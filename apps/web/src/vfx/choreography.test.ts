import { describe, expect, it } from 'vitest';
import { GlowEnvelope, MAX_GLOW, REDUCED_GLOW } from './glow.ts';
import { HAPTIC_PATTERNS, Haptics, type HapticNavigator } from './haptics.ts';
import { Timeline } from './timeline.ts';

describe('Timeline', () => {
  it('runs cues when their time arrives, in time then insertion order', () => {
    const tl = new Timeline();
    const log: string[] = [];
    tl.at(0.2, () => log.push('b'));
    tl.at(0.1, () => log.push('a'));
    tl.at(0.2, () => log.push('c'));
    tl.update(0.15);
    expect(log).toEqual(['a']);
    tl.update(0.05);
    expect(log).toEqual(['a', 'b', 'c']);
    expect(tl.pending).toBe(0);
  });

  it('stalls while effect time is frozen', () => {
    const tl = new Timeline();
    let fired = false;
    tl.at(0.1, () => (fired = true));
    for (let i = 0; i < 100; i++) tl.update(0);
    expect(fired).toBe(false);
  });

  it('lets a cue schedule a follow-up relative to now', () => {
    const tl = new Timeline();
    const log: number[] = [];
    tl.at(0.1, () => {
      tl.at(0.1, () => log.push(2));
    });
    tl.update(0.1);
    tl.update(0.05);
    expect(log).toEqual([]);
    tl.update(0.05);
    expect(log).toEqual([2]);
  });

  it('rejects negative and non-finite delays, and clear drops everything', () => {
    const tl = new Timeline();
    expect(() => {
      tl.at(-0.1, () => undefined);
    }).toThrow(RangeError);
    expect(() => {
      tl.at(Number.NaN, () => undefined);
    }).toThrow(RangeError);
    tl.at(1, () => undefined);
    tl.clear();
    expect(tl.pending).toBe(0);
  });
});

describe('GlowEnvelope', () => {
  it('peaks at the attack time and decays to rest', () => {
    const glow = new GlowEnvelope();
    glow.add({ peak: 1, attack: 0.1, release: 0.4 });
    expect(glow.update(0.1)).toBeCloseTo(1, 5);
    glow.update(0.4);
    expect(glow.value).toBe(0);
  });

  it('sums overlapping pulses under the white-out cap', () => {
    const glow = new GlowEnvelope();
    for (let i = 0; i < 5; i++) glow.add({ peak: 1, attack: 0.05, release: 0.5 });
    expect(glow.update(0.05)).toBe(MAX_GLOW);
  });

  it('halves and slows flashes under reduced motion', () => {
    const glow = new GlowEnvelope();
    glow.reducedMotion = true;
    glow.add({ peak: 2, attack: 0, release: 0.3 });
    const values: number[] = [];
    for (let i = 0; i < 60; i++) values.push(glow.update(1 / 120));
    expect(Math.max(...values)).toBeCloseTo(2 * REDUCED_GLOW.peakScale, 2);
    const firstFrame = values[0] ?? 0;
    expect(firstFrame).toBeLessThan(0.5);
  });

  it('rejects malformed pulses', () => {
    expect(() => {
      new GlowEnvelope().add({ peak: 0, attack: 0.1, release: 0.1 });
    }).toThrow(RangeError);
    expect(() => {
      new GlowEnvelope().add({ peak: 1, attack: 0.1, release: 0 });
    }).toThrow(RangeError);
  });
});

function fakeNavigator(active = true): HapticNavigator & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    userActivation: { hasBeenActive: active },
    vibrate: (pattern) => {
      calls.push(pattern);
      return true;
    },
  };
}

describe('Haptics', () => {
  it('vibrates the named pattern', () => {
    const nav = fakeNavigator();
    const haptics = new Haptics(nav, () => 0);
    expect(haptics.pulse('thud')).toBe(true);
    expect(nav.calls).toEqual([[...HAPTIC_PATTERNS.thud]]);
  });

  it('stays silent before the first user gesture, when unsupported, or disabled', () => {
    expect(new Haptics(fakeNavigator(false), () => 0).pulse('tap')).toBe(false);
    expect(new Haptics({}, () => 0).pulse('tap')).toBe(false);
    expect(new Haptics(undefined, () => 0).supported).toBe(false);
    const off = new Haptics(fakeNavigator(), () => 0);
    off.enabled = false;
    expect(off.pulse('tap')).toBe(false);
  });

  it('drops pulses that would blur into a buzz', () => {
    let now = 0;
    const nav = fakeNavigator();
    const haptics = new Haptics(nav, () => now);
    expect(haptics.pulse('tick')).toBe(true);
    now = 20;
    expect(haptics.pulse('tick')).toBe(false);
    expect(haptics.pulse('thud')).toBe(true);
    now = 50;
    expect(haptics.pulse('tick')).toBe(true);
    expect(nav.calls).toHaveLength(3);
  });
});
