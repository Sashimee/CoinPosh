import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';
import {
  buildImpactSpec,
  IMPACT_MIN_DB,
  IMPACT_VELOCITY_CEIL,
  IMPACT_VELOCITY_FLOOR,
  ImpactVariator,
  MAX_IMPACT_PAN,
  MIN_PITCH_STEP,
  PITCH_JITTER,
  strengthToBrightness,
  strengthToGain,
  velocityToStrength,
  type ImpactSpec,
} from './impactSpec.ts';
import { IMPACT_MATERIALS, MATERIAL_PROFILES, type ImpactMaterial } from './materials.ts';

function spec(material: ImpactMaterial, velocity: number, seed = 1): ImpactSpec {
  const rng = createRng(seed);
  const result = buildImpactSpec({ material, velocity }, new ImpactVariator(rng), rng);
  if (!result) throw new Error(`expected an audible impact at ${velocity} m/s`);
  return result;
}

function centroid(s: ImpactSpec): number {
  const weight = s.partials.reduce((sum, p) => sum + p.amplitude, 0);
  return s.partials.reduce((sum, p) => sum + p.frequency * p.amplitude, 0) / weight;
}

describe('velocity curves', () => {
  it('is silent below the resting-contact floor and for garbage input', () => {
    expect(velocityToStrength(0)).toBe(0);
    expect(velocityToStrength(IMPACT_VELOCITY_FLOOR * 0.99)).toBe(0);
    expect(velocityToStrength(-1)).toBe(0);
    expect(velocityToStrength(Number.NaN)).toBe(0);
    expect(velocityToStrength(Infinity)).toBe(0);
  });

  it('spans 0..1 from the floor to the ceiling and saturates above it', () => {
    expect(velocityToStrength(IMPACT_VELOCITY_FLOOR)).toBe(0);
    expect(velocityToStrength(IMPACT_VELOCITY_CEIL)).toBeCloseTo(1, 10);
    expect(velocityToStrength(IMPACT_VELOCITY_CEIL * 10)).toBe(1);
  });

  it('is logarithmic: equal velocity ratios give equal strength steps', () => {
    const a = velocityToStrength(0.1);
    const b = velocityToStrength(0.2);
    const c = velocityToStrength(0.4);
    expect(b - a).toBeCloseTo(c - b, 10);
  });

  it('maps strength to gain from the dB floor to unity, monotonically', () => {
    expect(strengthToGain(0)).toBe(0);
    expect(strengthToGain(1)).toBeCloseTo(1, 10);
    expect(20 * Math.log10(strengthToGain(1e-9))).toBeCloseTo(IMPACT_MIN_DB, 3);
    let previous = 0;
    for (let s = 0.05; s <= 1; s += 0.05) {
      const gain = strengthToGain(s);
      expect(gain).toBeGreaterThan(previous);
      previous = gain;
    }
  });

  it('keeps soft hits dull but never fully dark, and hard hits fully bright', () => {
    expect(strengthToBrightness(0)).toBeGreaterThan(0);
    expect(strengthToBrightness(1)).toBe(1);
    expect(strengthToBrightness(0.3)).toBeLessThan(strengthToBrightness(0.7));
  });
});

describe('ImpactVariator', () => {
  it('never picks the same variant twice in a row for a material', () => {
    const variator = new ImpactVariator(createRng(42));
    let last = -1;
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = variator.nextVariant('coin', 6);
      expect(v).not.toBe(last);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
      last = v;
    }
    expect(seen.size).toBe(6);
  });

  it('tracks each material independently', () => {
    const always = () => 0;
    const variator = new ImpactVariator(always);
    expect(variator.nextVariant('coin', 6)).toBe(0);
    expect(variator.nextVariant('wood', 6)).toBe(0);
    expect(variator.nextVariant('coin', 6)).toBe(1);
  });

  it('keeps a single-variant table at variant 0', () => {
    const variator = new ImpactVariator(createRng(1));
    expect(variator.nextVariant('metal', 1)).toBe(0);
    expect(variator.nextVariant('metal', 1)).toBe(0);
  });

  it('jitters pitch within ±6 % and always moves by at least the minimum step', () => {
    for (const seed of [1, 2, 3]) {
      const variator = new ImpactVariator(createRng(seed));
      let last: number | null = null;
      for (let i = 0; i < 3000; i++) {
        const pitch = variator.nextPitch('coin');
        expect(pitch).toBeGreaterThanOrEqual(1 - PITCH_JITTER - 1e-12);
        expect(pitch).toBeLessThanOrEqual(1 + PITCH_JITTER + 1e-12);
        if (last !== null)
          expect(Math.abs(pitch - last)).toBeGreaterThanOrEqual(MIN_PITCH_STEP - 1e-12);
        last = pitch;
      }
    }
  });

  it('stays in range when a repeat is forced at the edge of the jitter range', () => {
    const variator = new ImpactVariator(() => 0.9999999);
    const first = variator.nextPitch('wood');
    const second = variator.nextPitch('wood');
    expect(first).toBeCloseTo(1 + PITCH_JITTER, 5);
    expect(second).toBeCloseTo(1 + PITCH_JITTER - MIN_PITCH_STEP, 5);
  });
});

describe('buildImpactSpec', () => {
  it('returns null for a hit too soft to hear', () => {
    const rng = createRng(1);
    expect(
      buildImpactSpec({ material: 'coin', velocity: 0.01 }, new ImpactVariator(rng), rng),
    ).toBeNull();
  });

  it('gets louder, brighter and more important with velocity', () => {
    for (const material of IMPACT_MATERIALS) {
      const soft = spec(material, 0.15);
      const hard = spec(material, 2.5);
      expect(hard.gain).toBeGreaterThan(soft.gain);
      expect(hard.brightness).toBeGreaterThan(soft.brightness);
      expect(hard.priority).toBeGreaterThan(soft.priority);
      expect(hard.transient.frequency).toBeGreaterThan(soft.transient.frequency);
      expect(centroid(hard)).toBeGreaterThan(centroid(soft));
    }
  });

  it('keeps priority between the quiet and loud impact bands', () => {
    expect(spec('coin', 0.07).priority).toBeGreaterThanOrEqual(VoicePriority.quietImpact);
    expect(spec('coin', 50).priority).toBeCloseTo(VoicePriority.loudImpact, 10);
  });

  it('gives each material pair its own spectrum: wood low and short, coin high, metal long', () => {
    const coin = spec('coin', 1.5);
    const wood = spec('wood', 1.5);
    const metal = spec('metal', 1.5);
    expect(centroid(wood)).toBeLessThan(centroid(metal));
    expect(centroid(metal)).toBeLessThan(centroid(coin));
    expect(wood.duration).toBeLessThan(coin.duration);
    expect(metal.duration).toBeGreaterThan(coin.duration);
  });

  it('builds coin-on-coin from two detuned discs so the pair beats', () => {
    const coin = spec('coin', 2);
    const fundamentals = coin.partials
      .map((p) => p.frequency)
      .filter((f) => f > 1900 && f < 2900)
      .sort((a, b) => a - b);
    expect(fundamentals.length).toBeGreaterThanOrEqual(2);
    expect(MATERIAL_PROFILES.coin.bodies).toHaveLength(2);
  });

  it('culls inaudible partials on soft hits to save oscillators', () => {
    expect(spec('metal', 0.07).partials.length).toBeLessThan(spec('metal', 2.5).partials.length);
  });

  it('clamps pan to the mono-safe range', () => {
    const rng = createRng(3);
    const variator = new ImpactVariator(rng);
    expect(buildImpactSpec({ material: 'coin', velocity: 1, pan: -4 }, variator, rng)?.pan).toBe(
      -MAX_IMPACT_PAN,
    );
    expect(buildImpactSpec({ material: 'coin', velocity: 1, pan: 0.2 }, variator, rng)?.pan).toBe(
      0.2,
    );
  });

  it('never produces the same impact twice in a row from identical input', () => {
    const rng = createRng(9);
    const variator = new ImpactVariator(rng);
    let previous: ImpactSpec | null = null;
    for (let i = 0; i < 200; i++) {
      const next = buildImpactSpec({ material: 'metal', velocity: 1.2 }, variator, rng);
      expect(next).not.toBeNull();
      if (previous && next) {
        expect(next.variant).not.toBe(previous.variant);
        expect(next.pitch).not.toBe(previous.pitch);
      }
      previous = next;
    }
  });

  it('keeps every partial audible-range, finite and below Nyquist at 44.1 kHz', () => {
    for (const material of IMPACT_MATERIALS) {
      for (const velocity of [0.08, 0.5, 3]) {
        for (const p of spec(material, velocity).partials) {
          expect(Number.isFinite(p.frequency)).toBe(true);
          expect(p.frequency).toBeGreaterThan(20);
          expect(p.frequency).toBeLessThan(22050);
          expect(p.amplitude).toBeGreaterThan(0);
          expect(p.t60).toBeGreaterThan(0);
        }
      }
    }
  });
});
