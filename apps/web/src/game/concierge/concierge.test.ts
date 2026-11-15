import type {
  CascadeTier,
  CoinId,
  CrateId,
  MintedCoin,
  Rarity,
  Roll,
  SafeId,
  ScratchCardId,
  Tick,
  Wallet,
} from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus } from '../../app/bus.ts';
import type { AscensionEvents } from '../ascension/events.ts';
import type { CrateEvents } from '../crates/events.ts';
import type { SafeEvents } from '../safes/events.ts';
import type { ScratchEvents } from '../scratch/events.ts';
import type { GameEvents, TablePoint } from '../systems/events.ts';
import type { UpgradeEvents } from '../upgrades/events.ts';
import type { VaultEvents } from '../vault/events.ts';
import {
  CINEMATIC_QUIET_MAX_MS,
  CONCIERGE_GAP_MS,
  CONCIERGE_IDLE_MS,
  CONCIERGE_OPENING_HUSH_MS,
  CONCIERGE_STORAGE_KEY,
  createConcierge,
  type Concierge,
  type ConciergeClock,
  type ConciergeHushReason,
  type ConciergeLine,
} from './brain.ts';
import {
  CONCIERGE_DURATION_MS,
  CONCIERGE_LINE_IDS,
  CONCIERGE_LINE_VARIANTS,
  CONCIERGE_LINES,
  CUT_IN_PRIORITY,
  isConciergeLineId,
  type ConciergeLineId,
} from './lines.ts';
import {
  CONCIERGE_RULES,
  GUTTER_STREAK,
  GUTTER_WINDOW_MS,
  TOWER_TIP_AFTER_DROPS,
  type ConciergeState,
  type ConciergeTowerView,
} from './rules.ts';

class FakeClock implements ConciergeClock {
  time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (next === null || entry[1].at < next[1].at)) next = entry;
      }
      if (next === null) break;
      this.timers.delete(next[0]);
      this.time = Math.max(this.time, next[1].at);
      next[1].callback();
    }
    this.time = target;
  }
}

class MemoryStore {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const AT: TablePoint = { x: 0, y: 0, z: 0 };
const WALLET: Wallet = {
  coins: 0,
  bullion: 0,
  goldBars: 0,
  pearls: 0,
  keys: 0,
  tickets: 0,
  stars: 0,
};

function coin(id = 'c1'): MintedCoin {
  return { id: id as CoinId, tier: 'copper', value: 1 };
}

/** The brain reads only the rarity; the proof and rewards are the server's business. */
function roll(rarity: Rarity): Roll {
  return { rarity } as unknown as Roll;
}

interface Harness {
  readonly clock: FakeClock;
  readonly game: Bus<GameEvents>;
  readonly crates: Bus<CrateEvents>;
  readonly vault: Bus<VaultEvents>;
  readonly upgrades: Bus<UpgradeEvents>;
  readonly safes: Bus<SafeEvents>;
  readonly scratch: Bus<ScratchEvents>;
  readonly ascension: Bus<AscensionEvents>;
  readonly state: {
    coins: number;
    inHand: number;
    tower: ConciergeTowerView | null;
    affordable: string | null;
  };
  readonly store: MemoryStore;
  readonly said: ConciergeLine[];
  readonly hushed: { lineId: ConciergeLineId; reason: ConciergeHushReason }[];
  readonly concierge: Concierge;
  /** Starts past the opening hush so a test sees its own rule, not the FTUE quiet. */
  open(): void;
  saidIds(): ConciergeLineId[];
}

let harnesses: Harness[] = [];

function harness(
  options: { store?: MemoryStore; rng?: () => number; withState?: boolean } = {},
): Harness {
  const clock = new FakeClock();
  const game = createBus<GameEvents>();
  const crates = createBus<CrateEvents>();
  const vault = createBus<VaultEvents>();
  const upgrades = createBus<UpgradeEvents>();
  const safes = createBus<SafeEvents>();
  const scratch = createBus<ScratchEvents>();
  const ascension = createBus<AscensionEvents>();
  const playerState = {
    coins: 30,
    inHand: 0,
    tower: null as ConciergeTowerView | null,
    affordable: null as string | null,
  };
  const state: ConciergeState =
    options.withState === false
      ? {}
      : {
          vault: () => ({ coins: playerState.coins, inHand: playerState.inHand }),
          tower: () => playerState.tower,
          affordableUpgrade: () => playerState.affordable,
        };
  const store = options.store ?? new MemoryStore();
  const concierge = createConcierge({
    bus: game,
    feeds: { crates, vault, upgrades, safes, scratch, ascension },
    state,
    clock,
    rng: options.rng ?? (() => 0),
    store,
  });
  const said: ConciergeLine[] = [];
  const hushed: { lineId: ConciergeLineId; reason: ConciergeHushReason }[] = [];
  concierge.events.on('concierge:say', (line) => said.push(line));
  concierge.events.on('concierge:hush', (event) => hushed.push(event));
  const h: Harness = {
    clock,
    game,
    crates,
    vault,
    upgrades,
    safes,
    scratch,
    ascension,
    state: playerState,
    store,
    said,
    hushed,
    concierge,
    open() {
      clock.advance(CONCIERGE_OPENING_HUSH_MS);
    },
    saidIds() {
      return said.map((line) => line.lineId);
    },
  };
  harnesses.push(h);
  return h;
}

/** Lets the current line finish and the breather pass, so the next offer speaks at once. */
function settle(h: Harness): void {
  h.clock.advance(CONCIERGE_DURATION_MS.tip + CONCIERGE_GAP_MS);
}

function drop(h: Harness, ordinal = 1): void {
  h.game.emit('drop:requested', {
    aim: 0.5,
    xMm: 0,
    tick: ordinal,
    coin: coin(),
    ordinal,
    first: ordinal === 1,
    poured: false,
  });
}

function cascadeEnd(h: Harness, tier: CascadeTier | null, count = 6): void {
  h.game.emit('cascade:end', { count, tier });
}

beforeEach(() => {
  harnesses = [];
});

afterEach(() => {
  for (const h of harnesses) h.concierge.dispose();
  vi.restoreAllMocks();
});

describe('line table', () => {
  it('gives the copy at least 120 lines to write across the ids', () => {
    expect(CONCIERGE_LINE_IDS.length * CONCIERGE_LINE_VARIANTS).toBeGreaterThanOrEqual(120);
  });

  it('names a known line id in every rule-table suggestion it can make', () => {
    expect(CONCIERGE_LINE_IDS.every(isConciergeLineId)).toBe(true);
    expect(isConciergeLineId('cascade.vulgar')).toBe(false);
    expect(new Set(CONCIERGE_RULES.map((rule) => rule.id)).size).toBe(CONCIERGE_RULES.length);
  });

  it('keeps every wait shorter than the cinematic safety and every priority positive', () => {
    for (const id of CONCIERGE_LINE_IDS) {
      const spec = CONCIERGE_LINES[id];
      expect(spec.priority).toBeGreaterThan(0);
      expect(spec.waitMs).toBeGreaterThan(0);
      expect(spec.waitMs).toBeLessThan(CINEMATIC_QUIET_MAX_MS);
      expect(spec.cooldownMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('rules', () => {
  it('greets the first small cascade, then names each tier after it', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'chic');
    expect(h.saidIds()).toEqual(['greeting.firstCascade']);
    settle(h);
    cascadeEnd(h, 'lavish', 9);
    expect(h.said.at(-1)).toMatchObject({ lineId: 'cascade.lavish', params: { count: 9 } });
    settle(h);
    cascadeEnd(h, null);
    expect(h.said).toHaveLength(2);
  });

  it.each([
    ['opulent', 'cascade.opulent'],
    ['decadent', 'cascade.decadent'],
  ] as const)('names a %s cascade even as the first of the session', (tier, line) => {
    const h = harness();
    h.open();
    cascadeEnd(h, tier);
    expect(h.saidIds()).toEqual([line]);
  });

  it('gasps at OBSCENE the moment the chain reaches it, not again at its end', () => {
    const h = harness();
    h.open();
    h.game.emit('cascade:tier', { tier: 'decadent', rank: 4, count: 20 });
    expect(h.said).toHaveLength(0);
    h.game.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 30 });
    cascadeEnd(h, 'obscene', 34);
    expect(h.saidIds()).toEqual(['cascade.obscene']);
    expect(h.said[0]?.expression).toBe('scandalised');
  });

  it('introduces the first fusion as a tip, then keeps minor fusions to chatter', () => {
    const h = harness();
    h.open();
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'silver', claimed: true });
    expect(h.said[0]).toMatchObject({ lineId: 'fusion.first', kind: 'tip' });
    settle(h);
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'gold', claimed: true });
    expect(h.said.at(-1)?.lineId).toBe('fusion.minor');
  });

  it.each([
    ['platinum', 'fusion.platinum'],
    ['diamond', 'fusion.diamond'],
    ['heirloom', 'fusion.heirloom'],
  ] as const)('celebrates a %s fusion by name', (tier, line) => {
    const h = harness();
    h.open();
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier, claimed: true });
    expect(h.said[0]).toMatchObject({ lineId: line, params: { tier } });
  });

  it('compliments a perfect pour of more than one coin only', () => {
    const h = harness();
    h.open();
    const pour = { offsetMs: 0, heldMs: 900, tick: 1 as Tick };
    h.game.emit('pour:end', { ...pour, grade: 'perfect', drops: 1 });
    h.game.emit('pour:end', { ...pour, grade: 'late', drops: 5 });
    expect(h.said).toHaveLength(0);
    h.game.emit('pour:end', { ...pour, grade: 'perfect', drops: 4 });
    expect(h.saidIds()).toEqual(['pour.perfect']);
  });

  it('warns once as Decorum runs high and re-arms after it drains', () => {
    const h = harness();
    h.open();
    const decorum = (fraction: number, frozenSeconds = 0) => {
      h.game.emit('decorum:change', { used: fraction * 4, capacity: 4, fraction, frozenSeconds });
    };
    decorum(0.5);
    decorum(0.8);
    expect(h.saidIds()).toEqual(['decorum.warning']);
    settle(h);
    decorum(0.9);
    decorum(0.6);
    expect(h.said).toHaveLength(1);
    decorum(0.2);
    h.clock.advance(CONCIERGE_LINES['decorum.warning'].cooldownMs);
    decorum(0.8);
    expect(h.saidIds()).toEqual(['decorum.warning', 'decorum.warning']);
  });

  it('stays quiet about Decorum while the table is frozen', () => {
    const h = harness();
    h.open();
    h.game.emit('decorum:change', { used: 4, capacity: 4, fraction: 1, frozenSeconds: 10 });
    expect(h.said).toHaveLength(0);
  });

  it('rings the bell on a freeze, cutting in over anything lesser', () => {
    const h = harness();
    h.open();
    h.game.emit('pour:end', {
      grade: 'perfect',
      offsetMs: 0,
      heldMs: 900,
      drops: 3,
      tick: 1,
    });
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.saidIds()).toEqual(['pour.perfect', 'decorum.freeze']);
    expect(h.hushed).toEqual([{ lineId: 'pour.perfect', reason: 'preempted' }]);
    expect(h.said[1]).toMatchObject({ expression: 'scandalised', params: { seconds: 10 } });
  });

  it('answers a drop while frozen with a dry remark', () => {
    const h = harness();
    h.open();
    h.game.emit('drop:blocked', { reason: 'frozen' });
    expect(h.saidIds()).toEqual(['decorum.stillFrozen']);
  });

  it('points at the ledge when a tap finds the Vault empty', () => {
    const h = harness();
    h.open();
    h.state.coins = 0;
    h.game.emit('drop:blocked', { reason: 'empty' });
    expect(h.said[0]).toMatchObject({ lineId: 'vault.empty', kind: 'tip' });
  });

  it('answers an empty Vault even inside the opening hush, since the player asked', () => {
    const h = harness();
    h.state.coins = 0;
    h.game.emit('drop:blocked', { reason: 'empty' });
    expect(h.saidIds()).toEqual(['vault.empty']);
  });

  it('trusts the server balance over a stale empty block', () => {
    const h = harness();
    h.open();
    h.state.coins = 0;
    h.state.inHand = 3;
    h.game.emit('drop:blocked', { reason: 'empty' });
    expect(h.said).toHaveLength(0);
  });

  it('still gives the empty-Vault hint without a balance reader', () => {
    const h = harness({ withState: false });
    h.open();
    h.game.emit('drop:blocked', { reason: 'empty' });
    expect(h.saidIds()).toEqual(['vault.empty']);
  });

  it('ignores cooldown and suspended blocks', () => {
    const h = harness();
    h.open();
    h.game.emit('drop:blocked', { reason: 'cooldown' });
    h.game.emit('drop:blocked', { reason: 'suspended' });
    expect(h.said).toHaveLength(0);
  });

  it('suggests aiming centre after a streak of gutter losses inside the window', () => {
    const h = harness();
    h.open();
    const fall = (edge: 'front' | 'left' | 'right') => {
      h.game.emit('coin:fell', { coin: coin(), edge, position: AT, tick: 1 });
    };
    for (let i = 0; i < GUTTER_STREAK - 1; i += 1) fall('left');
    fall('front');
    fall('right');
    expect(h.said).toHaveLength(0);
    for (let i = 0; i < GUTTER_STREAK - 1; i += 1) {
      fall('left');
      h.clock.advance(GUTTER_WINDOW_MS / 2);
    }
    expect(h.said).toHaveLength(0);
    for (let i = 0; i < GUTTER_STREAK; i += 1) fall('right');
    expect(h.saidIds()).toEqual(['tip.aimCentre']);
  });

  it('never counts an unminted coin toward the gutter streak', () => {
    const h = harness();
    h.open();
    for (let i = 0; i < GUTTER_STREAK * 2; i += 1) {
      h.game.emit('coin:fell', { coin: null, edge: 'left', position: AT, tick: 1 });
    }
    expect(h.said).toHaveLength(0);
  });

  it('tells the player to feed a bare tower once they have found their aim', () => {
    const h = harness();
    h.open();
    h.state.tower = { stacked: 1, risk: 0.1 };
    for (let i = 1; i < TOWER_TIP_AFTER_DROPS; i += 1) drop(h, i);
    expect(h.said).toHaveLength(0);
    drop(h, TOWER_TIP_AFTER_DROPS);
    expect(h.saidIds()).toEqual(['tip.feedTower']);
  });

  it('does not tell anyone to feed a tall tower, and gasps when it wobbles', () => {
    const h = harness();
    h.open();
    h.state.tower = { stacked: 14, risk: 0.3 };
    for (let i = 1; i <= TOWER_TIP_AFTER_DROPS + 5; i += 1) drop(h, i);
    expect(h.said).toHaveLength(0);
    h.state.tower = { stacked: 21, risk: 0.85 };
    drop(h, 99);
    expect(h.saidIds()).toEqual(['tower.wobbling']);
  });

  it('says nothing about towers on a table without one', () => {
    const h = harness();
    h.open();
    for (let i = 1; i <= TOWER_TIP_AFTER_DROPS + 5; i += 1) drop(h, i);
    expect(h.said).toHaveLength(0);
  });

  it('names an affordable upgrade once, and again only after it was bought', () => {
    const h = harness();
    h.open();
    const credit = () => {
      h.game.emit('value:credited', {
        amount: 5,
        coinId: 'c1' as CoinId,
        tier: 'copper',
        position: AT,
        cascade: null,
      });
    };
    credit();
    expect(h.said).toHaveLength(0);
    h.state.affordable = 'pusherSpeed';
    credit();
    expect(h.said[0]).toMatchObject({
      lineId: 'tip.upgradeAffordable',
      params: { upgrade: 'pusherSpeed' },
    });
    settle(h);
    h.clock.advance(CONCIERGE_LINES['tip.upgradeAffordable'].cooldownMs);
    credit();
    expect(h.said).toHaveLength(1);
    h.upgrades.emit('upgrade:purchased', { lineId: 'pusherSpeed', level: 1, wallet: WALLET });
    expect(h.said.at(-1)).toMatchObject({
      lineId: 'upgrade.purchased',
      params: { upgrade: 'pusherSpeed', level: 1 },
    });
    settle(h);
    credit();
    expect(h.saidIds()).toEqual([
      'tip.upgradeAffordable',
      'upgrade.purchased',
      'tip.upgradeAffordable',
    ]);
  });

  it('keeps offering the upgrade tip until it is actually heard', () => {
    const h = harness();
    h.open();
    h.game.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 30 });
    h.state.affordable = 'decorumCapacity';
    h.vault.emit('vault:collected', { coins: 0 });
    expect(h.saidIds()).toEqual(['cascade.obscene']);
    settle(h);
    h.crates.emit('crate:collected', {
      crateId: 'k1' as CrateId,
      roll: roll('common'),
      wallet: WALLET,
    });
    expect(h.saidIds()).toContain('tip.upgradeAffordable');
  });

  it('skips the first crate of a session, which has its own hint, and resumed crates', () => {
    const h = harness();
    h.open();
    const spawn = (id: string, resumed: boolean) => {
      h.crates.emit('crate:spawned', {
        crateId: id as CrateId,
        kind: 'vault',
        position: AT,
        resumed,
      });
    };
    spawn('k0', true);
    spawn('k1', false);
    expect(h.said).toHaveLength(0);
    spawn('k2', false);
    expect(h.saidIds()).toEqual(['crate.arrived']);
  });

  it.each([
    ['common', 'reward.modest'],
    ['fine', 'reward.modest'],
    ['rare', 'reward.rare'],
    ['exquisite', 'reward.rare'],
    ['legendary', 'reward.legendary'],
    ['heirloom', 'reward.legendary'],
  ] as const)('grades a %s crate after its cinematic', (rarity, line) => {
    const h = harness();
    h.open();
    const crateId = 'k1' as CrateId;
    h.crates.emit('crate:fell', { crateId, tick: 1, position: AT });
    h.crates.emit('crate:revealed', { crateId, rarity });
    expect(h.said).toHaveLength(0);
    h.crates.emit('crate:collected', { crateId, roll: roll(rarity), wallet: WALLET });
    expect(h.said[0]).toMatchObject({ lineId: line, params: { rarity } });
  });

  it('grades safes and scratch cards once they are collected', () => {
    const h = harness();
    h.open();
    const safeId = 's1' as SafeId;
    h.safes.emit('safe:requested', { safeId, method: 'timer' });
    h.safes.emit('safe:collected', { safeId, roll: roll('legendary'), wallet: WALLET });
    expect(h.saidIds()).toEqual(['reward.legendary']);
    settle(h);
    const cardId = 'x1' as ScratchCardId;
    h.scratch.emit('scratch:requested', { cardId });
    h.scratch.emit('scratch:collected', { cardId, roll: roll('rare'), wallet: WALLET });
    expect(h.saidIds()).toEqual(['reward.legendary', 'reward.rare']);
  });

  it('welcomes the player back from the Vault, or chides a capped one', () => {
    const h = harness();
    h.open();
    h.vault.emit('vault:opened', { coins: 120, capped: false });
    h.vault.emit('vault:collected', { coins: 120 });
    expect(h.said[0]).toMatchObject({ lineId: 'vault.welcomeBack', params: { coins: 120 } });
    settle(h);
    h.vault.emit('vault:opened', { coins: 900, capped: true });
    h.vault.emit('vault:collected', { coins: 900 });
    expect(h.said.at(-1)).toMatchObject({ lineId: 'vault.capped', kind: 'tip' });
  });

  it('greets a new venue once the ascension cinematic hands back', () => {
    const h = harness();
    h.open();
    h.ascension.emit('ascension:requested', { venueId: 'salonDeParis' });
    h.clock.advance(5000);
    expect(h.said).toHaveLength(0);
    h.ascension.emit('ascension:completed', { venueId: 'salonDeParis' });
    expect(h.said[0]).toMatchObject({
      lineId: 'ascension.arrived',
      params: { venue: 'salonDeParis' },
    });
  });

  it('wonders aloud after a long pause with coins to spend, once per pause', () => {
    const h = harness();
    h.open();
    drop(h);
    h.clock.advance(CONCIERGE_IDLE_MS - 1);
    expect(h.said).toHaveLength(0);
    h.clock.advance(1);
    expect(h.saidIds()).toEqual(['tip.idle']);
    h.clock.advance(CONCIERGE_IDLE_MS * 4);
    expect(h.said).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
  });

  it('does not nag about idling with an empty Vault', () => {
    const h = harness();
    h.open();
    drop(h);
    h.state.coins = 0;
    h.clock.advance(CONCIERGE_IDLE_MS * 2);
    expect(h.said).toHaveLength(0);
  });

  it('pushes the idle wait back by any drop', () => {
    const h = harness();
    h.open();
    drop(h);
    h.clock.advance(CONCIERGE_IDLE_MS - 1000);
    drop(h, 2);
    h.clock.advance(CONCIERGE_IDLE_MS - 1000);
    expect(h.said).toHaveLength(0);
    h.clock.advance(1000);
    expect(h.saidIds()).toEqual(['tip.idle']);
  });

  it('subscribes only to the feeds it was given', () => {
    const clock = new FakeClock();
    const game = createBus<GameEvents>();
    const concierge = createConcierge({ bus: game, state: {}, clock, rng: () => 0 });
    const said: ConciergeLine[] = [];
    concierge.events.on('concierge:say', (line) => said.push(line));
    clock.advance(CONCIERGE_OPENING_HUSH_MS);
    game.emit('concierge:freeze', { seconds: 10 });
    expect(said.map((line) => line.lineId)).toEqual(['decorum.freeze']);
    concierge.dispose();
  });
});

describe('floor', () => {
  it('holds ordinary lines through the opening hush and drops the stale ones', () => {
    const h = harness();
    h.game.emit('pour:end', {
      grade: 'perfect',
      offsetMs: 0,
      heldMs: 900,
      drops: 3,
      tick: 1,
    });
    h.clock.advance(CONCIERGE_OPENING_HUSH_MS);
    expect(h.said).toHaveLength(0);

    const late = harness();
    late.clock.advance(CONCIERGE_OPENING_HUSH_MS - 1000);
    cascadeEnd(late, 'chic');
    expect(late.said).toHaveLength(0);
    late.clock.advance(1000);
    expect(late.saidIds()).toEqual(['greeting.firstCascade']);
  });

  it('keeps one line at a time and ends it after its duration', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'opulent');
    expect(h.concierge.current?.lineId).toBe('cascade.opulent');
    h.clock.advance(CONCIERGE_DURATION_MS.remark - 1);
    expect(h.concierge.current?.lineId).toBe('cascade.opulent');
    h.clock.advance(1);
    expect(h.concierge.current).toBeNull();
    expect(h.hushed).toEqual([{ lineId: 'cascade.opulent', reason: 'done' }]);
  });

  it('waits out the breather between lines, then speaks the waiting one', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'opulent');
    h.clock.advance(CONCIERGE_DURATION_MS.remark);
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'diamond', claimed: true });
    expect(h.said).toHaveLength(1);
    h.clock.advance(CONCIERGE_LINES['fusion.diamond'].waitMs - 1);
    expect(h.said).toHaveLength(1);

    const patient = harness();
    patient.open();
    cascadeEnd(patient, 'opulent');
    patient.clock.advance(CONCIERGE_DURATION_MS.remark + CONCIERGE_GAP_MS - 1000);
    patient.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'diamond', claimed: true });
    patient.clock.advance(999);
    expect(patient.said).toHaveLength(1);
    patient.clock.advance(1);
    expect(patient.saidIds()).toEqual(['cascade.opulent', 'fusion.diamond']);
  });

  it('respects each line’s own cooldown', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'chic');
    settle(h);
    cascadeEnd(h, 'opulent');
    settle(h);
    cascadeEnd(h, 'opulent');
    expect(h.saidIds()).toEqual(['greeting.firstCascade', 'cascade.opulent']);
    h.clock.advance(CONCIERGE_LINES['cascade.opulent'].cooldownMs);
    cascadeEnd(h, 'opulent');
    expect(h.saidIds()).toEqual(['greeting.firstCascade', 'cascade.opulent', 'cascade.opulent']);
  });

  it('speaks the highest-priority waiting line and lets a lesser one go', () => {
    const h = harness();
    h.open();
    h.game.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 30 });
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'platinum', claimed: true });
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'diamond', claimed: true });
    h.game.emit('pour:end', {
      grade: 'perfect',
      offsetMs: 0,
      heldMs: 900,
      drops: 3,
      tick: 1,
    });
    h.clock.advance(CONCIERGE_DURATION_MS.remark);
    h.clock.advance(CONCIERGE_GAP_MS);
    expect(h.saidIds()).toEqual(['cascade.obscene']);

    const close = harness();
    close.open();
    close.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'diamond', claimed: true });
    close.clock.advance(CONCIERGE_DURATION_MS.remark + CONCIERGE_GAP_MS - 500);
    close.game.emit('pour:end', {
      grade: 'perfect',
      offsetMs: 0,
      heldMs: 900,
      drops: 3,
      tick: 1,
    });
    close.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'platinum', claimed: true });
    close.clock.advance(500);
    expect(close.saidIds()).toEqual(['fusion.diamond', 'fusion.platinum']);
  });

  it('lets only a cut-in line interrupt, and never one of equal rank', () => {
    expect(CONCIERGE_LINES['cascade.opulent'].priority).toBeLessThan(CUT_IN_PRIORITY);
    const h = harness();
    h.open();
    cascadeEnd(h, 'lavish');
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'diamond', claimed: true });
    expect(h.concierge.current?.lineId).toBe('greeting.firstCascade');
    h.game.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 30 });
    expect(h.concierge.current?.lineId).toBe('cascade.obscene');
    h.ascension.emit('ascension:completed', { venueId: 'salonDeParis' });
    expect(h.concierge.current?.lineId).toBe('cascade.obscene');
  });

  it('never says the same variant twice running', () => {
    let calls = 0;
    const sequence = [0.1, 0.1, 0.1, 0.99, 0.99];
    const h = harness({ rng: () => sequence[calls++ % sequence.length] ?? 0 });
    h.open();
    const variants: number[] = [];
    for (const _ of sequence) {
      h.game.emit('concierge:freeze', { seconds: 10 });
      variants.push(h.said.at(-1)?.variant ?? -1);
      settle(h);
    }
    for (let i = 1; i < variants.length; i += 1) expect(variants[i]).not.toBe(variants[i - 1]);
    expect(variants.every((v) => v >= 0 && v < CONCIERGE_LINE_VARIANTS)).toBe(true);
  });

  it('carries the line’s expression, kind, priority and read time to the card', () => {
    const h = harness();
    h.open();
    h.state.coins = 0;
    h.game.emit('drop:blocked', { reason: 'empty' });
    const spec = CONCIERGE_LINES['vault.empty'];
    expect(h.said[0]).toEqual({
      lineId: 'vault.empty',
      variant: 0,
      expression: spec.expression,
      kind: spec.kind,
      priority: spec.priority,
      durationMs: CONCIERGE_DURATION_MS.tip,
      params: {},
    });
  });

  it('lets the player tap a line away, which starts the breather', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'opulent');
    h.concierge.dismiss();
    expect(h.concierge.current).toBeNull();
    expect(h.hushed).toEqual([{ lineId: 'cascade.opulent', reason: 'dismissed' }]);
    h.game.emit('coin:fusion', { sources: [AT], center: AT, tier: 'platinum', claimed: true });
    expect(h.said).toHaveLength(1);
  });

  it('never delays the event that triggered it: lines go out on the same call', () => {
    const h = harness();
    h.open();
    let seenDuringEmit = 0;
    h.concierge.events.on('concierge:say', () => {
      seenDuringEmit += 1;
    });
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(seenDuringEmit).toBe(1);
    expect(h.clock.pending).toBeLessThanOrEqual(1);
  });
});

describe('quiet periods', () => {
  it('steps aside for a crate cinematic and speaks after it hands back', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'opulent');
    const crateId = 'k1' as CrateId;
    h.crates.emit('crate:fell', { crateId, tick: 1, position: AT });
    expect(h.hushed).toEqual([{ lineId: 'cascade.opulent', reason: 'quiet' }]);
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.said).toHaveLength(1);
    h.crates.emit('crate:collected', { crateId, roll: roll('legendary'), wallet: WALLET });
    expect(h.saidIds()).toEqual(['cascade.opulent', 'reward.legendary']);
  });

  it('counts the cinematic as the breather, so its reward speaks as it hands back', () => {
    const h = harness();
    h.open();
    cascadeEnd(h, 'opulent');
    const crateId = 'k1' as CrateId;
    h.crates.emit('crate:fell', { crateId, tick: 1, position: AT });
    h.clock.advance(2000);
    h.crates.emit('crate:collected', { crateId, roll: roll('rare'), wallet: WALLET });
    expect(h.saidIds()).toEqual(['cascade.opulent', 'reward.rare']);
  });

  it('ends a crate quiet on a rejection too', () => {
    const h = harness();
    h.open();
    const crateId = 'k1' as CrateId;
    h.crates.emit('crate:fell', { crateId, tick: 1, position: AT });
    h.crates.emit('crate:rejected', { crateId, reason: 'unknown' as never });
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.saidIds()).toEqual(['decorum.freeze']);
  });

  it('holds while any sheet is up, however long', () => {
    const h = harness();
    h.open();
    h.concierge.setQuiet('sheet', true);
    h.game.emit('concierge:freeze', { seconds: 10 });
    h.clock.advance(CINEMATIC_QUIET_MAX_MS * 3);
    expect(h.said).toHaveLength(0);
    h.concierge.setQuiet('sheet', false);
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.saidIds()).toEqual(['decorum.freeze']);
  });

  it('speaks a line still within its patience once the quiet lifts', () => {
    const h = harness();
    h.open();
    h.concierge.setQuiet('hold', true);
    h.game.emit('concierge:freeze', { seconds: 10 });
    h.clock.advance(1000);
    h.concierge.setQuiet('hold', false);
    expect(h.saidIds()).toEqual(['decorum.freeze']);
  });

  it('lets go of a cinematic that never reported its end', () => {
    const h = harness();
    h.open();
    h.safes.emit('safe:requested', { safeId: 's1' as SafeId, method: 'key' });
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.said).toHaveLength(0);
    h.clock.advance(CINEMATIC_QUIET_MAX_MS);
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.saidIds()).toEqual(['decorum.freeze']);
  });

  it('does not count a cinematic as idling', () => {
    const h = harness();
    h.open();
    drop(h);
    h.clock.advance(CONCIERGE_IDLE_MS - 1000);
    h.concierge.setQuiet('hold', true);
    h.clock.advance(5000);
    h.concierge.setQuiet('hold', false);
    h.clock.advance(CONCIERGE_IDLE_MS - 1);
    expect(h.said).toHaveLength(0);
    h.clock.advance(1);
    expect(h.saidIds()).toEqual(['tip.idle']);
  });
});

describe('mute', () => {
  it('hushes the current line, says nothing more and keeps no timer', () => {
    const h = harness();
    h.open();
    drop(h);
    cascadeEnd(h, 'opulent');
    const muted: boolean[] = [];
    h.concierge.events.on('concierge:muted', ({ muted: value }) => muted.push(value));
    h.concierge.setMuted(true);
    expect(h.concierge.muted).toBe(true);
    expect(muted).toEqual([true]);
    expect(h.hushed).toEqual([{ lineId: 'cascade.opulent', reason: 'muted' }]);
    expect(h.clock.pending).toBe(0);
    h.game.emit('concierge:freeze', { seconds: 10 });
    drop(h, 2);
    h.clock.advance(CONCIERGE_IDLE_MS * 2);
    expect(h.said).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
  });

  it('speaks again once unmuted, without an idle line for the muted stretch', () => {
    const h = harness();
    h.open();
    drop(h);
    h.concierge.setMuted(true);
    h.clock.advance(CONCIERGE_IDLE_MS * 2);
    h.concierge.setMuted(false);
    h.clock.advance(CONCIERGE_GAP_MS);
    expect(h.said).toHaveLength(0);
    h.game.emit('concierge:freeze', { seconds: 10 });
    expect(h.saidIds()).toEqual(['decorum.freeze']);
  });

  it('persists the choice and restores it on the next session', () => {
    const store = new MemoryStore();
    const first = harness({ store });
    first.concierge.setMuted(true);
    expect(JSON.parse(store.getItem(CONCIERGE_STORAGE_KEY) ?? 'null')).toEqual({ muted: true });
    first.concierge.dispose();

    const second = harness({ store });
    expect(second.concierge.muted).toBe(true);
    second.open();
    second.game.emit('concierge:freeze', { seconds: 10 });
    expect(second.said).toHaveLength(0);
  });

  it('falls back to speaking on a corrupt saved mute, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryStore();
    store.setItem(CONCIERGE_STORAGE_KEY, '{"muted":"yes"}');
    expect(harness({ store }).concierge.muted).toBe(false);
    store.setItem(CONCIERGE_STORAGE_KEY, 'not json');
    expect(harness({ store }).concierge.muted).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps working when storage refuses reads and writes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const concierge = createConcierge({
      bus: createBus<GameEvents>(),
      state: {},
      clock: new FakeClock(),
      store: broken,
    });
    expect(concierge.muted).toBe(false);
    concierge.setMuted(true);
    expect(concierge.muted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    concierge.dispose();
  });

  it('does not re-announce a mute that did not change', () => {
    const h = harness();
    const muted: boolean[] = [];
    h.concierge.events.on('concierge:muted', ({ muted: value }) => muted.push(value));
    h.concierge.setMuted(false);
    expect(muted).toEqual([]);
  });
});

describe('dispose', () => {
  it('hushes, unsubscribes from every feed and clears its timers', () => {
    const h = harness();
    h.open();
    drop(h);
    cascadeEnd(h, 'opulent');
    expect(h.clock.pending).toBe(1);
    h.concierge.dispose();
    expect(h.hushed).toEqual([{ lineId: 'cascade.opulent', reason: 'disposed' }]);
    expect(h.clock.pending).toBe(0);
    expect(h.concierge.current).toBeNull();
    h.game.emit('concierge:freeze', { seconds: 10 });
    h.crates.emit('crate:collected', {
      crateId: 'k1' as CrateId,
      roll: roll('heirloom'),
      wallet: WALLET,
    });
    h.clock.advance(CONCIERGE_IDLE_MS * 2);
    expect(h.said).toHaveLength(1);
  });

  it('ignores every call after dispose', () => {
    const h = harness();
    h.concierge.dispose();
    h.concierge.setMuted(true);
    h.concierge.setQuiet('sheet', true);
    h.concierge.dismiss();
    h.concierge.dispose();
    expect(h.concierge.muted).toBe(false);
    expect(h.clock.pending).toBe(0);
  });
});
