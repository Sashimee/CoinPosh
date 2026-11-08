import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { COIN } from './coin.ts';
import { FIXED_DT, SIM_VERSION, SOLVER, TICK_RATE_HZ } from './constants.ts';
import type { SimInput } from './inputs.ts';
import { Sim } from './sim.ts';
import { DEFAULT_PUSHER_MOTION, type FallEvent, PUSHER, TABLE_SOLVER } from './table/index.ts';

const TICKS = 3600;
const HASH_INTERVAL = 300;
const SEED = 0xc0195051;

/**
 * One minute of play: a coin every 20 ticks, sweeping across the full drop range,
 * with a double drop every 100 ticks so same-tick input ordering is exercised.
 */
function scriptedInputs(tick: number): SimInput[] {
  if (tick % 20 !== 0) {
    return [];
  }
  const xMm = ((tick * 37) % 301) - 150;
  const inputs: SimInput[] = [{ kind: 'dropCoin', xMm }];
  if (tick % 100 === 0) {
    inputs.push({ kind: 'dropCoin', xMm: -xMm });
  }
  return inputs;
}

const live: Sim[] = [];

async function createSim(seed = SEED): Promise<Sim> {
  const sim = await Sim.create({ seed });
  live.push(sim);
  return sim;
}

interface Replay {
  readonly sim: Sim;
  readonly checkpoints: string[];
  readonly falls: FallEvent[];
  readonly drops: number[];
  readonly inputsAt: (tick: number) => SimInput[];
}

async function startReplay(
  seed: number,
  inputsAt: (tick: number) => SimInput[] = scriptedInputs,
): Promise<Replay> {
  return { sim: await Sim.create({ seed }), checkpoints: [], falls: [], drops: [], inputsAt };
}

function advance(replay: Replay, ticks: number): string[] {
  const { sim, checkpoints, falls, drops, inputsAt } = replay;
  while (sim.tick < ticks) {
    const inputs = inputsAt(sim.tick);
    for (const _ of inputs) {
      drops.push(sim.tick);
    }
    for (const fall of sim.step(inputs)) {
      expect(fall.tick, `coin ${fall.coinId}`).toBe(sim.tick);
      falls.push(fall);
    }
    if (sim.tick % HASH_INTERVAL === 0) {
      checkpoints.push(sim.hash());
    }
  }
  return checkpoints.slice();
}

async function run(
  seed: number,
  ticks: number,
  inputsAt: (tick: number) => SimInput[] = scriptedInputs,
): Promise<string[]> {
  const replay = await startReplay(seed, inputsAt);
  live.push(replay.sim);
  return advance(replay, ticks);
}

interface ScriptedMinute {
  readonly reference: Replay;
  readonly replica: Replay;
}

let minute: Promise<ScriptedMinute> | undefined;

/**
 * Two independent replays of the scripted minute that live for the whole file and
 * advance only as far as a test asks. Replaying the minute twice inside one test
 * overran the CI timeout on a 2-vCPU runner, so the comparison is spread over one
 * test per checkpoint rather than shortened.
 */
function scriptedMinute(): Promise<ScriptedMinute> {
  minute ??= Promise.all([startReplay(SEED), startReplay(SEED)]).then(([reference, replica]) => ({
    reference,
    replica,
  }));
  return minute;
}

async function referenceTo(ticks: number): Promise<string[]> {
  return advance((await scriptedMinute()).reference, ticks);
}

afterEach(() => {
  for (const sim of live.splice(0)) {
    sim.dispose();
  }
});

afterAll(async () => {
  if (minute) {
    const { reference, replica } = await minute;
    reference.sim.dispose();
    replica.sim.dispose();
  }
});

describe('Rapier world', () => {
  it('runs the deterministic build at a fixed 60 Hz tick with the table solver settings', async () => {
    const sim = await createSim();
    const scale = TABLE_SOLVER.worldScale;
    expect(TICK_RATE_HZ).toBe(60);
    expect(sim.engine).toEqual({
      simVersion: SIM_VERSION,
      rapierVersion: '0.21.0',
      substepTimestep: Math.fround(FIXED_DT / TABLE_SOLVER.substeps),
      substeps: TABLE_SOLVER.substeps,
      worldScale: scale,
      lengthUnit: Math.fround(TABLE_SOLVER.lengthUnit * scale),
      normalizedPredictionDistance: Math.fround(TABLE_SOLVER.normalizedPredictionDistance),
      numSolverIterations: TABLE_SOLVER.numSolverIterations,
      numInternalPgsIterations: TABLE_SOLVER.numInternalPgsIterations,
      maxCcdSubsteps: SOLVER.maxCcdSubsteps,
    });
    expect(Math.fround(sim.engine.substepTimestep * sim.engine.substeps)).toBe(
      Math.fround(FIXED_DT),
    );
  });

  it('lands a dropped coin on the upper tier without sinking and settles it flat', async () => {
    const sim = await createSim();
    sim.step([{ kind: 'dropCoin', xMm: 0 }]);
    const restY = PUSHER.height + COIN.halfThickness;
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 4 * TICK_RATE_HZ; i++) {
      sim.step();
      lowest = Math.min(lowest, sim.coins()[0]?.translation.y ?? lowest);
    }
    const [coin, ...rest] = sim.coins();
    if (!coin) {
      throw new Error('the dropped coin is missing');
    }
    const { x, z } = coin.rotation;
    const faceUpY = 1 - 2 * (x * x + z * z);
    expect(rest).toHaveLength(0);
    expect(coin.id).toBe(0);
    expect(lowest).toBeGreaterThan(restY - 0.0002);
    expect(coin.translation.y).toBeCloseTo(restY, 3);
    expect(Math.abs(coin.translation.x)).toBeLessThan(0.002);
    expect(faceUpY).toBeGreaterThan(0.9999);
  });
});

describe('determinism', () => {
  const checkpointTicks = Array.from(
    { length: TICKS / HASH_INTERVAL },
    (_, i) => (i + 1) * HASH_INTERVAL,
  );

  it.each(checkpointTicks)(
    'produces identical hashes up to tick %i for the same seed and inputs',
    async (tick) => {
      const { replica } = await scriptedMinute();
      const expected = await referenceTo(tick);
      expect(expected).toHaveLength(tick / HASH_INTERVAL);
      expect(advance(replica, tick)).toEqual(expected);
    },
  );

  it(`hashes each of the ${TICKS / HASH_INTERVAL} checkpoints distinctly`, async () => {
    const checkpoints = await referenceTo(TICKS);
    expect(checkpoints).toHaveLength(TICKS / HASH_INTERVAL);
    expect(new Set(checkpoints).size).toBe(checkpoints.length);
  });

  it('pins the final hash so engine, solver or input-handling changes are caught', async () => {
    const checkpoints = await referenceTo(TICKS);
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate SIM_VERSION bump.
    expect(SIM_VERSION).toBe(2);
    expect(checkpoints.at(-1)).toMatchInlineSnapshot(`"590da61d0e98c762"`);
  });

  it('reports the same falls, at the same ticks, on both replays of the minute', async () => {
    const { replica } = await scriptedMinute();
    await referenceTo(TICKS);
    advance(replica, TICKS);
    const { reference } = await scriptedMinute();
    expect(reference.falls.length).toBeGreaterThan(0);
    expect(replica.falls).toEqual(reference.falls);
  });

  it('stays identical when two sims are stepped interleaved in the same WASM instance', async () => {
    const expected = await referenceTo(1200);
    const a = await createSim();
    const b = await createSim();
    for (let tick = 0; tick < 1200; tick++) {
      a.step(scriptedInputs(tick));
      b.step(scriptedInputs(tick));
      if (a.tick % HASH_INTERVAL === 0) {
        const index = a.tick / HASH_INTERVAL - 1;
        expect(a.hash(), `tick ${a.tick}`).toBe(expected[index]);
        expect(b.hash(), `tick ${a.tick}`).toBe(expected[index]);
      }
    }
  });

  it('diverges for a different seed', async () => {
    const expected = await referenceTo(HASH_INTERVAL);
    const other = await run(SEED + 1, HASH_INTERVAL);
    expect(other[0]).not.toBe(expected[0]);
  });

  it('diverges from the tick a single input moves by one millimetre', async () => {
    const expected = await referenceTo(900);
    const nudged = (tick: number): SimInput[] =>
      scriptedInputs(tick).map((input, i) =>
        tick === 620 && i === 0 ? { ...input, xMm: input.xMm + 1 } : input,
      );
    expect(scriptedInputs(620)).toHaveLength(1);
    const checkpoints = await run(SEED, 900, nudged);
    expect(checkpoints.slice(0, 2)).toEqual(expected.slice(0, 2));
    expect(checkpoints[2]).not.toBe(expected[2]);
  });

  it('depends on the order of inputs within a tick', async () => {
    const a = await createSim();
    const b = await createSim();
    a.step([
      { kind: 'dropCoin', xMm: -40 },
      { kind: 'dropCoin', xMm: 40 },
    ]);
    b.step([
      { kind: 'dropCoin', xMm: 40 },
      { kind: 'dropCoin', xMm: -40 },
    ]);
    expect(b.hash()).not.toBe(a.hash());
  });
});

describe('table', () => {
  it('drives the table once per tick, removing and reporting every coin that falls on the tick it falls', async () => {
    const { reference } = await scriptedMinute();
    await referenceTo(TICKS);
    const { sim, falls, drops } = reference;
    const onTable = new Set(sim.coins().map((coin) => coin.id));
    expect(falls.length).toBeGreaterThan(0);
    expect(sim.coinCount).toBe(drops.length - falls.length);
    expect(onTable.size).toBe(sim.coinCount);
    for (const fall of falls) {
      expect(onTable.has(fall.coinId), `coin ${fall.coinId}`).toBe(false);
      expect(fall.coinId).toBeLessThan(drops.length);
      expect(fall.tick).toBeGreaterThan(drops[fall.coinId] ?? Number.POSITIVE_INFINITY);
    }
    const order = falls.map((fall) => [fall.tick, fall.coinId]);
    expect(order).toEqual(
      order.toSorted(([ta = 0, ia = 0], [tb = 0, ib = 0]) => ta - tb || ia - ib),
    );
  });

  it('sweeps the pusher one tick per step and hashes its phase', async () => {
    const a = await createSim();
    const b = await createSim();
    const start = a.pusher;
    expect(start.motion).toEqual(DEFAULT_PUSHER_MOTION);
    a.step();
    b.step();
    expect(a.pusher.frontZ).toBeGreaterThan(start.frontZ);
    expect(a.pusher).toEqual(b.pusher);
    expect(a.hash()).toBe(b.hash());
    const half = DEFAULT_PUSHER_MOTION.periodTicks / 2;
    while (a.tick < half) {
      a.step();
    }
    expect(a.pusher.frontZ).toBeGreaterThan(PUSHER.frontZ + DEFAULT_PUSHER_MOTION.stroke / 2);
  });
});

describe('Sim API', () => {
  it('counts ticks and coins, and an empty step only advances time', async () => {
    const sim = await createSim();
    const before = sim.hash();
    expect(sim.tick).toBe(0);
    expect(sim.hash()).toBe(before);
    sim.step();
    expect(sim.tick).toBe(1);
    expect(sim.coinCount).toBe(0);
    expect(sim.hash()).not.toBe(before);
    sim.step([
      { kind: 'dropCoin', xMm: 150 },
      { kind: 'dropCoin', xMm: -150 },
    ]);
    expect(sim.coinCount).toBe(2);
  });

  it('rejects malformed inputs without applying any input from that tick', async () => {
    const sim = await createSim();
    const before = sim.hash();
    const attempts: [SimInput[], RegExp][] = [
      [
        [
          { kind: 'dropCoin', xMm: 0 },
          { kind: 'dropCoin', xMm: 151 },
        ],
        /Tick 0: dropCoin.xMm must be an integer in \[-150, 150\], got 151/,
      ],
      [[{ kind: 'dropCoin', xMm: 0.5 }], /got 0.5/],
      [[{ kind: 'dropCoin', xMm: Number.NaN }], /got NaN/],
      [[{ kind: 'nudge' } as unknown as SimInput], /unknown sim input kind "nudge"/],
    ];
    for (const [inputs, error] of attempts) {
      expect(() => {
        sim.step(inputs);
      }).toThrow(error);
    }
    expect(sim.tick).toBe(0);
    expect(sim.coinCount).toBe(0);
    expect(sim.hash()).toBe(before);
  });

  it('rejects an invalid seed', async () => {
    await expect(Sim.create({ seed: -1 })).rejects.toThrow(/seed/);
    await expect(Sim.create({ seed: 0.5 })).rejects.toThrow(/seed/);
  });

  it('refuses to run after dispose', async () => {
    const sim = await Sim.create({ seed: 1 });
    sim.dispose();
    sim.dispose();
    expect(() => {
      sim.step();
    }).toThrow(/disposed/);
    expect(() => sim.hash()).toThrow(/disposed/);
  });
});
