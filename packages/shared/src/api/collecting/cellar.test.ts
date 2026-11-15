import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  BOTTLE_CLASSES,
  BottleRewardSchema,
  BottleSchema,
  CellarKeepRequestSchema,
  CellarKeepResponseSchema,
  CellarRackRequestSchema,
  CellarRackResponseSchema,
  CellarResponseSchema,
  CellarSellRequestSchema,
  CellarSellResponseSchema,
} from './cellar.ts';

const day = 86_400_000;
const now = 1_763_164_800_000;
const wallet = { coins: 980, bullion: 0, goldBars: 0, pearls: 0, keys: 1, tickets: 0, stars: 0 };
const bottle = {
  id: 'bottle_Gc7Ru2Mx4Q',
  type: 'margauxReserve',
  class: 'grandCru',
  state: 'racked',
  laidAt: now - 4 * day,
  peakAt: now + 17 * day,
  value: 460,
};
const second = { ...bottle, id: 'bottle_Tw3Ne8Ab1K', class: 'tableWine', peakAt: now - day };
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('BottleSchema', () => {
  it.each(BOTTLE_CLASSES)('round-trips a %s bottle', (bottleClass) => {
    const { parsed, reparsed } = roundTrip(BottleSchema, { ...bottle, class: bottleClass });
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a bottle that peaks the moment it is laid down', () => {
    expect(BottleSchema.safeParse({ ...bottle, peakAt: bottle.laidAt }).success).toBe(true);
  });

  it.each([
    ['a peak before it was laid down', { peakAt: bottle.laidAt - 1 }],
    ['an unknown class', { class: 'boxWine' }],
    ['an unknown state', { state: 'drunk' }],
    ['a prize id', { id: 'prize_Gc7Ru2Mx4Q' }],
    ['a negative value', { value: -1 }],
  ])('rejects %s', (_label, change) => {
    expect(BottleSchema.safeParse({ ...bottle, ...change }).success).toBe(false);
  });
});

describe('CellarResponseSchema', () => {
  const cellar = { serverTime: now, rackSlots: 12, bottles: [bottle, second] };

  it('round-trips the racks, valued at server time', () => {
    const { parsed, reparsed } = roundTrip(CellarResponseSchema, cellar);
    expect(reparsed).toEqual(parsed);
  });

  it('counts only racked bottles against the rack, so a kept one never overfills it', () => {
    const kept = { ...second, state: 'kept' };
    const full = { ...cellar, rackSlots: 1, bottles: [bottle, kept] };
    expect(CellarResponseSchema.safeParse(full).success).toBe(true);
    const over = { ...cellar, rackSlots: 1 };
    expect(issuePaths(CellarResponseSchema.safeParse(over))).toEqual([['bottles']]);
  });

  it('rejects a bottle laid down after the time it is valued at', () => {
    const future = { ...cellar, bottles: [{ ...bottle, laidAt: now + 1, peakAt: now + day }] };
    expect(issuePaths(CellarResponseSchema.safeParse(future))).toEqual([['bottles', 0, 'laidAt']]);
  });

  it('rejects a bottle listed twice', () => {
    const twice = { ...cellar, bottles: [bottle, bottle] };
    expect(issuePaths(CellarResponseSchema.safeParse(twice))).toEqual([['bottles', 1, 'id']]);
  });
});

describe('cellar uploads', () => {
  const sell = { bottleId: bottle.id };

  it('round-trips sell, keep and rack requests', () => {
    for (const [schema, body] of [
      [CellarSellRequestSchema, sell],
      [CellarKeepRequestSchema, sell],
      [CellarRackRequestSchema, { slots: 16 }],
    ] as const) {
      const { parsed, reparsed } = roundTrip(schema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it.each([
    ['a client laid-down time', { laidAt: now - 90 * day }],
    ['a client clock', { now: now + 365 * day }],
    ['an asking price', { value: 1_000_000 }],
    ['a client age', { ageMs: 30 * day }],
  ])('refuses a sell that carries %s', (_label, extra) => {
    const result = CellarSellRequestSchema.safeParse({ ...sell, ...extra });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('refuses a keep that sets its own collection value', () => {
    const result = CellarKeepRequestSchema.safeParse({ ...sell, collectionValue: 50_000 });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('refuses a rack upgrade that names its own price or a size of zero', () => {
    const priced = CellarRackRequestSchema.safeParse({ slots: 16, cost: 0 });
    expect(priced.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(CellarRackRequestSchema.safeParse({ slots: 0 }).success).toBe(false);
  });
});

describe('cellar answers', () => {
  it('round-trips a sale, a keep and a rack upgrade', () => {
    const answers = [
      [CellarSellResponseSchema, { bottleId: bottle.id, soldAt: now, credited: 460, wallet }],
      [CellarKeepResponseSchema, { bottle: { ...bottle, state: 'kept' }, collectionValue: 1_400 }],
      [CellarRackResponseSchema, { rackSlots: 16, wallet }],
    ] as const;
    for (const [schema, body] of answers) {
      const { parsed, reparsed } = roundTrip(schema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it('rejects a keep answer whose bottle is still on the rack', () => {
    const result = CellarKeepResponseSchema.safeParse({ bottle, collectionValue: 1_400 });
    expect(issuePaths(result)).toEqual([['bottle', 'state']]);
  });

  it('round-trips a bottle granted by a crate', () => {
    const { parsed, reparsed } = roundTrip(BottleRewardSchema, { kind: 'bottle', bottle });
    expect(reparsed).toEqual(parsed);
  });
});
