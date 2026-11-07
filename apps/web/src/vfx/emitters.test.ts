import { CASCADE_TIERS, COIN_TIERS } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../audio/rng.ts';
import type { QualityTier } from '../scene/quality/tiers.ts';
import {
  cascadeFizz,
  CONFETTI_COUNT,
  confetti,
  contactSparks,
  dropSwirl,
  dropTrail,
  fusionImpact,
  fusionImplosion,
  TRAIL_SPACING,
  type EmitContext,
  type ViewFrame,
} from './emitters.ts';
import { isValidSpawn, ParticleKind, type ParticleSpawn } from './particles/layout.ts';

function ctx(quality: QualityTier = 'high', reducedMotion = false, seed = 1) {
  const spawns: ParticleSpawn[] = [];
  const context: EmitContext = {
    rng: createRng(seed),
    quality,
    reducedMotion,
    emit: (s) => spawns.push(s),
  };
  return { context, spawns };
}

const view: ViewFrame = {
  origin: [0, 0.6, 0.9],
  right: [1, 0, 0],
  up: [0, 0.8, -0.6],
  forward: [0, -0.6, -0.8],
  tanHalfFov: Math.tan((40 * Math.PI) / 360),
  aspect: 9 / 16,
};

describe('emitters', () => {
  it('only produce valid spawns', () => {
    const { context, spawns } = ctx();
    dropSwirl(context, [0, 0.2, 0.1], 'gold');
    dropTrail(context, [0, 0.2, 0.1], [0, 0.05, 0.1], 'heirloom', 0);
    contactSparks(context, [0, 0, 0], 1, 'wood');
    fusionImplosion(
      context,
      [
        [0.03, 0, 0],
        [-0.03, 0, 0],
        [0, 0, 0.03],
      ],
      [0, 0.01, 0],
      2,
      'diamond',
    );
    fusionImpact(context, [0, 0.01, 0], 'heirloom');
    cascadeFizz(context, [0, 0, 0], 'obscene', 0.2);
    confetti(context, view);
    expect(spawns.length).toBeGreaterThan(1000);
    expect(spawns.every(isValidSpawn)).toBe(true);
  });

  it('space the drop trail by distance, carrying the remainder across frames', () => {
    const one = ctx();
    dropTrail(one.context, [0, 0.3, 0], [0, 0, 0], 'copper', 0);
    const sparks = one.spawns.filter((s) => s.kind === ParticleKind.Spark).length;
    expect(sparks).toBe(Math.floor(0.3 / TRAIL_SPACING));

    const split = ctx();
    let carry = 0;
    for (let i = 0; i < 30; i++) {
      carry = dropTrail(
        split.context,
        [0, 0.3 - i * 0.01, 0],
        [0, 0.29 - i * 0.01, 0],
        'copper',
        carry,
      );
    }
    const splitSparks = split.spawns.filter((s) => s.kind === ParticleKind.Spark).length;
    expect(Math.abs(splitSparks - sparks)).toBeLessThanOrEqual(1);
  });

  it('scale contact sparks with strength squared', () => {
    const soft = ctx();
    const hard = ctx();
    contactSparks(soft.context, [0, 0, 0], 0.3, 'coin');
    contactSparks(hard.context, [0, 0, 0], 1, 'coin');
    expect(hard.spawns.length).toBeGreaterThan(soft.spawns.length * 3);
    expect(() => {
      contactSparks(soft.context, [0, 0, 0], -1, 'coin');
    }).toThrow(RangeError);
  });

  it('throw sparks only into the hemisphere of the contact normal', () => {
    const { context, spawns } = ctx();
    contactSparks(context, [0, 0, 0], 1, 'metal', [1, 0, 0]);
    expect(spawns.every((s) => s.vx >= 0)).toBe(true);
  });

  it('add teak dust motes on wood only', () => {
    const wood = ctx();
    const coin = ctx();
    contactSparks(wood.context, [0, 0, 0], 0.8, 'wood');
    contactSparks(coin.context, [0, 0, 0], 0.8, 'coin');
    const motes = (s: ParticleSpawn[]) => s.filter((p) => p.kind === ParticleKind.Mote).length;
    expect(motes(wood.spawns)).toBeGreaterThan(0);
    expect(motes(coin.spawns)).toBe(0);
  });

  it('aim the fusion implosion at the leased attractor slot', () => {
    const { context, spawns } = ctx();
    fusionImplosion(
      context,
      [
        [0.03, 0, 0],
        [-0.03, 0, 0],
        [0, 0, 0.03],
      ],
      [0, 0.01, 0],
      3,
      'gold',
    );
    expect(spawns).toHaveLength(210);
    expect(spawns.every((s) => s.kind === ParticleKind.Homing && s.gravity === 3)).toBe(true);
  });

  it('grow the cascade fizz with each tier', () => {
    const counts = CASCADE_TIERS.map((tier) => {
      const { context, spawns } = ctx();
      cascadeFizz(context, [0, 0, 0], tier, 0.1);
      return spawns.length;
    });
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1] ?? 0);
  });

  it('launch the tier confetti count, with long lives, and fill the view volume', () => {
    for (const quality of ['high', 'medium', 'low'] as const) {
      const { context, spawns } = ctx(quality);
      expect(confetti(context, view)).toBe(CONFETTI_COUNT[quality]);
      expect(spawns).toHaveLength(CONFETTI_COUNT[quality]);
      expect(
        spawns.every((s) => s.kind === ParticleKind.Confetti && s.life >= 3.2 && s.life <= 4.2),
      ).toBe(true);
    }
  });

  it('cut counts with quality and again with reduced motion', () => {
    const total = (quality: QualityTier, reduced: boolean): number => {
      const { context, spawns } = ctx(quality, reduced);
      fusionImpact(context, [0, 0, 0], 'gold');
      cascadeFizz(context, [0, 0, 0], 'decadent', 0.1);
      confetti(context, view);
      return spawns.length;
    };
    expect(total('medium', false)).toBeLessThan(total('high', false));
    expect(total('low', false)).toBeLessThan(total('medium', false));
    expect(total('high', true)).toBeLessThan(total('high', false) * 0.5);
  });

  it('reduced motion swaps flying streaks for still or slow particles', () => {
    const { context, spawns } = ctx('high', true);
    dropTrail(context, [0, 0.3, 0], [0, 0, 0], 'gold', 0);
    dropSwirl(context, [0, 0.3, 0], 'gold');
    contactSparks(context, [0, 0, 0], 1, 'coin');
    expect(spawns.some((s) => s.kind === ParticleKind.Spark)).toBe(false);
    const fast = spawns.filter((s) => Math.hypot(s.vx, s.vy, s.vz) > 0.8);
    expect(fast).toHaveLength(0);
  });

  it('tint every coin tier', () => {
    for (const tier of COIN_TIERS) {
      const { context, spawns } = ctx();
      dropSwirl(context, [0, 0, 0], tier);
      expect(spawns.every((s) => s.r + s.g + s.b > 0)).toBe(true);
    }
  });

  it('are deterministic for a seed', () => {
    const a = ctx('high', false, 9);
    const b = ctx('high', false, 9);
    fusionImpact(a.context, [0, 0, 0], 'gold');
    fusionImpact(b.context, [0, 0, 0], 'gold');
    expect(a.spawns).toEqual(b.spawns);
  });
});
