import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { CollectionResponseSchema } from './collection.ts';

const at = 1_763_164_800_000;
const book = {
  prizes: [
    { type: 'rivieraChronograph', count: 1, polish: 0, firstFoundAt: at },
    { type: 'noirAbsolu', count: 4, polish: 3, firstFoundAt: at + 60_000 },
  ],
  variants: [
    { tier: 'copper', variant: 'foil', firstFoundAt: at },
    { tier: 'silver', variant: 'foil', firstFoundAt: at + 1 },
    { tier: 'copper', variant: 'proof', firstFoundAt: at + 2 },
  ],
  collectionValue: 1_310,
  multiplierBp: 200,
  pity: { prizesSinceNew: 3, mintsSinceMisprint: 1_204 },
};

describe('CollectionResponseSchema', () => {
  it('round-trips a collection book', () => {
    const { parsed, reparsed } = roundTrip(CollectionResponseSchema, book);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts an empty book for a new player', () => {
    const empty = {
      prizes: [],
      variants: [],
      collectionValue: 0,
      multiplierBp: 0,
      pity: { prizesSinceNew: 0, mintsSinceMisprint: 0 },
    };
    expect(CollectionResponseSchema.safeParse(empty).success).toBe(true);
  });

  it('rejects a prize kind listed twice', () => {
    const prizes = [...book.prizes, book.prizes[0]];
    const result = CollectionResponseSchema.safeParse({ ...book, prizes });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['prizes']]);
  });

  it('rejects a tier and variant found twice', () => {
    const variants = [...book.variants, { ...book.variants[0], firstFoundAt: at + 9 }];
    const result = CollectionResponseSchema.safeParse({ ...book, variants });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['variants']]);
  });

  it.each([
    ['a negative collection value', { collectionValue: -1 }],
    ['a fractional multiplier', { multiplierBp: 2.5 }],
    ['no pity counters', { pity: undefined }],
  ])('rejects %s', (_label, change) => {
    expect(CollectionResponseSchema.safeParse({ ...book, ...change }).success).toBe(false);
  });
});
