import type { Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import type { StateHasher } from '../hash.ts';
import type { Rapier } from '../rapier.ts';
import type { TableCoin } from '../table/table.ts';
import { CoinContactFinder, NO_GROUP } from './contacts.ts';
import { ContactFusion, type ContactProgress, type FusionRules } from './fusion.ts';
import type { MechanicTable } from './table.ts';
import { ChampagneTower, type TowerState } from './tower.ts';
import { FUSION_TUNING, type TowerPlacement } from './tuning.ts';

export interface MechanicsConfig<Tier extends string> {
  /** The coin tier ladder, lowest first (COIN_TIERS from packages/shared). The top tier never fuses. */
  readonly tiers: readonly Tier[];
  readonly fusion: FusionRules;
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

/**
 * The table's mechanics, run once a tick after the table steps: Contact Fusion, then
 * the Champagne Tower. It keeps each coin's tier (the table knows only bodies), so the
 * caller registers every coin it adds and passes the ids of coins that fell. Events
 * are physical facts for the server to value; the sim does no value math.
 */
export class TableMechanics<Tier extends string> {
  readonly #table: MechanicTable;
  readonly #tiers: readonly Tier[];
  readonly #tierIndex = new Map<Tier, number>();
  readonly #tierOf = new Map<number, number>();
  readonly #contacts: CoinContactFinder;
  readonly #fusion: ContactFusion;
  readonly #tower: ChampagneTower | null;
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
    this.#fusion = new ContactFusion(
      config.fusion,
      FUSION_TUNING.graceTicks,
      FUSION_TUNING.sampleTicks,
    );
    this.#tower = config.tower === null ? null : new ChampagneTower(rapier, world, config.tower);
  }

  get tower(): TowerState | null {
    return this.#tower?.state ?? null;
  }

  get fusionTicks(): number {
    return this.#fusion.requiredTicks;
  }

  /** Records the tier of a coin just added to the table. */
  registerCoin(id: number, tier: Tier): void {
    const index = this.#tierIndex.get(tier);
    if (index === undefined) {
      throw new RangeError(`TableMechanics.registerCoin: "${tier}" is not in the tier ladder`);
    }
    if (this.#tierOf.has(id)) {
      throw new RangeError(`TableMechanics.registerCoin: coin ${id} is already registered`);
    }
    this.#tierOf.set(id, index);
  }

  /** The tier of a coin on the table or in the tower. */
  tierOf(id: number): Tier {
    return this.#tier(this.#index(id));
  }

  /** Contact progress of the same-tier pairs touching on the last step, for the charge-up. */
  fusionProgress(): ContactProgress[] {
    return this.#fusion.progress(this.#lastTick);
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
      this.#tierOf.delete(id);
      gone.push(id);
    }
    this.#fusion.forget(gone);

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
      this.#fusion.forget(captures.map((capture) => capture.coinId));
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
    this.#fusion.hashInto(h);
    if (this.#tower) {
      this.#tower.hashInto(h);
    }
    return h;
  }

  #fuse(tick: number, coins: readonly TableCoin[], events: MechanicEvent<Tier>[]): Set<number> {
    const top = this.#tiers.length - 1;
    const groups = new Int32Array(coins.length);
    coins.forEach((coin, i) => {
      const index = this.#index(coin.id);
      groups[i] = index === top ? NO_GROUP : index;
    });
    const ripe = this.#fusion.update(
      tick,
      this.#contacts.find(
        coins,
        groups,
        tick % FUSION_TUNING.sampleTicks,
        FUSION_TUNING.sampleTicks,
      ),
    );
    const fused = new Set<number>();
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
        this.#tierOf.delete(id);
        fused.add(id);
      }
      const fusedId = this.#table.addCoin(position, first.rotation);
      this.#tierOf.set(fusedId, index + 1);
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
    this.#fusion.forget(fused);
    return fused;
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
