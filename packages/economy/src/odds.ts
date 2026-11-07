import { RARITY_IDS, type OddsTable, type RarityId } from './types.ts';

/** 100 % expressed in odds-table weight units (basis points of a percent). */
export const ODDS_SCALE = 10_000;

export interface OddsRow {
  readonly rarity: RarityId;
  readonly weight: number;
  readonly percent: number;
}

export function oddsTotal(odds: OddsTable): number {
  return RARITY_IDS.reduce((sum, rarity) => sum + odds[rarity], 0);
}

export function weightToPercent(weight: number): number {
  return weight / (ODDS_SCALE / 100);
}

/**
 * The rows the "Certified Fair" odds sheet renders. The UI must display these and
 * nothing else, so what players read is exactly what the server rolls.
 */
export function oddsRows(odds: OddsTable): readonly OddsRow[] {
  return RARITY_IDS.map((rarity) => ({
    rarity,
    weight: odds[rarity],
    percent: weightToPercent(odds[rarity]),
  }));
}

/** Locale-neutral percent label with only as many decimals as the weight needs (max 2). */
export function formatPercent(weight: number): string {
  const whole = Math.trunc(weight / 100);
  const fraction = weight % 100;
  if (fraction === 0) return `${whole}`;
  if (fraction % 10 === 0) return `${whole}.${fraction / 10}`;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}
