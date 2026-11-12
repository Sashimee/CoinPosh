import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig, ladderTargets } from '../src/config/index.ts';
import { PLAY_STYLE_IDS, type LadderTargetDef, type PlayStyleId } from '../src/types.ts';
import {
  CALIBRATION_TOLERANCE,
  FUSED_TIERS,
  calibrationStyle,
  evaluateLadder,
  evaluateLadderTarget,
  honestFusionPeak,
  ladderMeasurement,
  playStyles,
  type FusedTier,
  type LadderRun,
} from './ladder.ts';
import { ladderRuns } from './ladderRuns.ts';
import { simModel } from './model.ts';

const RUNS = { numRuns: 200 };
const { inputCount, bonusMultiplier } = economyConfig.fusion;
const heapCoins = economyConfig.openingHeap.coins;

const allRuns = PLAY_STYLE_IDS.flatMap((style) => ladderRuns[style].map((run) => ({ style, run })));

const firstTime = fc.option(fc.double({ min: 0, max: ladderMeasurement.seconds, noNaN: true }), {
  nil: null,
});

const syntheticRun: fc.Arbitrary<LadderRun> = fc
  .tuple(...FUSED_TIERS.map(() => firstTime))
  .map((times) => {
    let floor = 0;
    let reached = true;
    const first = Object.fromEntries(
      FUSED_TIERS.map((tier, i) => {
        const t = times[i] ?? null;
        if (!reached || t === null) {
          reached = false;
          return [tier, null];
        }
        floor = Math.max(floor, t);
        return [tier, floor];
      }),
    ) as Record<FusedTier, number | null>;
    return {
      seed: 0,
      drops: 300,
      fusions: 0,
      busiestFusions: 0,
      busiestFallValue: 0,
      frontValue: 0,
      fusionBonusOut: 0,
      first,
    };
  });

function withStyle(style: PlayStyleId, runs: readonly LadderRun[]) {
  return { ...ladderRuns, [style]: runs };
}

const targetArb: fc.Arbitrary<LadderTargetDef> = fc.record({
  id: fc.constant('synthetic'),
  label: fc.constant('synthetic'),
  style: fc.constantFrom(...PLAY_STYLE_IDS),
  tier: fc.constantFrom(...FUSED_TIERS),
  metric: fc.constant('activeSeconds' as const),
  percentile: fc.integer({ min: 1, max: 100 }),
  max: fc.integer({ min: 1, max: ladderMeasurement.seconds }),
});

describe('physics ladder fixture', () => {
  it('measures every play style on the same seeds', () => {
    for (const style of PLAY_STYLE_IDS) {
      expect(ladderRuns[style].map((run) => run.seed)).toEqual(ladderMeasurement.seeds);
    }
  });

  it('never fuses more coins than were on the table: each merge removes inputCount − 1', () => {
    for (const { run } of allRuns) {
      expect(run.fusions).toBeLessThanOrEqual((heapCoins + run.drops - 1) / (inputCount - 1));
      expect(run.busiestFusions).toBeLessThanOrEqual(run.fusions);
    }
  });

  it('climbs the ladder in order: no tier appears before the one it is fused from', () => {
    for (const { run } of allRuns) {
      let lower: number | null = 0;
      for (const tier of FUSED_TIERS) {
        const upper = run.first[tier];
        if (upper !== null) {
          expect(lower).not.toBeNull();
          expect(upper).toBeGreaterThanOrEqual(lower ?? Number.POSITIVE_INFINITY);
          expect(upper).toBeLessThanOrEqual(ladderMeasurement.seconds);
        }
        lower = upper;
      }
    }
  });

  it('pays fusion bonus only out of value that really left the front edge', () => {
    for (const { run } of allRuns) {
      expect(run.fusionBonusOut).toBeGreaterThanOrEqual(0);
      expect(run.fusionBonusOut).toBeLessThanOrEqual(run.frontValue);
      if (run.fusions === 0) expect(run.fusionBonusOut).toBe(0);
    }
  });
});

describe('ladder targets', () => {
  it('name a measured style, a fusable tier and bounds the 300 s fixture can judge', () => {
    for (const target of ladderTargets) {
      expect(PLAY_STYLE_IDS).toContain(target.style);
      expect(FUSED_TIERS as readonly string[]).toContain(target.tier);
      expect(() => evaluateLadderTarget(target)).not.toThrow();
    }
    expect(new Set(ladderTargets.map((t) => t.id)).size).toBe(ladderTargets.length);
  });

  it('refuse a max past the fixture and a tier no fusion creates', () => {
    const base = ladderTargets[0];
    expect(() => evaluateLadderTarget({ ...base, max: ladderMeasurement.seconds + 1 })).toThrow(
      /past the 300 s fixture/,
    );
    expect(() => evaluateLadderTarget({ ...base, tier: 'copper' })).toThrow(
      /no fusion creates copper/,
    );
  });

  it('report p10 ≤ p50 ≤ p90 for every style and tier', () => {
    const result = evaluateLadder(simModel, bonusMultiplier);
    for (const style of result.styles) {
      for (const tier of FUSED_TIERS) {
        const d = style.firsts[tier];
        expect(d.p10).toBeLessThanOrEqual(d.p50);
        expect(d.p50).toBeLessThanOrEqual(d.p90);
        expect(style.withinMinute[tier]).toBeLessThanOrEqual(ladderMeasurement.seeds.length);
      }
    }
  });

  it('treat an unreached tier as later than the fixture: it holds a min and misses a max', () => {
    fc.assert(
      fc.property(
        targetArb,
        fc.array(syntheticRun, { minLength: 1, maxLength: 12 }),
        (target, runs) => {
          const never = runs.map((run) => ({
            ...run,
            first: { ...run.first, [target.tier]: null },
          }));
          const field = withStyle(target.style, never);
          expect(evaluateLadderTarget(target, field).pass).toBe(false);
          const { id, label, style, tier, metric, percentile } = target;
          const asMin: LadderTargetDef = {
            id,
            label,
            style,
            tier,
            metric,
            percentile,
            min: ladderMeasurement.seconds,
          };
          expect(evaluateLadderTarget(asMin, field).pass).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('only gets harder to meet a max as any seed reaches a tier later', () => {
    fc.assert(
      fc.property(
        targetArb,
        fc.array(syntheticRun, { minLength: 1, maxLength: 12 }),
        fc.nat(),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (target, runs, pick, delay) => {
          const i = pick % runs.length;
          const later = runs.map((run, j) => {
            const t = run.first[target.tier as FusedTier];
            if (j !== i || t === null) return run;
            return { ...run, first: { ...run.first, [target.tier]: t + delay } };
          });
          const before = evaluateLadderTarget(target, withStyle(target.style, runs));
          const after = evaluateLadderTarget(target, withStyle(target.style, later));
          expect(after.value).toBeGreaterThanOrEqual(before.value);
          if (!before.pass) expect(after.pass).toBe(false);
        },
      ),
      RUNS,
    );
  });
});

describe('economy model calibration', () => {
  it('keeps the model’s fusion bonus per drop within tolerance of the style it plays like', () => {
    const result = evaluateLadder(simModel, bonusMultiplier);
    expect(result.calibration.style).toBe('casual');
    const measured = result.calibration.fusionBonusPerDrop;
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(result.modelFusionBonusPerDrop / measured - 1)).toBeLessThanOrEqual(
      CALIBRATION_TOLERANCE,
    );
  });

  it('flags a model that drifts from the physics, either way', () => {
    for (const factor of [0.8, 1.25, 2.7]) {
      const drifted = { ...simModel, fusionShare: simModel.fusionShare * factor };
      const result = evaluateLadder(drifted, bonusMultiplier);
      expect(
        Math.abs(result.modelFusionBonusPerDrop / result.calibration.fusionBonusPerDrop - 1),
      ).toBeGreaterThan(CALIBRATION_TOLERANCE);
    }
  });

  it('refuses a model cadence no ladder style measured', () => {
    expect(() => calibrationStyle({ ...simModel, baseDropsPerSecond: 1.7 })).toThrow(
      /No ladder style taps 1.7\/s/,
    );
  });
});

describe('honest fusion peak', () => {
  it('is monotonic in the tap ceiling and covers each style it admits', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(honestFusionPeak(lo)).toBeLessThanOrEqual(honestFusionPeak(hi));
          for (const style of PLAY_STYLE_IDS) {
            if (playStyles[style].tapsPerSecond > hi) continue;
            for (const run of ladderRuns[style]) {
              expect(run.busiestFusions).toBeLessThanOrEqual(honestFusionPeak(hi));
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('is 0 below the slowest measured style', () => {
    expect(honestFusionPeak(0.5)).toBe(0);
  });
});
