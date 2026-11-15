import { describe, expect, expectTypeOf, it } from 'vitest';
import { ids, serverSeedHash } from '../test/fixtures.ts';
import { roundTrip } from '../test/roundTrip.ts';
import {
  CRATE_POSE_MAX_ELAPSED_MS,
  ClaimResultSchema,
  ClaimSchema,
  ClaimWithPrizeSchema,
  ClaimsRequestSchema,
  ClaimsWithPrizeRequestSchema,
  CratePoseTupleSchema,
  DropRequestSchema,
  DropResponseSchema,
  InputsRequestSchema,
  MAX_CLAIMS_PER_BATCH,
  MAX_SNAPSHOT_COINS,
  MAX_SNAPSHOT_CRATES,
  MAX_SNAPSHOT_PRIZES,
  NudgeRequestSchema,
  POSE_POSITION_LIMIT,
  PoseTupleSchema,
  PrizeClaimSchema,
  PrizePoseTupleSchema,
  TableSnapshotRequestSchema,
  TableSnapshotResponseSchema,
  TableSnapshotSchema,
  type Claim,
  type ClaimWithPrize,
} from './table.ts';

const [coinA, coinB, coinC] = ids.coins;
const session = 'session_K3p9Wz2QfL';
const crateB = 'crate_Bz8Yx7Wv6U';

const coinIdAt = (i: number) => `coin_${String(i).padStart(8, '0')}`;
const crateIdAt = (i: number) => `crate_${String(i).padStart(8, '0')}`;
const pose = (id: string = coinA): unknown[] => [
  id,
  1_250,
  480,
  -32_000,
  0,
  0,
  0,
  32_767,
  'asleep',
];
const cratePose = (id: string = ids.crate): unknown[] => [id, -4_100, 22_000, 1_850, 'riding'];
const prizeA = 'prize_Wt4Ch9Rn2X';
const prizeB = 'prize_Pf7Um3Ae5Y';
const prizeIdAt = (i: number) => `prize_${String(i).padStart(8, '0')}`;
const prizePose = (id: string = prizeA): unknown[] => [
  id,
  -2_400,
  1_900,
  -18_500,
  1_024,
  0,
  -512,
  32_700,
  'awake',
];
const watch = { id: prizeA, type: 'rivieraChronograph', family: 'watch' };
const perfume = { id: prizeB, type: 'noirAbsolu', family: 'perfume' };

describe('DropRequestSchema', () => {
  it('carries the table session of the tab that dropped', () => {
    expect(DropRequestSchema.safeParse({ session, x: 0, tick: 0 }).success).toBe(true);
    const seasonAsSession = { session: ids.season, x: 0, tick: 0 };
    expect(DropRequestSchema.safeParse(seasonAsSession).success).toBe(false);
  });

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
    expect(ClaimsRequestSchema.safeParse({ session, claims: [fall] }).success).toBe(true);
    const full = Array.from({ length: MAX_CLAIMS_PER_BATCH }, () => fall);
    expect(ClaimsRequestSchema.safeParse({ claims: full }).success).toBe(true);
  });

  it('rejects empty and oversized batches', () => {
    expect(ClaimsRequestSchema.safeParse({ claims: [] }).success).toBe(false);
    const over = Array.from({ length: MAX_CLAIMS_PER_BATCH + 1 }, () => fall);
    expect(ClaimsRequestSchema.safeParse({ claims: over }).success).toBe(false);
  });
});

describe('NudgeRequestSchema', () => {
  it('carries the table session and rejects a malformed one', () => {
    const nudge = { tick: 12, direction: 'left' };
    expect(NudgeRequestSchema.safeParse({ ...nudge, session }).success).toBe(true);
    const short = { ...nudge, session: 'session_short' };
    expect(NudgeRequestSchema.safeParse(short).success).toBe(false);
  });
});

describe('PoseTupleSchema', () => {
  const at = (index: number, value: unknown) => pose().with(index, value);

  it('accepts positions and quaternion components at their transport bounds', () => {
    const extremes = [coinA, -POSE_POSITION_LIMIT, POSE_POSITION_LIMIT, 0, -32_768, 32_767, 0, 0];
    expect(PoseTupleSchema.safeParse([...extremes, 'awake']).success).toBe(true);
    expect(PoseTupleSchema.safeParse(pose()).success).toBe(true);
  });

  it.each([
    ['x past the bound', at(1, POSE_POSITION_LIMIT + 1)],
    ['y past the bound', at(2, -POSE_POSITION_LIMIT - 1)],
    ['a fractional z', at(3, 0.5)],
    ['qx above int16', at(4, 32_768)],
    ['qw below int16', at(7, -32_769)],
    ['a NaN quaternion component', at(5, Number.NaN)],
    ['an unknown sleep state', at(8, 'frozen')],
    ['a crate id', at(0, ids.crate)],
    ['a missing field', pose().slice(0, 8)],
    ['an extra field, such as a value', [...pose(), 625]],
  ])('rejects %s', (_label, tuple) => {
    expect(PoseTupleSchema.safeParse(tuple).success).toBe(false);
  });
});

describe('CratePoseTupleSchema', () => {
  const at = (index: number, value: unknown) => cratePose().with(index, value);

  it('accepts a ride from its first to its last millisecond', () => {
    expect(CratePoseTupleSchema.safeParse(at(3, 0)).success).toBe(true);
    const last = cratePose().with(3, CRATE_POSE_MAX_ELAPSED_MS).with(4, 'teeter');
    expect(CratePoseTupleSchema.safeParse(last).success).toBe(true);
  });

  it.each([
    ['a ride past its limit', at(3, CRATE_POSE_MAX_ELAPSED_MS + 1)],
    ['a negative elapsed time', at(3, -1)],
    ['x past the bound', at(1, POSE_POSITION_LIMIT + 1)],
    ['a fractional z', at(2, 1.5)],
    ['an unknown ride state', at(4, 'fell')],
    ['a coin id', at(0, coinA)],
    ['an extra field, such as a kind', [...cratePose(), 'vault']],
  ])('rejects %s', (_label, tuple) => {
    expect(CratePoseTupleSchema.safeParse(tuple).success).toBe(false);
  });
});

describe('TableSnapshotRequestSchema', () => {
  const upload = {
    session,
    seq: 1,
    tick: 3_600,
    pusher: { tickInCycle: 42 },
    coins: [pose(coinA), pose(coinB)],
    crates: [cratePose()],
  };
  const withCoins = (count: number) => ({
    ...upload,
    coins: Array.from({ length: count }, (_, i) => pose(coinIdAt(i))),
  });
  const withCrates = (count: number) => ({
    ...upload,
    crates: Array.from({ length: count }, (_, i) => cratePose(crateIdAt(i))),
  });

  it('accepts an upload and an empty table', () => {
    expect(TableSnapshotRequestSchema.safeParse(upload).success).toBe(true);
    const empty = { ...upload, pusher: { tickInCycle: 0 }, coins: [], crates: [] };
    expect(TableSnapshotRequestSchema.safeParse(empty).success).toBe(true);
  });

  it(`accepts up to ${MAX_SNAPSHOT_COINS} coins and rejects one more`, () => {
    expect(MAX_SNAPSHOT_COINS).toBe(320);
    expect(TableSnapshotRequestSchema.safeParse(withCoins(MAX_SNAPSHOT_COINS)).success).toBe(true);
    const over = TableSnapshotRequestSchema.safeParse(withCoins(MAX_SNAPSHOT_COINS + 1));
    expect(over.error?.issues.map((issue) => issue.path)).toEqual([['coins']]);
  });

  it(`accepts up to ${MAX_SNAPSHOT_CRATES} crates and rejects one more`, () => {
    expect(MAX_SNAPSHOT_CRATES).toBe(16);
    const full = TableSnapshotRequestSchema.safeParse(withCrates(MAX_SNAPSHOT_CRATES));
    expect(full.success).toBe(true);
    const over = TableSnapshotRequestSchema.safeParse(withCrates(MAX_SNAPSHOT_CRATES + 1));
    expect(over.error?.issues.map((issue) => issue.path)).toEqual([['crates']]);
  });

  it.each([
    ['a value', { value: 5_000 }],
    ['a tier', { tier: 'heirloom' }],
    ['a wallet', { wallet: { coins: 1_000_000 } }],
    ['frozen bodies', { frozen: [] }],
  ])('rejects an upload that carries %s', (_label, extra) => {
    const result = TableSnapshotRequestSchema.safeParse({ ...upload, ...extra });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects an extra key on the pusher phase', () => {
    const pusher = { tickInCycle: 42, speed: 2 };
    const result = TableSnapshotRequestSchema.safeParse({ ...upload, pusher });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it.each([
    ['no session', { session: undefined }],
    ['a season id as session', { session: ids.season }],
    ['seq 0', { seq: 0 }],
    ['a fractional seq', { seq: 1.5 }],
    ['a negative tick', { tick: -1 }],
    ['a negative pusher phase', { pusher: { tickInCycle: -1 } }],
    ['a fractional pusher phase', { pusher: { tickInCycle: 0.5 } }],
  ])('rejects %s', (_label, change) => {
    expect(TableSnapshotRequestSchema.safeParse({ ...upload, ...change }).success).toBe(false);
  });

  it('rejects a coin or crate posed twice in one upload', () => {
    const coins = TableSnapshotRequestSchema.safeParse({
      ...upload,
      coins: [pose(coinA), pose(coinB), pose(coinA)],
    });
    expect(coins.error?.issues.map((issue) => issue.path)).toEqual([['coins', 2, 0]]);
    const crates = TableSnapshotRequestSchema.safeParse({
      ...upload,
      crates: [cratePose(), cratePose()],
    });
    expect(crates.error?.issues.map((issue) => issue.path)).toEqual([['crates', 1, 0]]);
  });
});

describe('TableSnapshotResponseSchema', () => {
  it('counts what the server kept and dropped', () => {
    const answer = { seq: 4, stored: 2, ignored: 1 };
    expect(TableSnapshotResponseSchema.safeParse(answer).success).toBe(true);
    expect(TableSnapshotResponseSchema.safeParse({ ...answer, stored: -1 }).success).toBe(false);
    expect(TableSnapshotResponseSchema.safeParse({ ...answer, seq: 0 }).success).toBe(false);
  });
});

describe('TableSnapshotSchema layout', () => {
  const table = {
    session,
    coins: [
      { id: coinA, tier: 'copper', value: 1 },
      { id: coinB, tier: 'silver', value: 5 },
    ],
    crates: [
      { id: ids.crate, kind: 'vault' },
      { id: crateB, kind: 'vault' },
    ],
    buffer: [],
    decorum: 0,
    frozenUntil: null,
  };
  const layout = {
    pusher: { tickInCycle: 90 },
    coins: [
      { kind: 'pose', pose: pose(coinA) },
      { kind: 'heapSlot', slot: 7 },
    ],
    crates: [{ kind: 'pose', pose: cratePose(ids.crate) }, { kind: 'chute' }],
  };
  const parse = (value: unknown) => TableSnapshotSchema.safeParse({ ...table, layout: value });
  const paths = (value: unknown) => parse(value).error?.issues.map((issue) => issue.path);

  it('accepts a boot layout that places every coin and crate in order', () => {
    expect(parse(layout).success).toBe(true);
  });

  it('accepts a null layout on a resync and, while staged, a server that sends neither field', () => {
    expect(parse(null).success).toBe(true);
    const { session: _session, ...legacy } = table;
    expect(TableSnapshotSchema.safeParse(legacy).success).toBe(true);
  });

  it('rejects a malformed session', () => {
    expect(TableSnapshotSchema.safeParse({ ...table, session: coinA }).success).toBe(false);
  });

  it('lays an empty table', () => {
    const empty = { ...table, coins: [], crates: [] };
    const bare = { pusher: { tickInCycle: 0 }, coins: [], crates: [] };
    expect(TableSnapshotSchema.safeParse({ ...empty, layout: bare }).success).toBe(true);
  });

  it('rejects a coin pose that names a different coin than coins[i]', () => {
    const swapped = { ...layout, coins: [{ kind: 'pose', pose: pose(coinB) }, layout.coins[1]] };
    expect(paths(swapped)).toEqual([['layout', 'coins', 0, 'pose', 0]]);
  });

  it('rejects a crate pose that names a different crate than crates[i]', () => {
    const swapped = { ...layout, crates: [{ kind: 'chute' }, { kind: 'pose', pose: cratePose() }] };
    expect(paths(swapped)).toEqual([['layout', 'crates', 1, 'pose', 0]]);
  });

  it('rejects a layout that misses or adds a placement', () => {
    expect(paths({ ...layout, coins: layout.coins.slice(0, 1) })).toEqual([['layout', 'coins']]);
    const extra = { ...layout, crates: [...layout.crates, { kind: 'chute' }] };
    expect(paths(extra)).toEqual([['layout', 'crates']]);
  });

  it.each([
    ['a negative heap slot', { kind: 'heapSlot', slot: -1 }],
    ['a fractional heap slot', { kind: 'heapSlot', slot: 1.5 }],
    ['an unknown placement kind', { kind: 'refund' }],
    ['a pose out of range', { kind: 'pose', pose: pose(coinA).with(1, POSE_POSITION_LIMIT + 1) }],
  ])('rejects %s', (_label, placement) => {
    expect(parse({ ...layout, coins: [placement, layout.coins[1]] }).success).toBe(false);
  });

  it('rejects a layout without its pusher phase', () => {
    const { pusher: _pusher, ...noPusher } = layout;
    expect(parse(noPusher).success).toBe(false);
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

describe('PrizePoseTupleSchema', () => {
  const at = (index: number, value: unknown) => prizePose().with(index, value);

  it('round-trips a full pose, tilted as a teetering prize is', () => {
    const { parsed, reparsed } = roundTrip(PrizePoseTupleSchema, prizePose());
    expect(reparsed).toEqual(parsed);
    expect(PrizePoseTupleSchema.safeParse(at(8, 'asleep')).success).toBe(true);
  });

  it.each([
    ['a coin id', at(0, coinA)],
    ['a crate id', at(0, ids.crate)],
    ['x past the bound', at(1, POSE_POSITION_LIMIT + 1)],
    ['qw above int16', at(7, 32_768)],
    ['an unknown state', at(8, 'claimed')],
    ['a crate-style pose', [prizeA, -4_100, 22_000, 1_850, 'riding']],
    ['an extra field, such as a value', [...prizePose(), 400]],
  ])('rejects %s', (_label, tuple) => {
    expect(PrizePoseTupleSchema.safeParse(tuple).success).toBe(false);
  });
});

describe('TableSnapshotRequestSchema prizes', () => {
  const upload = {
    session,
    seq: 2,
    tick: 7_200,
    pusher: { tickInCycle: 12 },
    coins: [pose(coinA)],
    crates: [],
  };
  const withPrizes = (count: number) => ({
    ...upload,
    prizes: Array.from({ length: count }, (_, i) => prizePose(prizeIdAt(i))),
  });

  it('accepts an upload from a client that posts no prizes yet', () => {
    expect(TableSnapshotRequestSchema.safeParse(upload).success).toBe(true);
  });

  it(`round-trips up to ${MAX_SNAPSHOT_PRIZES} prize poses and rejects one more`, () => {
    const { parsed, reparsed } = roundTrip(TableSnapshotRequestSchema, withPrizes(2));
    expect(reparsed).toEqual(parsed);
    expect(parsed.prizes).toHaveLength(2);
    const full = TableSnapshotRequestSchema.safeParse(withPrizes(MAX_SNAPSHOT_PRIZES));
    expect(full.success).toBe(true);
    const over = TableSnapshotRequestSchema.safeParse(withPrizes(MAX_SNAPSHOT_PRIZES + 1));
    expect(over.error?.issues.map((issue) => issue.path)).toEqual([['prizes']]);
  });

  it('rejects a prize posed twice in one upload', () => {
    const twice = { ...upload, prizes: [prizePose(prizeA), prizePose(prizeB), prizePose(prizeA)] };
    const result = TableSnapshotRequestSchema.safeParse(twice);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['prizes', 2, 0]]);
  });

  it.each([
    ['the prizes it claims to own', { prizesOwned: [watch] }],
    ['a forged rarity', { rarity: 'legendary' }],
    ['a forged collection value', { collectionValue: 9_999 }],
  ])('rejects an upload that carries %s', (_label, extra) => {
    const result = TableSnapshotRequestSchema.safeParse({ ...withPrizes(1), ...extra });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('TableSnapshotSchema prizes', () => {
  const table = {
    session,
    coins: [{ id: coinA, tier: 'gold', value: 25 }],
    crates: [],
    prizes: [watch, perfume],
    buffer: [],
    decorum: 0.4,
    frozenUntil: null,
  };
  const layout = {
    pusher: { tickInCycle: 3 },
    coins: [{ kind: 'heapSlot', slot: 0 }],
    crates: [],
    prizes: [{ kind: 'pose', pose: prizePose(prizeA) }, { kind: 'spawn' }],
  };
  const paths = (value: unknown) =>
    TableSnapshotSchema.safeParse(value).error?.issues.map((issue) => issue.path);

  it('round-trips prizes riding the table with a boot layout that places each in order', () => {
    const { parsed, reparsed } = roundTrip(TableSnapshotSchema, { ...table, layout });
    expect(reparsed).toEqual(parsed);
    expect(parsed.prizes?.map((prize) => prize.family)).toEqual(['watch', 'perfume']);
  });

  it('still parses a server that sends no prizes, with or without a layout', () => {
    const { prizes: _prizes, ...legacy } = table;
    const { prizes: _placements, ...legacyLayout } = layout;
    expect(TableSnapshotSchema.safeParse(legacy).success).toBe(true);
    expect(TableSnapshotSchema.safeParse({ ...legacy, layout: legacyLayout }).success).toBe(true);
    expect(TableSnapshotSchema.parse(legacy).prizes).toBeUndefined();
  });

  it('rejects a boot layout that leaves out the prizes on the table', () => {
    const { prizes: _placements, ...noPrizes } = layout;
    expect(paths({ ...table, layout: noPrizes })).toEqual([['layout', 'prizes']]);
  });

  it('rejects a layout that places a prize the table does not have', () => {
    const { prizes: _prizes, ...legacy } = table;
    expect(paths({ ...legacy, layout })).toEqual([['layout', 'prizes']]);
  });

  it('rejects a prize pose that names a different prize than prizes[i]', () => {
    const swapped = { ...layout, prizes: [{ kind: 'spawn' }, { kind: 'pose', pose: prizePose() }] };
    expect(paths({ ...table, layout: swapped })).toEqual([['layout', 'prizes', 1, 'pose', 0]]);
  });

  it('rejects the same prize riding the table twice', () => {
    expect(paths({ ...table, prizes: [watch, watch] })).toEqual([['prizes', 1, 'id']]);
  });

  it.each([
    ['an unknown family', { ...watch, family: 'yacht' }],
    ['a crate id', { ...watch, id: ids.crate }],
    ['a catalogue kind that is not a config key', { ...watch, type: 'Riviera Chronograph' }],
  ])('rejects a table prize with %s', (_label, prize) => {
    expect(TableSnapshotSchema.safeParse({ ...table, prizes: [prize] }).success).toBe(false);
  });
});

describe('DropResponseSchema prizes', () => {
  const wallet = { coins: 40, bullion: 0, goldBars: 0, pearls: 0, keys: 0, tickets: 0, stars: 0 };
  const drop = {
    coin: { id: coinA, tier: 'copper', value: 1 },
    buffer: [],
    spawnedCrates: [],
    wallet,
  };

  it('round-trips a drop that spawned a prize, and one from a server without prizes', () => {
    const { parsed, reparsed } = roundTrip(DropResponseSchema, { ...drop, spawnedPrizes: [watch] });
    expect(reparsed).toEqual(parsed);
    expect(parsed.spawnedPrizes).toEqual([watch]);
    expect(DropResponseSchema.parse(drop).spawnedPrizes).toBeUndefined();
  });
});

describe('PrizeClaimSchema', () => {
  const claim = { kind: 'prize', prizeId: prizeA, tick: 4_210, edge: 'front' } as const;

  it('round-trips a front fall and a gutter fall', () => {
    for (const edge of ['front', 'left', 'right'] as const) {
      const { parsed, reparsed } = roundTrip(PrizeClaimSchema, { ...claim, edge });
      expect(reparsed).toEqual(parsed);
    }
  });

  it.each([
    ['its own value', { value: 400 }],
    ['its own rarity', { rarity: 'legendary' }],
    ['its own kind of prize', { type: 'rivieraChronograph' }],
    ['its own polish', { polish: 5 }],
    ['a client timestamp', { at: 1_763_200_000_000 }],
  ])('rejects a prize claim that states %s', (_label, extra) => {
    const result = ClaimWithPrizeSchema.safeParse({ ...claim, ...extra });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects a prize claim naming a crate or a coin', () => {
    expect(PrizeClaimSchema.safeParse({ ...claim, prizeId: ids.crate }).success).toBe(false);
    expect(PrizeClaimSchema.safeParse({ ...claim, prizeId: coinA }).success).toBe(false);
  });

  it('is staged: the live claim schema refuses it until the server settles prizes', () => {
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
    expect(ClaimWithPrizeSchema.safeParse(claim).success).toBe(true);
    expectTypeOf<Claim>().toExtend<ClaimWithPrize>();
    expectTypeOf<ClaimWithPrize['kind']>().toEqualTypeOf<'fall' | 'fusion' | 'crate' | 'prize'>();
  });

  it('keeps every core claim valid in the widened union', () => {
    const core = [
      { kind: 'fall', coinId: coinA, tick: 1, edge: 'front' },
      { kind: 'fusion', coinIds: [coinA, coinB, coinC], tick: 2 },
      { kind: 'crate', crateId: ids.crate, tick: 3, edge: 'left' },
    ];
    for (const c of core) {
      expect(ClaimWithPrizeSchema.parse(c)).toEqual(ClaimSchema.parse(c));
    }
  });

  it('batches prize claims beside coin claims, within the batch limit', () => {
    const fall = { kind: 'fall', coinId: coinA, tick: 1, edge: 'front' };
    const { parsed, reparsed } = roundTrip(ClaimsWithPrizeRequestSchema, {
      session,
      claims: [fall, claim],
    });
    expect(reparsed).toEqual(parsed);
    const over = Array.from({ length: MAX_CLAIMS_PER_BATCH + 1 }, () => claim);
    expect(ClaimsWithPrizeRequestSchema.safeParse({ claims: over }).success).toBe(false);
    expect(ClaimsWithPrizeRequestSchema.safeParse({ claims: [] }).success).toBe(false);
  });
});

describe('ClaimResultSchema prize award', () => {
  const award = {
    prizeId: prizeA,
    type: 'rivieraChronograph',
    rarity: 'exquisite',
    duplicate: false,
    count: 1,
    polish: 0,
    proof: { serverSeedHash, clientSeed: 'velvet-rope-42', nonce: 88 },
  };
  const accepted = { status: 'accepted', credited: 0, cascade: null, minted: null };

  it('round-trips a first find and a duplicate that polished the one owned', () => {
    for (const prize of [award, { ...award, duplicate: true, count: 3, polish: 2 }]) {
      const { parsed, reparsed } = roundTrip(ClaimResultSchema, { ...accepted, prize });
      expect(reparsed).toEqual(parsed);
    }
  });

  it('keeps parsing accepted results that carry no prize', () => {
    expect(ClaimResultSchema.parse(accepted)).toEqual(accepted);
  });

  it.each([
    ['a duplicate flag on a first find', { duplicate: true }],
    ['a second copy not flagged as a duplicate', { count: 2 }],
    ['heirloom, which no prize spawns at', { rarity: 'heirloom' }],
    ['no fair proof', { proof: undefined }],
  ])('rejects an award with %s', (_label, change) => {
    const prize = { ...award, ...change };
    expect(ClaimResultSchema.safeParse({ ...accepted, prize }).success).toBe(false);
  });
});
