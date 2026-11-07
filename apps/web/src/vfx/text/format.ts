import type { i18n as I18n } from 'i18next';

/** Past this a pop reads better as "+2.5M" than as a wall of digits. */
export const COMPACT_FROM = 1_000_000;

/**
 * Formats a pop's value through i18next's number formatter, so EN/FR/DE get their own
 * grouping ("+1,234", "+1 234", "+1.234") and compact suffixes ("+2.5M", "+2,5 Mio.").
 */
export function formatPopValue(i18n: I18n, value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`numberPop needs a finite value, got ${value}`);
  const formatter = i18n.services.formatter;
  const lng = i18n.resolvedLanguage ?? i18n.language;
  if (!i18n.isInitialized || !formatter || !lng) {
    throw new Error(
      'numberPop needs an initialised i18next instance; call i18next.init() before createVfx()',
    );
  }
  const compact = Math.abs(value) >= COMPACT_FROM;
  return formatter.format(value, 'number', lng, {
    signDisplay: value === 0 ? 'never' : 'always',
    maximumFractionDigits: compact ? 1 : 0,
    ...(compact ? { notation: 'compact' } : {}),
  });
}
