import { describe, expect, it } from 'vitest';
import {
  alignFromRight,
  canCount,
  COALESCE_MS,
  OdometerTrack,
  readout,
  ROLL_MS,
  rollTarget,
  splitGlyphs,
  wheelPosition,
  wrapDigit,
  type OdometerFrame,
} from './odometerMath.ts';

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

const grouped = new Intl.NumberFormat('en-US');
const format = (value: number): string => grouped.format(value);
const shownValue = (frame: OdometerFrame): number =>
  Number(readout(frame.columns).replace(/\D/g, ''));
const digitCount = (text: string): number => text.replace(/\D/g, '').length;
const expectWellFormed = (frame: OdometerFrame): void => {
  expect(readout(frame.columns)).toBe(format(shownValue(frame)));
};
const isWhole = (frame: OdometerFrame): boolean =>
  frame.columns.every((column) => column.kind === 'static' || Number.isInteger(column.position));

describe('wheelPosition', () => {
  it('reads as the rounded value at every point of a mechanical roll', () => {
    for (let value = 0; value <= 1200; value += 0.37) {
      const text = String(Math.round(value)).padStart(4, '0');
      const wheels = [3, 2, 1, 0].map((place) =>
        wrapDigit(Math.round(wheelPosition(value, place))),
      );
      expect(wheels.join('')).toBe(text);
    }
  });

  it('turns a wheel only while the wheels below it carry', () => {
    expect(wheelPosition(52, 1)).toBe(5);
    expect(wheelPosition(58.9, 1)).toBe(5);
    expect(wheelPosition(59.25, 1)).toBeCloseTo(5.25);
    expect(wheelPosition(999.5, 3)).toBeCloseTo(0.5);
  });
});

describe('canCount', () => {
  it('counts across grouping and added leading digits', () => {
    expect(canCount(splitGlyphs('999'), splitGlyphs('1,000'))).toBe(true);
    expect(canCount(splitGlyphs('1,000'), splitGlyphs('999'))).toBe(true);
    expect(canCount(splitGlyphs('12.5K'), splitGlyphs('112.5K'))).toBe(true);
  });

  it('refuses texts on different scales', () => {
    expect(canCount(splitGlyphs('9.9K'), splitGlyphs('10K'))).toBe(false);
    expect(canCount(splitGlyphs('999'), splitGlyphs('1K'))).toBe(false);
    expect(canCount(splitGlyphs('5'), splitGlyphs('-5'))).toBe(false);
    expect(canCount(splitGlyphs(''), splitGlyphs('5'))).toBe(false);
  });
});

describe('OdometerTrack', () => {
  it('stays readable under 20 credits 100 ms apart and lands within 250 ms of the last', () => {
    const track = new OdometerTrack();
    const credits = Array.from({ length: 20 }, (_, i) => ({
      at: i * 100,
      amount: 3 + (i % 4) * 7,
    }));
    const history: { at: number; balance: number }[] = [{ at: -Infinity, balance: 880 }];
    const balanceAt = (ms: number): number =>
      history.filter((entry) => entry.at <= ms).at(-1)?.balance ?? 880;
    track.jump(format(880));
    let next = 0;
    let lastShown = 880;
    for (let now = 0; now <= 1900 + 250; now += 10) {
      for (const credit of credits) {
        if (credit.at !== now) continue;
        const previous = balanceAt(now);
        history.push({ at: now, balance: previous + credit.amount });
        track.push(format(previous + credit.amount), 1, now, false);
      }
      const frame = track.sample(now);
      const shown = shownValue(frame);
      expectWellFormed(frame);
      expect(shown).toBeGreaterThanOrEqual(lastShown);
      lastShown = shown;
      if (now === next) {
        next += 300;
        const low = balanceAt(now - 250);
        const high = balanceAt(now);
        expect(shown).toBeGreaterThanOrEqual(low);
        expect(shown).toBeLessThanOrEqual(high);
        expect(digitCount(readout(frame.columns))).toBeGreaterThanOrEqual(digitCount(format(low)));
      }
    }
    const final = balanceAt(Infinity);
    expect(final).toBeGreaterThan(1000);
    const landed = track.sample(1900 + 250);
    expect(landed.settled).toBe(true);
    expect(isWhole(landed)).toBe(true);
    expect(readout(landed.columns)).toBe(format(final));
  });

  it('rolls only the wheels whose digit changes', () => {
    const track = new OdometerTrack();
    track.jump('1,052');
    const ids = track.sample(0).columns.map((column) => column.id);
    track.push('1,057', 1, 0, false);
    for (let now = 0; now <= ROLL_MS; now += 16) {
      const columns = track.sample(now).columns;
      expect(columns.map((column) => column.id)).toEqual(ids);
      const positions = columns.map((column) =>
        column.kind === 'digit' ? wrapDigit(column.position) : null,
      );
      expect(positions.slice(0, 4)).toEqual([1, null, 0, 5]);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe('1,057');
  });

  it('keeps a growing leading digit visible and in place', () => {
    const track = new OdometerTrack();
    track.jump('998');
    track.push('1,003', 1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 8) {
      const frame = track.sample(now);
      expect(frame.columns).toHaveLength(5);
      expectWellFormed(frame);
      const shown = shownValue(frame);
      expect(shown).toBeGreaterThanOrEqual(998);
      expect(shown).toBeLessThanOrEqual(1003);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe('1,003');
  });

  it('counts down without dipping below the new value, then drops the spare column', () => {
    const track = new OdometerTrack();
    track.jump('1,004');
    track.push('996', -1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 8) {
      const frame = track.sample(now);
      expectWellFormed(frame);
      const shown = shownValue(frame);
      expect(shown).toBeGreaterThanOrEqual(996);
      expect(shown).toBeLessThanOrEqual(1004);
    }
    const landed = track.sample(ROLL_MS);
    expect(readout(landed.columns)).toBe('996');
    expect(landed.settled).toBe(true);
  });

  it.each([
    [1000, 999],
    [100, 99],
    [10_000, 9950],
    [1000, 5],
  ])('never shows a leading zero counting down from %i to %i', (from, to) => {
    const track = new OdometerTrack();
    track.jump(format(from));
    const ids = track.sample(0).columns.map((column) => column.id);
    track.push(format(to), -1, 0, false);
    expectWellFormed(track.sample(0));
    for (let now = 0; now < ROLL_MS; now += 4) {
      const frame = track.sample(now);
      expect(frame.columns.map((column) => column.id)).toEqual(ids);
      expectWellFormed(frame);
      const shown = shownValue(frame);
      expect(shown).toBeGreaterThanOrEqual(to);
      expect(shown).toBeLessThanOrEqual(from);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe(format(to));
  });

  it.each([
    [52, 5052],
    [998, 1003],
    [999, 1000],
    [9, 12_345],
  ])('shows a new leading digit only once it reads non-zero, from %i to %i', (from, to) => {
    const track = new OdometerTrack();
    track.jump(format(from));
    track.push(format(to), 1, 0, false);
    expect(readout(track.sample(0).columns)).toBe(format(from));
    for (let now = 0; now < ROLL_MS; now += 4) {
      const frame = track.sample(now);
      expectWellFormed(frame);
      const shown = shownValue(frame);
      expect(shown).toBeGreaterThanOrEqual(from);
      expect(shown).toBeLessThanOrEqual(to);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe(format(to));
  });

  it('keeps a prefix and inner leading zeros the texts themselves show', () => {
    const track = new OdometerTrack();
    track.jump('$0.5K');
    track.push('$10.5K', 1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 4) {
      expect(readout(track.sample(now).columns)).toMatch(/^\$(0|10)\.\dK$/);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe('$10.5K');
  });

  it('coalesces changes inside the window into one landing', () => {
    const track = new OdometerTrack();
    track.jump('50');
    track.push('51', 1, 0, false);
    track.push('53', 1, COALESCE_MS - 1, false);
    expect(track.sample(ROLL_MS - 1).settled).toBe(false);
    const landed = track.sample(ROLL_MS);
    expect(landed.settled).toBe(true);
    expect(readout(landed.columns)).toBe('53');
  });

  it('starts a fresh landing for a change after the window', () => {
    const track = new OdometerTrack();
    track.jump('50');
    track.push('51', 1, 0, false);
    track.push('53', 1, COALESCE_MS, false);
    expect(track.sample(ROLL_MS).settled).toBe(false);
    expect(readout(track.sample(COALESCE_MS + ROLL_MS).columns)).toBe('53');
  });

  it('ticks whole digits on wheels that a large win would spin into a blur', () => {
    const track = new OdometerTrack();
    track.jump('52');
    track.push('5,052', 1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 8) {
      const columns = track.sample(now).columns.filter((column) => column.kind === 'digit');
      const units = columns.at(-1);
      const tens = columns.at(-2);
      expect(units?.kind === 'digit' && Number.isInteger(units.position)).toBe(true);
      expect(tens?.kind === 'digit' && Number.isInteger(tens.position)).toBe(true);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe('5,052');
  });

  it('rolls straight to a new compact scale without blanking a column', () => {
    const track = new OdometerTrack();
    track.jump('9.9K');
    track.push('10K', 1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 8) {
      const text = readout(track.sample(now).columns);
      expect(text).toMatch(/^\d\dK$/);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe('10K');
    expect(track.sample(ROLL_MS).settled).toBe(true);
  });

  it('snaps under reduced motion', () => {
    const track = new OdometerTrack();
    track.jump('52');
    track.push('1,234', 1, 0, true);
    const frame = track.sample(0);
    expect(frame.settled).toBe(true);
    expect(readout(frame.columns)).toBe('1,234');
    expect(isWhole(frame)).toBe(true);
  });

  it('ignores a push of the text it is already heading to', () => {
    const track = new OdometerTrack();
    track.jump('50');
    track.push('55', 1, 0, false);
    track.push('55', 1, 200, false);
    expect(track.sample(ROLL_MS).settled).toBe(true);
  });
});
