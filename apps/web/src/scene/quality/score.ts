import type { QualityTier } from './tiers.ts';

/**
 * Milliseconds per high-tier frame of the bench scene at which each tier is still chosen.
 * The bench is GPU-heavy but skips physics, audio and UI, so a tier needs roughly 2.5x
 * headroom against the 16.7 ms frame to hold 60 fps in play.
 */
export const TIER_THRESHOLDS_MS = { high: 6.5, medium: 13 } as const;

export function tierForFrameCost(msPerFrame: number): QualityTier {
  if (!Number.isFinite(msPerFrame)) return 'low';
  if (msPerFrame <= TIER_THRESHOLDS_MS.high) return 'high';
  if (msPerFrame <= TIER_THRESHOLDS_MS.medium) return 'medium';
  return 'low';
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const upper = sorted[middle] ?? Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/**
 * Per-frame cost from timed batches. Each batch ends with a 1-pixel readback that waits for
 * the GPU, so wall time covers GPU work on both backends instead of being capped by vsync;
 * the readback's own latency is measured separately and subtracted.
 */
export function frameCostFromBatches(
  batchMs: readonly number[],
  syncLatencyMs: number,
  framesPerBatch: number,
): number {
  const perFrame = batchMs.map((ms) => Math.max(ms - syncLatencyMs, 0) / framesPerBatch);
  return median(perFrame);
}
