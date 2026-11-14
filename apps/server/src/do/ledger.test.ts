import { ascension, bullion, venues } from '@coinposh/economy';
import { endpoints } from '@coinposh/shared';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newSession, type Session } from '../test/client.ts';
import { claims, drop, dropAsClient, expectConserved, playerStub, state } from '../test/game.ts';
import { ASCEND_TX_KIND } from '../routes/ascend.ts';
import { SCRATCH_GRANT_TX_KIND, SCRATCH_REVEAL_TX_KIND } from '../routes/scratch.ts';
import { commit, ConservationError, LedgerTx, TX_KINDS } from './ledger.ts';
import type { PlayerDO } from './PlayerDO.ts';

interface LedgerRow {
  seq: number;
  tx_id: string;
  kind: string;
  account: string;
  unit: string;
  delta: number;
}

async function playSomeRounds(session: Session): Promise<void> {
  const coins = (await dropAsClient(session, 5, (i) => i)).map((response) => response.coin);
  const [a, b, c, d, e] = coins;
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) {
    throw new Error('drops failed');
  }
  await claims(session, [
    { kind: 'fusion', coinIds: [a.id, b.id, c.id], tick: 9 },
    { kind: 'fall', coinId: d.id, tick: 9, edge: 'front' },
    { kind: 'fall', coinId: e.id, tick: 9, edge: 'left' },
  ]);
}

/**
 * Runs the flush alarm until D1 holds every row. A flush of more than one batch re-arms the
 * alarm for now, so the runtime can fire it on its own between two test-driven runs.
 */
async function flushEverything(stub: ReturnType<typeof playerStub>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await runDurableObjectAlarm(stub);
    const pending = await runInDurableObject(stub, async (_instance: PlayerDO, ctx) => {
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

function doLedger(session: Session): Promise<LedgerRow[]> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) =>
    ctx.storage.sql
      .exec<{
        seq: number;
        tx_id: string;
        kind: string;
        account: string;
        unit: string;
        delta: number;
      }>('SELECT seq, tx_id, kind, account, unit, delta FROM ledger ORDER BY seq')
      .toArray(),
  );
}

describe('LedgerTx', () => {
  it('refuses to commit value created from nothing', () => {
    const tx = new LedgerTx('claim.fall').post('wallet', 'coins', 5, null);
    expect(() => {
      tx.assertBalanced();
    }).toThrow(ConservationError);
  });

  it('balances per unit, so coins cannot pay for crates', () => {
    const tx = new LedgerTx('crate.spawn')
      .post('wallet', 'coins', -1, null)
      .post('table', 'crate', 1, null);
    expect(() => {
      tx.assertBalanced();
    }).toThrow(/coins legs sum to -1/);
  });

  it('refuses a scratch card the mint did not issue, or a reveal that pays without retiring the card', () => {
    expect(TX_KINDS).toEqual(
      expect.arrayContaining([SCRATCH_GRANT_TX_KIND, SCRATCH_REVEAL_TX_KIND]),
    );
    const conjured = new LedgerTx(SCRATCH_GRANT_TX_KIND).post('inventory', 'scratchCard', 1, null);
    expect(() => {
      conjured.assertBalanced();
    }).toThrow(/scratch.grant is unbalanced: scratchCard legs sum to 1/);
    const paidForCoins = new LedgerTx(SCRATCH_REVEAL_TX_KIND)
      .post('inventory', 'scratchCard', -1, null)
      .post('wallet', 'coins', 1, null);
    expect(() => {
      paidForCoins.assertBalanced();
    }).toThrow(/scratchCard legs sum to -1/);
  });

  it('keeps scratch cards out of the wallet', async () => {
    const session = await newSession();
    await state(session);
    await runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
      expect(() => {
        commit(
          ctx.storage.sql,
          new LedgerTx(SCRATCH_GRANT_TX_KIND).move('mint', 'wallet', 'scratchCard', 1, null),
          { at: Date.now(), idempotencyKey: null },
        );
      }).toThrow(/wallet only holds currencies, not scratchCard/);
    });
  });

  it('lists ascensions as their own kind and holds them to the same per-unit balance', () => {
    expect(TX_KINDS).toContain(ASCEND_TX_KIND);
    const minted = new LedgerTx(ASCEND_TX_KIND).post('wallet', 'goldBars', 20, 'rivieraYacht');
    expect(() => {
      minted.assertBalanced();
    }).toThrow(/ascend is unbalanced: goldBars legs sum to 20/);
    const paid = new LedgerTx(ASCEND_TX_KIND)
      .move('mint', 'wallet', 'goldBars', 20, 'rivieraYacht')
      .post('wallet', 'coins', -5, 'rivieraYacht')
      .post('house', 'goldBars', 0, null);
    expect(() => {
      paid.assertBalanced();
    }).toThrow(/coins legs sum to -5/);
  });

  it.each([
    ['quest.claim', 'mint', 'wallet', 'pearls'],
    ['streak.milestone', 'mint', 'wallet', 'keys'],
    ['season.tier', 'mint', 'wallet', 'tickets'],
    ['season.rollover', 'wallet', 'house', 'stars'],
  ] as const)(
    'lists %s as its own kind, moving %s -> %s and nothing else',
    (kind, from, to, unit) => {
      expect(TX_KINDS).toContain(kind);
      const moved = new LedgerTx(kind).move(from, to, unit, 3, null);
      expect(moved.legs).toEqual([
        { account: from, unit, delta: -3, ref: null },
        { account: to, unit, delta: 3, ref: null },
      ]);
      expect(() => {
        moved.assertBalanced();
      }).not.toThrow();
      const conjured = new LedgerTx(kind).post(to, unit, 3, null);
      expect(() => {
        conjured.assertBalanced();
      }).toThrow(`${kind} is unbalanced: ${unit} legs sum to 3`);
    },
  );

  it('refuses negative moves and fractional amounts', () => {
    expect(() => new LedgerTx('claim.fall').move('table', 'wallet', 'coins', -3, null)).toThrow(
      ConservationError,
    );
    expect(() => new LedgerTx('claim.fall').move('table', 'wallet', 'coins', 0.5, null)).toThrow(
      ConservationError,
    );
  });
});

describe('PlayerDO ledger', () => {
  it('balances every transaction and agrees with the wallet and the table', async () => {
    const session = await newSession();
    await playSomeRounds(session);
    await expectConserved(session);

    const { wallet } = await state(session);
    const rows = await doLedger(session);
    const byTx = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const units = byTx.get(row.tx_id) ?? new Map<string, number>();
      units.set(row.unit, (units.get(row.unit) ?? 0) + row.delta);
      byTx.set(row.tx_id, units);
    }
    for (const units of byTx.values()) {
      for (const sum of units.values()) expect(sum).toBe(0);
    }
    const kinds = new Set(rows.map((row) => row.kind));
    for (const kind of [
      'grant.starting',
      'grant.heap',
      'buffer.prepay',
      'drop.buffer',
      'claim.fusion',
      'claim.fall',
    ]) {
      expect(kinds).toContain(kind);
    }

    const walletSum = rows
      .filter((row) => row.account === 'wallet' && row.unit === 'coins')
      .reduce((sum, row) => sum + row.delta, 0);
    expect(walletSum).toBe(wallet.coins);
  });

  it('cannot be rewritten inside the Durable Object', async () => {
    const session = await newSession();
    const stub = playerStub(session.tokens.playerId);
    await runInDurableObject(stub, (_instance: PlayerDO, ctx) => {
      expect(() => ctx.storage.sql.exec('UPDATE ledger SET delta = 1000000')).toThrow(
        /append-only/,
      );
      expect(() => ctx.storage.sql.exec('DELETE FROM ledger')).toThrow(/append-only/);
    });
    await expectConserved(session);
  });

  it('flushes every row to D1 once, with the wallet mirror at the same sequence', async () => {
    const session = await newSession();
    await playSomeRounds(session);
    const { wallet } = await state(session);
    const stub = playerStub(session.tokens.playerId);
    let alarmed = await runDurableObjectAlarm(stub);
    expect(alarmed).toBe(true);
    while (alarmed) alarmed = await runDurableObjectAlarm(stub);

    const local = await doLedger(session);
    const remote = await env.DB.prepare(
      'SELECT seq, tx_id, kind, account, unit, delta FROM ledger WHERE player_id = ? ORDER BY seq',
    )
      .bind(session.tokens.playerId)
      .all<LedgerRow>();
    expect(remote.results).toEqual(local);

    const mirror = await env.DB.prepare('SELECT coins, ledger_seq FROM wallets WHERE player_id = ?')
      .bind(session.tokens.playerId)
      .first<{ coins: number; ledger_seq: number }>();
    expect(mirror).toEqual({
      coins: wallet.coins,
      ledger_seq: local.at(-1)?.seq,
    });

    await runInDurableObject(stub, async (instance: PlayerDO) => {
      await instance.alarm();
    });
    const again = await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger WHERE player_id = ?')
      .bind(session.tokens.playerId)
      .first<{ n: number }>();
    expect(again?.n).toBe(local.length);
  });

  it('flushes an ascension to D1 as one ascend transaction with the Gold Bars mirror', async () => {
    const session = await newSession();
    const home = venues[0];
    const won = home.bullionThreshold * bullion.valuePerBullion;
    const stub = playerStub(session.tokens.playerId);
    await runInDurableObject(stub, (_instance: PlayerDO, ctx) => {
      const context = { at: Date.now(), idempotencyKey: null };
      const sql = ctx.storage.sql;
      commit(sql, new LedgerTx('grant.heap').move('house', 'table', 'coins', won, null), context);
      commit(sql, new LedgerTx('claim.fall').move('table', 'wallet', 'coins', won, null), context);
    });
    const startedAt = Date.now();
    const response = await session.call(endpoints.ascend.path, { body: { venueId: home.id } });
    expect(response.status, await response.clone().text()).toBe(200);
    const { wallet } = await state(session);
    expect(wallet.goldBars).toBe(ascension.goldBarScale);
    await expectConserved(session);

    await flushEverything(stub);
    const local = await doLedger(session);
    const remote = await env.DB.prepare(
      'SELECT seq, tx_id, kind, account, unit, delta, at FROM ledger WHERE player_id = ? AND kind = ? ORDER BY seq',
    )
      .bind(session.tokens.playerId, ASCEND_TX_KIND)
      .all<LedgerRow & { at: number }>();
    const ascended = local.filter((row) => row.kind === ASCEND_TX_KIND);
    expect(ascended.length).toBeGreaterThan(0);
    expect(remote.results.map(({ at: _at, ...row }) => row)).toEqual(ascended);
    expect(new Set(ascended.map((row) => row.tx_id)).size).toBe(1);
    for (const row of remote.results) {
      expect(row.at).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(row.at).toBeLessThanOrEqual(Date.now() + 1000);
    }
    const mirror = await env.DB.prepare(
      'SELECT coins, gold_bars, ledger_seq FROM wallets WHERE player_id = ?',
    )
      .bind(session.tokens.playerId)
      .first<{ coins: number; gold_bars: number; ledger_seq: number }>();
    expect(mirror).toEqual({
      coins: wallet.coins,
      gold_bars: wallet.goldBars,
      ledger_seq: local.at(-1)?.seq,
    });
  });

  it('cannot be rewritten in D1 either', async () => {
    const session = await newSession();
    const update = env.DB.prepare('UPDATE ledger SET delta = 1000000 WHERE player_id = ?')
      .bind(session.tokens.playerId)
      .run();
    await expect(update).rejects.toThrow(/append-only/);
    const remove = env.DB.prepare('DELETE FROM ledger WHERE player_id = ?')
      .bind(session.tokens.playerId)
      .run();
    await expect(remove).rejects.toThrow(/append-only/);
  });

  it('records which request caused each row and stamps it with server time', async () => {
    const session = await newSession();
    const startedAt = Date.now();
    await drop(session, { tick: 0 });
    const rows = await runInDurableObject(
      playerStub(session.tokens.playerId),
      (_instance: PlayerDO, ctx) =>
        ctx.storage.sql
          .exec<{ at: number; idempotency_key: string | null }>(
            "SELECT at, idempotency_key FROM ledger WHERE kind = 'drop.mint'",
          )
          .toArray(),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.at).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(row.at).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });
});
