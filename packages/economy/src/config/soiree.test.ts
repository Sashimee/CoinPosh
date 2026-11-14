import {
  CoinTierIdSchema,
  SOIREE_DRAFT_SIZE,
  SOIREE_PERK_STATS,
  SoireeFavorIdSchema,
  SoireeGuestIdSchema,
  type SoireePerkStat,
} from '@coinposh/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simModel } from '../../sim/model.ts';
import { activeTick, createContext, createPlayer, rates } from '../../sim/player.ts';
import { runSimulation } from '../../sim/simulate.ts';
import { ODDS_SCALE, oddsRows } from '../odds.ts';
import { initialPityState, rollDrop } from '../pity.ts';
import { createRng } from '../rng.ts';
import {
  RARITY_IDS,
  UPGRADE_STAT_IDS,
  type CrateRewardDef,
  type EconomyConfig,
  type OddsTable,
  type PacingTargetId,
  type PityState,
  type RarityId,
  type SoireeConfig,
} from '../types.ts';
import { economyConfig } from './index.ts';
import {
  assertValidSoireeConfig,
  drawSoireeOffer,
  seatSoireeGuests,
  soireeActs,
  soireeBonusBound,
  soireeConfig,
  soireeCrateWorth,
  soireeFavorDef,
  soireeGuestDef,
  soireeMaxPerkWorth,
  soireePerkWorth,
  soireeReward,
  soireeRewardWorth,
  soireeRunEndsAt,
  soireeSeatCount,
  spendSoireeFavors,
  validateSoireeConfig,
} from './soiree.ts';

const RUNS = { numRuns: 300 };
const SEEDS = [1, 2, 3];
const seed = fc.integer({ min: 0, max: 0xffff_ffff });
const issuesOf = (config: SoireeConfig) => validateSoireeConfig(economyConfig, config);

describe('Soirée config', () => {
  it('validates as shipped', () => {
    expect(issuesOf(soireeConfig)).toEqual([]);
    expect(() => {
      assertValidSoireeConfig(economyConfig);
    }).not.toThrow();
  });

  it('runs eight minutes and drafts the contract draft size', () => {
    expect(soireeConfig.durationMs).toBe(480_000);
    expect(soireeConfig.draftSize).toBe(SOIREE_DRAFT_SIZE);
    expect(soireeRunEndsAt(1_700_000_000_000)).toBe(1_700_000_480_000);
    expect(() => soireeRunEndsAt(1.5)).toThrow(/epoch ms/);
  });

  it('names every problem it finds', () => {
    const broken: SoireeConfig = {
      ...soireeConfig,
      draftSize: 4,
      guests: [
        ...soireeConfig.guests,
        {
          id: 'duke',
          act: 3,
          request: { kind: 'falls', tier: 'mithril' as 'gold', count: 0, windowMs: 400_000 },
          favors: 0,
        },
      ],
      favors: [
        ...soireeConfig.favors,
        {
          id: 'goldLeaf',
          stat: 'offlineHours' as SoireePerkStat,
          magnitudeBp: 0,
          durationMs: 0,
          cost: 0,
        },
      ],
      rewards: soireeConfig.rewards.slice(0, 5),
      crateOdds: { ...soireeConfig.crateOdds, common: 3_999 },
    };
    const messages = issuesOf(broken).map((i) => `${i.path}: ${i.message}`);
    for (const expected of [
      /draftSize: must match/,
      /guests\[9\]: duplicate id "duke"/,
      /guests\[9\]\.request\.tier: unknown coin tier mithril/,
      /guests\[9\]\.request\.count/,
      /guests\[9\]\.favors/,
      /slowest seat plan needs/,
      /favors\[8\]: duplicate id "goldLeaf"/,
      /favors\[8\]\.stat: offlineHours is not a perk stat/,
      /favors\[8\]\.magnitudeBp/,
      /favors\[8\]\.durationMs/,
      /favors\[8\]\.cost/,
      /rewards: needs one tier per guests served, 0 to 6/,
      /crateOdds: weights sum to 9999, not 10000/,
    ]) {
      expect(
        messages.some((m) => expected.test(m)),
        String(expected),
      ).toBe(true);
    }
    expect(() => {
      assertValidSoireeConfig(economyConfig, broken);
    }).toThrow(/Soirée config is invalid/);
  });

  it('refuses a run that may out-earn the cap', () => {
    const greedy: SoireeConfig = {
      ...soireeConfig,
      rewards: soireeConfig.rewards.map((t, i) => (i === 6 ? { ...t, perfectCrates: 3 } : t)),
    };
    expect(issuesOf(greedy).map((i) => i.path)).toEqual(['soiree.cap']);
  });

  it('refuses a reward table that pays less for serving another guest', () => {
    const backwards: SoireeConfig = {
      ...soireeConfig,
      rewards: soireeConfig.rewards.map((t, i) => (i === 4 ? { ...t, keys: 0 } : t)),
    };
    expect(issuesOf(backwards).map((i) => i.path)).toEqual(['soiree.rewards[4]']);
  });
});

describe('guest roster', () => {
  it('seats at least six guests a run, two per act, with spares to rotate', () => {
    expect(soireeSeatCount()).toBeGreaterThanOrEqual(6);
    for (const act of soireeActs()) {
      expect(soireeConfig.guests.filter((g) => g.act === act).length).toBeGreaterThan(
        soireeConfig.seatsPerAct,
      );
    }
  });

  it('gives every guest a catalog id and a request on a real coin tier', () => {
    const tiers = new Set(economyConfig.coinTiers.map((t) => t.id));
    for (const guest of soireeConfig.guests) {
      expect(SoireeGuestIdSchema.safeParse(guest.id).success, guest.id).toBe(true);
      expect(CoinTierIdSchema.parse(guest.request.tier)).toBe(guest.request.tier);
      expect(tiers.has(guest.request.tier), guest.id).toBe(true);
    }
    expect(new Set(soireeConfig.guests.map((g) => g.id)).size).toBe(soireeConfig.guests.length);
  });

  it('pays more Favors and asks for rarer coins as the night goes on', () => {
    const tierRank = (tier: string) => economyConfig.coinTiers.findIndex((t) => t.id === tier);
    const acts = soireeActs();
    for (const [i, act] of acts.entries()) {
      const next = acts[i + 1];
      if (next === undefined) continue;
      const of = (a: number) => soireeConfig.guests.filter((g) => g.act === a);
      expect(Math.max(...of(act).map((g) => g.favors))).toBeLessThan(
        Math.min(...of(next).map((g) => g.favors)),
      );
      expect(Math.max(...of(act).map((g) => tierRank(g.request.tier)))).toBeLessThanOrEqual(
        Math.max(...of(next).map((g) => tierRank(g.request.tier))),
      );
    }
  });

  it('names an unknown guest or perk and the catalogue in the error', () => {
    expect(soireeGuestDef('duke').request.tier).toBe('platinum');
    expect(() => soireeGuestDef('jester')).toThrow(/"jester".*debutante/);
    expect(() => soireeFavorDef('fireworks')).toThrow(/"fireworks".*butlerService/);
  });

  it('seats each act in order, without a repeat, the same way for the same seed', () => {
    fc.assert(
      fc.property(seed, (s) => {
        const seated = seatSoireeGuests(createRng(s));
        expect(seated.length).toBe(soireeSeatCount());
        expect(new Set(seated.map((g) => g.id)).size).toBe(seated.length);
        expect(seated.map((g) => g.act)).toEqual(
          soireeActs().flatMap((act) => Array<number>(soireeConfig.seatsPerAct).fill(act)),
        );
        expect(seatSoireeGuests(createRng(s)).map((g) => g.id)).toEqual(seated.map((g) => g.id));
        const windows = seated.reduce((sum, g) => sum + g.request.windowMs, 0);
        expect(windows + (seated.length - 1) * soireeConfig.interludeMs).toBeLessThanOrEqual(
          soireeConfig.durationMs,
        );
      }),
      RUNS,
    );
  });
});

describe('Favor perks', () => {
  it('offers at least six temporary perks with unique catalog ids', () => {
    expect(soireeConfig.favors.length).toBeGreaterThanOrEqual(6);
    const ids = soireeConfig.favors.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(SoireeFavorIdSchema.safeParse(id).success, id).toBe(true);
  });

  it('lifts only existing upgrade stats, for less than the whole run', () => {
    for (const f of soireeConfig.favors) {
      expect((UPGRADE_STAT_IDS as readonly string[]).includes(f.stat), f.id).toBe(true);
      expect((SOIREE_PERK_STATS as readonly string[]).includes(f.stat), f.id).toBe(true);
      expect(f.durationMs, f.id).toBeLessThan(soireeConfig.durationMs / 4);
    }
    for (const stat of SOIREE_PERK_STATS) {
      expect(
        soireeConfig.favors.some((f) => f.stat === stat),
        stat,
      ).toBe(true);
    }
  });

  it('a draft holds three distinct perks from the catalogue', () => {
    const catalogue = new Set<string>(soireeConfig.favors.map((f) => f.id));
    fc.assert(
      fc.property(seed, (s) => {
        const offer = drawSoireeOffer(createRng(s));
        expect(offer.length).toBe(SOIREE_DRAFT_SIZE);
        expect(new Set(offer.map((f) => f.id)).size).toBe(SOIREE_DRAFT_SIZE);
        for (const f of offer) expect(catalogue.has(f.id)).toBe(true);
      }),
      RUNS,
    );
  });

  it('shows every perk in a draft at three in eight, so the odds the UI states hold', () => {
    const draws = 80_000;
    const rng = createRng(0x501_7ee);
    const seen = new Map<string, number>();
    for (let i = 0; i < draws; i++) {
      for (const f of drawSoireeOffer(rng)) seen.set(f.id, (seen.get(f.id) ?? 0) + 1);
    }
    const expected = SOIREE_DRAFT_SIZE / soireeConfig.favors.length;
    for (const f of soireeConfig.favors) {
      expect(Math.abs((seen.get(f.id) ?? 0) / draws - expected), f.id).toBeLessThan(0.006);
    }
  });

  it('conserves Favors: a draft never spends more than was earned, nor drafts past the bound', () => {
    const maxPerks = soireeMaxPerkWorth();
    fc.assert(
      fc.property(
        seed,
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.array(fc.integer({ min: -1, max: SOIREE_DRAFT_SIZE - 1 }), {
          minLength: 5,
          maxLength: 5,
        }),
        (s, served, picks) => {
          const rng = createRng(s);
          const seated = seatSoireeGuests(rng);
          let earned = 0;
          let spent = 0;
          let balance = 0;
          let worth = 0;
          seated.forEach((guest, i) => {
            if (served[i] === true) {
              earned += guest.favors;
              balance += guest.favors;
            }
            const pick = picks[i];
            if (pick === undefined) return;
            const favor = drawSoireeOffer(rng)[pick];
            if (favor === undefined) return;
            if (favor.cost > balance) {
              expect(() => spendSoireeFavors(balance, favor)).toThrow(/costs/);
              return;
            }
            balance = spendSoireeFavors(balance, favor);
            spent += favor.cost;
            worth += soireePerkWorth(favor);
          });
          expect(balance).toBeGreaterThanOrEqual(0);
          expect(earned).toBe(spent + balance);
          expect(worth).toBeLessThanOrEqual(maxPerks + 1e-9);
        },
      ),
      RUNS,
    );
  });
});

describe('run rewards', () => {
  it('both crate tables sum to exactly 100 %, as the odds sheet shows them', () => {
    for (const odds of [soireeConfig.crateOdds, soireeConfig.perfectCrateOdds]) {
      const rows = oddsRows(odds);
      expect(rows.reduce((s, r) => s + r.weight, 0)).toBe(ODDS_SCALE);
      expect(rows.reduce((s, r) => s + r.percent, 0)).toBeCloseTo(100, 10);
    }
  });

  it('a Soirée crate beats a Vault Crate and the perfect crate beats both', () => {
    const vault = economyConfig.dropTables.find((t) => t.source === 'vaultCrate');
    if (vault === undefined) throw new Error('no vaultCrate drop table');
    const worth = (odds: OddsTable) => soireeCrateWorth(odds, economyConfig);
    expect(worth(soireeConfig.crateOdds)).toBeGreaterThan(worth(vault.odds));
    expect(worth(soireeConfig.perfectCrateOdds)).toBeGreaterThan(worth(soireeConfig.crateOdds));
    expect(soireeConfig.perfectCrateOdds.common + soireeConfig.perfectCrateOdds.fine).toBe(0);
  });

  it('pays nothing for an empty night and never less for another guest served', () => {
    expect(soireeReward(0)).toEqual({ crates: 0, perfectCrates: 0, keys: 0 });
    for (let served = 1; served <= soireeSeatCount(); served++) {
      const now = soireeReward(served);
      const before = soireeReward(served - 1);
      expect(soireeRewardWorth(now, economyConfig)).toBeGreaterThanOrEqual(
        soireeRewardWorth(before, economyConfig),
      );
      expect(now.keys).toBeGreaterThanOrEqual(before.keys);
      expect(now.crates + now.perfectCrates + now.keys, `served ${served}`).toBeGreaterThan(
        before.crates + before.perfectCrates + before.keys,
      );
    }
    expect(soireeReward(soireeSeatCount()).perfectCrates).toBe(1);
    expect(() => soireeReward(7)).toThrow(/\[0, 6\]/);
    expect(() => soireeReward(-1)).toThrow();
  });
});

describe('Soirée cap', () => {
  const bound = soireeBonusBound(economyConfig);

  it('a perfect run adds under 60 % of eight minutes at the table, perks and crates together', () => {
    expect(bound.cap).toBeCloseTo(288, 9);
    expect(bound.total).toBeLessThanOrEqual(bound.cap);
    expect(bound.total).toBeGreaterThan(0.8 * bound.cap);
    expect(bound.perks).toBeLessThan(bound.rewards);
  });

  it('no drafting path beats the bound, saving Favors included', () => {
    const plans = (n: number): number[][] =>
      n === 0
        ? [[]]
        : plans(n - 1).flatMap((p) => [-1, ...soireeConfig.favors.keys()].map((i) => [...p, i]));
    const favorsBeforeDraft = [1, 1, 2, 2, 3];
    const worst = Math.max(
      ...plans(favorsBeforeDraft.length).map((picks) => {
        let balance = 0;
        let worth = 0;
        for (const [i, pick] of picks.entries()) {
          balance += favorsBeforeDraft[i] ?? 0;
          const favor = soireeConfig.favors[pick];
          if (favor === undefined) continue;
          if (favor.cost > balance) return 0;
          balance -= favor.cost;
          worth += soireePerkWorth(favor);
        }
        return worth;
      }),
    );
    expect(worst).toBeCloseTo(bound.perks, 9);
  });
});

/** Long-run Vault Crate income-seconds per open, pity included. */
function vaultCrateMean(config: EconomyConfig): number {
  const table = config.dropTables.find((t) => t.source === 'vaultCrate');
  if (table === undefined) throw new Error('no vaultCrate drop table');
  const rng = createRng(0xc4a7e);
  let state: PityState = initialPityState(config.pity);
  let sum = 0;
  const draws = 200_000;
  for (let i = 0; i < draws; i++) {
    const roll = rollDrop(table, config.pity, state, rng);
    state = roll.state;
    sum += config.crateRewards[roll.rarity].incomeSeconds;
  }
  return sum / draws;
}

describe('perk elasticity bounds against the balancing sim', () => {
  it('no perk adds more session income per unit of magnitude than its declared bound', () => {
    const crateMean = vaultCrateMean(economyConfig);
    const largest = (stat: SoireePerkStat) =>
      Math.max(...soireeConfig.favors.filter((f) => f.stat === stat).map((f) => f.magnitudeBp)) /
      ODDS_SCALE;
    const measured: Record<SoireePerkStat, number> = {
      pusherSpeed: 0,
      dropRate: 0,
      coinValue: 0,
      crateChance: 0,
      fusionWindow: 0,
    };
    const fusionLine = economyConfig.upgradeLines.find((l) => l.effect.stat === 'fusionWindow');
    if (fusionLine === undefined) throw new Error('no fusionWindow line');
    for (const s of SEEDS) {
      const ctx = createContext(economyConfig, simModel, createRng(s));
      const player = createPlayer(ctx);
      for (let t = 0; t < 6 * 3_600; t++) {
        activeTick(ctx, player);
        if (player.pileDebt > 0) continue;
        const r = rates(ctx, player);
        const g = r.grossPerDrop;
        const crates = r.crateChancePerDrop * r.dropsPerSecond * crateMean;
        const level = player.levels.get(fusionLine.id) ?? 0;
        const window = fusionLine.effect.base + fusionLine.effect.perLevel * level;
        const fused = simModel.fusionShare * window * (economyConfig.fusion.bonusMultiplier - 1);
        const value = g / (g - 1);
        const m = largest('dropRate');
        const sample: Record<SoireePerkStat, number> = {
          coinValue: value,
          pusherSpeed: value,
          dropRate: (1 + crates * (2 + m)) / (1 + crates),
          crateChance: crates / (1 + crates),
          fusionWindow: (fused / (1 + fused)) * value,
        };
        for (const stat of SOIREE_PERK_STATS) {
          measured[stat] = Math.max(measured[stat], sample[stat]);
        }
      }
    }
    for (const stat of SOIREE_PERK_STATS) {
      expect(measured[stat], stat).toBeLessThanOrEqual(soireeConfig.cap.perkElasticity[stat]);
      expect(measured[stat], stat).toBeGreaterThan(0.85 * soireeConfig.cap.perkElasticity[stat]);
    }
  }, 120_000);
});

describe('Soirée against the pacing targets', () => {
  const bound = soireeBonusBound(economyConfig);
  const best = soireeReward(soireeSeatCount());
  const charmsPer = (odds: OddsTable) =>
    RARITY_IDS.reduce(
      (s, r) =>
        s + (odds[r] / ODDS_SCALE) * (economyConfig.crateRewards[r].charmChance / ODDS_SCALE),
      0,
    );

  /**
   * Pays a full cap's worth of bonus once every `periodSeconds` of play: every coin stat lifted
   * by the cap over the period (net income rises at least as much, crates included), the run's
   * crates added as extra Vault Crates (their Stars, album cards and coins), and charm odds
   * lifted until those crates hold as many charms as the run's richer ones. Keys only open
   * safes sooner, which `safes.test.ts` already pays at once, so they move no milestone.
   */
  function withSoireeEvery(periodSeconds: number): EconomyConfig {
    const vault = economyConfig.dropTables.find((t) => t.source === 'vaultCrate');
    if (vault === undefined) throw new Error('no vaultCrate drop table');
    const k = 1 + bound.cap / periodSeconds;
    const crates = best.crates + best.perfectCrates;
    const baseCrates =
      (periodSeconds * simModel.baseDropsPerSecond) / economyConfig.crateSpawn.dropsPerCrate;
    const crateLift = (baseCrates + crates) / baseCrates;
    const charms =
      best.crates * charmsPer(soireeConfig.crateOdds) +
      best.perfectCrates * charmsPer(soireeConfig.perfectCrateOdds) -
      crates * charmsPer(vault.odds);
    const charmLift = 1 + Math.max(0, charms) / (baseCrates * crateLift * charmsPer(vault.odds));
    return {
      ...economyConfig,
      crateSpawn: {
        ...economyConfig.crateSpawn,
        dropsPerCrate: economyConfig.crateSpawn.dropsPerCrate / crateLift,
      },
      crateRewards: Object.fromEntries(
        RARITY_IDS.map((r) => {
          const row = economyConfig.crateRewards[r];
          return [
            r,
            { ...row, charmChance: Math.min(ODDS_SCALE, Math.ceil(row.charmChance * charmLift)) },
          ];
        }),
      ) as Record<RarityId, CrateRewardDef>,
      upgradeLines: economyConfig.upgradeLines.map((line) =>
        line.effect.stat === 'coinValue'
          ? {
              ...line,
              effect: {
                ...line.effect,
                base: line.effect.base * k,
                perLevel: line.effect.perLevel * k,
              },
            }
          : line,
      ),
    };
  }

  const missesOf = (config: EconomyConfig, ids: readonly PacingTargetId[]) => {
    const wanted = new Set<string>(ids);
    return SEEDS.flatMap((s) =>
      runSimulation(config, simModel, { days: 3, players: 24, seed: s })
        .targets.filter((t) => wanted.has(t.target.id) && !t.pass)
        .map((t) => `seed ${s} ${t.target.id}=${t.value}`),
    );
  };

  it('keeps the casual ascension on target with a capped run every casual day', () => {
    const casualDay =
      (simModel.casual.sessionStartHours.length * simModel.casual.sessionMinutes * 60) /
      soireeConfig.rewardedRunsPerDay;
    expect(casualDay).toBe(3_000);
    expect(missesOf(withSoireeEvery(casualDay), ['ascendVenue1Casual'])).toEqual([]);
  }, 120_000);

  it('keeps every active target on target with a capped run every two active hours', () => {
    const active: PacingTargetId[] = [
      'firstUpgrade',
      'firstCharm',
      'firstAlbumSet',
      'ascendVenue1',
      'ascendVenue2Ratio',
      'seasonFreeTrack',
    ];
    expect(missesOf(withSoireeEvery(7_200), active)).toEqual([]);
  }, 120_000);
});
