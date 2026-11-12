import { economyConfig, openingHeap } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { TICK_RATE_HZ } from '../constants.ts';
import { MAX_DROP_OFFSET_MM, type SimInput } from '../inputs.ts';
import { Xoshiro128ss } from '../prng.ts';
import { Sim } from '../sim.ts';
import type { FusionEvent, MechanicsConfig } from './mechanics.ts';

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
}

async function play(seed: number, inputsAt: (tick: number) => SimInput[], seconds: number) {
  const sim = await Sim.create({ seed, mechanics: DEMO_MECHANICS, openingHeap });
  try {
    let drops = 0;
    const fusions: FusionEvent<string>[] = [];
    for (let tick = 0; tick < seconds * TICK_RATE_HZ; tick++) {
      const inputs = inputsAt(tick);
      drops += inputs.length;
      for (const event of sim.step(inputs).mechanics) {
        if (event.kind === 'fusion') {
          fusions.push(event);
        }
      }
    }
    return { drops, fusions, hash: sim.hash() };
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
 * they fuse 3.5 times a minute, one drop in 17, the first fusion landing 8 to 46 s in.
 * One test per seed keeps each inside the CI timeout; the band is checked over all of them.
 */
describe('fusion rate at a drop a second on the Demo table', () => {
  it.each(SEEDS)('fuses for the first time within 60 s on seed %i', async (seed) => {
    const played = await session(seed);
    expect(firstFusionSeconds(played)).toBeLessThanOrEqual(60);
    for (const fusion of played.fusions) {
      expect(
        fusion.ids.every((id) => id >= openingHeap.coins),
        `fusion at ${fusion.tick}`,
      ).toBe(true);
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
    'fuses a three-copper pour at %i mm into a silver within 2 s',
    async (xMm) => {
      const { fusions } = await play(0xa1d, aimed(xMm, 3, 6), 8);
      expect(fusions).toHaveLength(1);
      expect(fusions[0]).toMatchObject({ ids: dropped(3), tier: 'copper', into: 'silver' });
      expect(fusions[0]?.tick).toBeLessThanOrEqual(2 * TICK_RATE_HZ);
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

  it('replays an aimed fusion to the same state', async () => {
    const a = await play(0xa1d, aimed(0, 5, TICK_RATE_HZ), 8);
    const b = await play(0xa1d, aimed(0, 5, TICK_RATE_HZ), 8);
    expect(b).toEqual(a);
  });
});
