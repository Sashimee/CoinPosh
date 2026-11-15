import { describe, expect, expectTypeOf, it } from 'vitest';
import { MintedCoinSchema, type MintedCoin } from '../../domain.ts';
import { ids } from '../../test/fixtures.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  COIN_VARIANTS,
  COLLECTIBLE_COIN_VARIANTS,
  CoinVariantSchema,
  FoundVariantSchema,
  VariantMintedCoinSchema,
  coinVariantShape,
  type VariantMintedCoin,
} from './variants.ts';

const [coinA] = ids.coins;
const plain = { id: coinA, tier: 'gold', value: 25 };

describe('CoinVariantSchema', () => {
  it('lists the plain strike first and the variants from commonest to rarest', () => {
    expect(COIN_VARIANTS).toEqual(['none', 'foil', 'proof', 'firstStrike', 'misprint']);
    expect(COLLECTIBLE_COIN_VARIANTS).toEqual(['foil', 'proof', 'firstStrike', 'misprint']);
  });

  it.each(['shiny', 'Foil', 'first-strike', '', null])('rejects %j', (variant) => {
    expect(CoinVariantSchema.safeParse(variant).success).toBe(false);
  });
});

describe('VariantMintedCoinSchema', () => {
  it('reads a coin from a server or fixture without variants as a plain strike', () => {
    expect(VariantMintedCoinSchema.parse(plain)).toEqual({ ...plain, variant: 'none' });
  });

  it.each(COIN_VARIANTS)('round-trips a %s coin', (variant) => {
    const { parsed, reparsed } = roundTrip(VariantMintedCoinSchema, { ...plain, variant });
    expect(parsed.variant).toBe(variant);
    expect(reparsed).toEqual(parsed);
  });

  it('rejects an unknown variant instead of defaulting it away', () => {
    expect(VariantMintedCoinSchema.safeParse({ ...plain, variant: 'gilded' }).success).toBe(false);
  });

  it('extends any minted-coin shape, so MintedCoinSchema can adopt it in place', () => {
    const adopted = MintedCoinSchema.extend(coinVariantShape);
    expect(adopted.parse(plain)).toEqual(VariantMintedCoinSchema.parse(plain));
    expectTypeOf<VariantMintedCoin>().toExtend<MintedCoin>();
    expectTypeOf<VariantMintedCoin['variant']>().toEqualTypeOf<(typeof COIN_VARIANTS)[number]>();
  });
});

describe('FoundVariantSchema', () => {
  const found = { tier: 'silver', variant: 'misprint', firstFoundAt: 1_763_164_800_000 };

  it('round-trips one cell of the variant grid', () => {
    const { parsed, reparsed } = roundTrip(FoundVariantSchema, found);
    expect(reparsed).toEqual(parsed);
  });

  it('never records the plain strike as a find', () => {
    expect(FoundVariantSchema.safeParse({ ...found, variant: 'none' }).success).toBe(false);
  });
});
