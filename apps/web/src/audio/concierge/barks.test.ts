import { describe, expect, it } from 'vitest';
import { CONCIERGE_EXPRESSIONS, type ConciergeExpression } from '../../game/concierge/lines.ts';
import { PitchVariator } from '../collecting/variation.ts';
import { createRng } from '../rng.ts';
import { MIN_PITCH_STEP, PITCH_JITTER } from '../synth/impactSpec.ts';
import { VoicePriority } from '../voicePool.ts';
import { BARK_PROFILES, barkVoiceCost, buildBarkSpec, type BarkSpec } from './barks.ts';

const RATE = 48000;

function bark(expression: ConciergeExpression, seed = 1, sampleRate = RATE): BarkSpec {
  const rng = createRng(seed);
  return buildBarkSpec(expression, new PitchVariator(rng), rng, sampleRate);
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

/** The melody and rhythm of a bark with the per-play pitch and pace taken back out. */
function shape(spec: BarkSpec) {
  const base = BARK_PROFILES[spec.expression].base * spec.pitch;
  return spec.syllables.map((s) => [s.startHz / base, s.peakHz / base, s.endHz / base]);
}

describe('concierge barks', () => {
  it('has a recipe for every portrait expression and nothing else', () => {
    expect(Object.keys(BARK_PROFILES).sort()).toEqual([...CONCIERGE_EXPRESSIONS].sort());
  });

  it.each(CONCIERGE_EXPRESSIONS)('%s is a short pitched murmur at UI priority', (expression) => {
    const spec = bark(expression);
    expect(spec.expression).toBe(expression);
    expect(spec.priority).toBe(VoicePriority.ui);
    expect(spec.syllables.length).toBeGreaterThanOrEqual(1);
    expect(spec.duration).toBeGreaterThan(0.2);
    expect(spec.duration).toBeLessThan(0.7);
    for (const s of spec.syllables) {
      expect(s.startHz).toBeGreaterThan(80);
      expect(s.peakHz).toBeLessThan(400);
      expect(s.attack + s.release).toBeLessThanOrEqual(s.duration + 1e-9);
      expect(s.peakTime).toBeGreaterThanOrEqual(0);
      expect(s.peakTime).toBeLessThanOrEqual(s.duration);
      expect(s.start + s.duration).toBeLessThanOrEqual(spec.duration + 1e-9);
    }
  });

  it('gives each expression its own melody, rhythm and register', () => {
    const shapes = CONCIERGE_EXPRESSIONS.map((e) => JSON.stringify(shape(bark(e))));
    expect(new Set(shapes).size).toBe(CONCIERGE_EXPRESSIONS.length);
    const bases = CONCIERGE_EXPRESSIONS.map((e) => BARK_PROFILES[e].base);
    expect(new Set(bases).size).toBe(CONCIERGE_EXPRESSIONS.length);
  });

  it('voices pleased as a rising "mm-HM", landing above where it began', () => {
    const spec = bark('pleased');
    const opening = first(spec.syllables);
    const answer = last(spec.syllables);
    expect(answer.peakHz).toBeGreaterThan(opening.startHz * 1.25);
    expect(answer.endHz).toBeGreaterThan(opening.startHz);
    expect(spec.breath).toBeNull();
  });

  it('voices wry as a low falling "hmm" with a knowing lift at the end', () => {
    const spec = bark('wry');
    const hmm = first(spec.syllables);
    const lift = last(spec.syllables);
    expect(hmm.endHz).toBeLessThan(hmm.startHz);
    expect(lift.endHz).toBeGreaterThan(lift.startHz);
    expect(BARK_PROFILES.wry.base).toBeLessThan(BARK_PROFILES.pleased.base);
  });

  it('voices scandalised as a gasp and a trembling high "OH!" that collapses', () => {
    const spec = bark('scandalised');
    expect(spec.breath).not.toBeNull();
    const oh = first(spec.syllables);
    expect(spec.breath?.start).toBeLessThan(oh.start);
    expect(oh.peakHz).toBeGreaterThan(oh.startHz * 1.4);
    expect(last(spec.syllables).endHz).toBeLessThan(oh.peakHz);
    expect(spec.syllables.every((s) => s.vibratoDepth > 0)).toBe(true);
    const peaks = CONCIERGE_EXPRESSIONS.map((e) =>
      Math.max(...bark(e).syllables.map((s) => s.peakHz)),
    );
    expect(Math.max(...peaks)).toBe(peaks[CONCIERGE_EXPRESSIONS.indexOf('scandalised')]);
  });

  it('moves pitch by at most ±6 % and never repeats the last pitch of an expression', () => {
    for (const expression of CONCIERGE_EXPRESSIONS) {
      const rng = createRng(7);
      const variator = new PitchVariator<ConciergeExpression>(rng);
      let previous: number | null = null;
      for (let i = 0; i < 200; i++) {
        const { pitch } = buildBarkSpec(expression, variator, rng, RATE);
        expect(Math.abs(pitch - 1)).toBeLessThanOrEqual(PITCH_JITTER + 1e-9);
        if (previous !== null) {
          expect(Math.abs(pitch - previous)).toBeGreaterThanOrEqual(MIN_PITCH_STEP - 1e-9);
        }
        previous = pitch;
      }
    }
  });

  it('varies its pace from play to play while keeping the shape', () => {
    const rng = createRng(3);
    const variator = new PitchVariator<ConciergeExpression>(rng);
    const a = buildBarkSpec('wry', variator, rng, RATE);
    const b = buildBarkSpec('wry', variator, rng, RATE);
    expect(a.duration).not.toBe(b.duration);
    const round = (spec: BarkSpec) => shape(spec).map((s) => s.map((r) => r.toFixed(6)));
    expect(round(a)).toEqual(round(b));
  });

  it('is deterministic for a given seed', () => {
    for (const expression of CONCIERGE_EXPRESSIONS) {
      expect(bark(expression, 42)).toEqual(bark(expression, 42));
    }
  });

  it('keeps every formant under Nyquist on a low-rate context', () => {
    const sampleRate = 3000;
    for (const expression of CONCIERGE_EXPRESSIONS) {
      const spec = bark(expression, 1, sampleRate);
      for (const s of spec.syllables) {
        for (const f of [...s.formantsFrom, ...s.formantsTo]) {
          expect(f.frequency).toBeLessThan(sampleRate / 2);
        }
      }
      if (spec.breath) expect(spec.breath.toHz).toBeLessThan(sampleRate / 2);
    }
  });

  it('counts one source per syllable, one per vibrato and one for the breath', () => {
    expect(barkVoiceCost(bark('wry'))).toBe(2);
    expect(barkVoiceCost(bark('pleased'))).toBe(3);
    expect(barkVoiceCost(bark('scandalised'))).toBe(5);
  });

  it('rejects a context without a usable sample rate', () => {
    expect(() => bark('pleased', 1, 0)).toThrow(/positive sample rate/);
    expect(() => bark('pleased', 1, Number.NaN)).toThrow(/positive sample rate/);
  });
});
