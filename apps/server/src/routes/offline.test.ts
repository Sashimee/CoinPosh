import {
  offline,
  offlineEarnings,
  offlineRate,
  starterVaultCoins,
  upgradeLines,
  upgradeStat,
  vaultRatePerHour,
} from '@coinposh/economy';
import { EpochMsSchema, type CoinId, type EpochMs } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HOME_VENUE } from '../do/entities.ts';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { newSession, type Session } from '../test/client.ts';
import { claims, dropAsClient, playerStub, vaultCoins } from '../test/game.ts';
import {
  measuredActiveRate,
  OFFLINE_MIN_AWAY_MS,
  OFFLINE_SETTLEMENTS_SQL,
  quoteOffline,
  recordOffline,
} from './offline.ts';
import { readUpgradeLevels, recordUpgrade } from './upgrades.ts';

const MINUTE = 60_000;
const OFFLINE_LINE = (() => {
  const line = upgradeLines.find((candidate) => candidate.id === 'offlineHours');
  if (line === undefined) throw new Error('Economy config has no offlineHours line.');
  return line;
})();
const HOUR = 60 * MINUTE;

type Edge = 'front' | 'left';

interface Played {
  /** Coins the wallet was paid for falls. */
  readonly won: number;
  /** Coins the Vault paid for drops. */
  readonly spent: number;
}

async function dropCoins(session: Session, count: number) {
  const before = await vaultCoins(session);
  const coins = (await dropAsClient(session, count, (i) => i)).map((response) => response.coin);
  return { coins, spent: before - (await vaultCoins(session)) };
}

async function fuse(session: Session, coinIds: readonly CoinId[], tick: number): Promise<CoinId[]> {
  const ids = [];
  for (let i = 0; i < coinIds.length; i += 3) ids.push(coinIds.slice(i, i + 3));
  const result = await claims(
    session,
    ids.map((triple) => ({ kind: 'fusion', coinIds: triple, tick })),
  );
  return result.results.map((claim, i) => {
    if (claim.status !== 'accepted' || claim.minted === null) {
      throw new Error(`Fusion ${i} was not accepted: ${JSON.stringify(claim)}`);
    }
    return claim.minted.id;
  });
}

async function fall(
  session: Session,
  coins: readonly { coinId: CoinId; edge: Edge }[],
  tick: number,
) {
  const result = await claims(
    session,
    coins.map((coin) => ({ kind: 'fall', ...coin, tick })),
  );
  let won = 0;
  for (const claim of result.results) if (claim.status === 'accepted') won += claim.credited;
  return won;
}

/**
 * Drops nine coppers, fuses them up to one gold and pushes it over `edge`. Fusion's bonus is
 * the only way the slice's play nets more than its drops cost, and copper → silver alone
 * rounds the bonus away.
 */
async function playGold(session: Session, edge: Edge): Promise<Played> {
  const { coins, spent } = await dropCoins(session, 9);
  const silvers = await fuse(
    session,
    coins.map((coin) => coin.id),
    20,
  );
  const [gold] = await fuse(session, silvers, 21);
  if (gold === undefined) throw new Error('Expected three silvers to fuse into one gold.');
  return { won: await fall(session, [{ coinId: gold, edge }], 30), spent };
}

/** Drops one copper per entry and pushes each over its edge unfused. */
async function playSingles(session: Session, edges: readonly Edge[]): Promise<Played> {
  const { coins, spent } = await dropCoins(session, edges.length);
  const won = await fall(
    session,
    coins.map((coin, i) => ({ coinId: coin.id, edge: edges[i] ?? 'left' })),
    30,
  );
  return { won, spent };
}

/** Plays `golds` rounds of `playGold` over the front edge; returns the wallet's net gain. */
async function play(session: Session, golds: number): Promise<number> {
  let net = 0;
  for (let i = 0; i < golds; i++) {
    const { won, spent } = await playGold(session, 'front');
    net += won - spent;
  }
  return net;
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

// A measured net rate needs real play, up to 72 signed drops and their fusions: over 3.5 s on CI.
describe('Velvet Vault offline earnings', { timeout: 20_000 }, () => {
  it('pays a player who never played only the starter floor, however long they were away', async () => {
    const session = await newSession();
    await inPlayer(session, (sql, last) => {
      expect(measuredActiveRate(sql)).toBe(0);
      const settlement = quoteOffline(sql, at(last + 12 * HOUR), {});
      expect(settlement).toEqual({
        awayMs: 12 * HOUR,
        creditedMs: 2 * HOUR,
        coins: starterVaultCoins(2),
      });
      expect(settlement?.coins).toBe(Math.floor(2 * 0.35 * offlineRate.starterRatePerHour));
      expect(settlement?.coins).toBeLessThanOrEqual(42);
    });
  });

  it('pays 0.35 × the measured net winning rate for the capped hours away', async () => {
    const session = await newSession();
    const net = await play(session, 8);
    expect(net).toBeGreaterThan(0);
    await inPlayer(session, (sql, last) => {
      const rate = measuredActiveRate(sql);
      expect(rate).toBeCloseTo((net * HOUR) / offlineRate.minSpanMs);
      expect(rate).toBeGreaterThan(offlineRate.starterRatePerHour);

      const settlement = quoteOffline(sql, at(last + 8 * HOUR), {});
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
    await play(session, 4);
    await inPlayer(session, (sql, last) => {
      const away = at(last + 20 * HOUR);
      const base = quoteOffline(sql, away, {});
      const upgraded = quoteOffline(sql, away, { offlineHours: 3 });
      const top = quoteOffline(sql, away, { offlineHours: OFFLINE_LINE.maxLevel });
      expect(base?.creditedMs).toBe(offline.baseCapHours * HOUR);
      expect(upgraded?.creditedMs).toBe(upgradeStat(OFFLINE_LINE, 3) * HOUR);
      expect(top?.creditedMs).toBe(offline.maxCapHours * HOUR);
      expect(upgraded?.coins ?? 0).toBeGreaterThan(base?.coins ?? 0);
      expect(top?.coins ?? 0).toBeGreaterThan(upgraded?.coins ?? 0);
    });
  });

  it('takes the cap from the stored offlineHours level as soon as it is bought', async () => {
    const session = await newSession();
    await play(session, 4);
    await inPlayer(session, (sql, last) => {
      const away = at(last + 20 * HOUR);
      const before = quoteOffline(sql, away, readUpgradeLevels(sql, HOME_VENUE.id));
      recordUpgrade(sql, {
        venueId: HOME_VENUE.id,
        lineId: 'offlineHours',
        level: 4,
        currency: 'coins',
        cost: 0,
      });
      const after = quoteOffline(sql, away, readUpgradeLevels(sql, HOME_VENUE.id));
      expect(before?.creditedMs).toBe(offline.baseCapHours * HOUR);
      expect(after?.creditedMs).toBe(upgradeStat(OFFLINE_LINE, 4) * HOUR);
    });
  });

  it('settles nothing for a short absence, and something from exactly the minimum', async () => {
    const session = await newSession();
    await play(session, 4);
    await inPlayer(session, (sql, last) => {
      expect(quoteOffline(sql, at(last + OFFLINE_MIN_AWAY_MS - 1), {})).toBeNull();
      expect(quoteOffline(sql, at(last + OFFLINE_MIN_AWAY_MS), {})?.creditedMs).toBe(
        OFFLINE_MIN_AWAY_MS,
      );
      expect(quoteOffline(sql, at(last - HOUR), {})).toBeNull();
    });
  });

  it('measures the net rate: falls won minus the coins paid to drop them', async () => {
    const session = await newSession();
    const gold = await playGold(session, 'front');
    const lost = await playSingles(session, ['left']);
    const won = gold.won + lost.won;
    const spent = gold.spent + lost.spent;
    expect(spent).toBeGreaterThan(0);
    expect(won - spent).toBeGreaterThan(0);
    await inPlayer(session, (sql) => {
      expect(measuredActiveRate(sql)).toBeCloseTo(((won - spent) * HOUR) / offlineRate.minSpanMs);
    });
  });

  it('measures zero when drops cost more than falls return, so the vault pays only the starter floor', async () => {
    const session = await newSession();
    const { won, spent } = await playSingles(session, ['front', 'left', 'left']);
    expect(won).toBeGreaterThan(0);
    expect(spent).toBeGreaterThan(won);
    await inPlayer(session, (sql, last) => {
      expect(measuredActiveRate(sql)).toBe(0);
      expect(quoteOffline(sql, at(last + 8 * HOUR), {})?.coins).toBe(starterVaultCoins(2));
    });
  });

  it('measures only coins actually won: side-gutter losses earn no more than the starter floor', async () => {
    const session = await newSession();
    const { won, spent } = await playSingles(session, Array<Edge>(6).fill('left'));
    expect(won).toBe(0);
    expect(spent).toBeGreaterThan(0);
    await inPlayer(session, (sql, last) => {
      expect(measuredActiveRate(sql)).toBe(0);
      expect(quoteOffline(sql, at(last + 8 * HOUR), {})?.coins).toBe(starterVaultCoins(2));
    });
  });

  it('pays on the measured rate or the starter floor, whichever is higher', async () => {
    const session = await newSession();
    const net = await play(session, 1);
    expect(net).toBeGreaterThan(0);
    await inPlayer(session, (sql, last) => {
      const rate = measuredActiveRate(sql);
      expect(rate).toBeCloseTo((net * HOUR) / offlineRate.minSpanMs);
      const coins = quoteOffline(sql, at(last + 3 * HOUR), {})?.coins;
      expect(coins).toBe(Math.floor(2 * offline.activeRateFactor * vaultRatePerHour(rate)));
      expect(coins).toBeGreaterThanOrEqual(starterVaultCoins(2));
    });
  });

  it('pays each stretch away once: a recorded settlement marks everything before it as paid', async () => {
    const session = await newSession();
    await play(session, 4);
    await inPlayer(session, (sql, last) => {
      const returned = at(last + 8 * HOUR);
      const first = quoteOffline(sql, returned, {});
      if (first === null) throw new Error('expected a settlement after 8 hours away');
      recordOffline(sql, returned, first);

      expect(quoteOffline(sql, returned, {})).toBeNull();
      expect(quoteOffline(sql, at(returned + MINUTE), {})).toBeNull();
      const again = quoteOffline(sql, at(returned + 3 * HOUR), {});
      expect(again).toEqual({ ...first, awayMs: 3 * HOUR });
    });
  });
});
