import { economyConfig, openingHeap } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { TICK_RATE_HZ } from '../constants.ts';
import type { SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { Xoshiro128ss } from '../prng.ts';
import { Sim } from '../sim.ts';
import { PUSHER } from './layout.ts';

/**
 * P-436 FTUE harness: a new player's opening taps on the Demo opening heap, measured from the
 * first tap to the first front fall (the first credit). 20 tables (the Demo seed, then 1..19),
 * each first tap at a seeded point in the pusher cycle, because a new player boots at pusher
 * tick 0 and reads the table for an unknown while before tapping.
 */
const SEEDS = Array.from({ length: 20 }, (_, i) => (i === 0 ? 0xc0196051 : i));
const WORKER_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};
/** The web's aim map puts a tap at 160..220 px on a 390 px screen at these drop-rail points. */
const CENTRE_X_MM: readonly [number, number] = [-34, 24];
const RAIL_X_MM: readonly [number, number] = [-150, 150];
const MAX_DROPS = 60;
/**
 * Two pusher cycles. A drop only reaches the ledge after the backboard scrapes it forward on
 * a retraction and the next push carries it to the lip, so the first credit trails the first
 * tap by at least one retraction and the push after it.
 */
const PAYS_WITHIN_TICKS = 2 * PUSHER.periodTicks;
const PHYSICS_FLOOR_TICKS = 3 * TICK_RATE_HZ;
/** P-436 asks for the first credit by the 8th drop. */
const TARGET_DROPS = 8;

interface Opening {
  readonly drops: number;
  readonly ticksAfterFirstTap: number;
}

async function opening(seed: number, interval: number, aim: readonly [number, number]) {
  const taps = Xoshiro128ss.fromSeed((seed ^ 0x5eed) >>> 0);
  const firstTap = taps.nextInt(PUSHER.periodTicks);
  const sim = await Sim.create({ seed, mechanics: WORKER_MECHANICS, openingHeap });
  try {
    let drops = 0;
    while (drops <= MAX_DROPS) {
      const inputs: SimInput[] = [];
      if (sim.tick >= firstTap && (sim.tick - firstTap) % interval === 0) {
        inputs.push({ kind: 'dropCoin', xMm: Math.round(taps.nextRange(aim[0], aim[1])) });
        drops += 1;
      }
      if (sim.step(inputs).falls.some((fall) => fall.edge === 'front')) {
        return { drops, ticksAfterFirstTap: sim.tick - firstTap } satisfies Opening;
      }
    }
    throw new Error(`Seed ${seed} paid nothing in ${MAX_DROPS} drops every ${interval} ticks.`);
  } finally {
    sim.dispose();
  }
}

describe.each([
  { rate: '3 taps/s', interval: 20 },
  { rate: '4 taps/s', interval: 15 },
])('a new player tapping at $rate (P-436)', ({ interval }) => {
  describe.each([
    { where: 'centre', aim: CENTRE_X_MM },
    { where: 'anywhere on the rail', aim: RAIL_X_MM },
  ])('$where', ({ aim }) => {
    const runs = Promise.all(SEEDS.map((seed) => opening(seed, interval, aim)));

    it('gets a first credit within two pusher cycles of the first tap on every table', async () => {
      const slowest = Math.max(...(await runs).map((run) => run.ticksAfterFirstTap));
      expect(slowest).toBeLessThanOrEqual(PAYS_WITHIN_TICKS);
    });

    it('never gets it sooner than 3 s after the first tap, the retract-then-push floor', async () => {
      const fastest = Math.min(...(await runs).map((run) => run.ticksAfterFirstTap));
      expect(fastest).toBeGreaterThanOrEqual(PHYSICS_FLOOR_TICKS);
      expect(PHYSICS_FLOOR_TICKS).toBeGreaterThan((TARGET_DROPS - 1) * interval);
    });

    it('spends no more coins before it than it can tap in those two cycles', async () => {
      const most = Math.max(...(await runs).map((run) => run.drops));
      expect(most).toBeLessThanOrEqual(1 + Math.floor(PAYS_WITHIN_TICKS / interval));
    });
  });
});
