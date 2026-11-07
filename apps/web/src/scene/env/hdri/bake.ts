import { FloatType } from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * Offline HDRI preparation, run by `bake-hdri.mjs` (never at runtime). The venue only uses the
 * HDRI for PMREM-blurred lighting and reflections, so the shipped file is graded once and
 * downsampled here instead of being decoded at full size and graded on the main thread.
 */

export interface RadianceImage {
  readonly width: number;
  readonly height: number;
  /** Linear RGBA, row-major, top row first. */
  readonly data: Float32Array;
}

export interface RadianceGrade {
  /**
   * Caps every texel's brightest channel, preserving hue. The venue lights its sun with an
   * analytic rim light, so the HDRI's own sun is clipped to stop it flooding rough surfaces
   * with a second, unshadowed sun once PMREM-blurred.
   */
  readonly maxRadiance: number;
  /** Linear RGB multiplier, so a photographed sky can be warmed to match the painted one. */
  readonly tint: readonly [number, number, number];
}

/** The grade baked into `venice_sunset_512.hdr` from Poly Haven's 1k original. */
export const VENICE_SUNSET_GRADE: RadianceGrade = { maxRadiance: 6, tint: [1.15, 0.86, 0.72] };

export function decodeRadiance(buffer: ArrayBuffer): RadianceImage {
  const loader = new HDRLoader();
  loader.setDataType(FloatType);
  const parsed = loader.parse(buffer);
  const { width, height, data } = parsed;
  if (!(data instanceof Float32Array) || width === undefined || height === undefined) {
    throw new Error('Radiance HDR did not decode to sized float RGBA data');
  }
  return { width, height, data };
}

/** Applies a {@link RadianceGrade} in place to linear RGBA texels; returns texels clipped. */
export function gradeRadiance(data: Float32Array, grade: RadianceGrade): number {
  const { maxRadiance, tint } = grade;
  if (!(maxRadiance > 0)) throw new RangeError(`maxRadiance must be positive, got ${maxRadiance}`);
  if (tint.some((channel) => !(channel >= 0))) {
    throw new RangeError(`tint channels must be non-negative, got ${tint.join(', ')}`);
  }
  let clipped = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = (data[i] ?? 0) * tint[0];
    const g = (data[i + 1] ?? 0) * tint[1];
    const b = (data[i + 2] ?? 0) * tint[2];
    const peak = Math.max(r, g, b);
    const scale = peak > maxRadiance ? maxRadiance / peak : 1;
    if (scale < 1) clipped += 1;
    data[i] = r * scale;
    data[i + 1] = g * scale;
    data[i + 2] = b * scale;
  }
  return clipped;
}

/** Halves both dimensions with a 2×2 box filter in linear light. */
export function downsampleHalf(image: RadianceImage): RadianceImage {
  const { width, height, data } = image;
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`downsampleHalf needs even dimensions, got ${width}×${height}`);
  }
  const w = width / 2;
  const h = height / 2;
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        const at = (sx: number, sy: number): number => data[(sy * width + sx) * 4 + c] ?? 0;
        const sum = at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1);
        out[(y * w + x) * 4 + c] = (sum + at(2 * x + 1, 2 * y + 1)) / 4;
      }
    }
  }
  return { width: w, height: h, data: out };
}

function toRgbe(r: number, g: number, b: number, out: Uint8Array, at: number): void {
  const peak = Math.max(r, g, b);
  if (!(peak > 1e-32)) {
    out.fill(0, at, at + 4);
    return;
  }
  let exponent = Math.floor(Math.log2(peak)) + 1;
  if (peak * 2 ** -exponent * 256 >= 256) exponent += 1;
  const scale = 256 * 2 ** -exponent;
  out[at] = Math.floor(r * scale);
  out[at + 1] = Math.floor(g * scale);
  out[at + 2] = Math.floor(b * scale);
  out[at + 3] = exponent + 128;
}

function encodeRun(channel: Uint8Array, bytes: number[]): void {
  let i = 0;
  while (i < channel.length) {
    let run = 1;
    while (run < 127 && i + run < channel.length && channel[i + run] === channel[i]) run += 1;
    if (run >= 4) {
      bytes.push(128 + run, channel[i] ?? 0);
      i += run;
      continue;
    }
    const start = i;
    while (i < channel.length && i - start < 128) {
      const ahead = channel[i];
      if (i + 3 < channel.length && channel[i + 1] === ahead && channel[i + 2] === ahead) {
        if (channel[i + 3] === ahead) break;
      }
      i += 1;
    }
    bytes.push(i - start, ...channel.subarray(start, i));
  }
}

/** Encodes linear RGBA as a run-length-encoded Radiance RGBE (.hdr) file. */
export function encodeRadiance(image: RadianceImage): Uint8Array {
  const { width, height, data } = image;
  if (width < 8 || width > 0x7fff) {
    throw new RangeError(`RLE Radiance scanlines must be 8..32767 wide, got ${width}`);
  }
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const bytes: number[] = Array.from(header, (ch) => ch.charCodeAt(0));
  const rgbe = new Uint8Array(width * 4);
  const planes = [0, 1, 2, 3].map(() => new Uint8Array(width));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      toRgbe(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, rgbe, x * 4);
    }
    bytes.push(2, 2, width >> 8, width & 0xff);
    planes.forEach((plane, c) => {
      for (let x = 0; x < width; x += 1) plane[x] = rgbe[x * 4 + c] ?? 0;
      encodeRun(plane, bytes);
    });
  }
  return Uint8Array.from(bytes);
}

/** Grades the source HDRI and halves it `halvings` times; returns the encoded file. */
export function bakeHdri(source: ArrayBuffer, grade: RadianceGrade, halvings: number): Uint8Array {
  let image = decodeRadiance(source);
  gradeRadiance(image.data, grade);
  for (let i = 0; i < halvings; i += 1) image = downsampleHalf(image);
  return encodeRadiance(image);
}
