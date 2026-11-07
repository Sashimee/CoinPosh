import type { Language } from './core.ts';

/** Balances switch from grouped digits to 3-significant-digit compact form at this value. */
export const COMPACT_BALANCE_FROM = 1_000_000;
export const COMPACT_PRICE_FROM = 100_000;

const cache = new Map<string, Intl.NumberFormat>();

function formatter(language: Language, kind: string, options: Intl.NumberFormatOptions) {
  const id = `${language}|${kind}`;
  let format = cache.get(id);
  if (!format) {
    format = new Intl.NumberFormat(language, options);
    cache.set(id, format);
  }
  return format;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${value}`);
  }
}

export function formatInteger(value: number, language: Language): string {
  assertFinite('formatInteger value', value);
  return formatter(language, 'int', { maximumFractionDigits: 0 }).format(Math.floor(value));
}

function formatCompact(value: number, language: Language): string {
  return formatter(language, 'compact', {
    notation: 'compact',
    minimumSignificantDigits: 3,
    maximumSignificantDigits: 3,
  }).format(value);
}

export function formatBalance(value: number, language: Language): string {
  assertFinite('formatBalance value', value);
  return Math.abs(value) < COMPACT_BALANCE_FROM
    ? formatInteger(value, language)
    : formatCompact(value, language);
}

export function formatPrice(value: number, language: Language): string {
  assertFinite('formatPrice value', value);
  return Math.abs(value) < COMPACT_PRICE_FROM
    ? formatInteger(value, language)
    : formatCompact(value, language);
}

export function formatDecimal(value: number, language: Language): string {
  assertFinite('formatDecimal value', value);
  return formatter(language, 'decimal', { maximumFractionDigits: 2 }).format(value);
}

export function formatPercent(fraction: number, language: Language): string {
  assertFinite('formatPercent fraction', fraction);
  return formatter(language, 'percent', { style: 'percent', maximumFractionDigits: 0 }).format(
    fraction,
  );
}
