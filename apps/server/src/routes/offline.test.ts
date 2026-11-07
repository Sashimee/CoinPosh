import { offline, offlineEarnings } from '@coinposh/economy';
import { EpochMsSchema, type EpochMs } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { newSession, type Session } from '../test/client.ts';
import { claims, drop, playerStub } from '../test/game.ts';
import {
  ACTIVE_RATE_MIN_SPAN_MS,
  measuredActiveRate,
  OFFLINE_MIN_AWAY_MS,
  OFFLINE_SETTLEMENTS_SQL,
  quoteOffline,
  recordOffline,
} from './offline.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Drops `count` coins and pushes them all over `edge`; returns what the wallet was paid. */
async function play(session: Session, count: number, edge: 'front' | 'left'): Promise<number> {
  const coins = [];
  for (let i = 0; i < count; i++) coins.push((await drop(session, { tick: i })).coin);
  const result = await claims(
    session,
    coins.map((coin) => ({ kind: 'fall', coinId: coin.id, tick: count + 10, edge })),
  );
  let won = 0;
  for (const claim of result.results) if (claim.status === 'accepted') won += claim.credited;
  return won;
}

function inPlayer<T>(session: Session, run: (sql: SqlStorage, lastActive: EpochMs) => T) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(OFFLINE_SETTLEMENTS_SQL);
    const last = sql.exec<{ at: number }>('SELECT MAX(at) AS at FROM ledger').one().at;
    return run(sql, EpochMsSchema.parse(last));
  });
}

function at(ms: number): EpochMs {
  return EpochMsSchema.parse(ms);
}

describe('Velvet Vault offline earnings', () => {
  it('pays nothing to a player who never played, however long they were away', async () => {
    const session = await newSession();
    await inPlayer(session, (sql, last) => {
      expect(measuredActiveRate(sql)).toBe(0);
      expect(quoteOffline(sql, at(last + 12 * HOUR), 2)).toBeNull();
    });
  });

  it('pays 0.35 × the measured winning rate for the capped hours away', async () => {
    const session = await newSession();
    const won = await play(session, 6, 'front');
    expect(won).toBeGreaterThan(0);
    await inPlayer(session, (sql, last) => {
      const rate = measuredActiveRate(sql);
      expect(rate).toBeCloseTo((won * HOUR) / ACTIVE_RATE_MIN_SPAN_MS);

      const settlement = quoteOffline(sql, at(last + 8 * HOUR), 2);
      expect(settlement).toEqual({
        awayMs: 8 * HOUR,
        creditedMs: 2 * HOUR,
        coins: Math.floor(offlineEarnings(8, 2, rate, offline)),
      });
      expect(settlement?.coins).toBe(Math.floor(2 * 0.35 * rate));
    });
  });

  it('credits more hours as the offlineHours upgrade raises the cap, up to the hard maximum', async () => {
    const session = await newSession();
    await play(session, 6, 'front');
    await inPlayer(session, (sql, last) => {
      const away = at(last + 20 * HOUR);
      const base = quoteOffline(sql, away, 2);
      const upgraded = quoteOffline(sql, away, 5);
      const beyond = quoteOffline(sql, away, 40);
      expect(base?.creditedMs).toBe(2 * HOUR);
      expect(upgraded?.creditedMs).toBe(5 * HOUR);
      expect(beyond?.creditedMs).toBe(offline.maxCapHours * HOUR);
      expect(upgraded?.coins ?? 0).toBeGreaterThan(base?.coins ?? 0);
    });
  });

  it('settles nothing for a short absence, and something from exactly the minimum', async () => {
    const session = await newSession();
    await play(session, 6, 'front');
    await inPlayer(session, (sql, last) => {
      expect(quoteOffline(sql, at(last + OFFLINE_MIN_AWAY_MS - 1), 2)).toBeNull();
      expect(quoteOffline(sql, at(last + OFFLINE_MIN_AWAY_MS), 2)?.creditedMs).toBe(
        OFFLINE_MIN_AWAY_MS,
      );
      expect(quoteOffline(sql, at(last - HOUR), 2)).toBeNull();
    });
  });

  it('measures only coins actually won: side-gutter losses earn no vault', async () => {
    const session = await newSession();
    expect(await play(session, 6, 'left')).toBe(0);
    await inPlayer(session, (sql, last) => {
      expect(measuredActiveRate(sql)).toBe(0);
      expect(quoteOffline(sql, at(last + 8 * HOUR), 2)).toBeNull();
    });
  });

  it('pays each stretch away once: a recorded settlement marks everything before it as paid', async () => {
    const session = await newSession();
    await play(session, 6, 'front');
    await inPlayer(session, (sql, last) => {
      const returned = at(last + 8 * HOUR);
      const first = quoteOffline(sql, returned, 2);
      if (first === null) throw new Error('expected a settlement after 8 hours away');
      recordOffline(sql, returned, first);

      expect(quoteOffline(sql, returned, 2)).toBeNull();
      expect(quoteOffline(sql, at(returned + MINUTE), 2)).toBeNull();
      const again = quoteOffline(sql, at(returned + 3 * HOUR), 2);
      expect(again).toEqual({ ...first, awayMs: 3 * HOUR });
    });
  });
});
