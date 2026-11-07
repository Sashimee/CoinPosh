import { SWELL_COUNT } from '../../env/ocean.ts';

/**
 * Per-venue render-cost knobs. T-1.06's quality tiers pick a preset (or override fields) and
 * pass it as `RivieraVenueOptions.quality`; the venue is rebuilt to change it.
 */
export interface RivieraQuality {
  /** Analytic swells summed per ocean pixel, 0 to {@link MAX_SWELLS}. */
  readonly swells: number;
  /** Fine noise ripples on the sea near the hull. */
  readonly ripples: boolean;
  /** Clearcoat layer on lacquer, gelcoat and varnish. */
  readonly clearcoat: boolean;
  /** Velvet sheen lobe. */
  readonly sheen: boolean;
  /** Anisotropic highlight on brushed gold. */
  readonly anisotropy: boolean;
  /** Scale on baked texture sizes, (0, 1]. */
  readonly textureScale: number;
}

export const MAX_SWELLS = SWELL_COUNT;

export const RIVIERA_QUALITY = {
  high: {
    swells: 8,
    ripples: true,
    clearcoat: true,
    sheen: true,
    anisotropy: true,
    textureScale: 1,
  },
  medium: {
    swells: 6,
    ripples: true,
    clearcoat: true,
    sheen: false,
    anisotropy: true,
    textureScale: 0.5,
  },
  low: {
    swells: 4,
    ripples: false,
    clearcoat: false,
    sheen: false,
    anisotropy: false,
    textureScale: 0.5,
  },
} as const satisfies Record<string, RivieraQuality>;

export type RivieraQualityTier = keyof typeof RIVIERA_QUALITY;

/** Resolves a tier name or a partial override (on top of `high`) and validates it. */
export function resolveRivieraQuality(
  quality: RivieraQualityTier | Partial<RivieraQuality> = 'high',
): RivieraQuality {
  if (typeof quality === 'string' && !Object.hasOwn(RIVIERA_QUALITY, quality)) {
    throw new RangeError(`Unknown Riviera quality tier "${quality}"`);
  }
  const resolved: RivieraQuality =
    typeof quality === 'string'
      ? RIVIERA_QUALITY[quality]
      : { ...RIVIERA_QUALITY.high, ...quality };
  if (!Number.isInteger(resolved.swells) || resolved.swells < 0 || resolved.swells > MAX_SWELLS) {
    throw new RangeError(
      `quality.swells must be an integer 0..${MAX_SWELLS}, got ${resolved.swells}`,
    );
  }
  if (!(resolved.textureScale > 0 && resolved.textureScale <= 1)) {
    throw new RangeError(`quality.textureScale must be in (0, 1], got ${resolved.textureScale}`);
  }
  return resolved;
}
