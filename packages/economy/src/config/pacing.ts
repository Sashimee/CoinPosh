import type { LadderTargetDef, PacingTargetDef } from '../types.ts';

const MINUTE = 60;
const HOUR = 3_600;

/** Mirrors 02-ECONOMY.md "Pacing targets"; the balancing sim checks every row. */
export const pacing = [
  {
    id: 'firstUpgrade',
    label: 'First upgrade',
    metric: 'activeSeconds',
    percentile: 90,
    max: 2 * MINUTE,
  },
  {
    id: 'firstCharm',
    label: 'First Charm',
    metric: 'activeSeconds',
    percentile: 90,
    max: 5 * MINUTE,
  },
  {
    id: 'firstAlbumSet',
    label: 'First album set',
    metric: 'activeSeconds',
    percentile: 50,
    max: 45 * MINUTE,
  },
  {
    id: 'ascendVenue1',
    label: 'Ascend Venue 1 (active)',
    metric: 'activeSeconds',
    percentile: 50,
    min: 3 * HOUR,
    max: 5 * HOUR,
  },
  {
    id: 'ascendVenue1Casual',
    label: 'Ascend Venue 1 (casual)',
    metric: 'casualDays',
    percentile: 50,
    min: 1.5,
    max: 2.5,
  },
  {
    id: 'ascendVenue2Ratio',
    label: 'Venue 2 / Venue 1 time',
    metric: 'ratio',
    percentile: 50,
    min: 1.4,
    max: 1.8,
  },
  {
    id: 'seasonFreeTrack',
    label: 'Free season track',
    metric: 'activeHours',
    percentile: 50,
    min: 25,
    max: 35,
  },
] as const satisfies readonly PacingTargetDef[];

/**
 * 00-VISION "Retention and FTUE targets" the economy sim can see on its own. First drop,
 * first Cascade and first Fusion are table physics, measured on packages/sim.
 */
export const ftueTargets = [
  {
    id: 'firstCrate',
    label: 'First Vault Crate',
    metric: 'activeSeconds',
    percentile: 90,
    max: 45,
  },
] as const satisfies readonly (Omit<PacingTargetDef, 'id'> & { readonly id: string })[];

/**
 * The fusion ladder, per play style (sim/ladder.ts). 00-VISION asks for a first Fusion
 * inside 60 s; above that, a Diamond (625) is about 24 min of base net income, so it is a
 * session goal that even 2–3 aimed taps a second should not reach inside the first minute,
 * and an Heirloom stays out of a five-minute session altogether. The physics fixture runs
 * 300 s, so no `max` may exceed 5 min.
 */
export const ladderTargets = [
  {
    id: 'firstFusionCasual',
    label: 'First Fusion, casual taps',
    style: 'casual',
    tier: 'silver',
    metric: 'activeSeconds',
    percentile: 90,
    max: MINUTE,
  },
  {
    id: 'firstFusionAimed',
    label: 'First Fusion, aimed taps',
    style: 'aimed',
    tier: 'silver',
    metric: 'activeSeconds',
    percentile: 90,
    max: 10,
  },
  {
    id: 'firstGoldAimed',
    label: 'First Gold, aimed taps',
    style: 'aimed',
    tier: 'gold',
    metric: 'activeSeconds',
    percentile: 90,
    max: 30,
  },
  {
    id: 'firstPlatinumAimed',
    label: 'First Platinum, aimed taps',
    style: 'aimed',
    tier: 'platinum',
    metric: 'activeSeconds',
    percentile: 50,
    max: 5 * MINUTE,
  },
  {
    id: 'firstPlatinumRapid',
    label: 'First Platinum, 2 aimed taps/s',
    style: 'rapid',
    tier: 'platinum',
    metric: 'activeSeconds',
    percentile: 90,
    max: MINUTE,
  },
  {
    id: 'firstDiamondRapidSoonest',
    label: 'First Diamond, 2 pinpoint taps/s',
    style: 'rapidPinpoint',
    tier: 'diamond',
    metric: 'activeSeconds',
    percentile: 10,
    min: MINUTE,
  },
  {
    id: 'firstDiamondRapid',
    label: 'First Diamond, 2 pinpoint taps/s',
    style: 'rapidPinpoint',
    tier: 'diamond',
    metric: 'activeSeconds',
    percentile: 50,
    max: 5 * MINUTE,
  },
  {
    id: 'firstDiamondFranticSoonest',
    label: 'First Diamond, 3 pinpoint taps/s',
    style: 'franticPinpoint',
    tier: 'diamond',
    metric: 'activeSeconds',
    percentile: 10,
    min: MINUTE,
  },
  {
    id: 'firstHeirloomFrantic',
    label: 'First Heirloom, 3 pinpoint taps/s',
    style: 'franticPinpoint',
    tier: 'heirloom',
    metric: 'activeSeconds',
    percentile: 10,
    min: 5 * MINUTE,
  },
] as const satisfies readonly LadderTargetDef[];
