/**
 * Offline helpers for preparing environment HDRIs (used by `hdri/derive-environment.mjs`).
 * They are plain array maths with no three.js or DOM dependency so Node can run them
 * directly and the unit tests can pin their behaviour.
 */

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

export interface RgbaImage {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
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

/** Box-filters an RGBA image down by an integer factor that divides both dimensions. */
export function downsampleRgba(image: RgbaImage, factor: number): RgbaImage {
  const { data, width, height } = image;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(`factor must be a positive integer, got ${factor}`);
  }
  if (width % factor !== 0 || height % factor !== 0) {
    throw new RangeError(`${width}x${height} is not divisible by ${factor}`);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(`expected ${width * height * 4} floats, got ${data.length}`);
  }
  const outWidth = width / factor;
  const outHeight = height / factor;
  const out = new Float32Array(outWidth * outHeight * 4);
  const weight = 1 / (factor * factor);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const o = (y * outWidth + x) * 4;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * width + x * factor + dx) * 4;
          for (let c = 0; c < 4; c += 1)
            out[o + c] = (out[o + c] ?? 0) + (data[i + c] ?? 0) * weight;
        }
      }
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/** Reverses row order, converting a top-down image to the bottom-up layout three uploads. */
export function flipRows(image: RgbaImage): RgbaImage {
  const { data, width, height } = image;
  const stride = width * 4;
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y += 1) {
    out.set(data.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  }
  return { data: out, width, height };
}
