/**
 * Radiance (.hdr) images without three.js, so the pre-filter worker stays a few kilobytes and
 * the offline bake and the runtime share one decoder.
 */

export interface RadianceImage {
  readonly width: number;
  readonly height: number;
  /** Linear RGBA, row-major, top row first. */
  readonly data: Float32Array;
}

function readLine(bytes: Uint8Array, start: number): { line: string; next: number } {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0x0a) end += 1;
  if (end >= bytes.length) {
    throw new Error('Radiance HDR header ended before its resolution line');
  }
  return { line: String.fromCharCode(...bytes.subarray(start, end)), next: end + 1 };
}

function readScanline(bytes: Uint8Array, at: number, width: number, rgbe: Uint8Array): number {
  const isRle =
    width >= 8 &&
    width <= 0x7fff &&
    bytes[at] === 2 &&
    bytes[at + 1] === 2 &&
    ((bytes[at + 2] ?? 0) & 0x80) === 0;
  if (!isRle) {
    if (at + width * 4 > bytes.length) throw new Error('Radiance HDR pixel data is truncated');
    rgbe.set(bytes.subarray(at, at + width * 4));
    return at + width * 4;
  }
  if ((((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) !== width) {
    throw new Error(`Radiance HDR scanline width does not match the ${String(width)} px header`);
  }
  let cursor = at + 4;
  for (let channel = 0; channel < 4; channel += 1) {
    let x = 0;
    while (x < width) {
      const count = bytes[cursor];
      if (count === undefined) throw new Error('Radiance HDR pixel data is truncated');
      cursor += 1;
      const run = count > 128;
      const length = run ? count - 128 : count;
      if (length === 0 || x + length > width) {
        throw new Error('Radiance HDR run-length data overruns its scanline');
      }
      for (let i = 0; i < length; i += 1) {
        const value = bytes[run ? cursor : cursor + i];
        if (value === undefined) throw new Error('Radiance HDR pixel data is truncated');
        rgbe[(x + i) * 4 + channel] = value;
      }
      cursor += run ? 1 : length;
      x += length;
    }
  }
  return cursor;
}

/**
 * Decodes a `-Y H +X W` Radiance file, flat or new-style run-length encoded, to linear RGBA
 * with the same scale as three's `HDRLoader`.
 */
export function decodeRgbe(buffer: ArrayBuffer): RadianceImage {
  const bytes = new Uint8Array(buffer);
  let { line, next } = readLine(bytes, 0);
  if (!line.startsWith('#?')) throw new Error('Not a Radiance HDR file: missing the #? signature');
  while (line !== '') ({ line, next } = readLine(bytes, next));
  ({ line, next } = readLine(bytes, next));
  const resolution = /^-Y (\d+) \+X (\d+)$/.exec(line.trim());
  if (!resolution) {
    throw new Error(`Radiance HDR orientation "${line}" is unsupported; expected "-Y H +X W"`);
  }
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);
  const data = new Float32Array(width * height * 4);
  const rgbe = new Uint8Array(width * 4);
  let cursor = next;
  for (let y = 0; y < height; y += 1) {
    cursor = readScanline(bytes, cursor, width, rgbe);
    for (let x = 0; x < width; x += 1) {
      const exponent = rgbe[x * 4 + 3] ?? 0;
      const scale = exponent === 0 ? 0 : 2 ** (exponent - 128) / 255;
      const at = (y * width + x) * 4;
      data[at] = (rgbe[x * 4] ?? 0) * scale;
      data[at + 1] = (rgbe[x * 4 + 1] ?? 0) * scale;
      data[at + 2] = (rgbe[x * 4 + 2] ?? 0) * scale;
      data[at + 3] = 1;
    }
  }
  return { width, height, data };
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

const halfScratch = new Float32Array(1);
const halfBits = new Uint32Array(halfScratch.buffer);

/** Rounds to the nearest IEEE half float; values past its range saturate to ±65504. */
export function toHalfFloat(value: number): number {
  halfScratch[0] = value;
  const bits = halfBits[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 112;
  const mantissa = bits & 0x7fffff;
  if (exponent === 143) return mantissa === 0 ? sign | 0x7bff : 0x7e00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const shifted = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((shifted + 0x1000) >>> 13);
  }
  const rounded = (exponent << 10) + ((mantissa + 0x1000) >>> 13);
  return sign | Math.min(rounded, 0x7bff);
}

export function toHalfFloats(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = toHalfFloat(data[i] ?? 0);
  return out;
}
