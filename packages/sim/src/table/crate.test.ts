import { openingHeap, rateEnvelopeDerivation } from '@coinposh/economy';
import { COIN_TIERS, MAX_SNAPSHOT_CRATES } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { TICK_RATE_HZ } from '../constants.ts';
import { MAX_CRATE_OFFSET_MM, type SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { Xoshiro128ss } from '../prng.ts';
import { type CrateState, Sim } from '../sim.ts';
import { PLAYFIELD, PUSHER } from './layout.ts';
import { CRATE_MAX_X, type CrateFallEvent, type CrateImpactEvent } from './table.ts';
import { CRATE_BODY } from './tuning.ts';

/** Tiers with no fusion and no tower: the Demo table on its own. */
const DEMO_MECHANICS: MechanicsConfig<string> = { tiers: COIN_TIERS, fusion: null, tower: null };
/** A Demo heap whose crate rides the upper tier, steps down and is pushed off in about 8 s. */
const RIDE_SEED = 1;
const SETTLE_TICKS = 10 * TICK_RATE_HZ;
const DROP_EVERY_TICKS = 2 * TICK_RATE_HZ;
const MAX_RIDE_TICKS = rateEnvelopeDerivation.crateFallSeconds.max * TICK_RATE_HZ;
const HALF = CRATE_BODY.size / 2;

async function demoSim(seed: number = RIDE_SEED): Promise<Sim> {
  return Sim.create({ seed, mechanics: DEMO_MECHANICS, openingHeap });
}

function settle(sim: Sim): void {
  while (sim.tick < SETTLE_TICKS) {
    sim.step();
  }
}

interface CrateRide {
  readonly fall: CrateFallEvent;
  readonly impacts: readonly CrateImpactEvent[];
  /** Its pose on every tick of the ride, up to the one before it fell. */
  readonly poses: readonly CrateState[];
  readonly hashes: readonly string[];
  readonly coinFalls: number;
}

/** The settled Demo table, a crate dropped at `xMm`, then a coin every 2 s until it falls. */
async function ride(xMm: number): Promise<CrateRide> {
  const sim = await demoSim();
  try {
    settle(sim);
    const drops = Xoshiro128ss.fromSeed((RIDE_SEED ^ 0x5eed) >>> 0);
    const impacts: CrateImpactEvent[] = [];
    const poses: CrateState[] = [];
    const hashes: string[] = [];
    let coinFalls = 0;
    let events = sim.step([{ kind: 'dropCrate', xMm }]);
    for (let i = 1; events.crateFalls.length === 0 && i <= MAX_RIDE_TICKS; i++) {
      impacts.push(...events.crateImpacts);
      coinFalls += events.falls.length;
      poses.push(...sim.crates());
      if (i % TICK_RATE_HZ === 0) {
        hashes.push(sim.hash());
      }
      const inputs: SimInput[] =
        i % DROP_EVERY_TICKS === DROP_EVERY_TICKS / 2
          ? [{ kind: 'dropCoin', xMm: drops.nextInt(241) - 120 }]
          : [];
      events = sim.step(inputs);
    }
    const [fall] = events.crateFalls;
    if (fall === undefined) {
      throw new Error(
        `The crate dropped at ${xMm} mm was still on the table after the longest ride`,
      );
    }
    hashes.push(sim.hash());
    expect(sim.crateCount).toBe(0);
    expect(sim.crates()).toEqual([]);
    return { fall, impacts, poses, hashes, coinFalls };
  } finally {
    sim.dispose();
  }
}

describe('Vault Crate rigid body (P-181)', () => {
  it('lands on the upper tier, steps down and is pushed over the front lip', async () => {
    const { fall, impacts, poses, coinFalls } = await ride(0);
    const dropTick = SETTLE_TICKS + 1;
    const rideTicks = fall.tick - dropTick;

    expect(fall.edge).toBe('front');
    expect(fall.crateId).toBe(0);
    expect(rideTicks).toBeGreaterThan(rateEnvelopeDerivation.crateFallSeconds.min * TICK_RATE_HZ);
    expect(rideTicks).toBeLessThanOrEqual(MAX_RIDE_TICKS);

    const onUpperTier = poses.findIndex((pose) => pose.translation.y > PUSHER.height + HALF / 2);
    const onLowerTier = poses.findIndex((pose) => pose.translation.y < PUSHER.height);
    expect(onUpperTier).toBeGreaterThanOrEqual(0);
    expect(onLowerTier).toBeGreaterThan(onUpperTier);
    const last = poses.at(-1);
    expect(last?.translation.z).toBeGreaterThan(PLAYFIELD.fieldFrontZ);
    for (const pose of poses) {
      expect(Math.abs(pose.translation.x)).toBeLessThan(PLAYFIELD.fieldHalfWidth - HALF);
    }
    // The pile it shoves goes over with it.
    expect(coinFalls).toBeGreaterThan(0);

    const [landing] = impacts;
    expect(landing?.tick).toBeLessThan(dropTick + 10);
    expect(landing?.strength).toBeGreaterThan(CRATE_BODY.thudSpeed / CRATE_BODY.fullSpeed);
    expect(landing?.strength).toBeLessThanOrEqual(1);
    for (const impact of impacts) {
      expect(impact.crateId).toBe(0);
      expect(impact.speed).toBeGreaterThanOrEqual(CRATE_BODY.thudSpeed);
      expect(impact.strength).toBe(Math.min(1, impact.speed / CRATE_BODY.fullSpeed));
    }
    const gaps = impacts.slice(1).map((impact, i) => impact.tick - (impacts[i]?.tick ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(CRATE_BODY.cooldownTicks);
    }
  });

  it('replays a crate ride to the same hash every second, pinned', async () => {
    const [first, second] = await Promise.all([ride(0), ride(0)]);
    expect(second.hashes).toEqual(first.hashes);
    expect(second.fall).toEqual(first.fall);
    expect(new Set(first.hashes).size).toBe(first.hashes.length);
    expect(first.fall.tick).toMatchInlineSnapshot(`1108`);
    expect(first.hashes.at(-1)).toMatchInlineSnapshot(`"bfc338cd646f5fbe"`);
  });

  it('keeps the hashes of a table that never held a crate', async () => {
    const [plain, other] = await Promise.all([demoSim(), demoSim()]);
    try {
      settle(plain);
      settle(other);
      expect(plain.hash()).toBe(other.hash());
      other.step([{ kind: 'dropCrate', xMm: 0 }]);
      plain.step();
      expect(other.hash()).not.toBe(plain.hash());
    } finally {
      plain.dispose();
      other.dispose();
    }
  });

  it('shoves a crate on a forward nudge', async () => {
    const [still, nudged] = await Promise.all([demoSim(), demoSim()]);
    try {
      for (const sim of [still, nudged]) {
        settle(sim);
        sim.step([{ kind: 'dropCrate', xMm: 0 }]);
        for (let i = 0; i < TICK_RATE_HZ; i++) {
          sim.step();
        }
      }
      expect(nudged.crates()).toEqual(still.crates());
      nudged.step([{ kind: 'nudge', direction: 'forward' }]);
      still.step();
      const [a] = still.crates();
      const [b] = nudged.crates();
      if (a === undefined || b === undefined) {
        throw new Error('The crate fell before the nudge; drop it where it rides longer');
      }
      expect(b.translation.z - a.translation.z).toBeGreaterThan(0.0005);
    } finally {
      still.dispose();
      nudged.dispose();
    }
  });

  it('keeps every drop position inside the guide walls', () => {
    expect(MAX_CRATE_OFFSET_MM / 1000).toBeLessThanOrEqual(CRATE_MAX_X);
  });

  it('rejects malformed crate drops, applying nothing', async () => {
    const sim = await Sim.create({ seed: 7 });
    try {
      const before = sim.hash();
      const attempts: [SimInput[], RegExp][] = [
        [
          [{ kind: 'dropCrate', xMm: MAX_CRATE_OFFSET_MM + 1 }],
          /Tick 0: dropCrate.xMm must be an integer in \[-120, 120\], got 121/,
        ],
        [[{ kind: 'dropCrate', xMm: -MAX_CRATE_OFFSET_MM - 1 }], /got -121/],
        [[{ kind: 'dropCrate', xMm: 0.5 }], /got 0.5/],
        [[{ kind: 'dropCrate', xMm: Number.POSITIVE_INFINITY }], /got Infinity/],
        [
          [
            { kind: 'dropCoin', xMm: 0 },
            { kind: 'dropCrate', xMm: Number.NaN },
          ],
          /got NaN/,
        ],
      ];
      for (const [inputs, error] of attempts) {
        expect(() => {
          sim.step(inputs);
        }).toThrow(error);
      }
      expect(sim.tick).toBe(0);
      expect(sim.coinCount).toBe(0);
      expect(sim.crateCount).toBe(0);
      expect(sim.hash()).toBe(before);
    } finally {
      sim.dispose();
    }
  });

  it('holds as many crates as a stored table snapshot', () => {
    expect(CRATE_BODY.maxOnTable).toBe(MAX_SNAPSHOT_CRATES);
  });

  it('refuses a snapshot while a crate is on the table, and takes one after it falls', async () => {
    const sim = await demoSim();
    try {
      settle(sim);
      sim.step([{ kind: 'dropCrate', xMm: 0 }]);
      const before = sim.hash();
      expect(() => sim.snapshot()).toThrow(
        /Sim.snapshot: tick 601 has 1 crates on the table, which a snapshot cannot hold/,
      );
      expect(sim.hash()).toBe(before);
      const drops = Xoshiro128ss.fromSeed((RIDE_SEED ^ 0x5eed) >>> 0);
      for (let i = 1; sim.crateCount > 0 && i <= MAX_RIDE_TICKS; i++) {
        sim.step(
          i % DROP_EVERY_TICKS === DROP_EVERY_TICKS / 2
            ? [{ kind: 'dropCoin', xMm: drops.nextInt(241) - 120 }]
            : [],
        );
      }
      expect(sim.crateCount).toBe(0);
      expect(sim.snapshot().coins.length).toBe(sim.coinCount);
    } finally {
      sim.dispose();
    }
  });

  it('accepts crates at the edge of the range and holds at most maxOnTable', async () => {
    const sim = await Sim.create({ seed: 7 });
    try {
      const full: SimInput[] = Array.from({ length: CRATE_BODY.maxOnTable }, (_, i) => ({
        kind: 'dropCrate',
        xMm: i % 2 === 0 ? -MAX_CRATE_OFFSET_MM : MAX_CRATE_OFFSET_MM,
      }));
      expect(() => sim.step([...full, { kind: 'dropCrate', xMm: 0 }])).toThrow(
        /holds 0 crates and takes at most 16/,
      );
      expect(sim.tick).toBe(0);
      expect(sim.crateCount).toBe(0);
      sim.step(full);
      expect(sim.crateCount).toBe(CRATE_BODY.maxOnTable);
      expect(sim.crates().map((crate) => crate.id)).toEqual(full.map((_, i) => i));
      const before = sim.hash();
      expect(() => sim.step([{ kind: 'dropCrate', xMm: 0 }])).toThrow(
        /holds 16 crates and takes at most 16/,
      );
      expect(sim.tick).toBe(1);
      expect(sim.hash()).toBe(before);
    } finally {
      sim.dispose();
    }
  });
});
