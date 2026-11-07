import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig } from './config/index.ts';
import {
  ascensionGoldBars,
  bullionFromValue,
  cascadeMultiplier,
  cascadeTierFor,
  coinValue,
  fusionValue,
  offlineEarnings,
  upgradeCost,
  upgradeCostTotal,
  upgradeStat,
} from './formulas.ts';
import type { UpgradeLineDef } from './types.ts';

const { cascade, fusion, offline, bullion, ascension, coinTiers, upgradeLines } = economyConfig;

const line: UpgradeLineDef = {
  id: 'test',
  scope: 'venue',
  currency: 'coins',
  baseCost: 100,
  growth: 1.15,
  maxLevel: 10,
  effect: { stat: 'coinValue', base: 1, perLevel: 0.2 },
};

const anyLine = fc.constantFrom(...upgradeLines);

describe('upgradeCost', () => {
  it('is base × growth^level, rounded up', () => {
    expect(upgradeCost(line, 0)).toBe(100);
    expect(upgradeCost(line, 1)).toBe(115);
    expect(upgradeCost(line, 2)).toBe(Math.ceil(100 * 1.15 ** 2));
  });

  it('never gets cheaper as a line levels up', () => {
    fc.assert(
      fc.property(anyLine, fc.nat(), (l, raw) => {
        fc.pre(l.maxLevel >= 2);
        const level = raw % (l.maxLevel - 1);
        expect(upgradeCost(l, level + 1)).toBeGreaterThanOrEqual(upgradeCost(l, level));
      }),
    );
  });

  it('refuses levels past the cap or fractional levels', () => {
    expect(() => upgradeCost(line, 10)).toThrow(/level must be an integer in \[0, 9\]/);
    expect(() => upgradeCost(line, -1)).toThrow(RangeError);
    expect(() => upgradeCost(line, 1.5)).toThrow(RangeError);
  });

  it('sums cumulative cost from level 0', () => {
    expect(upgradeCostTotal(line, 0)).toBe(0);
    expect(upgradeCostTotal(line, 2)).toBe(215);
    fc.assert(
      fc.property(anyLine, fc.nat(), (l, raw) => {
        const level = raw % l.maxLevel;
        expect(upgradeCostTotal(l, level + 1) - upgradeCostTotal(l, level)).toBe(
          upgradeCost(l, level),
        );
      }),
    );
  });
});

describe('upgradeStat', () => {
  it('grows linearly from the base', () => {
    expect(upgradeStat(line, 0)).toBe(1);
    expect(upgradeStat(line, 5)).toBe(2);
    expect(upgradeStat(line, 10)).toBe(3);
    expect(() => upgradeStat(line, 11)).toThrow(RangeError);
  });
});

describe('coin value and fusion', () => {
  it('applies multipliers to face value', () => {
    const gold = coinTiers[2];
    expect(coinValue(gold)).toBe(25);
    expect(coinValue(gold, 2)).toBe(50);
    expect(() => coinValue(gold, -1)).toThrow(RangeError);
  });

  it('fuses three same-tier coins into 3 × lower × 1.25', () => {
    expect(fusionValue([1, 1, 1], fusion)).toBe(3.75);
    expect(fusionValue([25, 25, 25], fusion)).toBe(93.75);
  });

  it('conserves value: the only value a fusion adds is the defined bonus', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e9, noNaN: true }), {
          minLength: fusion.inputCount,
          maxLength: fusion.inputCount,
        }),
        (inputs) => {
          const sum = inputs.reduce((a, b) => a + b, 0);
          const out = fusionValue(inputs, fusion);
          expect(out).toBeGreaterThanOrEqual(sum);
          expect(out).toBe(sum * fusion.bonusMultiplier);
        },
      ),
    );
  });

  it('only fuses the configured number of coins', () => {
    expect(() => fusionValue([1, 1], fusion)).toThrow(/expected 3 input coins, got 2/);
    expect(() => fusionValue([1, 1, Number.NaN], fusion)).toThrow(RangeError);
  });
});

describe('cascade', () => {
  it('names the tier at each threshold', () => {
    expect(cascadeTierFor(2, cascade)).toBeNull();
    expect(cascadeTierFor(3, cascade)?.id).toBe('chic');
    expect(cascadeTierFor(5, cascade)?.id).toBe('chic');
    expect(cascadeTierFor(6, cascade)?.id).toBe('lavish');
    expect(cascadeTierFor(10, cascade)?.id).toBe('opulent');
    expect(cascadeTierFor(16, cascade)?.id).toBe('decadent');
    expect(cascadeTierFor(25, cascade)?.id).toBe('obscene');
    expect(cascadeTierFor(1_000, cascade)?.id).toBe('obscene');
  });

  it('never lowers the multiplier as the combo grows, and caps at OBSCENE ×3', () => {
    fc.assert(
      fc.property(fc.nat(500), (n) => {
        expect(cascadeMultiplier(n + 1, cascade)).toBeGreaterThanOrEqual(
          cascadeMultiplier(n, cascade),
        );
        expect(cascadeMultiplier(n, cascade)).toBeLessThanOrEqual(3);
        expect(cascadeMultiplier(n, cascade)).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});

describe('bullion and ascension', () => {
  it('converts 1 bullion per 1,000 value, rounding down', () => {
    expect(bullionFromValue(999, bullion)).toBe(0);
    expect(bullionFromValue(1_000, bullion)).toBe(1);
    expect(bullionFromValue(2_999_999, bullion)).toBe(2_999);
    expect(() => bullionFromValue(-1, bullion)).toThrow(RangeError);
  });

  it('pays floor(sqrt(lifetime / threshold) × 10) Gold Bars', () => {
    expect(ascensionGoldBars(2_600, 2_600, ascension)).toBe(10);
    expect(ascensionGoldBars(4 * 2_600, 2_600, ascension)).toBe(20);
    expect(ascensionGoldBars(2 * 2_600, 2_600, ascension)).toBe(14);
  });

  it('pays nothing below the threshold and rejects a zero threshold', () => {
    expect(ascensionGoldBars(2_599, 2_600, ascension)).toBe(0);
    expect(() => ascensionGoldBars(10, 0, ascension)).toThrow(/threshold must be > 0/);
  });

  it('never pays fewer bars for more bullion', () => {
    fc.assert(
      fc.property(fc.nat(10_000_000), fc.nat(10_000_000), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(ascensionGoldBars(hi, 2_600, ascension)).toBeGreaterThanOrEqual(
          ascensionGoldBars(lo, 2_600, ascension),
        );
      }),
    );
  });
});

describe('offlineEarnings', () => {
  it('is min(hours, cap) × 0.35 × active rate', () => {
    expect(offlineEarnings(1, 2, 1_000, offline)).toBeCloseTo(350);
    expect(offlineEarnings(10, 2, 1_000, offline)).toBeCloseTo(700);
    expect(offlineEarnings(10, 12, 1_000, offline)).toBeCloseTo(3_500);
  });

  it('clamps the cap to the configured 2–12 h range', () => {
    expect(offlineEarnings(48, 100, 1_000, offline)).toBeCloseTo(12 * 350);
    expect(offlineEarnings(48, 0, 1_000, offline)).toBeCloseTo(2 * 350);
  });

  it('never beats the same time spent playing', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000, noNaN: true }),
        fc.double({ min: 0, max: 24, noNaN: true }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        (hours, cap, rate) => {
          expect(offlineEarnings(hours, cap, rate, offline)).toBeLessThanOrEqual(
            hours * rate + 1e-6,
          );
        },
      ),
    );
  });

  it('rejects negative or non-finite inputs', () => {
    expect(() => offlineEarnings(-1, 2, 100, offline)).toThrow(RangeError);
    expect(() => offlineEarnings(1, 2, Number.POSITIVE_INFINITY, offline)).toThrow(RangeError);
  });
});
