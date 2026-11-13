import type { Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import type { StateHasher } from '../hash.ts';
import type { Rapier } from '../rapier.ts';
import type { TableCoin } from '../table/table.ts';
import { type CoinPair, CoinContactFinder, NO_GROUP } from './contacts.ts';
import { ContactFusion, type ContactProgress, freshTicks, type FusionRules } from './fusion.ts';
import type { MechanicTable } from './table.ts';
import { ChampagneTower, type TowerState } from './tower.ts';
import { FUSION_TUNING, type TowerPlacement } from './tuning.ts';

export interface MechanicsConfig<Tier extends string> {
  /** The coin tier ladder, lowest first (COIN_TIERS from packages/shared). The top tier never fuses. */
  readonly tiers: readonly Tier[];
  /** Contact Fusion's rules; null for a table whose coins keep their tier. */
  readonly fusion: FusionRules | null;
  /** Where the Champagne Tower stands; null for a table without one. */
  readonly tower?: TowerPlacement | null;
}

export interface FusionEvent<Tier extends string> {
  readonly kind: 'fusion';
  readonly tick: number;
  /** The fused coins, ascending. They are gone from the table. */
  readonly ids: readonly number[];
  readonly tier: Tier;
  readonly into: Tier;
  readonly fusedId: number;
  readonly position: Readonly<Vector>;
}

export interface TowerCaptureEvent<Tier extends string> {
  readonly kind: 'towerCapture';
  readonly tick: number;
  readonly coinId: number;
  readonly tier: Tier;
  readonly height: number;
}

export interface TowerToppleEvent {
  readonly kind: 'towerTopple';
  readonly tick: number;
  /** The stacked coins, bottom to top. */
  readonly ids: readonly number[];
  /** The ids they have on the table again, in the same order. */
  readonly released: readonly number[];
  readonly direction: Readonly<{ x: number; z: number }>;
  readonly height: number;
}

export type MechanicEvent<Tier extends string> =
  FusionEvent<Tier> | TowerCaptureEvent<Tier> | TowerToppleEvent;

/** A coin laid on the table before the first tick, for TableMechanics.layCoins. */
export interface LaidCoin<Tier extends string> {
  readonly id: number;
  readonly tier: Tier;
}

interface Freshness {
  /** The first tick the coin may fuse on; it is fresh for TableMechanics.freshTicks from it. */
  readonly from: number;
  /** Whether it wakes the idle coins it touches: a coin that entered play does, a woken one does not. */
  readonly wakes: boolean;
}

/**
 * The table's mechanics, run once a tick after the table steps: Contact Fusion, then
 * the Champagne Tower. It keeps each coin's tier (the table knows only bodies), so the
 * caller registers every coin it adds and passes the ids of coins that fell. Events
 * are physical facts for the server to value; the sim does no value math.
 *
 * A coin fuses only while it is fresh, and only with fresh coins (FUSION_TUNING
 * spawnGraceTicks, freshTicks, wakeFromTier): a coin added during play waits out a spawn
 * grace and is then fresh for a window, freshTicks stretched by the fusionWindow upgrade
 * (FusionRules.fusionWindow). A coin laid before the first tick, or one whose window has
 * closed, is idle. An idle coin of wakeFromTier or above becomes fresh again, for a window
 * of its own, when a coin of its tier that entered play touches it while fresh, which is
 * how a new silver joins silvers that settled long ago. A woken coin wakes no others, so
 * one coin never wakes a whole heap. A chute drop is fresh only within the chute's stream
 * allowance (FUSION_TUNING streamTicks, streamBurst), so the tail of a held pour lands
 * idle. The windows and the allowance are kept, and hashed, only on a table that fuses;
 * a restored table starts with a full allowance, as its coins start idle.
 */
export class TableMechanics<Tier extends string> {
  readonly #table: MechanicTable;
  readonly #tiers: readonly Tier[];
  readonly #tierIndex = new Map<Tier, number>();
  readonly #tierOf = new Map<number, number>();
  /** Coins in their spawn grace or fresh, and whether they wake the idle coins they touch. */
  readonly #fresh = new Map<number, Freshness>();
  readonly #contacts: CoinContactFinder;
  readonly #fusion: ContactFusion | null;
  readonly #tower: ChampagneTower | null;
  readonly #freshTicks: number;
  /** When the chute's stream allowance is next spent (FUSION_TUNING.streamTicks), as a tick. */
  #streamDue = 0;
  #lastTick = -1;

  constructor(rapier: Rapier, world: World, table: MechanicTable, config: MechanicsConfig<Tier>) {
    if (config.tiers.length < 2) {
      throw new RangeError(`TableMechanics needs at least two tiers, got ${config.tiers.length}`);
    }
    config.tiers.forEach((tier, index) => {
      if (this.#tierIndex.has(tier)) {
        throw new RangeError(`TableMechanics: tier "${tier}" appears twice in the ladder`);
      }
      this.#tierIndex.set(tier, index);
    });
    this.#table = table;
    this.#tiers = config.tiers;
    this.#contacts = new CoinContactFinder(FUSION_TUNING.touchGap);
    this.#fusion =
      config.fusion === null
        ? null
        : new ContactFusion(config.fusion, FUSION_TUNING.graceTicks, FUSION_TUNING.sampleTicks);
    this.#freshTicks = freshTicks(config.fusion?.fusionWindow);
    this.#tower = config.tower === null ? null : new ChampagneTower(rapier, world, config.tower);
  }

  get tower(): TowerState | null {
    return this.#tower?.state ?? null;
  }

  /** Ticks of contact a fusion needs; null when the table does not fuse. */
  get fusionTicks(): number | null {
    return this.#fusion?.requiredTicks ?? null;
  }

  /** Ticks a coin stays fresh after its spawn grace; null when the table does not fuse. */
  get freshTicks(): number | null {
    return this.#fusion ? this.#freshTicks : null;
  }

  /** Records the tier of a coin just added to the table; it waits out the spawn grace, then is fresh. */
  registerCoin(id: number, tier: Tier): void {
    this.#setTier(id, tier, 'registerCoin');
    this.#startGrace(id, this.#lastTick + 1);
  }

  /**
   * Records the tier of a coin just dropped down the chute. It waits out the spawn grace
   * and is then fresh, like any coin added in play, while the chute keeps to its stream
   * allowance (FUSION_TUNING.streamTicks, streamBurst); past it, in a long pour, the coin
   * lands idle.
   */
  registerDrop(id: number, tier: Tier): void {
    this.#setTier(id, tier, 'registerDrop');
    const tick = this.#lastTick + 1;
    const { streamTicks, streamBurst } = FUSION_TUNING;
    if (this.#fusion && this.#streamDue - tick <= (streamBurst - 1) * streamTicks) {
      this.#streamDue = Math.max(this.#streamDue, tick) + streamTicks;
      this.#startGrace(id, tick);
    }
  }

  /**
   * Records the coins laid on the table before the first step, such as the opening heap.
   * They are idle: none of them fuses until a fresh coin of its tier wakes it.
   */
  layCoins(coins: Iterable<LaidCoin<Tier>>): void {
    if (this.#lastTick >= 0) {
      throw new RangeError(
        `TableMechanics.layCoins: coins are laid before the first step, but tick ${this.#lastTick} has run; use registerCoin`,
      );
    }
    const onTable = new Set(this.#table.coins().map((coin) => coin.id));
    for (const { id, tier } of coins) {
      if (!onTable.has(id)) {
        throw new RangeError(`TableMechanics.layCoins: coin ${id} is not on the table`);
      }
      this.#setTier(id, tier, 'layCoins');
    }
  }

  /** The tier of a coin on the table or in the tower. */
  tierOf(id: number): Tier {
    return this.#tier(this.#index(id));
  }

  /** Contact progress of the same-tier pairs touching on the last step, for the charge-up. */
  fusionProgress(): ContactProgress[] {
    return this.#fusion?.progress(this.#lastTick) ?? [];
  }

  /**
   * Runs the mechanics for `tick`, after the table stepped. `fallen` are the coins
   * that left the table this tick. Returns the events in the order they happened:
   * fusions in ascending order of their lowest id, then captures in id order, then a
   * topple.
   */
  step(tick: number, fallen: Iterable<number> = []): MechanicEvent<Tier>[] {
    if (tick <= this.#lastTick) {
      throw new RangeError(`TableMechanics.step: tick ${tick} is not after ${this.#lastTick}`);
    }
    this.#lastTick = tick;
    const gone: number[] = [];
    for (const id of fallen) {
      this.#forgetCoin(id);
      gone.push(id);
    }
    this.#fusion?.forget(gone);

    const events: MechanicEvent<Tier>[] = [];
    const coins = this.#table.coins();
    const fused = this.#fuse(tick, coins, events);
    if (!this.#tower) {
      return events;
    }
    const remaining = fused.size === 0 ? coins : coins.filter((coin) => !fused.has(coin.id));
    const { captures, topple } = this.#tower.step(
      tick,
      remaining,
      (id) => this.#index(id),
      this.#table,
    );
    if (captures.length > 0) {
      this.#fusion?.forget(captures.map((capture) => capture.coinId));
      for (const { coinId } of captures) {
        this.#fresh.delete(coinId);
      }
    }
    for (const { coinId, group, height } of captures) {
      events.push({ kind: 'towerCapture', tick, coinId, tier: this.#tier(group), height });
    }
    if (topple) {
      topple.released.forEach((id, k) => {
        const group = topple.groups[k];
        if (group === undefined) {
          throw new Error(`TableMechanics: topple released coin ${id} without a tier`);
        }
        this.#tierOf.set(id, group);
        this.#startGrace(id, tick);
      });
      for (const id of topple.ids) {
        this.#tierOf.delete(id);
      }
      events.push({
        kind: 'towerTopple',
        tick,
        ids: topple.ids,
        released: topple.released,
        direction: topple.direction,
        height: topple.ids.length,
      });
    }
    return events;
  }

  hashInto(h: StateHasher): StateHasher {
    const ids = Array.from(this.#tierOf.keys()).sort((p, q) => p - q);
    h.int(this.#lastTick).int(ids.length);
    for (const id of ids) {
      h.int(id).int(this.#index(id));
    }
    if (this.#fusion) {
      const fresh = Array.from(this.#fresh).sort((p, q) => p[0] - q[0]);
      h.int(this.#streamDue).int(fresh.length);
      for (const [id, { from, wakes }] of fresh) {
        h.int(id)
          .int(from)
          .int(wakes ? 1 : 0);
      }
      this.#fusion.hashInto(h);
    }
    if (this.#tower) {
      this.#tower.hashInto(h);
    }
    return h;
  }

  #fuse(tick: number, coins: readonly TableCoin[], events: MechanicEvent<Tier>[]): Set<number> {
    const fused = new Set<number>();
    const fusion = this.#fusion;
    if (!fusion) {
      return fused;
    }
    const top = this.#tiers.length - 1;
    const groups = new Int32Array(coins.length);
    coins.forEach((coin, i) => {
      const index = this.#index(coin.id);
      this.#expire(coin.id, tick);
      const fresh = this.#fresh.get(coin.id);
      // An idle coin below wakeFromTier can neither fuse nor be woken, so every pair it
      // would make is dropped by #wake; leaving it out spares the search the paved strip.
      const sitsOut = fresh ? tick < fresh.from : index < FUSION_TUNING.wakeFromTier;
      groups[i] = index === top || sitsOut ? NO_GROUP : index;
    });
    const touching = this.#contacts.find(
      coins,
      groups,
      tick % FUSION_TUNING.sampleTicks,
      FUSION_TUNING.sampleTicks,
    );
    const ripe = fusion.update(tick, this.#wake(tick, touching));
    if (ripe.length === 0) {
      return fused;
    }
    const byId = new Map(coins.map((coin) => [coin.id, coin]));
    for (const ids of ripe) {
      const inputs = ids.map((id) => {
        const coin = byId.get(id);
        if (!coin) {
          throw new Error(`TableMechanics: fusing coin ${id}, which is not on the table`);
        }
        return coin;
      });
      const first = inputs[0];
      if (!first) {
        throw new Error('TableMechanics: an empty fusion group');
      }
      let x = 0;
      let z = 0;
      let y = Number.NEGATIVE_INFINITY;
      for (const { translation } of inputs) {
        x += translation.x;
        z += translation.z;
        y = Math.max(y, translation.y);
      }
      const position = {
        x: x / inputs.length,
        y: y + FUSION_TUNING.spawnLift,
        z: z / inputs.length,
      };
      const index = this.#index(first.id);
      for (const id of ids) {
        this.#table.removeCoin(id);
        this.#forgetCoin(id);
        fused.add(id);
      }
      const fusedId = this.#table.addCoin(position, first.rotation);
      this.#tierOf.set(fusedId, index + 1);
      this.#startGrace(fusedId, tick);
      events.push({
        kind: 'fusion',
        tick,
        ids,
        tier: this.#tier(index),
        into: this.#tier(index + 1),
        fusedId,
        position,
      });
    }
    fusion.forget(fused);
    return fused;
  }

  /**
   * Wakes the idle coins that `touching` (same-tier contacts, sorted) pairs with a fresh
   * coin that wakes, and returns the contacts whose coins are both fresh, still sorted.
   * Only coins fresh before this call wake others, so the order of the pairs does not matter.
   */
  #wake(tick: number, touching: readonly CoinPair[]): CoinPair[] {
    const woken: number[] = [];
    const wakeBy = (waker: number, idle: number) => {
      if (
        this.#freshAt(waker, tick)?.wakes === true &&
        !this.#fresh.has(idle) &&
        this.#index(idle) >= FUSION_TUNING.wakeFromTier
      ) {
        woken.push(idle);
      }
    };
    for (const { a, b } of touching) {
      wakeBy(a, b);
      wakeBy(b, a);
    }
    for (const id of woken) {
      this.#fresh.set(id, { from: tick, wakes: false });
    }
    return touching.filter(({ a, b }) => this.#freshAt(a, tick) && this.#freshAt(b, tick));
  }

  /** Coin `id`'s freshness if it may fuse at `tick`: its spawn grace is over and its window is not. */
  #freshAt(id: number, tick: number): Freshness | undefined {
    const fresh = this.#fresh.get(id);
    return fresh && tick >= fresh.from && tick < fresh.from + this.#freshTicks ? fresh : undefined;
  }

  /** Makes coin `id` idle once its fresh window has closed. */
  #expire(id: number, tick: number): void {
    const fresh = this.#fresh.get(id);
    if (fresh && tick >= fresh.from + this.#freshTicks) {
      this.#fresh.delete(id);
    }
  }

  /** Starts the spawn grace of a coin that entered the table on `tick`. */
  #startGrace(id: number, tick: number): void {
    if (this.#fusion) {
      this.#fresh.set(id, {
        from: tick + FUSION_TUNING.spawnGraceTicks,
        wakes: true,
      });
    }
  }

  #setTier(id: number, tier: Tier, caller: string): void {
    const index = this.#tierIndex.get(tier);
    if (index === undefined) {
      throw new RangeError(`TableMechanics.${caller}: "${tier}" is not in the tier ladder`);
    }
    if (this.#tierOf.has(id)) {
      throw new RangeError(`TableMechanics.${caller}: coin ${id} is already registered`);
    }
    this.#tierOf.set(id, index);
  }

  /** Drops a coin that left the table for good. */
  #forgetCoin(id: number): void {
    this.#tierOf.delete(id);
    this.#fresh.delete(id);
  }

  #index(id: number): number {
    const index = this.#tierOf.get(id);
    if (index === undefined) {
      throw new Error(`TableMechanics: coin ${id} has no tier; call registerCoin when adding it`);
    }
    return index;
  }

  #tier(index: number): Tier {
    const tier = this.#tiers[index];
    if (tier === undefined) {
      throw new Error(`TableMechanics: no tier at index ${index}`);
    }
    return tier;
  }
}
