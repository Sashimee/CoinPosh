import { clamp, dbToGain, elementAt, lerp, type Rng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';
import { MATERIAL_PROFILES, type ImpactMaterial } from './materials.ts';

export interface ImpactEvent {
  readonly material: ImpactMaterial;
  /** Closing speed along the contact normal, in m/s. */
  readonly velocity: number;
  /** Stereo position in -1..1; clamped to a mono-safe range. */
  readonly pan?: number;
}

/** Below this the contact is resting jitter, not an impact. */
export const IMPACT_VELOCITY_FLOOR = 0.06;
/** About a coin dropped from the top of the cabinet. */
export const IMPACT_VELOCITY_CEIL = 2.8;
export const IMPACT_MIN_DB = -38;
export const PITCH_JITTER = 0.06;
/** Consecutive hits on the same material differ in pitch by at least this much. */
export const MIN_PITCH_STEP = 0.012;
export const MAX_IMPACT_PAN = 0.6;
const MIN_BRIGHTNESS = 0.15;
const MODE_TILT = 0.45;
const CULL_BELOW = dbToGain(-66);

/**
 * Maps closing speed to a 0..1 strike strength on a log scale: loudness perception is roughly
 * logarithmic, so a linear map would make every soft settle inaudible and every drop identical.
 */
export function velocityToStrength(velocity: number): number {
  if (!Number.isFinite(velocity) || velocity < IMPACT_VELOCITY_FLOOR) return 0;
  const t =
    Math.log(velocity / IMPACT_VELOCITY_FLOOR) /
    Math.log(IMPACT_VELOCITY_CEIL / IMPACT_VELOCITY_FLOOR);
  return clamp(t, 0, 1);
}

export function strengthToGain(strength: number): number {
  if (strength <= 0) return 0;
  return dbToGain(lerp(IMPACT_MIN_DB, 0, clamp(strength, 0, 1)));
}

export function strengthToBrightness(strength: number): number {
  return lerp(MIN_BRIGHTNESS, 1, clamp(strength, 0, 1) ** 0.8);
}

export interface ModalPartial {
  readonly frequency: number;
  readonly amplitude: number;
  readonly t60: number;
}

export interface ImpactTransient {
  readonly gain: number;
  readonly frequency: number;
  readonly q: number;
  readonly t60: number;
  /** Where to start reading the shared noise buffer, 0..1, so no two clicks are identical. */
  readonly noiseOffset: number;
}

export interface ImpactSpec {
  readonly material: ImpactMaterial;
  readonly variant: number;
  readonly pitch: number;
  readonly gain: number;
  readonly brightness: number;
  readonly pan: number;
  readonly partials: readonly ModalPartial[];
  readonly transient: ImpactTransient;
  readonly duration: number;
  readonly priority: number;
}

/**
 * Guarantees that the same material never plays the same strike variant twice in a row and
 * that consecutive pitches always move, so a stream of hits never sounds like a loop.
 */
export class ImpactVariator {
  private readonly lastVariant = new Map<ImpactMaterial, number>();
  private readonly lastPitch = new Map<ImpactMaterial, number>();

  constructor(private readonly rng: Rng) {}

  nextVariant(material: ImpactMaterial, count: number): number {
    if (count < 2) return 0;
    const last = this.lastVariant.get(material);
    let variant = Math.floor(this.rng() * (last === undefined ? count : count - 1));
    if (last !== undefined && variant >= last) variant++;
    this.lastVariant.set(material, variant);
    return variant;
  }

  /** Returns a pitch factor in [1 - PITCH_JITTER, 1 + PITCH_JITTER]. */
  nextPitch(material: ImpactMaterial): number {
    let offset = (this.rng() * 2 - 1) * PITCH_JITTER;
    const last = this.lastPitch.get(material);
    if (last !== undefined && Math.abs(offset - last) < MIN_PITCH_STEP) {
      const away = offset >= last ? 1 : -1;
      offset = last + away * MIN_PITCH_STEP;
      if (Math.abs(offset) > PITCH_JITTER) offset = last - away * MIN_PITCH_STEP;
    }
    this.lastPitch.set(material, offset);
    return 1 + offset;
  }
}

function strikeWeight(modeIndex: number, position: number): number {
  return 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * (modeIndex + 1) * position));
}

/** Small fixed per-variant mode detune so variants differ in timbre, not just loudness. */
function variantDetune(modeIndex: number, variant: number): number {
  return 1 + (((modeIndex * 7 + variant * 3) % 5) - 2) * 0.004;
}

/** Returns null when the hit is too soft to hear. */
export function buildImpactSpec(
  event: ImpactEvent,
  variator: ImpactVariator,
  rng: Rng,
): ImpactSpec | null {
  const strength = velocityToStrength(event.velocity);
  if (strength <= 0) return null;
  const profile = MATERIAL_PROFILES[event.material];
  const gain = strengthToGain(strength) * profile.level;
  const brightness = strengthToBrightness(strength);
  const variant = variator.nextVariant(event.material, profile.strikePositions.length);
  const position = elementAt(profile.strikePositions, variant);
  const pitch = variator.nextPitch(event.material);

  const partials: ModalPartial[] = [];
  for (const body of profile.bodies) {
    const bodyPitch = pitch * (1 + (rng() * 2 - 1) * body.detuneSpread);
    const weighted = body.modes.map(
      (mode, k) => mode.amplitude * strikeWeight(k, position) * brightness ** (k * MODE_TILT),
    );
    const total = weighted.reduce((sum, a) => sum + a, 0);
    body.modes.forEach((mode, k) => {
      const amplitude = (elementAt(weighted, k) / total) * body.gain;
      if (amplitude * gain < CULL_BELOW) return;
      partials.push({
        frequency: body.fundamental * mode.ratio * bodyPitch * variantDetune(k, variant),
        amplitude,
        t60: mode.t60 * lerp(0.75, 1, brightness),
      });
    });
  }

  const transient: ImpactTransient = {
    gain: profile.transient.gain * brightness,
    frequency: profile.transient.frequency * lerp(0.35, 1.25, brightness) * pitch,
    q: profile.transient.q,
    t60: profile.transient.t60,
    noiseOffset: rng(),
  };

  const duration = Math.max(transient.t60, ...partials.map((p) => p.t60));
  const priority = lerp(VoicePriority.quietImpact, VoicePriority.loudImpact, strength);
  const pan = clamp(event.pan ?? 0, -MAX_IMPACT_PAN, MAX_IMPACT_PAN);

  return {
    material: event.material,
    variant,
    pitch,
    gain,
    brightness,
    pan,
    partials,
    transient,
    duration,
    priority,
  };
}
