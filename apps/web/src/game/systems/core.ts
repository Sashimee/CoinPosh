import type {
  CoinId,
  CoinTier,
  FallEdge,
  IdempotencyKey,
  InputEvent,
  MintedCoin,
  NudgeDirection,
  StateResponse,
  Tick,
  VenueId,
} from '@coinposh/shared';
import { createBus, type Bus } from '../../app/bus.ts';
import type { DecorumState } from '../../app/model.ts';
import type { FeedbackKind, UiState } from '../../app/state.ts';
import { watch, type Store } from '../../app/store.ts';
import type { ServerClock, TableEvent, TableSync } from '../../net/index.ts';
import type { CoinTierId } from '../../scene/coins/index.ts';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import type { SimEventBatch } from '../simWorker/protocol.ts';
import { COIN, type ContactSurface as SimSurface } from '../simWorker/sim-api.ts';
import { CascadeCombo } from './combo.ts';
import { DecorumModel } from './decorum.ts';
import { CoinLedger, aimToMm, clampAim } from './drops.ts';
import type {
  ContactSurface,
  DropBlockReason,
  GameEvents,
  NudgeSource,
  TablePoint,
} from './events.ts';
import { PourTimer, type PourResult } from './pour.ts';
import { TableWatcher, type TableBounds } from './tableWatch.ts';
import {
  CASCADE,
  CASCADE_WINDOW_TICKS,
  DECORUM_DECAY_PER_SECOND,
  DECORUM_PER_NUDGE,
  FALL_CLAIMS_PER_TICK,
  MIN_TICKS_BETWEEN_DROPS,
  PERFECT_POUR_HALF_WINDOW_MS,
  POUR_STREAM_TICKS,
  POUR_TARGET_MS,
  decorumCapacity,
  pourStreamTicks,
} from './tuning.ts';

/** The slice of `SimBridge` the glue drives. */
export interface SimPort {
  readonly stats: { readonly tick: number; readonly renderTick: number };
  /** Set once the worker has failed; the sim then refuses every input. */
  readonly failure: Error | null;
  drop(xMm: number, tier: CoinTierId): void;
  nudge(direction: NudgeDirection): void;
  sync(target: CoinTransformTarget): void;
  onEvents(listener: (batch: SimEventBatch) => void): () => void;
}

export type TablePort = Pick<
  TableSync,
  'drop' | 'claimFall' | 'claimFusion' | 'nudge' | 'subscribe'
>;
export type ClockPort = Pick<ServerClock, 'msUntil'>;

export interface UiPort {
  setCascade(count: number): void;
  setDecorum(decorum: DecorumState): void;
  feedback(kind: FeedbackKind): void;
}

export interface SystemsCoreOptions {
  readonly sim: SimPort;
  readonly table: TablePort;
  readonly clock: ClockPort;
  readonly ui: UiPort;
  readonly bounds: TableBounds;
  /** Local monotonic milliseconds. */
  readonly now: () => number;
  readonly upgradeLevels?: Readonly<Record<string, number>>;
  /** Sim event batches the worker sent before the systems existed, oldest first. */
  readonly simBacklog?: readonly SimEventBatch[];
  /**
   * The coins already on the table, in the order the server lists them, which the sim laid
   * first from the boot layout, so they hold sim ids 0..n-1. Bound before the backlog is read.
   */
  readonly tableCoins?: readonly MintedCoin[];
}

export interface ContactReport {
  readonly position: TablePoint;
  /** 0 for a graze, 1 for the hardest hit the table makes. */
  readonly strength: number;
  readonly surface: ContactSurface;
}

export interface FusionReport {
  readonly simIds: readonly [number, number, number];
  readonly center: TablePoint;
  readonly tier: CoinTier;
}

/** The parameters the systems derive from the table's upgrade levels. */
export interface UpgradeTuning {
  readonly decorumCapacity: number;
  /** Sim ticks between two coins of a pour, fractional. */
  readonly pourStreamTicks: number;
}

export interface PourView {
  readonly pouring: boolean;
  readonly progress: number;
  readonly inWindow: boolean;
}

export interface SystemsCore {
  readonly events: Bus<GameEvents>;
  readonly aim: number;
  setAim(aim: number): void;
  /** A tap: one coin at `aim`. Returns whether a drop was sent. */
  drop(aim: number): boolean;
  startPour(aim: number): void;
  endPour(): PourResult | null;
  cancelPour(): void;
  pourView(): PourView;
  /**
   * Something else owns the screen, such as a crate cinematic: a running pour is cancelled
   * ungraded, and taps and holds drop nothing until it lets go.
   */
  setSuspended(suspended: boolean): void;
  readonly suspended: boolean;
  readonly tuning: UpgradeTuning;
  nudge(direction: NudgeDirection, strength: number, source: NudgeSource): boolean;
  /** Writes this frame's coins into `target` through the sim, and settles what changed. */
  sync(target: CoinTransformTarget): void;
  /** Runs the timers: combo window, pour stream, decorum decay, freeze countdown. */
  update(): void;
  /** Takes the table's freeze and venue; the levels come only from `setUpgradeLevels`. */
  hydrate(state: StateResponse): void;
  /** Applies purchased levels live: Decorum capacity at once, pour cadence from the next coin. */
  setUpgradeLevels(levels: Readonly<Record<string, number>>): void;
  reportContact(contact: ContactReport): void;
  reportFusion(fusion: FusionReport): void;
  /** The server coin a sim body is, or null once it fell, fused away or was never one. */
  coinOf(simId: number): CoinId | null;
  dispose(): void;
}

interface PendingDrop {
  readonly aim: number;
  readonly xMm: number;
}

/** A coin is gone for good once it is this far past an edge line or closer. */
const EDGE_MARGIN = COIN.radius * 2;

/**
 * The most contacts voiced per batch, hardest first: a shoved heap clinks on dozens of coins in
 * the same tick, and past a handful they blur into noise and cost frame time.
 */
const MAX_CONTACTS_PER_BATCH = 6;

const SURFACES: Readonly<Record<SimSurface, ContactSurface>> = {
  coin: 'coin',
  floor: 'wood',
  pusher: 'metal',
  cabinet: 'metal',
};

interface SimFall {
  readonly edge: FallEdge;
  readonly tick: Tick;
}

interface HeldFall {
  readonly coin: MintedCoin | null;
  readonly edge: FallEdge;
  readonly position: TablePoint;
  readonly seen: Tick;
}

/** A sim fusion the server cannot be asked for yet: an input has no coin bound to it so far. */
interface HeldFusion {
  readonly simIds: readonly [number, number, number];
  /** Each input's coin, taken as soon as it is bound, since the body may leave before the rest. */
  readonly coins: (MintedCoin | null)[];
  readonly fusedId: number | null;
}

const NOTHING_GONE: ReadonlyMap<number, TablePoint> = new Map();

/**
 * Keeps the systems on the UI store's upgrade levels, the ones a confirmed purchase or a state
 * refresh writes, so a level applies the moment the server confirms it.
 */
export function followUpgradeLevels(
  store: Store<UiState>,
  core: Pick<SystemsCore, 'setUpgradeLevels'>,
): () => void {
  return watch(
    store,
    (state) => state.upgradeLevels,
    (levels) => {
      core.setUpgradeLevels(levels);
    },
  );
}

export function createSystemsCore(options: SystemsCoreOptions): SystemsCore {
  const { sim, table, clock, ui, now } = options;
  const events = createBus<GameEvents>();
  const watcher = new TableWatcher(options.bounds, EDGE_MARGIN);
  const ledger = new CoinLedger();
  const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
  const pour = new PourTimer(POUR_TARGET_MS, PERFECT_POUR_HALF_WINDOW_MS);
  let levels: Readonly<Record<string, number>> = options.upgradeLevels ?? {};
  /** The drop envelope is per venue, so the pour keeps its base cadence until hydrate names it. */
  let venue: VenueId | null = null;
  const tuneFor = (): UpgradeTuning => ({
    decorumCapacity: decorumCapacity(levels),
    pourStreamTicks: venue === null ? POUR_STREAM_TICKS : pourStreamTicks(levels, venue),
  });
  let tuning = tuneFor();
  const decorum = new DecorumModel(
    { perNudge: DECORUM_PER_NUDGE, decayPerSecond: DECORUM_DECAY_PER_SECOND },
    tuning.decorumCapacity,
    now(),
  );
  const awaitingMint = new Map<IdempotencyKey, PendingDrop>();
  const bufferedKeys = new Map<IdempotencyKey, CoinId>();
  const claimedFalls = new Map<
    CoinId,
    { readonly tier: CoinTier; readonly position: TablePoint }
  >();
  const simFalls = new Map<number, SimFall>();
  const heldFalls: HeldFall[] = [];
  const fusedAway = new Set<number>();
  const settledIds = new Set<number>();
  let lastClaimTick = 0;
  let fallsAtLastClaimTick = 0;
  /** Sim id of the coin each fusion claim makes, keyed by the claim's first coin. */
  const fusedBodies = new Map<CoinId, number>();
  const heldFusions: HeldFusion[] = [];
  /** Fused bodies whose own claim has not settled, held or in flight. */
  const unsettledFused = new Set<number>();
  /** Unsettled fused bodies that already left the table, as a chained fusion's input does. */
  const departedFused = new Set<number>();
  /** Coins minted for fused bodies that had already left by the time their claim settled. */
  const departedCoins = new Map<number, MintedCoin>();
  /** Falls of fused bodies that left before their claim settled, claimed once it does. */
  const parkedFalls = new Map<number, Omit<HeldFall, 'coin'>>();
  const lip: TablePoint = { x: 0, y: 0, z: options.bounds.fieldFrontZ };

  let aim = 0;
  let lastDropTick: number | null = null;
  let drops = 0;
  let pourDrops = 0;
  let nextPourTick = 0;
  let shownDecorum = '';
  let suspended = false;
  let disposed = false;

  const tick = (): Tick => Math.max(0, Math.floor(sim.stats.tick));
  const log = (input: InputEvent): void => {
    events.emit('input', input);
  };

  const block = (reason: DropBlockReason, quiet: boolean): false => {
    events.emit('drop:blocked', { reason });
    if (!quiet && reason !== 'cooldown') ui.feedback('deny');
    return false;
  };

  const sendDrop = (at: number, poured: boolean): boolean => {
    if (suspended) return block('suspended', true);
    if (decorum.frozen(now())) return block('frozen', poured);
    const current = tick();
    if (
      lastDropTick !== null &&
      current >= lastDropTick &&
      current - lastDropTick < MIN_TICKS_BETWEEN_DROPS
    ) {
      return block('cooldown', true);
    }
    const ticket = table.drop(at, current);
    if (ticket === null) return block('empty', poured);
    lastDropTick = current;
    drops += 1;
    const xMm = aimToMm(at);
    if (ticket.coin) {
      sim.drop(xMm, ticket.coin.tier);
      ledger.expect(ticket.coin);
      bufferedKeys.set(ticket.key, ticket.coin.id);
      log({ kind: 'drop', tick: current, x: at, coinId: ticket.coin.id });
    } else {
      awaitingMint.set(ticket.key, { aim: at, xMm });
    }
    events.emit('drop:requested', {
      aim: at,
      xMm,
      tick: current,
      coin: ticket.coin,
      ordinal: drops,
      first: drops === 1,
      poured,
    });
    return true;
  };

  const refreshDecorum = (force: boolean): void => {
    const snap = decorum.snapshot(now());
    const key = `${Math.round(snap.used * 10)}|${snap.capacity}|${Math.ceil(snap.frozenSeconds)}`;
    if (!force && key === shownDecorum) return;
    shownDecorum = key;
    ui.setDecorum({ used: snap.used, capacity: snap.capacity, frozenSeconds: snap.frozenSeconds });
    events.emit('decorum:change', snap);
  };

  const applyFreeze = (fraction: number, frozenUntil: number | null): void => {
    const at = now();
    const wasFrozen = decorum.frozen(at);
    let freezeMs: number | null = null;
    if (frozenUntil !== null) {
      freezeMs = clock.msUntil(frozenUntil);
      if (freezeMs === null) {
        console.error(
          '[CoinPosh] the server froze the table before the clock synced; the freeze is shown only once the next answer arrives.',
        );
      }
    }
    decorum.reconcile(fraction, freezeMs, at);
    const frozen = decorum.frozen(at);
    if (frozen && !wasFrozen) {
      if (pour.pouring) finishPour();
      events.emit('concierge:freeze', { seconds: (freezeMs ?? 0) / 1000 });
    } else if (!frozen && wasFrozen) {
      events.emit('concierge:thaw', {});
    }
    refreshDecorum(true);
  };

  const onTable = (event: TableEvent): void => {
    switch (event.type) {
      case 'dropSettled': {
        const pending = awaitingMint.get(event.key);
        if (pending) {
          awaitingMint.delete(event.key);
          sim.drop(pending.xMm, event.coin.tier);
          ledger.expect(event.coin);
          log({ kind: 'drop', tick: tick(), x: pending.aim, coinId: event.coin.id });
        } else {
          const buffered = bufferedKeys.get(event.key);
          bufferedKeys.delete(event.key);
          if (buffered !== undefined && buffered !== event.coin.id) {
            ledger.replace(buffered, event.coin);
            reidentifyHeld(buffered, event.coin);
          }
        }
        events.emit('drop:confirmed', { coin: event.coin });
        break;
      }
      case 'dropRejected':
        awaitingMint.delete(event.key);
        bufferedKeys.delete(event.key);
        if (event.coinId !== null) ledger.void(event.coinId);
        events.emit('drop:rejected', { coinId: event.coinId });
        break;
      case 'claimSettled': {
        const { claim, result } = event;
        if (claim.kind === 'fusion') {
          const fusedId = fusedBodies.get(claim.coinIds[0]);
          fusedBodies.delete(claim.coinIds[0]);
          if (fusedId !== undefined) {
            settleFused(fusedId, result.status === 'accepted' ? result.minted : null);
            claimHeldFusions();
          }
          break;
        }
        if (claim.kind !== 'fall') break;
        const seen = claimedFalls.get(claim.coinId);
        claimedFalls.delete(claim.coinId);
        if (result.status !== 'accepted') {
          events.emit('fall:refused', { coinId: claim.coinId, reason: result.reason });
          break;
        }
        if (result.cascade !== null) {
          events.emit('cascade:confirmed', { tier: result.cascade, coinId: claim.coinId });
        }
        if (result.credited > 0) {
          events.emit('value:credited', {
            amount: result.credited,
            coinId: claim.coinId,
            tier: seen?.tier ?? null,
            position: seen?.position ?? null,
            cascade: result.cascade,
          });
        }
        break;
      }
      case 'claimsFailed':
        for (const claim of event.claims) {
          if (claim.kind === 'fall') {
            claimedFalls.delete(claim.coinId);
            events.emit('fall:refused', { coinId: claim.coinId, reason: null });
          }
          if (claim.kind === 'fusion') {
            const fusedId = fusedBodies.get(claim.coinIds[0]);
            fusedBodies.delete(claim.coinIds[0]);
            if (fusedId !== undefined) settleFused(fusedId, null);
          }
        }
        claimHeldFusions();
        break;
      case 'nudgeSettled':
        applyFreeze(event.decorum, event.frozenUntil);
        break;
      case 'nudgeRejected':
        events.emit('nudge:rejected', { reason: 'server' });
        break;
      case 'balance':
      case 'status':
        break;
    }
  };
  const unsubscribe = table.subscribe(onTable);

  const endCombo = (ended: GameEvents['cascade:end'] | null): void => {
    if (!ended) return;
    events.emit('cascade:end', ended);
    ui.setCascade(0);
  };

  /**
   * The server refuses a claim older than the last one, so a fall the table noticed late is
   * claimed no earlier than the claims already sent. It also refuses more than
   * FALL_CLAIMS_PER_TICK falls on one tick, so late falls held at the last claim's tick spill
   * over onto the ticks after it, but never past the sim's own tick: the server refuses a tick
   * ahead of its clock, so a fall with no room yet waits (null) for the sim to catch up.
   */
  const fallClaimTick = (seen: Tick): Tick | null => {
    let at = Math.max(seen, lastClaimTick);
    if (at === lastClaimTick && fallsAtLastClaimTick >= FALL_CLAIMS_PER_TICK) at += 1;
    if (at > Math.max(seen, lastClaimTick, tick())) return null;
    if (at !== lastClaimTick) {
      lastClaimTick = at;
      fallsAtLastClaimTick = 0;
    }
    fallsAtLastClaimTick += 1;
    return at;
  };

  const fusionClaimTick = (): Tick => {
    const at = Math.max(tick(), lastClaimTick);
    if (at !== lastClaimTick) {
      lastClaimTick = at;
      fallsAtLastClaimTick = 0;
    }
    return at;
  };

  const announceFall = (held: HeldFall, at: Tick): void => {
    const { coin, edge, position } = held;
    events.emit('coin:fell', { coin, edge, position, tick: at });
    if (!coin) return;
    claimedFalls.set(coin.id, { tier: coin.tier, position });
    table.claimFall(coin.id, at, edge);
    if (edge !== 'front') return;
    const { step, ended } = combo.fall(at);
    endCombo(ended);
    events.emit('cascade:step', { count: step.count, tier: step.tier });
    if (step.tierUp) {
      events.emit('cascade:tier', { ...step.tierUp, count: step.count });
    }
    ui.setCascade(step.count);
  };

  /** Claims held falls in the order they fell, as far as the sim's tick leaves room. */
  const flushFalls = (): void => {
    for (let held = heldFalls[0]; held !== undefined; held = heldFalls[0]) {
      const at = fallClaimTick(held.seen);
      if (at === null) return;
      heldFalls.shift();
      announceFall(held, at);
    }
  };

  const fell = (simId: number, edge: FallEdge, position: TablePoint, seen: Tick = tick()): void => {
    settledIds.add(simId);
    simFalls.delete(simId);
    ledger.reach(simId);
    const coin = ledger.claimable(simId);
    ledger.release(simId);
    if (!coin && unsettledFused.has(simId)) {
      parkedFalls.set(simId, { edge, position, seen });
      return;
    }
    heldFalls.push({ coin, edge, position, seen });
    flushFalls();
  };

  const claimFusion = (
    coins: readonly [MintedCoin, MintedCoin, MintedCoin],
    fusedId: number | null,
  ): void => {
    const [a, b, c] = coins;
    table.claimFusion([a.id, b.id, c.id], fusionClaimTick());
    if (fusedId !== null) fusedBodies.set(a.id, fusedId);
  };

  /** An input with no coin yet is waiting only while it is a fused body whose claim is in flight. */
  const inputCoin = (simId: number): MintedCoin | 'waiting' | 'lost' => {
    const coin = ledger.claimable(simId) ?? departedCoins.get(simId);
    if (coin) return coin;
    return unsettledFused.has(simId) ? 'waiting' : 'lost';
  };

  const gather = (held: HeldFusion): 'ready' | 'waiting' | 'lost' => {
    let waiting = false;
    for (const [slot, simId] of held.simIds.entries()) {
      if (held.coins[slot]) continue;
      const coin = inputCoin(simId);
      if (coin === 'lost') return 'lost';
      if (coin === 'waiting') {
        waiting = true;
        continue;
      }
      held.coins[slot] = coin;
      departedCoins.delete(simId);
    }
    return waiting ? 'waiting' : 'ready';
  };

  /** A fusion the server can never be asked for leaves its fused body unminted too. */
  const abandon = (held: HeldFusion): void => {
    for (const simId of held.simIds) departedCoins.delete(simId);
    if (held.fusedId !== null) settleFused(held.fusedId, null);
  };

  /** A fusion's own fused body is unsettled until the server answers the fusion's claim. */
  function settleFused(fusedId: number, minted: MintedCoin | null): void {
    unsettledFused.delete(fusedId);
    const departed = departedFused.delete(fusedId);
    const parked = parkedFalls.get(fusedId);
    if (parked) {
      parkedFalls.delete(fusedId);
      heldFalls.push({ ...parked, coin: minted });
      flushFalls();
      return;
    }
    if (minted === null) return;
    if (departed) departedCoins.set(fusedId, minted);
    else ledger.bind(fusedId, minted);
  }

  /** Claims each held fusion whose inputs are all bound now, and drops those that never will be. */
  function claimHeldFusions(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const held of [...heldFusions]) {
        const state = gather(held);
        if (state === 'waiting') continue;
        heldFusions.splice(heldFusions.indexOf(held), 1);
        changed = true;
        const [a, b, c] = held.coins;
        if (state === 'ready' && a && b && c) claimFusion([a, b, c], held.fusedId);
        else abandon(held);
      }
    }
  }

  function reidentifyHeld(previous: CoinId, coin: MintedCoin): void {
    for (const held of heldFusions) {
      held.coins.forEach((candidate, slot) => {
        if (candidate?.id === previous) held.coins[slot] = coin;
      });
    }
  }

  const fuse = (fusion: FusionReport, fusedId: number | null): void => {
    const sources = fusion.simIds.map((id) => watcher.lastPosition(id) ?? fusion.center);
    if (fusedId !== null) unsettledFused.add(fusedId);
    ledger.reach(Math.max(...fusion.simIds));
    const held: HeldFusion = { simIds: fusion.simIds, coins: [null, null, null], fusedId };
    const state = gather(held);
    const [a, b, c] = held.coins;
    let claimed = false;
    if (state === 'ready' && a && b && c) {
      claimFusion([a, b, c], fusedId);
      claimed = true;
    } else if (state === 'waiting') {
      heldFusions.push(held);
    } else {
      abandon(held);
    }
    events.emit('coin:fusion', { sources, center: fusion.center, tier: fusion.tier, claimed });
  };

  const contact = (report: ContactReport): void => {
    events.emit('coin:contact', {
      position: report.position,
      strength: Math.min(1, Math.max(0, report.strength)),
      surface: report.surface,
    });
  };

  const intake = (batch: SimEventBatch): void => {
    if (disposed) return;
    for (const fall of batch.falls) {
      if (settledIds.has(fall.coinId)) continue;
      simFalls.set(fall.coinId, { edge: fall.edge, tick: Math.max(0, Math.floor(fall.tick)) });
    }
    for (const fusion of batch.fusions) {
      const [a, b, c] = fusion.ids;
      if (a === undefined || b === undefined || c === undefined || fusion.ids.length !== 3) {
        throw new RangeError(
          `GameSystems: a sim fusion must consume three coins, got ids [${fusion.ids.join(', ')}]`,
        );
      }
      for (const id of fusion.ids) fusedAway.add(id);
      ledger.reserve(fusion.fusedId);
      fuse({ simIds: [a, b, c], center: fusion.position, tier: fusion.into }, fusion.fusedId);
    }
    const loudest = [...batch.contacts]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_CONTACTS_PER_BATCH);
    for (const hit of loudest) {
      contact({ position: hit.position, strength: hit.strength, surface: SURFACES[hit.surface] });
    }
  };

  /**
   * Sim falls arrive ahead of the drawn frame. Each is settled once the render clock reaches its
   * tick, or sooner when its coin stops being drawn, and always in tick order, since the server
   * refuses a claim older than the last. A coin that left before the systems took the table is
   * settled at the lip.
   */
  const settleSimFalls = (gone: ReadonlyMap<number, TablePoint>): void => {
    let horizon = sim.stats.renderTick;
    for (const id of gone.keys()) horizon = Math.max(horizon, simFalls.get(id)?.tick ?? horizon);
    const due = [...simFalls].filter(([, fall]) => fall.tick <= horizon);
    due.sort(([, a], [, b]) => a.tick - b.tick);
    for (const [id, fall] of due) {
      fell(id, fall.edge, gone.get(id) ?? watcher.lastPosition(id) ?? lip, fall.tick);
    }
  };

  function cancelPour(): void {
    if (!pour.pouring) return;
    pour.cancel();
    const current = tick();
    log({ kind: 'pourEnd', tick: current });
    events.emit('pour:cancel', { drops: pourDrops, tick: current });
    pourDrops = 0;
  }

  function finishPour(): PourResult | null {
    if (!pour.pouring) return null;
    const result = pour.release(now());
    const at = tick();
    log({ kind: 'pourEnd', tick: at });
    events.emit('pour:end', { ...result, drops: pourDrops, tick: at });
    if (result.grade === 'perfect') ui.feedback('confirm');
    pourDrops = 0;
    return result;
  }

  const requireLive = (method: string): void => {
    if (disposed) throw new Error(`GameSystems.${method}: the systems were disposed`);
  };

  options.tableCoins?.forEach((coin, simId) => {
    ledger.bind(simId, coin);
  });
  for (const batch of options.simBacklog ?? []) intake(batch);
  const stopSimEvents = sim.onEvents(intake);

  const setAim = (next: number): void => {
    const clamped = clampAim(next);
    if (clamped === aim) return;
    aim = clamped;
    events.emit('aim:move', { aim });
  };

  return {
    events,
    get aim() {
      return aim;
    },
    setAim,
    drop(at) {
      requireLive('drop');
      setAim(at);
      return sendDrop(aim, false);
    },
    startPour(at) {
      requireLive('startPour');
      setAim(at);
      if (pour.pouring) return;
      if (suspended) {
        block('suspended', true);
        return;
      }
      if (decorum.frozen(now())) {
        block('frozen', false);
        return;
      }
      pour.start(now());
      pourDrops = 0;
      nextPourTick = tick();
      const current = tick();
      log({ kind: 'pourStart', tick: current });
      events.emit('pour:start', { aim, tick: current, targetMs: pour.targetMs });
      pourStream();
    },
    endPour() {
      requireLive('endPour');
      return finishPour();
    },
    cancelPour,
    setSuspended(next) {
      if (disposed || next === suspended) return;
      suspended = next;
      if (suspended) cancelPour();
    },
    get suspended() {
      return suspended;
    },
    pourView() {
      const at = now();
      return { pouring: pour.pouring, progress: pour.progress(at), inWindow: pour.inWindow(at) };
    },
    nudge(direction, strength, source) {
      requireLive('nudge');
      if (decorum.frozen(now())) {
        events.emit('nudge:rejected', { reason: 'frozen' });
        ui.feedback('deny');
        return false;
      }
      if (sim.failure) {
        events.emit('nudge:rejected', { reason: 'sim' });
        ui.feedback('deny');
        return false;
      }
      const current = tick();
      if (!table.nudge(current, direction)) {
        events.emit('nudge:rejected', { reason: 'offline' });
        ui.feedback('deny');
        return false;
      }
      sim.nudge(direction);
      decorum.nudge(now());
      log({ kind: 'nudge', tick: current, direction });
      events.emit('nudge', {
        direction,
        strength: Math.min(1, Math.max(0, strength)),
        source,
        tick: current,
      });
      ui.feedback('tick');
      refreshDecorum(false);
      return true;
    },
    sync(target) {
      if (disposed) return;
      sim.sync(watcher.begin(target));
      const { appeared, vanished } = watcher.end();
      for (const body of appeared) {
        const coin = ledger.assign(body.id);
        events.emit('coin:spawned', { coin, position: body.position });
      }
      flushFalls();
      if (simFalls.size > 0) {
        settleSimFalls(
          vanished.length === 0
            ? NOTHING_GONE
            : new Map(vanished.map((body) => [body.id, body.position])),
        );
      }
      for (const body of vanished) {
        if (settledIds.has(body.id)) continue;
        if (fusedAway.delete(body.id) || body.edge === null) {
          if (unsettledFused.has(body.id)) departedFused.add(body.id);
          ledger.release(body.id);
        } else {
          fell(body.id, body.edge, body.position);
        }
      }
    },
    update() {
      if (disposed) return;
      const at = now();
      flushFalls();
      endCombo(combo.update(tick()));
      if (decorum.thawIfDue(at)) {
        events.emit('concierge:thaw', {});
        refreshDecorum(true);
      } else {
        refreshDecorum(false);
      }
      pourStream();
    },
    get tuning() {
      return tuning;
    },
    hydrate(state) {
      requireLive('hydrate');
      venue = state.venue.id;
      retune();
      applyFreeze(state.table.decorum, state.table.frozenUntil);
    },
    setUpgradeLevels(next) {
      if (disposed) return;
      levels = next;
      retune();
      refreshDecorum(true);
    },
    reportContact: contact,
    reportFusion(fusion) {
      fuse(fusion, null);
    },
    coinOf(simId) {
      return ledger.claimable(simId)?.id ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopSimEvents();
      pour.cancel();
    },
  };

  function retune(): void {
    tuning = tuneFor();
    decorum.setCapacity(tuning.decorumCapacity, now());
  }

  function pourStream(): void {
    if (!pour.pouring) return;
    const current = tick();
    if (current < nextPourTick) return;
    if (sendDrop(aim, true)) {
      pourDrops += 1;
      // Carried forward, not restarted from `current`, so a fractional cadence keeps its rate.
      nextPourTick = Math.max(nextPourTick, current - 1) + tuning.pourStreamTicks;
    }
  }
}
