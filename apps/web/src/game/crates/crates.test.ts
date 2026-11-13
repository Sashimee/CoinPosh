import { readFileSync } from 'node:fs';
import {
  album,
  crateSpawn,
  createRng,
  initialPityState,
  pity as pityConfig,
  rarityRank,
  rollDrop,
  type DropTableDef,
  type PityState,
} from '@coinposh/economy';
import {
  CURRENCIES,
  MAX_SNAPSHOT_CRATES,
  RARITIES,
  RollSchema,
  WalletSchema,
  type AlbumResponse,
  type CoinId,
  type CrateId,
  type CratePlacement,
  type CratePoseTuple,
  type NudgeDirection,
  type PityCounters,
  type PlayerId,
  type Rarity,
  type Reward,
  type Roll,
} from '@coinposh/shared';
import { checkCratePose, CRATE_RIDE, type CratePose, POSITION_UNIT } from '@coinposh/sim/snapshot';
import { Group, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import type { DuckOptions } from '../../audio/index.ts';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import type { ApiClient } from '../../net/client.ts';
import type { Connectivity, Scheduler } from '../../net/connectivity.ts';
import { MOCK_RULES } from '../../net/mock/rules.ts';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import type { MockServer } from '../../net/mock/server.ts';
import { Outbox } from '../../net/outbox.ts';
import { TableSync, type TableEvent } from '../../net/tableSync.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../../net/test/harness.ts';
import { bindCrateAudio, stingerDuck } from './audio.ts';
import { CrateController } from './controller.ts';
import type { CrateEvents } from './events.ts';
import {
  ARRIVAL_HINT_MS,
  bindArrivalHint,
  HINT_HEIGHT,
  hintFontScale,
  placeArrivalHint,
  PLAQUE_SWELL,
  type ArrivalHintLayout,
  type ArrivalHintPlacement,
  type HintClock,
  type HintRect,
} from './hint.ts';
import { CRATES_STRINGS, cratesKey, registerCratesStrings } from './i18n.ts';
import {
  albumPlace,
  albumProgress,
  heroOf,
  pityOutlook,
  rewardLines,
  rollHasAlbumCard,
  type PityOutlook,
  type RewardLine,
} from './loot.ts';
import {
  CARD_CHROME_GAP,
  CARD_FLY_SCALE,
  crateFlyOffset,
  pityLineCopy,
  placeCrateCard,
  placeSkipHint,
  rewardLineCopy,
  SKIP_HINT_GAP,
  type CratesT,
  type CrateCardLayout,
  type CrateCardPlacement,
} from './revealCard.ts';
import { CRATE_RIDE_SECONDS, CrateRide } from './ride.ts';
import { UnboxDirector, type OpenedCrate, type UnboxCard } from './view.ts';

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };
const offlineNever: Connectivity = { onOnline: () => () => undefined };

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

const crate = (id: string) => ({ id: id as CrateId, kind: 'vault' as const });

/** The pusher's extension over a 4 s stroke, as the bridge reports it. */
function strokeAt(seconds: number): number {
  return 0.5 - 0.5 * Math.cos((seconds / 4) * Math.PI * 2);
}

function rideToEdge(ride: CrateRide, step = 1 / 60, stroke = strokeAt): number {
  let t = 0;
  while (ride.phase !== 'fell' && t < CRATE_RIDE_SECONDS.max + 1) {
    t += step;
    ride.update(step, stroke(t));
  }
  return t;
}

describe('CrateRide', () => {
  it('rides the pusher to the lip and over it inside the economy envelope', () => {
    const ride = new CrateRide(crate('crate_AAAAAAAAAAAAAAAA'), 0);
    const phases = new Set<string>();
    let t = 0;
    while (ride.phase !== 'fell') {
      t += 1 / 60;
      phases.add(ride.update(1 / 60, strokeAt(t)));
    }
    expect([...phases]).toEqual(['riding', 'teeter', 'fell']);
    expect(t).toBeGreaterThanOrEqual(CRATE_RIDE_SECONDS.min);
    expect(t).toBeLessThan(20);
  });

  it('never tips before the minimum, however hard the table is shoved', () => {
    const ride = new CrateRide(crate('crate_BBBBBBBBBBBBBBBB'), 0);
    for (let i = 0; i < 50; i++) ride.nudge('forward', 1);
    expect(ride.phase).toBe('teeter');
    ride.update(CRATE_RIDE_SECONDS.min - 0.1, 0);
    expect(ride.phase).toBe('teeter');
    ride.update(0.2, 0);
    ride.nudge('forward', 1);
    ride.nudge('forward', 1);
    expect(ride.phase).toBe('fell');
  });

  it('is pushed off by the maximum even with the pusher frozen', () => {
    const ride = new CrateRide(crate('crate_CCCCCCCCCCCCCCCC'), 0);
    const t = rideToEdge(ride, 1 / 30, () => 0);
    expect(ride.phase).toBe('fell');
    expect(t).toBeLessThanOrEqual(CRATE_RIDE_SECONDS.max + 1 / 30);
  });

  it('steps down to the lower tier, pitches over the lip, and ignores input once gone', () => {
    const ride = new CrateRide(crate('crate_DDDDDDDDDDDDDDDD'), 0);
    expect(ride.position.y).toBeGreaterThan(0);
    expect(ride.tilt).toBe(0);
    rideToEdge(ride);
    expect(ride.position.y).toBe(0);
    expect(ride.tilt).toBeGreaterThan(1);
    const at = ride.position;
    ride.nudge('left', 1);
    expect(ride.update(1, 1)).toBe('fell');
    expect(ride.position).toEqual(at);
  });

  it('treats a bad frame delta or stroke as no motion', () => {
    const ride = new CrateRide(crate('crate_EEEEEEEEEEEEEEEE'), 0);
    const z = ride.position.z;
    ride.update(Number.NaN, Number.NaN);
    ride.update(-1, Number.POSITIVE_INFINITY);
    expect(ride.position.z).toBe(z);
    expect(ride.seconds).toBe(0);
  });

  it('keeps side nudges on the table', () => {
    const ride = new CrateRide(crate('crate_FFFFFFFFFFFFFFFF'), 0);
    for (let i = 0; i < 100; i++) ride.nudge('right', 1);
    expect(ride.position.x).toBe(CRATE_RIDE.sideLimit);
    for (let i = 0; i < 200; i++) ride.nudge('left', 1);
    expect(ride.position.x).toBe(-CRATE_RIDE.sideLimit);
  });

  it('takes its bounds from the CRATE_RIDE the server judges by', () => {
    const ride = new CrateRide(crate('crate_GGGGGGGGGGGGGGGG'), 0);
    expect(ride.position.z).toBe(CRATE_RIDE.spawnZ);
    expect(Math.abs(ride.position.x)).toBeLessThanOrEqual(CRATE_RIDE.spreadX);
    rideToEdge(ride);
    expect(ride.position.z).toBeGreaterThanOrEqual(CRATE_RIDE.tipZ);
    expect(ride.tilt).toBe(CRATE_RIDE.maxTilt);
  });
});

describe('CrateRide snapshot and restore', () => {
  const STEP = 1 / 60;
  const MAX_RIDE_S = CRATE_RIDE_SECONDS.max;

  /** A player's taps along the ride, by step: the same on every run so paths can be compared. */
  function nudgeAt(step: number): NudgeDirection | undefined {
    if (step % 211 === 0) return 'forward';
    if (step % 97 === 0) return 'left';
    if (step % 131 === 0) return 'right';
    return undefined;
  }

  interface RideLog {
    teeter: number | undefined;
    fell: number | undefined;
    /** Every pose uploaded, by the step it went up after. */
    poses: Map<number, CratePose>;
  }

  interface RunOptions {
    from?: number;
    until?: number;
    stroke?: (seconds: number) => number;
    /** Whether the table snapshot goes up after this step. */
    uploads?: (step: number) => boolean;
  }

  const UPLOAD_EVERY = 37;
  const everyUpload = (step: number): boolean => step % UPLOAD_EVERY === 0;

  /** Steps the ride until it falls, logging the step each phase began on and every pose uploaded. */
  function run(ride: CrateRide, options: RunOptions = {}): RideLog {
    const { from = 0, until = Infinity, stroke = strokeAt, uploads = everyUpload } = options;
    const log: RideLog = { teeter: undefined, fell: undefined, poses: new Map() };
    let phase = ride.phase;
    for (let step = from + 1; step <= until && phase !== 'fell'; step++) {
      if (step * STEP > MAX_RIDE_S + 1) throw new Error(`ride ${ride.crate.id} never fell`);
      const before = phase;
      ride.update(STEP, stroke(step * STEP));
      const direction = nudgeAt(step);
      if (direction) ride.nudge(direction, 0.8);
      phase = ride.phase;
      if (before !== 'teeter' && phase === 'teeter') log.teeter = step;
      if (phase === 'fell') log.fell = step;
      else if (uploads(step)) log.poses.set(step, ride.snapshot());
    }
    return log;
  }

  /**
   * Rides `id` to the upload after step `cut`, then reloads: restores the crate from that
   * pose as it comes back over the wire, with the pusher where the sim restored it, and
   * finishes the ride.
   */
  function reloadedAt(id: string, cut: number, options: RunOptions = {}): RideLog {
    const { stroke = strokeAt } = options;
    const before = run(new CrateRide(crate(id), stroke(0)), { ...options, until: cut });
    const posed = before.poses.get(cut);
    if (!posed) throw new Error(`no upload after step ${cut} to reload from`);
    const wire = JSON.parse(JSON.stringify(posed)) as CratePose;
    const resumed = CrateRide.restore(crate(id), wire, stroke(cut * STEP));
    expect(resumed.phase).toBe(posed.phase);
    const after = run(resumed, { ...options, from: cut });
    return {
      teeter: before.teeter ?? after.teeter,
      fell: after.fell,
      poses: new Map([...before.poses, ...after.poses]),
    };
  }

  function pathOf(log: RideLog) {
    return { teeter: log.teeter, fell: log.fell, poses: [...log.poses] };
  }

  const IDS = ['crate_AAAAAAAAAAAAAAAA', 'crate_Kq3vX9pLm2Rt8YwZ', 'crate_0000000000000009'];

  it('reaches teeter and falls on the same steps after a mid-ride reload', () => {
    for (const id of IDS) {
      const whole = run(new CrateRide(crate(id), strokeAt(0)));
      const { teeter, fell } = whole;
      if (teeter === undefined || fell === undefined) throw new Error(`${id} never tipped`);
      expect(teeter).toBeLessThan(fell);
      expect(fell * STEP).toBeGreaterThanOrEqual(CRATE_RIDE_SECONDS.min);
      const cuts = [...whole.poses.keys()];
      expect(cuts.some((cut) => cut < teeter)).toBe(true);
      expect(cuts.some((cut) => cut >= teeter)).toBe(true);
      for (const cut of cuts) {
        expect({ id, cut, ...pathOf(reloadedAt(id, cut)) }).toEqual({ id, cut, ...pathOf(whole) });
      }
    }
  });

  it('resumes on the same frame from an upload right at the lip', () => {
    const always = (): boolean => true;
    for (const id of IDS) {
      const whole = run(new CrateRide(crate(id), strokeAt(0)), { uploads: always });
      const teeter = whole.teeter ?? 0;
      const fell = whole.fell ?? 0;
      for (const cut of [1, teeter - 1, teeter, teeter + 1, fell - 1]) {
        const reloaded = reloadedAt(id, cut, { uploads: always });
        expect({ id, cut, ...pathOf(reloaded) }).toEqual({ id, cut, ...pathOf(whole) });
      }
    }
  });

  it('moves the crate no more than the pose grid when it uploads', () => {
    for (const id of IDS) {
      const quiet = run(new CrateRide(crate(id), strokeAt(0)), { uploads: () => false });
      const uploaded = run(new CrateRide(crate(id), strokeAt(0)));
      expect(Math.abs((uploaded.fell ?? 0) - (quiet.fell ?? 0))).toBeLessThanOrEqual(1);
      const ride = new CrateRide(crate(id), 0);
      for (let step = 1; step <= 300; step++) {
        ride.update(STEP, strokeAt(step * STEP));
        const at = ride.position;
        const seconds = ride.seconds;
        ride.snapshot();
        expect(Math.abs(ride.position.x - at.x)).toBeLessThanOrEqual(POSITION_UNIT);
        expect(Math.abs(ride.position.z - at.z)).toBeLessThanOrEqual(POSITION_UNIT * 1.5);
        expect(Math.abs(ride.seconds - seconds)).toBeLessThanOrEqual(0.0005);
      }
    }
  });

  it('only ever uploads poses the server accepts', () => {
    for (const id of IDS) {
      const always = (): boolean => true;
      const whole = run(new CrateRide(crate(id), strokeAt(0)), { uploads: always });
      const reloaded = reloadedAt(id, Math.floor((whole.teeter ?? 0) * 0.7), { uploads: always });
      const poses = [...whole.poses.values(), ...reloaded.poses.values()];
      expect(poses.length).toBeGreaterThan(100);
      expect(poses.some((p) => p.phase === 'riding')).toBe(true);
      expect(poses.some((p) => p.phase === 'teeter')).toBe(true);
      for (const pose of poses) {
        expect({ pose, verdict: checkCratePose(pose, MAX_RIDE_S) }).toEqual({
          pose,
          verdict: { ok: true },
        });
      }
    }
  });

  it('keeps poses valid with the pusher frozen until the pile shoves the crate off', () => {
    const frozen = (): number => 0.4;
    const id = 'crate_CCCCCCCCCCCCCCCC';
    const whole = run(new CrateRide(crate(id), 0.4), { stroke: frozen, uploads: () => true });
    const fell = whole.fell ?? 0;
    expect(fell * STEP).toBeLessThanOrEqual(MAX_RIDE_S + STEP);
    const last = whole.poses.get(fell - 1);
    expect(last?.elapsedMs).toBeLessThanOrEqual(MAX_RIDE_S * 1000);
    for (const pose of whole.poses.values()) {
      expect(checkCratePose(pose, MAX_RIDE_S)).toEqual({ ok: true });
    }
    const reloaded = reloadedAt(id, fell - 1, { stroke: frozen, uploads: () => true });
    expect(reloaded.fell).toBe(fell);
  });

  it('does not jump the crate on the first stroke after a reload', () => {
    const ride = new CrateRide(crate('crate_HHHHHHHHHHHHHHHH'), 0);
    for (let step = 1; step <= 90; step++) ride.update(STEP, strokeAt(step * STEP));
    const pose = ride.snapshot();
    const resumed = CrateRide.restore(ride.crate, pose, 0.95);
    const z = resumed.position.z;
    resumed.update(0, 0.95);
    expect(resumed.position.z).toBe(z);
    resumed.update(STEP, 0.97);
    expect(resumed.position.z - z).toBeCloseTo(
      0.02 * RIVIERA_TABLE.pusherStroke * CRATE_RIDE.carry + CRATE_RIDE.creepPerSecond * STEP,
      9,
    );
  });

  it('restores to the pose it was given, on the lower tier and pitched over the lip', () => {
    const teeter: CratePose = {
      x: -1234,
      z: Math.round(CRATE_RIDE.teeterZ / POSITION_UNIT),
      elapsedMs: 9000,
      phase: 'teeter',
    };
    const ride = CrateRide.restore(crate('crate_JJJJJJJJJJJJJJJJ'), teeter, 0.5);
    expect(ride.phase).toBe('teeter');
    expect(ride.seconds).toBe(9);
    expect(ride.position.x).toBeCloseTo(-0.01234, 9);
    expect(ride.position.y).toBe(0);
    expect(ride.position.z).toBeGreaterThanOrEqual(CRATE_RIDE.teeterZ);
    expect(ride.snapshot()).toEqual(teeter);
    const riding: CratePose = {
      x: 0,
      z: Math.round(CRATE_RIDE.spawnZ / POSITION_UNIT),
      elapsedMs: 0,
      phase: 'riding',
    };
    const fresh = CrateRide.restore(crate('crate_JJJJJJJJJJJJJJJJ'), riding, 0);
    expect(fresh.position.y).toBe(RIVIERA_TABLE.pusherHeight);
    expect(fresh.tilt).toBe(0);
    expect(fresh.snapshot()).toEqual(riding);
  });

  it('refuses a pose the server would refuse', () => {
    const tipZ = Math.round(CRATE_RIDE.tipZ / POSITION_UNIT);
    const bad: [CratePose, string][] = [
      [{ x: 0, z: tipZ, elapsedMs: 9000, phase: 'teeter' }, 'out_of_bounds'],
      [{ x: 0, z: tipZ - 1, elapsedMs: 9000, phase: 'riding' }, 'bad_phase'],
      [{ x: 0.5, z: tipZ - 1, elapsedMs: 9000, phase: 'teeter' }, 'non_finite'],
      [{ x: 0, z: tipZ - 1, elapsedMs: MAX_RIDE_S * 1000 + 1, phase: 'teeter' }, 'bad_elapsed'],
    ];
    for (const [pose, reason] of bad) {
      expect(() => CrateRide.restore(crate('crate_KKKKKKKKKKKKKKKK'), pose, 0)).toThrow(reason);
    }
  });

  it('never poses a crate that has fallen', () => {
    const ride = new CrateRide(crate('crate_LLLLLLLLLLLLLLLL'), 0);
    rideToEdge(ride);
    expect(ride.phase).toBe('fell');
    expect(() => ride.snapshot()).toThrow(/has fallen/);
  });
});

describe('pityOutlook', () => {
  const [rare, exquisite] = pityConfig.rules;

  it('reads the full window on fresh counters', () => {
    expect(pityOutlook({ rare: 0, exquisite: 0, legendary: 0 })).toEqual({
      rarity: 'rare',
      within: rare.within,
    });
  });

  it('names the guarantee that lands soonest, down to the next crate', () => {
    expect(pityOutlook({ rare: 0, exquisite: exquisite.within - 2, legendary: 0 })).toEqual({
      rarity: 'exquisite',
      within: 2,
    });
    expect(pityOutlook({ rare: rare.within - 1, exquisite: 0, legendary: 0 })).toEqual({
      rarity: 'rare',
      within: 1,
    });
  });

  it('refuses counters past their guarantee, since the server should have forced the floor', () => {
    expect(() => pityOutlook({ rare: rare.within, exquisite: 0, legendary: 0 })).toThrow(
      /past its/,
    );
  });

  /** Fine-heavy odds, so every natural open misses Rare and pity alone lifts the floor. */
  const stingy: DropTableDef = {
    source: 'vaultCrate',
    pity: true,
    odds: { common: 4_998, fine: 4_998, rare: 1, exquisite: 1, legendary: 1, heirloom: 1 },
  };
  const counters = (state: PityState): PityCounters => ({
    rare: state.rare ?? 0,
    exquisite: state.exquisite ?? 0,
    legendary: state.legendary ?? 0,
  });

  it.each([0, 1, 9])(
    'after %i non-Rare opens counts down to the open the server forces',
    (misses) => {
      expect(rare.within).toBe(10);
      const rng = createRng(337);
      let state = initialPityState(pityConfig);
      let last: Rarity = 'fine';
      for (let open = 0; open < misses; open++) {
        const roll = rollDrop(stingy, pityConfig, state, rng);
        expect(rarityRank(roll.rarity)).toBeLessThan(rarityRank('rare'));
        state = roll.state;
        last = roll.rarity;
      }
      const outlook = pityOutlook(counters(state), misses === 0 ? null : last);
      expect(outlook).toEqual({ rarity: 'rare', within: rare.within - misses });
      if (outlook === null) throw new Error('Expected a pending Rare guarantee');
      for (let open = 1; open <= outlook.within; open++) {
        const roll = rollDrop(stingy, pityConfig, state, rng);
        const forced = open === outlook.within;
        expect(roll.pityFloor).toBe(forced ? 'rare' : null);
        if (forced) expect(rarityRank(roll.rarity)).toBeGreaterThanOrEqual(rarityRank('rare'));
        else expect(rarityRank(roll.rarity)).toBeLessThan(rarityRank('rare'));
        state = roll.state;
      }
    },
  );

  it('leaves out the floors the opened crate met, and hides once it met them all', () => {
    const fresh = { rare: 0, exquisite: 6, legendary: 6 };
    expect(pityOutlook(fresh, 'fine')).toEqual({ rarity: 'rare', within: rare.within });
    expect(pityOutlook(fresh, 'rare')).toEqual({
      rarity: 'exquisite',
      within: exquisite.within - 6,
    });
    expect(pityOutlook({ rare: 0, exquisite: 0, legendary: 6 }, 'exquisite')).toEqual({
      rarity: 'legendary',
      within: (pityConfig.rules.at(-1)?.within ?? 0) - 6,
    });
    expect(pityOutlook({ rare: 0, exquisite: 0, legendary: 0 }, 'legendary')).toBeNull();
    expect(pityOutlook({ rare: 0, exquisite: 0, legendary: 0 }, 'heirloom')).toBeNull();
  });
});

describe('pity line', () => {
  const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
  registerCratesStrings(i18n);
  const t: CratesT = (key, values) => i18n.t(cratesKey(key), values);
  const lineIn = (language: (typeof LANGUAGES)[number], outlook: PityOutlook) => {
    i18n.changeLanguage(language);
    return pityLineCopy(outlook, t);
  };

  it('promises a crate, not an item, so a Fine crate with a Rare charm still reads true', () => {
    const outlook = pityOutlook({ rare: 1, exquisite: 1, legendary: 1 }, 'fine');
    if (outlook === null) throw new Error('Expected a pending Rare guarantee');
    expect(lineIn('en', outlook)).toBe('A Rare crate or better within 9 opens');
    expect(lineIn('fr', outlook)).toBe('Une caisse Rare ou mieux garantie d’ici 9 ouvertures');
    expect(lineIn('de', outlook)).toBe(
      'Eine seltene Kiste oder besser garantiert in höchstens 9 Öffnungen',
    );
  });

  it('agrees the article and adjective with each guaranteed rarity', () => {
    expect(lineIn('en', { rarity: 'exquisite', within: 34 })).toBe(
      'An Exquisite crate or better within 34 opens',
    );
    expect(lineIn('fr', { rarity: 'legendary', within: 80 })).toBe(
      'Une caisse Légendaire ou mieux garantie d’ici 80 ouvertures',
    );
    expect(lineIn('de', { rarity: 'exquisite', within: 34 })).toBe(
      'Eine exquisite Kiste oder besser garantiert in höchstens 34 Öffnungen',
    );
  });

  it('says next open when the guarantee is one open away', () => {
    const next = { rarity: 'rare', within: 1 } as const;
    expect(lineIn('en', next)).toBe('A Rare crate or better on your next open');
    expect(lineIn('fr', next)).toBe(
      'Une caisse Rare ou mieux garantie à votre prochaine ouverture',
    );
    expect(lineIn('de', next)).toBe(
      'Eine seltene Kiste oder besser garantiert bei Ihrer nächsten Öffnung',
    );
  });
});

describe('reward lines', () => {
  const rewards: Reward[] = [
    { kind: 'currency', currency: 'coins', amount: 30 },
    { kind: 'currency', currency: 'pearls', amount: 2 },
    {
      kind: 'charm',
      charmId: 'charm_AAAAAAAAAAAAAAAA' as never,
      charmType: 'captainsBellCharm' as never,
      level: 2,
      duplicate: true,
    },
    { kind: 'currency', currency: 'coins', amount: 12 },
    { kind: 'collectible', collectibleId: 'navyLacquerCoin' as never },
  ];

  it('puts items first, rarest first, and merges currencies in wallet order', () => {
    expect(rewardLines(rewards)).toEqual([
      { kind: 'collectible', item: 'navyLacquerCoin', rarity: 'rare', set: 'captainsTable' },
      {
        kind: 'charm',
        level: 2,
        duplicate: true,
        item: 'captainsBellCharm',
        rarity: 'fine',
        set: 'deckEssentials',
      },
      { kind: 'currency', currency: 'coins', amount: 42 },
      { kind: 'currency', currency: 'pearls', amount: 2 },
    ]);
  });

  it('stars the Legendary Sovereign over a Fine charm the server listed first', () => {
    const vault: Reward[] = [
      { kind: 'currency', currency: 'coins', amount: 120 },
      {
        kind: 'charm',
        charmId: 'charm_BBBBBBBBBBBBBBBB' as never,
        charmType: 'captainsBellCharm' as never,
        level: 1,
        duplicate: false,
      },
      { kind: 'collectible', collectibleId: 'admiralsSovereign' as never },
      { kind: 'currency', currency: 'pearls', amount: 8 },
    ];
    expect(heroOf(vault)).toBe('card');
    const lines = rewardLines(vault);
    expect(lines.map((line) => line.kind)).toEqual([
      'collectible',
      'charm',
      'currency',
      'currency',
    ]);
    expect(lines[0]).toEqual({
      kind: 'collectible',
      item: 'admiralsSovereign',
      rarity: 'legendary',
      set: 'sunsetGala',
    });
    expect(vault[1]?.kind).toBe('charm');
  });

  it('sorts every item line by economy rarity, never below a currency', () => {
    const lines = rewardLines([
      { kind: 'currency', currency: 'keys', amount: 1 },
      { kind: 'scratchCard', cardId: 'scratch_a1b2c3d4' as never },
      { kind: 'collectible', collectibleId: 'compassRoseCoin' as never },
      { kind: 'collectible', collectibleId: 'duchessSovereign1891' as never },
      { kind: 'collectible', collectibleId: 'monacoGrandPrixCoin' as never },
    ]);
    const ranks = lines.flatMap((line) => ('rarity' in line ? [rarityRank(line.rarity)] : []));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(lines.map((line) => ('item' in line ? line.item : line.kind))).toEqual([
      'duchessSovereign1891',
      'monacoGrandPrixCoin',
      'compassRoseCoin',
      'scratchCard',
      'currency',
    ]);
  });

  it('breaks a rarity tie by kind as before: a charm over a card, a safe over a common card', () => {
    const fineCoin: Reward = { kind: 'collectible', collectibleId: 'compassRoseCoin' as never };
    const fineCharm: Reward = {
      kind: 'charm',
      charmId: 'charm_CCCCCCCCCCCCCCCC' as never,
      charmType: 'captainsBellCharm' as never,
      level: 1,
      duplicate: false,
    };
    expect(heroOf([fineCoin, fineCharm])).toBe('charm');
    expect(rewardLines([fineCoin, fineCharm]).map((line) => line.kind)).toEqual([
      'charm',
      'collectible',
    ]);
    const safe: Reward = {
      kind: 'safe',
      safe: { id: 'safe_DDDDDDDDDDDDDDDD' as never, type: 'gold' as never, unlocksAt: 0 },
    };
    const card: Reward = { kind: 'scratchCard', cardId: 'scratch_a1b2c3d4' as never };
    const commonCoin: Reward = { kind: 'collectible', collectibleId: 'anchorCoin' as never };
    expect(heroOf([card, safe])).toBe('safe');
    expect(heroOf([commonCoin, safe])).toBe('safe');
    expect(heroOf([safe, fineCoin])).toBe('card');
  });

  it('keeps the wallet order and the currency hero for an all-currency roll', () => {
    const purse: Reward[] = [
      { kind: 'currency', currency: 'tickets', amount: 2 },
      { kind: 'currency', currency: 'coins', amount: 40 },
      { kind: 'currency', currency: 'pearls', amount: 3 },
      { kind: 'currency', currency: 'coins', amount: 10 },
    ];
    expect(rewardLines(purse)).toEqual([
      { kind: 'currency', currency: 'coins', amount: 50 },
      { kind: 'currency', currency: 'pearls', amount: 3 },
      { kind: 'currency', currency: 'tickets', amount: 2 },
    ]);
    expect(heroOf(purse)).toBe('pearls');
  });

  it('picks a currency hero only when the roll holds no item', () => {
    expect(heroOf(rewards)).toBe('card');
    expect(heroOf([{ kind: 'currency', currency: 'coins', amount: 1 }])).toBe('coins');
    expect(
      heroOf([
        { kind: 'currency', currency: 'coins', amount: 1 },
        { kind: 'currency', currency: 'keys', amount: 1 },
      ]),
    ).toBe('keys');
    expect(heroOf([])).toBe('coins');
    expect(rewardLines([])).toEqual([]);
  });
});

describe('crate strings', () => {
  function keys(tree: ResourceTree, prefix = ''): string[] {
    return Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
    );
  }

  it('cover the same keys in EN, FR and DE, with every rarity named', () => {
    const english = keys(CRATES_STRINGS.en);
    for (const language of LANGUAGES) {
      const strings = CRATES_STRINGS[language];
      expect(keys(strings).sort()).toEqual([...english].sort());
      for (const rarity of RARITIES) expect(strings.rarity[rarity].length).toBeGreaterThan(0);
      for (const set of album) {
        expect(strings.set[set.id].length).toBeGreaterThan(0);
        for (const item of set.items) expect(strings.item[item.id].length).toBeGreaterThan(0);
      }
    }
  });

  it('resolve through i18next with interpolation', () => {
    const i18n = createI18n({ language: 'fr', resources: { en: {}, fr: {}, de: {} } });
    registerCratesStrings(i18n);
    expect(i18n.t(cratesKey('pity'), { crate: 'Une caisse Rare', count: 4 })).toBe(
      'Une caisse Rare ou mieux garantie d’ici 4 ouvertures',
    );
    i18n.changeLanguage('de');
    expect(i18n.t(cratesKey('rarity.legendary'))).toBe('Legendär');
  });
});

describe('album entries on reward lines', () => {
  it('takes rarity and set from the economy album for every entry', () => {
    for (const set of album) {
      for (const item of set.items) {
        expect(albumPlace(item.id)).toEqual({ item: item.id, rarity: item.rarity, set: set.id });
      }
    }
  });

  it('refuses an entry the economy album does not list instead of showing a nameless line', () => {
    expect(() => albumPlace('butler')).toThrow(/does not list/);
    expect(() =>
      rewardLines([{ kind: 'collectible', collectibleId: 'ghostCoin' as never }]),
    ).toThrow(/"ghostCoin"/);
  });

  const deck = album.find((set) => set.id === 'deckEssentials');
  if (!deck) throw new Error('Expected the deckEssentials album set');
  const response = (owned: number): AlbumResponse => ({
    sets: album.map((set) => ({
      id: set.id as never,
      entries: set.items.map((item, index) => ({
        id: item.id as never,
        kind: 'coinSkin' as const,
        owned: set.id === deck.id && index < owned,
        count: set.id === deck.id && index < owned ? 1 : 0,
      })),
      completed: set.id === deck.id && owned === set.items.length,
    })),
  });
  const card: Reward = { kind: 'collectible', collectibleId: 'teakDeckCoin' as never };

  it('reads set progress from the server album, not from the roll', () => {
    expect(albumProgress(response(3), [card])).toEqual({
      teakDeckCoin: { owned: 3, total: deck.items.length },
    });
    expect(albumProgress(response(deck.items.length), [card]).teakDeckCoin).toEqual({
      owned: deck.items.length,
      total: deck.items.length,
    });
    expect(
      albumProgress(response(3), [{ kind: 'currency', currency: 'coins', amount: 4 }]),
    ).toEqual({});
  });

  it('refuses an album that has no set for a card the server just granted', () => {
    expect(() => albumProgress({ sets: [] }, [card])).toThrow(/no set holding it/);
  });

  it('asks for the album only when the roll holds an album card', () => {
    expect(rollHasAlbumCard([card])).toBe(true);
    expect(
      rollHasAlbumCard([
        { kind: 'currency', currency: 'pearls', amount: 1 },
        {
          kind: 'charm',
          charmId: 'charm_AAAAAAAAAAAAAAAA' as never,
          charmType: 'captainsBellCharm' as never,
          level: 1,
          duplicate: false,
        },
      ]),
    ).toBe(false);
  });
});

describe('reward line copy', () => {
  const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
  registerCratesStrings(i18n);
  const t: CratesT = (key, values) => i18n.t(cratesKey(key), values);
  const copyIn = (
    language: (typeof LANGUAGES)[number],
    line: RewardLine,
    progress = null as null | { owned: number; total: number },
  ) => {
    i18n.changeLanguage(language);
    return rewardLineCopy(line, t, language, progress);
  };
  const gain = (language: (typeof LANGUAGES)[number], currency: Reward & { kind: 'currency' }) =>
    copyIn(language, { kind: 'currency', currency: currency.currency, amount: currency.amount })
      .name;
  const pearls = (amount: number): Reward & { kind: 'currency' } => ({
    kind: 'currency',
    currency: 'pearls',
    amount,
  });

  it('heads the Legendary vault card with the Sovereign in EN, FR and DE, not the Fine charm', () => {
    const [first, second] = rewardLines([
      { kind: 'currency', currency: 'coins', amount: 300 },
      {
        kind: 'charm',
        charmId: 'charm_EEEEEEEEEEEEEEEE' as never,
        charmType: 'captainsBellCharm' as never,
        level: 1,
        duplicate: false,
      },
      { kind: 'collectible', collectibleId: 'admiralsSovereign' as never },
    ]);
    if (first === undefined || second === undefined) throw new Error('Expected two item lines.');
    expect(copyIn('en', first).name).toBe('Admiral’s Sovereign');
    expect(copyIn('fr', first).name).toBe('Souverain de l’amiral');
    expect(copyIn('de', first).name).toBe('Sovereign des Admirals');
    expect(copyIn('en', second).name).toBe('Captain’s Bell');
  });

  it('pluralises currencies through i18next at the one/other boundary in EN, FR and DE', () => {
    expect(gain('en', pearls(1))).toBe('+1 Pearl');
    expect(gain('fr', pearls(1))).toBe('+1 Perle');
    expect(gain('de', pearls(1))).toBe('+1 Perle');
    expect(gain('en', pearls(2))).toBe('+2 Pearls');
    expect(gain('fr', pearls(2))).toBe('+2 Perles');
    expect(gain('de', pearls(2))).toBe('+2 Perlen');
    expect(gain('en', { kind: 'currency', currency: 'coins', amount: 1 })).toBe('+1 Coin');
    expect(gain('de', { kind: 'currency', currency: 'coins', amount: 1_250 })).toBe(
      '+1.250 Münzen',
    );
    expect(gain('en', { kind: 'currency', currency: 'keys', amount: 1 })).toBe('+1 Key');
    expect(gain('de', { kind: 'currency', currency: 'keys', amount: 3 })).toBe('+3 Schlüssel');
  });

  it('keeps French round millions plural, where i18next picks the many form', () => {
    const line = gain('fr', { kind: 'currency', currency: 'coins', amount: 2_000_000 });
    expect(line.startsWith('+')).toBe(true);
    expect(line.endsWith(' Pièces')).toBe(true);
  });

  it('has a singular and a plural for every currency in every language', () => {
    for (const language of LANGUAGES) {
      for (const currency of CURRENCIES) {
        const one = gain(language, { kind: 'currency', currency, amount: 1 });
        const other = gain(language, { kind: 'currency', currency, amount: 7 });
        expect(one).toMatch(/^\+1 \S/);
        expect(other).toMatch(/^\+7 \S/);
        expect(one).not.toContain('gain.');
      }
    }
  });

  const charm = (duplicate: boolean, level: number): RewardLine => ({
    kind: 'charm',
    level,
    duplicate,
    ...albumPlace('captainsBellCharm'),
  });

  it('names a new charm and wears its rarity', () => {
    expect(copyIn('en', charm(false, 1))).toEqual({
      name: 'Captain’s Bell',
      detail: 'New Charm',
      rarity: 'fine',
      chip: 'Fine',
      completes: false,
    });
    expect(copyIn('fr', charm(false, 1)).name).toBe('Cloche du capitaine');
    expect(copyIn('de', charm(true, 3))).toMatchObject({
      name: 'Kapitänsglocke',
      detail: 'Glücksbringer auf Stufe 3 verbessert',
      rarity: 'fine',
    });
  });

  const albumCard: RewardLine = { kind: 'collectible', ...albumPlace('teakDeckCoin') };

  it('gives the French item chip a rarity that does not agree with « Caisse »', () => {
    const bucket: RewardLine = {
      kind: 'charm',
      level: 1,
      duplicate: false,
      ...albumPlace('champagneBucketCharm'),
    };
    const copy = copyIn('fr', bucket);
    expect(copy).toMatchObject({ name: 'Seau à champagne', rarity: 'fine', chip: 'De choix' });
    expect(copy.chip).not.toBe('Raffinée');
    expect(copyIn('fr', albumCard).chip).toBe('Ordinaire');
    for (const rarity of RARITIES) {
      expect(CRATES_STRINGS.fr.chip[rarity]).not.toMatch(/ée$|une$|ise$/);
    }
  });

  it('names an album card and shows its set progress once the album answers', () => {
    expect(copyIn('en', albumCard)).toEqual({
      name: 'Teak Deck Coin',
      detail: 'Album Card',
      rarity: 'common',
      chip: 'Common',
      completes: false,
    });
    expect(copyIn('en', albumCard, { owned: 3, total: 8 }).detail).toBe('Deck Essentials · 3 / 8');
    expect(copyIn('fr', albumCard, { owned: 3, total: 8 }).detail).toBe(
      'L’essentiel du pont · 3 / 8',
    );
    expect(copyIn('de', albumCard, { owned: 7, total: 8 })).toMatchObject({
      name: 'Teakdeck-Münze',
      detail: 'Deck-Grundausstattung · 7 / 8',
      completes: false,
    });
  });

  it('celebrates the card that completes its set', () => {
    expect(copyIn('en', albumCard, { owned: 8, total: 8 })).toMatchObject({
      detail: 'Deck Essentials complete · 8 / 8',
      completes: true,
    });
  });

  it('keeps safes and scratch cards as plain lines', () => {
    expect(copyIn('en', { kind: 'safe' })).toEqual({
      name: 'Key-locked Safe',
      detail: null,
      rarity: null,
      chip: null,
      completes: false,
    });
    expect(copyIn('fr', { kind: 'scratchCard' }).name).toBe('Carte à gratter');
  });
});

describe('crate audio', () => {
  it('ducks the music under a reveal and voices each stinger, deeper for rarer crates', () => {
    const events = createBus<CrateEvents>();
    const ducks: DuckOptions[] = [];
    const impacts: ImpactEvent[] = [];
    const off = bindCrateAudio(events, {
      duckMusic: (duck) => ducks.push(duck ?? {}),
      playImpact: (impact) => impacts.push(impact),
    });
    events.emit('crate:stinger', { cue: 'shudder', rarity: 'rare', step: 2, duckSeconds: 0 });
    expect(ducks).toEqual([]);
    expect(impacts).toHaveLength(1);
    events.emit('crate:stinger', { cue: 'burst', rarity: 'legendary', step: 1, duckSeconds: 2 });
    expect(ducks).toEqual([stingerDuck('legendary', 2)]);
    expect(impacts.length).toBeGreaterThan(1);
    expect(stingerDuck('legendary', 2).depthDb).toBeLessThan(stingerDuck('fine', 2).depthDb ?? 0);
    off();
    events.emit('crate:stinger', { cue: 'burst', rarity: 'rare', step: 1, duckSeconds: 2 });
    expect(ducks).toHaveLength(1);
  });
});

describe('arrival hint', () => {
  function fakeClock() {
    const timers = new Map<number, () => void>();
    let next = 0;
    const clock: HintClock = {
      setTimeout: (callback, ms) => {
        expect(ms).toBe(ARRIVAL_HINT_MS);
        timers.set(++next, callback);
        return next;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    };
    const fire = () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    };
    return { clock, timers, fire };
  }

  function bound() {
    const events = createBus<CrateEvents>();
    const log: string[] = [];
    const { clock, timers, fire } = fakeClock();
    const off = bindArrivalHint(
      events,
      { show: () => log.push('show'), hide: () => log.push('hide') },
      clock,
    );
    const spawn = (id: string, resumed = false) => {
      events.emit('crate:spawned', {
        crateId: id as CrateId,
        kind: 'vault',
        position: { x: 0, y: 0, z: 0 },
        resumed,
      });
    };
    return { events, log, timers, fire, off, spawn };
  }

  it('prompts on the first crate only and clears itself after the read time', () => {
    const { log, timers, fire, spawn } = bound();
    spawn('crate_AAAAAAAAAAAAAAAA');
    expect(log).toEqual(['show']);
    spawn('crate_BBBBBBBBBBBBBBBB');
    expect(log).toEqual(['show']);
    fire();
    expect(log).toEqual(['show', 'hide']);
    expect(timers.size).toBe(0);
  });

  it('stays down for a crate resumed mid-table and still prompts on a fresh one after', () => {
    const { log, timers, spawn } = bound();
    spawn('crate_AAAAAAAAAAAAAAAA', true);
    expect(log).toEqual([]);
    expect(timers.size).toBe(0);
    spawn('crate_BBBBBBBBBBBBBBBB');
    expect(log).toEqual(['show']);
    expect(timers.size).toBe(1);
  });

  it('clears as soon as that crate goes over, and ignores other crates falling', () => {
    const { events, log, timers, spawn } = bound();
    spawn('crate_AAAAAAAAAAAAAAAA');
    const position = { x: 0, y: 0, z: 0 };
    events.emit('crate:fell', { crateId: 'crate_BBBBBBBBBBBBBBBB' as CrateId, tick: 1, position });
    expect(log).toEqual(['show']);
    events.emit('crate:fell', { crateId: 'crate_AAAAAAAAAAAAAAAA' as CrateId, tick: 2, position });
    expect(log).toEqual(['show', 'hide']);
    expect(timers.size).toBe(0);
    events.emit('crate:failed', { crateId: 'crate_AAAAAAAAAAAAAAAA' as CrateId, error: null });
    expect(log).toEqual(['show', 'hide']);
  });

  it('hides on unbind and stops listening', () => {
    const { log, timers, off, spawn } = bound();
    spawn('crate_AAAAAAAAAAAAAAAA');
    off();
    expect(log).toEqual(['show', 'hide']);
    expect(timers.size).toBe(0);
    spawn('crate_BBBBBBBBBBBBBBBB');
    expect(log).toEqual(['show', 'hide']);
  });
});

describe('arrival hint placement', () => {
  const rect = (left: number, top: number, right: number, bottom: number): HintRect => ({
    left,
    top,
    right,
    bottom,
  });
  const intersects = (a: HintRect, b: HintRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const hintBox = (at: ArrivalHintPlacement, viewportWidth: number) =>
    rect(at.inset, at.top, viewportWidth - at.inset, at.top + HINT_HEIGHT);

  /** Measured at 390x844 in Demo Mode: banner, plaque, crown rails, aim rail above the dock. */
  const phone: ArrivalHintLayout = {
    viewportWidth: 390,
    ceiling: 164,
    plaque: rect(97, 90, 293, 164),
    floor: rect(15.6, 322.5, 374.4, 525.1),
    base: 658,
    rails: [rect(7, 186, 27, 300), rect(363, 186, 383, 300)],
  };

  it('sets the hint in the apron past the payout lip, clear of the balance and the rails', () => {
    const at = placeArrivalHint(phone);
    expect(at.zone).toBe('apron');
    const box = hintBox(at, phone.viewportWidth);
    expect(box.top).toBeGreaterThan(phone.floor.bottom);
    expect(box.bottom).toBeLessThan(phone.base);
    expect(intersects(box, phone.plaque ?? rect(0, 0, 0, 0))).toBe(false);
    for (const rail of phone.rails) expect(intersects(box, rail)).toBe(false);
    expect(at.inset).toBe(16);
  });

  it('narrows symmetrically for a rail that shares the apron', () => {
    const at = placeArrivalHint({
      ...phone,
      rails: [rect(7, 540, 27, 640), rect(363, 540, 383, 640)],
    });
    expect(at.zone).toBe('apron');
    expect(at.inset).toBe(35);
    for (const rail of [rect(7, 540, 27, 640), rect(363, 540, 383, 640)]) {
      expect(intersects(hintBox(at, phone.viewportWidth), rail)).toBe(false);
    }
  });

  it('falls back under the HUD, clear of the plaque at the peak of its credit pop', () => {
    const tight = { ...phone, base: phone.floor.bottom + 40 };
    const at = placeArrivalHint(tight);
    expect(at.zone).toBe('crown');
    const plaque = rect(97, 90, 293, 164);
    const swollen = 164 + ((164 - 90) * (PLAQUE_SWELL - 1)) / 2;
    expect(at.top).toBeGreaterThan(swollen);
    expect(intersects(hintBox(at, tight.viewportWidth), plaque)).toBe(false);
    expect(at.inset).toBe(35);
  });

  it('leaves the apron when its rails leave too little width for the hint', () => {
    const at = placeArrivalHint({
      ...phone,
      rails: [rect(6, 540, 100, 640), rect(290, 540, 384, 640)],
    });
    expect(at.zone).toBe('crown');
  });

  it('keeps under a HUD that grows below the plaque, such as the empty-Vault notice', () => {
    const at = placeArrivalHint({ ...phone, base: 560, ceiling: 240 });
    expect(at).toEqual({ zone: 'crown', top: 248, inset: 35 });
  });

  it('shrinks an overlong instruction only as far as it stays legible', () => {
    expect(hintFontScale(200, 260)).toBe(1);
    expect(hintFontScale(260, 260)).toBe(1);
    expect(hintFontScale(280, 260)).toBe(0.92);
    expect(hintFontScale(600, 260)).toBe(0.8);
    expect(hintFontScale(100, 0)).toBe(1);
  });

  it('keeps the instruction short enough for one line on a 360 px phone in every language', () => {
    for (const language of LANGUAGES) {
      expect(CRATES_STRINGS[language].arrived.length).toBeLessThanOrEqual(34);
      expect(CRATES_STRINGS[language].title.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('crate reward card placement', () => {
  const rect = (left: number, top: number, right: number, bottom: number): HintRect => ({
    left,
    top,
    right,
    bottom,
  });
  const intersects = (a: HintRect, b: HintRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const cardBox = (at: CrateCardPlacement, layout: CrateCardLayout, width: number) =>
    rect((width - 340) / 2, at.top, (width + 340) / 2, at.top + layout.cardHeight * at.scale);
  const swollen = (plaque: HintRect) => {
    const half = ((plaque.bottom - plaque.top) * PLAQUE_SWELL) / 2;
    const centre = (plaque.top + plaque.bottom) / 2;
    return rect(plaque.left, centre - half, plaque.right, centre + half);
  };

  /** Measured in seeded Demo Mode: the Vault plaque, the dock and a four-line card. */
  const viewports = [
    {
      name: '390x844',
      width: 390,
      plaque: rect(97, 90.1, 293, 163.6),
      dock: rect(16, 774, 374, 830),
      layout: { viewportHeight: 844, base: 774, cardHeight: 338.9 },
    },
    {
      name: '360x640',
      width: 360,
      plaque: rect(95, 90.1, 265, 153.6),
      dock: rect(12, 574, 348, 626),
      layout: { viewportHeight: 640, base: 574, cardHeight: 338.9 },
    },
  ];

  for (const viewport of viewports) {
    it(`rests the card above the dock and below the Vault at ${viewport.name}`, () => {
      const layout = { ...viewport.layout, plaque: viewport.plaque };
      const at = placeCrateCard(layout);
      const box = cardBox(at, layout, viewport.width);
      expect(at.scale).toBe(1);
      expect(intersects(box, viewport.dock)).toBe(false);
      expect(intersects(box, swollen(viewport.plaque))).toBe(false);
      expect(viewport.dock.top - box.bottom).toBeGreaterThanOrEqual(CARD_CHROME_GAP);
      expect(viewport.dock.top - box.bottom).toBeLessThan(CARD_CHROME_GAP + 1);
    });

    it(`keeps every card size at one spot for the whole reveal at ${viewport.name}`, () => {
      for (const cardHeight of [180, 266, 338.9]) {
        const layout = { ...viewport.layout, plaque: viewport.plaque, cardHeight };
        expect(placeCrateCard(layout)).toEqual(placeCrateCard({ ...layout }));
        const box = cardBox(placeCrateCard(layout), layout, viewport.width);
        expect(intersects(box, viewport.dock)).toBe(false);
      }
    });

    it(`shrinks a card too tall for the room rather than covering the HUD at ${viewport.name}`, () => {
      const layout = { ...viewport.layout, plaque: viewport.plaque, cardHeight: 720 };
      const at = placeCrateCard(layout);
      expect(at.scale).toBeLessThan(1);
      expect(at.scale).toBeGreaterThan(0.5);
      const box = cardBox(at, layout, viewport.width);
      expect(intersects(box, viewport.dock)).toBe(false);
      expect(intersects(box, swollen(viewport.plaque))).toBe(false);
    });
  }

  it('fits a landscape phone by shrinking between the plaque and the dock', () => {
    const plaque = rect(325, 12, 519, 86);
    const layout = { viewportHeight: 390, plaque, base: 322, cardHeight: 338.9 };
    const at = placeCrateCard(layout);
    const box = cardBox(at, layout, 844);
    expect(at.scale).toBeGreaterThan(0.4);
    expect(box.bottom).toBeLessThanOrEqual(322 - CARD_CHROME_GAP);
    expect(intersects(box, swollen(plaque))).toBe(false);
  });

  it('uses the viewport floor when the plaque is missing or the dock is not laid out', () => {
    expect(
      placeCrateCard({ viewportHeight: 640, plaque: null, base: 574, cardHeight: 300 }),
    ).toEqual({ top: 262, scale: 1 });
    expect(placeCrateCard({ viewportHeight: 640, plaque: null, base: 0, cardHeight: 300 })).toEqual(
      {
        top: 328,
        scale: 1,
      },
    );
  });

  it('keeps the card out of layout until the reveal, so it cannot show early and then jump', () => {
    const css = readFileSync(new URL('./crates.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cp-crate-card\[hidden\]\s*\{\s*display:\s*none;/);
    expect(css).not.toMatch(/margin-top:\s*\d+vh/);
    expect(css).not.toMatch(/\.cp-crate\.is-revealed\s*\{[^}]*place-items/);
  });
});

describe('crate skip hint placement', () => {
  const rect = (left: number, top: number, right: number, bottom: number): HintRect => ({
    left,
    top,
    right,
    bottom,
  });
  const intersects = (a: HintRect, b: HintRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const swollen = (plaque: HintRect) => {
    const half = ((plaque.bottom - plaque.top) * PLAQUE_SWELL) / 2;
    const centre = (plaque.top + plaque.bottom) / 2;
    return rect(plaque.left, centre - half, plaque.right, centre + half);
  };
  const HINT = { width: 150, height: 29 };
  const hintBox = (top: number, viewportWidth: number) =>
    rect(
      (viewportWidth - HINT.width) / 2,
      top,
      (viewportWidth + HINT.width) / 2,
      top + HINT.height,
    );

  /** Measured in seeded Demo Mode: the Vault plaque and the dock. */
  const viewports = [
    {
      name: '390x844',
      width: 390,
      height: 844,
      plaque: rect(97, 90.1, 293, 163.6),
      dock: rect(16, 774, 374, 830),
    },
    {
      name: '360x640',
      width: 360,
      height: 640,
      plaque: rect(95, 90.1, 265, 153.6),
      dock: rect(12, 574, 348, 626),
    },
    {
      name: '844x390',
      width: 844,
      height: 390,
      plaque: rect(325, 12, 519, 86),
      dock: rect(198, 322, 646, 374),
    },
  ];

  for (const viewport of viewports) {
    it(`sits just above the dock and clear of the Vault at ${viewport.name}`, () => {
      const top = placeSkipHint({
        viewportHeight: viewport.height,
        plaque: viewport.plaque,
        base: viewport.dock.top,
        hintHeight: HINT.height,
      });
      const box = hintBox(top, viewport.width);
      expect(intersects(box, viewport.dock)).toBe(false);
      expect(intersects(box, swollen(viewport.plaque))).toBe(false);
      expect(viewport.dock.top - box.bottom).toBeGreaterThanOrEqual(SKIP_HINT_GAP);
      expect(viewport.dock.top - box.bottom).toBeLessThan(SKIP_HINT_GAP + 1);
    });
  }

  it('keeps clear of the dock even while the entrance lifts it into place', () => {
    const top = placeSkipHint({ viewportHeight: 844, plaque: null, base: 774, hintHeight: 29 });
    const entranceDrop = 8;
    expect(top + 29 + entranceDrop).toBeLessThan(774);
  });

  it('never lands under the plaque when the dock leaves no room above it', () => {
    const plaque = rect(325, 12, 519, 86);
    const top = placeSkipHint({ viewportHeight: 390, plaque, base: 120, hintHeight: 29 });
    expect(top).toBe(347);
    expect(intersects(hintBox(top, 844), swollen(plaque))).toBe(false);
  });

  it('uses the viewport floor without a laid-out dock, and the top without a plaque', () => {
    expect(placeSkipHint({ viewportHeight: 640, plaque: null, base: 0, hintHeight: 29 })).toBe(597);
    expect(placeSkipHint({ viewportHeight: 640, plaque: null, base: 574, hintHeight: 29 })).toBe(
      531,
    );
  });

  it('dims the dock through the cinematic and breathes only with full motion', () => {
    const css = readFileSync(new URL('./crates.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cp-crate::before\s*\{[^}]*var\(--cp-crate-dock-top/);
    expect(css).toMatch(/\.cp-crate-skip\s*\{[^}]*cp-crate-breathe/);
    const reduced = /([^{}]*)\{\s*animation:\s*none;\s*\}/g;
    const selectors = [...css.matchAll(reduced)].map((match) => match[1] ?? '').join(',');
    expect(selectors).toContain(".cp-crate[data-motion='reduced'] .cp-crate-skip");
  });

  it('keeps the skip hint to one line on a 360 px phone in every language', () => {
    for (const language of LANGUAGES) {
      expect(CRATES_STRINGS[language].skip.length).toBeLessThanOrEqual(26);
    }
  });
});

describe('crateFlyOffset', () => {
  const landedCentre = (
    from: { left: number; top: number; width: number; height: number },
    fly: { x: number; y: number },
    scale: number,
    originY: number,
  ) => {
    const untransformedHeight = from.height / scale;
    const originX = from.left + from.width / 2;
    const originTop = from.top + originY * from.height;
    const centreFromOrigin = untransformedHeight / 2 - originY * untransformedHeight;
    return {
      x: originX + scale * fly.x,
      y: originTop + scale * (fly.y + CARD_FLY_SCALE * centreFromOrigin),
    };
  };
  const plaque = { left: 97, top: 90.1, width: 196, height: 73.5 };

  for (const scale of [1, 0.6]) {
    it(`lands the shrunken card centre on the target centre at scale ${scale}`, () => {
      const from = { left: 25, top: 423, width: 340 * scale, height: 338.9 * scale };
      const fly = crateFlyOffset(from, plaque, scale, 0);
      const centre = landedCentre(from, fly, scale, 0);
      expect(centre.x).toBeCloseTo(plaque.left + plaque.width / 2, 6);
      expect(centre.y).toBeCloseTo(plaque.top + plaque.height / 2, 6);
    });
  }

  it('lands on the target from a centre origin before the card is placed', () => {
    const from = { left: 25, top: 200, width: 340, height: 338.9 };
    const fly = crateFlyOffset(from, plaque, 1, 0.5);
    const centre = landedCentre(from, fly, 1, 0.5);
    expect(centre.x).toBeCloseTo(plaque.left + plaque.width / 2, 6);
    expect(centre.y).toBeCloseTo(plaque.top + plaque.height / 2, 6);
  });

  it('treats a non-positive scale as unscaled', () => {
    const from = { left: 0, top: 0, width: 100, height: 100 };
    expect(crateFlyOffset(from, plaque, 0, 0)).toEqual(crateFlyOffset(from, plaque, 1, 0));
  });

  it('matches the shrink the fly keyframe ends on', () => {
    const css = readFileSync(new URL('./crates.css', import.meta.url), 'utf8');
    const fly = /@keyframes cp-crate-fly\s*\{[^@]*?scale\(([\d.]+)\)/.exec(css);
    expect(Number(fly?.[1])).toBe(CARD_FLY_SCALE);
  });
});

describe('UnboxDirector', () => {
  const FRAMING = { position: new Vector3(0, 0.5, 0.6), target: new Vector3(0, 0, -0.05), fov: 40 };
  const roll = (rarity: Roll['rarity']): Roll =>
    RollSchema.parse({
      rarity,
      rewards: [{ kind: 'currency', currency: 'pearls', amount: 25 }],
      proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'velvet', nonce: 1 },
      pity: { rare: 0, exquisite: 0, legendary: 0 },
    });
  const wallet = WalletSchema.parse({
    coins: 10,
    bullion: 0,
    goldBars: 0,
    pearls: 25,
    keys: 0,
    tickets: 0,
    stars: 0,
  });
  const opened = (id: string): OpenedCrate => ({
    crateId: id as CrateId,
    roll: roll('fine'),
    wallet,
    at: new Vector3(0, -0.075, 0.085),
  });

  function director(refuse: ReadonlySet<string>) {
    const parent = new Group();
    const cards: string[] = [];
    const disposedCards: string[] = [];
    const started: string[] = [];
    const unbox = new UnboxDirector({
      parent,
      camera: new PerspectiveCamera(40, 9 / 16),
      framing: () => FRAMING,
      events: createBus<CrateEvents>(),
      reducedMotion: () => true,
      onStart: (crateId) => started.push(crateId),
      card: (crate): UnboxCard => {
        if (refuse.has(crate.crateId)) throw new RangeError(`card refused ${crate.crateId}`);
        cards.push(crate.crateId);
        let shown = false;
        return {
          get shown() {
            return shown;
          },
          show: () => {
            shown = true;
          },
          dispose: () => disposedCards.push(crate.crateId),
        };
      },
    });
    return { unbox, parent, cards, disposedCards, started };
  }

  const BAD = 'crate_BBBBBBBBBBBBBBBB';

  it('compiles the unbox props only once primed or handed a crate, never at mount', () => {
    const { unbox, parent } = director(new Set());
    const light = parent.children[0];
    expect(light?.children).toEqual([]);
    unbox.prime();
    expect(light?.children.map((child) => child.name)).toEqual(['unbox-primer']);
    unbox.dispose();

    const handed = director(new Set());
    handed.unbox.enqueue(opened('crate_AAAAAAAAAAAAAAAA'));
    expect(handed.parent.children[0]?.children.map((child) => child.name)).toContain(
      'unbox-primer',
    );
    handed.unbox.dispose();
  });

  it('keeps one light in the scene from mount to dispose, whatever plays', () => {
    const { unbox, parent } = director(new Set());
    expect(parent.children).toHaveLength(1);
    const light = parent.children[0];
    unbox.enqueue(opened('crate_AAAAAAAAAAAAAAAA'));
    expect(parent.children).toHaveLength(2);
    unbox.update(1.2);
    unbox.update(0.1);
    unbox.collect();
    unbox.update(1);
    expect(unbox.active).toBeNull();
    expect(parent.children).toEqual([light]);
    unbox.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('leaves no stage behind when the card refuses a roll, and plays the next crate', () => {
    const { unbox, parent, cards, started } = director(new Set([BAD]));
    expect(() => {
      unbox.enqueue(opened(BAD));
    }).toThrow(RangeError);
    expect(unbox.active).toBeNull();
    expect(parent.children).toHaveLength(1);

    unbox.enqueue(opened('crate_AAAAAAAAAAAAAAAA'));
    unbox.enqueue(opened(BAD));
    unbox.enqueue(opened('crate_CCCCCCCCCCCCCCCC'));
    unbox.update(1.2);
    unbox.update(0.1);
    unbox.collect();
    expect(() => {
      unbox.update(1);
    }).toThrow(RangeError);
    expect(unbox.active).toBe('crate_CCCCCCCCCCCCCCCC');
    expect(unbox.waiting).toBe(0);
    expect(parent.children).toHaveLength(2);
    expect(cards).toEqual(['crate_AAAAAAAAAAAAAAAA', 'crate_CCCCCCCCCCCCCCCC']);
    expect(started).toEqual([BAD, 'crate_AAAAAAAAAAAAAAAA', BAD, 'crate_CCCCCCCCCCCCCCCC']);
    unbox.dispose();
    expect(parent.children).toHaveLength(0);
  });
});

describe('crates against the Demo Mode server', () => {
  let time: FakeTime;
  let server: MockServer;
  let player: Player;
  let playerId: PlayerId;

  beforeEach(async () => {
    time = new FakeTime();
    server = createMockServer({ now: time.now });
    player = await connectPlayer(server, time);
  });

  async function setup(client: Pick<ApiClient, 'call'> = player.client) {
    const outbox = await Outbox.open(player.store, rethrow);
    const table = new TableSync({
      client: player.client,
      outbox,
      connectivity: offlineNever,
      scheduler: manualScheduler,
      jitter: () => 0,
      onError: rethrow,
    });
    table.hydrate(await player.client.call('state'));
    await table.flush();
    playerId = requirePlayerId(player);
    let seconds = 0;
    const sim = {
      stats: {
        get tick() {
          return time.tick();
        },
        get pusherStroke() {
          return strokeAt(seconds);
        },
      },
    };
    const events = createBus<CrateEvents>();
    const log: { type: keyof CrateEvents; crateId?: CrateId }[] = [];
    const opened: { crateId: CrateId; roll: Roll }[] = [];
    const record =
      <K extends keyof CrateEvents>(type: K) =>
      (payload: CrateEvents[K]) => {
        log.push({ type, ...('crateId' in payload ? { crateId: payload.crateId } : {}) });
      };
    for (const type of [
      'crate:spawned',
      'crate:teeter',
      'crate:fell',
      'crate:claimed',
      'crate:rejected',
      'crate:failed',
      'crate:opened',
      'crate:pity',
    ] as const) {
      events.on(type, record(type));
    }
    events.on('crate:opened', ({ crateId, roll }) => opened.push({ crateId, roll }));
    const controller = new CrateController({ table, client, sim, events });
    let drops = 0;
    const falling: CoinId[] = [];

    /** One player drop; the coin from the drop before it goes out the front, as a real heap pays. */
    const drop = async () => {
      time.advance(250);
      seconds += 0.25;
      controller.update(0.25);
      const ticket = table.drop(0, time.tick());
      if (!ticket?.coin) throw new Error('Expected a buffered coin to drop.');
      drops += 1;
      await table.flush();
      const previous = falling.shift();
      if (previous !== undefined) {
        time.advance(MOCK_RULES.minFallMsAfterDrop);
        table.claimFall(previous, time.tick(), 'front');
        await table.flush();
      }
      falling.push(ticket.coin.id);
    };

    /** Lets the table run with no drops until the crates on it have gone over and opened. */
    const play = async (maxSeconds: number) => {
      for (let t = 0; t < maxSeconds && controller.riding.length > 0; t += 0.1) {
        time.advance(100);
        seconds += 0.1;
        controller.update(0.1);
        await table.flush();
      }
      await table.flush();
      await controller.settled();
    };

    return {
      table,
      controller,
      events,
      log,
      opened,
      drop,
      play,
      get drops() {
        return drops;
      },
      get seconds() {
        return seconds;
      },
    };
  }

  function expectConserved(): void {
    expect(ledgerWallet(server, playerId)).toEqual(serverWallet(server, playerId));
  }

  it('scripts the FTUE crate at drop 12, rides it off the front, claims it and opens a fine charm crate', async () => {
    const game = await setup();
    let spawnedAt = 0;
    while (game.log.every((entry) => entry.type !== 'crate:spawned')) {
      await game.drop();
      spawnedAt = game.drops;
      if (game.drops > crateSpawn.ftueScriptedDrop) break;
    }
    expect(spawnedAt).toBe(crateSpawn.ftueScriptedDrop);
    const spawnSeconds = game.seconds;
    await game.play(CRATE_RIDE_SECONDS.max + 1);
    const crateId = game.log.find((entry) => entry.type === 'crate:spawned')?.crateId;
    expect(
      game.log.filter((entry) => entry.crateId === crateId).map((entry) => entry.type),
    ).toEqual(['crate:spawned', 'crate:teeter', 'crate:fell', 'crate:claimed', 'crate:opened']);
    expect(game.log.at(-1)?.type).toBe('crate:pity');
    const [first] = game.opened;
    expect(first?.crateId).toBe(crateId);
    expect(first?.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    expect(first?.roll.rewards.some((reward) => reward.kind === 'charm')).toBe(
      crateSpawn.ftueScriptedCharm,
    );
    const rideSeconds = game.seconds - spawnSeconds;
    expect(rideSeconds).toBeGreaterThanOrEqual(CRATE_RIDE_SECONDS.min);
    expect(spawnSeconds + rideSeconds).toBeLessThan(45);
    expect(game.controller.riding).toHaveLength(0);
    expect(serverWallet(server, playerId).pearls).toBeGreaterThan(0);
    expectConserved();
  });

  async function openFtueCrate(game: Awaited<ReturnType<typeof setup>>) {
    while (game.controller.riding.length === 0) await game.drop();
    await game.play(CRATE_RIDE_SECONDS.max + 1);
    const [first] = game.opened;
    if (!first) throw new Error('Expected the FTUE crate to open');
    return first;
  }

  it('reads the server album after an open with an album card and reports its set progress', async () => {
    const game = await setup();
    const albums: CrateEvents['crate:album'][] = [];
    game.events.on('crate:album', (payload) => albums.push(payload));
    game.events.on('crate:albumFailed', ({ error }) => rethrow(error));
    const first = await openFtueCrate(game);
    const cards = first.roll.rewards.flatMap((reward) =>
      reward.kind === 'collectible' ? [reward.collectibleId] : [],
    );
    expect(cards.length).toBeGreaterThan(0);
    expect(albums).toHaveLength(1);
    const [report] = albums;
    expect(report?.crateId).toBe(first.crateId);
    const served = await player.client.call('album');
    for (const id of cards) {
      const set = served.sets.find((candidate) => candidate.entries.some((e) => e.id === id));
      expect(report?.progress[id]).toEqual({
        owned: set?.entries.filter((entry) => entry.owned).length,
        total: set?.entries.length,
      });
      expect(report?.progress[id]?.owned).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports a failed album read without failing the crate', async () => {
    const failure = new Error('album offline');
    const client: Pick<ApiClient, 'call'> = {
      call: ((...args: Parameters<ApiClient['call']>) =>
        args[0] === 'album'
          ? Promise.reject(failure)
          : player.client.call(...args)) as ApiClient['call'],
    };
    const game = await setup(client);
    const failed: unknown[] = [];
    game.events.on('crate:albumFailed', ({ error }) => failed.push(error));
    game.events.on('crate:album', () => {
      throw new Error('Expected no album progress');
    });
    await openFtueCrate(game);
    expect(failed).toEqual([failure]);
    expect(game.log.some((entry) => entry.type === 'crate:failed')).toBe(false);
    expectConserved();
  });

  it('reports a crate the server already settled as rejected, and opens nothing', async () => {
    const game = await setup();
    while (game.controller.riding.length === 0) await game.drop();
    const [ride] = game.controller.riding;
    if (!ride) throw new Error('Expected a crate on the table.');
    time.advance(100);
    await player.client.call('tableClaims', {
      body: {
        claims: [{ kind: 'crate', crateId: ride.crate.id, tick: time.tick(), edge: 'left' }],
      },
    });
    await game.play(CRATE_RIDE_SECONDS.max + 1);
    expect(game.log.filter((entry) => entry.crateId === ride.crate.id).map((e) => e.type)).toEqual([
      'crate:spawned',
      'crate:teeter',
      'crate:fell',
      'crate:rejected',
    ]);
    expect(game.opened).toHaveLength(0);
    expectConserved();
  });

  it('carries the server pity counters through every open and lands the guaranteed floor', async () => {
    const game = await setup();
    const rare = pityConfig.rules.find((rule) => rule.rarity === 'rare');
    if (!rare) throw new Error('Expected a rare pity rule');
    const pityReports: CrateEvents['crate:pity']['pity'][] = [];
    game.events.on('crate:pity', ({ pity }) => pityReports.push(pity));

    const openNext = async () => {
      const before = game.opened.length;
      while (game.controller.riding.length === 0) await game.drop();
      await game.play(CRATE_RIDE_SECONDS.max + 1);
      expect(game.opened).toHaveLength(before + 1);
      const roll = game.opened.at(-1)?.roll;
      if (!roll) throw new Error('Expected an opened crate');
      return roll;
    };

    const ftue = await openNext();
    expect(ftue.pity).toEqual({ rare: 0, exquisite: 0, legendary: 0 });

    const mock = server.world.player(playerId);
    if (!mock) throw new Error('Expected the mock player');
    mock.pity.set('vaultCrate', { rare: rare.within - 1, exquisite: 3, legendary: 7 });
    const forced = await openNext();
    expect(RARITIES.indexOf(forced.rarity)).toBeGreaterThanOrEqual(RARITIES.indexOf('rare'));
    expect(forced.pity.rare).toBe(0);
    const rank = RARITIES.indexOf(forced.rarity);
    expect(forced.pity.exquisite).toBe(rank >= RARITIES.indexOf('exquisite') ? 0 : 4);
    expect(forced.pity.legendary).toBe(rank >= RARITIES.indexOf('legendary') ? 0 : 8);
    expect(pityOutlook(forced.pity)?.within).toBeGreaterThan(0);

    const next = await openNext();
    const nextRank = RARITIES.indexOf(next.rarity);
    for (const rule of pityConfig.rules) {
      const previous = forced.pity[rule.rarity];
      expect(next.pity[rule.rarity]).toBe(
        nextRank >= RARITIES.indexOf(rule.rarity) ? 0 : previous + 1,
      );
    }
    expect(pityReports).toEqual([ftue.pity, forced.pity, next.pity]);
    expect(game.controller.pity).toEqual(next.pity);
    expectConserved();
  });

  it('stops listening once disposed', async () => {
    const game = await setup();
    game.controller.dispose();
    for (let i = 0; i < crateSpawn.ftueScriptedDrop; i++) await game.drop();
    expect(game.log).toEqual([]);
    expect(game.controller.riding).toHaveLength(0);
  });
});

describe('overlapping crate opens', () => {
  const deck = album.find((set) => set.id === 'deckEssentials');
  if (!deck) throw new Error('Expected the deckEssentials album set');
  const albumWith = (owned: number): AlbumResponse => ({
    sets: album.map((set) => ({
      id: set.id as never,
      entries: set.items.map((item, index) => ({
        id: item.id as never,
        kind: 'coinSkin' as const,
        owned: set.id === deck.id && index < owned,
        count: set.id === deck.id && index < owned ? 1 : 0,
      })),
      completed: false,
    })),
  });
  const openedWithCard = () => ({
    roll: RollSchema.parse({
      rarity: 'fine',
      rewards: [{ kind: 'collectible', collectibleId: 'teakDeckCoin' }],
      proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'velvet', nonce: 1 },
      pity: { rare: 0, exquisite: 0, legendary: 0 },
    }),
    wallet: WalletSchema.parse({
      coins: 0,
      bullion: 0,
      goldBars: 0,
      pearls: 0,
      keys: 0,
      tickets: 0,
      stars: 0,
    }),
  });

  interface Pending {
    readonly endpoint: string;
    readonly crateId: CrateId | undefined;
    readonly resolve: (value: unknown) => void;
  }

  it('reads each crate’s album right after its own grant, in open order', async () => {
    const pending: Pending[] = [];
    const client: Pick<ApiClient, 'call'> = {
      call: ((endpoint: string, options?: { body?: { crateId?: CrateId } }) =>
        new Promise((resolve) => {
          pending.push({ endpoint, crateId: options?.body?.crateId, resolve });
        })) as unknown as ApiClient['call'],
    };
    const listeners: ((event: TableEvent) => void)[] = [];
    const table = {
      subscribe: (listener: (event: TableEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      claimCrate: () => undefined,
    };
    const events = createBus<CrateEvents>();
    const albums: { crateId: CrateId; owned: number | undefined }[] = [];
    events.on('crate:album', ({ crateId, progress }) =>
      albums.push({ crateId, owned: progress.teakDeckCoin?.owned }),
    );
    const controller = new CrateController({
      table,
      client,
      sim: { stats: { tick: 0, pusherStroke: 0 } },
      events,
    });
    const a = 'crate_AAAAAAAAAAAAAAAA' as CrateId;
    const b = 'crate_BBBBBBBBBBBBBBBB' as CrateId;
    controller.adopt([crate(a), crate(b)]);
    for (let t = 0; t < CRATE_RIDE_SECONDS.max + 1; t += 1 / 30) controller.update(1 / 30);
    expect(controller.riding).toHaveLength(0);
    for (const crateId of [a, b]) {
      const settled = {
        type: 'claimSettled',
        claim: { kind: 'crate', crateId, tick: 0, edge: 'front' },
        result: { status: 'accepted' },
      } as TableEvent;
      for (const listener of listeners) listener(settled);
    }
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const answer = async (endpoint: string, value: unknown) => {
      await flush();
      const next = pending.shift();
      expect(next?.endpoint).toBe(endpoint);
      next?.resolve(value);
      await flush();
      return next;
    };

    expect((await answer('cratesOpen', openedWithCard()))?.crateId).toBe(a);
    expect(pending.map((call) => call.endpoint)).toEqual(['album']);
    await answer('album', albumWith(3));
    expect((await answer('cratesOpen', openedWithCard()))?.crateId).toBe(b);
    await answer('album', albumWith(4));
    await controller.settled();
    expect(albums).toEqual([
      { crateId: a, owned: 3 },
      { crateId: b, owned: 4 },
    ]);
  });
});

describe('adopting the table the server laid', () => {
  const STEP = 1 / 60;
  const A = 'crate_AAAAAAAAAAAAAAAA' as CrateId;
  const B = 'crate_BBBBBBBBBBBBBBBB' as CrateId;
  const C = 'crate_CCCCCCCCCCCCCCCC' as CrateId;

  /** A controller on a stub table: the sim clock is set by hand and every event is logged. */
  function session() {
    const listeners: ((event: TableEvent) => void)[] = [];
    const claims: CrateId[] = [];
    const events = createBus<CrateEvents>();
    const log: { type: keyof CrateEvents; crateId: CrateId; resumed?: boolean }[] = [];
    for (const type of ['crate:spawned', 'crate:teeter', 'crate:fell', 'crate:failed'] as const) {
      events.on(type, (payload) => {
        log.push({
          type,
          crateId: payload.crateId,
          ...('resumed' in payload ? { resumed: payload.resumed } : {}),
        });
      });
    }
    const sim = { stats: { tick: 0, pusherStroke: 0 } };
    const controller = new CrateController({
      table: {
        subscribe: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
        claimCrate: (crateId) => {
          claims.push(crateId);
        },
      },
      client: { call: () => Promise.reject(new Error('no server in this test')) },
      sim,
      events,
    });
    let seconds = 0;
    const step = () => {
      seconds += STEP;
      sim.stats.pusherStroke = strokeAt(seconds);
      sim.stats.tick += 1;
      controller.update(STEP);
    };
    const at = (time: number) => {
      seconds = time;
      sim.stats.pusherStroke = strokeAt(time);
    };
    const drop = (...ids: CrateId[]) => {
      const event = { type: 'dropSettled', spawnedCrates: ids.map(crate) } as unknown as TableEvent;
      for (const listener of listeners) listener(event);
    };
    return { controller, events, log, claims, step, at, drop, now: () => seconds };
  }

  /** The tuples as they come back from the server: through JSON, as `layout.crates` poses. */
  function stored(tuples: readonly CratePoseTuple[]): CratePlacement[] {
    return (JSON.parse(JSON.stringify(tuples)) as CratePoseTuple[]).map((pose) => ({
      kind: 'pose',
      pose,
    }));
  }

  /** Rides crate A from the chute, uploading the table after `steps` steps. */
  function rideThenUpload(steps: number) {
    const before = session();
    before.controller.adopt([crate(A)]);
    for (let i = 0; i < steps; i++) before.step();
    const upload = before.controller.snapshot();
    return { before, upload };
  }

  it('resumes a posed crate at its stored pose after a reload and tips on the same frame', () => {
    const { before, upload } = rideThenUpload(90);
    const [original] = before.controller.riding;
    if (!original) throw new Error('crate A fell before the upload');
    expect(original.position.z).toBeGreaterThan(CRATE_RIDE.spawnZ);

    const after = session();
    after.at(before.now());
    after.controller.adopt([crate(A)], stored(upload));
    const [resumed] = after.controller.riding;
    if (!resumed) throw new Error('crate A was not resumed');
    expect(resumed.position).toEqual(original.position);
    expect(resumed.seconds).toBe(original.seconds);
    expect(resumed.phase).toBe(original.phase);
    expect(after.log).toEqual([{ type: 'crate:spawned', crateId: A, resumed: true }]);

    let stepsLeft = 0;
    while (before.controller.riding.length > 0 || after.controller.riding.length > 0) {
      if (stepsLeft++ > CRATE_RIDE_SECONDS.max / STEP) throw new Error('crate A never fell');
      before.step();
      after.step();
      expect(after.controller.riding.map((ride) => ride.position)).toEqual(
        before.controller.riding.map((ride) => ride.position),
      );
    }
    expect(after.claims).toEqual([A]);
    expect(after.log.at(-1)).toEqual({ type: 'crate:fell', crateId: A });
  });

  it('resumes a teetering crate over the lip, on the lower tier, still teetering', () => {
    const before = session();
    before.controller.adopt([crate(A)]);
    while (before.controller.riding[0]?.phase === 'riding') before.step();
    expect(before.controller.riding[0]?.phase).toBe('teeter');
    const upload = before.controller.snapshot();

    const after = session();
    after.at(before.now());
    after.controller.adopt([crate(A)], stored(upload));
    const [resumed] = after.controller.riding;
    expect(resumed?.phase).toBe('teeter');
    expect(resumed?.position.y).toBe(0);
    expect(resumed?.position.z).toBeGreaterThanOrEqual(CRATE_RIDE.teeterZ);
    expect(resumed?.tilt).toBeGreaterThan(0);
    expect(after.log.map(({ type }) => type)).toEqual(['crate:spawned']);
  });

  it('starts a chute placement fresh from the chute, wherever the crate last was', () => {
    rideThenUpload(90);
    const after = session();
    after.controller.adopt([crate(A)], [{ kind: 'chute' }]);
    const [ride] = after.controller.riding;
    expect(ride?.position.z).toBe(CRATE_RIDE.spawnZ);
    expect(ride?.seconds).toBe(0);
    expect(ride?.phase).toBe('riding');
    expect(after.log).toEqual([{ type: 'crate:spawned', crateId: A, resumed: false }]);
  });

  it('starts every crate from the chute when the session carries no layout', () => {
    const { controller, log } = session();
    controller.adopt([crate(A), crate(B)]);
    expect(controller.riding.map((ride) => ride.position.z)).toEqual([
      CRATE_RIDE.spawnZ,
      CRATE_RIDE.spawnZ,
    ]);
    expect(log.map(({ resumed }) => resumed)).toEqual([false, false]);
  });

  it('puts adopted crates in the next table snapshot, posed ones exactly as stored', () => {
    const { upload } = rideThenUpload(90);
    const { controller, drop } = session();
    controller.adopt([crate(A), crate(B)], [...stored(upload), { kind: 'chute' }]);
    drop(C);
    const next = controller.snapshot();
    expect(next.map(([id]) => id)).toEqual([A, B, C]);
    expect(next[0]).toEqual(upload[0]);
    const chuteZ = Math.round(CRATE_RIDE.spawnZ / POSITION_UNIT);
    expect(next[1]).toEqual([B, next[1]?.[1], chuteZ, 0, 'riding']);
    for (const [, x, z, elapsedMs, phase] of next) {
      expect(checkCratePose({ x, z, elapsedMs, phase }, CRATE_RIDE_SECONDS.max)).toEqual({
        ok: true,
      });
    }
  });

  it('leaves a fallen crate out of the snapshot and caps it at the transport bound', () => {
    const { controller, step } = session();
    const many = Array.from({ length: MAX_SNAPSHOT_CRATES + 2 }, (_, i) =>
      crate(`crate_${String(i).padStart(16, 'Z')}`),
    );
    controller.adopt(many);
    expect(controller.snapshot()).toHaveLength(MAX_SNAPSHOT_CRATES);
    for (let t = 0; t < CRATE_RIDE_SECONDS.max + 1; t += STEP) step();
    expect(controller.riding).toHaveLength(0);
    expect(controller.snapshot()).toEqual([]);
  });

  it('adopts a crate it already rides only once', () => {
    const { upload } = rideThenUpload(60);
    const { controller, log } = session();
    controller.adopt([crate(A)]);
    controller.adopt([crate(A)], stored(upload));
    expect(controller.riding).toHaveLength(1);
    expect(log).toEqual([{ type: 'crate:spawned', crateId: A, resumed: false }]);
  });

  it('starts a pose the ride cannot take from the chute and still lays the rest', () => {
    const tipZ = Math.round(CRATE_RIDE.tipZ / POSITION_UNIT);
    const { controller, log } = session();
    controller.adopt(
      [crate(A), crate(B)],
      [{ kind: 'pose', pose: [A, 0, tipZ + 10, 1000, 'teeter'] }, { kind: 'chute' }],
    );
    expect(controller.riding.map((ride) => ride.crate.id)).toEqual([A, B]);
    expect(controller.riding[0]?.position.z).toBe(CRATE_RIDE.spawnZ);
    expect(controller.riding[0]?.phase).toBe('riding');
    expect(controller.snapshot().map(([id]) => id)).toEqual([A, B]);
    expect(log.some(({ type }) => type === 'crate:failed')).toBe(false);
    expect(log).toEqual([
      { type: 'crate:spawned', crateId: A, resumed: false },
      { type: 'crate:spawned', crateId: B, resumed: false },
    ]);
  });

  it('refuses placements that do not lay the crates one for one, in order', () => {
    const { controller } = session();
    expect(() => {
      controller.adopt([crate(A), crate(B)], [{ kind: 'chute' }]);
    }).toThrow(/1 placements for 2 crates/);
    expect(() => {
      controller.adopt([crate(A)], [{ kind: 'pose', pose: [B, 0, 0, 0, 'riding'] }]);
    }).toThrow(/names crate crate_B/);
    expect(controller.riding).toHaveLength(0);
  });
});
