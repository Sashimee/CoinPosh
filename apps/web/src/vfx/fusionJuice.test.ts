import { COIN_TIERS, type CoinTier } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../audio/rng.ts';
import {
  COMPACT_FUSION_REACH,
  FULL_FUSION_REACH,
  fusionImpact,
  fusionSpark,
  type EmitContext,
} from './emitters.ts';
import {
  FUSION_FULL_FROM,
  FUSION_FULL_GAP_MS,
  FUSION_FULL_PER_WINDOW,
  FUSION_FULL_SPACING_MS,
  FUSION_FULL_WINDOW_MS,
  FUSION_MID_FROM,
  FUSION_MID_GAP_MS,
  FusionDirector,
  type FusionTreatment,
} from './fusionJuice.ts';
import { EFFECT_JUICE } from './juice.ts';
import { createParticleBuffers, writeParticle, type ParticleSpawn } from './particles/layout.ts';
import { createAttractors, stepParticles } from './particles/physics.ts';

const rank = (tier: CoinTier): number => COIN_TIERS.indexOf(tier);
const LOW_TIERS = COIN_TIERS.slice(0, rank(FUSION_MID_FROM));
const MID_TIERS = COIN_TIERS.slice(rank(FUSION_MID_FROM), rank(FUSION_FULL_FROM));
const RARE_TIERS = COIN_TIERS.slice(rank(FUSION_FULL_FROM));

/** A director whose session has already celebrated every tier, long ago. */
function seasoned(): { director: FusionDirector; start: number } {
  const director = new FusionDirector();
  let ms = 0;
  for (const tier of COIN_TIERS) {
    while (director.select(tier, ms).treatment !== 'full') ms += FUSION_FULL_SPACING_MS;
    ms += FUSION_FULL_WINDOW_MS;
  }
  return { director, start: ms + FUSION_FULL_WINDOW_MS };
}

/**
 * A held pour on a gold-rich table: a fusion every 0.35 to 1.2 s (P-400 measured about 76 a
 * minute while holding), most of them making gold, with silver, platinum and the odd diamond.
 */
function goldRichPour(seed: number, seconds = 30): { tier: CoinTier; ms: number }[] {
  const rng = createRng(seed);
  const pour: { tier: CoinTier; ms: number }[] = [];
  for (let ms = 0; ms < seconds * 1000; ms += 350 + rng() * 850) {
    const roll = rng();
    const tier: CoinTier =
      roll < 0.2 ? 'silver' : roll < 0.84 ? 'gold' : roll < 0.97 ? 'platinum' : 'diamond';
    pour.push({ tier, ms });
  }
  return pour;
}

describe('fusion juice selection', () => {
  it('splits the tiers: copper and silver compact, gold and platinum mid, diamond up rare', () => {
    expect(LOW_TIERS).toEqual(['copper', 'silver']);
    expect(MID_TIERS).toEqual(['gold', 'platinum']);
    expect(RARE_TIERS).toEqual(['diamond', 'heirloom']);
  });

  it.each(COIN_TIERS)('plays the first fusion of the session in full, even a %s one', (tier) => {
    expect(new FusionDirector().select(tier, 0)).toEqual({
      treatment: 'full',
      hitStop: true,
      reason: 'milestone',
    });
  });

  it('plays the first time each tier is reached in full, inside the 20 s cap', () => {
    const director = new FusionDirector();
    expect(director.select('silver', 0).treatment).toBe('full');
    expect(director.select('silver', 4000).treatment).toBe('compact');
    const gold = director.select('gold', 5000);
    expect(gold).toEqual({ treatment: 'full', hitStop: true, reason: 'milestone' });
    expect(director.select('gold', 9000).treatment).toBe('mid');
  });

  it('keeps routine copper and silver compact, with no camera or hit-stop', () => {
    const { director, start } = seasoned();
    for (let i = 0; i < 40; i++) {
      const juice = director.select(i % 2 === 0 ? 'silver' : 'copper', start + i * 4000);
      expect(juice).toEqual({ treatment: 'compact', hitStop: false, reason: 'routine' });
    }
  });

  it.each(MID_TIERS)('plays a routine %s fusion mid: no hit-stop', (tier) => {
    const { director, start } = seasoned();
    for (let i = 0; i < 10; i++) {
      const juice = director.select(tier, start + i * 2500);
      expect(juice).toEqual({ treatment: 'mid', hitStop: false, reason: 'routine' });
    }
  });

  it.each(RARE_TIERS)('plays a routine %s in full once the 20 s cap has rested', (tier) => {
    const { director, start } = seasoned();
    expect(director.select(tier, start)).toEqual({
      treatment: 'full',
      hitStop: true,
      reason: 'rare',
    });
    expect(director.select(tier, start + FUSION_FULL_GAP_MS - 1).treatment).toBe('mid');
    expect(director.select(tier, start + FUSION_FULL_GAP_MS).treatment).toBe('full');
  });

  it('caps rare results at one full per 20 s however many land', () => {
    const { director, start } = seasoned();
    const full: number[] = [];
    for (let ms = 0; ms <= 60_000; ms += 1000) {
      const juice = director.select('diamond', start + ms);
      expect(juice.treatment).not.toBe('compact');
      if (juice.treatment === 'full') full.push(ms);
    }
    expect(full).toEqual([0, 20_000, 40_000, 60_000]);
  });

  it('counts a milestone against the cap, so a diamond right after it waits', () => {
    const director = new FusionDirector();
    expect(director.select('silver', 0).treatment).toBe('full');
    expect(director.select('diamond', 10_000)).toEqual({
      treatment: 'full',
      hitStop: true,
      reason: 'milestone',
    });
    expect(director.select('diamond', 25_000).treatment).toBe('mid');
    expect(director.select('diamond', 10_000 + FUSION_FULL_GAP_MS)).toEqual({
      treatment: 'full',
      hitStop: true,
      reason: 'rare',
    });
  });

  it('holds a first back while a full set piece rests, then plays it on the next of its tier', () => {
    const director = new FusionDirector();
    expect(director.select('silver', 0).treatment).toBe('full');
    const early = director.select('gold', FUSION_FULL_SPACING_MS - 1);
    expect(early).toEqual({ treatment: 'mid', hitStop: false, reason: 'routine' });
    expect(director.select('silver', FUSION_FULL_SPACING_MS).treatment).toBe('compact');
    expect(director.select('gold', FUSION_FULL_SPACING_MS + 100)).toEqual({
      treatment: 'full',
      hitStop: true,
      reason: 'milestone',
    });
  });

  it('allows no more than two full set pieces in any 30 s, even when every tier is new', () => {
    const director = new FusionDirector();
    const full: number[] = [];
    for (let ms = 0; ms < 90_000; ms += 500) {
      const tier = COIN_TIERS[Math.min(COIN_TIERS.length - 1, Math.floor(ms / 4000))] ?? 'gold';
      if (director.select(tier, ms).treatment === 'full') full.push(ms);
    }
    for (const at of full) {
      expect(
        full.filter((t) => t >= at && t < at + FUSION_FULL_WINDOW_MS).length,
      ).toBeLessThanOrEqual(FUSION_FULL_PER_WINDOW);
    }
    for (let i = 1; i < full.length; i++) {
      expect((full[i] ?? 0) - (full[i - 1] ?? 0)).toBeGreaterThanOrEqual(FUSION_FULL_SPACING_MS);
    }
    expect(full.length).toBeGreaterThanOrEqual(3);
  });

  it.each([1, 7, 42, 182, 2026])(
    'plays at most 2 full set pieces in seeded 30 s gold-rich pour %i, fresh or seasoned',
    (seed) => {
      const pour = goldRichPour(seed);
      expect(pour.length).toBeGreaterThan(30);
      expect(pour.filter((f) => f.tier === 'gold').length).toBeGreaterThan(pour.length * 0.45);
      const fresh = new FusionDirector();
      const { director, start } = seasoned();
      const plays = (d: FusionDirector, offset: number): Record<FusionTreatment, number> => {
        const counts: Record<FusionTreatment, number> = { full: 0, mid: 0, compact: 0 };
        for (const { tier, ms } of pour) counts[d.select(tier, offset + ms).treatment]++;
        return counts;
      };
      const first = plays(fresh, 0);
      const later = plays(director, start);
      expect(first.full).toBeGreaterThanOrEqual(1);
      expect(first.full).toBeLessThanOrEqual(2);
      expect(later.full).toBeLessThanOrEqual(2);
      expect(later.mid).toBeGreaterThan(later.full);
    },
  );

  it('turns back-to-back mids into compact flashes so a fusion chain does not strobe', () => {
    const { director, start } = seasoned();
    expect(director.select('gold', start).treatment).toBe('mid');
    expect(director.select('platinum', start + FUSION_MID_GAP_MS - 1)).toEqual({
      treatment: 'compact',
      hitStop: false,
      reason: 'resting',
    });
    expect(director.select('gold', start + FUSION_MID_GAP_MS).treatment).toBe('mid');
  });

  it('does not let compact or mid fusions use up or reset the full cap', () => {
    const { director, start } = seasoned();
    director.select('diamond', start);
    for (let ms = 100; ms < FUSION_FULL_GAP_MS; ms += 100) {
      director.select(ms % 300 ? 'silver' : 'gold', start + ms);
    }
    expect(director.select('heirloom', start + FUSION_FULL_GAP_MS).treatment).toBe('full');
  });

  it('rejects an unknown tier, a broken clock or one that runs backwards', () => {
    expect(() => new FusionDirector().select('tin' as CoinTier, 0)).toThrow(RangeError);
    expect(() => new FusionDirector().select('gold', Number.NaN)).toThrow(RangeError);
    const director = new FusionDirector();
    director.select('gold', 1000);
    expect(() => director.select('gold', 999)).toThrow(/backwards/);
  });

  it('keeps mid and compact at 4 checklist items without sound, camera or time', () => {
    for (const effect of ['fusionMid', 'fusionCompact'] as const) {
      const { items } = EFFECT_JUICE[effect];
      expect(items.length).toBeGreaterThanOrEqual(4);
      expect(items).not.toContain('sound');
      expect(items).not.toContain('camera');
      expect(items).not.toContain('timeManipulation');
    }
    expect(EFFECT_JUICE.fusion.items).toEqual(
      expect.arrayContaining(['camera', 'timeManipulation']),
    );
  });
});

describe('fusion sparks', () => {
  const farthest = (reducedMotion: boolean, emitter = fusionSpark): number => {
    const spawns: ParticleSpawn[] = [];
    const context: EmitContext = {
      rng: createRng(4),
      quality: 'high',
      reducedMotion,
      emit: (s) => spawns.push(s),
    };
    emitter(context, [0, 0.01, 0], 'gold');
    const buffers = createParticleBuffers(spawns.length);
    spawns.forEach((s, i) => {
      writeParticle(buffers, i, s);
    });
    const env = {
      floor: { y: 0, minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
      attractors: createAttractors(),
    };
    let reach = 0;
    for (let step = 0; step < 90; step++) {
      stepParticles(buffers, spawns.length, 1 / 120, env);
      for (let i = 0; i < spawns.length; i++) {
        if ((buffers.velLife[i * 4 + 3] ?? 0) <= 0) continue;
        const x = buffers.posAge[i * 4] ?? 0;
        const z = buffers.posAge[i * 4 + 2] ?? 0;
        reach = Math.max(reach, Math.hypot(x, z));
      }
    }
    expect(spawns.length).toBeGreaterThan(0);
    return reach;
  };

  it('stay within about three coin diameters of the new coin when compact', () => {
    expect(farthest(false)).toBeLessThanOrEqual(COMPACT_FUSION_REACH);
    expect(farthest(true)).toBeLessThan(farthest(false));
  });

  it('hug the full ring instead of needling across the heap', () => {
    const full = farthest(false, fusionImpact);
    expect(full).toBeLessThanOrEqual(FULL_FUSION_REACH);
    expect(full).toBeGreaterThan(COMPACT_FUSION_REACH);
    expect(farthest(true, fusionImpact)).toBeLessThan(full);
  });
});
