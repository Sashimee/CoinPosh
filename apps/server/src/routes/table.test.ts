import { coinTiers, crateSpawn, fusion, fusionValue, openingHeap } from '@coinposh/economy';
import {
  endpoints,
  MAX_CLAIMS_PER_BATCH,
  tableSnapshotEndpoint,
  type MintedCoin,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mintedValue } from '../do/entities.ts';
import { PREMINT_BUFFER_TARGET, type PlayerDO } from '../do/PlayerDO.ts';
import { newIdempotencyKey, newSession, signParts, type Session } from '../test/client.ts';
import {
  claims,
  drop,
  dropAsClient,
  expectConserved,
  expectError,
  playerStub,
  reload,
  state,
  vaultCoins,
} from '../test/game.ts';

const COPPER = coinTiers[0];
const FORGED_COIN_ID = 'coin_AAAAAAAAAAAAAAAAAAAA';

async function dropMany(session: Session, count: number, tick = 0): Promise<MintedCoin[]> {
  return (await dropAsClient(session, count, () => tick)).map((response) => response.coin);
}

/** The table's coins other than the opening heap, which every new player starts on. */
async function droppedOnTable(session: Session): Promise<MintedCoin[]> {
  const coins = (await state(session)).table.coins;
  expect(coins.slice(0, openingHeap.coins).every((coin) => coin.tier === openingHeap.tier)).toBe(
    true,
  );
  return coins.slice(openingHeap.coins);
}

function fall(coin: { id: string }, edge: 'front' | 'left' | 'right' = 'front', tick = 10) {
  return { kind: 'fall', coinId: coin.id, tick, edge };
}

describe('POST /v1/table/drop', () => {
  it('debits the drop cost and mints a server-valued coin onto the table', async () => {
    const session = await newSession();
    const before = await state(session);
    const result = await drop(session, { x: 0.25, tick: 3 });

    expect(result.coin.id).toMatch(/^coin_[0-9A-Za-z]{20}$/);
    expect(result.coin.tier).toBe(COPPER.id);
    expect(result.coin.value).toBe(COPPER.value);
    expect(result.wallet.coins).toBe(before.wallet.coins - COPPER.value);
    expect((await droppedOnTable(session)).map((coin) => coin.id)).toEqual([result.coin.id]);
    await expectConserved(session);
  });

  it('refuses a forged value, tier, timestamp or out-of-range aim and moves no coins', async () => {
    const session = await newSession();
    const before = await state(session);
    for (const forged of [
      { x: 0, tick: 0, value: 1_000_000 },
      { x: 0, tick: 0, tier: 'heirloom' },
      { x: 0, tick: 0, at: Date.now() + 86_400_000 },
      { x: 2, tick: 0 },
      { x: 0, tick: -1 },
      { x: 0, tick: 0.5 },
    ]) {
      await expectError(
        await session.call(endpoints.tableDrop.path, { body: forged }),
        400,
        'validation_failed',
      );
    }
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.table).toEqual(before.table);
  });

  it('spends a prepaid buffer coin once, costing the Vault one drop and no more', async () => {
    const session = await newSession();
    const before = await state(session);
    const vaultBefore = await vaultCoins(session);
    const buffered = before.table.buffer[0];
    if (buffered === undefined) throw new Error('A new player should have a buffer.');

    const result = await drop(session, { coinId: buffered.id, tick: 1 });
    expect(result.coin).toEqual(buffered);
    expect(result.buffer).toHaveLength(PREMINT_BUFFER_TARGET);
    expect(result.buffer.map((coin) => coin.id)).not.toContain(buffered.id);
    expect(result.wallet.coins).toBe(before.wallet.coins - COPPER.value);
    expect(await vaultCoins(session)).toBe(vaultBefore - COPPER.value);
    expect((await droppedOnTable(session)).map((coin) => coin.id)).toEqual([buffered.id]);

    await expectError(
      await session.call(endpoints.tableDrop.path, {
        body: { x: 0, tick: 2, coinId: buffered.id },
      }),
      409,
      'conflict',
    );
    await expectConserved(session);
  });

  it('refuses forged or foreign buffer coin IDs', async () => {
    const session = await newSession();
    const other = await newSession();
    const foreign = (await state(other)).table.buffer[0];
    if (foreign === undefined) throw new Error('A new player should have a buffer.');

    for (const coinId of [FORGED_COIN_ID, foreign.id]) {
      await expectError(
        await session.call(endpoints.tableDrop.path, { body: { x: 0, tick: 0, coinId } }),
        404,
        'not_found',
      );
    }
    await expectError(
      await session.call(endpoints.tableDrop.path, {
        body: { x: 0, tick: 0, coinId: 'crate_AAAAAAAAAAAAAAAAAAAA' },
      }),
      400,
      'validation_failed',
    );
    expect((await state(other)).table.buffer.map((coin) => coin.id)).toContain(foreign.id);
  });

  it('prepays each reservation from the wallet, so wallet plus buffer is the starting grant', async () => {
    const session = await newSession();
    const { wallet, table } = await state(session);
    const report = await playerStub(session.tokens.playerId).conservation();
    expect(report.walletCoins).toBe(wallet.coins);
    expect(report.ledger.wallet).toBe(wallet.coins);
    expect(report.bufferCoins).toBe(table.buffer.length);
    expect(report.ledger.buffer).toBe(table.buffer.length * COPPER.value);
    expect(report.bufferPaid).toBe(report.ledger.buffer);
    expect(table.buffer).toHaveLength(PREMINT_BUFFER_TARGET);
    await expectConserved(session);
  });

  it('never spends a reserved coin for a drop without coinId, and refuses one nothing pays for', async () => {
    const session = await newSession();
    const { wallet, table } = await state(session);
    const fresh: MintedCoin[] = [];
    for (let i = 0; i < wallet.coins / COPPER.value; i++) fresh.push((await drop(session)).coin);
    expect(fresh.every((coin) => !table.buffer.some((b) => b.id === coin.id))).toBe(true);
    const after = await state(session);
    expect(after.wallet.coins).toBe(0);
    expect(after.table.buffer.map((coin) => coin.id)).toEqual(table.buffer.map((coin) => coin.id));

    await expectError(
      await session.call(endpoints.tableDrop.path, { body: { x: 0, tick: 0 } }),
      409,
      'insufficient_funds',
    );
    const [reserved, next] = after.table.buffer;
    if (reserved === undefined || next === undefined) {
      throw new Error('A new player should have a buffer.');
    }
    const spent = await drop(session, { coinId: reserved.id });
    expect(spent.wallet.coins).toBe(0);
    expect(spent.buffer.map((coin) => coin.id)).toEqual(
      after.table.buffer.slice(1).map((coin) => coin.id),
    );
    await expectError(
      await session.call(endpoints.tableDrop.path, {
        body: { x: 0, tick: 0, coinId: reserved.id },
      }),
      409,
      'conflict',
    );
    const final = await state(session);
    expect(final.wallet.coins).toBe(0);
    expect(final.table.buffer.map((coin) => coin.id)).toContain(next.id);
    expect(await droppedOnTable(session)).toHaveLength(fresh.length + 1);
    await expectConserved(session);
  });

  it('reconciles an offline run of reserved drops in order, without refusing any', async () => {
    const session = await newSession();
    const { table } = await state(session);
    for (const [i, coin] of table.buffer.entries()) {
      expect((await drop(session, { coinId: coin.id, tick: i })).coin.id).toBe(coin.id);
    }
    await expectConserved(session);
  });

  it('spawns the scripted FTUE crate on the scripted drop and only then', async () => {
    const session = await newSession();
    const drops = await dropAsClient(session, crateSpawn.ftueScriptedDrop);
    const spawned = drops.flatMap((result, i) => (result.spawnedCrates.length > 0 ? [i + 1] : []));
    expect(spawned).toEqual([crateSpawn.ftueScriptedDrop]);
    expect((await state(session)).table.crates).toHaveLength(1);
    await expectConserved(session);
  });
});

describe('POST /v1/table/claims', () => {
  it('credits the value the server stored for a coin that fell off the front', async () => {
    const session = await newSession();
    const [coin] = await dropMany(session, 1);
    if (coin === undefined) throw new Error('drop failed');
    const before = await state(session);
    const result = await claims(session, [fall(coin)]);
    expect(result.results).toEqual([
      { status: 'accepted', credited: coin.value, cascade: null, minted: null },
    ]);
    expect(result.wallet.coins).toBe(before.wallet.coins + coin.value);
    await expectConserved(session);
  });

  it('rejects a double claim, across batches and within one batch', async () => {
    const session = await newSession();
    const [a, b] = await dropMany(session, 2);
    if (a === undefined || b === undefined) throw new Error('drop failed');

    const first = await claims(session, [fall(a)]);
    const second = await claims(session, [fall(a), fall(a, 'left')]);
    expect(second.results).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    expect(second.wallet).toEqual(first.wallet);

    const within = await claims(session, [fall(b), fall(b)]);
    expect(within.results).toEqual([
      { status: 'accepted', credited: b.value, cascade: null, minted: null },
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    expect(within.wallet.coins).toBe(first.wallet.coins + b.value);
    await expectConserved(session);
  });

  it('rejects unknown IDs, other players coins and coins that never left the buffer', async () => {
    const session = await newSession();
    const other = await newSession();
    const [theirs] = await dropMany(other, 1);
    const { table, wallet } = await state(session);
    const buffered = table.buffer[0];
    if (theirs === undefined || buffered === undefined) throw new Error('setup failed');

    const result = await claims(session, [
      fall({ id: FORGED_COIN_ID }),
      fall(theirs),
      fall(buffered),
      { kind: 'crate', crateId: 'crate_AAAAAAAAAAAAAAAAAAAA', tick: 1, edge: 'front' },
    ]);
    expect(result.results).toEqual([
      { status: 'rejected', reason: 'unknown_entity' },
      { status: 'rejected', reason: 'unknown_entity' },
      { status: 'rejected', reason: 'not_on_table' },
      { status: 'rejected', reason: 'unknown_entity' },
    ]);
    expect(result.wallet).toEqual(wallet);
    expect((await claims(other, [fall(theirs)])).results[0]?.status).toBe('accepted');
  });

  it('rejects malformed and cross-kind IDs at the contract', async () => {
    const session = await newSession();
    for (const coinId of ['coin_short', 'crate_AAAAAAAAAAAAAAAAAAAA', "coin_A' OR 1=1 --", '']) {
      await expectError(
        await session.call(endpoints.tableClaims.path, {
          body: { claims: [{ kind: 'fall', coinId, tick: 0, edge: 'front' }] },
        }),
        400,
        'validation_failed',
      );
    }
  });

  it('ignores forged values: a claim carrying its own value is refused outright', async () => {
    const session = await newSession();
    const [coin] = await dropMany(session, 1);
    if (coin === undefined) throw new Error('drop failed');
    const before = await state(session);

    for (const extra of [{ value: 1_000_000 }, { credited: 1_000_000 }, { tier: 'heirloom' }]) {
      await expectError(
        await session.call(endpoints.tableClaims.path, {
          body: { claims: [{ ...fall(coin), ...extra }] },
        }),
        400,
        'validation_failed',
      );
    }
    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body: { claims: [fall(coin)], wallet: { coins: 1_000_000 } },
      }),
      400,
      'validation_failed',
    );
    expect((await state(session)).wallet).toEqual(before.wallet);

    const honest = await claims(session, [fall(coin)]);
    expect(honest.results[0]).toMatchObject({ status: 'accepted', credited: coin.value });
    expect(honest.wallet.coins).toBe(before.wallet.coins + coin.value);
  });

  it('refuses a claim stamped before the coin was dropped', async () => {
    const session = await newSession();
    const result = await drop(session, { tick: 500 });
    const early = await claims(session, [fall(result.coin, 'front', 499)]);
    expect(early.results).toEqual([{ status: 'rejected', reason: 'not_on_table' }]);
    const onTime = await claims(session, [fall(result.coin, 'front', 500)]);
    expect(onTime.results[0]?.status).toBe('accepted');
  });

  it('sends side-gutter falls to the house without crediting the wallet', async () => {
    const session = await newSession();
    const [left, right] = await dropMany(session, 2);
    if (left === undefined || right === undefined) throw new Error('drop failed');
    const before = await state(session);
    const result = await claims(session, [fall(left, 'left'), fall(right, 'right')]);
    expect(result.results).toEqual([
      { status: 'accepted', credited: 0, cascade: null, minted: null },
      { status: 'accepted', credited: 0, cascade: null, minted: null },
    ]);
    expect(result.wallet).toEqual(before.wallet);
    expect(await droppedOnTable(session)).toEqual([]);
    const report = await playerStub(session.tokens.playerId).conservation();
    const heapStake = openingHeap.coins * mintedValue(openingHeap.tier, {});
    expect(report.ledger.house).toBe(left.value + right.value - heapStake);
    await expectConserved(session);
  });

  it('fuses three same-tier coins into the next tier at the configured value', async () => {
    const session = await newSession();
    const inputs = await dropMany(session, 3);
    const result = await claims(session, [
      { kind: 'fusion', coinIds: inputs.map((coin) => coin.id), tick: 5 },
    ]);
    const expectedValue = Math.floor(
      fusionValue(
        inputs.map((coin) => coin.value),
        fusion,
      ),
    );
    expect(result.results[0]).toMatchObject({
      status: 'accepted',
      credited: 0,
      minted: { tier: COPPER.fusesInto, value: expectedValue },
    });
    const table = await droppedOnTable(session);
    expect(table).toHaveLength(1);
    expect(table[0]?.tier).toBe(COPPER.fusesInto);

    const reuse = await claims(session, [fall(inputs[0] ?? { id: FORGED_COIN_ID })]);
    expect(reuse.results).toEqual([{ status: 'rejected', reason: 'already_claimed' }]);
    await expectConserved(session);
  });

  it('rejects a fusion of mixed tiers and consumes none of its coins', async () => {
    const session = await newSession();
    const coppers = await dropMany(session, 5);
    const fused = await claims(session, [
      { kind: 'fusion', coinIds: coppers.slice(0, 3).map((coin) => coin.id), tick: 5 },
    ]);
    const silver = fused.results[0]?.status === 'accepted' ? fused.results[0].minted : null;
    if (silver === null) throw new Error('fusion setup failed');

    const mixed = await claims(session, [
      { kind: 'fusion', coinIds: [silver.id, ...coppers.slice(3).map((coin) => coin.id)], tick: 6 },
    ]);
    expect(mixed.results).toEqual([{ status: 'rejected', reason: 'tier_mismatch' }]);
    expect(await droppedOnTable(session)).toHaveLength(3);

    const rest = await claims(session, [
      fall(silver),
      ...coppers.slice(3).map((coin) => fall(coin)),
    ]);
    expect(rest.results.every((result) => result.status === 'accepted')).toBe(true);
    await expectConserved(session);
  });

  it('rejects fusions that reuse a coin, include a claimed coin or exceed the top tier', async () => {
    const session = await newSession();
    const coins = await dropMany(session, 3);
    const ids = coins.map((coin) => coin.id);
    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body: { claims: [{ kind: 'fusion', coinIds: [ids[0], ids[0], ids[1]], tick: 1 }] },
      }),
      400,
      'validation_failed',
    );

    const claimedFirst = await claims(session, [
      fall(coins[0] ?? { id: FORGED_COIN_ID }),
      { kind: 'fusion', coinIds: ids, tick: 11 },
    ]);
    expect(claimedFirst.results[1]).toEqual({ status: 'rejected', reason: 'already_claimed' });

    const stub = playerStub(session.tokens.playerId);
    const heirlooms = [
      'coin_HeirloomTestCoin0001',
      'coin_HeirloomTestCoin0002',
      'coin_HeirloomTestCoin0003',
    ];
    await runInDurableObject(stub, (_instance: PlayerDO, ctx) => {
      for (const id of heirlooms) {
        ctx.storage.sql.exec(
          "INSERT INTO coins (id, tier, value, state, dropped_tick, minted_at) VALUES (?, 'heirloom', 0, 'table', 0, 0)",
          id,
        );
      }
    });
    const top = await claims(session, [{ kind: 'fusion', coinIds: heirlooms, tick: 1 }]);
    expect(top.results).toEqual([{ status: 'rejected', reason: 'max_tier' }]);
  });

  it('keeps a crate pushed off the front and loses one down the side', async () => {
    const session = await newSession();
    await dropMany(session, crateSpawn.ftueScriptedDrop);
    const crate = (await state(session)).table.crates[0];
    if (crate === undefined) throw new Error('no crate spawned');

    const claim = { kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' };
    const kept = await claims(session, [claim, claim]);
    expect(kept.results).toEqual([
      { status: 'accepted', credited: 0, cascade: null, minted: null },
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    expect((await state(session)).table.crates).toEqual([]);
    const report = await playerStub(session.tokens.playerId).conservation();
    expect(report.tableCrates).toBe(0);
    await expectConserved(session);
  });

  it('answers a bot flooding forged claims with rejections and no value', async () => {
    const session = await newSession();
    const { wallet } = await state(session);
    const forged = Array.from({ length: MAX_CLAIMS_PER_BATCH }, (_, i) =>
      fall({ id: `coin_${String(i).padStart(20, 'Z')}` }),
    );
    const result = await claims(session, forged);
    expect(result.results.every((r) => r.status === 'rejected')).toBe(true);
    expect(result.wallet).toEqual(wallet);

    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body: { claims: [...forged, fall({ id: FORGED_COIN_ID })] },
      }),
      400,
      'validation_failed',
    );
    await expectError(
      await session.call(endpoints.tableClaims.path, { body: { claims: [] } }),
      400,
      'validation_failed',
    );
  });
});

describe('idempotency', () => {
  it('replays a retried claim from cache and credits it only once', async () => {
    const session = await newSession();
    const [coin] = await dropMany(session, 1);
    if (coin === undefined) throw new Error('drop failed');
    const idempotencyKey = newIdempotencyKey();
    const body = { claims: [fall(coin)] };

    const first = await session.call(endpoints.tableClaims.path, { body, idempotencyKey });
    const retry = await session.call(endpoints.tableClaims.path, { body, idempotencyKey });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    expect(retry.headers.get('Idempotent-Replayed')).toBe('true');
    const firstBody: unknown = await first.json();
    expect(await retry.json()).toEqual(firstBody);
    expect((await state(session)).wallet).toEqual(
      endpoints.tableClaims.response.parse(firstBody).wallet,
    );
    await expectConserved(session);
  });

  it('replays a retried drop without debiting or minting twice', async () => {
    const session = await newSession();
    const before = await state(session);
    const idempotencyKey = newIdempotencyKey();
    const body = { x: 0, tick: 0 };
    const first = await session.call(endpoints.tableDrop.path, { body, idempotencyKey });
    const retry = await session.call(endpoints.tableDrop.path, { body, idempotencyKey });
    expect(await retry.json()).toEqual(await first.json());
    const after = await state(session);
    expect(await droppedOnTable(session)).toHaveLength(1);
    expect(after.wallet.coins).toBe(before.wallet.coins - COPPER.value);
  });

  it('refuses a key reused for a different request or route', async () => {
    const session = await newSession();
    const [a, b] = await dropMany(session, 2);
    if (a === undefined || b === undefined) throw new Error('drop failed');
    const idempotencyKey = newIdempotencyKey();
    await claims(session, [fall(a)]);
    expect(
      (
        await session.call(endpoints.tableClaims.path, {
          body: { claims: [fall(b)] },
          idempotencyKey,
        })
      ).status,
    ).toBe(200);
    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body: { claims: [fall(a)] },
        idempotencyKey,
      }),
      422,
      'idempotency_key_reused',
    );
    await expectError(
      await session.call(endpoints.tableDrop.path, { body: { x: 0, tick: 0 }, idempotencyKey }),
      422,
      'idempotency_key_reused',
    );
  });

  it('requires an Idempotency-Key on every mutation', async () => {
    const session = await newSession();
    await expectError(
      await session.call(endpoints.tableDrop.path, {
        body: { x: 0, tick: 0 },
        idempotencyKey: null,
      }),
      400,
      'idempotency_key_missing',
    );
  });

  it('does not let a captured request be replayed with a fresh key', async () => {
    const session = await newSession();
    const [coin] = await dropMany(session, 1);
    if (coin === undefined) throw new Error('drop failed');
    const captured = newIdempotencyKey();
    const body = { claims: [fall(coin)] };
    expect(
      (await session.call(endpoints.tableClaims.path, { body, idempotencyKey: captured })).status,
    ).toBe(200);

    const signedForCaptured = await signParts(
      session.device.privateKey,
      'POST',
      endpoints.tableClaims.path,
      captured,
      JSON.stringify(body),
    );
    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body,
        idempotencyKey: newIdempotencyKey(),
        signature: signedForCaptured,
      }),
      401,
      'invalid_signature',
    );
  });
});

describe('POST /v1/table/snapshot', () => {
  async function snapshotBody(session: Session) {
    const { table } = await reload(session);
    const coin = table.coins[0];
    if (table.session === undefined || coin === undefined) {
      throw new Error('A boot should return a session and the opening heap.');
    }
    return {
      session: table.session,
      seq: 1,
      tick: 60,
      pusher: { tickInCycle: 0 },
      coins: [[coin.id, 0, 160, -9_000, 0, 0, 0, 32_767, 'asleep']],
      crates: [],
    };
  }

  it('stores a signed snapshot and answers with the contract response', async () => {
    const session = await newSession();
    const body = await snapshotBody(session);
    const response = await session.call(tableSnapshotEndpoint.path, { body });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(tableSnapshotEndpoint.response.parse(await response.json())).toEqual({
      seq: 1,
      stored: 1,
      ignored: 0,
    });
  });

  it('requires a sign-in, a device signature over the body and an Idempotency-Key', async () => {
    const session = await newSession();
    const body = await snapshotBody(session);
    await expectError(
      await session.call(tableSnapshotEndpoint.path, { body, accessToken: 'forged.token.value' }),
      401,
      'unauthorized',
    );
    await expectError(
      await session.call(tableSnapshotEndpoint.path, { body, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(tableSnapshotEndpoint.path, {
        body,
        signBody: JSON.stringify({ ...body, seq: 2 }),
      }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(tableSnapshotEndpoint.path, { body, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    expect((await session.call(tableSnapshotEndpoint.path, { body })).status).toBe(200);
  });

  it('refuses a body that is not JSON or not a snapshot', async () => {
    const session = await newSession();
    await expectError(
      await session.call(tableSnapshotEndpoint.path, { body: '{"session":' }),
      400,
      'bad_request',
    );
    await expectError(
      await session.call(tableSnapshotEndpoint.path, { body: { coins: [] } }),
      400,
      'validation_failed',
    );
  });
});
