import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from './coin.ts';
import { TICK_RATE_HZ } from './constants.ts';
import type { SimInput } from './inputs.ts';
import type { FusionEvent, MechanicsConfig, UnfuseEvent } from './mechanics/index.ts';
import { UNFUSE_TUNING } from './mechanics/tuning.ts';
import { type CoinState, MAX_UNFUSE_COINS, Sim, type SimEvents } from './sim.ts';
import { quantizePosition, quantizeRotation } from './snapshot/snapshot.ts';
import { DROP_ZONE, PLAYFIELD, PUSHER } from './table/index.ts';

const SEED = 0xc0195051;

const MECHANICS: MechanicsConfig<string> = {
  tiers: ['copper', 'silver', 'gold'],
  fusion: { inputCount: 3, contactSeconds: 0.4 },
  tower: null,
};

const live: Sim[] = [];

afterEach(() => {
  for (const sim of live.splice(0)) {
    sim.dispose();
  }
});

async function createSim(options: { mechanics?: MechanicsConfig<string> | null } = {}) {
  const mechanics = options.mechanics === undefined ? MECHANICS : options.mechanics;
  const sim = await Sim.create(mechanics ? { seed: SEED, mechanics } : { seed: SEED });
  live.push(sim);
  return sim;
}

function steadyDrops(tick: number): SimInput[] {
  return tick % 12 === 0 ? [{ kind: 'dropCoin', xMm: ((tick * 13) % 81) - 40 }] : [];
}

interface Fused {
  readonly sim: Sim;
  readonly fusion: FusionEvent<string>;
  /** coins() just before the step that fused. */
  readonly before: CoinState[];
  /** The fusing step's events. */
  readonly events: SimEvents;
  /** Coins dropped on the fusing step. */
  readonly drops: number;
}

/** Drops coins on an empty table until the first fusion fires, then stops dropping. */
async function untilFusion(): Promise<Fused> {
  const sim = await createSim();
  for (let tick = 0; tick < 10 * TICK_RATE_HZ; tick++) {
    const before = sim.coins();
    const drops = steadyDrops(tick);
    const events = sim.step(drops);
    const fusion = events.mechanics.find((e): e is FusionEvent<string> => e.kind === 'fusion');
    if (fusion) {
      return { sim, fusion, before, events, drops: drops.length };
    }
  }
  throw new Error('no fusion within 10 s of steady drops');
}

function unfusedOf(events: SimEvents): UnfuseEvent[] {
  return events.mechanics.filter((e): e is UnfuseEvent => e.kind === 'unfused');
}

function tierCounts(coins: readonly CoinState[]): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const { tier } of coins) {
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  return counts;
}

function horizontal(a: Readonly<{ x: number; z: number }>, b: Readonly<{ x: number; z: number }>) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

describe('Sim.unfuse', () => {
  it('lays a 3-coin fusion back as its three coins, with their tier, where they lay', async () => {
    const { sim, fusion, before, events, drops } = await untilFusion();
    expect(fusion.ids).toHaveLength(3);
    const fused = sim.coins();
    expect(fused.find((coin) => coin.id === fusion.fusedId)?.tier).toBe(fusion.into);
    const hashBefore = sim.hash();
    sim.unfuse({ fusedId: fusion.fusedId, inputs: fusion.ids.map(() => ({ tier: fusion.tier })) });
    expect(sim.hash(), 'a queued unfuse is part of the state').not.toBe(hashBefore);

    const unfuseStep = sim.step();
    const [unfused, ...more] = unfusedOf(unfuseStep);
    expect(more).toEqual([]);
    expect(unfused).toMatchObject({
      kind: 'unfused',
      tick: sim.tick,
      fusedId: fusion.fusedId,
      removed: true,
    });
    const coinIds = unfused?.coinIds ?? [];
    expect(coinIds).toHaveLength(3);
    expect(Math.min(...coinIds)).toBeGreaterThan(fusion.fusedId);
    expect(unfuseStep.mechanics[0]).toBe(unfused);

    const after = sim.coins();
    const byId = new Map(after.map((coin) => [coin.id, coin]));
    expect(byId.has(fusion.fusedId)).toBe(false);
    const dropped = events.falls.length + unfuseStep.falls.length;
    expect(dropped).toBe(0);
    expect(sim.coinCount).toBe(before.length + drops);
    expect(after).toHaveLength(sim.coinCount);

    const counts = tierCounts(after);
    const expected = tierCounts(before);
    expected.set(fusion.tier, (expected.get(fusion.tier) ?? 0) + drops);
    expect(counts).toEqual(expected);

    const inputPoses = new Map(before.map((coin) => [coin.id, coin.translation]));
    coinIds.forEach((id, i) => {
      const coin = byId.get(id);
      const was = inputPoses.get(fusion.ids[i] ?? -1);
      if (!coin || !was) {
        throw new Error(`unfused coin ${id} or input ${i} is missing`);
      }
      expect(coin.tier).toBe(fusion.tier);
      expect(coin.sleeping).toBe(false);
      expect(horizontal(coin.translation, was), `coin ${id}`).toBeLessThan(0.01);
    });
  });

  it('keeps the laid coins from fusing again among themselves', async () => {
    const { sim, fusion } = await untilFusion();
    sim.unfuse({ fusedId: fusion.fusedId, inputs: fusion.ids.map(() => ({ tier: fusion.tier })) });
    const coinIds = new Set(unfusedOf(sim.step())[0]?.coinIds);
    expect(coinIds.size).toBe(3);
    for (let tick = 0; tick < 12 * TICK_RATE_HZ; tick++) {
      for (const event of sim.step().mechanics) {
        if (event.kind === 'fusion') {
          expect(
            event.ids.filter((id) => coinIds.has(id)),
            `tick ${event.tick}`,
          ).toEqual([]);
        }
      }
    }
    const left = sim.coins().filter((coin) => coinIds.has(coin.id));
    expect(left.map((coin) => coin.tier)).toEqual(left.map(() => fusion.tier));
  });

  it('replays to the same hash and events, twice, and pins the hash', async () => {
    const play = async () => {
      const { sim, fusion } = await untilFusion();
      sim.unfuse({
        fusedId: fusion.fusedId,
        inputs: fusion.ids.map(() => ({ tier: fusion.tier })),
      });
      const queued = sim.hash();
      const events: SimEvents[] = [];
      for (let tick = 0; tick < 3 * TICK_RATE_HZ; tick++) {
        events.push(sim.step(tick === 60 ? [{ kind: 'dropCoin', xMm: 10 }] : []));
        if (tick === 30) {
          sim.unfuse({ fusedId: 9999, inputs: [{ tier: 'copper' }, { tier: 'silver' }] });
        }
      }
      return { queued, hash: sim.hash(), events };
    };
    const first = await play();
    const second = await play();
    expect(second.queued).toBe(first.queued);
    expect(second.hash).toBe(first.hash);
    expect(second.events).toEqual(first.events);
    expect(first.events.flatMap(unfusedOf)).toHaveLength(2);
    // Changing this value breaks replay audits of every input log with an unfuse in it.
    expect(first.hash).toMatchInlineSnapshot(`"dc457f14d1feeb62"`);
  });

  it('lays coins at the given poses, lifted clear of a coin already there', async () => {
    const { sim, fusion } = await untilFusion();
    for (let tick = 0; tick < 2 * TICK_RATE_HZ; tick++) {
      sim.step();
    }
    const resting = sim.coins().find((coin) => coin.id !== fusion.fusedId);
    if (!resting) {
      throw new Error('no other coin on the table');
    }
    const pose = {
      id: 0,
      p: quantizePosition(resting.translation),
      q: quantizeRotation(resting.rotation),
      rest: 'awake' as const,
    };
    sim.unfuse({ fusedId: fusion.fusedId, inputs: [{ tier: 'copper', pose }] });
    const before = sim.coins().find((coin) => coin.id === resting.id);
    const [unfused] = unfusedOf(sim.step());
    const laid = sim.coins().find((coin) => coin.id === unfused?.coinIds[0]);
    if (!laid || !before) {
      throw new Error('the laid coin is missing');
    }
    expect(horizontal(laid.translation, before.translation)).toBeLessThan(0.003);
    expect(laid.translation.y).toBeGreaterThan(before.translation.y + COIN.halfThickness);
  });

  it('lays the coins of a fused coin that is gone at its recorded poses, and reports nothing removed', async () => {
    const { sim, fusion } = await untilFusion();
    sim.unfuse({ fusedId: fusion.fusedId, inputs: [{ tier: fusion.tier }] });
    sim.step();
    const count = sim.coinCount;
    sim.unfuse({ fusedId: fusion.fusedId, inputs: fusion.ids.map(() => ({ tier: fusion.tier })) });
    const [unfused] = unfusedOf(sim.step());
    expect(unfused?.removed).toBe(false);
    expect(unfused?.coinIds).toHaveLength(3);
    expect(sim.coinCount).toBe(count + 3);
  });

  it('spreads coins with no pose around the latest fusion site without overlapping', async () => {
    const { sim, fusion } = await untilFusion();
    sim.unfuse({ fusedId: 123_456, inputs: Array.from({ length: 5 }, () => ({ tier: 'gold' })) });
    const [unfused] = unfusedOf(sim.step());
    expect(unfused?.removed).toBe(false);
    expect(sim.coins().some((coin) => coin.id === fusion.fusedId)).toBe(true);
    const ids = new Set(unfused?.coinIds);
    const laid = sim.coins().filter((coin) => ids.has(coin.id));
    expect(laid).toHaveLength(5);
    for (const coin of laid) {
      expect(coin.tier).toBe('gold');
      expect(horizontal(coin.translation, fusion.position)).toBeLessThan(0.04);
      expect(coin.translation.z).toBeLessThan(PLAYFIELD.fieldFrontZ - COIN.radius);
      for (const other of laid) {
        if (other.id < coin.id) {
          expect(horizontal(coin.translation, other.translation)).toBeGreaterThan(
            1.9 * COIN.radius,
          );
        }
      }
    }
  });

  it('lays coins under the chute on a Sim that has seen no fusion, and they come to rest on the table', async () => {
    const sim = await createSim();
    sim.unfuse({ fusedId: 0, inputs: [{ tier: 'silver' }, { tier: 'silver' }] });
    const [unfused] = unfusedOf(sim.step());
    expect(unfused).toEqual({
      kind: 'unfused',
      tick: 1,
      fusedId: 0,
      removed: false,
      coinIds: [0, 1],
    });
    for (const coin of sim.coins()) {
      expect(coin.tier).toBe('silver');
      expect(Math.abs(coin.translation.z - DROP_ZONE.z)).toBeLessThan(0.03);
      expect(coin.translation.y).toBeGreaterThan(PUSHER.height);
    }
    for (let tick = 0; tick < 2 * TICK_RATE_HZ; tick++) {
      expect(sim.step().falls).toEqual([]);
    }
    expect(sim.coinCount).toBe(2);
  });

  it('applies queued unfuses in call order, ahead of the step inputs', async () => {
    const sim = await createSim();
    sim.unfuse({ fusedId: 3, inputs: [{ tier: 'copper' }] });
    sim.unfuse({ fusedId: 4, inputs: [{ tier: 'gold' }] });
    const events = sim.step([{ kind: 'dropCoin', xMm: 0 }]);
    expect(unfusedOf(events).map(({ fusedId, coinIds }) => [fusedId, coinIds])).toEqual([
      [3, [0]],
      [4, [1]],
    ]);
    expect(sim.coins().map((coin) => coin.tier)).toEqual(['copper', 'gold', 'copper']);
    expect(unfusedOf(sim.step())).toEqual([]);
  });

  it('refuses a malformed unfuse, queuing nothing', async () => {
    const plain = await createSim({ mechanics: null });
    expect(() => {
      plain.unfuse({ fusedId: 0, inputs: [{ tier: 'copper' }] });
    }).toThrow(/needs a Sim created with mechanics/);
    const sim = await createSim();
    const hash = sim.hash();
    const bad = [
      { fusedId: -1, inputs: [{ tier: 'copper' }] },
      { fusedId: 1.5, inputs: [{ tier: 'copper' }] },
      { fusedId: 0, inputs: [] },
      {
        fusedId: 0,
        inputs: Array.from({ length: MAX_UNFUSE_COINS + 1 }, () => ({ tier: 'copper' })),
      },
      { fusedId: 0, inputs: [{ tier: 'copper' }, { tier: 'bronze' }] },
      {
        fusedId: 0,
        inputs: [
          {
            tier: 'copper',
            pose: { id: 0, p: [0, 9_000_000, 0], q: [0, 0, 0, 32767], rest: 'awake' },
          },
        ],
      },
    ] as const;
    for (const request of bad) {
      expect(() => {
        sim.unfuse(request);
      }, JSON.stringify(request)).toThrow(RangeError);
    }
    expect(sim.hash()).toBe(hash);
    expect(unfusedOf(sim.step())).toEqual([]);
    expect(sim.coinCount).toBe(0);
  });

  it('forgets the poses of a fusion once UNFUSE_TUNING no longer keeps them', async () => {
    const { sim, fusion, before } = await untilFusion();
    const record = sim.fusionRecord(fusion.fusedId);
    expect(record?.tick).toBe(fusion.tick);
    expect(record?.position).toEqual(fusion.position);
    const inputs = new Map(before.map((coin) => [coin.id, coin.translation]));
    record?.inputs.forEach((input, i) => {
      const was = inputs.get(fusion.ids[i] ?? -1);
      if (!was) {
        throw new Error(`input ${i} was not on the table`);
      }
      expect(horizontal(input.translation, was)).toBeLessThan(0.005);
    });
    for (let tick = 1; tick < UNFUSE_TUNING.memoryTicks; tick++) {
      sim.step();
    }
    expect(sim.fusionRecord(fusion.fusedId)).toEqual(record);
    sim.step();
    expect(sim.fusionRecord(fusion.fusedId)).toBeNull();
    sim.unfuse({ fusedId: fusion.fusedId, inputs: fusion.ids.map(() => ({ tier: fusion.tier })) });
    const [unfused] = unfusedOf(sim.step());
    const ids = new Set(unfused?.coinIds);
    const laid = sim.coins().filter((coin) => ids.has(coin.id));
    expect(laid).toHaveLength(3);
    for (const coin of laid) {
      expect(coin.tier).toBe(fusion.tier);
    }
  });
});
