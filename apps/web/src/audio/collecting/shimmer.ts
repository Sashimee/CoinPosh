import type { CoinVariant, CollectibleCoinVariant } from '@coinposh/shared';
import { clamp, type Rng } from '../rng.ts';
import { MAX_IMPACT_PAN } from '../synth/impactSpec.ts';
import { VoicePriority } from '../voicePool.ts';
import { signedSpread, type PitchVariator } from './variation.ts';

export interface ShimmerPartialSpec {
  /** Relative to the variant's base frequency. */
  readonly ratio: number;
  /** Where the partial glides to over its ring, relative to where it starts. */
  readonly glide: number;
  readonly amplitude: number;
  readonly delay: number;
  readonly attack: number;
  readonly t60: number;
  readonly vibratoHz: number;
  /** Peak frequency deviation as a fraction of the partial's frequency. */
  readonly vibratoDepth: number;
}

export interface ShimmerProfile {
  readonly base: number;
  readonly level: number;
  /** Random per-partial detune, so two plays of one variant never beat the same way. */
  readonly detuneSpread: number;
  readonly partials: readonly ShimmerPartialSpec[];
}

export interface ShimmerPartial {
  readonly frequency: number;
  readonly endFrequency: number;
  readonly amplitude: number;
  readonly delay: number;
  readonly attack: number;
  readonly t60: number;
  readonly vibratoHz: number;
  readonly vibratoDepth: number;
}

export interface VariantShimmerSpec {
  readonly variant: CollectibleCoinVariant;
  readonly pitch: number;
  readonly gain: number;
  readonly pan: number;
  readonly partials: readonly ShimmerPartial[];
  readonly duration: number;
  readonly priority: number;
}

const STILL = { glide: 1, vibratoHz: 0, vibratoDepth: 0 } as const;
/** Partials stay well under Nyquist so a 22 kHz context never aliases or clamps them. */
const NYQUIST_MARGIN = 0.8;

/**
 * Each variant gets "a high shimmer partial on top of the normal coin modes" (03-ART), voiced to
 * match its look: the foil's thin-film rainbow is a beating, rising chorus; the proof's mirror
 * is a pure octave that rings longest; the first strike is one crisp ping and a star-like
 * sparkle; the misprint wobbles slightly off true.
 */
export const SHIMMER_PROFILES: Readonly<Record<CollectibleCoinVariant, ShimmerProfile>> = {
  foil: {
    base: 5200,
    level: 0.15,
    detuneSpread: 0.003,
    partials: [
      {
        ratio: 1,
        glide: 1.08,
        amplitude: 1,
        delay: 0,
        attack: 0.02,
        t60: 1.05,
        vibratoHz: 0,
        vibratoDepth: 0,
      },
      {
        ratio: 1.0047,
        glide: 1.08,
        amplitude: 0.85,
        delay: 0.03,
        attack: 0.02,
        t60: 1,
        vibratoHz: 0,
        vibratoDepth: 0,
      },
      {
        ratio: 1.5,
        glide: 1.06,
        amplitude: 0.55,
        delay: 0.06,
        attack: 0.025,
        t60: 0.9,
        vibratoHz: 0,
        vibratoDepth: 0,
      },
      {
        ratio: 1.5064,
        glide: 1.06,
        amplitude: 0.45,
        delay: 0.09,
        attack: 0.025,
        t60: 0.85,
        vibratoHz: 0,
        vibratoDepth: 0,
      },
    ],
  },
  proof: {
    base: 4700,
    level: 0.14,
    detuneSpread: 0.001,
    partials: [
      { ...STILL, ratio: 1, amplitude: 1, delay: 0, attack: 0.004, t60: 1.6 },
      { ...STILL, ratio: 2, amplitude: 0.42, delay: 0, attack: 0.004, t60: 1.2 },
      { ...STILL, ratio: 3, amplitude: 0.12, delay: 0, attack: 0.004, t60: 0.7 },
    ],
  },
  firstStrike: {
    base: 6300,
    level: 0.17,
    detuneSpread: 0.002,
    partials: [
      { ...STILL, ratio: 1, amplitude: 1, delay: 0, attack: 0.0008, t60: 0.45 },
      { ...STILL, ratio: 1.335, amplitude: 0.62, delay: 0.06, attack: 0.0008, t60: 0.32 },
      { ...STILL, ratio: 2, amplitude: 0.48, delay: 0.11, attack: 0.0008, t60: 0.5 },
    ],
  },
  misprint: {
    base: 4400,
    level: 0.15,
    detuneSpread: 0.004,
    partials: [
      {
        ratio: 1,
        glide: 0.95,
        amplitude: 1,
        delay: 0,
        attack: 0.008,
        t60: 0.95,
        vibratoHz: 6.5,
        vibratoDepth: 0.012,
      },
      {
        ratio: 1.414,
        glide: 0.95,
        amplitude: 0.6,
        delay: 0.018,
        attack: 0.008,
        t60: 0.8,
        vibratoHz: 5.1,
        vibratoDepth: 0.016,
      },
    ],
  },
};

export function isShimmeringVariant(variant: CoinVariant): variant is CollectibleCoinVariant {
  return variant !== 'none';
}

/** One oscillator per partial plus one LFO per vibrating partial. */
export function shimmerVoiceCost(spec: VariantShimmerSpec): number {
  return spec.partials.reduce((sum, p) => sum + (p.vibratoDepth > 0 ? 2 : 1), 0);
}

/**
 * Returns null for the plain strike ('none'), and when no partial fits under the context's
 * Nyquist limit; throws on a non-finite pan.
 */
export function buildVariantShimmerSpec(
  variant: CoinVariant,
  variator: PitchVariator<CollectibleCoinVariant>,
  rng: Rng,
  sampleRate: number,
  pan = 0,
): VariantShimmerSpec | null {
  if (!Number.isFinite(pan)) {
    throw new RangeError(`Variant shimmer pan must be a finite number in -1..1, got ${pan}`);
  }
  if (!isShimmeringVariant(variant)) return null;
  const profile = SHIMMER_PROFILES[variant];
  const pitch = variator.next(variant);
  const ceiling = (sampleRate / 2) * NYQUIST_MARGIN;
  const partials: ShimmerPartial[] = [];
  for (const partial of profile.partials) {
    const frequency =
      profile.base * partial.ratio * pitch * signedSpread(rng, profile.detuneSpread);
    const endFrequency = frequency * partial.glide;
    const peak = frequency * Math.max(1, partial.glide) * (1 + partial.vibratoDepth);
    if (peak >= ceiling) continue;
    partials.push({
      frequency,
      endFrequency,
      amplitude: partial.amplitude,
      delay: partial.delay,
      attack: partial.attack,
      t60: partial.t60,
      vibratoHz: partial.vibratoHz,
      vibratoDepth: partial.vibratoDepth,
    });
  }
  if (partials.length === 0) return null;
  return {
    variant,
    pitch,
    gain: profile.level,
    pan: clamp(pan, -MAX_IMPACT_PAN, MAX_IMPACT_PAN),
    partials,
    duration: Math.max(...partials.map((p) => p.delay + p.attack + p.t60)),
    priority: VoicePriority.ui,
  };
}
