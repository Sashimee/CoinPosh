/**
 * Soirée Nights (T-3.06): the numbers and the rules that read them, as for quests. The server
 * seats the guests, rolls every draft and pays the run through these functions; the Demo mock
 * does the same with its own seed, and the client only shows what they report.
 *
 * Why each number is what it is, and the sim evidence behind the cap, is in 02-ECONOMY.md
 * "Soirée Nights (T-3.06)".
 */
import {
  COIN_TIERS,
  SOIREE_DRAFT_SIZE,
  SOIREE_PERK_STATS,
  SoireeFavorIdSchema,
  SoireeGuestIdSchema,
} from '@coinposh/shared';
import { ODDS_SCALE, oddsTotal } from '../odds.ts';
import type { Rng } from '../rng.ts';
import {
  RARITY_IDS,
  UPGRADE_STAT_IDS,
  type EconomyConfig,
  type OddsTable,
  type SoireeConfig,
  type SoireeFavorDef,
  type SoireeGuestDef,
  type SoireeRewardTier,
} from '../types.ts';
import type { ValidationIssue } from '../validate.ts';

const SECOND_MS = 1_000;

export const soireeConfig = {
  durationMs: 480_000,
  interludeMs: 10_000,
  rewardedRunsPerDay: 1,
  seatsPerAct: 2,
  draftSize: SOIREE_DRAFT_SIZE,
  guests: [
    {
      id: 'debutante',
      act: 1,
      request: { kind: 'falls', tier: 'copper', count: 15, windowMs: 45_000 },
      favors: 1,
    },
    {
      id: 'pianist',
      act: 1,
      request: { kind: 'falls', tier: 'copper', count: 20, windowMs: 60_000 },
      favors: 1,
    },
    {
      id: 'sommelier',
      act: 1,
      request: { kind: 'falls', tier: 'silver', count: 2, windowMs: 50_000 },
      favors: 1,
    },
    {
      id: 'heiress',
      act: 2,
      request: { kind: 'falls', tier: 'silver', count: 3, windowMs: 45_000 },
      favors: 2,
    },
    {
      id: 'countess',
      act: 2,
      request: { kind: 'falls', tier: 'silver', count: 5, windowMs: 60_000 },
      favors: 2,
    },
    {
      id: 'ambassador',
      act: 2,
      request: { kind: 'falls', tier: 'gold', count: 1, windowMs: 60_000 },
      favors: 2,
    },
    {
      id: 'admiral',
      act: 3,
      request: { kind: 'falls', tier: 'silver', count: 8, windowMs: 75_000 },
      favors: 3,
    },
    {
      id: 'maharani',
      act: 3,
      request: { kind: 'falls', tier: 'gold', count: 3, windowMs: 80_000 },
      favors: 3,
    },
    {
      id: 'duke',
      act: 3,
      request: { kind: 'falls', tier: 'platinum', count: 1, windowMs: 90_000 },
      favors: 3,
    },
  ],
  favors: [
    { id: 'butlerService', stat: 'dropRate', magnitudeBp: 1_500, durationMs: 40_000, cost: 1 },
    { id: 'midnightBuffet', stat: 'crateChance', magnitudeBp: 3_000, durationMs: 60_000, cost: 1 },
    { id: 'velvetRope', stat: 'fusionWindow', magnitudeBp: 4_000, durationMs: 75_000, cost: 1 },
    { id: 'champagneTower', stat: 'coinValue', magnitudeBp: 1_500, durationMs: 60_000, cost: 2 },
    { id: 'grandEntrance', stat: 'pusherSpeed', magnitudeBp: 1_000, durationMs: 60_000, cost: 2 },
    {
      id: 'crystalChandelier',
      stat: 'crateChance',
      magnitudeBp: 5_000,
      durationMs: 60_000,
      cost: 2,
    },
    { id: 'goldLeaf', stat: 'coinValue', magnitudeBp: 2_500, durationMs: 45_000, cost: 3 },
    { id: 'stringQuartet', stat: 'pusherSpeed', magnitudeBp: 2_000, durationMs: 60_000, cost: 3 },
  ],
  rewards: [
    { crates: 0, perfectCrates: 0, keys: 0 },
    { crates: 1, perfectCrates: 0, keys: 0 },
    { crates: 2, perfectCrates: 0, keys: 0 },
    { crates: 2, perfectCrates: 0, keys: 1 },
    { crates: 3, perfectCrates: 0, keys: 1 },
    { crates: 3, perfectCrates: 0, keys: 2 },
    { crates: 3, perfectCrates: 1, keys: 2 },
  ],
  crateOdds: {
    common: 4_000,
    fine: 3_200,
    rare: 1_800,
    exquisite: 700,
    legendary: 275,
    heirloom: 25,
  },
  perfectCrateOdds: {
    common: 0,
    fine: 0,
    rare: 6_500,
    exquisite: 2_500,
    legendary: 900,
    heirloom: 100,
  },
  cap: {
    maxBonusShare: 0.6,
    perkElasticity: {
      pusherSpeed: 2.4,
      dropRate: 1.6,
      coinValue: 2.4,
      crateChance: 0.55,
      fusionWindow: 0.4,
    },
  },
} as const satisfies SoireeConfig;

export function soireeActs(config: SoireeConfig = soireeConfig): readonly number[] {
  return [...new Set(config.guests.map((g) => g.act))].toSorted((a, b) => a - b);
}

export function soireeSeatCount(config: SoireeConfig = soireeConfig): number {
  return soireeActs(config).length * config.seatsPerAct;
}

export function soireeGuestDef(id: string, config: SoireeConfig = soireeConfig): SoireeGuestDef {
  const found = config.guests.find((g) => g.id === id);
  if (found === undefined) {
    throw new Error(
      `Unknown Soirée guest "${id}"; the roster is ${config.guests.map((g) => g.id).join(', ')}.`,
    );
  }
  return found;
}

export function soireeFavorDef(id: string, config: SoireeConfig = soireeConfig): SoireeFavorDef {
  const found = config.favors.find((f) => f.id === id);
  if (found === undefined) {
    throw new Error(
      `Unknown Soirée Favor "${id}"; the catalogue is ${config.favors.map((f) => f.id).join(', ')}.`,
    );
  }
  return found;
}

/** The first `count` items of a uniform shuffle (partial Fisher–Yates), each pick one draw. */
function drawDistinct<T>(items: readonly T[], count: number, rng: Rng): T[] {
  if (count > items.length) {
    throw new RangeError(`Cannot draw ${count} distinct items from ${items.length}.`);
  }
  const pool = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + rng.nextInt(pool.length - i);
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, count);
}

/** The run's guests in arrival order: `seatsPerAct` of each act, acts in order. */
export function seatSoireeGuests(
  rng: Rng,
  config: SoireeConfig = soireeConfig,
): readonly SoireeGuestDef[] {
  return soireeActs(config).flatMap((act) =>
    drawDistinct(
      config.guests.filter((g) => g.act === act),
      config.seatsPerAct,
      rng,
    ),
  );
}

/** One draft: `draftSize` distinct perks, each equally likely, so each shows at size / catalogue. */
export function drawSoireeOffer(
  rng: Rng,
  config: SoireeConfig = soireeConfig,
): readonly SoireeFavorDef[] {
  return drawDistinct(config.favors, config.draftSize, rng);
}

/** Favors left after drafting `favor`; refuses a pick the balance cannot pay for. */
export function spendSoireeFavors(balance: number, favor: SoireeFavorDef): number {
  if (!Number.isInteger(balance) || balance < 0) {
    throw new RangeError(`spendSoireeFavors: balance must be an integer ≥ 0, got ${balance}`);
  }
  if (favor.cost > balance) {
    throw new RangeError(
      `spendSoireeFavors: "${favor.id}" costs ${favor.cost} Favors and only ${balance} are left.`,
    );
  }
  return balance - favor.cost;
}

export function soireeRunEndsAt(startedAt: number, config: SoireeConfig = soireeConfig): number {
  if (!Number.isInteger(startedAt) || startedAt < 0) {
    throw new RangeError(`soireeRunEndsAt: startedAt must be epoch ms, got ${startedAt}`);
  }
  return startedAt + config.durationMs;
}

export function soireeReward(
  guestsServed: number,
  config: SoireeConfig = soireeConfig,
): SoireeRewardTier {
  const tier = config.rewards[guestsServed];
  if (!Number.isInteger(guestsServed) || tier === undefined) {
    throw new RangeError(
      `soireeReward: guestsServed must be an integer in [0, ${config.rewards.length - 1}], ` +
        `got ${guestsServed}`,
    );
  }
  return tier;
}

/** Session income a perk adds at most, in session-seconds. */
export function soireePerkWorth(
  favor: SoireeFavorDef,
  config: SoireeConfig = soireeConfig,
): number {
  return (
    (favor.durationMs / SECOND_MS) *
    (favor.magnitudeBp / ODDS_SCALE) *
    config.cap.perkElasticity[favor.stat]
  );
}

function mean(odds: OddsTable, pick: (rarity: (typeof RARITY_IDS)[number]) => number): number {
  return RARITY_IDS.reduce((sum, rarity) => sum + (odds[rarity] / ODDS_SCALE) * pick(rarity), 0);
}

/**
 * Expected income-seconds of a crate of these odds opened as a Vault Crate, with the Gold Safe
 * its `safeChance` may hold paid at once (pity left out: it moves the long-run share by
 * under a point and these crates carry no counters).
 */
export function soireeCrateWorth(odds: OddsTable, economy: EconomyConfig): number {
  const safeType = economy.safes.types.find((t) => t.id === economy.safes.crateDrop.type);
  const safeTable = economy.dropTables.find((t) => t.source === safeType?.dropSource);
  if (safeTable === undefined) {
    throw new Error(
      `soireeCrateWorth: no drop table for the crate safe "${economy.safes.crateDrop.type}".`,
    );
  }
  const safe = mean(safeTable.odds, (r) => economy.crateRewards[r].incomeSeconds);
  return mean(odds, (r) => {
    const row = economy.crateRewards[r];
    return row.incomeSeconds + (row.safeChance / ODDS_SCALE) * safe;
  });
}

export function soireeRewardWorth(
  tier: SoireeRewardTier,
  economy: EconomyConfig,
  config: SoireeConfig = soireeConfig,
): number {
  return (
    tier.crates * soireeCrateWorth(config.crateOdds, economy) +
    tier.perfectCrates * soireeCrateWorth(config.perfectCrateOdds, economy)
  );
}

/** Every seat plan as the Favors each seated guest pays, in arrival order. */
function seatPlans(config: SoireeConfig): number[][] {
  let plans: number[][] = [[]];
  for (const act of soireeActs(config)) {
    const guests = config.guests.filter((g) => g.act === act);
    const orders: number[][] = [];
    const pick = (chosen: number[], left: readonly SoireeGuestDef[]): void => {
      if (chosen.length === config.seatsPerAct) {
        orders.push(chosen);
        return;
      }
      left.forEach((g, i) => {
        pick([...chosen, g.favors], left.toSpliced(i, 1));
      });
    };
    pick([], guests);
    plans = plans.flatMap((plan) => orders.map((order) => [...plan, ...order]));
  }
  return plans;
}

/**
 * The most perk income any run can draft: every guest served, every draft offering the best
 * perk the balance pays for. Overlap is ignored (a new pick replaces the running one), so this
 * overstates what a run can reach. Draft `n` follows guest `n`; the last guest has no draft.
 */
export function soireeMaxPerkWorth(config: SoireeConfig = soireeConfig): number {
  const worth = config.favors.map((f) => ({ cost: f.cost, worth: soireePerkWorth(f, config) }));
  let best = 0;
  for (const plan of seatPlans(config)) {
    let reach = new Map<number, number>([[0, 0]]);
    for (const favors of plan.slice(0, -1)) {
      const next = new Map<number, number>();
      const keep = (balance: number, value: number): void => {
        if ((next.get(balance) ?? -1) < value) next.set(balance, value);
      };
      for (const [held, value] of reach) {
        const balance = held + favors;
        keep(balance, value);
        for (const f of worth) if (f.cost <= balance) keep(balance - f.cost, value + f.worth);
      }
      reach = next;
    }
    for (const value of reach.values()) best = Math.max(best, value);
  }
  return best;
}

export interface SoireeBonusBound {
  /** Expected session-seconds of the richest reward tier. */
  readonly rewards: number;
  readonly perks: number;
  readonly total: number;
  /** `maxBonusShare` of the run's length, in session-seconds. */
  readonly cap: number;
}

export function soireeBonusBound(
  economy: EconomyConfig,
  config: SoireeConfig = soireeConfig,
): SoireeBonusBound {
  const rewards = Math.max(...config.rewards.map((t) => soireeRewardWorth(t, economy, config)));
  const perks = soireeMaxPerkWorth(config);
  return {
    rewards,
    perks,
    total: rewards + perks,
    cap: config.cap.maxBonusShare * (config.durationMs / SECOND_MS),
  };
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function checkOdds(report: (path: string, message: string) => void, path: string, odds: OddsTable) {
  for (const rarity of RARITY_IDS) {
    if (!isCount(odds[rarity])) report(`${path}.${rarity}`, 'must be an integer weight ≥ 0');
  }
  const total = oddsTotal(odds);
  if (total !== ODDS_SCALE) report(path, `weights sum to ${total}, not ${ODDS_SCALE}`);
}

export function validateSoireeConfig(
  economy: EconomyConfig,
  config: SoireeConfig = soireeConfig,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report = (path: string, message: string): void => void issues.push({ path, message });

  if (!isPositiveInt(config.durationMs)) report('soiree.durationMs', 'must be an integer > 0');
  if (!isCount(config.interludeMs)) report('soiree.interludeMs', 'must be an integer ≥ 0');
  if (!isPositiveInt(config.rewardedRunsPerDay)) {
    report('soiree.rewardedRunsPerDay', 'must be an integer > 0');
  }
  if (!isPositiveInt(config.seatsPerAct)) report('soiree.seatsPerAct', 'must be an integer > 0');
  if (config.draftSize !== SOIREE_DRAFT_SIZE) {
    report(
      'soiree.draftSize',
      `must match the contract's SOIREE_DRAFT_SIZE (${SOIREE_DRAFT_SIZE})`,
    );
  }

  const guestIds = new Set<string>();
  const tiers = new Set(economy.coinTiers.map((t) => t.id));
  config.guests.forEach((g, i) => {
    const path = `soiree.guests[${i}]`;
    if (!SoireeGuestIdSchema.safeParse(g.id).success)
      report(path, `"${g.id}" is not a catalog key`);
    if (guestIds.has(g.id)) report(path, `duplicate id "${g.id}"`);
    guestIds.add(g.id);
    if (!isPositiveInt(g.act)) report(`${path}.act`, 'must be an integer > 0');
    if (!(COIN_TIERS as readonly string[]).includes(g.request.tier) || !tiers.has(g.request.tier)) {
      report(`${path}.request.tier`, `unknown coin tier ${g.request.tier}`);
    }
    if (!isPositiveInt(g.request.count)) report(`${path}.request.count`, 'must be an integer > 0');
    if (!isPositiveInt(g.request.windowMs)) {
      report(`${path}.request.windowMs`, 'must be an integer > 0');
    }
    if (!isPositiveInt(g.favors)) report(`${path}.favors`, 'must be an integer > 0');
  });

  const acts = soireeActs(config);
  acts.forEach((act, i) => {
    if (act !== i + 1)
      report('soiree.guests', `acts must run 1, 2, 3… without a gap, found ${act}`);
    const seated = config.guests.filter((g) => g.act === act).length;
    if (seated < config.seatsPerAct) {
      report('soiree.guests', `act ${act} has ${seated} guests for ${config.seatsPerAct} seats`);
    }
  });
  const longest = acts.reduce(
    (sum, act) =>
      sum +
      config.guests
        .filter((g) => g.act === act)
        .map((g) => g.request.windowMs)
        .toSorted((a, b) => b - a)
        .slice(0, config.seatsPerAct)
        .reduce((s, w) => s + w, 0),
    0,
  );
  const seats = soireeSeatCount(config);
  const needed = longest + Math.max(0, seats - 1) * config.interludeMs;
  if (needed > config.durationMs) {
    report(
      'soiree.guests',
      `the slowest seat plan needs ${needed} ms of windows and interludes, more than the ` +
        `${config.durationMs} ms run`,
    );
  }

  const favorIds = new Set<string>();
  const statIds: readonly string[] = UPGRADE_STAT_IDS;
  config.favors.forEach((f, i) => {
    const path = `soiree.favors[${i}]`;
    if (!SoireeFavorIdSchema.safeParse(f.id).success)
      report(path, `"${f.id}" is not a catalog key`);
    if (favorIds.has(f.id)) report(path, `duplicate id "${f.id}"`);
    favorIds.add(f.id);
    if (!(SOIREE_PERK_STATS as readonly string[]).includes(f.stat) || !statIds.includes(f.stat)) {
      report(`${path}.stat`, `${f.stat} is not a perk stat`);
    }
    if (!isPositiveInt(f.magnitudeBp)) report(`${path}.magnitudeBp`, 'must be an integer > 0');
    if (!isPositiveInt(f.durationMs) || f.durationMs > config.durationMs) {
      report(`${path}.durationMs`, 'must be an integer in (0, durationMs]');
    }
    if (!isPositiveInt(f.cost)) report(`${path}.cost`, 'must be an integer > 0');
  });
  if (config.favors.length < config.draftSize) {
    report('soiree.favors', `needs at least ${config.draftSize} perks to fill a draft`);
  }

  if (config.rewards.length !== seats + 1) {
    report('soiree.rewards', `needs one tier per guests served, 0 to ${seats}`);
  }
  config.rewards.forEach((t, i) => {
    const path = `soiree.rewards[${i}]`;
    for (const key of ['crates', 'perfectCrates', 'keys'] as const) {
      if (!isCount(t[key])) report(`${path}.${key}`, 'must be an integer ≥ 0');
    }
    const prev = config.rewards[i - 1];
    if (
      prev !== undefined &&
      (t.crates + t.perfectCrates < prev.crates + prev.perfectCrates ||
        t.perfectCrates < prev.perfectCrates ||
        t.keys < prev.keys)
    ) {
      report(path, 'serving another guest never pays less');
    }
  });
  checkOdds(report, 'soiree.crateOdds', config.crateOdds);
  checkOdds(report, 'soiree.perfectCrateOdds', config.perfectCrateOdds);

  for (const stat of SOIREE_PERK_STATS) {
    const e = config.cap.perkElasticity[stat];
    if (!(e >= 0)) report(`soiree.cap.perkElasticity.${stat}`, 'must be a number ≥ 0');
  }
  if (!(config.cap.maxBonusShare > 0)) report('soiree.cap.maxBonusShare', 'must be > 0');
  if (issues.length === 0) {
    const bound = soireeBonusBound(economy, config);
    if (bound.total > bound.cap) {
      report(
        'soiree.cap',
        `a perfect run may add ${bound.total.toFixed(1)} session-seconds, over the ` +
          `${bound.cap.toFixed(1)} the cap allows`,
      );
    }
  }
  return issues;
}

export function assertValidSoireeConfig(
  economy: EconomyConfig,
  config: SoireeConfig = soireeConfig,
): void {
  const issues = validateSoireeConfig(economy, config);
  if (issues.length > 0) {
    throw new Error(
      `Soirée config is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
}
