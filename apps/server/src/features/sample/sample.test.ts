import { HEADERS } from '@coinposh/shared';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../do/schema.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../../http/cors.ts';
import { API_ORIGIN, newIdempotencyKey } from '../../test/client.ts';
import { expectConserved, expectError } from '../../test/game.ts';
import { createFeatureHarness, type FeaturePlayer } from '../harness.ts';
import { sampleEndpoints } from './endpoints.ts';
import {
  SAMPLE_FEE_COINS,
  SAMPLE_GRANT_COINS,
  SAMPLE_MAX_STAMPS,
  SAMPLE_TX_KIND,
  sampleFeature,
} from './feature.ts';

const harness = createFeatureHarness([sampleFeature]);

type Player = FeaturePlayer<typeof sampleEndpoints>;

interface LegRow extends Record<string, SqlStorageValue> {
  tx_id: string;
  kind: string;
  account: string;
  unit: string;
  delta: number;
  idempotency_key: string | null;
}

function walletCoins(player: Player): Promise<number> {
  return runInDurableObject(
    player.stub,
    (_do, ctx) =>
      ctx.storage.sql
        .exec<{ balance: number }>("SELECT balance FROM wallet WHERE currency = 'coins'")
        .one().balance,
  );
}

function sampleLegs(player: Player): Promise<LegRow[]> {
  return runInDurableObject(player.stub, (_do, ctx) =>
    ctx.storage.sql
      .exec<LegRow>(
        'SELECT tx_id, kind, account, unit, delta, idempotency_key FROM ledger WHERE kind = ? ORDER BY seq',
        SAMPLE_TX_KIND,
      )
      .toArray(),
  );
}

/** The runtime may fire the flush alarm itself between test-driven runs, so wait on flushed_seq. */
async function flushEverything(stub: FeaturePlayer<typeof sampleEndpoints>['stub']): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await runDurableObjectAlarm(stub);
    const pending = await runInDurableObject(stub, async (_instance, ctx) => {
      const sql = ctx.storage.sql;
      const flushed = sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'flushed_seq'")
        .one().value;
      const latest = sql.exec<{ seq: number }>('SELECT MAX(seq) AS seq FROM ledger').one().seq;
      return Number(flushed) !== latest || (await ctx.storage.getAlarm()) !== null;
    });
    if (!pending) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The PlayerDO never flushed its whole ledger to D1.');
}

describe('sample feature: tables', () => {
  it('creates its table at its own version, apart from the core schema version', async () => {
    const player = await harness.player();
    const stored = await runInDurableObject(player.stub, (_do, ctx) => {
      const sql = ctx.storage.sql;
      return {
        versions: sql.exec('SELECT feature, name, version FROM feature_tables').toArray(),
        columns: sql
          .exec<{ name: string }>("SELECT name FROM pragma_table_info('sample_stamps')")
          .toArray()
          .map((row) => row.name),
        schemaVersion: sql.exec<{ version: number }>('SELECT version FROM schema_version').one()
          .version,
      };
    });
    expect(stored.versions).toEqual([{ feature: 'sample', name: 'sample_stamps', version: 2 }]);
    expect(stored.columns).toEqual(['id', 'at', 'motto', 'seal']);
    expect(stored.schemaVersion).toBe(MIGRATIONS.length);
  });
});

describe('sample feature: routes', () => {
  it('serves its GET and POST from the harness worker', async () => {
    const player = await harness.player();
    expect(await player.call('sampleBook')).toEqual({ stamps: [] });
    const { stamp, book } = await player.call('sampleStamp', { motto: 'Fortune favours' });
    expect(stamp.motto).toBe('Fortune favours');
    expect(book.stamps).toEqual([stamp]);
    expect(await player.call('sampleBook')).toEqual({ stamps: [stamp] });
  });

  it('mounts its routes behind device-signed bearer auth', async () => {
    const unsigned = await harness.fetch(
      new Request(`${API_ORIGIN}${sampleEndpoints.sampleBook.path}`),
    );
    await expectError(unsigned, 401, 'unauthorized');

    const player = await harness.player();
    await expectError(
      await player.send('sampleStamp', {
        body: { motto: 'Hi' },
        accessToken: 'forged.token.value',
      }),
      401,
      'unauthorized',
    );
    await expectError(
      await player.send('sampleStamp', { body: { motto: 'Hi' }, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await player.send('sampleStamp', { body: { motto: 'Hi' }, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
  });

  it('stays off the deployed worker until a wiring task registers it', async () => {
    const player = await harness.player();
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}${sampleEndpoints.sampleBook.path}`, {
        headers: { [HEADERS.authorization]: `Bearer ${player.session.tokens.accessToken}` },
      }),
    );
    await expectError(response, 404, 'not_found');
  });
});

describe('sample feature: DO handler and ledger kind', () => {
  it('moves value mint → wallet → house under its own kind and stays conserved', async () => {
    const player = await harness.player();
    const before = await walletCoins(player);
    const { stamp, wallet } = await player.call('sampleStamp', { motto: 'Noblesse' });
    expect(wallet.coins).toBe(before + SAMPLE_GRANT_COINS - SAMPLE_FEE_COINS);
    expect(await walletCoins(player)).toBe(wallet.coins);

    const legs = await sampleLegs(player);
    expect(legs.map(({ account, unit, delta }) => ({ account, unit, delta }))).toEqual([
      { account: 'mint', unit: 'coins', delta: -SAMPLE_GRANT_COINS },
      { account: 'wallet', unit: 'coins', delta: SAMPLE_GRANT_COINS },
      { account: 'wallet', unit: 'coins', delta: -SAMPLE_FEE_COINS },
      { account: 'house', unit: 'coins', delta: SAMPLE_FEE_COINS },
    ]);
    expect(new Set(legs.map((leg) => leg.tx_id)).size).toBe(1);
    expect(legs.every((leg) => leg.idempotency_key !== null)).toBe(true);

    const roll = await runInDurableObject(player.stub, (_do, ctx) =>
      ctx.storage.sql
        .exec<{ purpose: string; ref: string }>('SELECT purpose, ref FROM fair_rolls')
        .toArray(),
    );
    expect(roll).toEqual([{ purpose: 'sample.seal', ref: stamp.id }]);
    await expectConserved(player.session);
  });

  it('flushes its ledger rows to D1 with the core ones', async () => {
    const player = await harness.player();
    await player.call('sampleStamp', { motto: 'Ledger' });
    await flushEverything(player.stub);
    const rows = await env.DB.prepare(
      'SELECT account, delta FROM ledger WHERE player_id = ? AND kind = ? ORDER BY seq',
    )
      .bind(player.playerId, SAMPLE_TX_KIND)
      .all<{ account: string; delta: number }>();
    expect(rows.results.map((row) => row.account)).toEqual(['mint', 'wallet', 'wallet', 'house']);
  });

  it('rolls the row and its legs back together when the handler refuses after writing', async () => {
    const player = await harness.player();
    for (let i = 0; i < SAMPLE_MAX_STAMPS; i++) {
      await player.call('sampleStamp', { motto: `Stamp ${i}` });
    }
    const before = await walletCoins(player);
    const legsBefore = (await sampleLegs(player)).length;

    await expectError(
      await player.send('sampleStamp', { body: { motto: 'One too many' } }),
      409,
      'conflict',
    );

    expect(await walletCoins(player)).toBe(before);
    expect((await sampleLegs(player)).length).toBe(legsBefore);
    expect((await player.call('sampleBook')).stamps).toHaveLength(SAMPLE_MAX_STAMPS);
    await expectConserved(player.session);
  });

  it('replays a retried write instead of paying twice', async () => {
    const player = await harness.player();
    const idempotencyKey = newIdempotencyKey();
    const first = await player.send('sampleStamp', { body: { motto: 'Once' }, idempotencyKey });
    const retry = await player.send('sampleStamp', { body: { motto: 'Once' }, idempotencyKey });
    expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await retry.json()).toEqual(await first.json());
    expect((await player.call('sampleBook')).stamps).toHaveLength(1);
    expect(await sampleLegs(player)).toHaveLength(4);

    await expectError(
      await player.send('sampleStamp', { body: { motto: 'Twice' }, idempotencyKey }),
      422,
      'idempotency_key_reused',
    );
  });

  it('never trusts a value the client sends', async () => {
    const player = await harness.player();
    const before = await walletCoins(player);
    for (const forged of [
      { motto: 'Rich', coins: 1_000_000 },
      { motto: 'Rich', wallet: { coins: 1_000_000 } },
      { motto: 'Rich', seal: 'onyx' },
      { motto: 'Rich', at: 0 },
    ]) {
      await expectError(
        await player.send('sampleStamp', { body: forged }),
        400,
        'validation_failed',
      );
    }
    expect(await walletCoins(player)).toBe(before);
    expect(await sampleLegs(player)).toEqual([]);

    const { wallet } = await player.call('sampleStamp', { motto: 'Honest' });
    expect(wallet.coins).toBe(before + SAMPLE_GRANT_COINS - SAMPLE_FEE_COINS);
    await expectConserved(player.session);
  });
});
