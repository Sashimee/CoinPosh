export interface SwayPose {
  /** Rotation about the boat's fore-aft axis (Z), radians. */
  readonly roll: number;
  /** Rotation about the beam axis (X), radians. */
  readonly pitch: number;
  /** Vertical offset of the boat relative to the sea, metres. */
  readonly heave: number;
}

export interface SwayProfile {
  readonly rollAmplitude: number;
  readonly pitchAmplitude: number;
  readonly heaveAmplitude: number;
  /** Seconds for one main roll cycle. */
  readonly period: number;
}

export const CALM_SEA: SwayProfile = {
  rollAmplitude: (0.55 * Math.PI) / 180,
  pitchAmplitude: (0.3 * Math.PI) / 180,
  heaveAmplitude: 0.035,
  period: 9.5,
};

export const REST_POSE: SwayPose = { roll: 0, pitch: 0, heave: 0 };

const TAU = Math.PI * 2;

/**
 * A moored yacht's motion: each channel sums two sines with incommensurate frequency ratios
 * so the swell never visibly loops. The result is bounded by the profile's amplitudes.
 */
export function swayPose(seconds: number, profile: SwayProfile, intensity: number): SwayPose {
  const k = Math.min(Math.max(intensity, 0), 1);
  if (k === 0) return REST_POSE;
  const w = TAU / profile.period;
  const roll = 0.72 * Math.sin(w * seconds) + 0.28 * Math.sin(w * 2.618 * seconds + 1.3);
  const pitch = 0.65 * Math.sin(w * 1.414 * seconds + 0.7) + 0.35 * Math.sin(w * 3.302 * seconds);
  const heave =
    0.6 * Math.sin(w * 0.786 * seconds + 2.1) + 0.4 * Math.sin(w * 1.902 * seconds + 0.4);
  return {
    roll: roll * profile.rollAmplitude * k,
    pitch: pitch * profile.pitchAmplitude * k,
    heave: heave * profile.heaveAmplitude * k,
  };
}

export type SwayListener = (pose: SwayPose) => void;

/**
 * The deck sway hook. The venue advances it each frame and applies the inverse pose to the
 * sea and sky (the camera rides the boat). Camera rigs, physics nudges or audio creaks can
 * subscribe to the same pose.
 */
export class DeckSway {
  private elapsed = 0;
  private current: SwayPose = REST_POSE;
  private readonly listeners = new Set<SwayListener>();

  constructor(
    private readonly profile: SwayProfile = CALM_SEA,
    private intensityValue = 1,
  ) {}

  get pose(): SwayPose {
    return this.current;
  }

  get intensity(): number {
    return this.intensityValue;
  }

  set intensity(value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`DeckSway intensity must be a finite number, got ${value}`);
    }
    this.intensityValue = Math.min(Math.max(value, 0), 1);
  }

  update(deltaSeconds: number): SwayPose {
    if (deltaSeconds > 0) this.elapsed += Math.min(deltaSeconds, 0.25);
    this.current = swayPose(this.elapsed, this.profile, this.intensityValue);
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  subscribe(listener: SwayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
