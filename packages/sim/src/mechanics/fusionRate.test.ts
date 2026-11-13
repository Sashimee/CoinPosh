import {
  economyConfig,
  ladderTargets,
  openingHeap,
  rateEnvelope,
  rateEnvelopeDerivation,
} from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { afterAll, describe, expect, it } from 'vitest';
// The economy's measured ladder lives in its sim/ folder, which its package exports leave out.
import { evaluateLadder, playStyles } from '../../../economy/sim/ladder.ts';
import { simModel } from '../../../economy/sim/model.ts';
import { COIN } from '../coin.ts';
import { TICK_RATE_HZ } from '../constants.ts';
import { MAX_DROP_OFFSET_MM, type SimInput } from '../inputs.ts';
import { Xoshiro128ss } from '../prng.ts';
import { Sim } from '../sim.ts';
import type { FusionEvent, MechanicsConfig } from './mechanics.ts';
import { FUSION_TUNING } from './tuning.ts';

/** The Demo table as apps/web's sim worker runs it (SIM_MECHANICS in table-config.ts). */
const DEMO_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PLAY_SECONDS = 180;

interface Played {
  readonly drops: number;
  readonly fusions: readonly FusionEvent<string>[];
  readonly fallTicks: readonly number[];
  readonly hash: string;
}

async function play(
  seed: number,
  inputsAt: (tick: number) => SimInput[],
  seconds: number,
): Promise<Played> {
  const sim = await Sim.create({ seed, mechanics: DEMO_MECHANICS, openingHeap });
  try {
    let drops = 0;
    const fusions: FusionEvent<string>[] = [];
    const fallTicks: number[] = [];
    for (let tick = 0; tick < seconds * TICK_RATE_HZ; tick++) {
      const inputs = inputsAt(tick);
      drops += inputs.length;
      const events = sim.step(inputs);
      for (const event of events.mechanics) {
        if (event.kind === 'fusion') {
          fusions.push(event);
        }
      }
      fallTicks.push(...events.falls.map(() => tick));
    }
    return { drops, fusions, fallTicks, hash: sim.hash() };
  } finally {
    sim.dispose();
  }
}

/** A copper a second, each at an aim drawn uniformly across the whole chute. */
function tapping(seed: number): (tick: number) => SimInput[] {
  const rng = Xoshiro128ss.fromSeed(seed ^ 0x7a9);
  return (tick) =>
    tick % TICK_RATE_HZ === 0
      ? [
          {
            kind: 'dropCoin',
            xMm: Math.round(rng.nextRange(-MAX_DROP_OFFSET_MM, MAX_DROP_OFFSET_MM)),
          },
        ]
      : [];
}

const sessions = new Map<number, Promise<Played>>();

function session(seed: number): Promise<Played> {
  let played = sessions.get(seed);
  if (!played) {
    played = play(seed, tapping(seed), PLAY_SECONDS);
    sessions.set(seed, played);
  }
  return played;
}

afterAll(() => {
  sessions.clear();
});

function firstFusionSeconds({ fusions }: Played): number {
  return (fusions[0]?.tick ?? Number.POSITIVE_INFINITY) / TICK_RATE_HZ;
}

/**
 * Issue #132: Contact Fusion is a merge the player aims for, not a constant flicker. At a
 * copper a second, aimed anywhere across the chute, onto the economy's opening heap, the
 * first fusion comes within the FTUE's 60 s (00-VISION) and after that about one drop in
 * 12 to 20 is fused, 3 to 5 fusions a minute. Before the fresh window (FUSION_TUNING.
 * freshTicks) these seeds fused 28 to 30 times a minute, one fusion every 2 drops; with it
 * they fuse 3.8 times a minute, one drop in 16, the first fusion landing 8 to 46 s in.
 * The silver heap never fuses on its own: a heap coin fuses only once a silver made in
 * play has touched it. One test per seed keeps each inside the CI timeout; the band is
 * checked over all of them.
 */
describe('fusion rate at a drop a second on the Demo table', () => {
  it.each(SEEDS)('fuses for the first time within 60 s on seed %i', async (seed) => {
    const played = await session(seed);
    expect(firstFusionSeconds(played)).toBeLessThanOrEqual(60);
    const firstSilver = played.fusions.find((fusion) => fusion.into === 'silver')?.tick ?? 0;
    for (const fusion of played.fusions.filter(({ ids }) =>
      ids.some((id) => id < openingHeap.coins),
    )) {
      expect(fusion.tier, `fusion at ${fusion.tick}`).toBe(openingHeap.tier);
      expect(fusion.tick, `fusion at ${fusion.tick}`).toBeGreaterThanOrEqual(
        firstSilver + FUSION_TUNING.spawnGraceTicks,
      );
    }
  });

  it('fuses 3 to 5 times a minute, one drop in 12 to 20', { timeout: 300_000 }, async () => {
    const all = await Promise.all(SEEDS.map(session));
    const fusions = all.reduce((sum, { fusions }) => sum + fusions.length, 0);
    const drops = all.reduce((sum, played) => sum + played.drops, 0);
    const minutes = (SEEDS.length * PLAY_SECONDS) / 60;
    expect(fusions / minutes).toBeGreaterThanOrEqual(3);
    expect(fusions / minutes).toBeLessThanOrEqual(5);
    expect(drops / fusions).toBeGreaterThanOrEqual(12);
    expect(drops / fusions).toBeLessThanOrEqual(20);
  });
});

describe('aimed drops on the Demo table', () => {
  /** `count` coppers at one aim, `every` ticks apart, then nothing. */
  function aimed(xMm: number, count: number, every: number): (tick: number) => SimInput[] {
    return (tick) =>
      tick % every === 0 && tick < count * every ? [{ kind: 'dropCoin', xMm }] : [];
  }

  const dropped = (count: number) =>
    Array.from({ length: count }, (_, index) => openingHeap.coins + index);

  it.each([-120, -60, 0, 60, 120])(
    'fuses a three-copper pour at %i mm into a silver within 2 s, which wakes two heap silvers into a gold',
    async (xMm) => {
      const { fusions } = await play(0xa1d, aimed(xMm, 3, 6), 8);
      expect(fusions).toHaveLength(2);
      const [silver, gold] = fusions;
      expect(silver).toMatchObject({ ids: dropped(3), tier: 'copper', into: 'silver' });
      expect(silver?.tick).toBeLessThanOrEqual(2 * TICK_RATE_HZ);
      expect(gold).toMatchObject({ tier: 'silver', into: 'gold' });
      expect(gold?.ids.filter((id) => id < openingHeap.coins)).toHaveLength(2);
      expect(gold?.ids).toContain(silver?.fusedId);
      expect(gold?.tick).toBeGreaterThanOrEqual(
        (silver?.tick ?? 0) + FUSION_TUNING.spawnGraceTicks,
      );
    },
  );

  /**
   * P-332: kept on purpose. The drop strip rides the pusher, which carries a landed coin
   * about two coin widths a second, so a copper tapped a second after another lands two
   * widths behind it, not on it. Three taps lay a line that the backboard folds into a
   * pair and a straggler; a fourth or fifth tap, or a pour, closes the gap.
   * Fusing them anyway would take a contact gap the player can see.
   */
  it.each([-120, -60, 0, 60, 120])(
    'does not fuse three coppers tapped a second apart at %i mm: the strip carries each two widths on',
    async (xMm) => {
      const sim = await Sim.create({ seed: 0xa1d, mechanics: DEMO_MECHANICS, openingHeap });
      try {
        const [first, second] = dropped(2);
        let apart = 0;
        for (let tick = 0; tick < 8 * TICK_RATE_HZ; tick++) {
          if (tick === 2 * TICK_RATE_HZ) {
            const at = (id: number | undefined) => {
              const coin = sim.coins().find((c) => c.id === id);
              if (!coin) {
                throw new Error(`coin ${id} is not on the table`);
              }
              return coin.translation;
            };
            const p = at(first);
            const q = at(second);
            const dx = p.x - q.x;
            const dz = p.z - q.z;
            apart = Math.sqrt(dx * dx + dz * dz);
          }
          const events = sim.step(aimed(xMm, 3, TICK_RATE_HZ)(tick)).mechanics;
          expect(events.filter(({ kind }) => kind === 'fusion')).toEqual([]);
        }
        expect(apart).toBeGreaterThan(1.5 * 2 * COIN.radius);
      } finally {
        sim.dispose();
      }
    },
  );

  it.each([-120, -60, 0, 60, 120])(
    'fuses three of five coppers tapped a second apart at %i mm within 5 s',
    async (xMm) => {
      const { fusions } = await play(0xa1d, aimed(xMm, 5, TICK_RATE_HZ), 8);
      expect(fusions).toHaveLength(1);
      expect(fusions[0]).toMatchObject({ tier: 'copper', into: 'silver' });
      expect(fusions[0]?.ids.every((id) => dropped(5).includes(id))).toBe(true);
      expect(fusions[0]?.tick).toBeLessThanOrEqual(5 * TICK_RATE_HZ);
    },
  );

  /**
   * The ladder climbs under aimed play (00-VISION §1): two coppers a second at the middle
   * of the chute make silvers on the strip, and each new silver wakes the silvers it lands
   * on, older ones and the heap's alike, so silvers fuse into gold, and golds into platinum, within the minute.
   */
  it.each([0xa1d, 1, 2])(
    'fuses silver into gold and gold into platinum within 60 s of two taps a second at the middle on seed %i',
    async (seed) => {
      const { fusions } = await play(seed, aimed(0, 120, TICK_RATE_HZ / 2), 60);
      const into = (tier: string) => fusions.filter((fusion) => fusion.into === tier).length;
      expect(into('gold')).toBeGreaterThanOrEqual(6);
      expect(into('platinum')).toBeGreaterThanOrEqual(1);
    },
  );

  it('replays an aimed fusion to the same state', async () => {
    const a = await play(0xa1d, aimed(0, 5, TICK_RATE_HZ), 8);
    const b = await play(0xa1d, aimed(0, 5, TICK_RATE_HZ), 8);
    expect(b).toEqual(a);
  });
});

/** The most events in any `windowTicks`-long span of the sorted `ticks`. */
function busiest(ticks: readonly number[], windowTicks: number): number {
  let most = 0;
  for (let end = 0, start = 0; end < ticks.length; end++) {
    while ((ticks[end] ?? 0) - (ticks[start] ?? 0) >= windowTicks) {
      start++;
    }
    most = Math.max(most, end - start + 1);
  }
  return most;
}

/**
 * P-375, founder report on #132: holding a finger on the chute pours a copper every 6
 * ticks, the most the server's drops envelope lets through, and fused 266 to 274 times a
 * minute, twice the rateEnvelope fusions max, so an honest pour was flagged, the ladder
 * reached diamond in under a minute and most coins fused on the shelf instead of falling.
 * The chute's stream allowance (FUSION_TUNING.streamTicks, streamBurst) lands the coins a
 * pour drops faster than fast tapping idle, so a pour fuses like 3 to 4 taps a second.
 */
describe('a sustained pour on the Demo table', () => {
  const POUR_TICKS = Math.ceil(
    rateEnvelope.drops.windowMs / rateEnvelope.drops.max / (1000 / TICK_RATE_HZ),
  );
  const POUR_SECONDS = 90;
  const POURS = [1, 2, 3, 4].flatMap((seed) => [-120, 0, 60].map((xMm) => [seed, xMm] as const));
  const MINUTE_TICKS = rateEnvelope.fusions.windowMs / (1000 / TICK_RATE_HZ);
  /** Fusions a minute of the economy's ladder styles that tap two to three times a second, aimed. */
  const tappedFusionsPerMinute = evaluateLadder(simModel, economyConfig.fusion.bonusMultiplier)
    .styles.filter(({ style }) => {
      const { tapsPerSecond, aimSpreadMm, pour } = playStyles[style];
      return !pour && tapsPerSecond >= 2 && tapsPerSecond <= 3 && aimSpreadMm < MAX_DROP_OFFSET_MM;
    })
    .map(({ fusionsPerMinute }) => fusionsPerMinute);
  const TAPPED_FUSIONS_PER_MINUTE = {
    min: Math.min(...tappedFusionsPerMinute),
    max: Math.max(...tappedFusionsPerMinute),
  };

  function pour(xMm: number): (tick: number) => SimInput[] {
    return (tick) => (tick % POUR_TICKS === 0 ? [{ kind: 'dropCoin', xMm }] : []);
  }

  const pours = new Map<string, Promise<Played>>();

  function poured(seed: number, xMm: number): Promise<Played> {
    const key = `${seed}:${xMm}`;
    let played = pours.get(key);
    if (!played) {
      played = play(seed, pour(xMm), POUR_SECONDS);
      pours.set(key, played);
    }
    return played;
  }

  afterAll(() => {
    pours.clear();
  });

  const firstSeconds = ({ fusions }: Played, tier: string) =>
    (fusions.find(({ into }) => into === tier)?.tick ?? Number.POSITIVE_INFINITY) / TICK_RATE_HZ;

  it('pours as fast as the drops envelope lets a held finger', () => {
    expect(POUR_TICKS).toBe(6);
  });

  it.each(POURS)(
    'keeps a pour on seed %i at %i mm under the fusions envelope, with an honest margin',
    { timeout: 120_000 },
    async (seed, xMm) => {
      const played = await poured(seed, xMm);
      const minute = busiest(
        played.fusions.map(({ tick }) => tick),
        MINUTE_TICKS,
      );
      expect(minute).toBeLessThanOrEqual(
        rateEnvelope.fusions.max / rateEnvelopeDerivation.headroom,
      );
      const fallWindow = rateEnvelope.falls.windowMs / (1000 / TICK_RATE_HZ);
      expect(busiest(played.fallTicks, fallWindow)).toBeLessThanOrEqual(rateEnvelope.falls.max);
      expect(played.fallTicks.length / played.drops).toBeGreaterThanOrEqual(0.6);
    },
  );

  it('fuses like fast tapping, not faster', { timeout: 600_000 }, async () => {
    expect(tappedFusionsPerMinute.length).toBeGreaterThan(0);
    const all = await Promise.all(POURS.map(([seed, xMm]) => poured(seed, xMm)));
    for (const played of all) {
      const perMinute = (played.fusions.length / POUR_SECONDS) * 60;
      expect(perMinute).toBeGreaterThanOrEqual(TAPPED_FUSIONS_PER_MINUTE.min);
      expect(perMinute).toBeLessThanOrEqual(TAPPED_FUSIONS_PER_MINUTE.max);
      expect(played.drops / played.fusions.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('holds the ladder targets of 02-ECONOMY for a pour', { timeout: 600_000 }, async () => {
    const all = await Promise.all(POURS.map(([seed, xMm]) => poured(seed, xMm)));
    const soonest = ladderTargets.filter((target) => 'min' in target);
    expect(soonest.length).toBeGreaterThan(0);
    for (const target of soonest) {
      for (const played of all) {
        expect(firstSeconds(played, target.tier), target.id).toBeGreaterThanOrEqual(target.min);
      }
    }
    for (const id of ['firstFusionAimed', 'firstGoldAimed'] as const) {
      const target = ladderTargets.find((candidate) => candidate.id === id);
      if (!target || !('max' in target)) {
        throw new Error(`ladderTargets has no ${id} with a max`);
      }
      for (const played of all) {
        expect(firstSeconds(played, target.tier), id).toBeLessThanOrEqual(target.max);
      }
    }
  });

  it('replays a pour to the same state', { timeout: 120_000 }, async () => {
    const replayed = await play(1, pour(0), POUR_SECONDS);
    expect(replayed).toEqual(await poured(1, 0));
    expect(replayed.hash).toMatchInlineSnapshot(`"9e48160a1fda528e"`);
  });
});
