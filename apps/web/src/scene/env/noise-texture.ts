import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
  type Node,
  type Texture,
} from 'three/webgpu';
import { texture } from 'three/tsl';

/**
 * Layout of the baked noise atlas. Every channel tiles seamlessly over one texture repeat and
 * stores a signed value v as (v / range) * 0.5 + 0.5. Cell counts are per repeat, so a
 * shader reaches a noise frequency f (cycles per unit) by sampling at coordinate f / cells.
 */
export const NOISE_CHANNELS = {
  /** Fine gradient noise, stretched 4:1 so wood fibres can be sampled without distortion. */
  fibre: { channel: 0, cellsX: 64, cellsY: 16, octaves: 1, gain: 1, range: 1 },
  /** Three-octave fractal noise with the same 4:1 stretch, for wood figure and streaks. */
  streak: { channel: 1, cellsX: 8, cellsY: 4, octaves: 3, gain: 0.55, range: 2 },
  /** Four-octave isotropic fractal noise for clouds and soft pile variation. */
  cloud: { channel: 2, cellsX: 4, cellsY: 4, octaves: 4, gain: 0.5, range: 2 },
  /** Fine isotropic gradient noise for flake, brushing and ripples. */
  speckle: { channel: 3, cellsX: 32, cellsY: 32, octaves: 1, gain: 1, range: 1 },
} as const;

export type NoiseChannel = (typeof NOISE_CHANNELS)[keyof typeof NOISE_CHANNELS];

export const NOISE_TEXTURE_SIZE = 256;

function latticeHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** 2D gradient noise in roughly [-1, 1] that repeats every `periodX` × `periodY` cells. */
export function periodicGradientNoise(
  x: number,
  y: number,
  periodX: number,
  periodY: number,
  seed: number,
): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const corner = (cx: number, cy: number): number => {
    const angle = latticeHash(mod(ix + cx, periodX), mod(iy + cy, periodY), seed) * Math.PI * 2;
    return Math.cos(angle) * (fx - cx) + Math.sin(angle) * (fy - cy);
  };
  const u = fade(fx);
  const v = fade(fy);
  const bottom = corner(0, 0) + (corner(1, 0) - corner(0, 0)) * u;
  const top = corner(0, 1) + (corner(1, 1) - corner(0, 1)) * u;
  return (bottom + (top - bottom) * v) * Math.SQRT2;
}

function sampleChannel(spec: NoiseChannel, s: number, t: number, seed: number): number {
  let sum = 0;
  let amplitude = 1;
  let scale = 1;
  for (let octave = 0; octave < spec.octaves; octave += 1) {
    const px = spec.cellsX * scale;
    const py = spec.cellsY * scale;
    sum += amplitude * periodicGradientNoise(s * px, t * py, px, py, seed + octave * 101);
    amplitude *= spec.gain;
    scale *= 2;
  }
  return sum;
}

/** Bakes the noise atlas texels (RGBA8, row-major, `size` × `size`). */
export function bakeNoiseTexels(size = NOISE_TEXTURE_SIZE, seed = 1): Uint8Array {
  if (!Number.isInteger(size) || size < 16) {
    throw new RangeError(`Noise texture size must be an integer of at least 16, got ${size}`);
  }
  const data = new Uint8Array(size * size * 4);
  const channels = Object.values(NOISE_CHANNELS);
  for (let row = 0; row < size; row += 1) {
    const t = row / size;
    for (let column = 0; column < size; column += 1) {
      const s = column / size;
      const texel = (row * size + column) * 4;
      for (const spec of channels) {
        const value = sampleChannel(spec, s, t, seed + spec.channel * 7919) / spec.range;
        data[texel + spec.channel] = Math.round(Math.min(Math.max(value * 0.5 + 0.5, 0), 1) * 255);
      }
    }
  }
  return data;
}

/**
 * Bakes the shared noise atlas once at venue creation. Materials, sky and sea sample it
 * instead of evaluating procedural noise per pixel per frame, and its mip chain filters the
 * fine channels to their average at a distance instead of letting them shimmer.
 */
export function createNoiseTexture(size = NOISE_TEXTURE_SIZE): DataTexture {
  const atlas = new DataTexture(bakeNoiseTexels(size), size, size, RGBAFormat, UnsignedByteType);
  atlas.name = 'baked-noise';
  atlas.colorSpace = NoColorSpace;
  atlas.wrapS = RepeatWrapping;
  atlas.wrapT = RepeatWrapping;
  atlas.magFilter = LinearFilter;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.anisotropy = 4;
  atlas.needsUpdate = true;
  return atlas;
}

/** Samples the atlas once; read channels from the result with {@link decodeNoise}. */
export function sampleNoiseAtlas(atlas: Texture, coord: Node<'vec2'>): Node<'vec4'> {
  return texture(atlas, coord);
}

/** Unpacks one channel of an atlas sample back to its signed value. */
export function decodeNoise(sample: Node<'vec4'>, spec: NoiseChannel): Node<'float'> {
  const raw = [sample.x, sample.y, sample.z, sample.w][spec.channel];
  if (!raw) throw new RangeError(`Noise channel ${spec.channel} is outside 0..3`);
  return raw.mul(2).sub(1).mul(spec.range);
}
