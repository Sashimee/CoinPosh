/** The surface a coin strikes. Every impact is coin-on-something, so this names the pair. */
export type ImpactMaterial = 'coin' | 'wood' | 'metal';

export const IMPACT_MATERIALS: readonly ImpactMaterial[] = ['coin', 'wood', 'metal'];

export interface ModeSpec {
  /** Frequency relative to the body's fundamental. */
  readonly ratio: number;
  readonly amplitude: number;
  /** Seconds to decay by 60 dB. */
  readonly t60: number;
}

export interface ResonantBody {
  readonly fundamental: number;
  readonly gain: number;
  readonly modes: readonly ModeSpec[];
  /**
   * Extra random detune applied to this body only, as a fraction. Two coins never share a
   * pitch, and the beating between them is what makes a coin-on-coin "ching" sound expensive.
   */
  readonly detuneSpread: number;
}

export interface TransientSpec {
  readonly gain: number;
  readonly frequency: number;
  readonly q: number;
  readonly t60: number;
}

export interface MaterialProfile {
  readonly bodies: readonly ResonantBody[];
  readonly transient: TransientSpec;
  /** Loudness balance between pairs at the same velocity. */
  readonly level: number;
  /**
   * Strike positions along the body (0..1). Each one weights the modes differently, the way
   * hitting a bar near its end or its middle changes the tone. One position per variant.
   */
  readonly strikePositions: readonly number[];
}

/**
 * Mode ratios for the coin follow a thin free disc (inharmonic, roughly 1 : 1.47 : 2.1 : 2.7);
 * the tray follows a clamped plate; teak is a short, heavily damped beam.
 */
const COIN_DISC: readonly ModeSpec[] = [
  { ratio: 1, amplitude: 1, t60: 0.62 },
  { ratio: 1.47, amplitude: 0.72, t60: 0.48 },
  { ratio: 2.09, amplitude: 0.55, t60: 0.36 },
  { ratio: 2.69, amplitude: 0.4, t60: 0.27 },
  { ratio: 3.42, amplitude: 0.27, t60: 0.19 },
  { ratio: 4.17, amplitude: 0.17, t60: 0.13 },
];

function damped(modes: readonly ModeSpec[], amount: number, keep: number): ModeSpec[] {
  return modes.slice(0, keep).map((mode) => ({ ...mode, t60: mode.t60 * amount }));
}

const STRIKES = [0.13, 0.21, 0.29, 0.37, 0.44, 0.17];

export const MATERIAL_PROFILES: Readonly<Record<ImpactMaterial, MaterialProfile>> = {
  coin: {
    level: 0.9,
    strikePositions: STRIKES,
    bodies: [
      { fundamental: 2380, gain: 1, modes: COIN_DISC, detuneSpread: 0 },
      { fundamental: 2380, gain: 0.62, modes: damped(COIN_DISC, 0.8, 5), detuneSpread: 0.09 },
    ],
    transient: { gain: 0.32, frequency: 7200, q: 0.9, t60: 0.012 },
  },
  wood: {
    level: 1,
    strikePositions: STRIKES,
    bodies: [
      {
        fundamental: 205,
        gain: 1,
        detuneSpread: 0.05,
        modes: [
          { ratio: 1, amplitude: 1, t60: 0.11 },
          { ratio: 2.43, amplitude: 0.62, t60: 0.075 },
          { ratio: 3.91, amplitude: 0.4, t60: 0.05 },
          { ratio: 5.34, amplitude: 0.24, t60: 0.034 },
        ],
      },
      { fundamental: 2380, gain: 0.3, modes: damped(COIN_DISC, 0.3, 3), detuneSpread: 0.03 },
    ],
    transient: { gain: 0.55, frequency: 2600, q: 0.7, t60: 0.02 },
  },
  metal: {
    level: 0.85,
    strikePositions: STRIKES,
    bodies: [
      { fundamental: 2380, gain: 0.75, modes: damped(COIN_DISC, 0.9, 5), detuneSpread: 0.02 },
      {
        fundamental: 612,
        gain: 0.55,
        detuneSpread: 0.04,
        modes: [
          { ratio: 1, amplitude: 1, t60: 0.95 },
          { ratio: 1.59, amplitude: 0.7, t60: 0.78 },
          { ratio: 2.14, amplitude: 0.52, t60: 0.62 },
          { ratio: 2.3, amplitude: 0.46, t60: 0.55 },
          { ratio: 2.65, amplitude: 0.33, t60: 0.42 },
          { ratio: 3.6, amplitude: 0.2, t60: 0.3 },
        ],
      },
    ],
    transient: { gain: 0.4, frequency: 5200, q: 1.1, t60: 0.015 },
  },
};
