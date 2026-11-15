import { PRIZE_FAMILIES } from '@coinposh/shared';
import { afterAll, bench, describe } from 'vitest';
import { TICK_RATE_HZ } from '../../constants.ts';
import { Xoshiro128ss } from '../../prng.ts';
import { Sim } from '../../sim.ts';
import { validateSnapshot } from '../../snapshot/validate.ts';
import type { AnyPropSpec } from '../index.ts';
import { prizeSpec } from './index.ts';

/**
 * What four prizes add to a tick of the 250-coin table, against the 'no props' row of
 * props.bench.ts: the table is played to 250 coins as there, then laid again twice from
 * its snapshot, once bare and once with a prize of each family dropped onto the upper tier
 * by the backboard, where they ride longest before the lip. Run with
 * `pnpm --filter @coinposh/sim exec vitest bench --run src/props/prizes`, and compare only
 * runs taken back to back on one machine (P-253 in docs/plan/STACK.lock.md). The run logs
 * how many prizes were still on the table at the end: a fallen prize costs nothing.
 */
const TARGET_COINS = 250;
const WARMUP_TICKS = 45 * TICK_RATE_HZ;
const SETTLE_TICKS = TICK_RATE_HZ;
/** Ten seconds of table a row: the prizes ride the upper tier for some twenty. */
const RUN = { time: 0, iterations: 10 * TICK_RATE_HZ } as const;
const SEED = 0xbe7c4;
const HALF = Math.sqrt(0.5);
/** A quarter turn about y, so a long prize lies across the table. */
const ACROSS = { x: 0, y: HALF, z: 0, w: HALF } as const;
const UPRIGHT = { x: 0, y: 0, z: 0, w: 1 } as const;

const PRIZES: readonly AnyPropSpec[] = PRIZE_FAMILIES.map((family, i) =>
  prizeSpec(family, i + 1, {
    translation: { x: -0.12 + 0.08 * i, y: 0.11, z: -0.2 },
    rotation: family === 'watch' || family === 'carKeys' ? ACROSS : UPRIGHT,
  }),
);

function stepper(sim: Sim): () => void {
  const rng = Xoshiro128ss.fromSeed(SEED);
  return () => {
    sim.step(
      sim.coinCount < TARGET_COINS ? [{ kind: 'dropCoin', xMm: rng.nextInt(301) - 150 }] : [],
    );
  };
}

const played = await Sim.create({ seed: SEED });
const play = stepper(played);
for (let i = 0; i < WARMUP_TICKS; i++) {
  play();
}
const saved = played.snapshot();
const restore = {
  pusherTickInCycle: saved.pusherTickInCycle,
  coins: validateSnapshot(saved).ok.map((pose) => ({ kind: 'pose', pose }) as const),
};
played.dispose();

async function laid(props: readonly AnyPropSpec[]): Promise<{ sim: Sim; step: () => void }> {
  const sim = await Sim.create({ seed: SEED, props, restore });
  const step = stepper(sim);
  for (let i = 0; i < SETTLE_TICKS; i++) {
    step();
  }
  return { sim, step };
}

const bare = await laid([]);
const prized = await laid(PRIZES);

afterAll(() => {
  for (const [name, { sim }] of [
    ['no props', bare],
    ['four prizes', prized],
  ] as const) {
    const onTable = sim.props().filter(({ present }) => present).length;
    console.info(`${name}: ${sim.coinCount} coins, ${onTable} prizes after ${sim.tick} ticks`);
    sim.dispose();
  }
});

describe('Sim.step with 250 coins', () => {
  bench('no props', bare.step, RUN);
  bench('a watch, a perfume, cufflinks and car keys', prized.step, RUN);
});
