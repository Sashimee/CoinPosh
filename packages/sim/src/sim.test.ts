import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { COIN } from './coin.ts';
import { FIXED_DT, SOLVER, TICK_RATE_HZ } from './constants.ts';
import type { SimInput } from './inputs.ts';
import { Sim } from './sim.ts';

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
  readonly inputsAt: (tick: number) => SimInput[];
}

async function startReplay(
  seed: number,
  inputsAt: (tick: number) => SimInput[] = scriptedInputs,
): Promise<Replay> {
  return { sim: await Sim.create({ seed }), checkpoints: [], inputsAt };
}

function advance(replay: Replay, ticks: number): string[] {
  const { sim, checkpoints, inputsAt } = replay;
  while (sim.tick < ticks) {
    sim.step(inputsAt(sim.tick));
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
  it('runs the deterministic build at a fixed 60 Hz step with pinned solver settings', async () => {
    const sim = await createSim();
    expect(TICK_RATE_HZ).toBe(60);
    expect(sim.engine).toEqual({
      rapierVersion: '0.21.0',
      timestep: Math.fround(1 / 60),
      lengthUnit: Math.fround(SOLVER.lengthUnit),
      numSolverIterations: SOLVER.numSolverIterations,
      maxCcdSubsteps: SOLVER.maxCcdSubsteps,
    });
    expect(Math.fround(FIXED_DT)).toBe(sim.engine.timestep);
  });

  it('lands a dropped coin cleanly, settles it flat on the tray and lets it sleep', async () => {
    const sim = await createSim();
    sim.step([{ kind: 'dropCoin', xMm: 0 }]);
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 4 * TICK_RATE_HZ; i++) {
      sim.step();
      lowest = Math.min(lowest, sim.coins()[0]?.translation.y ?? lowest);
    }
    const [coin] = sim.coins();
    if (!coin) {
      throw new Error('the dropped coin is missing');
    }
    const { x, z } = coin.rotation;
    const faceUpY = 1 - 2 * (x * x + z * z);
    expect(coin.id).toBe(0);
    expect(lowest).toBeGreaterThan(COIN.halfThickness - 0.0002);
    expect(coin.translation.y).toBeCloseTo(COIN.halfThickness, 3);
    expect(faceUpY).toBeGreaterThan(0.9999);
    expect(coin.sleeping).toBe(true);
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
    // the change. Update it only alongside a deliberate sim version bump.
    expect(checkpoints.at(-1)).toMatchInlineSnapshot(`"9a92b6f80b23ac96"`);
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
