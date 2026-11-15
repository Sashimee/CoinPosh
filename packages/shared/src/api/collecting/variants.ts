import { z } from 'zod';
import { CoinTierSchema, MintedCoinSchema } from '../../domain.ts';
import { EpochMsSchema } from '../../primitives.ts';

/**
 * Commonest to rarest. The server rolls a variant when it mints a coin and stores it with the
 * coin id; the client never names one, so no request schema carries this field.
 */
export const COIN_VARIANTS = ['none', 'foil', 'proof', 'firstStrike', 'misprint'] as const;
export const CoinVariantSchema = z.enum(COIN_VARIANTS);
export type CoinVariant = z.infer<typeof CoinVariantSchema>;

/** Every variant a numismatist can find; `none` is the plain strike and is never collected. */
export const COLLECTIBLE_COIN_VARIANTS = COIN_VARIANTS.filter(
  (variant): variant is Exclude<CoinVariant, 'none'> => variant !== 'none',
);
export const CollectibleCoinVariantSchema = z.enum(COLLECTIBLE_COIN_VARIANTS);
export type CollectibleCoinVariant = z.infer<typeof CollectibleCoinVariantSchema>;

/**
 * Spread into a minted coin's shape. A server or fixture from before variants omits the field,
 * and the coin parses as a plain strike.
 */
export const coinVariantShape = { variant: CoinVariantSchema.default('none') };

/** A minted coin with its variant: what `MintedCoinSchema` becomes once T-11.06 adopts it. */
export const VariantMintedCoinSchema = MintedCoinSchema.extend(coinVariantShape);
export type VariantMintedCoin = z.infer<typeof VariantMintedCoinSchema>;

/** The first time the player banked a variant of a tier: one cell of the Album's variant grid. */
export const FoundVariantSchema = z.object({
  tier: CoinTierSchema,
  variant: CollectibleCoinVariantSchema,
  firstFoundAt: EpochMsSchema,
});
export type FoundVariant = z.infer<typeof FoundVariantSchema>;
