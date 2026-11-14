import { rateEnvelopeDerivation } from '@coinposh/economy';
import { clamp, lerp } from '../../rng.ts';
import { smoothstep } from '../layers.ts';

/** The loop may never drift further than this from the tempo it was written at. */
export const MAX_TEMPO_SWING_BPM = 8;
/** Reduced motion keeps the room calmer: half the push, the same feel. */
export const REDUCED_TEMPO_SWING_BPM = 4;
/**
 * Largest change between two consecutive bars. A full 8 BPM push takes several bars, which
 * reads as the band leaning in rather than a tape speeding up.
 */
export const MAX_TEMPO_STEP_BPM = 1.5;
/** Each bar closes this share of the gap to the target, so the tempo eases in and settles. */
const TEMPO_EASE = 0.45;
const TEMPO_SNAP_BPM = 0.05;

/** An unhurried player (about one drop a second) hears the loop exactly as written. */
export const NEUTRAL_DROPS_PER_SECOND = rateEnvelopeDerivation.honestTapsPerSecond / 3;
/** The fastest honest tapping earns the full push. */
export const FULL_DROPS_PER_SECOND = rateEnvelopeDerivation.honestTapsPerSecond;
/** An idle table relaxes the groove by this share of the swing. */
const IDLE_SHARE = 0.5;

function assertTempo(name: string, bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError(`${name} must be a positive number of BPM, got ${bpm}`);
  }
}

export function assertSwing(swing: number): void {
  if (!Number.isFinite(swing) || swing < 0 || swing > MAX_TEMPO_SWING_BPM) {
    throw new RangeError(`Tempo swing must be in 0..${MAX_TEMPO_SWING_BPM} BPM, got ${swing}`);
  }
}

export function clampTempo(bpm: number, baseBpm: number, swing: number): number {
  return clamp(bpm, baseBpm - swing, baseBpm + swing);
}

/** Maps the player's drop rate onto a target tempo, eased so the top end never feels frantic. */
export function tempoForDropRate(dropsPerSecond: number, baseBpm: number, swing: number): number {
  if (!Number.isFinite(dropsPerSecond) || dropsPerSecond < 0) {
    throw new RangeError(
      `Drop rate must be a non-negative number of drops per second, got ${dropsPerSecond}`,
    );
  }
  assertTempo('Base tempo', baseBpm);
  assertSwing(swing);
  if (dropsPerSecond <= NEUTRAL_DROPS_PER_SECOND) {
    const idle = 1 - dropsPerSecond / NEUTRAL_DROPS_PER_SECOND;
    return baseBpm - swing * IDLE_SHARE * idle;
  }
  const push = smoothstep(NEUTRAL_DROPS_PER_SECOND, FULL_DROPS_PER_SECOND, dropsPerSecond);
  return lerp(baseBpm, baseBpm + swing, push);
}

/**
 * The tempo the next bar plays at: eased toward the target and step-limited. The target is
 * held inside the active swing, and the result inside the hard ±8 BPM, so narrowing the swing
 * (reduced motion) glides back in over a few bars instead of lurching.
 */
export function nextBarTempo(
  currentBpm: number,
  targetBpm: number,
  baseBpm: number,
  swing: number,
): number {
  assertTempo('Current tempo', currentBpm);
  assertTempo('Target tempo', targetBpm);
  assertTempo('Base tempo', baseBpm);
  assertSwing(swing);
  const target = clampTempo(targetBpm, baseBpm, swing);
  const gap = target - currentBpm;
  if (Math.abs(gap) <= TEMPO_SNAP_BPM) return clampTempo(target, baseBpm, MAX_TEMPO_SWING_BPM);
  const eased = clamp(gap * TEMPO_EASE, -MAX_TEMPO_STEP_BPM, MAX_TEMPO_STEP_BPM);
  const step = Math.abs(eased) < TEMPO_SNAP_BPM ? Math.sign(gap) * TEMPO_SNAP_BPM : eased;
  return clampTempo(currentBpm + step, baseBpm, MAX_TEMPO_SWING_BPM);
}
