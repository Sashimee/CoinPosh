import { ladderTargets } from '../src/config/index.ts';
import {
  PLAY_STYLE_IDS,
  type CoinTierId,
  type LadderTargetDef,
  type PlayStyleId,
} from '../src/types.ts';
import { ladderRuns } from './ladderRuns.ts';
import type { SimModel } from './model.ts';
import { distribution, percentile, type Distribution, type TargetResult } from './simulate.ts';

/** Tiers a Contact Fusion can create, lowest first. */
export const FUSED_TIERS = ['silver', 'gold', 'platinum', 'diamond', 'heirloom'] as const;
export type FusedTier = (typeof FUSED_TIERS)[number];

/** One seed of one play style, measured on packages/sim. */
export interface LadderRun {
  readonly seed: number;
  /** Copper coins dropped over the run. */
  readonly drops: number;
  readonly fusions: number;
  /** Most fusions inside any 60 s span (the server's `fusions` window). */
  readonly busiestFusions: number;
  /**
   * Most front-edge value inside any 30 s span (the server's `fallValue` window), each coin
   * credited at its combo's final Cascade multiplier: an upper bound on what the server pays.
   */
  readonly busiestFallValue: number;
  /** Face value that left the front edge, the opening heap included. */
  readonly frontValue: number;
  /** The part of `frontValue` that is fusion bonus (the × 1.25 on every merge). */
  readonly fusionBonusOut: number;
  /** Seconds until the first fusion into each tier; null when the run never made one. */
  readonly first: Readonly<Record<FusedTier, number | null>>;
}

export interface PlayStyle {
  readonly label: string;
  readonly tapsPerSecond: number;
  /** Half-width of the uniform aim spread in mm; 150 is the whole chute. */
  readonly aimSpreadMm: number;
  /** Adds a 2 s Sommelier Pour (a drop every 8 ticks) every 20 s on top of the taps. */
  readonly pour: boolean;
}

export const playStyles: Readonly<Record<PlayStyleId, PlayStyle>> = {
  casual: { label: '0.8/s, whole chute', tapsPerSecond: 0.8, aimSpreadMm: 150, pour: false },
  steady: { label: '1/s, whole chute', tapsPerSecond: 1, aimSpreadMm: 150, pour: false },
  aimed: { label: '1/s, ±40 mm', tapsPerSecond: 1, aimSpreadMm: 40, pour: false },
  aimedPinpoint: { label: '1/s, one spot', tapsPerSecond: 1, aimSpreadMm: 0, pour: false },
  rapidScatter: { label: '2/s, whole chute', tapsPerSecond: 2, aimSpreadMm: 150, pour: false },
  rapid: { label: '2/s, ±40 mm', tapsPerSecond: 2, aimSpreadMm: 40, pour: false },
  rapidPinpoint: { label: '2/s, one spot', tapsPerSecond: 2, aimSpreadMm: 0, pour: false },
  franticScatter: { label: '3/s, whole chute', tapsPerSecond: 3, aimSpreadMm: 150, pour: false },
  frantic: { label: '3/s, ±40 mm', tapsPerSecond: 3, aimSpreadMm: 40, pour: false },
  franticPinpoint: { label: '3/s, one spot', tapsPerSecond: 3, aimSpreadMm: 0, pour: false },
  franticPour: { label: '3/s + Pours, one spot', tapsPerSecond: 3, aimSpreadMm: 0, pour: true },
  overdrive: { label: '4/s, one spot', tapsPerSecond: 4, aimSpreadMm: 0, pour: false },
};

/**
 * Where `ladderRuns` comes from: packages/sim at `simCommit` with the Demo mechanics
 * (economy fusion rule, no tower) and the shipped opening heap, stepped `seconds` at 60 Hz
 * for each seed. Taps land every round(60 / tapsPerSecond) ticks at
 * `xMm = Math.round(Xoshiro128ss.fromSeed(seed ^ 0x7a9).nextRange(-spread, spread))`, the
 * aim RNG fusionRate.test.ts uses; a one-spot style (spread 0) drops at `xMm = 0` and draws
 * no RNG, since nextRange needs max > min. A Pour adds a drop every 8 ticks for 2 s every
 * 20 s. `first` times are the fusion event's tick / 60, rounded to 0.1 s; an independent
 * rebuild matched within one 0.1 s step. The generator is not committed yet (economy cannot
 * import @coinposh/sim, which depends on economy): it belongs in packages/sim, pinned to
 * `simVersion`. Rerun it whenever FUSION_TUNING or SIM_VERSION changes.
 */
export const ladderMeasurement = {
  simCommit: 'e3eb761',
  simVersion: 8,
  seconds: 300,
  seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
} as const;

export interface LadderStyleResult {
  readonly style: PlayStyleId;
  readonly firsts: Readonly<Record<FusedTier, Distribution>>;
  /** Seeds that made the tier inside the first minute. */
  readonly withinMinute: Readonly<Record<FusedTier, number>>;
  readonly fusionsPerMinute: number;
  readonly busiestFusions: number;
  readonly busiestFallValue: number;
  /** Fusion bonus that reached the front edge, per coin dropped. */
  readonly fusionBonusPerDrop: number;
}

export interface LadderResult {
  readonly styles: readonly LadderStyleResult[];
  readonly targets: readonly TargetResult[];
  /** What the economy model assumes `fusionBonusPerDrop` is at fusionWindow 1. */
  readonly modelFusionBonusPerDrop: number;
  /** The measured style the model's fusionShare is calibrated on, and what it measured. */
  readonly calibration: {
    readonly style: PlayStyleId;
    readonly fusionBonusPerDrop: number;
  };
}

/** How far the model's fusion bonus per drop may sit from its calibration style. */
export const CALIBRATION_TOLERANCE = 0.1;

/** The style that plays like the economy model: its base cadence across the whole chute. */
export function calibrationStyle(model: SimModel): PlayStyleId {
  const style = PLAY_STYLE_IDS.find(
    (id) =>
      playStyles[id].tapsPerSecond === model.baseDropsPerSecond &&
      playStyles[id].aimSpreadMm === 150 &&
      !playStyles[id].pour,
  );
  if (style === undefined) {
    throw new RangeError(
      `No ladder style taps ${model.baseDropsPerSecond}/s across the whole chute; measure one before changing baseDropsPerSecond.`,
    );
  }
  return style;
}

function fusionBonusPerDrop(runs: readonly LadderRun[]): number {
  const sum = (f: (run: LadderRun) => number): number => runs.reduce((a, run) => a + f(run), 0);
  return sum((run) => run.fusionBonusOut) / sum((run) => run.drops);
}

function firstTimes(runs: readonly LadderRun[], tier: FusedTier): (number | undefined)[] {
  return runs.map((run) => run.first[tier] ?? undefined);
}

function isFusedTier(tier: CoinTierId): tier is FusedTier {
  return (FUSED_TIERS as readonly string[]).includes(tier);
}

/** Unreached runs count as later than the fixture's last second, so a `min` still holds. */
export function evaluateLadderTarget(
  target: LadderTargetDef,
  runs: Readonly<Record<PlayStyleId, readonly LadderRun[]>> = ladderRuns,
): TargetResult {
  if (!isFusedTier(target.tier)) {
    throw new RangeError(`ladder target ${target.id}: no fusion creates ${target.tier}`);
  }
  if (target.max !== undefined && target.max > ladderMeasurement.seconds) {
    throw new RangeError(
      `ladder target ${target.id}: max ${target.max} s is past the ${ladderMeasurement.seconds} s fixture`,
    );
  }
  const values = firstTimes(runs[target.style], target.tier);
  const value = percentile(
    values.map((v) => v ?? Number.POSITIVE_INFINITY),
    target.percentile,
  );
  const pass =
    (target.min === undefined || value >= target.min) &&
    (target.max === undefined || value <= target.max);
  return { target, distribution: distribution(values), value, pass };
}

function styleResult(style: PlayStyleId, runs: readonly LadderRun[]): LadderStyleResult {
  const per = <T>(f: (tier: FusedTier) => T): Record<FusedTier, T> =>
    Object.fromEntries(FUSED_TIERS.map((tier) => [tier, f(tier)])) as Record<FusedTier, T>;
  const sum = (f: (run: LadderRun) => number): number => runs.reduce((a, run) => a + f(run), 0);
  return {
    style,
    firsts: per((tier) => distribution(firstTimes(runs, tier))),
    withinMinute: per(
      (tier) => runs.filter((run) => (run.first[tier] ?? Number.POSITIVE_INFINITY) <= 60).length,
    ),
    fusionsPerMinute: (sum((run) => run.fusions) / runs.length / ladderMeasurement.seconds) * 60,
    busiestFusions: Math.max(...runs.map((run) => run.busiestFusions)),
    busiestFallValue: Math.max(...runs.map((run) => run.busiestFallValue)),
    fusionBonusPerDrop: fusionBonusPerDrop(runs),
  };
}

export function evaluateLadder(
  model: SimModel,
  bonusMultiplier: number,
  targets: readonly LadderTargetDef[] = ladderTargets,
  runs: Readonly<Record<PlayStyleId, readonly LadderRun[]>> = ladderRuns,
): LadderResult {
  const style = calibrationStyle(model);
  return {
    styles: PLAY_STYLE_IDS.map((id) => styleResult(id, runs[id])),
    targets: targets.map((target) => evaluateLadderTarget(target, runs)),
    modelFusionBonusPerDrop: model.baseReturnRatio * model.fusionShare * (bonusMultiplier - 1),
    calibration: { style, fusionBonusPerDrop: fusionBonusPerDrop(runs[style]) },
  };
}

/** The busiest 60 s of fusions any honest style tapping at most `tapsPerSecond` reached. */
export function honestFusionPeak(
  tapsPerSecond: number,
  runs: Readonly<Record<PlayStyleId, readonly LadderRun[]>> = ladderRuns,
): number {
  return Math.max(
    0,
    ...PLAY_STYLE_IDS.filter((style) => playStyles[style].tapsPerSecond <= tapsPerSecond).flatMap(
      (style) => runs[style].map((run) => run.busiestFusions),
    ),
  );
}
