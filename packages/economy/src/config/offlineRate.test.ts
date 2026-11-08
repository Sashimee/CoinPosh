import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simModel } from '../../sim/model.ts';
import {
  activeTick,
  claimOffline,
  createContext,
  createPlayer,
  netRatePerSecond,
  type PlayerState,
} from '../../sim/player.ts';
import { offlineEarnings, upgradeStat } from '../formulas.ts';
import { createRng } from '../rng.ts';
import { economyConfig, offline, upgradeLines } from './index.ts';
import {
  crateIncomeCoins,
  measuredActiveRatePerHour,
  offlineRate,
  offlineVaultCoins,
  playStretchOf,
  starterVaultCoins,
  vaultRatePerHour,
  type PlayEntry,
} from './offlineRate.ts';

const RUNS = { numRuns: 300 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The Demo mock's old floor (one copper a second) paid this much for 2 h away with no play. */
const OLD_FLOOR_TWO_HOURS = 1 * 3_600 * offline.activeRateFactor * 2;

const offlineHoursLine = upgradeLines.find((line) => line.effect.stat === 'offlineHours');
if (offlineHoursLine === undefined) throw new Error('Expected an offlineHours upgrade line.');
const capLine = offlineHoursLine;

function capHoursOf(player: PlayerState): number {
  return upgradeStat(capLine, player.levels.get(capLine.id) ?? 0);
}

function clampedCap(capHours: number): number {
  return Math.min(Math.max(capHours, offline.baseCapHours), offline.maxCapHours);
}

function playCoins(player: PlayerState): number {
  const l = player.ledger;
  return l.won + l.heap + l.crateIncome - l.dropsPaid;
}

describe('Velvet Vault starter floor', () => {
  it('pays a fresh profile with zero credited coins, away 2 h, at most the documented floor', () => {
    const measured = measuredActiveRatePerHour(playStretchOf([]));
    expect(measured).toBe(0);
    const coins = offlineVaultCoins(2, offline.baseCapHours, measured);
    expect(coins).toBe(starterVaultCoins(offline.baseCapHours));
    expect(coins).toBe(42);
    expect(coins).toBeLessThan(OLD_FLOOR_TWO_HOURS / 30);
  });

  it('documents the floor as a copper a minute: 42 coins at the base cap, 252 at the 12 h cap', () => {
    expect(offlineRate.starterRatePerHour).toBe(60);
    expect(starterVaultCoins(offline.baseCapHours)).toBe(42);
    expect(starterVaultCoins(offline.maxCapHours)).toBe(252);
  });

  it('never pays a profile that has won nothing more than the floor, however long it was away', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000, noNaN: true }),
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: 0, max: offlineRate.starterRatePerHour, noNaN: true }),
        (hours, cap, measured) => {
          const coins = offlineVaultCoins(hours, cap, measured);
          expect(coins).toBeLessThanOrEqual(starterVaultCoins(cap));
          const owed =
            Math.min(hours, clampedCap(cap)) *
            offline.activeRateFactor *
            offlineRate.starterRatePerHour;
          expect(coins).toBeGreaterThan(owed - 1);
          expect(coins).toBeLessThanOrEqual(owed + 1e-6);
        },
      ),
      RUNS,
    );
  });
});

describe('Velvet Vault on a measured active rate', () => {
  it('pays min(h, cap) × 0.35 × R for a measured rate R at or above the floor', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000, noNaN: true }),
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: offlineRate.starterRatePerHour, max: 1e9, noNaN: true }),
        (hours, cap, rate) => {
          const coins = offlineVaultCoins(hours, cap, rate);
          const owed = Math.min(hours, clampedCap(cap)) * 0.35 * rate;
          expect(owed).toBeCloseTo(offlineEarnings(hours, cap, rate, offline), 6);
          expect(Number.isInteger(coins)).toBe(true);
          expect(coins).toBeGreaterThan(owed - 1);
          expect(coins).toBeLessThanOrEqual(owed + 1e-6);
        },
      ),
      RUNS,
    );
  });

  it('pays less per hour away than the rate it measured, at every rate', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000, noNaN: true }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        (hours, rate) => {
          const credited = Math.min(hours, clampedCap(0));
          expect(offlineVaultCoins(hours, 0, rate) / credited).toBeLessThan(vaultRatePerHour(rate));
        },
      ),
      RUNS,
    );
  });

  it('measures net coins over the stretch of play, never shorter than the minimum span', () => {
    const entries: PlayEntry[] = [
      { at: 0, coins: -12 },
      { at: 15 * MINUTE, coins: 60 },
      { at: 20 * MINUTE, coins: -8 },
    ];
    expect(measuredActiveRatePerHour(playStretchOf(entries))).toBeCloseTo(
      ((60 - 20) * HOUR) / (20 * MINUTE),
    );
    const burst: PlayEntry[] = [
      { at: 0, coins: -1 },
      { at: 2_000, coins: 25 },
    ];
    expect(measuredActiveRatePerHour(playStretchOf(burst))).toBeCloseTo(
      (24 * HOUR) / offlineRate.minSpanMs,
    );
  });

  it('measures zero when play lost coins, and ignores play older than the window', () => {
    expect(
      measuredActiveRatePerHour(
        playStretchOf([
          { at: 0, coins: 5 },
          { at: MINUTE, coins: -9 },
        ]),
      ),
    ).toBe(0);
    const stale = playStretchOf([
      { at: 0, coins: 10_000 },
      { at: offlineRate.windowMs + MINUTE, coins: 30 },
    ]);
    expect(stale).toEqual({
      netCoins: 30,
      firstAt: offlineRate.windowMs + MINUTE,
      lastAt: offlineRate.windowMs + MINUTE,
    });
    expect(
      measuredActiveRatePerHour(
        playStretchOf([
          { at: offlineRate.windowMs, coins: 1 },
          { at: 0, coins: 2 },
        ]),
      ),
    ).toBeCloseTo((3 * HOUR) / offlineRate.windowMs);
  });

  it('rejects a stretch that ends before it starts', () => {
    expect(() => measuredActiveRatePerHour({ netCoins: 5, firstAt: 10, lastAt: 0 })).toThrow(
      RangeError,
    );
  });

  const entryArb = fc.record({
    at: fc.integer({ min: 0, max: 4 * HOUR }),
    coins: fc.integer({ min: -50, max: 500 }),
  });

  it('depends on active play only: account age and idle time before the stretch change nothing', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 400 * 24 * HOUR }),
        (entries, age) => {
          const aged = entries.map((entry) => ({ ...entry, at: entry.at + age }));
          expect(measuredActiveRatePerHour(playStretchOf(aged))).toBeCloseTo(
            measuredActiveRatePerHour(playStretchOf(entries)),
            6,
          );
        },
      ),
      RUNS,
    );
  });

  it('is never negative and never above the net won over the minimum span', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 40 }), (entries) => {
        const stretch = playStretchOf(entries);
        const rate = measuredActiveRatePerHour(stretch);
        expect(rate).toBeGreaterThanOrEqual(0);
        const won = Math.max(0, stretch?.netCoins ?? 0);
        expect(rate).toBeLessThanOrEqual((won * HOUR) / offlineRate.minSpanMs + 1e-9);
      }),
      RUNS,
    );
  });
});

describe('Vault Crate income on the measured rate', () => {
  it('pays incomeSeconds of the measured rate, never under a copper per second', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(economyConfig.crateRewards).map((r) => r.incomeSeconds)),
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        (incomeSeconds, rate) => {
          const coins = crateIncomeCoins(incomeSeconds, rate);
          expect(coins).toBeGreaterThanOrEqual(
            incomeSeconds * offlineRate.crateIncomeFloorPerSecond,
          );
          expect(coins).toBe(
            Math.round(
              incomeSeconds * Math.max(rate / 3_600, offlineRate.crateIncomeFloorPerSecond),
            ),
          );
        },
      ),
      RUNS,
    );
  });
});

interface CasualGap {
  readonly activePerHour: number;
  readonly offlinePerHourAway: number;
  readonly offlinePerCreditedHour: number;
  readonly measuredPerHour: number;
}

/**
 * Replays the economy sim's casual schedule, paying the Vault between sessions by this rule on
 * the sim's net rate (what the server would measure), next to the sim's own floorless payout.
 */
function casualGaps(seed: number, days: number): CasualGap[] {
  const ctx = createContext(economyConfig, simModel, createRng(seed));
  const player = createPlayer(ctx);
  const { sessionStartHours, sessionMinutes } = simModel.casual;
  const ticks = Math.round((sessionMinutes * 60) / simModel.tickSeconds);
  const gaps: CasualGap[] = [];
  let lastEnd: number | null = null;
  let activePerHour = 0;
  for (let day = 0; day < days; day++) {
    for (const startOfDay of sessionStartHours) {
      const start = day * 24 + startOfDay;
      if (lastEnd !== null) {
        const away = start - lastEnd;
        const cap = capHoursOf(player);
        const measured = netRatePerSecond(ctx, player) * 3_600;
        const coins = offlineVaultCoins(away, cap, measured);
        const simCoins = claimOffline(ctx, player, away);
        expect(Math.abs(coins - simCoins)).toBeLessThan(1);
        gaps.push({
          activePerHour,
          offlinePerHourAway: coins / away,
          offlinePerCreditedHour: coins / Math.min(away, clampedCap(cap)),
          measuredPerHour: measured,
        });
      }
      const before = playCoins(player);
      for (let t = 0; t < ticks; t++) activeTick(ctx, player);
      activePerHour = (playCoins(player) - before) / (sessionMinutes / 60);
      lastEnd = start + sessionMinutes / 60;
    }
  }
  return gaps;
}

describe('Velvet Vault in the economy sim: offline never out-earns play', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const gaps = seeds.flatMap((seed) => casualGaps(seed, 7));

  it('pays less per hour away, and per credited hour, than the session before it earned', () => {
    expect(gaps.length).toBe(seeds.length * (7 * simModel.casual.sessionStartHours.length - 1));
    for (const gap of gaps) {
      expect(gap.offlinePerHourAway).toBeLessThan(gap.activePerHour);
      expect(gap.offlinePerCreditedHour).toBeLessThan(gap.activePerHour);
    }
  });

  it('never binds the starter floor for a sim player, so the sim models the shipped rule exactly', () => {
    for (const gap of gaps) {
      expect(gap.measuredPerHour).toBeGreaterThan(offlineRate.starterRatePerHour);
    }
  });

  it("keeps the floor's offline hour far under a starter's first minute of play", () => {
    const ctx = createContext(economyConfig, simModel, createRng(1));
    const player = createPlayer(ctx);
    while (player.activeSeconds < 60) activeTick(ctx, player);
    const firstMinutePerHour = playCoins(player) * 60;
    const floorPerHour = offline.activeRateFactor * offlineRate.starterRatePerHour;
    expect(floorPerHour).toBeLessThan(0.01 * firstMinutePerHour);
  });
});
