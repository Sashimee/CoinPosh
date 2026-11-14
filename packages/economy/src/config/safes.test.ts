import { SafeTypeIdSchema, type RewardPreview } from '@coinposh/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simModel } from '../../sim/model.ts';
import { activeTick, claimOffline, createContext, createPlayer } from '../../sim/player.ts';
import { percentile, runSimulation } from '../../sim/simulate.ts';
import { ODDS_SCALE, oddsTotal } from '../odds.ts';
import { initialPityState, rollDrop } from '../pity.ts';
import { createRng, type Rng } from '../rng.ts';
import {
  RARITY_IDS,
  type CrateRewardDef,
  type DropTableDef,
  type EconomyConfig,
  type PityState,
  type RarityId,
} from '../types.ts';
import { validateEconomyConfig } from '../validate.ts';
import { economyConfig } from './index.ts';
import { questCadences, streakMilestone } from './quests.ts';
import { safeTimerReady, safeTypeDef, safeUnlocksAt, safes } from './safes.ts';
import { seasonTierAt, seasonTrack } from './season.ts';

const RUNS = { numRuns: 300 };
const HOUR_MS = 3_600_000;
const SEEDS = [1, 2, 3, 4, 5];
const SEASON_DAYS = economyConfig.season.weeks * 7;

function table(config: EconomyConfig, source: DropTableDef['source']): DropTableDef {
  const found = config.dropTables.find((t) => t.source === source);
  if (found === undefined) throw new Error(`no ${source} drop table`);
  return found;
}

const gold = safeTypeDef(safes.crateDrop.type);

/** A rarity stream with pity, as the server rolls one source for one player. */
function roller(config: EconomyConfig, source: DropTableDef['source'], rng: Rng) {
  const t = table(config, source);
  let state: PityState = initialPityState(config.pity);
  return (): RarityId => {
    const roll = rollDrop(t, config.pity, state, rng);
    state = roll.state;
    return roll.rarity;
  };
}

/** Long-run share of each rarity for one source, pity included. */
function rarityShares(config: EconomyConfig, source: DropTableDef['source']) {
  const draws = 200_000;
  const next = roller(config, source, createRng(0x5afe));
  const counts = Object.fromEntries(RARITY_IDS.map((r) => [r, 0])) as Record<RarityId, number>;
  for (let i = 0; i < draws; i++) counts[next()] += 1;
  return Object.fromEntries(RARITY_IDS.map((r) => [r, counts[r] / draws])) as Record<
    RarityId,
    number
  >;
}

const keysIn = (rewards: readonly RewardPreview[]): number =>
  rewards.reduce(
    (sum, r) => sum + (r.kind === 'currency' && r.currency === 'keys' ? r.amount : 0),
    0,
  );
const starsIn = (rewards: readonly RewardPreview[]): number =>
  rewards.reduce(
    (sum, r) => sum + (r.kind === 'currency' && r.currency === 'stars' ? r.amount : 0),
    0,
  );
const perPeriod = (cadence: 'daily' | 'weekly', pick: (r: readonly RewardPreview[]) => number) =>
  questCadences[cadence].slots.reduce((s, d) => s + pick(questCadences[cadence].rewards[d]), 0);
/** quests.test.ts proves every weekly target falls inside the first five reference sessions. */
const WEEKLY_DONE_ON_DAY = 5;
const seasonKeysThrough = (tier: number): number =>
  seasonTrack.tiers.slice(0, tier).reduce((s, t) => s + keysIn(t.free), 0);

interface SafeFlow {
  readonly safes: number;
  readonly keyed: number;
  readonly timed: number;
  readonly keysLeft: number;
  readonly firstSafeMinutes: number | null;
  readonly maxLocked: number;
  /** Safes from an earlier session still ticking when a session begins. */
  readonly lockedAtSessionStart: number;
}

/**
 * The economy sim's casual player (two sessions a day, `simModel.casual`) with safes on top:
 * every crate the sim opens also rolls the Vault Crate table with pity on a side stream and
 * its `safeChance`; a safe opens with a Key the moment one is in hand, otherwise on its timer.
 * Keys come from the sim's crates, safe contents, the free season track and, with
 * `withQuests`, the daily and weekly hard quests and streak milestones.
 */
function playSafes(config: EconomyConfig, seed: number, days: number, withQuests: boolean) {
  const ctx = createContext(config, simModel, createRng(seed));
  const player = createPlayer(ctx);
  const side = createRng(seed ^ 0x5afe);
  const crateRarity = roller(config, 'vaultCrate', side);
  const safeType = safeTypeDef(config.safes.crateDrop.type, config.safes);
  const safeRarity = roller(config, safeType.dropSource, side);
  const { sessionStartHours, sessionMinutes } = simModel.casual;

  let keys = 0;
  let crateKeysSeen = 0;
  let seasonKeysSeen = 0;
  let questStars = 0;
  const locked: number[] = [];
  const flow = {
    safes: 0,
    keyed: 0,
    timed: 0,
    keysLeft: 0,
    firstSafeMinutes: null as number | null,
    maxLocked: 0,
    lockedAtSessionStart: 0,
  };
  const open = (): void => {
    keys += config.crateRewards[safeRarity()].keys;
  };
  const spendKeys = (): void => {
    while (keys >= safeType.keysPerSafe && locked.length > 0) {
      locked.pop();
      keys -= safeType.keysPerSafe;
      flow.keyed += 1;
      open();
    }
  };
  const openDue = (nowMs: number): void => {
    for (let i = locked.length - 1; i >= 0; i--) {
      if (safeTimerReady(locked[i] ?? Number.POSITIVE_INFINITY, nowMs)) {
        locked.splice(i, 1);
        flow.timed += 1;
        open();
      }
    }
  };

  let lastEndHour: number | null = null;
  for (let day = 0; day < days; day++) {
    for (const startHour of sessionStartHours) {
      const start = day * 24 + startHour;
      const startMs = start * HOUR_MS;
      if (lastEndHour !== null) claimOffline(ctx, player, start - lastEndHour);
      openDue(startMs);
      flow.lockedAtSessionStart += locked.length;
      for (let t = 0; t < (sessionMinutes * 60) / simModel.tickSeconds; t++) {
        const nowMs = Math.round(startMs + t * simModel.tickSeconds * 1_000);
        openDue(nowMs);
        const before = player.crates;
        activeTick(ctx, player);
        for (let c = before; c < player.crates; c++) {
          if (side.nextInt(ODDS_SCALE) < config.crateRewards[crateRarity()].safeChance) {
            flow.safes += 1;
            flow.firstSafeMinutes ??= player.activeSeconds / 60;
            locked.push(safeUnlocksAt(safeType.id, nowMs, config.safes));
          }
        }
        keys += player.keys - crateKeysSeen;
        crateKeysSeen = player.keys;
        const seasonKeys = seasonKeysThrough(seasonTierAt(player.stars + questStars));
        keys += seasonKeys - seasonKeysSeen;
        seasonKeysSeen = seasonKeys;
        spendKeys();
        flow.maxLocked = Math.max(flow.maxLocked, locked.length);
      }
      lastEndHour = start + sessionMinutes / 60;
    }
    if (withQuests) {
      keys += perPeriod('daily', keysIn) + keysIn(streakMilestone(day + 1)?.rewards ?? []);
      questStars += perPeriod('daily', starsIn);
      if (day % 7 === WEEKLY_DONE_ON_DAY - 1) {
        keys += perPeriod('weekly', keysIn);
        questStars += perPeriod('weekly', starsIn);
      }
      spendKeys();
    }
  }
  flow.keysLeft = keys;
  return flow satisfies SafeFlow;
}

const flows = {
  quests: SEEDS.map((seed) => playSafes(economyConfig, seed, SEASON_DAYS, true)),
  noQuests: SEEDS.map((seed) => playSafes(economyConfig, seed, SEASON_DAYS, false)),
};
const keyedShare = (f: SafeFlow): number => f.keyed / (f.keyed + f.timed);

describe('safe catalog', () => {
  it('ships the Gold safe the goldSafe drop table and the crate safe line both name', () => {
    expect(gold).toEqual({
      id: 'gold',
      dropSource: 'goldSafe',
      keysPerSafe: 1,
      unlockSeconds: 14_400,
    });
    expect(safes.crateDrop).toEqual({ source: 'vaultCrate', type: 'gold' });
    for (const type of safes.types) {
      expect(SafeTypeIdSchema.safeParse(type.id).success).toBe(true);
      const contents = table(economyConfig, type.dropSource);
      expect(contents.pity).toBe(true);
      expect(oddsTotal(contents.odds)).toBe(ODDS_SCALE);
    }
    expect(validateEconomyConfig(economyConfig)).toEqual([]);
  });

  it('names an unknown safe type and the catalog in the error', () => {
    expect(() => safeTypeDef('platinum')).toThrow(
      'Unknown safe type "platinum"; the catalog has gold',
    );
  });

  it('a better crate is never less likely to hold a safe, and every Heirloom crate holds one', () => {
    const chances = RARITY_IDS.map((r) => economyConfig.crateRewards[r].safeChance);
    expect(chances).toEqual([...chances].sort((a, b) => a - b));
    expect(economyConfig.crateRewards.heirloom.safeChance).toBe(ODDS_SCALE);
  });
});

describe('safe timers', () => {
  it('unlocksAt is the grant time plus the type duration, exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (grantedAt) => {
        expect(safeUnlocksAt('gold', grantedAt)).toBe(grantedAt + gold.unlockSeconds * 1_000);
      }),
      RUNS,
    );
  });

  it('a timer open succeeds from unlocksAt on and never a millisecond before', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.integer({ min: -gold.unlockSeconds * 2_000, max: gold.unlockSeconds * 2_000 }),
        (grantedAt, offset) => {
          const unlocksAt = safeUnlocksAt('gold', grantedAt);
          const now = unlocksAt + offset;
          expect(safeTimerReady(unlocksAt, now)).toBe(offset >= 0);
          expect(safeTimerReady(unlocksAt, grantedAt)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('rejects a grant time that is not a whole epoch millisecond', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => safeUnlocksAt('gold', bad)).toThrow(RangeError);
    }
    expect(() => safeUnlocksAt('vault', 0)).toThrow('Unknown safe type "vault"');
  });

  it('every timer runs out between two casual sessions, so the next one always finds it open', () => {
    const [first, second] = simModel.casual.sessionStartHours;
    const sessionHours = simModel.casual.sessionMinutes / 60;
    const shortestGapHours = Math.min(second - first, 24 - (second - first)) - sessionHours;
    for (const type of safes.types)
      expect(type.unlockSeconds / 3_600).toBeLessThan(shortestGapHours);
    for (const f of [...flows.quests, ...flows.noQuests]) expect(f.lockedAtSessionStart).toBe(0);
  });

  it('is longer than a whole casual day of play, so a Key is the only way to open it in session', () => {
    const playHoursPerDay =
      (simModel.casual.sessionMinutes * simModel.casual.sessionStartHours.length) / 60;
    expect(gold.unlockSeconds / 3_600).toBeGreaterThan(playHoursPerDay);
  });
});

describe('safe and Key flows (casual reference player, 42-day season, five seeds)', () => {
  it('drops 4–9 safes a casual day, the first inside the first day and mostly the first session', () => {
    const { sessionMinutes, sessionStartHours } = simModel.casual;
    const firsts = flows.noQuests.map((f) => f.firstSafeMinutes ?? Infinity);
    for (const f of [...flows.quests, ...flows.noQuests]) {
      expect(f.safes / SEASON_DAYS).toBeGreaterThanOrEqual(4);
      expect(f.safes / SEASON_DAYS).toBeLessThanOrEqual(9);
      expect(f.firstSafeMinutes ?? Infinity).toBeLessThanOrEqual(
        sessionMinutes * sessionStartHours.length,
      );
    }
    expect(percentile(firsts, 50)).toBeLessThanOrEqual(sessionMinutes);
  });

  it('Keys open most safes at once but never all, so a timer is always worth coming back for', () => {
    for (const f of flows.noQuests) {
      expect(keyedShare(f)).toBeGreaterThanOrEqual(0.5);
      expect(keyedShare(f)).toBeLessThanOrEqual(0.75);
    }
    for (const f of flows.quests) {
      expect(keyedShare(f)).toBeGreaterThanOrEqual(0.7);
      expect(keyedShare(f)).toBeLessThanOrEqual(0.95);
    }
    for (const [i, f] of flows.quests.entries()) {
      expect(keyedShare(f)).toBeGreaterThan(keyedShare(flows.noQuests[i] ?? f));
    }
  });

  it('Keys never pile up unspent and the rack never overflows a casual player', () => {
    for (const f of [...flows.quests, ...flows.noQuests]) {
      expect(f.keysLeft).toBeLessThanOrEqual(10);
      expect(f.maxLocked).toBeLessThanOrEqual(12);
    }
  });

  it('with a Key in every Exquisite crate, crates alone outrun safes and Keys hoard', () => {
    const exquisiteKey: EconomyConfig = {
      ...economyConfig,
      crateRewards: {
        ...economyConfig.crateRewards,
        exquisite: { ...economyConfig.crateRewards.exquisite, keys: 1 },
      },
    };
    for (const seed of SEEDS.slice(0, 2)) {
      const f = playSafes(exquisiteKey, seed, SEASON_DAYS, false);
      expect(keyedShare(f)).toBe(1);
      expect(f.keysLeft).toBeGreaterThan(100);
    }
  });
});

describe('safes against the pacing targets', () => {
  /**
   * Folds a safe's expected contents into each crate row the safe line can drop from, paid the
   * moment the crate opens. Real safes pay up to `unlockSeconds` later, so this is the fastest
   * safes could make any pacing milestone; album cards from safes are left out (sets complete
   * in minutes, hours before the first ascension the margins below protect).
   */
  function withSafesPaidAtOnce(config: EconomyConfig): EconomyConfig {
    const shares = rarityShares(config, safeTypeDef(config.safes.crateDrop.type).dropSource);
    const mean = (pick: (r: CrateRewardDef) => number): number =>
      RARITY_IDS.reduce((s, r) => s + shares[r] * pick(config.crateRewards[r]), 0);
    const safe = {
      incomeSeconds: mean((r) => r.incomeSeconds),
      pearls: mean((r) => r.pearls),
      keys: mean((r) => r.keys),
      tickets: mean((r) => r.tickets),
      charmChance: mean((r) => r.charmChance),
    };
    const crateRewards = Object.fromEntries(
      RARITY_IDS.map((rarity) => {
        const row = config.crateRewards[rarity];
        const p = row.safeChance / ODDS_SCALE;
        return [
          rarity,
          {
            ...row,
            incomeSeconds: row.incomeSeconds + p * safe.incomeSeconds,
            pearls: row.pearls + p * safe.pearls,
            keys: row.keys + p * safe.keys,
            tickets: row.tickets + p * safe.tickets,
            charmChance: Math.min(ODDS_SCALE, Math.round(row.charmChance + p * safe.charmChance)),
          },
        ];
      }),
    ) as Record<RarityId, CrateRewardDef>;
    return { ...config, crateRewards };
  }

  it('adds under 6 % to crate coin income', () => {
    const crates = rarityShares(economyConfig, 'vaultCrate');
    const income = (c: EconomyConfig) =>
      RARITY_IDS.reduce((s, r) => s + crates[r] * c.crateRewards[r].incomeSeconds, 0);
    const uplift = income(withSafesPaidAtOnce(economyConfig)) / income(economyConfig) - 1;
    expect(uplift).toBeGreaterThan(0.04);
    expect(uplift).toBeLessThan(0.06);
  });

  it('keeps every pacing target on target even when safes pay the moment they drop', () => {
    const config = withSafesPaidAtOnce(economyConfig);
    for (const seed of [1, 2, 3]) {
      const result = runSimulation(config, simModel, { days: 3, players: 24, seed });
      const misses = result.targets.filter((t) => !t.pass).map((t) => `${t.target.id}=${t.value}`);
      expect(misses).toEqual([]);
    }
  });
});
