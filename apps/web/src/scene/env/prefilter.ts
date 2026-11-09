import { decodeRgbe, downsampleHalf, toHalfFloats, type RadianceImage } from './radiance.ts';

/**
 * The pre-filtered environment: an equirect mip chain whose level `k` holds the HDRI convolved
 * with a GGX lobe of roughness `k / (levels - 1)`, so the shader reads any roughness with one
 * trilinear sample at `lod = roughness * (levels - 1)`. Level 0 is the HDRI itself and the last
 * level, roughness 1, is its cosine-weighted irradiance.
 */
export const PREFILTERED_ENVIRONMENT = { width: 512, height: 256, levels: 6 } as const;

export interface PrefilteredEnvironment {
  readonly width: number;
  readonly height: number;
  /** Half-float RGBA per level, top row first, each level half the size of the one before. */
  readonly levels: readonly Uint16Array[];
}

export interface PrefilterRequest {
  readonly url: string;
}

export type PrefilterReply =
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly levels: Uint16Array[];
    }
  | { readonly ok: false; readonly message: string };

/** Lobe tails past `tan(θh) = 5α` hold under 4 % of the GGX energy; they are cut and renormalised. */
const LOBE_TAN_EXTENT = 5;
/** Source texels per half-intensity lobe radius, so even the sharpest lobe is resolved. */
const TEXELS_PER_LOBE_CORE = 2;
const MIN_SOURCE_WIDTH = 16;

interface Rows {
  readonly sin: Float64Array;
  readonly cos: Float64Array;
}

function rows(height: number): Rows {
  const sin = new Float64Array(height);
  const cos = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    const latitude = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    sin[y] = Math.sin(latitude);
    cos[y] = Math.cos(latitude);
  }
  return { sin, cos };
}

function longitudes(width: number): Rows {
  const sin = new Float64Array(width);
  const cos = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const longitude = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
    sin[x] = Math.sin(longitude);
    cos[x] = Math.cos(longitude);
  }
  return { sin, cos };
}

/**
 * Convolves `source` with the GGX lobe of `roughness`, assuming N = V = R as the split-sum
 * approximation does: each texel is weighted by D(h) · (L · R) · its solid angle.
 */
export function convolveGgx(
  source: RadianceImage,
  roughness: number,
  width: number,
  height: number,
): RadianceImage {
  if (!(roughness > 0 && roughness <= 1)) {
    throw new RangeError(`GGX roughness must be in (0, 1], got ${String(roughness)}`);
  }
  const alpha2 = roughness ** 4;
  const cap = Math.min(2 * Math.atan(LOBE_TAN_EXTENT * roughness * roughness), Math.PI / 2);
  const cosCap = Math.cos(cap);
  const src = source.data;
  const srcRows = rows(source.height);
  const srcCols = longitudes(source.width);
  const outRows = rows(height);
  const outCols = longitudes(width);
  const rowStep = Math.PI / source.height;
  const colStep = (2 * Math.PI) / source.width;
  const out = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sinR = outRows.sin[y] ?? 0;
    const cosR = outRows.cos[y] ?? 0;
    const latitude = Math.asin(sinR);
    const first = Math.max(0, Math.floor((Math.PI / 2 - latitude - cap) / rowStep));
    const last = Math.min(source.height - 1, Math.ceil((Math.PI / 2 - latitude + cap) / rowStep));
    for (let x = 0; x < width; x += 1) {
      const cosLonR = outCols.cos[x] ?? 0;
      const sinLonR = outCols.sin[x] ?? 0;
      const centre = ((x + 0.5) / width) * source.width - 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let sy = first; sy <= last; sy += 1) {
        const sinL = srcRows.sin[sy] ?? 0;
        const cosL = srcRows.cos[sy] ?? 0;
        const across = cosL * cosR;
        const along = sinL * sinR;
        const bound = across > 1e-9 ? (cosCap - along) / across : -2;
        if (bound > 1) continue;
        const span = bound <= -1 ? source.width : Math.ceil(Math.acos(bound) / colStep) * 2 + 3;
        const count = Math.min(span, source.width);
        const start = count === source.width ? 0 : Math.round(centre) - (count >> 1);
        const rowOffset = sy * source.width;
        for (let i = 0; i < count; i += 1) {
          const sx = (((start + i) % source.width) + source.width) % source.width;
          const cosDelta = (srcCols.cos[sx] ?? 0) * cosLonR + (srcCols.sin[sx] ?? 0) * sinLonR;
          const lDotR = across * cosDelta + along;
          if (lDotR <= cosCap || lDotR <= 0) continue;
          const nDotH2 = (1 + lDotR) / 2;
          const d = nDotH2 * (alpha2 - 1) + 1;
          const weight = (lDotR * cosL) / (d * d);
          const at = (rowOffset + sx) * 4;
          r += (src[at] ?? 0) * weight;
          g += (src[at + 1] ?? 0) * weight;
          b += (src[at + 2] ?? 0) * weight;
          total += weight;
        }
      }
      const at = (y * width + x) * 4;
      const norm = total > 0 ? 1 / total : 0;
      out[at] = r * norm;
      out[at + 1] = g * norm;
      out[at + 2] = b * norm;
      out[at + 3] = 1;
    }
  }
  return { width, height, data: out };
}

/** Narrowest source that still resolves the lobe's half-intensity radius. */
function sourceWidthFor(roughness: number, outputWidth: number): number {
  const core = 2 * Math.atan(Math.sqrt(Math.SQRT2 - 1) * roughness * roughness);
  const needed = (2 * Math.PI * TEXELS_PER_LOBE_CORE) / core;
  let width = MIN_SOURCE_WIDTH;
  while (width < needed && width < outputWidth) width *= 2;
  return Math.max(MIN_SOURCE_WIDTH, Math.min(width, outputWidth));
}

/** Builds the pre-filtered chain described by {@link PREFILTERED_ENVIRONMENT} from `source`. */
export function prefilterEquirect(source: RadianceImage, levels: number): RadianceImage[] {
  const { width, height } = source;
  if (width !== height * 2 || width >> (levels - 1) < 2 || width % (1 << (levels - 1)) !== 0) {
    throw new RangeError(
      `A ${String(levels)}-level equirect chain needs a 2:1 image divisible by ${String(1 << (levels - 1))}, got ${String(width)}×${String(height)}`,
    );
  }
  const sources = [source];
  for (let last = source; last.width > MIN_SOURCE_WIDTH;) {
    last = downsampleHalf(last);
    sources.push(last);
  }
  const chain = [source];
  for (let k = 1; k < levels; k += 1) {
    const roughness = k / (levels - 1);
    const w = width >> k;
    const want = sourceWidthFor(roughness, w);
    const from = sources.find((candidate) => candidate.width <= want) ?? source;
    chain.push(convolveGgx(from, roughness, w, height >> k));
  }
  return chain;
}

/** Decodes a 512×256 Radiance file and pre-filters it into half-float levels. */
export function prefilterRadianceFile(buffer: ArrayBuffer): PrefilteredEnvironment {
  const image = decodeRgbe(buffer);
  const { width, height, levels } = PREFILTERED_ENVIRONMENT;
  if (image.width !== width || image.height !== height) {
    throw new Error(
      `The environment HDRI is ${String(image.width)}×${String(image.height)}, not ${String(width)}×${String(height)}; re-bake it with hdri/bake-hdri.mjs`,
    );
  }
  return {
    width,
    height,
    levels: prefilterEquirect(image, levels).map((level) => toHalfFloats(level.data)),
  };
}
