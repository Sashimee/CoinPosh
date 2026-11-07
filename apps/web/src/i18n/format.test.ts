import { describe, expect, it } from 'vitest';
import {
  COMPACT_BALANCE_FROM,
  COMPACT_PRICE_FROM,
  formatBalance,
  formatDecimal,
  formatInteger,
  formatPercent,
  formatPrice,
} from './format.ts';

const nbsp = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('number formatting', () => {
  it('groups digits per language and floors fractions', () => {
    expect(formatInteger(12_480.9, 'en')).toBe('12,480');
    expect(nbsp(formatInteger(12_480, 'fr'))).toBe('12 480');
    expect(formatInteger(12_480, 'de')).toBe('12.480');
  });

  it('switches balances to compact form at the threshold', () => {
    expect(formatBalance(COMPACT_BALANCE_FROM - 1, 'en')).toBe('999,999');
    expect(formatBalance(COMPACT_BALANCE_FROM, 'en')).toBe('1.00M');
    expect(nbsp(formatBalance(1_250_000, 'fr'))).toBe('1,25 M');
  });

  it('switches prices to compact form earlier than balances', () => {
    expect(formatPrice(COMPACT_PRICE_FROM - 1, 'en')).toBe('99,999');
    expect(formatPrice(COMPACT_PRICE_FROM, 'en')).toBe('100K');
  });

  it('formats decimals and percents', () => {
    expect(formatDecimal(1.256, 'en')).toBe('1.26');
    expect(formatDecimal(1.5, 'de')).toBe('1,5');
    expect(formatPercent(0.456, 'en')).toBe('46%');
  });

  it('refuses non-finite input instead of printing NaN', () => {
    expect(() => formatInteger(Number.NaN, 'en')).toThrow(RangeError);
    expect(() => formatBalance(Infinity, 'en')).toThrow(RangeError);
    expect(() => formatPrice(-Infinity, 'fr')).toThrow(RangeError);
    expect(() => formatDecimal(Number.NaN, 'de')).toThrow(RangeError);
    expect(() => formatPercent(Number.NaN, 'en')).toThrow(RangeError);
  });
});
