import { COIN_TIERS, type CoinTier } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../audio/rng.ts';
import { COMPACT_FUSION_REACH, fusionSpark, type EmitContext } from './emitters.ts';
import { FUSION_KICK_GAP_MS, FusionDirector } from './fusionJuice.ts';
import { EFFECT_JUICE } from './juice.ts';
import { createParticleBuffers, writeParticle, type ParticleSpawn } from './particles/layout.ts';
import { createAttractors, stepParticles } from './particles/physics.ts';

const COMPACT = { treatment: 'compact', hitStop: false, cameraKick: false } as const;
const FULL = { treatment: 'full', hitStop: true, cameraKick: true } as const;

/** A director that has already shown the session's first fusion, 10 s ago. */
function warmed(): FusionDirector {
  const director = new FusionDirector();
  director.select('copper', -10_000);
  return director;
}

describe('fusion juice selection', () => {
  it('gives the first fusion of the session the full treatment, whatever it makes', () => {
    for (const tier of COIN_TIERS) {
      expect(new FusionDirector().select(tier, 0)).toEqual(FULL);
    }
  });

  it('keeps routine copper and silver fusions compact, with no camera or hit-stop', () => {
    const director = warmed();
    for (let i = 0; i < 40; i++) {
      expect(director.select(i % 2 === 0 ? 'silver' : 'copper', i * 900)).toEqual(COMPACT);
    }
  });

  it.each(['gold', 'platinum', 'diamond', 'heirloom'] as const)(
    'gives a %s result the full treatment',
    (tier) => {
      expect(warmed().select(tier, 0)).toEqual(FULL);
    },
  );

  it('kicks the camera for at most one fusion per 3 s, keeping the hit-stop and ring', () => {
    const director = new FusionDirector();
    const kicks: number[] = [];
    for (let ms = 0; ms <= 10_000; ms += 500) {
      const juice = director.select('gold', ms);
      expect(juice.treatment).toBe('full');
      expect(juice.hitStop).toBe(true);
      if (juice.cameraKick) kicks.push(ms);
    }
    expect(kicks).toEqual([0, 3000, 6000, 9000]);
  });

  it('opens the window exactly at the gap, not a millisecond before', () => {
    const director = new FusionDirector();
    director.select('gold', 1000);
    expect(director.select('gold', 1000 + FUSION_KICK_GAP_MS - 1).cameraKick).toBe(false);
    expect(director.select('gold', 1000 + FUSION_KICK_GAP_MS).cameraKick).toBe(true);
  });

  it('does not let compact fusions use up or reset the kick window', () => {
    const director = new FusionDirector();
    director.select('gold', 0);
    for (let ms = 100; ms < 3000; ms += 100) director.select('silver', ms);
    expect(director.select('diamond', 3000).cameraKick).toBe(true);
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
