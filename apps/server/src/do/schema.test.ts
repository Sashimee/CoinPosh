import { coinTiers, openingHeap } from '@coinposh/economy';
import { CURRENCIES, ENTITY_ID_PREFIXES, PlayerIdSchema } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { mintedValue } from './entities.ts';
import { PlayerDO, PREMINT_BUFFER_TARGET } from './PlayerDO.ts';
import { MIGRATIONS } from './schema.ts';

const COPPER = coinTiers[0];
const STARTING_COINS = 20;
const DROPPED_VALUE = mintedValue(COPPER.id, {});

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

      const again = await player.state({ hydrate: 'boot' });
      if (!again.ok) throw new Error(again.error.message);
      expect(again.body.table.coins).toEqual(booted.body.table.coins);
      expect(again.body.wallet).toEqual(booted.body.wallet);
      expect(player.conservation()).toMatchObject({ conserved: true });
    });
  });
});
