import { COIN_TIERS, type CoinTier } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../audio/rng.ts';
import { COMPACT_FUSION_REACH, fusionSpark, type EmitContext } from './emitters.ts';
import { FUSION_FULL_FROM, FUSION_KICK_GAP_MS, FusionDirector } from './fusionJuice.ts';
import { EFFECT_JUICE } from './juice.ts';
import { createParticleBuffers, writeParticle, type ParticleSpawn } from './particles/layout.ts';
import { createAttractors, stepParticles } from './particles/physics.ts';

const COMPACT = { treatment: 'compact', hitStop: false } as const;
const FULL = { treatment: 'full', hitStop: true } as const;

const HIGH_TIERS = COIN_TIERS.slice(COIN_TIERS.indexOf(FUSION_FULL_FROM));
const LOW_TIERS = COIN_TIERS.slice(0, COIN_TIERS.indexOf(FUSION_FULL_FROM));

describe('fusion juice selection', () => {
  it('splits the tiers at gold: copper and silver below, gold to heirloom above', () => {
    expect(LOW_TIERS).toEqual(['copper', 'silver']);
    expect(HIGH_TIERS).toEqual(['gold', 'platinum', 'diamond', 'heirloom']);
  });

  it('keeps even the first fusion of the session compact when it makes copper or silver', () => {
    for (const tier of LOW_TIERS) {
      expect(new FusionDirector().select(tier, 0)).toEqual(COMPACT);
    }
  });

  it('keeps routine copper and silver fusions compact, with no camera or hit-stop', () => {
    const director = new FusionDirector();
    for (let i = 0; i < 40; i++) {
      expect(director.select(i % 2 === 0 ? 'silver' : 'copper', i * 4000)).toEqual(COMPACT);
    }
  });

  it.each(HIGH_TIERS)('gives a rested %s result the full treatment', (tier) => {
    expect(new FusionDirector().select(tier, 0)).toEqual(FULL);
  });

  it('plays at most one full fusion per 3 s; the gold ones in between go compact', () => {
    const director = new FusionDirector();
    const full: number[] = [];
    for (let ms = 0; ms <= 10_000; ms += 500) {
      const juice = director.select('gold', ms);
      expect(juice).toEqual(juice.treatment === 'full' ? FULL : COMPACT);
      if (juice.treatment === 'full') full.push(ms);
    }
    expect(full).toEqual([0, 3000, 6000, 9000]);
  });

  it('shares the window across tiers, so a diamond right after a gold stays compact', () => {
    const director = new FusionDirector();
    expect(director.select('gold', 0)).toEqual(FULL);
    expect(director.select('diamond', 1200)).toEqual(COMPACT);
    expect(director.select('heirloom', 2999)).toEqual(COMPACT);
    expect(director.select('platinum', 3000)).toEqual(FULL);
  });

  it('opens the window exactly at the gap, not a millisecond before', () => {
    const director = new FusionDirector();
    director.select('gold', 1000);
    expect(director.select('gold', 1000 + FUSION_KICK_GAP_MS - 1)).toEqual(COMPACT);
    expect(director.select('gold', 1000 + FUSION_KICK_GAP_MS)).toEqual(FULL);
  });

  it('does not let compact fusions use up or reset the window', () => {
    const director = new FusionDirector();
    director.select('gold', 0);
    for (let ms = 100; ms < 3000; ms += 100) director.select(ms % 200 ? 'silver' : 'gold', ms);
    expect(director.select('diamond', 3000)).toEqual(FULL);
  });

  it('keeps a pour of mostly silver with the odd gold to a few full beats a minute', () => {
    const director = new FusionDirector();
    let full = 0;
    for (let ms = 0; ms < 60_000; ms += 400) {
      const tier = ms % 2000 === 0 ? 'gold' : 'silver';
      if (director.select(tier, ms).treatment === 'full') full++;
    }
    expect(full).toBeLessThanOrEqual(60_000 / FUSION_KICK_GAP_MS);
    expect(full).toBeGreaterThan(0);
  });

  it('rejects an unknown tier or a broken clock', () => {
    expect(() => new FusionDirector().select('tin' as CoinTier, 0)).toThrow(RangeError);
    expect(() => new FusionDirector().select('gold', Number.NaN)).toThrow(RangeError);
  });

  it('keeps the compact variant at 4 checklist items without sound, camera or time', () => {
    const { items } = EFFECT_JUICE.fusionCompact;
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items).not.toContain('sound');
    expect(items).not.toContain('camera');
    expect(items).not.toContain('timeManipulation');
    expect(EFFECT_JUICE.fusion.items).toEqual(
      expect.arrayContaining(['camera', 'timeManipulation']),
    );
  });
});

describe('compact fusion sparks', () => {
  const farthest = (reducedMotion: boolean): number => {
    const spawns: ParticleSpawn[] = [];
    const context: EmitContext = {
      rng: createRng(4),
      quality: 'high',
      reducedMotion,
      emit: (s) => spawns.push(s),
    };
    fusionSpark(context, [0, 0.01, 0], 'silver');
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

  it('stay within about three coin diameters of the new coin', () => {
    expect(farthest(false)).toBeLessThanOrEqual(COMPACT_FUSION_REACH);
    expect(farthest(true)).toBeLessThan(farthest(false));
  });
});
