import { describe, expect, it } from 'vitest';
import { ids } from '../test/fixtures.ts';
import {
  ClaimSchema,
  ClaimsRequestSchema,
  DropRequestSchema,
  InputsRequestSchema,
  MAX_CLAIMS_PER_BATCH,
} from './table.ts';

const [coinA, coinB, coinC] = ids.coins;

describe('DropRequestSchema', () => {
  it('accepts aim at both ends of the rail and an optional buffered coin', () => {
    expect(DropRequestSchema.safeParse({ x: -1, tick: 0 }).success).toBe(true);
    expect(DropRequestSchema.safeParse({ x: 1, tick: 5, coinId: coinA }).success).toBe(true);
  });

  it.each([
    ['aim past the rail', { x: 1.01, tick: 0 }],
    ['NaN aim', { x: Number.NaN, tick: 0 }],
    ['infinite aim', { x: Number.POSITIVE_INFINITY, tick: 0 }],
    ['negative tick', { x: 0, tick: -1 }],
    ['fractional tick', { x: 0, tick: 1.5 }],
    ['unsafe integer tick', { x: 0, tick: Number.MAX_SAFE_INTEGER + 1 }],
    ['a crate id as coin', { x: 0, tick: 0, coinId: ids.crate }],
    ['a client-chosen value', { x: 0, tick: 0, value: 5_000 }],
    ['a client-chosen tier', { x: 0, tick: 0, tier: 'heirloom' }],
  ])('rejects %s', (_label, body) => {
    expect(DropRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('ClaimSchema', () => {
  it('rejects a fall claim that tries to state its own value', () => {
    const forged = { kind: 'fall', coinId: coinA, tick: 10, edge: 'front', value: 625 };
    const result = ClaimSchema.safeParse(forged);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('requires three distinct coins for a fusion', () => {
    const fusion = (coinIds: unknown) =>
      ClaimSchema.safeParse({ kind: 'fusion', coinIds, tick: 3 });
    expect(fusion([coinA, coinB, coinC]).success).toBe(true);
    expect(fusion([coinA, coinA, coinB]).success).toBe(false);
    expect(fusion([coinA, coinB]).success).toBe(false);
    expect(fusion([coinA, coinB, coinC, ids.coins[3]]).success).toBe(false);
  });

  it('rejects an unknown claim kind and an unknown edge', () => {
    expect(ClaimSchema.safeParse({ kind: 'jackpot', tick: 1 }).success).toBe(false);
    expect(
      ClaimSchema.safeParse({ kind: 'fall', coinId: coinA, tick: 1, edge: 'back' }).success,
    ).toBe(false);
  });

  it('rejects a crate claim pointing at a coin id', () => {
    const claim = { kind: 'crate', crateId: coinA, tick: 1, edge: 'front' };
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
  });
});

describe('ClaimsRequestSchema', () => {
  const fall = { kind: 'fall', coinId: coinA, tick: 1, edge: 'front' } as const;

  it('accepts batches from 1 up to the batch limit', () => {
    expect(ClaimsRequestSchema.safeParse({ claims: [fall] }).success).toBe(true);
    const full = Array.from({ length: MAX_CLAIMS_PER_BATCH }, () => fall);
    expect(ClaimsRequestSchema.safeParse({ claims: full }).success).toBe(true);
  });

  it('rejects empty and oversized batches', () => {
    expect(ClaimsRequestSchema.safeParse({ claims: [] }).success).toBe(false);
    const over = Array.from({ length: MAX_CLAIMS_PER_BATCH + 1 }, () => fall);
    expect(ClaimsRequestSchema.safeParse({ claims: over }).success).toBe(false);
  });
});

describe('InputsRequestSchema', () => {
  const segment = {
    fromTick: 300,
    toTick: 600,
    events: [
      { kind: 'drop', tick: 300, x: 0, coinId: coinA },
      { kind: 'nudge', tick: 450, direction: 'left' },
    ],
    checkpoints: [{ tick: 600, hash: 'deadbeef' }],
  };

  it('accepts an ordered segment whose ticks touch both bounds', () => {
    expect(InputsRequestSchema.safeParse(segment).success).toBe(true);
  });

  it('rejects a segment that ends before it starts', () => {
    const result = InputsRequestSchema.safeParse({ ...segment, fromTick: 700 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain('toTick');
  });

  it('rejects events outside the segment or out of order', () => {
    const late = { ...segment, events: [{ kind: 'pourStart', tick: 601 }] };
    expect(InputsRequestSchema.safeParse(late).success).toBe(false);
    const shuffled = { ...segment, events: segment.events.toReversed() };
    expect(InputsRequestSchema.safeParse(shuffled).success).toBe(false);
  });

  it('requires at least one checkpoint with a well-formed hash', () => {
    expect(InputsRequestSchema.safeParse({ ...segment, checkpoints: [] }).success).toBe(false);
    const badHash = { ...segment, checkpoints: [{ tick: 600, hash: 'DEADBEEF' }] };
    expect(InputsRequestSchema.safeParse(badHash).success).toBe(false);
    const oddHash = { ...segment, checkpoints: [{ tick: 600, hash: 'abc' }] };
    expect(InputsRequestSchema.safeParse(oddHash).success).toBe(false);
  });
});
