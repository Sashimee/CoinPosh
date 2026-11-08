import { ftueTargets } from '../src/config/index.ts';
import { createRng } from '../src/rng.ts';
import type {
  EconomyConfig,
  OpeningHeapConfig,
  PacingTargetDef,
  PacingTargetId,
} from '../src/types.ts';
import { dropsBeforeFirstFall, type SimModel } from './model.ts';
import {
  activeTick,
  claimOffline,
  createContext,
  createPlayer,
  currentVenue,
  venueBullion,
  type MilestoneId,
  type PlayerContext,
  type PlayerState,
} from './player.ts';

export interface SimOptions {
  readonly days: number;
  readonly players: number;
  readonly seed: number;
}

export interface Distribution {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /** Players who never reached the milestone inside the simulated window. */
  readonly unreached: number;
}

/** A pacing row from 02-ECONOMY.md or an FTUE row from 00-VISION. */
export type SimTarget = Omit<PacingTargetDef, 'id'> & { readonly id: string };

export interface TargetResult {
  readonly target: SimTarget;
  readonly distribution: Distribution;
  /** The value at the target's percentile; Infinity when that share of players never got there. */
  readonly value: number;
  readonly pass: boolean;
}

export interface DaySnapshot {
  readonly day: number;
  readonly venue: number;
  readonly bullionProgress: number;
  readonly goldBars: number;
  readonly crates: number;
  readonly charms: number;
  readonly albumSets: number;
  readonly pearls: number;
  readonly keys: number;
  readonly seasonTier: number;
  readonly activeMinutes: number;
}

export interface OpeningHeapResult extends OpeningHeapConfig {
  /** Drops paid into the heap before its first coin leaves the front edge. */
  readonly dropsBeforeFirstFall: number;
  /** Value the heap paid each active player, over the whole run. */
  readonly paid: Distribution;
}

export interface SimResult {
  readonly options: SimOptions;
  readonly openingHeap: OpeningHeapResult;
  readonly targets: readonly TargetResult[];
  readonly ftue: readonly TargetResult[];
  readonly active: Readonly<Record<MilestoneId, Distribution>>;
  readonly casualDays: readonly DaySnapshot[];
  readonly activeCapHours: number;
}

const MILESTONES: readonly MilestoneId[] = [
  'heapCleared',
  'firstUpgrade',
  'firstCrate',
  'firstCharm',
  'firstAlbumSet',
  'ascendVenue1',
  'ascendVenue2',
  'seasonFreeTrack',
];

function playerSeed(seed: number, index: number, cohort: number): number {
  return (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(cohort + 1, 0x85ebca6b)) >>> 0;
}

/** Nearest-rank percentile; missing values sort last as Infinity. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? Number.POSITIVE_INFINITY;
}

function distribution(values: readonly (number | undefined)[]): Distribution {
  const filled = values.map((v) => v ?? Number.POSITIVE_INFINITY);
  return {
    p10: percentile(filled, 10),
    p50: percentile(filled, 50),
    p90: percentile(filled, 90),
    unreached: values.filter((v) => v === undefined).length,
  };
}

function runActivePlayer(ctx: PlayerContext): PlayerState {
  const player = createPlayer(ctx);
  const cap = ctx.model.activeCapHours * 3_600;
  while (player.activeSeconds < cap) {
    activeTick(ctx, player);
    const m = player.milestones;
    if (m.ascendVenue2 !== undefined && m.seasonFreeTrack !== undefined) break;
  }
  return player;
}

interface CasualRun {
  readonly ascendVenue1Day: number | undefined;
  readonly snapshots: readonly DaySnapshot[];
}

function snapshot(ctx: PlayerContext, player: PlayerState, day: number): DaySnapshot {
  const venue = currentVenue(ctx, player);
  const { season } = ctx.config;
  return {
    day,
    venue: venue.order,
    bullionProgress: Math.min(1, venueBullion(ctx, player) / venue.bullionThreshold),
    goldBars: player.goldBars,
    crates: player.crates,
    charms: player.charms,
    albumSets: player.completedSets.size,
    pearls: player.pearls,
    keys: player.keys,
    seasonTier: Math.min(season.freeTiers, Math.floor(player.stars / season.starsPerTier)),
    activeMinutes: player.activeSeconds / 60,
  };
}

function runCasualPlayer(ctx: PlayerContext, days: number): CasualRun {
  const player = createPlayer(ctx);
  const { sessionStartHours, sessionMinutes } = ctx.model.casual;
  const firstStart = sessionStartHours[0] ?? 0;
  const sessionTicks = Math.round((sessionMinutes * 60) / ctx.model.tickSeconds);
  let lastEndHour: number | null = null;
  let ascendVenue1Day: number | undefined;
  const snapshots: DaySnapshot[] = [];

  for (let day = 0; day < days; day++) {
    for (const startOfDay of sessionStartHours) {
      const start = day * 24 + startOfDay;
      if (lastEndHour !== null) claimOffline(ctx, player, start - lastEndHour);
      for (let t = 0; t < sessionTicks; t++) {
        activeTick(ctx, player);
        if (ascendVenue1Day === undefined && player.milestones.ascendVenue1 !== undefined) {
          const hour = start + ((t + 1) * ctx.model.tickSeconds) / 3_600;
          ascendVenue1Day = (hour - firstStart) / 24;
        }
      }
      lastEndHour = start + sessionMinutes / 60;
    }
    snapshots.push(snapshot(ctx, player, day + 1));
  }
  return { ascendVenue1Day, snapshots };
}

function medianSnapshot(day: number, all: readonly DaySnapshot[]): DaySnapshot {
  const med = (pick: (s: DaySnapshot) => number): number => percentile(all.map(pick), 50);
  return {
    day,
    venue: med((s) => s.venue),
    bullionProgress: med((s) => s.bullionProgress),
    goldBars: med((s) => s.goldBars),
    crates: med((s) => s.crates),
    charms: med((s) => s.charms),
    albumSets: med((s) => s.albumSets),
    pearls: med((s) => s.pearls),
    keys: med((s) => s.keys),
    seasonTier: med((s) => s.seasonTier),
    activeMinutes: med((s) => s.activeMinutes),
  };
}

function evaluate(target: SimTarget, values: readonly (number | undefined)[]): TargetResult {
  const dist = distribution(values);
  const filled = values.map((v) => v ?? Number.POSITIVE_INFINITY);
  const value = percentile(filled, target.percentile);
  const pass =
    Number.isFinite(value) &&
    (target.min === undefined || value >= target.min) &&
    (target.max === undefined || value <= target.max);
  return { target, distribution: dist, value, pass };
}

export function runSimulation(
  config: EconomyConfig,
  model: SimModel,
  options: SimOptions,
): SimResult {
  if (!Number.isInteger(options.days) || options.days < 1) {
    throw new RangeError(`--days must be a positive integer, got ${options.days}`);
  }
  if (!Number.isInteger(options.players) || options.players < 1) {
    throw new RangeError(`--players must be a positive integer, got ${options.players}`);
  }

  const activeRuns: PlayerState[] = [];
  const casualRuns: CasualRun[] = [];
  for (let i = 0; i < options.players; i++) {
    activeRuns.push(
      runActivePlayer(createContext(config, model, createRng(playerSeed(options.seed, i, 0)))),
    );
    casualRuns.push(
      runCasualPlayer(
        createContext(config, model, createRng(playerSeed(options.seed, i, 1))),
        options.days,
      ),
    );
  }

  const active = Object.fromEntries(
    MILESTONES.map((id) => [id, distribution(activeRuns.map((p) => p.milestones[id]))]),
  ) as Record<MilestoneId, Distribution>;

  const venueRatio = activeRuns.map((p) => {
    const v1 = p.milestones.ascendVenue1;
    const v2 = p.milestones.ascendVenue2;
    return v1 === undefined || v2 === undefined ? undefined : (v2 - v1) / v1;
  });

  const valuesFor: Record<PacingTargetId, readonly (number | undefined)[]> = {
    firstUpgrade: activeRuns.map((p) => p.milestones.firstUpgrade),
    firstCharm: activeRuns.map((p) => p.milestones.firstCharm),
    firstAlbumSet: activeRuns.map((p) => p.milestones.firstAlbumSet),
    ascendVenue1: activeRuns.map((p) => p.milestones.ascendVenue1),
    ascendVenue1Casual: casualRuns.map((r) => r.ascendVenue1Day),
    ascendVenue2Ratio: venueRatio,
    seasonFreeTrack: activeRuns.map((p) => {
      const s = p.milestones.seasonFreeTrack;
      return s === undefined ? undefined : s / 3_600;
    }),
  };

  const casualDays: DaySnapshot[] = [];
  for (let d = 0; d < options.days; d++) {
    casualDays.push(
      medianSnapshot(
        d + 1,
        casualRuns.map((r) => {
          const s = r.snapshots[d];
          if (s === undefined) throw new Error(`Missing casual snapshot for day ${d + 1}`);
          return s;
        }),
      ),
    );
  }

  return {
    options,
    openingHeap: {
      ...config.openingHeap,
      dropsBeforeFirstFall: dropsBeforeFirstFall(model.pile, config.openingHeap.coins),
      paid: distribution(activeRuns.map((p) => p.ledger.heap)),
    },
    targets: config.pacing.map((target) => evaluate(target, valuesFor[target.id])),
    ftue: ftueTargets.map((target) =>
      evaluate(
        target,
        activeRuns.map((p) => p.milestones[target.id]),
      ),
    ),
    active,
    casualDays,
    activeCapHours: model.activeCapHours,
  };
}
