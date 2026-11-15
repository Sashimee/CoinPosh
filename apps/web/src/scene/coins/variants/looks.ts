import {
  COLLECTIBLE_COIN_VARIANTS,
  type CoinVariant,
  type CollectibleCoinVariant,
} from '@coinposh/shared';
import { RARITY_COLORS } from '../../../vfx/palette.ts';

/**
 * The shape printed on a variant's badge, so a variant reads by silhouette alone: a pair of
 * four-point sparkles for foil, a mirror ring for proof, a five-point star for first strike and an
 * off-centre disc for misprint.
 */
export type VariantGlyph = 'sparkle' | 'mirror' | 'star' | 'offset';

export interface VariantLook {
  readonly glyph: VariantGlyph;
  /** Badge rim and glyph tint, sRGB hex: the rarity ladder from fine up, commonest first. */
  readonly accent: string;
  /** Thin-film strength on top of the tier's own (0 keeps the tier's film). */
  readonly film: number;
  /** Holographic colour laid over the metal, 0..1. */
  readonly holo: number;
  /** Roughness of the open field; `null` keeps the tier's. */
  readonly fieldRoughness: number | null;
  /** Roughness of the raised design; `null` keeps the tier's. */
  readonly reliefRoughness: number | null;
  /** How far the relief is lifted towards a pale frost, 0..1. */
  readonly frost: number;
  /** Scales the edge and lip roughness: below 1 is a crisper, fresher strike. */
  readonly edgeCrispness: number;
  /** Radius of the privy star in face units (the face spans -1..1); 0 for none. */
  readonly starMark: number;
  /** Off-centre shift of the whole strike in face units; 0 for a centred one. */
  readonly strikeOffset: number;
}

export const VARIANT_LOOKS: Readonly<Record<CollectibleCoinVariant, VariantLook>> = {
  foil: {
    glyph: 'sparkle',
    accent: RARITY_COLORS.fine,
    film: 1,
    holo: 0.42,
    fieldRoughness: null,
    reliefRoughness: null,
    frost: 0,
    edgeCrispness: 1,
    starMark: 0,
    strikeOffset: 0,
  },
  proof: {
    glyph: 'mirror',
    accent: RARITY_COLORS.rare,
    film: 0,
    holo: 0,
    fieldRoughness: 0.025,
    reliefRoughness: 0.62,
    frost: 0.38,
    edgeCrispness: 0.55,
    starMark: 0,
    strikeOffset: 0,
  },
  firstStrike: {
    glyph: 'star',
    accent: RARITY_COLORS.exquisite,
    film: 0,
    holo: 0,
    fieldRoughness: null,
    reliefRoughness: null,
    frost: 0.12,
    edgeCrispness: 0.4,
    starMark: 0.13,
    strikeOffset: 0,
  },
  misprint: {
    glyph: 'offset',
    accent: RARITY_COLORS.legendary,
    film: 0,
    holo: 0,
    fieldRoughness: null,
    reliefRoughness: null,
    frost: 0,
    edgeCrispness: 1,
    starMark: 0,
    strikeOffset: 0.16,
  },
};

/** Badge slot of each glyph in the atlas, in the order the shared contract lists the variants. */
export const VARIANT_GLYPH_INDEX: Readonly<Record<CollectibleCoinVariant, number>> =
  Object.fromEntries(COLLECTIBLE_COIN_VARIANTS.map((variant, i) => [variant, i])) as Record<
    CollectibleCoinVariant,
    number
  >;

export function isCollectibleVariant(variant: CoinVariant): variant is CollectibleCoinVariant {
  return variant !== 'none';
}

/** The look of a minted coin's variant, or null for a plain strike that the base field draws. */
export function variantLook(variant: CoinVariant): VariantLook | null {
  return isCollectibleVariant(variant) ? VARIANT_LOOKS[variant] : null;
}
