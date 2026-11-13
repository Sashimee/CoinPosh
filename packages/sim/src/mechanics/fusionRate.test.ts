import { economyConfig, openingHeap } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { afterAll, describe, expect, it } from 'vitest';
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
