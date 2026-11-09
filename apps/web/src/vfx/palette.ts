import type { CascadeTier, CoinTier, Rarity } from '@coinposh/shared';
import { Color } from 'three/webgpu';
import { COIN_LOOKS } from '../scene/coins/tiers.ts';
import { rivieraTokens } from '../scene/venues/riviera/palette.ts';

/** Linear-light RGB, the space particle colours are written and blended in. */
export type LinearRgb = readonly [number, number, number];

/** Rarity colours from 03-ART-AUDIO-JUICE.md; heirloom's base is the prismatic gradient's gold. */
export const RARITY_COLORS: Readonly<Record<Rarity, string>> = {
  common: '#E9E4D8',
  fine: '#3CCB7F',
  rare: '#3B82F6',
  exquisite: '#A855F7',
  legendary: '#F5B942',
  heirloom: '#F3E5C0',
};

/** The stops of the animated heirloom gradient, used by text and confetti alike. */
export const HEIRLOOM_PRISM = ['#F5B942', '#FF7A59', '#A855F7', '#3B82F6', '#7FD1C7'] as const;

export const VFX_COLORS = {
  gold: rivieraTokens['gold-brushed'],
  champagne: rivieraTokens.champagne,
  coral: rivieraTokens['coral-sunset'],
  seaGlass: rivieraTokens['sea-glass'],
  ivory: rivieraTokens.ivory,
  teak: rivieraTokens.teak,
  /** White-gold core of a hot spark or the fusion flash. */
  whiteGold: '#FFF4D6',
} as const;

/** Each Cascade tier climbs the palette towards gold, and OBSCENE throws everything. */
export const CASCADE_COLORS: Readonly<Record<CascadeTier, readonly string[]>> = {
  chic: [VFX_COLORS.champagne, VFX_COLORS.ivory],
  lavish: [VFX_COLORS.champagne, VFX_COLORS.gold],
  opulent: [VFX_COLORS.gold, VFX_COLORS.champagne],
  decadent: [VFX_COLORS.coral, VFX_COLORS.gold],
  obscene: [VFX_COLORS.gold, VFX_COLORS.coral, VFX_COLORS.champagne, VFX_COLORS.seaGlass],
};

/** Foil confetti: mostly gold and champagne so the burst reads as money, accents for life. */
export const CONFETTI_COLORS = [
  VFX_COLORS.gold,
  VFX_COLORS.gold,
  VFX_COLORS.champagne,
  VFX_COLORS.ivory,
  VFX_COLORS.coral,
  VFX_COLORS.seaGlass,
] as const;

export function tierMetal(tier: CoinTier): string {
  return COIN_LOOKS[tier].metal;
}

const linearCache = new Map<string, LinearRgb>();

export function toLinear(hex: string): LinearRgb {
  const cached = linearCache.get(hex);
  if (cached) return cached;
  const color = new Color(hex);
  const rgb: LinearRgb = [color.r, color.g, color.b];
  linearCache.set(hex, rgb);
  return rgb;
}

/** Mixes two linear colours; `t` = 0 is `a`. */
export function mixLinear(a: LinearRgb, b: LinearRgb, t: number): LinearRgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
