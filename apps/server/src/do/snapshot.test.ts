import { crateSpawn } from '@coinposh/economy';
import {
  MAX_SNAPSHOT_COINS,
  tableSnapshotEndpoint,
  type CratePoseTuple,
  type IdempotencyKey,
  type PoseTuple,
  type StateResponse,
  type TableSnapshotResponse,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { newIdempotencyKey, newSession, type Session } from '../test/client.ts';
import {
  claims,
  dropAsClient,
  expectConserved,
  expectError,
  playerStub,
  reload,
  state,
} from '../test/game.ts';
import type { PlayerDO } from './PlayerDO.ts';
import {
  CHUTE_POSE,
  COIN_TRAVEL,
  elapsedSeconds,
  readTableSnapshot,
  snapshotFlags,
  SNAPSHOT_RATE,
  takeSnapshotToken,
  withinCoinTravel,
  withinCrateRide,
  type StoredTableSnapshot,
} from './snapshot.ts';

const FLAT = [0, 0, 0, 32_767] as const;
const FLOOR_Y = 160;
/** The front lip: the furthest forward a coin's centre may rest. */
const LIP_Z = 5_000;
const FORGED_COIN_ID = 'coin_AAAAAAAAAAAAAAAAAAAA';
const FORGED_CRATE_ID = 'crate_AAAAAAAAAAAAAAAAAAAA';
const SPAWN_Z = CHUTE_POSE.z;

function pose(id: string, x: number, z: number, y = FLOOR_Y): PoseTuple {
  return [id, x, y, z, ...FLAT, 'asleep'] as PoseTuple;
}

function cratePose(id: string, z: number, elapsedMs: number, x = 0): CratePoseTuple {
  return [id, x, z, elapsedMs, z >= 4_160 ? 'teeter' : 'riding'] as CratePoseTuple;
}

/** Coin i of `ids` on a floor grid at pusher tick 0, none touching another. */
function grid(ids: readonly string[]): PoseTuple[] {
  return ids.map((id, i) =>
    pose(id, -15_000 + (i % 11) * 3_000, -9_000 + Math.floor(i / 11) * 3_000),
  );
}

interface SnapshotBody {
  session: string;
  seq: number;
  tick: number;
  pusher: { tickInCycle: number };
  coins: unknown[];
  crates: unknown[];
}

function body(table: StateResponse['table'], overrides: Partial<SnapshotBody> = {}): SnapshotBody {
  const session = table.session;
  if (session === undefined) throw new Error('state did not return a table session.');
  return {
    session,
    seq: 1,
    tick: 60,
    pusher: { tickInCycle: 0 },
    coins: [],
    crates: [],
    ...overrides,
  };
}

function upload(session: Session, snapshot: unknown, idempotencyKey?: IdempotencyKey) {
  return session.call(tableSnapshotEndpoint.path, {
    body: snapshot,
    idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
  });
}

async function accept(session: Session, snapshot: unknown): Promise<TableSnapshotResponse> {
  const response = await upload(session, snapshot);
  expect(response.status, await response.clone().text()).toBe(200);
  return tableSnapshotEndpoint.response.parse(await response.json());
}

function inDO<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) =>
    run(ctx.storage.sql),
  );
}

function stored(session: Session): Promise<StoredTableSnapshot | null> {
  return inDO(session, readTableSnapshot);
}

function flags(session: Session) {
  return inDO(session, snapshotFlags);
}

/** What only the server changes: the ledger, the wallet and the coin and crate rows. */
function economy(session: Session) {
  return inDO(session, (sql) => ({
    ledger: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ledger').one().n,
    wallet: sql.exec('SELECT currency, balance FROM wallet ORDER BY currency').toArray(),
    coins: sql.exec('SELECT id, state, value, dropped_tick FROM coins ORDER BY rowid').toArray(),
    crates: sql.exec('SELECT id, state, spawned_tick FROM crates ORDER BY rowid').toArray(),
    meta: sql
      .exec(
        "SELECT key, value FROM meta WHERE key IN ('drop_count', 'drop_high_water') ORDER BY key",
      )
      .toArray(),
  }));
}

/** Server time passes: every stored instant moves `ms` into the past. */
function elapse(session: Session, ms: number) {
  return inDO(session, (sql) => {
    sql.exec('UPDATE table_snapshot SET received_at = received_at - ?', ms);
    sql.exec('UPDATE crates SET spawned_at = spawned_at - ?', ms);
    sql.exec(
      "UPDATE meta SET value = CAST(value AS INTEGER) - ? WHERE key IN ('snapshot_tokens_at', 'table_session_started_at')",
      ms,
    );
  });
}

async function booted(session: Session): Promise<StateResponse['table']> {
  return (await reload(session)).table;
}

describe('POST /v1/table/snapshot pipeline', () => {
  describe('step 1: session', () => {
    it('refuses a session the server never issued', async () => {
      const session = await newSession();
      const table = await booted(session);
      const forged = body(table, { session: 'session_ForgedForgedForged0' });
      await expectError(await upload(session, forged), 409, 'session_superseded');
      expect((await stored(session))?.seq).toBe(0);
    });

    it('fences the older tab once another boot took the table (multiple tabs)', async () => {
      const session = await newSession();
      const first = await booted(session);
      const second = await booted(session);
      expect(second.session).not.toBe(first.session);
      const coins = grid(second.coins.slice(0, 3).map((coin) => coin.id));
      await expectError(await upload(session, body(first, { coins })), 409, 'session_superseded');
      expect(await accept(session, body(second, { coins }))).toEqual({
        seq: 1,
        stored: 3,
        ignored: 0,
      });
    });

    it('refuses a snapshot before any session exists', async () => {
      const session = await newSession();
      await expectError(
        await upload(session, {
          session: 'session_NeverIssuedNever0',
          seq: 1,
          tick: 0,
          pusher: { tickInCycle: 0 },
          coins: [],
          crates: [],
        }),
        409,
        'session_superseded',
      );
    });
  });

  describe('step 2: seq and tick ordering (stale or replayed snapshots)', () => {
    it('refuses a seq that is not after the stored one', async () => {
      const session = await newSession();
      const table = await booted(session);
      await accept(session, body(table, { seq: 5, tick: 60 }));
      await expectError(
        await upload(session, body(table, { seq: 5, tick: 120 })),
        409,
        'stale_snapshot',
      );
      await expectError(
        await upload(session, body(table, { seq: 4, tick: 120 })),
        409,
        'stale_snapshot',
      );
      expect((await stored(session))?.seq).toBe(5);
    });

    it('refuses a tick before the stored snapshot', async () => {
      const session = await newSession();
      const table = await booted(session);
      await accept(session, body(table, { seq: 1, tick: 600 }));
      await expectError(
        await upload(session, body(table, { seq: 2, tick: 599 })),
        409,
        'stale_snapshot',
      );
      expect(await accept(session, body(table, { seq: 2, tick: 600 }))).toMatchObject({ seq: 2 });
    });

    it('refuses a tick before a drop or claim already settled in the session', async () => {
      const session = await newSession();
      const table = await booted(session);
      await dropAsClient(session, 1, () => 900);
      await expectError(await upload(session, body(table, { tick: 899 })), 409, 'stale_snapshot');

      const coin = table.coins[0];
      if (coin === undefined) throw new Error('No heap coin.');
      const result = await claims(session, [
        { kind: 'fall', coinId: coin.id, tick: 1_500, edge: 'front' },
      ]);
      expect(result.results[0]?.status).toBe('accepted');
      await expectError(await upload(session, body(table, { tick: 1_499 })), 409, 'stale_snapshot');
      expect(await accept(session, body(table, { tick: 1_500 }))).toMatchObject({ seq: 1 });
    });

    it('does not let a rejected claim or another session move the tick floor', async () => {
      const session = await newSession();
      const table = await booted(session);
      const rejected = await claims(session, [
        { kind: 'fall', coinId: FORGED_COIN_ID, tick: 9_000, edge: 'front' },
      ]);
      expect(rejected.results[0]).toEqual({ status: 'rejected', reason: 'unknown_entity' });
      const response = await session.call('/v1/table/drop', {
        body: { session: 'session_SomeOtherTabTab00', x: 0, tick: 8_000 },
      });
      await expectError(response, 409, 'session_superseded');
      expect(await accept(session, body(table, { tick: 60 }))).toMatchObject({ seq: 1 });
    });
  });

  describe('step 3: rate, 1 per 2 s with a burst of 3 (flood)', () => {
    it('allows a burst of 3, then answers rate_limited with retryAfterMs', async () => {
      const session = await newSession();
      const table = await booted(session);
      for (let seq = 1; seq <= SNAPSHOT_RATE.burst; seq++) {
        await accept(session, body(table, { seq, tick: seq * 60 }));
      }
      const limited = await upload(session, body(table, { seq: 4, tick: 240 }));
      expect(limited.status).toBe(429);
      const envelope = await limited.json<{ error: { code: string; retryAfterMs: number } }>();
      expect(envelope.error.code).toBe('rate_limited');
      expect(envelope.error.retryAfterMs).toBeGreaterThan(SNAPSHOT_RATE.intervalMs - 500);
      expect(envelope.error.retryAfterMs).toBeLessThanOrEqual(SNAPSHOT_RATE.intervalMs);
      expect((await stored(session))?.seq).toBe(3);

      await elapse(session, SNAPSHOT_RATE.intervalMs);
      await accept(session, body(table, { seq: 4, tick: 240 }));
      await expectError(
        await upload(session, body(table, { seq: 5, tick: 300 })),
        429,
        'rate_limited',
      );
    });

    it('earns nothing when the server clock steps back', async () => {
      const session = await newSession();
      const table = await booted(session);
      for (let seq = 1; seq <= SNAPSHOT_RATE.burst; seq++) {
        await accept(session, body(table, { seq, tick: seq * 60 }));
      }
      await elapse(session, -60 * 60 * 1000);
      await expectError(
        await upload(session, body(table, { seq: 4, tick: 240 })),
        429,
        'rate_limited',
      );
    });

    it('spends no token on a refused snapshot', async () => {
      const session = await newSession();
      const table = await booted(session);
      await accept(session, body(table, { seq: 2, tick: 60 }));
      for (let i = 0; i < 5; i++) {
        await expectError(
          await upload(session, body(table, { seq: 1, tick: 60 })),
          409,
          'stale_snapshot',
        );
      }
      await accept(session, body(table, { seq: 3, tick: 120 }));
      await accept(session, body(table, { seq: 4, tick: 180 }));
    });

    it('does not refill when the player boots again', async () => {
      const session = await newSession();
      let table = await booted(session);
      for (let seq = 1; seq <= SNAPSHOT_RATE.burst; seq++) {
        await accept(session, body(table, { seq, tick: seq * 60 }));
      }
      table = await booted(session);
      await expectError(
        await upload(session, body(table, { seq: 1, tick: 60 })),
        429,
        'rate_limited',
      );
    });

    it('caps a snapshot at MAX_SNAPSHOT_COINS poses', async () => {
      const session = await newSession();
      const table = await booted(session);
      const coins = Array.from({ length: MAX_SNAPSHOT_COINS + 1 }, (_, i) =>
        pose(`coin_${String(i).padStart(20, '0')}`, 0, 0),
      );
      await expectError(await upload(session, body(table, { coins })), 400, 'validation_failed');
    });
  });

  describe('step 4: structure', () => {
    it('refuses a pusher phase outside its cycle', async () => {
      const session = await newSession();
      const table = await booted(session);
      await expectError(
        await upload(session, body(table, { pusher: { tickInCycle: 240 } })),
        400,
        'bad_request',
      );
    });

    it('refuses a coin or crate posed twice', async () => {
      const session = await newSession();
      const table = await booted(session);
      const id = table.coins[0]?.id ?? '';
      await expectError(
        await upload(session, body(table, { coins: [pose(id, 0, 0), pose(id, 3_000, 0)] })),
        400,
        'validation_failed',
      );
      await expectError(
        await upload(
          session,
          body(table, {
            crates: [
              cratePose(FORGED_CRATE_ID, SPAWN_Z, 0),
              cratePose(FORGED_CRATE_ID, SPAWN_Z, 0),
            ],
          }),
        ),
        400,
        'validation_failed',
      );
    });

    it('refuses any value, tier or wallet field the client tries to slip in', async () => {
      const session = await newSession();
      const table = await booted(session);
      const before = await economy(session);
      for (const extra of [{ value: 1_000 }, { wallet: { coins: 1_000 } }, { tier: 'gold' }]) {
        await expectError(
          await upload(session, { ...body(table), ...extra }),
          400,
          'validation_failed',
        );
      }
      const id = table.coins[0]?.id ?? '';
      await expectError(
        await upload(session, body(table, { coins: [[...pose(id, 0, 0), 1_000]] })),
        400,
        'validation_failed',
      );
      expect(await economy(session)).toEqual(before);
    });
  });

  describe('step 5: ownership', () => {
    it('ignores and flags a coin this player does not own (forged ids)', async () => {
      const session = await newSession();
      const other = await newSession();
      const theirs = (await state(other)).table.coins[0]?.id ?? '';
      const table = await booted(session);
      const mine = table.coins[0]?.id ?? '';
      const result = await accept(
        session,
        body(table, {
          coins: [
            pose(mine, 0, -9_000),
            pose(FORGED_COIN_ID, 3_000, -9_000),
            pose(theirs, 6_000, -9_000),
          ],
        }),
      );
      expect(result).toEqual({ seq: 1, stored: 1, ignored: 2 });
      expect((await stored(session))?.poses.map((tuple) => tuple[0])).toEqual([mine]);
      expect(await flags(session)).toMatchObject({ 'snapshot.foreign': 2 });
    });

    it('ignores and flags a buffer coin posed onto the table, which stays in the buffer', async () => {
      const session = await newSession();
      const table = await booted(session);
      const reserved = table.buffer[0]?.id ?? '';
      const before = await economy(session);
      expect(await accept(session, body(table, { coins: [pose(reserved, 0, -9_000)] }))).toEqual({
        seq: 1,
        stored: 0,
        ignored: 1,
      });
      expect(await economy(session)).toEqual(before);
      expect(await flags(session)).toMatchObject({ 'snapshot.foreign': 1 });
      const after = await booted(session);
      expect(after.buffer.map((coin) => coin.id)).toContain(reserved);
      expect(after.coins.map((coin) => coin.id)).not.toContain(reserved);
    });

    it('ignores a coin that already left the table without flagging it, since a claim can race', async () => {
      const session = await newSession();
      const table = await booted(session);
      const [gone, kept] = table.coins;
      if (gone === undefined || kept === undefined) throw new Error('No heap coins.');
      await claims(session, [{ kind: 'fall', coinId: gone.id, tick: 30, edge: 'front' }]);
      const result = await accept(
        session,
        body(table, { coins: [pose(gone.id, 0, -9_000), pose(kept.id, 3_000, -9_000)] }),
      );
      expect(result).toEqual({ seq: 1, stored: 1, ignored: 1 });
      expect(await flags(session)).toMatchObject({ 'snapshot.foreign': 0 });
    });
  });

  describe('step 6: checkPose and validateSnapshot', () => {
    it('drops poses outside the table, in the pusher or with a broken rotation, and flags them', async () => {
      const session = await newSession();
      const table = await booted(session);
      const [a, b, c, d] = table.coins.map((coin) => coin.id);
      if (d === undefined || a === undefined || b === undefined || c === undefined) {
        throw new Error('No heap coins.');
      }
      const tilted: PoseTuple = [c, 6_000, FLOOR_Y, -9_000, 0, 0, 0, 20_000, 'asleep'] as PoseTuple;
      const result = await accept(
        session,
        body(table, {
          pusher: { tickInCycle: 120 },
          coins: [pose(a, 0, LIP_Z + 1), pose(b, 3_000, -5_000), tilted, pose(d, 9_000, 2_000)],
        }),
      );
      expect(result).toEqual({ seq: 1, stored: 1, ignored: 3 });
      expect((await stored(session))?.poses.map((tuple) => tuple[0])).toEqual([d]);
      expect(await flags(session)).toMatchObject({ 'snapshot.implausible': 3 });
    });

    it('drops the later of two coins sunk into each other', async () => {
      const session = await newSession();
      const table = await booted(session);
      const [a, b] = table.coins.map((coin) => coin.id);
      if (a === undefined || b === undefined) throw new Error('No heap coins.');
      const result = await accept(
        session,
        body(table, { coins: [pose(b, 500, -9_000), pose(a, 0, -9_000)] }),
      );
      expect(result).toEqual({ seq: 1, stored: 1, ignored: 1 });
      expect((await stored(session))?.poses.map((tuple) => tuple[0])).toEqual([a]);
    });
  });

  describe('step 7: teleport bound', () => {
    it('keeps the old pose of a coin that jumped across the table, and flags it', async () => {
      const session = await newSession();
      const table = await booted(session);
      const [a, b] = table.coins.map((coin) => coin.id);
      if (a === undefined || b === undefined) throw new Error('No heap coins.');
      await accept(
        session,
        body(table, { seq: 1, tick: 60, coins: [pose(a, -15_000, -9_000), pose(b, 0, -9_000)] }),
      );
      await elapse(session, 100);
      const result = await accept(
        session,
        body(table, { seq: 2, tick: 66, coins: [pose(a, 15_000, -9_000), pose(b, 0, -8_800)] }),
      );
      expect(result).toEqual({ seq: 2, stored: 1, ignored: 1 });
      expect((await stored(session))?.poses).toEqual([
        pose(a, -15_000, -9_000),
        pose(b, 0, -8_800),
      ]);
      expect(await flags(session)).toMatchObject({ 'snapshot.teleport': 1 });
    });

    it('farms no lip coins: a jump to the lip keeps the old pose and pays nothing', async () => {
      const session = await newSession();
      const table = await booted(session);
      const ids = table.coins.slice(0, 11).map((coin) => coin.id);
      await accept(session, body(table, { seq: 1, tick: 60, coins: grid(ids) }));
      const before = await economy(session);
      await elapse(session, 200);
      const lip = ids.map((id, i) => pose(id, -15_000 + i * 3_000, LIP_Z));
      expect(await accept(session, body(table, { seq: 2, tick: 72, coins: lip }))).toEqual({
        seq: 2,
        stored: 0,
        ignored: ids.length,
      });
      expect((await stored(session))?.poses).toEqual(grid(ids));
      expect(await economy(session)).toEqual(before);
    });

    it('judges by server time, so fast-forwarded ticks buy no longer move (clock skew)', async () => {
      const session = await newSession();
      const table = await booted(session);
      const a = table.coins[0]?.id ?? '';
      await accept(session, body(table, { seq: 1, tick: 60, coins: [pose(a, -15_000, -9_000)] }));
      await elapse(session, 100);
      expect(
        await accept(
          session,
          body(table, { seq: 2, tick: 60 + 600 * 60, coins: [pose(a, 15_000, -9_000)] }),
        ),
      ).toMatchObject({ stored: 0, ignored: 1 });
      expect(await flags(session)).toMatchObject({ 'snapshot.teleport': 1 });
    });

    it('lets a coin travel as far as real time allows', async () => {
      const session = await newSession();
      const table = await booted(session);
      const a = table.coins[0]?.id ?? '';
      await accept(session, body(table, { seq: 1, tick: 60, coins: [pose(a, -15_000, -9_000)] }));
      await elapse(session, 1_000);
      expect(
        await accept(session, body(table, { seq: 2, tick: 120, coins: [pose(a, 15_000, -9_000)] })),
      ).toEqual({ seq: 2, stored: 1, ignored: 0 });
    });
  });

  describe('step 8: crates', () => {
    async function withCrate(session: Session) {
      await booted(session);
      const drops = await dropAsClient(session, crateSpawn.ftueScriptedDrop);
      const crate = drops.flatMap((response) => response.spawnedCrates)[0];
      if (crate === undefined) throw new Error('The scripted drop spawned no crate.');
      return { table: (await state(session)).table, crate };
    }

    it('accepts a crate riding forward at the ride rate', async () => {
      const session = await newSession();
      const { table, crate } = await withCrate(session);
      await elapse(session, 5_000);
      expect(
        await accept(
          session,
          body(table, { seq: 1, tick: 300, crates: [cratePose(crate.id, SPAWN_Z + 5_000, 5_000)] }),
        ),
      ).toEqual({
        seq: 1,
        stored: 1,
        ignored: 0,
      });
      expect((await stored(session))?.cratePoses).toEqual([
        cratePose(crate.id, SPAWN_Z + 5_000, 5_000),
      ]);
    });

    it('farms no crates: a fresh crate posed at the teeter point is refused (crate lip farming)', async () => {
      const session = await newSession();
      const { table, crate } = await withCrate(session);
      await elapse(session, 500);
      expect(
        await accept(session, body(table, { tick: 30, crates: [cratePose(crate.id, 4_500, 500)] })),
      ).toEqual({
        seq: 1,
        stored: 0,
        ignored: 1,
      });
      expect((await stored(session))?.cratePoses).toEqual([]);
      expect(await flags(session)).toMatchObject({ 'snapshot.teleport': 1 });
    });

    it('never lets a crate ride backwards, skip ahead or age faster than real time', async () => {
      const session = await newSession();
      const { table, crate } = await withCrate(session);
      await elapse(session, 4_000);
      const start = cratePose(crate.id, SPAWN_Z + 4_000, 4_000);
      await accept(session, body(table, { seq: 1, tick: 240, crates: [start] }));
      await elapse(session, 500);
      const attempts = [
        cratePose(crate.id, SPAWN_Z + 3_000, 4_500),
        cratePose(crate.id, SPAWN_Z + 14_000, 4_500),
        cratePose(crate.id, SPAWN_Z + 4_100, 9_000),
        cratePose(crate.id, SPAWN_Z + 4_100, 3_000),
      ];
      for (const [i, attempt] of attempts.entries()) {
        await elapse(session, SNAPSHOT_RATE.intervalMs);
        expect(
          await accept(session, body(table, { seq: 2 + i, tick: 270 + i, crates: [attempt] })),
        ).toMatchObject({ stored: 0, ignored: 1 });
      }
      expect((await stored(session))?.cratePoses).toEqual([start]);
      expect(await flags(session)).toMatchObject({ 'snapshot.teleport': attempts.length });
    });

    it('drops an implausible crate pose, ignores a gone crate and flags a forged one', async () => {
      const session = await newSession();
      const { table, crate } = await withCrate(session);
      await elapse(session, 5_000);
      expect(
        await accept(
          session,
          body(table, { seq: 1, tick: 300, crates: [cratePose(crate.id, SPAWN_Z - 100, 0)] }),
        ),
      ).toMatchObject({ stored: 0, ignored: 1 });
      expect(await flags(session)).toMatchObject({ 'snapshot.implausible': 1 });

      await accept(
        session,
        body(table, { seq: 2, tick: 300, crates: [cratePose(FORGED_CRATE_ID, SPAWN_Z, 0)] }),
      );
      expect(await flags(session)).toMatchObject({ 'snapshot.foreign': 1 });

      await claims(session, [{ kind: 'crate', crateId: crate.id, tick: 300, edge: 'front' }]);
      expect(
        await accept(
          session,
          body(table, { seq: 3, tick: 300, crates: [cratePose(crate.id, SPAWN_Z + 100, 100)] }),
        ),
      ).toMatchObject({ stored: 0, ignored: 1 });
      expect(await flags(session)).toMatchObject({
        'snapshot.foreign': 1,
        'snapshot.implausible': 1,
      });
    });
  });

  describe('step 9: omitted entries keep their pose (omitting coins)', () => {
    it('keeps the last pose of every coin and crate the snapshot leaves out', async () => {
      const session = await newSession();
      await booted(session);
      const drops = await dropAsClient(session, crateSpawn.ftueScriptedDrop);
      const crate = drops.flatMap((response) => response.spawnedCrates)[0];
      if (crate === undefined) throw new Error('No crate spawned.');
      const table = (await state(session)).table;
      const [a, b] = table.coins.map((coin) => coin.id);
      if (a === undefined || b === undefined) throw new Error('No heap coins.');
      await elapse(session, 2_000);
      const ride = cratePose(crate.id, SPAWN_Z + 2_000, 2_000);
      await accept(
        session,
        body(table, {
          seq: 1,
          tick: 120,
          coins: [pose(a, 0, -9_000), pose(b, 3_000, -9_000)],
          crates: [ride],
        }),
      );
      await elapse(session, 1_000);
      expect(
        await accept(session, body(table, { seq: 2, tick: 180, coins: [pose(a, 0, -8_000)] })),
      ).toEqual({
        seq: 2,
        stored: 1,
        ignored: 0,
      });
      expect(await stored(session)).toMatchObject({
        seq: 2,
        tick: 180,
        poses: [pose(a, 0, -8_000), pose(b, 3_000, -9_000)],
        cratePoses: [ride],
      });
    });

    it('drops a stored pose once its coin leaves the table', async () => {
      const session = await newSession();
      const table = await booted(session);
      const [a, b] = table.coins.map((coin) => coin.id);
      if (a === undefined || b === undefined) throw new Error('No heap coins.');
      await accept(
        session,
        body(table, { seq: 1, tick: 60, coins: [pose(a, 0, -9_000), pose(b, 3_000, -9_000)] }),
      );
      await claims(session, [{ kind: 'fall', coinId: a, tick: 90, edge: 'front' }]);
      await accept(session, body(table, { seq: 2, tick: 120 }));
      expect((await stored(session))?.poses).toEqual([pose(b, 3_000, -9_000)]);
    });
  });

  describe('step 10: value', () => {
    it('writes nothing to the ledger, wallet, coins, crates or drop counts, accepted or refused', async () => {
      const session = await newSession();
      await booted(session);
      await dropAsClient(session, crateSpawn.ftueScriptedDrop);
      const table = (await state(session)).table;
      const before = await economy(session);
      await elapse(session, 3_000);
      await accept(
        session,
        body(table, {
          seq: 1,
          tick: 120,
          coins: grid(table.coins.map((coin) => coin.id).slice(0, 40)),
        }),
      );
      await accept(
        session,
        body(table, { seq: 2, tick: 130, coins: [pose(FORGED_COIN_ID, 0, 0)] }),
      );
      await expectError(
        await upload(session, body(table, { seq: 2, tick: 140 })),
        409,
        'stale_snapshot',
      );
      await accept(session, body(table, { seq: 3, tick: 150 }));
      await expectError(
        await upload(session, body(table, { seq: 4, tick: 160 })),
        429,
        'rate_limited',
      );
      expect(await economy(session)).toEqual(before);
      await expectConserved(session);
    });
  });

  describe('idempotency', () => {
    it('answers a replayed key with the first response and writes nothing', async () => {
      const session = await newSession();
      const table = await booted(session);
      const a = table.coins[0]?.id ?? '';
      const key = newIdempotencyKey();
      const snapshot = body(table, {
        coins: [pose(a, 0, -9_000), pose(FORGED_COIN_ID, 3_000, -9_000)],
      });
      const first = await upload(session, snapshot, key);
      expect(first.status).toBe(200);
      const answer: unknown = await first.json();
      const row = await stored(session);
      const after = { flags: await flags(session), economy: await economy(session) };

      for (let i = 0; i < 5; i++) {
        const replay = await upload(session, snapshot, key);
        expect(replay.status).toBe(200);
        expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
        expect(await replay.json()).toEqual(answer);
      }
      expect(await stored(session)).toEqual(row);
      expect({ flags: await flags(session), economy: await economy(session) }).toEqual(after);
      await accept(session, body(table, { seq: 2, tick: 120 }));
      await accept(session, body(table, { seq: 3, tick: 180 }));
    });

    it('refuses the same key for a different snapshot', async () => {
      const session = await newSession();
      const table = await booted(session);
      const key = newIdempotencyKey();
      expect((await upload(session, body(table, { seq: 1 }), key)).status).toBe(200);
      await expectError(
        await upload(session, body(table, { seq: 2 }), key),
        422,
        'idempotency_key_reused',
      );
    });
  });
});

describe('snapshot bounds', () => {
  it('refills one token per interval up to the burst, and never from a clock stepped back', () => {
    let take = takeSnapshotToken(null, 10_000);
    const spent: number[] = [];
    for (let i = 0; i < SNAPSHOT_RATE.burst; i++) {
      if (!take.ok) throw new Error('The burst ran out early.');
      spent.push(take.bucket.tokens);
      take = takeSnapshotToken(take.bucket, 10_000);
    }
    expect(spent).toEqual([2, 1, 0]);
    expect(take).toEqual({ ok: false, retryAfterMs: SNAPSHOT_RATE.intervalMs });
    const empty = { tokens: 0, at: 10_000 };
    expect(takeSnapshotToken(empty, 11_000)).toEqual({ ok: false, retryAfterMs: 1_000 });
    expect(takeSnapshotToken(empty, 12_000)).toEqual({
      ok: true,
      bucket: { tokens: 0, at: 12_000 },
    });
    expect(takeSnapshotToken(empty, 0)).toEqual({
      ok: false,
      retryAfterMs: SNAPSHOT_RATE.intervalMs,
    });
    expect(takeSnapshotToken(empty, 10_000 + 3_600_000)).toEqual({
      ok: true,
      bucket: { tokens: SNAPSHOT_RATE.burst - 1, at: 10_000 + 3_600_000 },
    });
  });

  it('takes the shorter of tick time and server time, with the jitter allowance', () => {
    expect(elapsedSeconds(60, 0, 10_000)).toBe(1);
    expect(elapsedSeconds(6_000, 0, 1_000)).toBe((1_000 + COIN_TRAVEL.clockAllowanceMs) / 1000);
    expect(elapsedSeconds(60, 5_000, 0)).toBe(COIN_TRAVEL.clockAllowanceMs / 1000);
    expect(elapsedSeconds(-60, 0, 1_000)).toBe(0);
  });

  it('bounds coin travel by the table speed plus slack', () => {
    const from = pose(FORGED_COIN_ID, 0, 0);
    const edge = Math.round((COIN_TRAVEL.maxSpeed * 1 + COIN_TRAVEL.slack) / 1e-5);
    expect(withinCoinTravel(from, pose(FORGED_COIN_ID, edge, 0), 1)).toBe(true);
    expect(withinCoinTravel(from, pose(FORGED_COIN_ID, edge + 1, 0), 1)).toBe(false);
    expect(withinCoinTravel(from, pose(FORGED_COIN_ID, 2_000, 0), 0)).toBe(true);
    expect(withinCoinTravel(from, pose(FORGED_COIN_ID, 2_001, 0), 0)).toBe(false);
  });

  it('bounds a crate ride forward only, by the pusher, and by real time', () => {
    const at = (z: number, elapsedMs: number) => ({ x: 0, z, elapsedMs, phase: 'riding' as const });
    expect(withinCrateRide(at(0, 0), at(2_000, 1_000), 0)).toBe(true);
    expect(withinCrateRide(at(0, 0), at(2_001, 0), 0)).toBe(false);
    expect(withinCrateRide(at(0, 0), at(-1, 0), 10)).toBe(false);
    expect(withinCrateRide(at(0, 0), at(0, 1_001), 0)).toBe(false);
    expect(withinCrateRide(at(0, 1_000), at(0, 999), 10)).toBe(false);
    expect(withinCrateRide(at(0, 0), at(6_000, 2_000), 1)).toBe(true);
    expect(withinCrateRide(at(0, 0), at(7_000, 2_000), 1)).toBe(false);
  });
});
