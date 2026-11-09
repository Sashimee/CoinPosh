import { describe, expect, it } from 'vitest';
import { ids } from '../test/fixtures.ts';
import {
  CRATE_POSE_MAX_ELAPSED_MS,
  ClaimSchema,
  ClaimsRequestSchema,
  CratePoseTupleSchema,
  DropRequestSchema,
  InputsRequestSchema,
  MAX_CLAIMS_PER_BATCH,
  MAX_SNAPSHOT_COINS,
  MAX_SNAPSHOT_CRATES,
  NudgeRequestSchema,
  POSE_POSITION_LIMIT,
  PoseTupleSchema,
  TableSnapshotRequestSchema,
  TableSnapshotResponseSchema,
  TableSnapshotSchema,
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
