import { rateEnvelopeFor } from '../src/config.ts';
import { createRng } from '../src/rng.ts';
import {
  RATE_ENVELOPE_METRIC_IDS,
  type EconomyConfig,
  type RateEnvelopeLimits,
  type RateEnvelopeMetricId,
  type RateEnvelopeTable,
} from '../src/types.ts';
import type { SimModel } from './model.ts';
import {
  activeTick,
  createContext,
  createPlayer,
  currentVenue,
  rates,
  type PlayerContext,
  type PlayerState,
} from './player.ts';

/** Minutes of continuous play at which the generated table samples the sim player. */
export const ENVELOPE_CHECKPOINT_MINUTES = [0, 2, 10, 30, 60, 120, 180] as const;

export interface EnvelopeRow {
  readonly label: string;
  /** Active seconds into the run, or null for a synthetic ceiling row. */
  readonly activeSeconds: number | null;
  readonly table: RateEnvelopeTable;
  readonly limits: RateEnvelopeLimits;
  /** Sim mean per window for each metric, so headroom = limit / mean. */
  readonly mean: Readonly<Record<RateEnvelopeMetricId, number>>;
}

export interface EnvelopeTable {
  readonly seed: number;
  readonly rows: readonly EnvelopeRow[];
}

/** The table the server would key the envelope on for this sim player right now. */
export function tableOf(ctx: PlayerContext, player: PlayerState): RateEnvelopeTable {
  const levels: Record<string, number> = {};
  for (const line of ctx.config.upgradeLines) {
    const level = player.levels.get(line.id) ?? 0;
    if (level > 0) levels[line.id] = level;
  }
  return {
    levels,
    venue: currentVenue(ctx, player).id,
    charms: player.charms,
    albumBonus: Math.round(player.albumBonus * 1_000) / 1_000,
  };
}

function statOf(ctx: PlayerContext, table: RateEnvelopeTable, stat: string): number {
  const line = ctx.config.upgradeLines.find((l) => l.effect.stat === stat);
  if (line === undefined) return 1;
  return line.effect.base + line.effect.perLevel * (table.levels[line.id] ?? 0);
}

function meanPerWindow(
  ctx: PlayerContext,
  player: PlayerState,
  table: RateEnvelopeTable,
  limits: RateEnvelopeLimits,
): Record<RateEnvelopeMetricId, number> {
  const r = rates(ctx, player);
  const { inputCount } = ctx.config.fusion;
  const inputs = r.dropsPerSecond * ctx.model.baseReturnRatio * statOf(ctx, table, 'pusherSpeed');
  const fusedShare = Math.min(1, ctx.model.fusionShare * statOf(ctx, table, 'fusionWindow'));
  const fusedCoinChance = fusedShare / (inputCount - (inputCount - 1) * fusedShare);
  const falls = inputs / (fusedCoinChance * inputCount + 1 - fusedCoinChance);
  const perSecond: Record<RateEnvelopeMetricId, number> = {
    drops: r.dropsPerSecond,
    falls,
    fallValue: r.dropsPerSecond * r.grossPerDrop,
    fusions: falls * fusedCoinChance,
    crates: r.dropsPerSecond * r.crateChancePerDrop,
  };
  const mean = {} as Record<RateEnvelopeMetricId, number>;
  for (const metric of RATE_ENVELOPE_METRIC_IDS) {
    const seconds = limits[metric].windowMs / 1_000;
    mean[metric] = Math.round(perSecond[metric] * seconds * 100) / 100;
  }
  return mean;
}

function row(
  ctx: PlayerContext,
  player: PlayerState,
  label: string,
  activeSeconds: number | null,
): EnvelopeRow {
  const table = tableOf(ctx, player);
  const limits = rateEnvelopeFor(table);
  return { label, activeSeconds, table, limits, mean: meanPerWindow(ctx, player, table, limits) };
}

/** Every venue line maxed, every socket filled, at the Family Office levels the run reached. */
function ceilingRow(ctx: PlayerContext, from: PlayerState, venueIndex: number): EnvelopeRow {
  const player: PlayerState = { ...from, levels: new Map(from.levels), rates: null };
  player.venueIndex = venueIndex;
  for (const line of ctx.venueLines) player.levels.set(line.id, line.maxLevel);
  const venue = currentVenue(ctx, player);
  player.charms = venue.charmSockets;
  return row(ctx, player, `${venue.id} fully upgraded`, null);
}

/**
 * The limits the server's RateEnvelope will apply to the tables a real player actually
 * builds: one median-luck sim player sampled at fixed minutes of play, at each venue
 * entry and on the last tick before each Ascension, plus a fully upgraded ceiling per
 * venue. Generated, never hand-edited: `pnpm --filter @coinposh/economy sim --envelope`.
 */
export function buildEnvelopeTable(
  config: EconomyConfig,
  model: SimModel,
  seed: number,
): EnvelopeTable {
  const ctx = createContext(config, model, createRng(seed));
  const player = createPlayer(ctx);
  const rows: EnvelopeRow[] = [];
  const checkpoints = ENVELOPE_CHECKPOINT_MINUTES.map((m) => m * 60);
  const lastVenue = 2;
  let next = 0;
  rows.push(row(ctx, player, 'Fresh table', 0));
  next += 1;
  const cap = model.activeCapHours * 3_600;
  while (player.activeSeconds < cap && player.venueIndex < lastVenue) {
    const venueBefore = player.venueIndex;
    const before = { ...player, levels: new Map(player.levels), rates: null };
    activeTick(ctx, player);
    if (player.venueIndex !== venueBefore) {
      const leaving = currentVenue(ctx, before);
      rows.push(row(ctx, before, `${leaving.id} before Ascension`, before.activeSeconds));
      rows.push(ceilingRow(ctx, before, venueBefore));
      if (player.venueIndex < lastVenue) {
        rows.push(row(ctx, player, `${currentVenue(ctx, player).id} entry`, player.activeSeconds));
      }
    }
    const due = checkpoints[next];
    if (due !== undefined && player.activeSeconds >= due && player.venueIndex === 0) {
      rows.push(row(ctx, player, `${due / 60} min`, player.activeSeconds));
      next += 1;
    }
  }
  return { seed, rows };
}
