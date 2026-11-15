import { describe, expect, it } from 'vitest';
import { COIN_TIERS } from '../domain.ts';
import {
  CrateIdSchema,
  ENTITY_ID_PREFIXES,
  SoireeFavorIdSchema,
  SoireeGuestIdSchema,
  SoireeRunIdSchema,
} from '../ids.ts';
import { roundTrip } from '../test/roundTrip.ts';
import {
  SOIREE_DRAFT_SIZE,
  SoireeActiveFavorSchema,
  SoireeDraftRequestSchema,
  SoireeDraftResponseSchema,
  SoireeFinishRequestSchema,
  SoireeFinishResponseSchema,
  SoireeGuestSchema,
  SoireeRewardSchema,
  SoireeStartRequestSchema,
  SoireeStartResponseSchema,
} from './soiree.ts';

const runId = 'soiree_Ve1vEtR0pe';
const proof = {
  serverSeedHash: '5b1d3f7a9c2e4b6d8f0a1c3e5d7b9f2a4c6e8d0b2f4a6c8e1d3b5f7a9c0e2d4f',
  clientSeed: 'velvet-rope-42',
  nonce: 17,
};
const wallet = {
  coins: 1250,
  bullion: 3,
  goldBars: 0,
  pearls: 40,
  keys: 4,
  tickets: 5,
  stars: 180,
};

const guests = [
  {
    id: 'debutante',
    order: 1,
    request: { kind: 'falls', tier: 'copper', count: 15, windowMs: 45_000 },
    favors: 1,
  },
  {
    id: 'sommelier',
    order: 2,
    request: { kind: 'falls', tier: 'silver', count: 2, windowMs: 50_000 },
    favors: 1,
  },
  {
    id: 'countess',
    order: 3,
    request: { kind: 'falls', tier: 'silver', count: 5, windowMs: 60_000 },
    favors: 2,
  },
  {
    id: 'ambassador',
    order: 4,
    request: { kind: 'falls', tier: 'gold', count: 1, windowMs: 60_000 },
    favors: 2,
  },
  {
    id: 'duke',
    order: 5,
    request: { kind: 'falls', tier: 'platinum', count: 1, windowMs: 90_000 },
    favors: 3,
  },
  {
    id: 'admiral',
    order: 6,
    request: { kind: 'falls', tier: 'silver', count: 8, windowMs: 75_000 },
    favors: 3,
  },
];
const offered = [
  { id: 'butlerService', stat: 'dropRate', magnitudeBp: 1_500, durationMs: 40_000, cost: 1 },
  { id: 'champagneTower', stat: 'coinValue', magnitudeBp: 1_500, durationMs: 60_000, cost: 2 },
  { id: 'velvetRope', stat: 'fusionWindow', magnitudeBp: 4_000, durationMs: 75_000, cost: 1 },
];

const start = {
  runId,
  seed: 0xdead_beef,
  startedAt: 1_700_000_000_000,
  durationMs: 480_000,
  interludeMs: 10_000,
  guests,
  offered,
  proof,
};
const draft = {
  runId,
  draft: 1,
  picked: { id: 'butlerService', startsAt: 1_700_000_051_000, endsAt: 1_700_000_091_000 },
  favorsLeft: 0,
  offered,
};
const results = guests.map((g, i) => ({
  guestId: g.id,
  fulfilled: i !== 4,
  progress: i === 4 ? 0 : g.request.count,
}));
const finish = {
  runId,
  guestsServed: 5,
  favorsEarned: 9,
  results,
  rewards: [
    { kind: 'crate', crateId: 'crate_Qw3Er5Ty7U', rarity: 'rare' },
    { kind: 'crate', crateId: 'crate_Qw3Er5Ty8V', rarity: 'common' },
    { kind: 'crate', crateId: 'crate_Qw3Er5Ty9W', rarity: 'legendary' },
    { kind: 'currency', currency: 'keys', amount: 2 },
  ],
  proof,
  wallet,
};

describe('Soirée ids', () => {
  it('mints run ids with their own prefix, never mistaken for another entity', () => {
    expect(ENTITY_ID_PREFIXES.soireeRun).toBe('soiree');
    expect(roundTrip(SoireeRunIdSchema, runId).reparsed).toBe(runId);
    expect(SoireeRunIdSchema.safeParse('crate_Qw3Er5Ty7U').success).toBe(false);
    expect(CrateIdSchema.safeParse(runId).success).toBe(false);
    expect(SoireeRunIdSchema.safeParse('soiree_short').success).toBe(false);
  });

  it('keys guests and perks by config key', () => {
    expect(SoireeGuestIdSchema.parse('duke')).toBe('duke');
    expect(SoireeFavorIdSchema.parse('champagneTower')).toBe('champagneTower');
    expect(SoireeGuestIdSchema.safeParse('The Duke').success).toBe(false);
    expect(SoireeFavorIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });
});

describe.each([
  ['start', SoireeStartResponseSchema, start],
  ['draft', SoireeDraftResponseSchema, draft],
  ['finish', SoireeFinishResponseSchema, finish],
] as const)('soiree %s response', (_name, schema, fixture) => {
  it('round-trips losslessly through JSON', () => {
    const { parsed, reparsed } = roundTrip(schema, fixture);
    expect(parsed).toEqual(fixture);
    expect(reparsed).toEqual(fixture);
  });

  it('ignores unknown keys so older clients survive newer servers', () => {
    expect(schema.parse({ ...fixture, encore: true })).toEqual(fixture);
  });
});

describe('soiree requests', () => {
  it('round-trip, and the client sends no value, tally or time', () => {
    for (const [schema, body] of [
      [SoireeStartRequestSchema, {}],
      [SoireeDraftRequestSchema, { runId, favorId: 'goldLeaf' }],
      [SoireeDraftRequestSchema, { runId, favorId: null }],
      [SoireeFinishRequestSchema, { runId }],
    ] as const) {
      expect(roundTrip(schema, body).reparsed).toEqual(body);
    }
    expect(SoireeStartRequestSchema.safeParse({ seed: 7 }).success).toBe(false);
    expect(
      SoireeDraftRequestSchema.safeParse({ runId, favorId: 'goldLeaf', favorsLeft: 9 }).success,
    ).toBe(false);
    expect(SoireeDraftRequestSchema.safeParse({ runId }).success).toBe(false);
    expect(SoireeFinishRequestSchema.safeParse({ runId, guestsServed: 6 }).success).toBe(false);
    expect(SoireeFinishRequestSchema.safeParse({ runId, endedAt: 1_700_000_480_000 }).success).toBe(
      false,
    );
  });
});

describe('soiree guests', () => {
  it('accepts a request on every coin tier', () => {
    for (const tier of COIN_TIERS) {
      const guest = { ...guests[0], request: { kind: 'falls', tier, count: 1, windowMs: 1 } };
      expect(SoireeGuestSchema.parse(guest).request.tier).toBe(tier);
    }
  });

  it('rejects an unknown tier, an empty request and a request kind the server cannot judge', () => {
    const request = guests[0]?.request;
    for (const bad of [
      { ...request, tier: 'mithril' },
      { ...request, count: 0 },
      { ...request, windowMs: 0 },
      { ...request, kind: 'fusions' },
    ]) {
      expect(SoireeGuestSchema.safeParse({ ...guests[0], request: bad }).success).toBe(false);
    }
  });

  it('lists guests in arrival order from 1, each once', () => {
    const swapped = [guests[1], guests[0], ...guests.slice(2)];
    expect(SoireeStartResponseSchema.safeParse({ ...start, guests: swapped }).success).toBe(false);
    const twice = guests.map((g, i) => (i === 5 ? { ...g, id: 'duke' } : g));
    expect(SoireeStartResponseSchema.safeParse({ ...start, guests: twice }).success).toBe(false);
    expect(SoireeStartResponseSchema.safeParse({ ...start, guests: [] }).success).toBe(false);
  });
});

describe('soiree drafts', () => {
  it(`offers exactly ${SOIREE_DRAFT_SIZE} distinct perks, or none after the last draft`, () => {
    expect(
      SoireeStartResponseSchema.safeParse({ ...start, offered: offered.slice(0, 2) }).success,
    ).toBe(false);
    const repeat = [offered[0], offered[0], offered[1]];
    expect(SoireeStartResponseSchema.safeParse({ ...start, offered: repeat }).success).toBe(false);
    expect(SoireeStartResponseSchema.safeParse({ ...start, offered: [] }).success).toBe(false);
    expect(SoireeDraftResponseSchema.parse({ ...draft, draft: 5, offered: [] }).offered).toEqual(
      [],
    );
    expect(
      SoireeDraftResponseSchema.safeParse({ ...draft, offered: offered.slice(0, 1) }).success,
    ).toBe(false);
  });

  it('perks lift only perk stats, and a pass leaves nothing running', () => {
    const offline = [{ ...offered[0], stat: 'offlineHours' }, offered[1], offered[2]];
    expect(SoireeStartResponseSchema.safeParse({ ...start, offered: offline }).success).toBe(false);
    expect(
      SoireeDraftResponseSchema.parse({ ...draft, picked: null, favorsLeft: 1 }).picked,
    ).toBeNull();
  });

  it('times a drafted perk forward on the server clock', () => {
    const at = 1_700_000_051_000;
    expect(
      SoireeActiveFavorSchema.safeParse({ id: 'goldLeaf', startsAt: at, endsAt: at }).success,
    ).toBe(false);
    expect(
      SoireeActiveFavorSchema.safeParse({ id: 'goldLeaf', startsAt: at, endsAt: at - 1 }).success,
    ).toBe(false);
  });

  it('never reports a negative Favor balance', () => {
    expect(SoireeDraftResponseSchema.safeParse({ ...draft, favorsLeft: -1 }).success).toBe(false);
  });
});

describe('soiree start', () => {
  it('carries a 32-bit table seed', () => {
    expect(SoireeStartResponseSchema.parse({ ...start, seed: 0 }).seed).toBe(0);
    expect(SoireeStartResponseSchema.safeParse({ ...start, seed: 2 ** 32 }).success).toBe(false);
    expect(SoireeStartResponseSchema.safeParse({ ...start, seed: -1 }).success).toBe(false);
    expect(SoireeStartResponseSchema.safeParse({ ...start, durationMs: 0 }).success).toBe(false);
  });
});

describe('soiree finish', () => {
  it('pays crates and keys only', () => {
    expect(
      SoireeRewardSchema.safeParse({ kind: 'currency', currency: 'coins', amount: 1 }).success,
    ).toBe(false);
    expect(
      SoireeRewardSchema.safeParse({ kind: 'currency', currency: 'pearls', amount: 1 }).success,
    ).toBe(false);
    expect(
      SoireeRewardSchema.safeParse({ kind: 'currency', currency: 'keys', amount: 0 }).success,
    ).toBe(false);
    expect(
      SoireeRewardSchema.safeParse({ kind: 'crate', crateId: 'crate_Qw3Er5Ty7U', rarity: 'mythic' })
        .success,
    ).toBe(false);
    expect(SoireeRewardSchema.safeParse({ kind: 'charm', charmType: 'ruby' }).success).toBe(false);
  });

  it('counts guests served from the guests fulfilled', () => {
    expect(SoireeFinishResponseSchema.safeParse({ ...finish, guestsServed: 6 }).success).toBe(
      false,
    );
    const none = results.map((r) => ({ ...r, fulfilled: false }));
    expect(
      SoireeFinishResponseSchema.parse({ ...finish, guestsServed: 0, results: none, rewards: [] })
        .rewards,
    ).toEqual([]);
  });
});
