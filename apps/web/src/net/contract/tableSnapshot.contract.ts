import {
  MAX_SNAPSHOT_COINS,
  tableSnapshotEndpoint,
  type CoinId,
  type IdempotencyKey,
  type PoseTuple,
  type StateResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';

/** D7: one upload per 2 s of server time, with a burst of 3. */
export const CONTRACT_SNAPSHOT_RATE = { intervalMs: 2_000, burst: 3 } as const;

export const CONTRACT_FLAG_KINDS = [
  'snapshot.foreign',
  'snapshot.teleport',
  'snapshot.implausible',
] as const;
export type ContractFlags = Record<(typeof CONTRACT_FLAG_KINDS)[number], number>;

export interface ContractResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ContractStored {
  readonly seq: number;
  readonly poses: readonly PoseTuple[];
}

export interface ContractPlayer {
  /** `GET /v1/state?hydrate=boot`, as a page load does. */
  boot(): Promise<StateResponse['table']>;
  /** `GET /v1/state` without booting. */
  state(): Promise<StateResponse['table']>;
  /** Sends `body` exactly as given, signed, under `key` or a fresh one. */
  upload(body: unknown, key?: IdempotencyKey): Promise<ContractResponse>;
  newKey(): IdempotencyKey;
  /** Server time passes by `ms`; negative steps the server clock back. */
  elapse(ms: number): Promise<void>;
  stored(): Promise<ContractStored | null>;
  flags(): Promise<ContractFlags>;
  /** Everything only the server may change: ledger, wallet, coins, crates, drop counters. */
  economy(): Promise<unknown>;
  expectConserved(): Promise<void>;
}

export interface SnapshotContractDriver {
  /** A signed-in player on a fresh server, or on the same one when `alongside` is given. */
  newPlayer(alongside?: ContractPlayer): Promise<ContractPlayer>;
}

const FLAT = [0, 0, 0, 32_767] as const;
const FLOOR_Y = 160;
const FORGED_COIN_ID = 'coin_AAAAAAAAAAAAAAAAAAAA';

export function contractPose(id: string, x: number, z: number): PoseTuple {
  return [id, x, FLOOR_Y, z, ...FLAT, 'asleep'] as PoseTuple;
}

/** Coin i of `ids` on a floor grid at pusher tick 0, none touching another. */
export function contractGrid(ids: readonly string[]): PoseTuple[] {
  return ids.map((id, i) =>
    contractPose(id, -15_000 + (i % 11) * 3_000, -9_000 + Math.floor(i / 11) * 3_000),
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

export function contractBody(
  table: StateResponse['table'],
  overrides: Partial<SnapshotBody> = {},
): SnapshotBody {
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

function expectError(response: ContractResponse, status: number, code: string): void {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body).toMatchObject({ error: { code } });
}

async function accept(player: ContractPlayer, body: unknown) {
  const response = await player.upload(body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return tableSnapshotEndpoint.response.parse(response.body);
}

function coinIds(table: StateResponse['table'], count: number): CoinId[] {
  const ids = table.coins.slice(0, count).map((coin) => coin.id);
  if (ids.length < count) throw new Error(`Expected ${count} heap coins, got ${ids.length}.`);
  return ids;
}

/**
 * The `POST /v1/table/snapshot` contract both servers keep (92-table-persistence 3.2): the
 * Worker and the Demo Mode mock each run these cases through their own driver, so neither can
 * drift from the other on what a compromised client gets away with.
 */
export function tableSnapshotContract(label: string, driver: () => SnapshotContractDriver): void {
  describe(`${label}: POST /v1/table/snapshot contract`, () => {
    it('refuses a session the server never issued', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      expectError(
        await player.upload(contractBody(table, { session: 'session_ForgedForgedForged0' })),
        409,
        'session_superseded',
      );
      expect((await player.stored())?.seq).toBe(0);
    });

    it('fences the older tab once another boot took the table', async () => {
      const player = await driver().newPlayer();
      const first = await player.boot();
      const second = await player.boot();
      expect(second.session).not.toBe(first.session);
      const coins = contractGrid(coinIds(second, 3));
      expectError(await player.upload(contractBody(first, { coins })), 409, 'session_superseded');
      expect(await accept(player, contractBody(second, { coins }))).toEqual({
        seq: 1,
        stored: 3,
        ignored: 0,
      });
    });

    it('refuses a seq that is not after the stored one (replayed snapshot)', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      await accept(player, contractBody(table, { seq: 5, tick: 60 }));
      for (const seq of [5, 4]) {
        expectError(
          await player.upload(contractBody(table, { seq, tick: 120 })),
          409,
          'stale_snapshot',
        );
      }
      expect((await player.stored())?.seq).toBe(5);
    });

    it('refuses a tick before the stored snapshot', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      await accept(player, contractBody(table, { seq: 1, tick: 600 }));
      expectError(
        await player.upload(contractBody(table, { seq: 2, tick: 599 })),
        409,
        'stale_snapshot',
      );
      expect(await accept(player, contractBody(table, { seq: 2, tick: 600 }))).toMatchObject({
        seq: 2,
      });
    });

    it('allows a burst, then answers rate_limited with retryAfterMs (flood)', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const { burst, intervalMs } = CONTRACT_SNAPSHOT_RATE;
      for (let seq = 1; seq <= burst; seq++) {
        await accept(player, contractBody(table, { seq, tick: seq * 60 }));
      }
      const limited = await player.upload(contractBody(table, { seq: burst + 1, tick: 240 }));
      expectError(limited, 429, 'rate_limited');
      const retryAfterMs = (limited.body as { error: { retryAfterMs: number } }).error.retryAfterMs;
      expect(retryAfterMs).toBeGreaterThan(intervalMs - 500);
      expect(retryAfterMs).toBeLessThanOrEqual(intervalMs);
      expect((await player.stored())?.seq).toBe(burst);

      await player.elapse(intervalMs);
      await accept(player, contractBody(table, { seq: burst + 1, tick: 240 }));
      expectError(
        await player.upload(contractBody(table, { seq: burst + 2, tick: 300 })),
        429,
        'rate_limited',
      );
    });

    it('earns no tokens when the server clock steps back', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      for (let seq = 1; seq <= CONTRACT_SNAPSHOT_RATE.burst; seq++) {
        await accept(player, contractBody(table, { seq, tick: seq * 60 }));
      }
      await player.elapse(-60 * 60 * 1000);
      expectError(
        await player.upload(contractBody(table, { seq: 4, tick: 240 })),
        429,
        'rate_limited',
      );
    });

    it('spends no token on a refused snapshot', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      await accept(player, contractBody(table, { seq: 2, tick: 60 }));
      for (let i = 0; i < 5; i++) {
        expectError(
          await player.upload(contractBody(table, { seq: 1, tick: 60 })),
          409,
          'stale_snapshot',
        );
      }
      await accept(player, contractBody(table, { seq: 3, tick: 120 }));
      await accept(player, contractBody(table, { seq: 4, tick: 180 }));
    });

    it('does not refill the bucket when the player boots again', async () => {
      const player = await driver().newPlayer();
      let table = await player.boot();
      for (let seq = 1; seq <= CONTRACT_SNAPSHOT_RATE.burst; seq++) {
        await accept(player, contractBody(table, { seq, tick: seq * 60 }));
      }
      table = await player.boot();
      expectError(
        await player.upload(contractBody(table, { seq: 1, tick: 60 })),
        429,
        'rate_limited',
      );
    });

    it('caps a snapshot at MAX_SNAPSHOT_COINS poses', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const coins = Array.from({ length: MAX_SNAPSHOT_COINS + 1 }, (_, i) =>
        contractPose(`coin_${String(i).padStart(20, '0')}`, 0, 0),
      );
      expectError(await player.upload(contractBody(table, { coins })), 400, 'validation_failed');
    });

    it('refuses a pusher phase outside its cycle', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      expectError(
        await player.upload(contractBody(table, { pusher: { tickInCycle: 240 } })),
        400,
        'bad_request',
      );
    });

    it('refuses a coin posed twice', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const [id = ''] = coinIds(table, 1);
      expectError(
        await player.upload(
          contractBody(table, { coins: [contractPose(id, 0, 0), contractPose(id, 3_000, 0)] }),
        ),
        400,
        'validation_failed',
      );
    });

    it('refuses any value, tier or wallet field the client slips in', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const before = await player.economy();
      for (const extra of [{ value: 1_000 }, { wallet: { coins: 1_000 } }, { tier: 'gold' }]) {
        expectError(
          await player.upload({ ...contractBody(table), ...extra }),
          400,
          'validation_failed',
        );
      }
      const [id = ''] = coinIds(table, 1);
      expectError(
        await player.upload(contractBody(table, { coins: [[...contractPose(id, 0, 0), 1_000]] })),
        400,
        'validation_failed',
      );
      expect(await player.economy()).toEqual(before);
    });

    it('ignores and flags coins this player does not own (forged ids)', async () => {
      const player = await driver().newPlayer();
      const other = await driver().newPlayer(player);
      const [theirs = ''] = coinIds(await other.state(), 1);
      const table = await player.boot();
      const [mine = ''] = coinIds(table, 1);
      const result = await accept(
        player,
        contractBody(table, {
          coins: [
            contractPose(mine, 0, -9_000),
            contractPose(FORGED_COIN_ID, 3_000, -9_000),
            contractPose(theirs, 6_000, -9_000),
          ],
        }),
      );
      expect(result).toEqual({ seq: 1, stored: 1, ignored: 2 });
      expect((await player.stored())?.poses.map((tuple) => tuple[0])).toEqual([mine]);
      expect(await player.flags()).toMatchObject({ 'snapshot.foreign': 2 });
    });

    it('ignores and flags a buffer coin posed onto the table, which stays in the buffer', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const reserved = table.buffer[0]?.id ?? '';
      const before = await player.economy();
      expect(
        await accept(player, contractBody(table, { coins: [contractPose(reserved, 0, -9_000)] })),
      ).toEqual({ seq: 1, stored: 0, ignored: 1 });
      expect(await player.economy()).toEqual(before);
      expect(await player.flags()).toMatchObject({ 'snapshot.foreign': 1 });
      const after = await player.boot();
      expect(after.buffer.map((coin) => coin.id)).toContain(reserved);
      expect(after.coins.map((coin) => coin.id)).not.toContain(reserved);
    });

    it('keeps the old pose of a coin that jumped across the table, and flags it', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const [a = '', b = ''] = coinIds(table, 2);
      await accept(
        player,
        contractBody(table, {
          seq: 1,
          tick: 60,
          coins: [contractPose(a, -15_000, -9_000), contractPose(b, 0, -9_000)],
        }),
      );
      await player.elapse(100);
      const result = await accept(
        player,
        contractBody(table, {
          seq: 2,
          tick: 66,
          coins: [contractPose(a, 15_000, -9_000), contractPose(b, 0, -8_800)],
        }),
      );
      expect(result).toEqual({ seq: 2, stored: 1, ignored: 1 });
      expect((await player.stored())?.poses).toEqual([
        contractPose(a, -15_000, -9_000),
        contractPose(b, 0, -8_800),
      ]);
      expect(await player.flags()).toMatchObject({ 'snapshot.teleport': 1 });
    });

    it('judges travel by server time, so fast-forwarded ticks buy no longer move (clock skew)', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const [a = ''] = coinIds(table, 1);
      await accept(
        player,
        contractBody(table, { seq: 1, tick: 60, coins: [contractPose(a, -15_000, -9_000)] }),
      );
      await player.elapse(100);
      expect(
        await accept(
          player,
          contractBody(table, {
            seq: 2,
            tick: 60 + 600 * 60,
            coins: [contractPose(a, 15_000, -9_000)],
          }),
        ),
      ).toMatchObject({ stored: 0, ignored: 1 });
      expect(await player.flags()).toMatchObject({ 'snapshot.teleport': 1 });
    });

    it('lets a coin travel as far as real time allows', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const [a = ''] = coinIds(table, 1);
      await accept(
        player,
        contractBody(table, { seq: 1, tick: 60, coins: [contractPose(a, -15_000, -9_000)] }),
      );
      await player.elapse(1_000);
      expect(
        await accept(
          player,
          contractBody(table, { seq: 2, tick: 120, coins: [contractPose(a, 15_000, -9_000)] }),
        ),
      ).toEqual({ seq: 2, stored: 1, ignored: 0 });
    });

    it('writes no value, accepted or refused, and the ledger stays conserved', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const before = await player.economy();
      await player.elapse(3_000);
      await accept(
        player,
        contractBody(table, { seq: 1, tick: 120, coins: contractGrid(coinIds(table, 20)) }),
      );
      await accept(
        player,
        contractBody(table, { seq: 2, tick: 130, coins: [contractPose(FORGED_COIN_ID, 0, 0)] }),
      );
      expectError(
        await player.upload(contractBody(table, { seq: 2, tick: 140 })),
        409,
        'stale_snapshot',
      );
      await accept(player, contractBody(table, { seq: 3, tick: 150 }));
      expectError(
        await player.upload(contractBody(table, { seq: 4, tick: 160 })),
        429,
        'rate_limited',
      );
      expect(await player.economy()).toEqual(before);
      await player.expectConserved();
    });

    it('answers a replayed key with the first response and writes nothing (replay)', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const [a = ''] = coinIds(table, 1);
      const key = player.newKey();
      const snapshot = contractBody(table, {
        coins: [contractPose(a, 0, -9_000), contractPose(FORGED_COIN_ID, 3_000, -9_000)],
      });
      const first = await player.upload(snapshot, key);
      expect(first.status).toBe(200);
      const row = await player.stored();
      const after = { flags: await player.flags(), economy: await player.economy() };
      for (let i = 0; i < 5; i++) {
        const replay = await player.upload(snapshot, key);
        expect(replay).toEqual(first);
      }
      expect(await player.stored()).toEqual(row);
      expect({ flags: await player.flags(), economy: await player.economy() }).toEqual(after);
      await accept(player, contractBody(table, { seq: 2, tick: 120 }));
      await accept(player, contractBody(table, { seq: 3, tick: 180 }));
    });

    it('refuses the same key for a different snapshot', async () => {
      const player = await driver().newPlayer();
      const table = await player.boot();
      const key = player.newKey();
      expect((await player.upload(contractBody(table, { seq: 1 }), key)).status).toBe(200);
      expectError(
        await player.upload(contractBody(table, { seq: 2 }), key),
        422,
        'idempotency_key_reused',
      );
    });
  });
}
