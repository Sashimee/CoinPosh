import type { NudgeDirection } from '@coinposh/shared';

/** Ergonomics only. Accelerations are m/s² without gravity, in the device's portrait frame. */
export interface ShakeConfig {
  /** A jolt this hard nudges the table. */
  readonly triggerMs2: number;
  /** The phone must settle under this before the next jolt can count. */
  readonly rearmMs2: number;
  readonly cooldownMs: number;
  /** A jolt this hard is a full-strength nudge. */
  readonly fullMs2: number;
}

export const DEFAULT_SHAKE: ShakeConfig = {
  triggerMs2: 14,
  rearmMs2: 5,
  cooldownMs: 350,
  fullMs2: 30,
};

export interface ShakeNudge {
  readonly direction: NudgeDirection;
  readonly strength: number;
}

/**
 * Turns DeviceMotion samples into nudges. A sideways jolt nudges left or right; a push or pull
 * along the screen's normal nudges forward. One jolt is one nudge: the detector
 * re-arms only after the phone settles, so a single shake's rebound never counts twice.
 */
export class ShakeDetector {
  readonly #config: ShakeConfig;
  #armed = true;
  #lastAt = Number.NEGATIVE_INFINITY;

  constructor(config: ShakeConfig = DEFAULT_SHAKE) {
    if (!(config.rearmMs2 > 0) || !(config.triggerMs2 > config.rearmMs2)) {
      throw new RangeError('ShakeDetector: need 0 < rearmMs2 < triggerMs2');
    }
    if (!(config.fullMs2 >= config.triggerMs2) || !(config.cooldownMs >= 0)) {
      throw new RangeError('ShakeDetector: need fullMs2 ≥ triggerMs2 and cooldownMs ≥ 0');
    }
    this.#config = config;
  }

  /** `x` is towards the right edge of the screen, `z` out of the screen towards the player. */
  sample(x: number, z: number, at: number): ShakeNudge | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const magnitude = Math.hypot(x, z);
    if (!this.#armed) {
      if (magnitude < this.#config.rearmMs2) this.#armed = true;
      return null;
    }
    if (magnitude < this.#config.triggerMs2 || at - this.#lastAt < this.#config.cooldownMs) {
      return null;
    }
    this.#armed = false;
    this.#lastAt = at;
    const span = this.#config.fullMs2 - this.#config.triggerMs2;
    const strength =
      span === 0 ? 1 : Math.min(1, 0.5 + (0.5 * (magnitude - this.#config.triggerMs2)) / span);
    let direction: NudgeDirection;
    if (Math.abs(x) >= Math.abs(z)) direction = x < 0 ? 'left' : 'right';
    else direction = 'forward';
    return { direction, strength };
  }
}
