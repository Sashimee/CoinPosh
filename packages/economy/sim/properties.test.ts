import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rateEnvelopeFor } from '../src/config.ts';
import { economyConfig } from '../src/config/index.ts';
import { fusionValue } from '../src/formulas.ts';
import { ODDS_SCALE, formatPercent, oddsRows, oddsTotal, weightToPercent } from '../src/odds.ts';
import { createRng } from '../src/rng.ts';
import { RARITY_IDS, RATE_ENVELOPE_METRIC_IDS, type OddsTable } from '../src/types.ts';
import { buildEnvelopeTable, tableOf } from './envelopeTable.ts';
import { simModel, type SimModel } from './model.ts';
import {
  activeTick,
  claimOffline,
  createContext,
  createPlayer,
  type PlayerState,
} from './player.ts';

const RUNS = { numRuns: 25 };

function balanceFromLedger(player: PlayerState): number {
  const l = player.ledger;
  return l.granted + l.won + l.crateIncome + l.offline - l.dropsPaid - l.upgradesPaid - l.forfeited;
}

const models: fc.Arbitrary<SimModel> = fc
  .record({
    baseReturnRatio: fc.double({ min: 0.5, max: 2, noNaN: true }),
    emptyTable: fc.boolean(),
  })
  .map(({ baseReturnRatio, emptyTable }) => ({
    ...simModel,
    baseReturnRatio,
    pile: emptyTable ? { ...simModel.pile, startingCoins: 0 } : simModel.pile,
  }));

describe('sim coin conservation', () => {
  it('accounts for every coin: granted + won + crates + offline − drops − upgrades − forfeited', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        models,
        fc.array(
          fc.oneof(
            fc.record({ play: fc.integer({ min: 1, max: 2_000 }) }),
            fc.record({ away: fc.double({ min: 0, max: 48, noNaN: true }) }),
          ),
          { maxLength: 6 },
        ),
        (seed, model, steps) => {
          const ctx = createContext(economyConfig, model, createRng(seed));
          const player = createPlayer(ctx);
          for (const step of steps) {
            if ('play' in step) for (let i = 0; i < step.play; i += 1) activeTick(ctx, player);
            else claimOffline(ctx, player, step.away);
            expect(player.coins).toBeGreaterThanOrEqual(0);
            expect(player.coins).toBeCloseTo(balanceFromLedger(player), 6);
          }
        },
      ),
      RUNS,
    );
  });

  it('never mints a coin while the table is still building its pile', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 600 }), (seed, ticks) => {
        const empty = { ...simModel, pile: { ...simModel.pile, startingCoins: 0 } };
        const ctx = createContext(economyConfig, empty, createRng(seed));
        const player = createPlayer(ctx);
        for (let i = 0; i < ticks && player.pileDebt > 0; i += 1) activeTick(ctx, player);
        if (player.pileDebt > 0) {
          expect(player.ledger.won + player.ledger.crateIncome + player.ledger.offline).toBe(0);
        }
      }),
      RUNS,
    );
  });
});

describe('sim trajectories stay inside the server rate envelope', () => {
  it('drops and front-edge value per window never exceed rateEnvelopeFor(table)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 60, max: 4_000 }), (seed, ticks) => {
        const ctx = createContext(economyConfig, simModel, createRng(seed));
        const player = createPlayer(ctx);
        const dropsWindow = economyConfig.rateEnvelope.drops.windowMs / 1_000;
        const valueWindow = economyConfig.rateEnvelope.fallValue.windowMs / 1_000;
        interface Sample {
          at: number;
          drops: number;
          won: number;
        }
        const history: Sample[] = [];
        const since = (seconds: number, now: Sample): Sample =>
          history.find((h) => h.at > now.at - seconds) ?? now;
        for (let i = 0; i < ticks; i += 1) {
          const venue = player.venueIndex;
          activeTick(ctx, player);
          if (player.venueIndex !== venue) history.length = 0;
          const now = {
            at: player.activeSeconds,
            drops: player.ledger.dropsPaid,
            won: player.ledger.won,
          };
          history.push(now);
          const limits = rateEnvelopeFor(tableOf(ctx, player));
          expect(now.drops - since(dropsWindow, now).drops).toBeLessThanOrEqual(limits.drops.max);
          expect(now.won - since(valueWindow, now).won).toBeLessThanOrEqual(limits.fallValue.max);
        }
      }),
      { numRuns: 10 },
    );
  });

  it('every generated envelope row covers its sim mean with burst headroom', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        for (const row of buildEnvelopeTable(economyConfig, simModel, seed).rows) {
          for (const metric of RATE_ENVELOPE_METRIC_IDS) {
            expect(row.limits[metric].max, `${row.label} ${metric}`).toBeGreaterThanOrEqual(
              2 * row.mean[metric],
            );
          }
        }
      }),
      { numRuns: 5 },
    );
  });

  it('matches the committed table the server team reads', () => {
    const committed: unknown = JSON.parse(
      readFileSync(
        new URL('../../../docs/plan/balance-reports/rate-envelope.json', import.meta.url),
        'utf8',
      ),
    );
    expect(committed).toEqual(buildEnvelopeTable(economyConfig, simModel, 1));
  });
});

describe('fusion value conservation', () => {
  const faces: readonly number[] = economyConfig.coinTiers.map((t) => t.value);
  const copper = economyConfig.coinTiers[0].value;
  const { fusion } = economyConfig;

  it('a fused coin adds exactly (bonus − 1) × the inputs it consumed, never less', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...faces), {
          minLength: fusion.inputCount,
          maxLength: fusion.inputCount,
        }),
        fc.double({ min: 1, max: 64, noNaN: true }),
        (inputs, multiplier) => {
          const scaled = inputs.map((v) => v * multiplier);
          const sum = scaled.reduce((a, b) => a + b, 0);
          const fused = fusionValue(scaled, fusion);
          expect(fused - sum).toBeCloseTo((fusion.bonusMultiplier - 1) * sum, 9);
          expect(fused).toBeGreaterThanOrEqual(sum);
        },
      ),
    );
  });

  it('drop → fusion chain → front edge: value out = value in + the fusion bonuses, nothing else', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 40 }), { minLength: 1, maxLength: 200 }), (fuseAt) => {
        const pile: number[] = fuseAt.map(() => copper);
        let dropped = pile.reduce((a, b) => a + b, 0);
        let bonus = 0;
        for (const at of fuseAt) {
          if (pile.length < fusion.inputCount) {
            pile.push(copper);
            dropped += copper;
            continue;
          }
          const start = at % (pile.length - fusion.inputCount + 1);
          const inputs = pile.splice(start, fusion.inputCount);
          pile.push(fusionValue(inputs, fusion));
          bonus += (fusion.bonusMultiplier - 1) * inputs.reduce((a, b) => a + b, 0);
        }
        const offTheEdge = pile.reduce((a, b) => a + b, 0);
        expect(offTheEdge).toBeCloseTo(dropped + bonus, 6);
      }),
    );
  });
});

const oddsTables: fc.Arbitrary<OddsTable> = fc
  .array(fc.nat({ max: ODDS_SCALE }), {
    minLength: RARITY_IDS.length - 1,
    maxLength: RARITY_IDS.length - 1,
  })
  .map((cuts) => {
    const edges = [0, ...cuts.sort((a, b) => a - b), ODDS_SCALE];
    return Object.fromEntries(
      RARITY_IDS.map((r, i) => [r, (edges[i + 1] ?? ODDS_SCALE) - (edges[i] ?? 0)]),
    ) as OddsTable;
  });

describe('odds honesty', () => {
  it('the odds sheet of any table that sums to 100 % shows rows that sum to 100 %', () => {
    fc.assert(
      fc.property(oddsTables, (odds) => {
        expect(oddsTotal(odds)).toBe(ODDS_SCALE);
        const rows = oddsRows(odds);
        expect(rows.map((r) => r.rarity)).toEqual([...RARITY_IDS]);
        expect(rows.reduce((sum, r) => sum + r.percent, 0)).toBeCloseTo(100, 9);
      }),
    );
  });

  it('every percent label reads back as exactly the weight the server rolls', () => {
    fc.assert(
      fc.property(fc.nat({ max: ODDS_SCALE }), (weight) => {
        expect(Number(formatPercent(weight))).toBe(weightToPercent(weight));
      }),
    );
  });

  it('every shipped table and Charm chance is a valid probability on the odds scale', () => {
    for (const table of economyConfig.dropTables) expect(oddsTotal(table.odds)).toBe(ODDS_SCALE);
    for (const reward of Object.values(economyConfig.crateRewards)) {
      expect(Number.isInteger(reward.charmChance)).toBe(true);
      expect(reward.charmChance).toBeGreaterThanOrEqual(0);
      expect(reward.charmChance).toBeLessThanOrEqual(ODDS_SCALE);
    }
  });

  it('a better crate is never a worse Charm, Key or income roll', () => {
    const rewards = RARITY_IDS.map((r) => economyConfig.crateRewards[r]);
    for (const [i, hi] of rewards.entries()) {
      const lo = rewards[i - 1];
      if (lo === undefined) continue;
      expect(hi.charmChance).toBeGreaterThanOrEqual(lo.charmChance);
      expect(hi.keys).toBeGreaterThanOrEqual(lo.keys);
      expect(hi.incomeSeconds).toBeGreaterThan(lo.incomeSeconds);
    }
  });
});
