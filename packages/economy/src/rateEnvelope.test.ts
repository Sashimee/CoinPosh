import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cadenceStyles,
  fusionShareFor,
  honestPeak,
  ladderMeasurement,
  playStyles,
  type PeakField,
} from '../sim/ladder.ts';
import { ladderRuns } from '../sim/ladderRuns.ts';
import { simModel, type SimModel } from '../sim/model.ts';
import { createContext, createPlayer, rates } from '../sim/player.ts';
import { percentile } from '../sim/simulate.ts';
import {
  rateEnvelope,
  rateEnvelopeDerivation,
  rateEnvelopeFor,
  rateEnvelopeScale,
  validateRateEnvelope,
  type RateEnvelopeSource,
} from './config.ts';
import { economyConfig } from './config/index.ts';
import * as economy from './index.ts';
import { createRng, type Rng } from './rng.ts';
import {
  CASCADE_TIER_IDS,
  PLAY_STYLE_IDS,
  RATE_ENVELOPE_METRIC_IDS,
  VENUE_IDS,
  type RateEnvelopeConfig,
  type RateEnvelopeDerivation,
  type RateEnvelopeLimits,
  type RateEnvelopeMetricId,
  type RateEnvelopeTable,
} from './types.ts';

const BASE_TABLE: RateEnvelopeTable = {
  levels: {},
  venue: 'rivieraYacht',
  charms: 0,
  albumBonus: 0,
};

type Peaks = Record<RateEnvelopeMetricId, number>;

/** The economy sim's mean rates for one table, read from the same functions the balancing sim runs. */
function simRates(table: RateEnvelopeTable, model: SimModel = simModel) {
  const ctx = createContext(economyConfig, model, createRng(0));
  const player = createPlayer(ctx);
  for (const [id, level] of Object.entries(table.levels)) player.levels.set(id, level);
  player.venueIndex = economyConfig.venues.findIndex((v) => v.id === table.venue);
  player.charms = table.charms;
  player.albumBonus = table.albumBonus;
  player.rates = null;
  const { dropsPerSecond, grossPerDrop, crateChancePerDrop } = rates(ctx, player);
  const stat = (id: string): number => {
    const line = economyConfig.upgradeLines.find((l) => l.effect.stat === id);
    if (line === undefined) return 1;
    return line.effect.base + line.effect.perLevel * (table.levels[line.id] ?? 0);
  };
  return {
    dropsPerSecond,
    grossPerDrop,
    crateChancePerDrop,
    /** Copper-equivalent coins pushed off per coin dropped. */
    inputsPerDrop: model.baseReturnRatio * stat('pusherSpeed'),
    /** Share of returned value that went through one Contact Fusion. */
    fusedShare: Math.min(1, model.fusionShare * stat('fusionWindow')),
  };
}

function poisson(rng: Rng, mean: number): number {
  if (mean <= 0) return 0;
  const floor = Math.exp(-mean);
  let k = 0;
  let p = rng.nextFloat();
  while (p > floor) {
    k += 1;
    p *= rng.nextFloat();
  }
  return k;
}

interface Clump {
  readonly weight: number;
  readonly min: number;
  readonly max: number;
  readonly multiplier: number;
}

/** Cascade clumps weighted so each tier carries the sim's share of pushed-off coins. */
function clumps(model: SimModel, derivation: RateEnvelopeDerivation): Clump[] {
  const tiers = economyConfig.cascade.tiers;
  const list: Omit<Clump, 'weight'>[] = [
    { min: 1, max: derivation.looseMaxCoins, multiplier: 1 },
    ...CASCADE_TIER_IDS.map((id, i) => {
      const tier = tiers.find((t) => t.id === id);
      if (tier === undefined) throw new Error(`No cascade tier ${id}`);
      const next = tiers[i + 1];
      const max = next === undefined ? derivation.obsceneMaxCoins : next.minCoins - 1;
      return { min: tier.minCoins, max, multiplier: tier.multiplier };
    }),
  ];
  const tierShare = CASCADE_TIER_IDS.reduce((sum, id) => sum + model.cascadeShare[id], 0);
  const shares = [1 - tierShare, ...CASCADE_TIER_IDS.map((id) => model.cascadeShare[id])];
  return list.map((clump, i) => ({
    ...clump,
    weight: (shares[i] ?? 0) / ((clump.min + clump.max) / 2),
  }));
}

/**
 * One honest session through the sim's mean rates plus the burst model: Sommelier Pours
 * bunch drops, the pusher turns them into falls after a lag, falls arrive as cascade
 * clumps, a share of falling coins are fused Silvers, and crates fall some time after
 * they spawn. Returns each metric's busiest window.
 */
function honestSession(
  rng: Rng,
  table: RateEnvelopeTable,
  config: RateEnvelopeConfig,
  derivation: RateEnvelopeDerivation,
  model: SimModel = simModel,
): Peaks {
  const sim = simRates(table, model);
  const dt = derivation.slotMs / 1_000;
  const slots = Math.round((model.casual.sessionMinutes * 60) / dt);
  const { inputCount, bonusMultiplier } = economyConfig.fusion;

  const f = sim.fusedShare;
  const fusedCoinChance = f / (inputCount - (inputCount - 1) * f);
  const fusedValue = inputCount * bonusMultiplier;
  const inputsPerCoin = fusedCoinChance * inputCount + (1 - fusedCoinChance);
  const valuePerCoinUnit = fusedCoinChance * fusedValue + (1 - fusedCoinChance);
  const shape = clumps(model, derivation);
  const totalWeight = shape.reduce((sum, c) => sum + c.weight, 0);
  const meanClump =
    shape.reduce((sum, c) => sum + (c.weight * (c.min + c.max)) / 2, 0) / totalWeight;
  const cascadeMean =
    shape.reduce((sum, c) => sum + c.weight * ((c.min + c.max) / 2) * c.multiplier, 0) /
    (totalWeight * meanClump);
  // Calibrated so the long-run value rate equals the sim's dropsPerSecond × grossPerDrop.
  const unitValue =
    sim.grossPerDrop / (sim.inputsPerDrop * cascadeMean * (valuePerCoinUnit / inputsPerCoin));

  const { pourShare, pourCadence, meanPourSeconds, tableLagSeconds } = derivation;
  const tapRate = (sim.dropsPerSecond * (1 - pourShare * pourCadence)) / (1 - pourShare);
  const pourRate = sim.dropsPerSecond * pourCadence;
  const pourStart = (dt * pourShare) / ((1 - pourShare) * meanPourSeconds);
  const pourEnd = dt / meanPourSeconds;

  const series: Record<RateEnvelopeMetricId, Float64Array> = {
    drops: new Float64Array(slots),
    falls: new Float64Array(slots),
    fallValue: new Float64Array(slots),
    fusions: new Float64Array(slots),
    crates: new Float64Array(slots),
  };
  const crateFallSlots = {
    min: derivation.crateFallSeconds.min / dt,
    max: derivation.crateFallSeconds.max / dt,
  };

  let pouring = false;
  let intensity = sim.dropsPerSecond;
  for (let s = 0; s < slots; s++) {
    pouring = pouring ? rng.nextFloat() >= pourEnd : rng.nextFloat() < pourStart;
    const drops = poisson(rng, (pouring ? pourRate : tapRate) * dt);
    series.drops[s] = drops;
    for (let d = 0; d < drops; d++) {
      if (rng.nextFloat() < sim.crateChancePerDrop) {
        const fall =
          s +
          Math.round(
            crateFallSlots.min + rng.nextFloat() * (crateFallSlots.max - crateFallSlots.min),
          );
        if (fall < slots) series.crates[fall] = (series.crates[fall] ?? 0) + 1;
      }
    }
    intensity += (drops / dt - intensity) * Math.min(1, dt / tableLagSeconds);

    const clumpRate = (intensity * sim.inputsPerDrop) / (meanClump * inputsPerCoin);
    const events = poisson(rng, clumpRate * dt);
    for (let e = 0; e < events; e++) {
      let pick = rng.nextFloat() * totalWeight;
      let clump = shape[shape.length - 1];
      for (const candidate of shape) {
        pick -= candidate.weight;
        if (pick < 0) {
          clump = candidate;
          break;
        }
      }
      if (clump === undefined) throw new Error('No cascade clump shape');
      const size = clump.min + rng.nextInt(clump.max - clump.min + 1);
      for (let c = 0; c < size; c++) {
        const fused = rng.nextFloat() < fusedCoinChance;
        series.falls[s] = (series.falls[s] ?? 0) + 1;
        if (fused) series.fusions[s] = (series.fusions[s] ?? 0) + 1;
        series.fallValue[s] =
          (series.fallValue[s] ?? 0) + (fused ? fusedValue : 1) * unitValue * clump.multiplier;
      }
    }
  }

  const peak = (metric: RateEnvelopeMetricId, windowMs = config[metric].windowMs): number => {
    const values = series[metric];
    const width = Math.round(windowMs / derivation.slotMs);
    let sum = 0;
    let best = 0;
    for (let s = 0; s < values.length; s++) {
      sum += values[s] ?? 0;
      if (s >= width) sum -= values[s - width] ?? 0;
      best = Math.max(best, sum);
    }
    return best;
  };
  // The burst model returns value per drop, not coins, so a faster pusher grows its fused
  // falls without bound. Real merges are capped by the coins fed into the window.
  const feed =
    (peak('drops', config.fusions.windowMs) + economyConfig.openingHeap.coins) / (inputCount - 1);
  return {
    drops: peak('drops'),
    falls: peak('falls'),
    fallValue: peak('fallValue'),
    fusions: Math.min(peak('fusions'), feed),
    crates: peak('crates'),
  };
}

/**
 * The model once per measured style at the model's cadence, each with the fusionShare that
 * style measured. Whole-chute play fuses least, so more separate coins fall; aimed play
 * fuses most. The envelope has to let every one of them through, not just the calibration.
 */
const honestModels: readonly SimModel[] = cadenceStyles(simModel).map((style) => ({
  ...simModel,
  fusionShare: fusionShareFor(style, simModel, economyConfig.fusion.bonusMultiplier),
}));

function sessionPeaks(
  table: RateEnvelopeTable,
  sessions: number,
  seed: number,
  model: SimModel,
): Peaks[] {
  const rng = createRng(seed);
  return Array.from({ length: sessions }, () =>
    honestSession(rng, table, rateEnvelope, rateEnvelopeDerivation, model),
  );
}

/**
 * What the shipped base `max` must be: the derivation's percentile of busiest windows, with
 * headroom, for whichever cadence style reaches it.
 */
function deriveBaseMax(peaksByStyle: readonly (readonly Peaks[])[]): Peaks {
  const { percentile: p, headroom } = rateEnvelopeDerivation;
  const at = (metric: RateEnvelopeMetricId) =>
    Math.max(
      ...peaksByStyle.map((peaks) =>
        Math.ceil(
          percentile(
            peaks.map((peak) => peak[metric]),
            p,
          ) * headroom,
        ),
      ),
    );
  return {
    drops: at('drops'),
    falls: at('falls'),
    fallValue: Math.max(at('fallValue'), physicsMax('fallValue')),
    fusions: Math.max(at('fusions'), physicsMax('fusions')),
    crates: at('crates'),
  };
}

/**
 * Metrics the physics ladder measures per run, and the run field that holds each one's
 * busiest window. The burst model under-reads both under aimed play: it only sees fused
 * coins that fall, and spreads value evenly, where aimed play piles high-tier coins up and
 * sheds them in a lump.
 */
const PHYSICS_METRICS = {
  fallValue: 'busiestFallValue',
  fusions: 'busiestFusions',
} as const satisfies Partial<Record<RateEnvelopeMetricId, PeakField>>;
type PhysicsMetric = keyof typeof PHYSICS_METRICS;
const isPhysicsMetric = (metric: RateEnvelopeMetricId): metric is PhysicsMetric =>
  metric in PHYSICS_METRICS;

/** The busiest measured window of every honest style up to the tap ceiling, with headroom. */
function physicsMax(metric: PhysicsMetric): number {
  const { honestTapsPerSecond, headroom } = rateEnvelopeDerivation;
  return Math.ceil(honestPeak(PHYSICS_METRICS[metric], honestTapsPerSecond) * headroom);
}

const honestStyles = PLAY_STYLE_IDS.filter(
  (style) => playStyles[style].tapsPerSecond <= rateEnvelopeDerivation.honestTapsPerSecond,
);

const upgradeLevels = fc.record(
  Object.fromEntries(
    economyConfig.upgradeLines.map((line) => [line.id, fc.integer({ min: 0, max: line.maxLevel })]),
  ),
);

const tables: fc.Arbitrary<RateEnvelopeTable> = fc.record({
  levels: upgradeLevels,
  venue: fc.constantFrom(...VENUE_IDS),
  charms: fc.integer({ min: 0, max: 8 }),
  albumBonus: fc.double({ min: 0, max: 2, noNaN: true }),
});

/**
 * The most merges one fusions window can hold on this table: every coin the drop cap lets
 * in plus the opening heap, and each merge removes inputCount − 1 of them.
 */
function fusionFeedBound(limits: RateEnvelopeLimits): number {
  const { inputCount } = economyConfig.fusion;
  const dropsPerWindow = (limits.drops.max * limits.fusions.windowMs) / limits.drops.windowMs;
  return (dropsPerWindow + economyConfig.openingHeap.coins) / (inputCount - 1);
}

const maxTable: RateEnvelopeTable = {
  levels: Object.fromEntries(economyConfig.upgradeLines.map((line) => [line.id, line.maxLevel])),
  venue: 'orbitalCasino',
  charms: 99,
  albumBonus: 0,
};

describe('rate envelope base limits', () => {
  const peaksByStyle = honestModels.map((model) =>
    sessionPeaks(BASE_TABLE, rateEnvelopeDerivation.sessions, rateEnvelopeDerivation.seed, model),
  );

  it('derive from every cadence style, whole chute to aimed', () => {
    expect(cadenceStyles(simModel)).toEqual(['casual', 'steady', 'aimed', 'aimedPinpoint']);
    const shares = honestModels.map((model) => model.fusionShare);
    expect(Math.min(...shares)).toBeLessThan(0.1);
    expect(Math.max(...shares)).toBeCloseTo(simModel.fusionShare, 3);
  });

  it('are exactly the derived 99.9th percentile with headroom, not hand-picked', () => {
    const shipped = Object.fromEntries(
      RATE_ENVELOPE_METRIC_IDS.map((m) => [m, rateEnvelope[m].max]),
    );
    expect(shipped).toEqual(deriveBaseMax(peaksByStyle));
  });

  it.each(Object.keys(PHYSICS_METRICS) as PhysicsMetric[])(
    'let every physics-measured run at 3 taps/s or less through %s untouched',
    (metric) => {
      expect(rateEnvelopeDerivation.honestTapsPerSecond).toBeLessThanOrEqual(3);
      expect(honestStyles).toEqual(expect.arrayContaining(['franticPinpoint', 'franticPour']));
      for (const style of honestStyles) {
        for (const run of ladderRuns[style]) {
          expect(run[PHYSICS_METRICS[metric]], `${style} seed ${run.seed}`).toBeLessThanOrEqual(
            rateEnvelope[metric].max,
          );
        }
      }
    },
  );

  it('let at least 99.9 % of every cadence style’s honest sessions through every window untouched', () => {
    for (const peaks of peaksByStyle) {
      for (const metric of RATE_ENVELOPE_METRIC_IDS) {
        const over = peaks.filter((peak) => peak[metric] > rateEnvelope[metric].max).length;
        expect(over / peaks.length).toBeLessThanOrEqual(
          1 - rateEnvelopeDerivation.percentile / 100,
        );
      }
    }
  });

  it('stay tight enough to bound a bot: within 4× the busiest cadence style’s median window', () => {
    for (const metric of RATE_ENVELOPE_METRIC_IDS.filter((m) => !isPhysicsMetric(m))) {
      const median = Math.max(
        ...peaksByStyle.map((peaks) =>
          percentile(
            peaks.map((peak) => peak[metric]),
            50,
          ),
        ),
      );
      expect(rateEnvelope[metric].max).toBeLessThanOrEqual(Math.max(4 * median, 4));
    }
  });

  it.each(Object.keys(PHYSICS_METRICS) as PhysicsMetric[])(
    'stay within 4× the median busiest %s window of the fastest measured honest styles',
    (metric) => {
      const ceiling = rateEnvelopeDerivation.honestTapsPerSecond;
      const fastest = PLAY_STYLE_IDS.filter((style) => playStyles[style].tapsPerSecond === ceiling);
      const median = percentile(
        fastest.flatMap((style) => ladderRuns[style].map((run) => run[PHYSICS_METRICS[metric]])),
        50,
      );
      expect(rateEnvelope[metric].max).toBeLessThanOrEqual(4 * median);
      expect(ladderMeasurement.seconds * 1_000).toBeGreaterThanOrEqual(
        rateEnvelope[metric].windowMs,
      );
    },
  );

  it('reproduce the sim’s mean coin rate, so the burst model only adds variance', () => {
    const sim = simRates(BASE_TABLE);
    const rng = createRng(7);
    const config: RateEnvelopeConfig = {
      ...rateEnvelope,
      drops: { ...rateEnvelope.drops, windowMs: 1_500_000 },
      fallValue: { ...rateEnvelope.fallValue, windowMs: 1_500_000 },
    };
    let dropped = 0;
    let value = 0;
    const sessions = 40;
    for (let i = 0; i < sessions; i++) {
      const peak = honestSession(rng, BASE_TABLE, config, rateEnvelopeDerivation);
      dropped += peak.drops;
      value += peak.fallValue;
    }
    const seconds = sessions * simModel.casual.sessionMinutes * 60;
    expect(dropped / seconds).toBeCloseTo(sim.dropsPerSecond, 1);
    expect(value / seconds / (sim.dropsPerSecond * sim.grossPerDrop)).toBeCloseTo(1, 1);
  });

  it('pass the validator and match the server envelope contract', () => {
    expect(validateRateEnvelope(rateEnvelope)).toEqual([]);
    expect(Object.keys(rateEnvelopeFor(BASE_TABLE))).toEqual([...RATE_ENVELOPE_METRIC_IDS]);
    for (const metric of RATE_ENVELOPE_METRIC_IDS) {
      expect(rateEnvelopeFor(BASE_TABLE)[metric]).toEqual({
        windowMs: rateEnvelope[metric].windowMs,
        max: rateEnvelope[metric].max,
      });
    }
  });
});

describe('rate envelope scaling', () => {
  it('never flags an honest session on any upgraded table', () => {
    fc.assert(
      fc.property(tables, fc.nat(), (table, seed) => {
        const limits = rateEnvelopeFor(table);
        for (const model of honestModels) {
          for (const peak of sessionPeaks(table, 25, seed, model)) {
            for (const metric of RATE_ENVELOPE_METRIC_IDS) {
              expect(peak[metric]).toBeLessThanOrEqual(limits[metric].max);
            }
          }
        }
      }),
      { numRuns: 12, seed: 0x45 },
    );
  });

  it('grows at least as fast as the sim’s coin, drop and crate rates on every upgrade path', () => {
    const base = simRates(BASE_TABLE);
    fc.assert(
      fc.property(tables, (table) => {
        const sim = simRates(table);
        const grows = (metric: RateEnvelopeMetricId) =>
          rateEnvelopeScale(rateEnvelope[metric], table);
        const slack = 1 + 1e-9;
        expect(sim.dropsPerSecond / base.dropsPerSecond).toBeLessThanOrEqual(
          grows('drops') * slack,
        );
        expect(
          (sim.dropsPerSecond * sim.inputsPerDrop) / (base.dropsPerSecond * base.inputsPerDrop),
        ).toBeLessThanOrEqual(grows('falls') * slack);
        expect(
          (sim.dropsPerSecond * sim.grossPerDrop) / (base.dropsPerSecond * base.grossPerDrop),
        ).toBeLessThanOrEqual(grows('fallValue') * slack);
        // Honest merges grow with the sim's fused-coin rate, but the coins that feed them
        // (drops plus a fixed heap) never grow faster than the drops.
        const fusionGrowth = Math.min(
          (sim.dropsPerSecond * sim.inputsPerDrop * sim.fusedShare) /
            (base.dropsPerSecond * base.inputsPerDrop * base.fusedShare),
          grows('drops'),
        );
        expect(fusionGrowth).toBeLessThanOrEqual(grows('fusions') * slack);
        expect(
          (sim.dropsPerSecond * sim.crateChancePerDrop) /
            (base.dropsPerSecond * base.crateChancePerDrop),
        ).toBeLessThanOrEqual(grows('crates') * slack);
      }),
      { numRuns: 300, seed: 0x45 },
    );
  });

  it('bounds fusions below what the drop cap could feed, on every upgrade level and venue', () => {
    const check = (table: RateEnvelopeTable): void => {
      const limits = rateEnvelopeFor(table);
      expect(limits.fusions.max).toBeLessThanOrEqual(fusionFeedBound(limits));
    };
    check(BASE_TABLE);
    for (const venue of VENUE_IDS) check({ ...maxTable, venue });
    fc.assert(
      fc.property(upgradeLevels, fc.constantFrom(...VENUE_IDS), (levels, venue) => {
        check({ ...BASE_TABLE, levels, venue });
      }),
      { numRuns: 500 },
    );
  });

  it('lifts fallValue by fusionWindow exactly as much as the sim’s fusion lift, rounded up', () => {
    const lift = simModel.fusionShare * (economyConfig.fusion.bonusMultiplier - 1);
    const elasticity = lift / (1 + lift);
    expect(rateEnvelope.fallValue.scaleBy.fusionWindow).toBeGreaterThanOrEqual(elasticity);
    expect(rateEnvelope.fallValue.scaleBy.fusionWindow).toBeLessThan(elasticity + 0.001);
    expect(rateEnvelope.fallValue.value.perCharm).toBe(simModel.charmIncomeBonus);
  });

  it('is monotonic: raising any level, venue, charm or album bonus never lowers a limit', () => {
    fc.assert(
      fc.property(tables, fc.nat(), (table, pick) => {
        const lines = economyConfig.upgradeLines;
        const line = lines[pick % lines.length];
        if (line === undefined) throw new Error('No upgrade lines');
        const level = table.levels[line.id] ?? 0;
        const venueIndex = VENUE_IDS.indexOf(table.venue);
        const raised: RateEnvelopeTable[] = [
          { ...table, levels: { ...table.levels, [line.id]: Math.min(line.maxLevel, level + 1) } },
          {
            ...table,
            venue: VENUE_IDS[Math.min(VENUE_IDS.length - 1, venueIndex + 1)] ?? table.venue,
          },
          { ...table, charms: table.charms + 1 },
          { ...table, albumBonus: table.albumBonus + 0.1 },
        ];
        const before = rateEnvelopeFor(table);
        for (const next of raised) {
          const after = rateEnvelopeFor(next);
          for (const metric of RATE_ENVELOPE_METRIC_IDS) {
            expect(after[metric].max).toBeGreaterThanOrEqual(before[metric].max);
            expect(after[metric].windowMs).toBe(before[metric].windowMs);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('stays inside the envelope of a fully upgraded table and never drops below base', () => {
    const ceiling = rateEnvelopeFor(maxTable);
    fc.assert(
      fc.property(tables, (table) => {
        const limits = rateEnvelopeFor({ ...table, albumBonus: 0 });
        for (const metric of RATE_ENVELOPE_METRIC_IDS) {
          expect(Number.isSafeInteger(limits[metric].max)).toBe(true);
          expect(limits[metric].max).toBeGreaterThanOrEqual(rateEnvelope[metric].max);
          expect(limits[metric].max).toBeLessThanOrEqual(ceiling[metric].max);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('scales each metric only by the stats it names', () => {
    const at = (levels: Record<string, number>) => rateEnvelopeFor({ ...BASE_TABLE, levels });
    const base = at({});
    const crates = at({ crateChance: 20 });
    expect(crates.crates.max).toBeGreaterThan(base.crates.max);
    expect({ ...crates, crates: base.crates }).toEqual(base);
    const coinValue = at({ coinValue: 100 });
    expect(coinValue.fallValue.max).toBe(Math.ceil(base.fallValue.max * 21 - 1e-9));
    expect({ ...coinValue, fallValue: base.fallValue }).toEqual(base);
    const dropRate = at({ dropRate: 25 });
    for (const metric of RATE_ENVELOPE_METRIC_IDS) {
      expect(dropRate[metric].max).toBe(Math.ceil(rateEnvelope[metric].max * 1.75 - 1e-9));
    }
  });

  it('counts only the Charms a venue has sockets for', () => {
    const three = rateEnvelopeFor({ ...BASE_TABLE, charms: 3 });
    expect(rateEnvelopeFor({ ...BASE_TABLE, charms: 50 })).toEqual(three);
    expect(three.fallValue.max).toBe(Math.ceil(rateEnvelope.fallValue.max * 1.18 - 1e-9));
  });
});

describe('rateEnvelopeFor input checks', () => {
  it.each<[string, RateEnvelopeTable, RegExp]>([
    [
      'an unknown line',
      { ...BASE_TABLE, levels: { warpDrive: 1 } },
      /unknown upgrade line "warpDrive"/,
    ],
    [
      'a level past max',
      { ...BASE_TABLE, levels: { dropRate: 26 } },
      /"dropRate" level must be an integer in \[0, 25\]/,
    ],
    ['a fractional level', { ...BASE_TABLE, levels: { dropRate: 1.5 } }, /"dropRate" level/],
    ['a negative level', { ...BASE_TABLE, levels: { dropRate: -1 } }, /"dropRate" level/],
    ['negative charms', { ...BASE_TABLE, charms: -1 }, /charms must be a non-negative integer/],
    ['a NaN album bonus', { ...BASE_TABLE, albumBonus: Number.NaN }, /albumBonus must be a finite/],
    [
      'an unknown venue',
      { ...BASE_TABLE, venue: 'moonBase' as RateEnvelopeTable['venue'] },
      /unknown venue "moonBase"/,
    ],
  ])('rejects %s', (_, table, message) => {
    expect(() => rateEnvelopeFor(table)).toThrow(message);
  });

  it('reads a caller-supplied envelope instead of the shipped one', () => {
    const source: RateEnvelopeSource = {
      upgradeLines: economyConfig.upgradeLines,
      venues: economyConfig.venues,
      rateEnvelope: { ...rateEnvelope, drops: { ...rateEnvelope.drops, max: 7, windowMs: 1_000 } },
    };
    expect(rateEnvelopeFor(BASE_TABLE, source).drops).toEqual({ windowMs: 1_000, max: 7 });
  });
});

describe('validateRateEnvelope', () => {
  it('reports every broken field by path', () => {
    const broken = {
      ...rateEnvelope,
      drops: { ...rateEnvelope.drops, windowMs: 0, max: 1.5 },
      falls: { ...rateEnvelope.falls, scaleBy: { dropRate: 2, luck: 1 } },
      fallValue: { ...rateEnvelope.fallValue, value: { perCharm: -0.1 } },
      warp: { windowMs: 1, max: 1, scaleBy: {}, value: null },
    } as unknown as RateEnvelopeConfig;
    expect(validateRateEnvelope(broken)).toEqual([
      { path: 'rateEnvelope.drops', message: 'windowMs must be a positive integer, got 0' },
      { path: 'rateEnvelope.drops', message: 'max must be a positive integer, got 1.5' },
      {
        path: 'rateEnvelope.falls',
        message: 'scaleBy.dropRate must be an elasticity in [0, 1], got 2',
      },
      { path: 'rateEnvelope.falls', message: 'scaleBy names unknown stat "luck"' },
      { path: 'rateEnvelope.fallValue', message: 'value.perCharm must be ≥ 0, got -0.1' },
      { path: 'rateEnvelope', message: 'unknown metric "warp"' },
    ]);
  });
});

describe('package surface', () => {
  it('lets the server read the envelope from @coinposh/economy alone', () => {
    expect(economy.rateEnvelopeFor).toBe(rateEnvelopeFor);
    expect(economy.rateEnvelope).toBe(rateEnvelope);
    expect(economy.RATE_ENVELOPE_METRIC_IDS).toEqual([
      'drops',
      'falls',
      'fallValue',
      'fusions',
      'crates',
    ]);
  });
});
