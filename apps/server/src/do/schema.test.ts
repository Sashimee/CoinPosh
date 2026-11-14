import { coinTiers, openingHeap, venues } from '@coinposh/economy';
import { CURRENCIES, ENTITY_ID_PREFIXES, PlayerIdSchema } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newSession } from '../test/client.ts';
import { claims, dropAsClient, expectConserved, playerStub, reload, state } from '../test/game.ts';
import { mintedValue } from './entities.ts';
import { PlayerDO, PREMINT_BUFFER_TARGET } from './PlayerDO.ts';
import { grantScratchCard } from '../routes/scratch.ts';
import { MIGRATIONS } from './schema.ts';

const COPPER = coinTiers[0];
const STARTING_COINS = 20;
const DROPPED_VALUE = mintedValue(COPPER.id, {});

function migrationIndex(marker: string): number {
  const index = MIGRATIONS.findIndex((migration) => migration.includes(marker));
  if (index < 0) throw new Error(`No PlayerDO migration contains "${marker}".`);
  return index;
}

function coinId(n: number): string {
  return `${ENTITY_ID_PREFIXES.coin}_${String(n).padStart(20, '0')}`;
}

/**
 * Writes the rows the first deployed PlayerDO left behind: a starting grant, a buffer reserved
 * without debiting the wallet, three wallet-paid drops of which one already fell to the front.
 */
function storeV1Player(sql: SqlStorage, playerId: string): void {
  for (const { name } of sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .toArray()) {
    sql.exec(`DROP TABLE "${name}"`);
  }
  sql.exec(MIGRATIONS[0] ?? '');
  sql.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  sql.exec('INSERT INTO schema_version (version) VALUES (1)');

  const meta = {
    player_id: playerId,
    display_name: 'V1PL',
    locale: 'en',
    created_at: '0',
    drop_count: '3',
    flushed_seq: '0',
    fair_server_seed: '00'.repeat(32),
    fair_server_seed_hash: 'ab'.repeat(32),
    fair_client_seed: 'v1clientseed0000',
    fair_nonce: '0',
  };
  for (const [key, value] of Object.entries(meta)) {
    sql.exec('INSERT INTO meta (key, value) VALUES (?, ?)', key, value);
  }
  for (const currency of CURRENCIES) {
    sql.exec(
      'INSERT INTO wallet (currency, balance) VALUES (?, ?)',
      currency,
      currency === 'coins' ? STARTING_COINS - 3 * COPPER.value + DROPPED_VALUE : 0,
    );
  }

  let seq = 0;
  const leg = (tx: string, kind: string, account: string, delta: number, ref: string | null) => {
    seq += 1;
    sql.exec(
      'INSERT INTO ledger (seq, tx_id, at, kind, account, unit, delta, ref, idempotency_key) VALUES (?, ?, 0, ?, ?, ?, ?, ?, NULL)',
      seq,
      tx,
      kind,
      account,
      'coins',
      delta,
      ref,
    );
  };
  leg('tx_grant', 'grant.starting', 'mint', -STARTING_COINS, null);
  leg('tx_grant', 'grant.starting', 'wallet', STARTING_COINS, null);

  for (let i = 0; i < PREMINT_BUFFER_TARGET; i++) {
    sql.exec(
      "INSERT INTO coins (id, tier, value, state, dropped_tick, minted_at) VALUES (?, ?, ?, 'buffer', NULL, 0)",
      coinId(100 + i),
      COPPER.id,
      DROPPED_VALUE,
    );
  }
  for (let i = 0; i < 3; i++) {
    const id = coinId(i);
    const claimed = i === 0;
    sql.exec(
      'INSERT INTO coins (id, tier, value, state, dropped_tick, minted_at, settled_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      id,
      COPPER.id,
      DROPPED_VALUE,
      claimed ? 'claimed' : 'table',
      i,
      claimed ? 0 : null,
    );
    leg(`tx_drop_${i}`, 'drop.mint', 'wallet', -COPPER.value, id);
    leg(`tx_drop_${i}`, 'drop.mint', 'table', DROPPED_VALUE, id);
    leg(`tx_drop_${i}`, 'drop.mint', 'mint', COPPER.value - DROPPED_VALUE, id);
    if (claimed) {
      leg('tx_claim', 'claim.fall', 'table', -DROPPED_VALUE, id);
      leg('tx_claim', 'claim.fall', 'wallet', DROPPED_VALUE, id);
    }
  }
}

describe('a player stored before table persistence', () => {
  it('migrates to the snapshot table and backfills heap slots in mint order', async () => {
    const session = await newSession();
    const heap = (await state(session)).table.coins;
    const [dropped] = await dropAsClient(session, 1, () => 5);
    const [first] = heap;
    if (dropped === undefined || first === undefined) throw new Error('No heap or drop.');
    await claims(session, [{ kind: 'fall', coinId: first.id, tick: 5, edge: 'front' }]);

    await runInDurableObject(playerStub(session.tokens.playerId), (_live: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      const slots = () =>
        sql
          .exec<{ id: string; heap_slot: number | null }>(
            'SELECT id, heap_slot FROM coins ORDER BY rowid',
          )
          .toArray();
      const seeded = slots();
      sql.exec('DROP INDEX ledger_tx_id');
      sql.exec('DROP TABLE table_snapshot');
      sql.exec('DROP TABLE snapshot_flags');
      sql.exec('ALTER TABLE coins DROP COLUMN heap_slot');
      sql.exec(
        "DELETE FROM meta WHERE key LIKE 'table\\_session%' ESCAPE '\\' OR key LIKE 'snapshot\\_%' ESCAPE '\\'",
      );
      sql.exec(
        'UPDATE schema_version SET version = ?',
        migrationIndex('CREATE TABLE table_snapshot'),
      );

      const player = new PlayerDO(ctx, env);
      expect(sql.exec<{ version: number }>('SELECT version FROM schema_version').one()).toEqual({
        version: MIGRATIONS.length,
      });
      expect(slots()).toEqual(seeded);
      expect(slots().filter((row) => row.heap_slot !== null)).toHaveLength(openingHeap.coins);
      expect(seeded.find((row) => row.id === dropped.coin.id)?.heap_slot).toBeNull();
      expect(sql.exec('SELECT * FROM table_snapshot').toArray()).toEqual([]);
      return player;
    });

    const { table } = await reload(session);
    expect(table.coins).toEqual(heap.slice(1));
    expect(table.layout?.coins).toEqual(
      heap.slice(1).map((_coin, i) => ({ kind: 'heapSlot', slot: i + 1 })),
    );
    await expectConserved(session);
  });
});

describe('a player stored by the v1 schema', () => {
  it('migrates on construction and boots into a refunded table, the heap and a prepaid buffer', async () => {
    const playerId = PlayerIdSchema.parse(crypto.randomUUID());
    const stub = env.PLAYER.get(env.PLAYER.idFromName(playerId));
    await runInDurableObject(stub, async (_fresh: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      storeV1Player(sql, playerId);

      const player = new PlayerDO(ctx, env);
      expect(sql.exec<{ version: number }>('SELECT version FROM schema_version').one()).toEqual({
        version: MIGRATIONS.length,
      });
      expect(
        sql
          .exec(
            "SELECT key, value FROM meta WHERE key IN ('mint_carry', 'cascade_carry') ORDER BY key",
          )
          .toArray(),
      ).toEqual([
        { key: 'cascade_carry', value: '0' },
        { key: 'mint_carry', value: '0' },
      ]);
      const dropCounters = () =>
        sql
          .exec(
            "SELECT key, value FROM meta WHERE key IN ('drop_count', 'drop_high_water') ORDER BY key",
          )
          .toArray();
      expect(dropCounters()).toEqual([
        { key: 'drop_count', value: '3' },
        { key: 'drop_high_water', value: '3' },
      ]);
      const vault = () => {
        const report = player.conservation();
        return report.walletCoins + report.bufferPaid;
      };

      const booted = await player.state({ hydrate: 'boot' });
      if (!booted.ok) throw new Error(booted.error.message);
      expect(booted.body.table.coins).toHaveLength(openingHeap.coins);
      expect(booted.body.table.coins.every((coin) => coin.tier === openingHeap.tier)).toBe(true);
      expect(booted.body.table.buffer).toHaveLength(PREMINT_BUFFER_TARGET);
      expect(booted.body.wallet.coins).toBe(
        STARTING_COINS + DROPPED_VALUE - COPPER.value - PREMINT_BUFFER_TARGET * COPPER.value,
      );
      expect(vault()).toBe(STARTING_COINS + DROPPED_VALUE - COPPER.value);
      expect(player.conservation()).toMatchObject({ conserved: true });
      expect(
        sql
          .exec<{ id: string; state: string }>(
            'SELECT id, state FROM coins WHERE id IN (?, ?, ?) ORDER BY id',
            coinId(0),
            coinId(1),
            coinId(2),
          )
          .toArray(),
      ).toEqual([
        { id: coinId(0), state: 'claimed' },
        { id: coinId(1), state: 'refunded' },
        { id: coinId(2), state: 'refunded' },
      ]);
      expect(dropCounters()).toEqual([
        { key: 'drop_count', value: '1' },
        { key: 'drop_high_water', value: '3' },
      ]);

      const again = await player.state({ hydrate: 'boot' });
      if (!again.ok) throw new Error(again.error.message);
      expect(again.body.table.coins).toEqual(booted.body.table.coins);
      expect(again.body.wallet).toEqual(booted.body.wallet);
      expect(dropCounters()).toEqual([
        { key: 'drop_count', value: '1' },
        { key: 'drop_high_water', value: '3' },
      ]);
      expect(player.conservation()).toMatchObject({ conserved: true });
    });
  });
});

describe('a player stored before Venue Ascension', () => {
  it('gets the ascension and Family Office tables on construction and boots at the first venue', async () => {
    const session = await newSession();
    await state(session);
    const home = venues[0];
    await runInDurableObject(playerStub(session.tokens.playerId), (_live: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      const tables = () =>
        sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') AND (name LIKE 'ascensions%' OR name = 'family_office_levels') ORDER BY name",
          )
          .toArray()
          .map((row) => row.name);
      const migrated = tables();
      expect(migrated).toEqual([
        'ascensions',
        'ascensions_no_delete',
        'ascensions_no_update',
        'family_office_levels',
      ]);
      sql.exec('DROP TABLE ascensions');
      sql.exec('DROP TABLE family_office_levels');
      const before = migrationIndex('CREATE TABLE IF NOT EXISTS ascensions');
      expect(before).toBe(migrationIndex('CREATE TABLE IF NOT EXISTS safes') - 1);
      sql.exec('UPDATE schema_version SET version = ?', before);
      expect(tables()).toEqual([]);

      new PlayerDO(ctx, env);
      expect(sql.exec<{ version: number }>('SELECT version FROM schema_version').one()).toEqual({
        version: MIGRATIONS.length,
      });
      expect(tables()).toEqual(migrated);

      sql.exec(
        'INSERT INTO ascensions (venue_id, ledger_seq, lifetime_bullion, gold_bars, at) VALUES (?, 0, 0, 0, 0)',
        home.id,
      );
      sql.exec("INSERT INTO family_office_levels (line_id, level) VALUES ('trustFund', 1)");
      sql.exec('UPDATE schema_version SET version = ?', before);
      new PlayerDO(ctx, env);
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ascensions').one().n).toBe(1);
      expect(() => sql.exec('UPDATE ascensions SET gold_bars = 1000000')).toThrow(/append-only/);
      expect(() => sql.exec('DELETE FROM ascensions')).toThrow(/append-only/);
      expect(() =>
        sql.exec("INSERT INTO family_office_levels (line_id, level) VALUES ('oldMoney', -1)"),
      ).toThrow(/CHECK/);
    });

    const booted = await reload(session);
    expect(booted.venue).toMatchObject({
      id: venues[1].id,
      unlocked: [home.id, venues[1].id],
      lifetimeBullion: 0,
    });
    expect(booted.familyOffice).toEqual({ oldMoney: 0, privateCourier: 0, trustFund: 1 });
    await expectConserved(session);
  });
});

describe('a player stored before scratch cards', () => {
  it('gets the scratch_cards table on construction, holding no cards, and keeps cards once granted', async () => {
    const session = await newSession();
    await state(session);
    await runInDurableObject(playerStub(session.tokens.playerId), (_live: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      const objects = () =>
        sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') AND name LIKE 'scratch\\_cards%' ESCAPE '\\' ORDER BY name",
          )
          .toArray()
          .map((row) => row.name);
      const migrated = objects();
      expect(migrated).toEqual([
        'scratch_cards',
        'scratch_cards_no_delete',
        'scratch_cards_reveal_once',
        'scratch_cards_state',
      ]);
      sql.exec('DROP TABLE scratch_cards');
      const before = migrationIndex('CREATE TABLE IF NOT EXISTS scratch_cards');
      expect(before).toBe(migrationIndex('CREATE TABLE IF NOT EXISTS safes') + 1);
      sql.exec('UPDATE schema_version SET version = ?', before);
      expect(objects()).toEqual([]);

      new PlayerDO(ctx, env);
      expect(sql.exec<{ version: number }>('SELECT version FROM schema_version').one()).toEqual({
        version: MIGRATIONS.length,
      });
      expect(objects()).toEqual(migrated);
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM scratch_cards').one().n).toBe(0);

      grantScratchCard(sql, { source: 'quest:migrated' }, { at: Date.now(), idempotencyKey: null });
      sql.exec('UPDATE schema_version SET version = ?', before);
      new PlayerDO(ctx, env);
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM scratch_cards').one().n).toBe(1);
    });

    expect((await state(session)).inventory.scratchCards).toHaveLength(1);
    await expectConserved(session);
  });
});
