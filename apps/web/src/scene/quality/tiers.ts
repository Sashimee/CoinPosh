export const QUALITY_TIERS = ['low', 'medium', 'high'] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

export type AntiAlias = 'msaa' | 'fxaa';

export interface QualityProfile {
  readonly tier: QualityTier;
  /** Device pixels per CSS pixel the 3D scene is rendered at, before dynamic scaling. */
  readonly maxPixelRatio: number;
  readonly antiAlias: AntiAlias;
  /** Bounds for the dynamic resolution controller, as a fraction of `maxPixelRatio`. */
  readonly minResolutionScale: number;
  readonly maxResolutionScale: number;
  readonly bloom: {
    readonly strength: number;
    readonly radius: number;
    readonly threshold: number;
    /** Size of the bloom chain relative to the drawing buffer. */
    readonly resolutionScale: number;
  };
  readonly vignette: { readonly strength: number; readonly warmth: number };
  /** Film grain amplitude in display space (0.02 = 2 %). */
  readonly grain: number;
}

const VIGNETTE = { strength: 0.42, warmth: 0.55 } as const;
const GRAIN = 0.02;

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    antiAlias: 'msaa',
    minResolutionScale: 0.6,
    maxResolutionScale: 1,
    bloom: { strength: 0.32, radius: 0.55, threshold: 0.92, resolutionScale: 0.5 },
    vignette: VIGNETTE,
    grain: GRAIN,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    antiAlias: 'msaa',
    minResolutionScale: 0.55,
    maxResolutionScale: 1,
    bloom: { strength: 0.3, radius: 0.5, threshold: 0.92, resolutionScale: 0.35 },
    vignette: VIGNETTE,
    grain: GRAIN,
  },
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    antiAlias: 'fxaa',
    minResolutionScale: 0.5,
    maxResolutionScale: 1,
    bloom: { strength: 0.26, radius: 0.4, threshold: 0.95, resolutionScale: 0.25 },
    vignette: VIGNETTE,
    grain: GRAIN,
  },
};

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (QUALITY_TIERS as readonly string[]).includes(value);
}

export function lowerTier(tier: QualityTier): QualityTier | null {
  const index = QUALITY_TIERS.indexOf(tier);
  return index > 0 ? (QUALITY_TIERS[index - 1] ?? null) : null;
}
