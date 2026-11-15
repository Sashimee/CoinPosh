import {
  COLLECTIBLE_COIN_VARIANTS,
  type CollectibleCoinVariant,
  type CoinVariant,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import { MATERIAL_PROFILES } from '../synth/materials.ts';
import { MIN_PITCH_STEP, PITCH_JITTER } from '../synth/impactSpec.ts';
import { VoicePriority } from '../voicePool.ts';
import {
  buildVariantShimmerSpec,
  isShimmeringVariant,
  shimmerVoiceCost,
  type VariantShimmerSpec,
} from './shimmer.ts';
import { PitchVariator } from './variation.ts';

const RATE = 48000;

function shimmer(variant: CoinVariant, seed = 1, sampleRate = RATE): VariantShimmerSpec | null {
  const rng = createRng(seed);
  return buildVariantShimmerSpec(variant, new PitchVariator(rng), rng, sampleRate);
}

function must(variant: CollectibleCoinVariant, seed = 1): VariantShimmerSpec {
  const spec = shimmer(variant, seed);
  if (!spec) throw new Error(`expected a ${variant} shimmer`);
  return spec;
}

const ring = (spec: VariantShimmerSpec) => Math.max(...spec.partials.map((p) => p.t60));

describe('variant shimmer', () => {
  it('stays silent for the plain strike', () => {
    expect(isShimmeringVariant('none')).toBe(false);
    expect(shimmer('none')).toBeNull();
  });

  it.each(COLLECTIBLE_COIN_VARIANTS)(
    '%s rings above the coin fundamental, at UI priority',
    (variant) => {
      const spec = must(variant);
      expect(spec.variant).toBe(variant);
      expect(spec.priority).toBe(VoicePriority.ui);
      const coinFundamental = MATERIAL_PROFILES.coin.bodies[0]?.fundamental ?? Infinity;
      for (const p of spec.partials) {
        expect(p.frequency).toBeGreaterThan(coinFundamental * 1.5);
        expect(p.delay + p.attack + p.t60).toBeLessThanOrEqual(spec.duration + 1e-9);
      }
    },
  );

  it('voices foil as a beating, rising chorus', () => {
    const spec = must('foil');
    expect(spec.partials.every((p) => p.endFrequency > p.frequency)).toBe(true);
    const [a, b] = spec.partials;
    if (!a || !b) throw new Error('foil needs a beating pair');
    const beat = Math.abs(a.frequency - b.frequency);
    expect(beat).toBeGreaterThan(5);
    expect(beat).toBeLessThan(60);
  });

  it('voices proof as a pure, still octave that rings longest', () => {
    const spec = must('proof');
    expect(spec.partials.every((p) => p.endFrequency === p.frequency && p.vibratoDepth === 0)).toBe(
      true,
    );
    const [root, octave] = spec.partials;
    expect((octave?.frequency ?? 0) / (root?.frequency ?? 1)).toBeCloseTo(2, 2);
    for (const variant of COLLECTIBLE_COIN_VARIANTS.filter((v) => v !== 'proof')) {
      expect(ring(spec)).toBeGreaterThan(ring(must(variant)));
    }
  });

  it('voices first strike as a crisp ping and a staggered sparkle', () => {
    const spec = must('firstStrike');
    expect(Math.min(...spec.partials.map((p) => p.attack))).toBeLessThanOrEqual(0.001);
    const delays = spec.partials.map((p) => p.delay);
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('voices misprint as a wobbling, sagging shimmer', () => {
    const spec = must('misprint');
    expect(spec.partials.every((p) => p.vibratoDepth > 0 && p.vibratoHz > 0)).toBe(true);
    expect(spec.partials.every((p) => p.endFrequency < p.frequency)).toBe(true);
  });

  it('counts one extra LFO source per vibrating partial', () => {
    expect(shimmerVoiceCost(must('misprint'))).toBe(must('misprint').partials.length * 2);
    expect(shimmerVoiceCost(must('proof'))).toBe(must('proof').partials.length);
  });

  it('drops partials that would alias, and plays nothing when none fit', () => {
    const narrow = shimmer('firstStrike', 1, 22050);
    expect(narrow?.partials.length).toBeLessThan(must('firstStrike').partials.length);
    for (const p of narrow?.partials ?? []) {
      expect(p.frequency).toBeLessThan(22050 / 2);
    }
    expect(shimmer('foil', 1, 8000)).toBeNull();
  });

  it('jitters pitch within ±6 % and never repeats a pitch twice in a row', () => {
    const rng = createRng(5);
    const variator = new PitchVariator<CollectibleCoinVariant>(rng);
    let previous: number | null = null;
    for (let i = 0; i < 300; i++) {
      const spec = buildVariantShimmerSpec('foil', variator, rng, RATE);
      if (!spec) throw new Error('expected a foil shimmer');
      expect(Math.abs(spec.pitch - 1)).toBeLessThanOrEqual(PITCH_JITTER + 1e-12);
      if (previous !== null) {
        expect(Math.abs(spec.pitch - previous)).toBeGreaterThanOrEqual(MIN_PITCH_STEP - 1e-12);
      }
      previous = spec.pitch;
    }
  });

  it('rejects a non-finite pan', () => {
    const rng = createRng(1);
    expect(() =>
      buildVariantShimmerSpec('proof', new PitchVariator(rng), rng, RATE, Infinity),
    ).toThrow(/pan/);
  });
});
