import type {
  CoinId,
  CoinTier,
  FallEdge,
  IdempotencyKey,
  InputEvent,
  NudgeDirection,
  StateResponse,
  Tick,
} from '@coinposh/shared';
import { createBus, type Bus } from '../../app/bus.ts';
import type { DecorumState } from '../../app/model.ts';
import type { FeedbackKind } from '../../app/state.ts';
import type { ServerClock, TableEvent, TableSync } from '../../net/index.ts';
import type { CoinTierId } from '../../scene/coins/index.ts';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import { COIN } from '../simWorker/sim-api.ts';
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
  MIN_TICKS_BETWEEN_DROPS,
  PERFECT_POUR_HALF_WINDOW_MS,
  POUR_STREAM_TICKS,
  POUR_TARGET_MS,
  decorumCapacity,
} from './tuning.ts';

/** The slice of `SimBridge` the glue drives. */
export interface SimPort {
  readonly stats: { readonly tick: number };
  drop(xMm: number, tier: CoinTierId): void;
  sync(target: CoinTransformTarget): void;
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
  nudge(direction: NudgeDirection, strength: number, source: NudgeSource): boolean;
  /** Writes this frame's coins into `target` through the sim, and settles what changed. */
  sync(target: CoinTransformTarget): void;
  /** Runs the timers: combo window, pour stream, decorum decay, freeze countdown. */
  update(): void;
  hydrate(state: StateResponse): void;
  setUpgradeLevels(levels: Readonly<Record<string, number>>): void;
  reportContact(contact: ContactReport): void;
  reportFusion(fusion: FusionReport): void;
  dispose(): void;
}

interface PendingDrop {
  readonly aim: number;
  readonly xMm: number;
}

/** A coin is gone for good once it is this far past an edge line or closer. */
const EDGE_MARGIN = COIN.radius * 2;

export function createSystemsCore(options: SystemsCoreOptions): SystemsCore {
  const { sim, table, clock, ui, now } = options;
  const events = createBus<GameEvents>();
  const watcher = new TableWatcher(options.bounds, EDGE_MARGIN);
  const ledger = new CoinLedger();
  const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
  const pour = new PourTimer(POUR_TARGET_MS, PERFECT_POUR_HALF_WINDOW_MS);
  const decorum = new DecorumModel(
    { perNudge: DECORUM_PER_NUDGE, decayPerSecond: DECORUM_DECAY_PER_SECOND },
    decorumCapacity(options.upgradeLevels ?? {}),
    now(),
  );
  const awaitingMint = new Map<IdempotencyKey, PendingDrop>();
  const bufferedKeys = new Map<IdempotencyKey, CoinId>();
  const claimedFalls = new Map<
    CoinId,
    { readonly tier: CoinTier; readonly position: TablePoint }
  >();

  let aim = 0;
  let lastDropTick: number | null = null;
  let drops = 0;
  let pourDrops = 0;
  let nextPourTick = 0;
  let shownDecorum = '';
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
          if (buffered !== undefined && buffered !== event.coin.id)
            ledger.replace(buffered, event.coin);
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
        if (claim.kind !== 'fall') break;
        const seen = claimedFalls.get(claim.coinId);
        claimedFalls.delete(claim.coinId);
        if (result.status !== 'accepted') break;
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
        for (const claim of event.claims)
          if (claim.kind === 'fall') claimedFalls.delete(claim.coinId);
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

  const fell = (simId: number, edge: FallEdge, position: TablePoint): void => {
    const coin = ledger.claimable(simId);
    const at = tick();
    ledger.release(simId);
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
    cancelPour() {
      if (!pour.pouring) return;
      pour.cancel();
      const current = tick();
      log({ kind: 'pourEnd', tick: current });
      events.emit('pour:cancel', { drops: pourDrops, tick: current });
      pourDrops = 0;
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
      const current = tick();
      if (!table.nudge(current, direction)) {
        events.emit('nudge:rejected', { reason: 'offline' });
        ui.feedback('deny');
        return false;
      }
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
      for (const body of vanished) {
        if (body.edge === null) ledger.release(body.id);
        else fell(body.id, body.edge, body.position);
      }
    },
    update() {
      if (disposed) return;
      const at = now();
      endCombo(combo.update(tick()));
      if (decorum.thawIfDue(at)) {
        events.emit('concierge:thaw', {});
        refreshDecorum(true);
      } else {
        refreshDecorum(false);
      }
      pourStream();
    },
    hydrate(state) {
      requireLive('hydrate');
      decorum.setCapacity(decorumCapacity(state.venue.upgrades), now());
      applyFreeze(state.table.decorum, state.table.frozenUntil);
    },
    setUpgradeLevels(levels) {
      decorum.setCapacity(decorumCapacity(levels), now());
      refreshDecorum(true);
    },
    reportContact(contact) {
      events.emit('coin:contact', {
        position: contact.position,
        strength: Math.min(1, Math.max(0, contact.strength)),
        surface: contact.surface,
      });
    },
    reportFusion(fusion) {
      const coins = fusion.simIds.map((id) => ledger.claimable(id));
      const sources = fusion.simIds.map((id) => watcher.lastPosition(id) ?? fusion.center);
      const [a, b, c] = coins;
      let claimed = false;
      if (a && b && c) {
        table.claimFusion([a.id, b.id, c.id], tick());
        claimed = true;
      }
      events.emit('coin:fusion', { sources, center: fusion.center, tier: fusion.tier, claimed });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      pour.cancel();
    },
  };

  function pourStream(): void {
    if (!pour.pouring) return;
    const current = tick();
    if (current < nextPourTick) return;
    if (sendDrop(aim, true)) {
      pourDrops += 1;
      nextPourTick = current + POUR_STREAM_TICKS;
    }
  }
}
