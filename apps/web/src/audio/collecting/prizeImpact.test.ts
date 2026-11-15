import { PRIZE_FAMILIES, type PrizeFamily } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import {
  buildImpactSpec,
  IMPACT_VELOCITY_CEIL,
  IMPACT_VELOCITY_FLOOR,
  ImpactVariator,
  MAX_IMPACT_PAN,
  MIN_PITCH_STEP,
  PITCH_JITTER,
} from '../synth/impactSpec.ts';
import { VoicePriority } from '../voicePool.ts';
import {
  buildPrizeImpactSpec,
  followerCount,
  PRIZE_PROFILES,
  prizeVoiceCost,
  type PrizeImpactSpec,
} from './prizeImpact.ts';
import { PitchVariator } from './variation.ts';

function prize(family: PrizeFamily, speed: number, seed = 1, pan = 0): PrizeImpactSpec {
  const rng = createRng(seed);
  const spec = buildPrizeImpactSpec(family, speed, new PitchVariator(rng), rng, pan);
  if (!spec) throw new Error(`expected an audible ${family} impact at ${speed} m/s`);
  return spec;
}

const partialsOf = (spec: PrizeImpactSpec) => spec.layers.flatMap((layer) => layer.partials);

function lowEnergyShare(spec: PrizeImpactSpec, belowHz: number): number {
  const main = spec.layers[0]?.partials ?? [];
  const total = main.reduce((sum, p) => sum + p.amplitude, 0);
  return main.filter((p) => p.frequency < belowHz).reduce((sum, p) => sum + p.amplitude, 0) / total;
}

describe('prize impact velocity mapping', () => {
  it('is silent for resting contact and garbage speeds', () => {
    const rng = createRng(3);
    const variator = new PitchVariator<PrizeFamily>(rng);
    for (const speed of [0, IMPACT_VELOCITY_FLOOR * 0.9, -2, Number.NaN, Infinity]) {
      expect(buildPrizeImpactSpec('watch', speed, variator, rng)).toBeNull();
    }
  });

  it.each(PRIZE_FAMILIES)('%s gets louder, brighter and more important with speed', (family) => {
    const speeds = [0.12, 0.3, 0.8, 1.6, IMPACT_VELOCITY_CEIL];
    const specs = speeds.map((speed) => prize(family, speed));
    for (let i = 1; i < specs.length; i++) {
      const [before, after] = [specs[i - 1], specs[i]];
      if (!before || !after) throw new Error('missing spec');
      expect(after.gain).toBeGreaterThan(before.gain);
      expect(after.brightness).toBeGreaterThan(before.brightness);
      expect(after.priority).toBeGreaterThan(before.priority);
      expect(partialsOf(after).length).toBeGreaterThanOrEqual(partialsOf(before).length);
    }
  });

  it('shakes loose more secondary contacts on a harder hit', () => {
    const keys = PRIZE_PROFILES.carKeys.followers;
    if (!keys) throw new Error('car keys should jangle');
    expect(followerCount(keys, 0)).toBe(keys.minCount);
    expect(followerCount(keys, 1)).toBe(keys.maxCount);
    expect(prize('carKeys', IMPACT_VELOCITY_CEIL).layers.length).toBeGreaterThan(
      prize('carKeys', 0.12).layers.length,
    );
  });

  it('sits one band above coin hits so the coin bed never steals a prize', () => {
    for (const family of PRIZE_FAMILIES) {
      for (const speed of [0.1, 1, IMPACT_VELOCITY_CEIL]) {
        const spec = prize(family, speed);
        expect(spec.priority).toBeGreaterThanOrEqual(VoicePriority.loudImpact);
        expect(spec.priority).toBeLessThanOrEqual(VoicePriority.ui);
      }
    }
  });
});

describe('prize families', () => {
  const coinRng = createRng(1);
  const coin = buildImpactSpec(
    { material: 'coin', velocity: 1.2 },
    new ImpactVariator(coinRng),
    coinRng,
  );

  it.each(PRIZE_FAMILIES)('%s lands heavier than a coin clink at the same speed', (family) => {
    if (!coin) throw new Error('expected a coin impact');
    const spec = prize(family, 1.2);
    const lowestPrize = Math.min(...partialsOf(spec).map((p) => p.frequency));
    const lowestCoin = Math.min(...coin.partials.map((p) => p.frequency));
    expect(lowestPrize).toBeLessThan(lowestCoin / 8);
    expect(lowEnergyShare(spec, 400)).toBeGreaterThan(0.15);
  });

  it('gives the perfume bottle the longest glass ting', () => {
    const ring = (family: PrizeFamily) =>
      Math.max(...partialsOf(prize(family, IMPACT_VELOCITY_CEIL)).map((p) => p.t60));
    for (const family of PRIZE_FAMILIES.filter((f) => f !== 'perfume')) {
      expect(ring('perfume')).toBeGreaterThan(ring(family));
    }
    expect(ring('perfume')).toBeGreaterThan(1);
  });

  it('thuds the leather key fob low and dull, then jangles the keys high', () => {
    const spec = prize('carKeys', IMPACT_VELOCITY_CEIL);
    const [fob, ...keys] = spec.layers;
    if (!fob) throw new Error('missing fob layer');
    expect(fob.delay).toBe(0);
    expect(fob.transient?.filter).toBe('lowpass');
    expect(Math.max(...fob.partials.map((p) => p.frequency))).toBeLessThan(700);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      expect(key.delay).toBeGreaterThan(0);
      expect(Math.max(...key.partials.map((p) => p.frequency))).toBeGreaterThan(2000);
    }
    const keyPitches = keys.map((key) => key.partials[0]?.frequency);
    expect(new Set(keyPitches).size).toBe(keyPitches.length);
  });

  it('always clicks the second cufflink just after the first', () => {
    for (const speed of [0.1, IMPACT_VELOCITY_CEIL]) {
      const [, second] = prize('cufflinks', speed).layers;
      expect(second?.delay).toBeGreaterThanOrEqual(0.02);
      expect(second?.delay).toBeLessThan(0.06);
    }
  });

  it('lets the perfume slosh after the ting as filtered noise only', () => {
    const [, slosh] = prize('perfume', IMPACT_VELOCITY_CEIL).layers;
    expect(slosh?.partials).toHaveLength(0);
    expect(slosh?.transient?.filter).toBe('lowpass');
    expect(slosh?.delay).toBeGreaterThanOrEqual(0.04);
  });

  it('keeps every layer ordered, finite and inside the reported duration', () => {
    for (const family of PRIZE_FAMILIES) {
      const spec = prize(family, IMPACT_VELOCITY_CEIL, 9);
      const delays = spec.layers.map((layer) => layer.delay);
      expect(delays).toEqual([...delays].sort((a, b) => a - b));
      for (const layer of spec.layers) {
        for (const p of layer.partials) {
          expect(Number.isFinite(p.frequency) && p.frequency > 0).toBe(true);
          expect(layer.delay + p.t60).toBeLessThanOrEqual(spec.duration + 1e-9);
        }
      }
    }
  });

  it('costs one source per partial and per noise transient', () => {
    const spec = prize('carKeys', IMPACT_VELOCITY_CEIL);
    const expected = spec.layers.reduce(
      (sum, layer) => sum + layer.partials.length + (layer.transient ? 1 : 0),
      0,
    );
    expect(prizeVoiceCost(spec)).toBe(expected);
    expect(Number.isInteger(prizeVoiceCost(spec))).toBe(true);
  });
});

describe('prize variation', () => {
  it('jitters pitch within ±6 % and never repeats a pitch twice in a row', () => {
    const rng = createRng(11);
    const variator = new PitchVariator<PrizeFamily>(rng);
    let previous: number | null = null;
    for (let i = 0; i < 400; i++) {
      const spec = buildPrizeImpactSpec('watch', 1, variator, rng);
      if (!spec) throw new Error('expected a watch impact');
      expect(Math.abs(spec.pitch - 1)).toBeLessThanOrEqual(PITCH_JITTER + 1e-12);
      if (previous !== null) {
        expect(Math.abs(spec.pitch - previous)).toBeGreaterThanOrEqual(MIN_PITCH_STEP - 1e-12);
      }
      previous = spec.pitch;
    }
  });

  it('tracks repetition per family, so two families can share a pitch', () => {
    const variator = new PitchVariator<PrizeFamily>(() => 0.5);
    expect(variator.next('watch')).toBe(1);
    expect(variator.next('perfume')).toBe(1);
    expect(variator.next('watch')).not.toBe(1);
  });

  it('clamps pan to the mono-safe range and rejects a non-finite one', () => {
    expect(prize('watch', 1, 1, 5).pan).toBe(MAX_IMPACT_PAN);
    expect(prize('watch', 1, 1, -5).pan).toBe(-MAX_IMPACT_PAN);
    const rng = createRng(1);
    expect(() => buildPrizeImpactSpec('watch', 1, new PitchVariator(rng), rng, Number.NaN)).toThrow(
      /pan/,
    );
  });
});
