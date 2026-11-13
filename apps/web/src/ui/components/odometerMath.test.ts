import { describe, expect, it } from 'vitest';
import { createRng } from '../../audio/rng.ts';
import { LANGUAGES, type Language } from '../../i18n/core.ts';
import { COMPACT_BALANCE_FROM, formatBalance } from '../../i18n/format.ts';
import {
  alignFromRight,
  canCount,
  COALESCE_MS,
  OdometerTrack,
  readout,
  ROLL_MS,
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

interface Reading {
  /** The balance the text names, at the middle of the range it rounds from. */
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

/**
 * Reads a balance plaque text back as the balances it can stand for, or null when no balance
 * formats to it (a leading zero, a missing digit, a wrong suffix).
 */
const readBalance = (text: string, language: Language): Reading | null => {
  const numeric = /^[\d.,\u00a0\u202f ]*\d/.exec(text)?.[0] ?? '';
  if (numeric === '') return null;
  const suffix = text.slice(numeric.length);
  if (suffix === '') {
    const value = Number(numeric.replace(/\D/g, ''));
    return formatBalance(value, language) === text ? { value, low: value, high: value } : null;
  }
  const scale = [1e6, 1e9].find(
    (unit) => formatBalance(unit, language).replace(/^[\d.,]+/, '') === suffix,
  );
  if (scale === undefined) return null;
  const decimal =
    new Intl.NumberFormat(language).formatToParts(1.5).find((part) => part.type === 'decimal')
      ?.value ?? '.';
  const [whole = '', fraction = ''] = numeric.split(decimal);
  const step = scale / 10 ** fraction.length;
  const value = Number(`${whole}${fraction}`) * step;
  if (formatBalance(value, language) !== text) return null;
  return { value, low: value - step / 2, high: value + step / 2 };
};

describe('readBalance', () => {
  it('reads grouped and compact texts in every language', () => {
    expect(readBalance('999,990', 'en')).toEqual({ value: 999_990, low: 999_990, high: 999_990 });
    expect(readBalance('1.01M', 'en')).toEqual({
      value: 1_010_000,
      low: 1_005_000,
      high: 1_015_000,
    });
    expect(readBalance(formatBalance(1_010_000, 'de'), 'de')?.value).toBe(1_010_000);
    expect(readBalance(formatBalance(12_300_000, 'fr'), 'fr')?.value).toBe(12_300_000);
    expect(readBalance(formatBalance(999_024, 'fr'), 'fr')?.value).toBe(999_024);
  });

  it('rejects texts no balance formats to', () => {
    expect(readBalance('019.649', 'de')).toBeNull();
    expect(readBalance('0.00M', 'en')).toBeNull();
    expect(readBalance('1.0M', 'en')).toBeNull();
    expect(readBalance('', 'en')).toBeNull();
  });
});

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

  it('lays out the grown width up front and hides the new leading wheel until it reads 1', () => {
    const track = new OdometerTrack();
    track.jump('998');
    track.push('1,003', 1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 8) {
      const frame = track.sample(now);
      expect(frame.columns).toHaveLength(5);
      expect(frame.columns.map((column) => column.hidden)).toEqual(
        shownValue(frame) < 1000
          ? [true, true, false, false, false]
          : [false, false, false, false, false],
      );
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

  interface Credit {
    readonly at: number;
    readonly balance: number;
  }

  /**
   * Plays `credits` (absolute balances at integer ms) through a track one ms at a time and
   * checks every frame: it reads as a whole formatted number (no missing digit, no leading
   * zero) and stays between the balances of the last ROLL_MS, so it never runs ahead of the
   * balance nor lags more than ROLL_MS behind it. A rising stream must also never roll back.
   * Texts are the plaque's own, so streams past COMPACT_BALANCE_FROM change scale.
   */
  const playCredits = (
    start: number,
    credits: readonly Credit[],
    language: Language = 'en',
  ): OdometerTrack => {
    const plaque = (balance: number): string => formatBalance(balance, language);
    const track = new OdometerTrack();
    track.jump(plaque(start));
    const history: Credit[] = [{ at: -Infinity, balance: start }, ...credits];
    const balanceAt = (ms: number): number =>
      history.filter((entry) => entry.at <= ms).at(-1)?.balance ?? start;
    const end = (credits.at(-1)?.at ?? 0) + ROLL_MS;
    const rising = credits.every(
      (credit, i) => credit.balance >= (credits[i - 1]?.balance ?? start),
    );
    let lastShown = start;
    for (let now = 0; now <= end; now++) {
      const previous = balanceAt(now - 1);
      for (const credit of credits) {
        if (credit.at !== now) continue;
        track.push(plaque(credit.balance), credit.balance >= previous ? 1 : -1, now, false);
      }
      const frame = track.sample(now);
      const text = readout(frame.columns);
      const window = [
        balanceAt(now - ROLL_MS),
        ...credits.filter((c) => c.at > now - ROLL_MS && c.at <= now).map((c) => c.balance),
      ];
      const context = `${language} at ${now} ms, ${previous} -> ${balanceAt(now)}, showing "${text}"`;
      const shown = readBalance(text, language);
      expect(shown, context).not.toBeNull();
      if (!shown) continue;
      expect(shown.high, context).toBeGreaterThanOrEqual(Math.min(...window));
      expect(shown.low, context).toBeLessThanOrEqual(Math.max(...window));
      if (rising) expect(shown.value, context).toBeGreaterThanOrEqual(lastShown);
      lastShown = shown.value;
    }
    const landed = track.sample(end);
    expect(landed.settled).toBe(true);
    expect(isWhole(landed)).toBe(true);
    expect(readout(landed.columns)).toBe(plaque(balanceAt(end)));
    return track;
  };

  it.each([
    [
      'a credit joins a roll that is about to cross 1,000',
      990,
      [
        [0, 999],
        [60, 1500],
        [120, 1600],
      ],
    ],
    [
      'a credit lands before the roll reaches 1,000',
      990,
      [
        [0, 1500],
        [40, 1501],
      ],
    ],
    [
      'credits keep a roll across 10,000 going',
      9380,
      [
        [0, 9416],
        [90, 9999],
        [140, 12_416],
        [260, 12_420],
      ],
    ],
    [
      'a fresh roll starts just under 10,000',
      9416,
      [
        [0, 10_416],
        [200, 10_420],
      ],
    ],
    [
      'a big win is followed by a coin',
      52,
      [
        [0, 5052],
        [180, 5053],
      ],
    ],
    [
      'credits arrive every frame across 100',
      90,
      Array.from({ length: 12 }, (_, i) => [i * 16, 95 + i]),
    ],
  ] as const)('stays well formed when %s', (_, start, credits) => {
    playCredits(
      start,
      credits.map(([at, balance]) => ({ at, balance })),
    );
  });

  it.each([
    ['990', '1,000', '1,010'],
    ['9,380', '10,000', '10,416'],
  ])(
    'never pads with a zero when a credit joins a roll from %s across a power of ten',
    (start, first, second) => {
      const track = new OdometerTrack();
      track.jump(start);
      track.push(first, 1, 0, false);
      track.push(second, 1, 20, false);
      for (let now = 20; now <= ROLL_MS; now++) {
        const frame = track.sample(now);
        expect(readout(frame.columns)).not.toMatch(/^0/);
        expectWellFormed(frame);
      }
      expect(readout(track.sample(ROLL_MS).columns)).toBe(second);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('holds up under a random credit stream (seed %i)', (seed) => {
    const rng = createRng(0x226 * seed);
    const starts = [0, 7, 95, 990, 9380, 99_950, 52, 999_990];
    let balance = starts[Math.floor(rng() * starts.length)] ?? 0;
    const start = balance;
    const credits: Credit[] = [];
    let at = 0;
    for (let i = 0; i < 40; i++) {
      at += Math.floor(rng() ** 2 * 320);
      if (credits.at(-1)?.at === at) at++;
      balance += 1 + Math.floor(rng() ** 4 * 6000);
      credits.push({ at, balance });
    }
    playCredits(start, credits);
  });

  it.each([11, 12, 13, 14])('holds up when spends mix into the stream (seed %i)', (seed) => {
    const rng = createRng(0x226 * seed);
    const start = [1004, 10_020, 100_010, 52][seed % 4] ?? 0;
    let balance = start;
    const credits: Credit[] = [];
    let at = 0;
    for (let i = 0; i < 40; i++) {
      at += 1 + Math.floor(rng() ** 2 * 320);
      const amount = 1 + Math.floor(rng() ** 4 * 6000);
      balance = rng() < 0.35 ? Math.max(0, balance - amount) : balance + amount;
      credits.push({ at, balance });
    }
    playCredits(start, credits);
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

  it.each([
    ['9.9K', '10K', 1],
    ['999,990', '1.01M', 1],
    ['1.01M', '999,990', -1],
    ['9.99M', '10.0M', 1],
  ] as const)('swaps the whole readout from %s to the new scale %s', (from, to, direction) => {
    const track = new OdometerTrack();
    track.jump(from);
    track.push(to, direction, 0, false);
    let lastProgress = -1;
    for (let now = 0; now < ROLL_MS; now += 4) {
      const frame = track.sample(now);
      expect(readout(frame.columns)).toBe(to);
      expect(isWhole(frame)).toBe(true);
      expect(frame.settled).toBe(false);
      expect(frame.swap?.direction).toBe(direction);
      const progress = frame.swap?.progress ?? -1;
      expect(progress).toBeGreaterThanOrEqual(lastProgress);
      expect(progress).toBeLessThan(1);
      lastProgress = progress;
    }
    const landed = track.sample(ROLL_MS);
    expect(readout(landed.columns)).toBe(to);
    expect(landed.settled).toBe(true);
    expect(landed.swap).toBeNull();
  });

  it('counts again as soon as a change after a swap can count', () => {
    const track = new OdometerTrack();
    track.jump('1.00M');
    track.push('999,740', -1, 0, false);
    track.push('999,647', -1, 177, false);
    track.push('999,711', 1, 274, false);
    for (let now = 0; now <= 274 + ROLL_MS; now++) {
      const frame = track.sample(now);
      const text = readout(frame.columns);
      expectWellFormed(frame);
      const shown = shownValue(frame);
      if (now < 177) expect(text, `at ${now}`).toBe('999,740');
      expect(shown, `at ${now}: ${text}`).toBeGreaterThanOrEqual(999_647);
      expect(shown, `at ${now}: ${text}`).toBeLessThanOrEqual(999_740);
    }
    expect(readout(track.sample(274 + ROLL_MS).columns)).toBe('999,711');
  });

  it('keeps counting within the compact scale', () => {
    const track = new OdometerTrack();
    track.jump('1.01M');
    track.push('1.03M', 1, 0, false);
    for (let now = 0; now < ROLL_MS; now += 4) {
      const frame = track.sample(now);
      expect(frame.swap).toBeNull();
      expect(readout(frame.columns)).toMatch(/^1\.0[123]M$/);
    }
    expect(readout(track.sample(ROLL_MS).columns)).toBe('1.03M');
  });

  it.each(LANGUAGES)('stays readable crossing %s compact notation and back', (language) => {
    playCredits(
      999_990,
      [
        { at: 0, balance: 1_010_000 },
        { at: 60, balance: 1_010_400 },
        { at: 300, balance: 999_990 },
        { at: 340, balance: 999_960 },
        { at: 700, balance: 1_000_000 },
        { at: 800, balance: 1_012_000 },
      ],
      language,
    );
  });

  it.each(
    LANGUAGES.flatMap((language) => [1, 2, 3, 4, 5, 6].map((seed) => [language, seed] as const)),
  )('holds up in %s around the compact boundary (seed %i)', (language, seed) => {
    const rng = createRng(0x1226 * seed + language.charCodeAt(0));
    const start = COMPACT_BALANCE_FROM - 1 - Math.floor(rng() * 4000);
    let balance = start;
    const credits: Credit[] = [];
    let at = 0;
    for (let i = 0; i < 40; i++) {
      at += 1 + Math.floor(rng() ** 2 * 320);
      const amount = 1 + Math.floor(rng() ** 3 * 9000);
      const toward = balance < COMPACT_BALANCE_FROM ? 0.65 : 0.4;
      balance = rng() < toward ? balance + amount : Math.max(0, balance - amount);
      credits.push({ at, balance });
    }
    expect(credits.some((credit) => credit.balance >= COMPACT_BALANCE_FROM)).toBe(true);
    playCredits(start, credits, language);
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
