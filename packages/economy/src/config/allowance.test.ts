import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simModel } from '../../sim/model.ts';
import {
  activeTick,
  createContext,
  createPlayer,
  netRatePerSecond,
  type PlayerState,
} from '../../sim/player.ts';
import { createRng } from '../rng.ts';
import {
  claimStewardAllowance,
  initialStewardAllowanceState,
  stewardAllowance,
  stewardAllowanceDueAt,
  stewardAllowanceMaxRate,
  type StewardAllowanceState,
} from './allowance.ts';
import { economyConfig } from './index.ts';

const RUNS = { numRuns: 200 };
const DAY = 86_400;
/** P-200 acceptance: pour everything in the first 30 s, drop again within 20 s. */
const POUR_DEADLINE_SECONDS = 30;
const RESUME_WITHIN_SECONDS = 20;
/** The playtest table: the ledge paid nothing back while the poured coins slid. */
const LEDGE_NEVER_PAYS = 1_000_000;

interface PourRun {
  readonly brokeAt: number | null;
  readonly resumedAt: number | null;
  readonly player: PlayerState;
}

function balanceFromLedger(player: PlayerState): number {
  const l = player.ledger;
  return (
    l.granted +
    l.heap +
    l.won +
    l.crateIncome +
    l.offline -
    l.dropsPaid -
    l.upgradesPaid -
    l.forfeited
  );
}

/**
 * Replays the economy sim's player on a table whose ledge never pays, so every coin poured is
 * gone, applying the allowance after each tick the way the server applies it after a debit.
 */
function pourEverything(dropsPerSecond: number, seed: number, withAllowance: boolean): PourRun {
  const model = { ...simModel, baseDropsPerSecond: dropsPerSecond };
  const ctx = createContext(economyConfig, model, createRng(seed));
  const player = createPlayer(ctx);
  player.pileDebt = LEDGE_NEVER_PAYS;
  let steward: StewardAllowanceState = initialStewardAllowanceState;
  let brokeAt: number | null = null;
  let resumedAt: number | null = null;
  let dropsWhenBroke = 0;
  while (player.activeSeconds < 120 && resumedAt === null) {
    activeTick(ctx, player);
    if (brokeAt === null && player.coins < stewardAllowance.emptyBelowCoins) {
      brokeAt = player.activeSeconds;
      dropsWhenBroke = player.drops;
    } else if (brokeAt !== null && player.drops > dropsWhenBroke) {
      resumedAt = player.activeSeconds;
    }
    if (!withAllowance) continue;
    const grant = claimStewardAllowance(steward, player.coins, player.activeSeconds);
    steward = grant.state;
    player.coins += grant.coins;
    player.ledger.granted += grant.coins;
  }
  return { brokeAt, resumedAt, player };
}

const STARTING_COINS =
  economyConfig.upgradeLines.find((l) => l.effect.stat === 'startingCoins')?.effect.base ?? 0;
/**
 * The slowest pour that empties the starting Vault inside the deadline. One tick of slack: the
 * sim drops on whole 1 s ticks and its drop carry is a float.
 */
const SLOWEST_FULL_POUR = STARTING_COINS / (POUR_DEADLINE_SECONDS - simModel.tickSeconds);

describe("Steward's allowance in the economy sim", () => {
  it('reproduces the playtest dead end without it: a poured-out Vault never drops again', () => {
    const run = pourEverything(SLOWEST_FULL_POUR, 1, false);
    expect(run.brokeAt).not.toBeNull();
    expect(run.brokeAt).toBeLessThanOrEqual(POUR_DEADLINE_SECONDS);
    expect(run.resumedAt).toBeNull();
  });

  it('lets a player who pours everything in the first 30 s drop again within 20 s', () => {
    const fastestTap = 4;
    fc.assert(
      fc.property(
        fc.double({ min: SLOWEST_FULL_POUR, max: fastestTap, noNaN: true }),
        fc.integer(),
        (dropsPerSecond, seed) => {
          const run = pourEverything(dropsPerSecond, seed, true);
          expect(run.brokeAt).not.toBeNull();
          expect(run.brokeAt).toBeLessThanOrEqual(POUR_DEADLINE_SECONDS);
          expect(run.resumedAt).not.toBeNull();
          expect((run.resumedAt ?? Infinity) - (run.brokeAt ?? 0)).toBeLessThanOrEqual(
            RESUME_WITHIN_SECONDS,
          );
          expect(balanceFromLedger(run.player)).toBeCloseTo(run.player.coins, 9);
        },
      ),
      RUNS,
    );
  });

  it('pays far less than playing: its ceiling is under a quarter of the base active rate', () => {
    const ctx = createContext(economyConfig, simModel, createRng(1));
    const player = createPlayer(ctx);
    player.pileDebt = 0;
    expect(stewardAllowanceMaxRate()).toBeLessThan(0.25 * netRatePerSecond(ctx, player));
  });
});

const vaultArb = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 5_000 }));
const stepArb = fc.record({
  advance: fc.double({ min: 0, max: 400, noNaN: true }),
  vault: vaultArb,
});

function replay(start: number, steps: readonly { advance: number; vault: number }[]) {
  let state = initialStewardAllowanceState;
  let now = start;
  const grants: { at: number; coins: number; vault: number }[] = [];
  for (const step of steps) {
    now += step.advance;
    const before = state;
    const grant = claimStewardAllowance(state, step.vault, now);
    state = grant.state;
    if (grant.coins > 0) grants.push({ at: now, coins: grant.coins, vault: step.vault });
    else expect(grant.state.lastGrantSeconds).toBe(before.lastGrantSeconds);
  }
  return grants;
}

describe("Steward's allowance rule", () => {
  it('only ever pays a Vault that is empty, a fixed amount', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.array(stepArb),
        (start, steps) => {
          for (const grant of replay(start, steps)) {
            expect(grant.vault).toBeLessThan(stewardAllowance.emptyBelowCoins);
            expect(grant.coins).toBe(stewardAllowance.coins);
          }
        },
      ),
      RUNS,
    );
  });

  it('keeps grants a cooldown apart and within the daily cap', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.array(stepArb, { maxLength: 400 }),
        (start, steps) => {
          const grants = replay(start, steps);
          for (const [i, grant] of grants.entries()) {
            const previous = grants[i - 1];
            if (previous) {
              expect(grant.at - previous.at).toBeGreaterThanOrEqual(
                stewardAllowance.cooldownSeconds,
              );
            }
          }
          const perDay = new Map<number, number>();
          for (const grant of grants) {
            const day = Math.floor(grant.at / DAY);
            perDay.set(day, (perDay.get(day) ?? 0) + 1);
          }
          for (const count of perDay.values()) {
            expect(count).toBeLessThanOrEqual(stewardAllowance.maxPerDay);
          }
        },
      ),
      RUNS,
    );
  });

  it('never pays more over any span than its max rate allows', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 400 }), (steps) => {
        const grants = replay(0, steps);
        const first = grants[0];
        const last = grants.at(-1);
        if (!first || !last) return;
        const paid = grants.reduce((sum, g) => sum + g.coins, 0);
        expect(paid - stewardAllowance.coins).toBeLessThanOrEqual(
          stewardAllowanceMaxRate() * (last.at - first.at) + 1e-6,
        );
      }),
      RUNS,
    );
  });

  it('pays once the Vault has sat empty for the grace period, not before', () => {
    const empty = claimStewardAllowance(initialStewardAllowanceState, 0, 100);
    expect(empty.coins).toBe(0);
    expect(stewardAllowanceDueAt(empty.state, 100)).toBe(100 + stewardAllowance.graceSeconds);
    const early = claimStewardAllowance(empty.state, 0, 100 + stewardAllowance.graceSeconds - 0.01);
    expect(early.coins).toBe(0);
    const due = claimStewardAllowance(early.state, 0, 100 + stewardAllowance.graceSeconds);
    expect(due.coins).toBe(stewardAllowance.coins);
  });

  it('restarts the grace when a credit lands before it ends', () => {
    let state = claimStewardAllowance(initialStewardAllowanceState, 0, 0).state;
    state = claimStewardAllowance(state, 3, 2).state;
    expect(state.emptySinceSeconds).toBeNull();
    expect(stewardAllowanceDueAt(state, 2)).toBeNull();
    state = claimStewardAllowance(state, 0, 4).state;
    expect(claimStewardAllowance(state, 0, stewardAllowance.graceSeconds).coins).toBe(0);
    expect(claimStewardAllowance(state, 0, 4 + stewardAllowance.graceSeconds).coins).toBe(
      stewardAllowance.coins,
    );
  });

  it('waits out the cooldown after a grant, then pays again', () => {
    let state = claimStewardAllowance(initialStewardAllowanceState, 0, 0).state;
    state = claimStewardAllowance(state, 0, stewardAllowance.graceSeconds).state;
    expect(state.lastGrantSeconds).toBe(stewardAllowance.graceSeconds);
    state = claimStewardAllowance(state, 0, stewardAllowance.graceSeconds + 1).state;
    expect(stewardAllowanceDueAt(state, stewardAllowance.graceSeconds + 1)).toBe(
      stewardAllowance.graceSeconds + stewardAllowance.cooldownSeconds,
    );
  });

  it('stops for the rest of the UTC day at the cap and resumes the next day', () => {
    let state: StewardAllowanceState = initialStewardAllowanceState;
    let now = 0;
    let paid = 0;
    while (now < DAY) {
      const grant = claimStewardAllowance(state, 0, now);
      state = grant.state;
      if (grant.coins > 0) paid += 1;
      now += 1;
    }
    expect(paid).toBe(stewardAllowance.maxPerDay);
    expect(claimStewardAllowance(state, 0, DAY - 1).coins).toBe(0);
    const nextDay = claimStewardAllowance(state, 0, DAY);
    expect(nextDay.coins).toBe(stewardAllowance.coins);
    expect(nextDay.state.grantsToday).toBe(1);
  });

  it('rejects a balance or a clock it cannot reason about', () => {
    for (const vault of [-1, Number.NaN, Infinity]) {
      expect(() => claimStewardAllowance(initialStewardAllowanceState, vault, 0)).toThrow(
        /vaultCoins must be a finite number ≥ 0/,
      );
    }
    expect(() => claimStewardAllowance(initialStewardAllowanceState, 0, Number.NaN)).toThrow(
      /nowSeconds must be finite/,
    );
  });

  it('has positive whole-number settings and a grace short enough for the 20 s promise', () => {
    for (const value of [
      stewardAllowance.emptyBelowCoins,
      stewardAllowance.coins,
      stewardAllowance.maxPerDay,
    ]) {
      expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    }
    expect(stewardAllowance.graceSeconds).toBeGreaterThan(0);
    expect(stewardAllowance.graceSeconds).toBeLessThan(RESUME_WITHIN_SECONDS);
    expect(stewardAllowance.cooldownSeconds).toBeGreaterThanOrEqual(stewardAllowance.graceSeconds);
    expect(economyConfig.currencies.find((c) => c.id === 'coins')?.sources).toContain(
      'stewardAllowance',
    );
  });
});
