import { describe, expect, it } from 'vitest';
import { RARITIES } from '../../domain.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  OwnedPrizeSchema,
  PRIZE_FAMILIES,
  PRIZE_RARITIES,
  PrizeCatalogEntrySchema,
  PrizeRaritySchema,
  TablePrizeSchema,
} from './prizes.ts';

describe('prize catalogue types', () => {
  it('names the four families and the five spawn rarities, lowest first', () => {
    expect(PRIZE_FAMILIES).toEqual(['watch', 'perfume', 'cufflinks', 'carKeys']);
    expect(PRIZE_RARITIES).toEqual(RARITIES.slice(0, PRIZE_RARITIES.length));
    expect(PrizeRaritySchema.safeParse('heirloom').success).toBe(false);
  });

  it('round-trips a catalogue entry for every family', () => {
    for (const family of PRIZE_FAMILIES) {
      const entry = { id: `${family}-classic`, family, rarity: 'fine' };
      const { parsed, reparsed } = roundTrip(PrizeCatalogEntrySchema, entry);
      expect(reparsed).toEqual(parsed);
    }
  });

  it.each([
    ['an unknown family', { id: 'goldYacht', family: 'yacht', rarity: 'rare' }],
    ['an unknown rarity', { id: 'goldWatch', family: 'watch', rarity: 'mythic' }],
    ['an id that is not a config key', { id: 'Gold Watch', family: 'watch', rarity: 'rare' }],
  ])('rejects an entry with %s', (_label, entry) => {
    expect(PrizeCatalogEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe('TablePrizeSchema', () => {
  it('round-trips a prize riding the table', () => {
    const prize = { id: 'prize_Ck1Ff2Ll3S', type: 'onyxCufflinks', family: 'cufflinks' };
    const { parsed, reparsed } = roundTrip(TablePrizeSchema, prize);
    expect(reparsed).toEqual(parsed);
  });
});

describe('OwnedPrizeSchema', () => {
  const owned = {
    type: 'rivieraChronograph',
    count: 2,
    polish: 1,
    firstFoundAt: 1_763_164_800_000,
  };

  it('round-trips a prize kind in the collection', () => {
    const { parsed, reparsed } = roundTrip(OwnedPrizeSchema, owned);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['none owned', { count: 0 }],
    ['negative polish', { polish: -1 }],
    ['fractional polish', { polish: 0.5 }],
  ])('rejects %s', (_label, change) => {
    expect(OwnedPrizeSchema.safeParse({ ...owned, ...change }).success).toBe(false);
  });
});
