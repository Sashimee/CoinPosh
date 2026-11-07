import { describe, expect, it } from 'vitest';
import { alignFromRight, rollTarget, splitGlyphs, wrapDigit } from './odometerMath.ts';

describe('splitGlyphs', () => {
  it('separates digits from separators, including non-ASCII ones', () => {
    expect(splitGlyphs('1 2,5')).toEqual([
      { kind: 'digit', digit: 1 },
      { kind: 'static', char: ' ' },
      { kind: 'digit', digit: 2 },
      { kind: 'static', char: ',' },
      { kind: 'digit', digit: 5 },
    ]);
    expect(splitGlyphs('')).toEqual([]);
  });
});

describe('wrapDigit', () => {
  it('maps any turn count onto 0..9', () => {
    expect(wrapDigit(0)).toBe(0);
    expect(wrapDigit(13)).toBe(3);
    expect(wrapDigit(-1)).toBe(9);
    expect(wrapDigit(-20)).toBe(0);
  });
});

describe('rollTarget', () => {
  it('rolls forward through 9 to 0 when rising', () => {
    expect(rollTarget(9, 0, 1)).toBe(10);
    expect(rollTarget(3, 7, 1)).toBe(7);
    expect(rollTarget(7, 7, 1)).toBe(7);
  });

  it('rolls backward through 0 to 9 when falling', () => {
    expect(rollTarget(10, 9, -1)).toBe(9);
    expect(rollTarget(0, 9, -1)).toBe(-1);
    expect(rollTarget(5, 2, -1)).toBe(2);
  });

  it('starts from the nearest whole turn mid-roll', () => {
    expect(rollTarget(4.6, 6, 1)).toBe(6);
    expect(wrapDigit(rollTarget(-3, 2, 1))).toBe(2);
  });

  it('rejects anything but a single digit', () => {
    expect(() => rollTarget(0, 10, 1)).toThrow(RangeError);
    expect(() => rollTarget(0, -1, 1)).toThrow(RangeError);
    expect(() => rollTarget(0, 1.5, 1)).toThrow(RangeError);
  });
});

describe('alignFromRight', () => {
  it('keeps units aligned when a digit and separator are added', () => {
    expect(alignFromRight(splitGlyphs('999'), splitGlyphs('1,000'))).toEqual([null, null, 0, 1, 2]);
  });

  it('drops columns whose kind or separator changed', () => {
    expect(alignFromRight(splitGlyphs('1,5'), splitGlyphs('1.5'))).toEqual([0, null, 2]);
    expect(alignFromRight(splitGlyphs('12'), splitGlyphs('1M'))).toEqual([0, null]);
  });

  it('reuses columns when the number shrinks', () => {
    expect(alignFromRight(splitGlyphs('1,000'), splitGlyphs('999'))).toEqual([2, 3, 4]);
  });
});
