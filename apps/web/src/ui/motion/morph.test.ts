import { describe, expect, it } from 'vitest';
import { morphFrame } from './morph.ts';

const trigger = { left: 300, top: 780, width: 60, height: 40 };
const panel = { left: 0, top: 400, width: 390, height: 444 };

describe('morphFrame', () => {
  it('sits exactly on the trigger at progress 0 with content hidden', () => {
    const frame = morphFrame(trigger, panel, 0);
    expect(frame.translateX).toBe(300);
    expect(frame.translateY).toBe(380);
    expect(frame.scaleX).toBeCloseTo(60 / 390);
    expect(frame.scaleY).toBeCloseTo(40 / 444);
    expect(frame.content).toBe(0);
  });

  it('rests as the identity transform at progress 1 with content shown', () => {
    expect(morphFrame(trigger, panel, 1)).toEqual({
      translateX: 0,
      translateY: 0,
      scaleX: 1,
      scaleY: 1,
      content: 1,
    });
  });

  it('keeps content hidden early and clamps it through spring overshoot', () => {
    expect(morphFrame(trigger, panel, 0.3).content).toBe(0);
    const mid = morphFrame(trigger, panel, 0.6).content;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(morphFrame(trigger, panel, 1.15).content).toBe(1);
    expect(morphFrame(trigger, panel, -0.1).content).toBe(0);
  });

  it('does not divide by a zero-sized target', () => {
    const frame = morphFrame(trigger, { left: 0, top: 0, width: 0, height: 0 }, 0.5);
    expect(frame.scaleX).toBe(1);
    expect(frame.scaleY).toBe(1);
  });
});
