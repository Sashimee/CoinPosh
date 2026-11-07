import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newSession, type Session } from '../test/client.ts';
import { claims, drop, expectConserved, playerStub, state } from '../test/game.ts';
import { ConservationError, LedgerTx } from './ledger.ts';
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
  const coins = [];
  for (let i = 0; i < 5; i++) coins.push((await drop(session, { tick: i })).coin);
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
      'buffer.purchase',
      'drop.mint',
      'claim.fusion',
      'claim.fall',
    ]) {
      expect(kinds).toContain(kind);
    }

    const { wallet } = await state(session);
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
    const stub = playerStub(session.tokens.playerId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

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
      coins: (await state(session)).wallet.coins,
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
