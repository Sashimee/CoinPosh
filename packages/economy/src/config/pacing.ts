import type { PacingTargetDef } from '../types.ts';

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
