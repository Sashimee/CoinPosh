import { pulse } from './easing.ts';

export interface GlowPulse {
  /** Peak added to the resting level (1 = double the bloom). */
  readonly peak: number;
  /** Seconds from start to peak. */
  readonly attack: number;
  /** Seconds from peak back to rest. */
  readonly release: number;
}

interface ActivePulse extends GlowPulse {
  age: number;
}

/**
 * Photosensitivity guard for reduced motion: flashes reach at most half their peak and
 * never rise faster than this, so nothing strobes.
 */
export const REDUCED_GLOW = { peakScale: 0.5, minAttack: 0.12 } as const;
/** Overlapping pulses sum, but the total stays under this so a cascade storm cannot white out. */
export const MAX_GLOW = 2.4;

/**
 * Sums light-response pulses over time. The integrator feeds `value` into the post
 * pipeline (`bloomBoost = 1 + value`), which is how sparks, flashes and cascades make the
 * whole frame breathe with them.
 */
export class GlowEnvelope {
  reducedMotion = false;
  private pulses: ActivePulse[] = [];
  private current = 0;

  get value(): number {
    return this.current;
  }

  add(next: GlowPulse): void {
    if (!(next.peak > 0) || !(next.attack >= 0) || !(next.release > 0)) {
      throw new RangeError(
        `GlowEnvelope pulses need peak > 0, attack >= 0 and release > 0, got ${next.peak}/${next.attack}/${next.release}`,
      );
    }
    const shaped = this.reducedMotion
      ? {
          peak: next.peak * REDUCED_GLOW.peakScale,
          attack: Math.max(next.attack, REDUCED_GLOW.minAttack),
          release: next.release,
        }
      : next;
    this.pulses.push({ ...shaped, age: 0 });
  }

  update(dt: number): number {
    let sum = 0;
    this.pulses = this.pulses.filter((p) => {
      p.age += Math.max(0, dt);
      const duration = p.attack + p.release;
      if (p.age >= duration) return false;
      sum += p.peak * pulse(p.age / duration, p.attack / duration);
      return true;
    });
    this.current = Math.min(sum, MAX_GLOW);
    return this.current;
  }

  clear(): void {
    this.pulses = [];
    this.current = 0;
  }
}
