import { COLLECTIBLE_COIN_VARIANTS } from '@coinposh/shared';
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
} from 'three/webgpu';
import { VARIANT_GLYPH_INDEX, VARIANT_LOOKS, type VariantGlyph } from './looks.ts';

/** Texels per glyph cell; the badge is drawn at 14 to 40 CSS px, so 64 keeps every mip crisp. */
export const GLYPH_CELL = 64;
/** Signed distance, in glyph units (the cell spans -1..1), that maps to the full byte range. */
export const GLYPH_SPREAD = 0.3;

function circle(x: number, y: number, r: number): number {
  return Math.hypot(x, y) - r;
}

function ring(x: number, y: number, r: number, half: number): number {
  return Math.abs(Math.hypot(x, y) - r) - half;
}

// Inigo Quilez's regular star: `n` points, `m` in 2..n sets how deep the notches cut.
function star(x: number, y: number, r: number, n: number, m: number): number {
  const an = Math.PI / n;
  const en = Math.PI / m;
  const acx = Math.cos(an);
  const acy = Math.sin(an);
  const ecx = Math.cos(en);
  const ecy = Math.sin(en);
  const period = 2 * an;
  const bn = (((Math.atan2(x, y) % period) + period) % period) - an;
  const length = Math.hypot(x, y);
  let px = length * Math.cos(bn) - r * acx;
  let py = length * Math.abs(Math.sin(bn)) - r * acy;
  const k = Math.min(Math.max(-(px * ecx + py * ecy), 0), (r * acy) / ecy);
  px += ecx * k;
  py += ecy * k;
  return Math.hypot(px, py) * Math.sign(px);
}

/**
 * Signed distance from (x, y) to the glyph, negative inside, in glyph units where the badge's
 * inner disc spans -1..1 with +y up.
 */
export function glyphDistance(glyph: VariantGlyph, x: number, y: number): number {
  switch (glyph) {
    case 'sparkle':
      return Math.min(
        star(x + 0.16, y + 0.16, 0.66, 4, 2.15),
        star(x - 0.5, y - 0.5, 0.3, 4, 2.15),
      );
    case 'mirror':
      return Math.min(ring(x, y, 0.56, 0.12), circle(x, y, 0.19));
    case 'star':
      return star(x, y + 0.04, 0.74, 5, 2.6);
    case 'offset':
      return Math.min(ring(x, y, 0.64, 0.075), circle(x - 0.2, y + 0.16, 0.36));
  }
}

/** True for each texel of a `size` x `size` raster whose centre lies inside the glyph. */
export function rasterizeGlyph(glyph: VariantGlyph, size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const x = ((col + 0.5) / size) * 2 - 1;
      const y = 1 - ((row + 0.5) / size) * 2;
      mask[row * size + col] = glyphDistance(glyph, x, y) < 0 ? 1 : 0;
    }
  }
  return mask;
}

/**
 * One row of glyph cells, in `VARIANT_GLYPH_INDEX` order, as signed distance in the red channel
 * (0.5 on the outline, brighter inside). The badge shader reads it with a screen-space
 * smoothstep, so the outline stays a pixel wide at any size.
 */
export function createGlyphAtlas(): DataTexture {
  const cells = COLLECTIBLE_COIN_VARIANTS.length;
  const width = GLYPH_CELL * cells;
  const height = GLYPH_CELL;
  const data = new Uint8Array(width * height * 4);
  for (const variant of COLLECTIBLE_COIN_VARIANTS) {
    const glyph = VARIANT_LOOKS[variant].glyph;
    const x0 = VARIANT_GLYPH_INDEX[variant] * GLYPH_CELL;
    for (let row = 0; row < height; row += 1) {
      // Texture rows run bottom-up, so the first row written is the glyph's bottom edge.
      const y = ((row + 0.5) / height) * 2 - 1;
      for (let col = 0; col < GLYPH_CELL; col += 1) {
        const x = ((col + 0.5) / GLYPH_CELL) * 2 - 1;
        const d = glyphDistance(glyph, x, y);
        const value = Math.round(Math.min(Math.max(0.5 - d / (2 * GLYPH_SPREAD), 0), 1) * 255);
        const o = (row * width + x0 + col) * 4;
        data[o] = value;
        data[o + 1] = value;
        data[o + 2] = value;
        data[o + 3] = 255;
      }
    }
  }
  const atlas = new DataTexture(data, width, height, RGBAFormat);
  atlas.name = 'coin-variant-glyphs';
  atlas.colorSpace = NoColorSpace;
  atlas.generateMipmaps = true;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.needsUpdate = true;
  return atlas;
}
