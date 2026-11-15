import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  LoungeArrangeRequestSchema,
  LoungeLayoutSchema,
  LoungeResponseSchema,
  MAX_LOUNGE_SLOTS,
} from './lounge.ts';

const layout = [
  { slot: 0, item: { kind: 'prize', prize: 'rivieraChronograph' } },
  { slot: 3, item: { kind: 'heirloom', collectible: 'founders-doubloon' } },
  { slot: 5, item: { kind: 'trophy', trophy: 'firstMisprint' } },
];
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('LoungeLayoutSchema', () => {
  it('round-trips an arrangement with gaps between vitrines', () => {
    const { parsed, reparsed } = roundTrip(LoungeLayoutSchema, layout);
    expect(reparsed).toEqual(parsed);
    expect(LoungeLayoutSchema.safeParse([]).success).toBe(true);
  });

  it('rejects two items in one vitrine', () => {
    const crowded = [...layout, { slot: 3, item: { kind: 'prize', prize: 'noirAbsolu' } }];
    expect(issuePaths(LoungeLayoutSchema.safeParse(crowded))).toEqual([[3, 'slot']]);
  });

  it('rejects one item in two vitrines', () => {
    const cloned = [...layout, { slot: 9, item: layout[0]?.item }];
    expect(issuePaths(LoungeLayoutSchema.safeParse(cloned))).toEqual([[3, 'item']]);
  });

  it('keeps items of different kinds with the same key apart', () => {
    const twins = [
      { slot: 0, item: { kind: 'prize', prize: 'jubilee' } },
      { slot: 1, item: { kind: 'trophy', trophy: 'jubilee' } },
    ];
    expect(LoungeLayoutSchema.safeParse(twins).success).toBe(true);
  });

  it(`bounds vitrine indices to ${MAX_LOUNGE_SLOTS}`, () => {
    const item = { kind: 'trophy', trophy: 'firstMisprint' };
    expect(LoungeLayoutSchema.safeParse([{ slot: MAX_LOUNGE_SLOTS - 1, item }]).success).toBe(true);
    expect(LoungeLayoutSchema.safeParse([{ slot: MAX_LOUNGE_SLOTS, item }]).success).toBe(false);
    expect(LoungeLayoutSchema.safeParse([{ slot: -1, item }]).success).toBe(false);
  });
});

describe('LoungeArrangeRequestSchema', () => {
  it('round-trips an arrangement upload', () => {
    const { parsed, reparsed } = roundTrip(LoungeArrangeRequestSchema, { layout });
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a value on the item', { kind: 'prize', prize: 'rivieraChronograph', value: 400 }],
    ['a rarity on the item', { kind: 'prize', prize: 'rivieraChronograph', rarity: 'legendary' }],
    ['a polish level on the item', { kind: 'prize', prize: 'rivieraChronograph', polish: 5 }],
  ])('rejects %s', (_label, item) => {
    const result = LoungeArrangeRequestSchema.safeParse({ layout: [{ slot: 0, item }] });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects extra keys on the placement and on the request', () => {
    const placement = { ...layout[0], ownedAt: 1_763_164_800_000 };
    const onPlacement = LoungeArrangeRequestSchema.safeParse({ layout: [placement] });
    expect(onPlacement.error?.issues[0]?.code).toBe('unrecognized_keys');
    const onRequest = LoungeArrangeRequestSchema.safeParse({ layout, collectionValue: 9_999 });
    expect(onRequest.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('LoungeResponseSchema', () => {
  const lounge = { slots: 6, layout, trophies: ['firstMisprint', 'baron'] };

  it('round-trips the lounge the server says the player owns', () => {
    const { parsed, reparsed } = roundTrip(LoungeResponseSchema, lounge);
    expect(reparsed).toEqual(parsed);
  });

  it('rejects an item in a vitrine the lounge has not opened', () => {
    const result = LoungeResponseSchema.safeParse({ ...lounge, slots: 5 });
    expect(issuePaths(result)).toEqual([['layout', 2, 'slot']]);
  });
});
