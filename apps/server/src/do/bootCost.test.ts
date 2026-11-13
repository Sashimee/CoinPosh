import { coinTiers } from '@coinposh/economy';
import type { CoinId } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newIdempotencyKey, newSession, type Session } from '../test/client.ts';
import { expectConserved, playerStub, reload, state, tableSession } from '../test/game.ts';
import { commit, LedgerTx } from './ledger.ts';
import { FUSION_INPUTS_SQL, PlayerDO } from './PlayerDO.ts';
import { MIGRATIONS } from './schema.ts';

const COPPER = coinTiers[0];
const FUSED_DROPS = 2700;
const BOOT_BUDGET_MS = 2000;

function queryPlan(sql: SqlStorage): string[] {
  return sql
    .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${FUSION_INPUTS_SQL}`, 'coin_x')
    .toArray()
    .map((row) => row.detail);
}

/** Drops `drops` coins straight into the DO and fuses them in threes, leaving no stored poses. */
async function playFusedHistory(session: Session, drops: number) {
  const lease = await tableSession(session);
  return runInDurableObject(playerStub(session.tokens.playerId), async (player: PlayerDO, ctx) => {
    commit(
      ctx.storage.sql,
      new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', drops * COPPER.value, null),
      { at: 0, idempotencyKey: null },
    );
    let batch: CoinId[] = [];
    for (let tick = 0; tick < drops; tick++) {
      const dropped = await player.drop({
        idempotencyKey: newIdempotencyKey(),
        fingerprint: `drop ${tick}`,
        body: { session: lease, x: 0, tick },
      });
      if (!dropped.ok) throw new Error(`Drop ${tick} failed: ${dropped.error.message}`);
      const [first, second] = batch;
      if (first === undefined || second === undefined) {
        batch.push(dropped.body.coin.id);
        continue;
      }
      const fused = await player.claims({
        idempotencyKey: newIdempotencyKey(),
        fingerprint: `fuse ${tick}`,
        body: {
          session: lease,
          claims: [{ kind: 'fusion', coinIds: [first, second, dropped.body.coin.id], tick }],
        },
      });
      if (!fused.ok || fused.body.results[0]?.status !== 'accepted') {
        throw new Error(`Fusing at tick ${tick} was not accepted.`);
      }
      batch = [];
    }
    return ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM coins WHERE state = 'table' AND heap_slot IS NULL",
      )
      .one().n;
  });
}

describe('the fusion walk a boot refund runs per stranded coin', () => {
  it('looks every ledger leg up by index instead of scanning the ledger', async () => {
    const session = await newSession();
    await state(session);
    await runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
      const plan = queryPlan(ctx.storage.sql);
      expect(plan).toHaveLength(2);
      expect(plan.filter((step) => step.startsWith('SCAN'))).toEqual([]);
      expect(plan.some((step) => step.includes('ledger_tx_id'))).toBe(true);
    });
  });

  it('gets its index on a player stored before the index existed', async () => {
    const session = await newSession();
    await state(session);
    await runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec('DROP INDEX ledger_tx_id');
      sql.exec('UPDATE schema_version SET version = ?', MIGRATIONS.length - 1);
      expect(queryPlan(sql).some((step) => step.startsWith('SCAN'))).toBe(true);

      new PlayerDO(ctx, env);
      expect(
        sql
          .exec("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'ledger_tx_id'")
          .toArray(),
      ).toEqual([{ tbl_name: 'ledger' }]);
      expect(queryPlan(sql).filter((step) => step.startsWith('SCAN'))).toEqual([]);
    });
  });
});

describe('a boot after a long session of fusions', () => {
  it(
    `refunds every stranded fused coin within ${BOOT_BUDGET_MS} ms`,
    { timeout: 120_000 },
    async () => {
      const session = await newSession();
      await state(session);
      const stranded = await playFusedHistory(session, FUSED_DROPS);
      expect(stranded).toBe(FUSED_DROPS / 3);

      const started = performance.now();
      const booted = await reload(session);
      const elapsed = performance.now() - started;

      expect(booted.table.layout?.coins.every((coin) => coin.kind === 'heapSlot')).toBe(true);
      expect(elapsed).toBeLessThan(BOOT_BUDGET_MS);
      await expectConserved(session);
    },
  );
});
