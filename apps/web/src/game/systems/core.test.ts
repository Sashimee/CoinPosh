import type {
  CoinId,
  CoinTier,
  IdempotencyKey,
  MintedCoin,
  NudgeDirection,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import type { DecorumState } from '../../app/model.ts';
import type { FeedbackKind } from '../../app/state.ts';
import { createI18n, LANGUAGES } from '../../i18n/index.ts';
import type { TableEvent } from '../../net/index.ts';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import { createSystemsCore, type SystemsCore, type TablePort } from './core.ts';
import type { GameEventType, GameEvents } from './events.ts';
import { SYSTEMS_NAMESPACE, SYSTEMS_STRINGS, registerSystemsStrings, systemsKey } from './i18n.ts';
import {
  CASCADE_WINDOW_TICKS,
  DECORUM_PER_NUDGE,
  MIN_TICKS_BETWEEN_DROPS,
  POUR_STREAM_TICKS,
  POUR_TARGET_MS,
  decorumCapacity,
} from './tuning.ts';

const BOUNDS = { fieldHalfWidth: 0.28, fieldFrontZ: 0.36 };
const SERVER_NOW = 1_800_000_000_000;

const coin = (n: number, tier: CoinTier = 'copper'): MintedCoin => ({
  id: `coin_${'A'.repeat(15)}${String(n)}` as CoinId,
  tier,
  value: 10,
});
const key = (n: number): IdempotencyKey =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as IdempotencyKey;

class FakeSim {
  readonly stats = { tick: 0 };
  readonly drops: { xMm: number; tier: string }[] = [];
  readonly bodies = new Map<number, [number, number, number]>();
  drawing = true;
  #nextId = 0;

  drop(xMm: number, tier: string): void {
    this.drops.push({ xMm, tier });
    this.bodies.set(this.#nextId, [xMm / 1000, 0.1, 0]);
    this.#nextId += 1;
  }

  sync(target: CoinTransformTarget): void {
    if (!this.drawing) return;
    const ids = [...this.bodies.keys()];
    const positions = ids.flatMap((id) => this.bodies.get(id) ?? []);
    target.setTransforms('copper', positions, [], ids.length, ids);
  }
}

class FakeTable implements TablePort {
  readonly listeners = new Set<(event: TableEvent) => void>();
  readonly falls: { coinId: CoinId; tick: number; edge: string }[] = [];
  readonly fusions: (readonly CoinId[])[] = [];
  readonly nudges: { tick: number; direction: NudgeDirection }[] = [];
  online = true;
  next: { coin: MintedCoin | null } | null = null;
  #keys = 0;

  drop(): { key: IdempotencyKey; coin: MintedCoin | null } | null {
    if (!this.online) return null;
    this.#keys += 1;
    const ticket = this.next ?? { coin: coin(this.#keys) };
    this.next = null;
    return { key: key(this.#keys), coin: ticket.coin };
  }

  claimFall(coinId: CoinId, tick: number, edge: 'front' | 'left' | 'right'): void {
    this.falls.push({ coinId, tick, edge });
  }

  claimFusion(coinIds: readonly [CoinId, CoinId, CoinId]): void {
    this.fusions.push(coinIds);
  }

  nudge(tick: number, direction: NudgeDirection): boolean {
    if (!this.online) return false;
    this.nudges.push({ tick, direction });
    return true;
  }

  subscribe(listener: (event: TableEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TableEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const NULL_TARGET: CoinTransformTarget = {
  capacity: () => 1_000,
  setTransforms: () => undefined,
};

function setup() {
  const sim = new FakeSim();
  const table = new FakeTable();
  const time = { now: 0 };
  const ui = {
    cascade: [] as number[],
    decorum: [] as DecorumState[],
    feedback: [] as FeedbackKind[],
  };
  const core = createSystemsCore({
    sim,
    table,
    clock: { msUntil: (at) => Math.max(0, at - SERVER_NOW) },
    ui: {
      setCascade: (count) => ui.cascade.push(count),
      setDecorum: (decorum) => ui.decorum.push(decorum),
      feedback: (kind) => ui.feedback.push(kind),
    },
    bounds: BOUNDS,
    now: () => time.now,
  });
  const sync = (): void => {
    core.sync(NULL_TARGET);
  };
  const advance = (ticks: number): void => {
    sim.stats.tick += ticks;
  };
  /** Drops `n` coins a legal cooldown apart and lets the sim draw them. */
  const dropCoins = (n: number): void => {
    for (let i = 0; i < n; i += 1) {
      expect(core.drop(0)).toBe(true);
      advance(MIN_TICKS_BETWEEN_DROPS);
    }
    sync();
  };
  /** Moves a body to `at`, draws it there, then removes it as the sim does when it falls. */
  const leave = (simId: number, at: [number, number, number]): void => {
    sim.bodies.set(simId, at);
    sync();
    sim.bodies.delete(simId);
    sync();
  };
  return { sim, table, time, ui, core, sync, advance, dropCoins, leave };
}

function record<K extends GameEventType>(core: SystemsCore, type: K): GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  core.events.on(type, (payload) => {
    seen.push(payload);
  });
  return seen;
}

const FRONT: [number, number, number] = [0, 0, BOUNDS.fieldFrontZ];

describe('systems core: drops', () => {
  it('a tap sends one coin to the sim at the aimed millimetre and tells everyone', () => {
    const { core, sim, table } = setup();
    const requested = record(core, 'drop:requested');
    const inputs = record(core, 'input');
    expect(core.drop(0.5)).toBe(true);
    expect(sim.drops).toEqual([{ xMm: 75, tier: 'copper' }]);
    expect(requested).toEqual([
      { aim: 0.5, xMm: 75, tick: 0, coin: coin(1), ordinal: 1, first: true, poured: false },
    ]);
    expect(inputs).toEqual([{ kind: 'drop', tick: 0, x: 0.5, coinId: coin(1).id }]);
    expect(table.falls).toEqual([]);
  });

  it('holds back a second tap inside the drop cooldown without scolding the player', () => {
    const { core, sim, ui, advance } = setup();
    const blocked = record(core, 'drop:blocked');
    const requested = record(core, 'drop:requested');
    core.drop(0);
    expect(core.drop(0)).toBe(false);
    expect(blocked).toEqual([{ reason: 'cooldown' }]);
    expect(ui.feedback).toEqual([]);
    advance(MIN_TICKS_BETWEEN_DROPS);
    expect(core.drop(0)).toBe(true);
    expect(sim.drops).toHaveLength(2);
    expect(requested.map((r) => [r.ordinal, r.first])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('an empty buffer offline refuses the drop out loud', () => {
    const { core, table, sim, ui } = setup();
    const blocked = record(core, 'drop:blocked');
    table.online = false;
    expect(core.drop(0)).toBe(false);
    expect(blocked).toEqual([{ reason: 'empty' }]);
    expect(ui.feedback).toEqual(['deny']);
    expect(sim.drops).toEqual([]);
  });

  it('a coin the server mints only reaches the sim once the server settles it', () => {
    const { core, sim, table } = setup();
    const confirmed = record(core, 'drop:confirmed');
    table.next = { coin: null };
    expect(core.drop(-1)).toBe(true);
    expect(sim.drops).toEqual([]);
    table.emit({ type: 'dropSettled', key: key(1), coin: coin(9, 'silver'), spawnedCrates: [] });
    expect(sim.drops).toEqual([{ xMm: -150, tier: 'silver' }]);
    expect(confirmed).toEqual([{ coin: coin(9, 'silver') }]);
  });

  it('a buffered coin the server settles under another id is claimed under the server id', () => {
    const { core, table, sync, leave } = setup();
    core.drop(0);
    table.emit({ type: 'dropSettled', key: key(1), coin: coin(42), spawnedCrates: [] });
    sync();
    leave(0, FRONT);
    expect(table.falls.map((f) => f.coinId)).toEqual([coin(42).id]);
  });

  it('a rejected drop is never claimed when its coin falls', () => {
    const { core, table, sync, leave } = setup();
    const rejected = record(core, 'drop:rejected');
    const fell = record(core, 'coin:fell');
    core.drop(0);
    sync();
    table.emit({ type: 'dropRejected', key: key(1), coinId: coin(1).id, error: new Error('no') });
    leave(0, FRONT);
    expect(rejected).toEqual([{ coinId: coin(1).id }]);
    expect(fell).toHaveLength(1);
    expect(fell[0]?.coin).toBeNull();
    expect(table.falls).toEqual([]);
  });

  it('pairs each new body with its coin and reports where it appeared', () => {
    const { core, dropCoins } = setup();
    const spawned = record(core, 'coin:spawned');
    dropCoins(2);
    expect(spawned).toEqual([
      { coin: coin(1), position: { x: 0, y: 0.1, z: 0 } },
      { coin: coin(2), position: { x: 0, y: 0.1, z: 0 } },
    ]);
  });
});

describe('systems core: falls and the Cascade combo', () => {
  it('claims every front fall, climbs to Chic on the third and ends the chain after the window', () => {
    const { core, table, ui, sim, dropCoins, leave, advance } = setup();
    const steps = record(core, 'cascade:step');
    const tiers = record(core, 'cascade:tier');
    const ends = record(core, 'cascade:end');
    dropCoins(3);
    sim.stats.tick = 500;
    for (const id of [0, 1, 2]) leave(id, FRONT);
    expect(table.falls).toEqual([
      { coinId: coin(1).id, tick: 500, edge: 'front' },
      { coinId: coin(2).id, tick: 500, edge: 'front' },
      { coinId: coin(3).id, tick: 500, edge: 'front' },
    ]);
    expect(steps).toEqual([
      { count: 1, tier: null },
      { count: 2, tier: null },
      { count: 3, tier: 'chic' },
    ]);
    expect(tiers).toEqual([{ tier: 'chic', rank: 1, count: 3 }]);
    expect(ui.cascade).toEqual([1, 2, 3]);

    advance(CASCADE_WINDOW_TICKS);
    core.update();
    expect(ends).toEqual([]);
    advance(1);
    core.update();
    expect(ends).toEqual([{ count: 3, tier: 'chic' }]);
    expect(ui.cascade.at(-1)).toBe(0);
  });

  it('a side fall is claimed but does not feed the combo', () => {
    const { core, table, dropCoins, leave } = setup();
    const steps = record(core, 'cascade:step');
    dropCoins(1);
    leave(0, [-BOUNDS.fieldHalfWidth, 0, 0]);
    expect(table.falls.map((f) => f.edge)).toEqual(['left']);
    expect(steps).toEqual([]);
  });

  it('a coin leaving mid-table, as a fused coin does, is neither a fall nor a claim', () => {
    const { core, table, dropCoins, leave } = setup();
    const fell = record(core, 'coin:fell');
    dropCoins(1);
    leave(0, [0, 0, 0]);
    expect(fell).toEqual([]);
    expect(table.falls).toEqual([]);
  });

  it('a frame the sim has not drawn yet changes nothing', () => {
    const { core, sim, table, sync, dropCoins } = setup();
    const spawned = record(core, 'coin:spawned');
    const fell = record(core, 'coin:fell');
    dropCoins(1);
    sim.drawing = false;
    sync();
    expect(fell).toEqual([]);
    expect(table.falls).toEqual([]);
    sim.drawing = true;
    sync();
    expect(spawned).toHaveLength(1);
    expect(fell).toEqual([]);
  });

  it('credits exactly what the server accepted, at the place the coin fell', () => {
    const { core, table, dropCoins, leave } = setup();
    const credited = record(core, 'value:credited');
    const confirmed = record(core, 'cascade:confirmed');
    dropCoins(2);
    leave(0, FRONT);
    leave(1, FRONT);
    table.emit({
      type: 'claimSettled',
      claim: { kind: 'fall', coinId: coin(1).id, tick: 0, edge: 'front' },
      result: { status: 'accepted', credited: 11, cascade: 'chic', minted: null },
    });
    table.emit({
      type: 'claimSettled',
      claim: { kind: 'fall', coinId: coin(2).id, tick: 0, edge: 'front' },
      result: { status: 'rejected', reason: 'already_claimed' },
    });
    expect(credited).toEqual([
      {
        amount: 11,
        coinId: coin(1).id,
        tier: 'copper',
        position: { x: 0, y: 0, z: BOUNDS.fieldFrontZ },
        cascade: 'chic',
      },
    ]);
    expect(confirmed).toEqual([{ tier: 'chic', coinId: coin(1).id }]);
  });
});

describe('systems core: nudge, Decorum and the Concierge', () => {
  it('a nudge reaches the server, ticks the meter and the haptic', () => {
    const { core, table, ui } = setup();
    const nudges = record(core, 'nudge');
    expect(core.nudge('left', 3, 'swipe')).toBe(true);
    expect(table.nudges).toEqual([{ tick: 0, direction: 'left' }]);
    expect(nudges).toEqual([{ direction: 'left', strength: 1, source: 'swipe', tick: 0 }]);
    expect(ui.feedback).toEqual(['tick']);
    expect(ui.decorum.at(-1)).toEqual({
      used: DECORUM_PER_NUDGE,
      capacity: decorumCapacity({}),
      frozenSeconds: 0,
    });
  });

  it('offline, a nudge is refused and nothing moves', () => {
    const { core, table, ui } = setup();
    const rejected = record(core, 'nudge:rejected');
    table.online = false;
    expect(core.nudge('right', 1, 'motion')).toBe(false);
    expect(rejected).toEqual([{ reason: 'offline' }]);
    expect(ui.feedback).toEqual(['deny']);
    expect(ui.decorum).toEqual([]);
  });

  it('the server freezes the table: nudges and drops are refused until it thaws', () => {
    const { core, table, time, sim } = setup();
    const freezes = record(core, 'concierge:freeze');
    const thaws = record(core, 'concierge:thaw');
    const rejected = record(core, 'nudge:rejected');
    const blocked = record(core, 'drop:blocked');
    table.emit({ type: 'nudgeSettled', decorum: 1, frozenUntil: SERVER_NOW + 3_000 });
    expect(freezes).toEqual([{ seconds: 3 }]);
    expect(core.nudge('forward', 1, 'key')).toBe(false);
    expect(rejected).toEqual([{ reason: 'frozen' }]);
    expect(core.drop(0)).toBe(false);
    expect(blocked).toEqual([{ reason: 'frozen' }]);
    expect(sim.drops).toEqual([]);

    time.now = 2_999;
    core.update();
    expect(thaws).toEqual([]);
    time.now = 3_000;
    core.update();
    expect(thaws).toEqual([{}]);
    expect(core.drop(0)).toBe(true);
  });

  it('the server rejecting a nudge is announced', () => {
    const { core, table } = setup();
    const rejected = record(core, 'nudge:rejected');
    table.emit({ type: 'nudgeRejected', error: new Error('table_frozen') });
    expect(rejected).toEqual([{ reason: 'server' }]);
  });

  it('a freeze cuts a running pour short and grades it', () => {
    const { core, table } = setup();
    const ends = record(core, 'pour:end');
    core.startPour(0);
    table.emit({ type: 'nudgeSettled', decorum: 1, frozenUntil: SERVER_NOW + 1_000 });
    expect(ends).toHaveLength(1);
    expect(core.pourView().pouring).toBe(false);
  });
});

describe('systems core: the Sommelier Pour', () => {
  it('streams coins on the stream cadence and grades a release on the marker as perfect', () => {
    const { core, sim, time, ui, advance } = setup();
    const starts = record(core, 'pour:start');
    const ends = record(core, 'pour:end');
    const requested = record(core, 'drop:requested');
    core.startPour(0.2);
    expect(starts).toEqual([{ aim: 0.2, tick: 0, targetMs: POUR_TARGET_MS }]);
    expect(sim.drops).toHaveLength(1);
    advance(POUR_STREAM_TICKS - 1);
    core.update();
    expect(sim.drops).toHaveLength(1);
    advance(1);
    core.update();
    expect(sim.drops).toHaveLength(2);
    expect(requested.every((r) => r.poured)).toBe(true);

    time.now = POUR_TARGET_MS;
    expect(core.pourView()).toMatchObject({ pouring: true, progress: 1, inWindow: true });
    const result = core.endPour();
    expect(result?.grade).toBe('perfect');
    expect(ends).toEqual([
      { grade: 'perfect', offsetMs: 0, heldMs: POUR_TARGET_MS, drops: 2, tick: POUR_STREAM_TICKS },
    ]);
    expect(ui.feedback).toEqual(['confirm']);
    expect(core.endPour()).toBeNull();
  });

  it('an early release is graded early with no Perfect Pour flourish', () => {
    const { core, time, ui } = setup();
    core.startPour(0);
    time.now = POUR_TARGET_MS / 4;
    expect(core.endPour()?.grade).toBe('early');
    expect(ui.feedback).toEqual([]);
  });

  it('a cancelled pour is not graded and stops streaming', () => {
    const { core, sim, advance } = setup();
    const cancels = record(core, 'pour:cancel');
    const ends = record(core, 'pour:end');
    core.startPour(0);
    core.cancelPour();
    advance(POUR_STREAM_TICKS * 3);
    core.update();
    expect(cancels).toEqual([{ drops: 1, tick: 0 }]);
    expect(ends).toEqual([]);
    expect(sim.drops).toHaveLength(1);
  });
});

describe('systems core: fusion, contacts and lifetime', () => {
  it('claims a fusion of three known coins and still shows one it cannot claim', () => {
    const { core, table, dropCoins } = setup();
    const fusions = record(core, 'coin:fusion');
    dropCoins(3);
    const center = { x: 0, y: 0.1, z: 0 };
    core.reportFusion({ simIds: [0, 1, 2], center, tier: 'silver' });
    core.reportFusion({ simIds: [7, 8, 9], center, tier: 'silver' });
    expect(table.fusions).toEqual([[coin(1).id, coin(2).id, coin(3).id]]);
    expect(fusions.map((f) => f.claimed)).toEqual([true, false]);
    expect(fusions[1]?.sources).toEqual([center, center, center]);
  });

  it('clamps contact strength for the audio and vfx', () => {
    const { core } = setup();
    const contacts = record(core, 'coin:contact');
    const position = { x: 0, y: 0, z: 0 };
    core.reportContact({ position, strength: 4, surface: 'coin' });
    core.reportContact({ position, strength: -1, surface: 'metal' });
    expect(contacts.map((c) => c.strength)).toEqual([1, 0]);
  });

  it('after dispose it stops listening to the table and refuses new input', () => {
    const { core, table } = setup();
    core.dispose();
    expect(table.listeners.size).toBe(0);
    expect(() => core.drop(0)).toThrow(/disposed/);
    expect(() => core.nudge('left', 1, 'key')).toThrow(/disposed/);
    core.dispose();
  });

  it('rejects a NaN aim instead of dropping somewhere arbitrary', () => {
    const { core, sim } = setup();
    expect(() => core.drop(Number.NaN)).toThrow(RangeError);
    expect(sim.drops).toEqual([]);
  });
});

describe('systems strings', () => {
  const keysOf = (tree: object, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([k, v]: [string, unknown]) =>
      typeof v === 'object' && v !== null ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );

  it('has every key in EN, FR and DE, none of them empty', () => {
    const en = keysOf(SYSTEMS_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(keysOf(SYSTEMS_STRINGS[language]).sort()).toEqual(en);
    }
  });

  it('resolves in the player language once registered', () => {
    const i18n = createI18n({ language: 'fr', resources: { en: {}, fr: {}, de: {} } });
    registerSystemsStrings(i18n);
    expect(i18n.t(systemsKey('pour.perfect'))).toBe(SYSTEMS_STRINGS.fr.pour.perfect);
    expect(systemsKey('aim.label')).toBe(`${SYSTEMS_NAMESPACE}:aim.label`);
  });
});
