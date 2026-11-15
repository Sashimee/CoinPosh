import type { PrizeFamily } from '@coinposh/shared';
import { clamp, dbToGain, elementAt, lerp, type Rng } from '../rng.ts';
import {
  MAX_IMPACT_PAN,
  modesToKeep,
  strengthToBrightness,
  strengthToGain,
  velocityToStrength,
  type ModalPartial,
} from '../synth/impactSpec.ts';
import type { ModeSpec, ResonantBody } from '../synth/materials.ts';
import { VoicePriority } from '../voicePool.ts';
import { signedSpread, type PitchVariator } from './variation.ts';

export interface PrizeTransientSpec {
  readonly filter: BiquadFilterType;
  readonly gain: number;
  readonly frequency: number;
  readonly q: number;
  readonly t60: number;
}

export interface StrikeSpec {
  readonly bodies: readonly ResonantBody[];
  readonly transient: PrizeTransientSpec | null;
}

/**
 * Secondary contacts that ride on the first one: the second cufflink, a bracelet link, keys on
 * a ring, liquid moving in a bottle. Harder hits shake loose more of them.
 */
export interface FollowerSpec {
  readonly strike: StrikeSpec;
  readonly minCount: number;
  readonly maxCount: number;
  readonly firstDelay: number;
  readonly spread: number;
  readonly gain: number;
}

export interface PrizeProfile {
  readonly level: number;
  readonly main: StrikeSpec;
  readonly followers: FollowerSpec | null;
}

export interface PrizeTransient extends PrizeTransientSpec {
  readonly noiseOffset: number;
}

export interface PrizeLayer {
  readonly delay: number;
  readonly gain: number;
  readonly partials: readonly ModalPartial[];
  readonly transient: PrizeTransient | null;
}

export interface PrizeImpactSpec {
  readonly family: PrizeFamily;
  readonly strength: number;
  readonly pitch: number;
  readonly gain: number;
  readonly brightness: number;
  readonly pan: number;
  readonly layers: readonly PrizeLayer[];
  readonly duration: number;
  readonly priority: number;
}

const MODE_TILT = 0.5;
const CULL_BELOW = dbToGain(-60);

function modes(ratios: readonly number[], t60s: readonly number[]): ModeSpec[] {
  return ratios.map((ratio, i) => ({
    ratio,
    amplitude: 0.78 ** i,
    t60: elementAt(t60s, i),
  }));
}

/**
 * Every prize is far denser than a coin, so each one lands with a low cabinet thud under its
 * own voice: that weight is what tells the ear "something valuable just dropped".
 */
function tableThud(gain: number): ResonantBody {
  return {
    fundamental: 148,
    gain,
    detuneSpread: 0.04,
    modes: modes([1, 2.31, 3.86], [0.16, 0.09, 0.05]),
  };
}

/** A clamped steel plate: the watch case and the chrome key bodies share its mode ratios. */
const STEEL_RATIOS = [1, 1.59, 2.14, 2.3, 2.65, 3.6];
/** A thick-walled glass vessel: widely spaced, long-ringing modes give the "ting". */
const GLASS_RATIOS = [1, 2.32, 4.25, 6.63];
/** A thin free disc, as for coins, but smaller and stiffer: the gold cufflink face. */
const DISC_RATIOS = [1, 1.47, 2.09, 2.69, 3.42];
/** A slender key blade rings like a free bar (1 : 2.76 : 5.40). */
const BAR_RATIOS = [1, 2.76, 5.4];

export const PRIZE_PROFILES: Readonly<Record<PrizeFamily, PrizeProfile>> = {
  watch: {
    level: 1,
    main: {
      bodies: [
        tableThud(0.85),
        {
          fundamental: 905,
          gain: 0.8,
          detuneSpread: 0.02,
          modes: modes(STEEL_RATIOS, [0.42, 0.34, 0.28, 0.25, 0.19, 0.13]),
        },
        {
          fundamental: 3180,
          gain: 0.34,
          detuneSpread: 0.015,
          modes: modes([1, 2.32, 4.1], [0.24, 0.15, 0.08]),
        },
      ],
      transient: { filter: 'bandpass', gain: 0.42, frequency: 3900, q: 1.2, t60: 0.011 },
    },
    followers: {
      strike: {
        bodies: [
          {
            fundamental: 4300,
            gain: 1,
            detuneSpread: 0.06,
            modes: modes([1, 1.5, 2.2], [0.06, 0.045, 0.03]),
          },
        ],
        transient: { filter: 'highpass', gain: 0.3, frequency: 5200, q: 0.7, t60: 0.006 },
      },
      minCount: 1,
      maxCount: 3,
      firstDelay: 0.014,
      spread: 0.05,
      gain: 0.22,
    },
  },
  perfume: {
    level: 0.95,
    main: {
      bodies: [
        tableThud(0.6),
        {
          fundamental: 1340,
          gain: 1,
          detuneSpread: 0.015,
          modes: modes(GLASS_RATIOS, [1.15, 0.82, 0.52, 0.3]),
        },
      ],
      transient: { filter: 'bandpass', gain: 0.36, frequency: 6100, q: 0.8, t60: 0.008 },
    },
    followers: {
      strike: {
        bodies: [],
        transient: { filter: 'lowpass', gain: 1, frequency: 720, q: 2.4, t60: 0.1 },
      },
      minCount: 1,
      maxCount: 2,
      firstDelay: 0.04,
      spread: 0.09,
      gain: 0.3,
    },
  },
  cufflinks: {
    level: 0.88,
    main: {
      bodies: [
        tableThud(0.45),
        {
          fundamental: 3020,
          gain: 1,
          detuneSpread: 0.03,
          modes: modes(DISC_RATIOS, [0.3, 0.24, 0.18, 0.13, 0.09]),
        },
      ],
      transient: { filter: 'bandpass', gain: 0.38, frequency: 7400, q: 1, t60: 0.009 },
    },
    followers: {
      strike: {
        bodies: [
          {
            fundamental: 3020,
            gain: 1,
            detuneSpread: 0.07,
            modes: modes(DISC_RATIOS.slice(0, 4), [0.26, 0.2, 0.15, 0.11]),
          },
        ],
        transient: { filter: 'bandpass', gain: 0.32, frequency: 7400, q: 1, t60: 0.008 },
      },
      minCount: 1,
      maxCount: 2,
      firstDelay: 0.022,
      spread: 0.035,
      gain: 0.68,
    },
  },
  carKeys: {
    level: 1.05,
    main: {
      bodies: [
        tableThud(0.7),
        {
          fundamental: 118,
          gain: 1,
          detuneSpread: 0.05,
          modes: modes([1, 2.12, 3.31], [0.1, 0.055, 0.03]),
        },
      ],
      transient: { filter: 'lowpass', gain: 0.62, frequency: 950, q: 0.7, t60: 0.03 },
    },
    followers: {
      strike: {
        bodies: [
          {
            fundamental: 2640,
            gain: 1,
            detuneSpread: 0.13,
            modes: modes(BAR_RATIOS, [0.3, 0.19, 0.1]),
          },
        ],
        transient: { filter: 'bandpass', gain: 0.35, frequency: 6600, q: 1.1, t60: 0.007 },
      },
      minCount: 2,
      maxCount: 4,
      firstDelay: 0.006,
      spread: 0.15,
      gain: 0.5,
    },
  },
};

export function followerCount(follower: FollowerSpec, strength: number): number {
  return Math.round(lerp(follower.minCount, follower.maxCount, clamp(strength, 0, 1)));
}

function strikePartials(
  strike: StrikeSpec,
  pitch: number,
  strength: number,
  brightness: number,
  audibleGain: number,
  rng: Rng,
): ModalPartial[] {
  const partials: ModalPartial[] = [];
  for (const body of strike.bodies) {
    const bodyPitch = pitch * signedSpread(rng, body.detuneSpread);
    const weighted = body.modes.map((mode, k) => mode.amplitude * brightness ** (k * MODE_TILT));
    const total = weighted.reduce((sum, a) => sum + a, 0);
    const keep = modesToKeep(body.modes.length, strength);
    body.modes.slice(0, keep).forEach((mode, k) => {
      const amplitude = (elementAt(weighted, k) / total) * body.gain;
      if (amplitude * audibleGain < CULL_BELOW) return;
      partials.push({
        frequency: body.fundamental * mode.ratio * bodyPitch,
        amplitude,
        t60: mode.t60 * lerp(0.7, 1, brightness),
      });
    });
  }
  return partials;
}

function strikeTransient(
  strike: StrikeSpec,
  pitch: number,
  brightness: number,
  rng: Rng,
): PrizeTransient | null {
  if (strike.transient === null) return null;
  const { transient } = strike;
  return {
    ...transient,
    gain: transient.gain * lerp(0.4, 1, brightness),
    frequency: transient.frequency * lerp(0.45, 1.15, brightness) * pitch,
    noiseOffset: rng(),
  };
}

function layerEnd(layer: PrizeLayer): number {
  const tails = layer.partials.map((p) => p.t60);
  if (layer.transient) tails.push(layer.transient.t60);
  return layer.delay + Math.max(0, ...tails);
}

/** One oscillator per partial and one noise source per transient. */
export function prizeVoiceCost(spec: PrizeImpactSpec): number {
  return spec.layers.reduce(
    (sum, layer) => sum + layer.partials.length + (layer.transient ? 1 : 0),
    0,
  );
}

/**
 * Builds a prize-on-table impact. Returns null when the contact is too soft to hear; throws
 * on a non-finite pan. Prizes sit one priority band above coin hits: a dropped watch must
 * never be stolen by the coin bed around it.
 */
export function buildPrizeImpactSpec(
  family: PrizeFamily,
  speed: number,
  variator: PitchVariator<PrizeFamily>,
  rng: Rng,
  pan = 0,
): PrizeImpactSpec | null {
  if (!Number.isFinite(pan)) {
    throw new RangeError(`Prize impact pan must be a finite number in -1..1, got ${pan}`);
  }
  const strength = velocityToStrength(speed);
  if (strength <= 0) return null;
  const profile = PRIZE_PROFILES[family];
  const gain = strengthToGain(strength) * profile.level;
  const brightness = strengthToBrightness(strength);
  const pitch = variator.next(family);

  const layers: PrizeLayer[] = [
    {
      delay: 0,
      gain: 1,
      partials: strikePartials(profile.main, pitch, strength, brightness, gain, rng),
      transient: strikeTransient(profile.main, pitch, brightness, rng),
    },
  ];
  const { followers } = profile;
  if (followers) {
    const count = followerCount(followers, strength);
    const delays = Array.from(
      { length: count },
      () => followers.firstDelay + rng() * followers.spread,
    ).sort((a, b) => a - b);
    delays.forEach((delay, i) => {
      const layerGain = followers.gain * lerp(0.7, 1, rng()) * 0.85 ** i;
      layers.push({
        delay,
        gain: layerGain,
        partials: strikePartials(
          followers.strike,
          pitch,
          strength,
          brightness,
          gain * layerGain,
          rng,
        ),
        transient: strikeTransient(followers.strike, pitch, brightness, rng),
      });
    });
  }

  return {
    family,
    strength,
    pitch,
    gain,
    brightness,
    pan: clamp(pan, -MAX_IMPACT_PAN, MAX_IMPACT_PAN),
    layers: layers.filter((layer) => layer.partials.length > 0 || layer.transient !== null),
    duration: Math.max(...layers.map(layerEnd)),
    priority: lerp(VoicePriority.loudImpact, VoicePriority.ui, strength),
  };
}
