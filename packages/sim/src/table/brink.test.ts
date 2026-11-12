import { economyConfig, openingHeap } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { TICK_RATE_HZ } from '../constants.ts';
import type { SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { type CoinState, Sim } from '../sim.ts';
import type { FallEvent } from './table.ts';
import { PLAYFIELD, PUSHER } from './layout.ts';

/** The Demo table's seed (apps/web main.ts TABLE_SEED), then two more tables with the same heap. */
const DEMO_SEED = 0xc0196051;
const OTHER_SEEDS = [1, 2];
/** The sim worker's mechanics (apps/web simWorker/table-config.ts): fusion on, no tower. */
const WORKER_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};
const IDLE_TICKS = 30 * TICK_RATE_HZ;
const DROP_TICK = 2 * TICK_RATE_HZ;
const DROP_WINDOW_TICKS = 5 * TICK_RATE_HZ;
const MIN_BRINK_COINS = 3;

/** Lower-tier coins whose centre lies within one coin radius of the front lip. */
function atTheBrink(coins: readonly CoinState[]): number {
  return coins.filter(
    (coin) =>
      coin.translation.y < PUSHER.height &&
      Math.abs(coin.translation.z - PLAYFIELD.fieldFrontZ) <= COIN.radius,
  ).length;
}

interface BrinkRun {
  readonly falls: readonly FallEvent[];
  readonly fusions: number;
  /** The fewest coins at the brink on any tick. */
  readonly fewestAtBrink: number;
  readonly hash: string;
}

/** The Demo opening heap as the worker lays it, stepped for `ticks`, with `drops` by tick. */
async function demoTable(
  ticks: number,
  drops: ReadonlyMap<number, number> = new Map(),
  seed: number = DEMO_SEED,
): Promise<BrinkRun> {
  const sim = await Sim.create({ seed, mechanics: WORKER_MECHANICS, openingHeap });
  try {
    const falls: FallEvent[] = [];
    let fusions = 0;
    let fewestAtBrink = atTheBrink(sim.coins());
    while (sim.tick < ticks) {
      const xMm = drops.get(sim.tick);
      const inputs: SimInput[] = xMm === undefined ? [] : [{ kind: 'dropCoin', xMm }];
      const events = sim.step(inputs);
      falls.push(...events.falls);
      fusions += events.mechanics.filter((event) => event.kind === 'fusion').length;
      fewestAtBrink = Math.min(fewestAtBrink, atTheBrink(sim.coins()));
    }
    return { falls, fusions, fewestAtBrink, hash: sim.hash() };
  } finally {
    sim.dispose();
  }
}

describe('the Demo opening heap rests at the brink (P-258)', () => {
  const idle = demoTable(IDLE_TICKS);
  const dropped = demoTable(DROP_TICK + DROP_WINDOW_TICKS, new Map([[DROP_TICK, 0]]));

  it('pays nothing and fuses nothing for 30 s with nobody playing', async () => {
    const { falls, fusions } = await idle;
    expect(falls, JSON.stringify(falls)).toEqual([]);
    expect(fusions).toBe(0);
  });

  it(`keeps at least ${MIN_BRINK_COINS} coins hanging at the lip on every tick of those 30 s`, async () => {
    const { fewestAtBrink } = await idle;
    expect(fewestAtBrink).toBeGreaterThanOrEqual(MIN_BRINK_COINS);
  });

  it('tips heap coins over the front within 5 s of a single centre drop at 2 s', async () => {
    const { falls } = await dropped;
    const front = falls.filter((fall) => fall.edge === 'front');
    expect(front.length, JSON.stringify(falls)).toBeGreaterThanOrEqual(1);
    expect(falls.every((fall) => fall.tick > DROP_TICK)).toBe(true);
    expect(front.every((fall) => fall.coinId < openingHeap.coins)).toBe(true);
  });

  it.each(OTHER_SEEDS)('rests the same heap at the brink on seed %i too', async (seed) => {
    const { falls, fusions, fewestAtBrink } = await demoTable(IDLE_TICKS, new Map(), seed);
    expect(falls, JSON.stringify(falls)).toEqual([]);
    expect(fusions).toBe(0);
    expect(fewestAtBrink).toBeGreaterThanOrEqual(MIN_BRINK_COINS);
  });

  it('replays both runs to the same hash and pins them', async () => {
    const [again, droppedAgain] = await Promise.all([
      demoTable(IDLE_TICKS),
      demoTable(DROP_TICK + DROP_WINDOW_TICKS, new Map([[DROP_TICK, 0]])),
    ]);
    expect(again.hash).toBe((await idle).hash);
    expect(droppedAgain.hash).toBe((await dropped).hash);
    // Changing these values breaks replay audits of every input log recorded before the
    // change. Update them only alongside a deliberate sim version bump.
    expect((await idle).hash).toMatchInlineSnapshot(`"fdccb1a574c9357a"`);
    expect((await dropped).hash).toMatchInlineSnapshot(`"819ef376edaf2fbe"`);
  });
});
