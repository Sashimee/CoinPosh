import { afterAll, bench, describe } from 'vitest';
import { TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { Sim } from '../sim.ts';
import type { AnyPropSpec } from './index.ts';

/**
 * What props add to a tick of the 250-coin table in table.bench: the same played table
 * through Sim, bare and with one prop of each kind that runs every tick (a mover sweeping
 * the lower tier, a field over it and a fixed post). Run with
 * `pnpm --filter @coinposh/sim exec vitest bench --run src/props`, and compare only runs
 * taken back to back on one machine (P-253 in docs/plan/STACK.lock.md).
 */
const TARGET_COINS = 250;
const WARMUP_TICKS = 45 * TICK_RATE_HZ;
const UPRIGHT = { x: 0, y: 0, z: 0, w: 1 } as const;

const PROPS: readonly AnyPropSpec[] = [
  {
    id: 1,
    kind: 'slider',
    shape: { kind: 'box', halfExtents: { x: 0.01, y: 0.006, z: 0.01 } },
    mass: 0,
    pose: { translation: { x: 0.1, y: 0.006, z: 0.02 }, rotation: UPRIGHT },
    params: {
      friction: 0.4,
      restitution: 0.1,
      stroke: { x: -0.08, z: 0 },
      periodTicks: 240,
      phaseTicks: 0,
    },
  },
  {
    id: 2,
    kind: 'attractor',
    shape: { kind: 'cylinder', halfHeight: 0.005, radius: 0.01 },
    mass: 0,
    pose: { translation: { x: -0.06, y: 0.005, z: 0 }, rotation: UPRIGHT },
    params: { reach: 0.08, pull: 0.02, tiers: [], stirs: true },
  },
  {
    id: 3,
    kind: 'post',
    shape: { kind: 'cylinder', halfHeight: 0.01, radius: 0.004 },
    mass: 0,
    pose: { translation: { x: 0, y: 0.01, z: 0.0 }, rotation: UPRIGHT },
    params: { friction: 0.3, restitution: 0.2, bounce: true, reports: false },
  },
];

async function playedSim(props: readonly AnyPropSpec[]): Promise<{ sim: Sim; step: () => void }> {
  const sim = await Sim.create({ seed: 0xbe7c4, props });
  const rng = Xoshiro128ss.fromSeed(0xbe7c4);
  const step = (): void => {
    sim.step(
      sim.coinCount < TARGET_COINS ? [{ kind: 'dropCoin', xMm: rng.nextInt(301) - 150 }] : [],
    );
  };
  for (let i = 0; i < WARMUP_TICKS; i++) {
    step();
  }
  return { sim, step };
}

const bare = await playedSim([]);
const propped = await playedSim(PROPS);

afterAll(() => {
  for (const [name, { sim }] of [
    ['no props', bare],
    ['three props', propped],
  ] as const) {
    console.info(`${name}: ${sim.coinCount} coins after ${sim.tick} ticks`);
    sim.dispose();
  }
});

describe('Sim.step with 250 coins', () => {
  bench('no props', bare.step, { time: 10_000 });
  bench('a slider, an attractor and a post', propped.step, { time: 10_000 });
});
