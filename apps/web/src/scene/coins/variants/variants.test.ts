import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COIN_TIERS, COIN_VARIANTS, COLLECTIBLE_COIN_VARIANTS } from '@coinposh/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Color, PerspectiveCamera, Vector3, type InstancedBufferAttribute } from 'three/webgpu';
import { RARITY_COLORS } from '../../../vfx/palette.ts';
import { rivieraTokens } from '../../venues/riviera/palette.ts';
import { COIN_LOOKS } from '../tiers.ts';
import {
  BADGE_MIN_PX,
  GLINT_SECONDS,
  REDUCED_GLINT_SECONDS,
  VariantCoinField,
  glintAt,
} from './field.ts';
import { GLYPH_CELL, createGlyphAtlas, glyphDistance, rasterizeGlyph } from './glyphs.ts';
import { VARIANT_GLYPH_INDEX, VARIANT_LOOKS, isCollectibleVariant, variantLook } from './looks.ts';
import { createVariantCoinMaterial } from './material.ts';
import { uniform } from 'three/tsl';

const RADIUS = 0.0135;

function luminance(hex: string): number {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

describe('variant looks', () => {
  it('gives every collectible variant from the shared contract a look, and none to a plain strike', () => {
    expect(Object.keys(VARIANT_LOOKS).sort()).toEqual([...COLLECTIBLE_COIN_VARIANTS].sort());
    expect(variantLook('none')).toBeNull();
    expect(isCollectibleVariant('none')).toBe(false);
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      expect(isCollectibleVariant(variant)).toBe(true);
      expect(variantLook(variant)).toBe(VARIANT_LOOKS[variant]);
    }
    expect(COIN_VARIANTS.filter(isCollectibleVariant)).toEqual([...COLLECTIBLE_COIN_VARIANTS]);
  });

  it('maps each variant to its own glyph and accent, the accents climbing the rarity ladder', () => {
    const glyphs = COLLECTIBLE_COIN_VARIANTS.map((v) => VARIANT_LOOKS[v].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(VARIANT_LOOKS.foil.glyph).toBe('sparkle');
    expect(VARIANT_LOOKS.proof.glyph).toBe('mirror');
    expect(VARIANT_LOOKS.firstStrike.glyph).toBe('star');
    expect(VARIANT_LOOKS.misprint.glyph).toBe('offset');
    expect(COLLECTIBLE_COIN_VARIANTS.map((v) => VARIANT_LOOKS[v].accent)).toEqual([
      RARITY_COLORS.fine,
      RARITY_COLORS.rare,
      RARITY_COLORS.exquisite,
      RARITY_COLORS.legendary,
    ]);
  });

  it('numbers the atlas cells in contract order', () => {
    COLLECTIBLE_COIN_VARIANTS.forEach((variant, i) => {
      expect(VARIANT_GLYPH_INDEX[variant]).toBe(i);
    });
  });

  it('gives each variant the finish that names it', () => {
    expect(VARIANT_LOOKS.foil.holo).toBeGreaterThan(0);
    expect(VARIANT_LOOKS.foil.film).toBeGreaterThan(0);
    const proof = VARIANT_LOOKS.proof;
    expect(proof.fieldRoughness).not.toBeNull();
    expect(proof.reliefRoughness).not.toBeNull();
    expect(proof.fieldRoughness ?? 1).toBeLessThan((proof.reliefRoughness ?? 0) / 4);
    expect(VARIANT_LOOKS.firstStrike.starMark).toBeGreaterThan(0);
    expect(VARIANT_LOOKS.firstStrike.edgeCrispness).toBeLessThan(1);
    expect(VARIANT_LOOKS.misprint.strikeOffset).toBeGreaterThan(0.05);
    for (const variant of COLLECTIBLE_COIN_VARIANTS.filter((v) => v !== 'misprint')) {
      expect(VARIANT_LOOKS[variant].strikeOffset).toBe(0);
    }
  });
});

describe('badge glyphs', () => {
  const SIZE = 48;
  const masks = Object.fromEntries(
    COLLECTIBLE_COIN_VARIANTS.map((v) => [v, rasterizeGlyph(VARIANT_LOOKS[v].glyph, SIZE)]),
  );

  function area(mask: Uint8Array): number {
    return mask.reduce((sum, bit) => sum + bit, 0);
  }

  it('fills a readable share of the cell with every glyph and stays inside it', () => {
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      const mask = masks[variant] ?? new Uint8Array();
      const share = area(mask) / mask.length;
      expect(share, variant).toBeGreaterThan(0.12);
      expect(share, variant).toBeLessThan(0.55);
      for (let i = 0; i < SIZE; i += 1) {
        expect(mask[i], `${variant} top row`).toBe(0);
        expect(mask[(SIZE - 1) * SIZE + i], `${variant} bottom row`).toBe(0);
        expect(mask[i * SIZE], `${variant} left column`).toBe(0);
        expect(mask[i * SIZE + SIZE - 1], `${variant} right column`).toBe(0);
      }
    }
  });

  it('keeps every pair of glyphs apart by silhouette, with no colour to help', () => {
    for (const [i, a] of COLLECTIBLE_COIN_VARIANTS.entries()) {
      for (const b of COLLECTIBLE_COIN_VARIANTS.slice(i + 1)) {
        const ma = masks[a] ?? new Uint8Array();
        const mb = masks[b] ?? new Uint8Array();
        let both = 0;
        let either = 0;
        for (let k = 0; k < ma.length; k += 1) {
          both += (ma[k] ?? 0) & (mb[k] ?? 0);
          either += (ma[k] ?? 0) | (mb[k] ?? 0);
        }
        expect(both / either, `${a} vs ${b}`).toBeLessThan(0.5);
      }
    }
  });

  it('draws the misprint glyph off centre, and the mirror and star centred', () => {
    for (const variant of ['mirror', 'star', 'offset'] as const) {
      const mask = rasterizeGlyph(variant, SIZE);
      let cx = 0;
      let cy = 0;
      for (let row = 0; row < SIZE; row += 1) {
        for (let col = 0; col < SIZE; col += 1) {
          if (!mask[row * SIZE + col]) continue;
          cx += ((col + 0.5) / SIZE) * 2 - 1;
          cy += 1 - ((row + 0.5) / SIZE) * 2;
        }
      }
      const offset = Math.hypot(cx, cy) / area(mask);
      if (variant === 'offset') expect(offset).toBeGreaterThan(0.08);
      else expect(offset, variant).toBeLessThan(0.05);
    }
  });

  it('is negative inside and positive outside', () => {
    expect(glyphDistance('mirror', 0, 0)).toBeLessThan(0);
    expect(glyphDistance('mirror', 0.35, 0)).toBeGreaterThan(0);
    expect(glyphDistance('star', 0, 0)).toBeLessThan(0);
    expect(glyphDistance('star', 0.95, 0.95)).toBeGreaterThan(0);
    expect(glyphDistance('offset', 0.2, -0.16)).toBeLessThan(0);
    expect(glyphDistance('sparkle', -0.16, -0.16)).toBeLessThan(0);
    expect(glyphDistance('sparkle', 0.5, 0.5)).toBeLessThan(0);
    expect(glyphDistance('sparkle', 0.3, 0.3)).toBeGreaterThan(0);
  });

  it('packs one cell per variant into the atlas, the outline at half value', () => {
    const atlas = createGlyphAtlas();
    try {
      const { width, height, data } = atlas.image as {
        width: number;
        height: number;
        data: Uint8Array;
      };
      expect(width).toBe(GLYPH_CELL * COLLECTIBLE_COIN_VARIANTS.length);
      expect(height).toBe(GLYPH_CELL);
      const at = (x: number, y: number): number => data[(y * width + x) * 4] ?? -1;
      const mid = GLYPH_CELL / 2;
      for (const variant of COLLECTIBLE_COIN_VARIANTS) {
        const x0 = VARIANT_GLYPH_INDEX[variant] * GLYPH_CELL;
        expect(at(x0, 0), `${variant} corner`).toBe(0);
        expect(at(x0 + mid, mid), `${variant} centre`).toBeGreaterThan(128);
      }
      // Bottom-up rows: the misprint disc sits below centre, so it shows in the lower half.
      const misprint = VARIANT_GLYPH_INDEX.misprint * GLYPH_CELL;
      const below = at(misprint + Math.round(GLYPH_CELL * 0.6), Math.round(GLYPH_CELL * 0.42));
      const above = at(misprint + Math.round(GLYPH_CELL * 0.6), Math.round(GLYPH_CELL * 0.62));
      expect(below).toBeGreaterThan(128);
      expect(above).toBeLessThan(128);
    } finally {
      atlas.dispose();
    }
  });

  it('keeps the badge ink far brighter than its lacquer for any colour vision', () => {
    expect(luminance(rivieraTokens.ivory)).toBeGreaterThan(
      luminance(rivieraTokens['navy-lacquer']) * 8,
    );
  });
});

describe('variant coin materials', () => {
  it('builds one named material per variant that takes any tier look', () => {
    const motion = uniform(1);
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      const built = createVariantCoinMaterial(variant, motion);
      try {
        expect(built.variant).toBe(variant);
        expect(built.material.name).toBe(`coin-variant-${variant}`);
        for (const tier of COIN_TIERS) {
          built.setLook(COIN_LOOKS[tier]);
          expect(built.uniforms.prismatic.value).toBe(COIN_LOOKS[tier].prismatic ? 1 : 0);
        }
      } finally {
        built.material.dispose();
      }
    }
  });
});

describe('glint timing', () => {
  it('sweeps the face once in full motion', () => {
    expect(glintAt(0, false)?.[0]).toBeCloseTo(-1);
    const mid = glintAt(GLINT_SECONDS / 2, false);
    expect(mid?.[0]).toBeGreaterThan(-1);
    expect(mid?.[0]).toBeLessThan(1);
    expect(glintAt(GLINT_SECONDS, false)).toBeNull();
    expect(glintAt(-0.1, false)).toBeNull();
    expect(glintAt(Number.NaN, false)).toBeNull();
  });

  it('flashes in place under reduced motion, with no sweep', () => {
    const peak = glintAt(REDUCED_GLINT_SECONDS / 2, true);
    expect(peak?.[0]).toBeLessThan(-1);
    expect(peak?.[1]).toBeGreaterThan(0.5);
    expect(glintAt(0, true)?.[1]).toBeCloseTo(0);
    expect(glintAt(REDUCED_GLINT_SECONDS, true)).toBeNull();
  });
});

const fields: VariantCoinField[] = [];
function field(capacity = 4): VariantCoinField {
  const created = new VariantCoinField({ capacity, radius: RADIUS });
  fields.push(created);
  return created;
}
afterEach(() => {
  for (const f of fields.splice(0)) f.dispose();
});

function cameraAt(distance: number, height = 800): { camera: PerspectiveCamera; height: number } {
  const camera = new PerspectiveCamera(35, 1, 0.01, 10);
  camera.position.set(0, distance, 0.0001);
  camera.lookAt(new Vector3(0, 0, 0));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { camera, height };
}

const flat = [0, 0, 0, 1];

describe('VariantCoinField', () => {
  it('rejects a bad capacity or radius', () => {
    expect(() => new VariantCoinField({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new VariantCoinField({ capacity: 2.5 })).toThrow(/capacity/);
    expect(() => new VariantCoinField({ capacity: 2, radius: 0 })).toThrow(/radius/);
  });

  it('rejects bad transforms without changing what it holds', () => {
    const f = field(2);
    f.setTransforms('gold', 'foil', [0, 0, 0], flat, 1, [7]);
    expect(() => {
      f.setTransforms('gold', 'foil', [0, 0, 0], flat, 3, [1, 2, 3]);
    }).toThrow(/capacity/);
    expect(() => {
      f.setTransforms('gold', 'foil', [0, 0], flat, 1, [1]);
    }).toThrow(/position/);
    expect(() => {
      f.setTransforms('gold', 'foil', [0, 0, 0, 1, 0, 0], [...flat, ...flat], 2, [4, 4]);
    }).toThrow(/twice/);
    expect(() => {
      f.setTransforms('gold', 'foil', [0, 0, 0], flat, 1, [0.5]);
    }).toThrow(/safe/);
    expect(f.count('gold', 'foil')).toBe(1);
    expect(() => {
      f.glint('gold', 'foil', Number.NaN);
    }).toThrow(/safe/);
  });

  it('draws a tier and variant in one call, with one more each for contacts and badges', () => {
    const f = field(4);
    const { camera, height } = cameraAt(0.4);
    f.setTransforms('gold', 'proof', [0, 0, 0, 0.03, 0, 0], [...flat, ...flat], 2, [1, 2]);
    f.setTransforms('silver', 'misprint', [-0.03, 0, 0], flat, 1, [3]);
    const stats = f.update(camera, height);
    expect(stats.coins).toBe(3);
    expect(stats.badges).toBe(3);
    expect(stats.drawCalls).toBe(4);
    expect(f.mesh('gold', 'proof', 'near').count + f.mesh('gold', 'proof', 'far').count).toBe(2);
    expect(f.mesh('gold', 'foil', 'near').visible).toBe(false);
    f.setBadges(false);
    expect(f.update(camera, height)).toMatchObject({ badges: 0, drawCalls: 3 });
    expect(f.badgeMesh.visible).toBe(false);
  });

  it('shares one shader per variant across all six tiers', () => {
    const f = field(1);
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      const perTier = new Set(COIN_TIERS.map((t) => f.mesh(t, variant, 'near').material));
      expect(perTier.size).toBe(COIN_TIERS.length);
      for (const tier of COIN_TIERS) {
        const material = f.mesh(tier, variant, 'near').material;
        expect(material).toBe(f.mesh(tier, variant, 'far').material);
        expect((material as { name: string }).name).toBe(`coin-variant-${variant}`);
      }
    }
  });

  it('labels each coin with its variant glyph and accent', () => {
    const f = field(1);
    const { camera, height } = cameraAt(0.4);
    f.setTransforms('copper', 'firstStrike', [0, 0, 0], flat, 1, [9]);
    f.update(camera, height);
    const glyphs = f.badgeMesh.geometry.getAttribute('badgeGlyph') as InstancedBufferAttribute;
    const accents = f.badgeMesh.geometry.getAttribute('badgeAccent') as InstancedBufferAttribute;
    expect(glyphs.getX(0)).toBe(VARIANT_GLYPH_INDEX.firstStrike);
    const accent = new Color(RARITY_COLORS.exquisite);
    expect(accents.getX(0)).toBeCloseTo(accent.r, 5);
    expect(accents.getZ(0)).toBeCloseTo(accent.b, 5);
  });

  it('holds badges at a readable size on screen, growing with the coin but never past it', () => {
    const f = field(1);
    f.setTransforms('gold', 'foil', [0, 0, 0], flat, 1, [1]);
    const sizes = f.badgeMesh.geometry.getAttribute('badgeSize') as InstancedBufferAttribute;
    const centres = f.badgeMesh.geometry.getAttribute('badgeCentre') as InstancedBufferAttribute;
    const onScreen = (distance: number): { badgePx: number; coinPx: number } => {
      const { camera, height } = cameraAt(distance);
      f.update(camera, height);
      const ppu = height / (2 * Math.tan((35 * Math.PI) / 360));
      const badgeDistance = new Vector3(centres.getX(0), centres.getY(0), centres.getZ(0))
        .sub(camera.position)
        .length();
      return {
        badgePx: (2 * sizes.getX(0) * ppu) / badgeDistance,
        coinPx: (2 * RADIUS * ppu) / distance,
      };
    };
    // The back of the table from the play camera, about 1.2 m out.
    const back = onScreen(1.2);
    expect(back.badgePx).toBeGreaterThanOrEqual(BADGE_MIN_PX - 0.5);
    const remote = onScreen(3);
    expect(remote.badgePx).toBeLessThan(remote.coinPx * 0.7);
    const table = onScreen(0.9);
    expect(table.badgePx).toBeGreaterThanOrEqual(BADGE_MIN_PX - 0.5);
    expect(table.badgePx).toBeLessThan(table.coinPx);
    const close = onScreen(0.15);
    expect(close.badgePx).toBeLessThan(close.coinPx * 0.8);
    expect(close.badgePx).toBeGreaterThan(table.badgePx);
  });

  it('plays a glint on the minted coin only, then parks it', () => {
    const f = field(2);
    const { camera, height } = cameraAt(0.15);
    f.setTransforms('gold', 'foil', [0, 0, 0, 0.03, 0, 0], [...flat, ...flat], 2, [1, 2]);
    f.glint('gold', 'foil', 2);
    f.update(camera, height, 0);
    f.update(camera, height, GLINT_SECONDS / 2);
    const glints = f
      .mesh('gold', 'foil', 'near')
      .geometry.getAttribute('variantGlint') as InstancedBufferAttribute;
    const sweeps = [glints.getX(0), glints.getX(1)].sort((a, b) => a - b);
    expect(sweeps[0]).toBeLessThan(-1);
    expect(sweeps[1]).toBeGreaterThan(-1);
    expect(sweeps[1]).toBeLessThan(1);
    f.update(camera, height, GLINT_SECONDS);
    expect(Math.max(glints.getX(0), glints.getX(1))).toBeLessThan(-1);
  });

  it('drops a glint when its coin leaves the set', () => {
    const f = field(1);
    const { camera, height } = cameraAt(0.15);
    f.setTransforms('gold', 'proof', [0, 0, 0], flat, 1, [5]);
    f.glint('gold', 'proof', 5);
    f.setTransforms('gold', 'proof', [0, 0, 0], flat, 1, [6]);
    f.update(camera, height, 0.1);
    const glints = f
      .mesh('gold', 'proof', 'near')
      .geometry.getAttribute('variantGlint') as InstancedBufferAttribute;
    expect(glints.getX(0)).toBeLessThan(-1);
  });

  it('hands out warm-up parts for every program and frees only what they own', () => {
    const f = field(1);
    const batch = f.warmParts();
    const materials = new Set(batch.parts.map((p) => ('material' in p ? p.material : null)));
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      expect(materials.has(f.mesh('gold', variant, 'near').material)).toBe(true);
    }
    expect(materials.has(f.badgeMesh.material)).toBe(true);
    expect(materials.has(f.contactMesh.material)).toBe(true);
    batch.release();
    expect(f.badgeMesh.geometry.getAttribute('badgeSize')).toBeDefined();
  });
});

describe('module boundary', () => {
  it('is reached from outside the folder only through lazy.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, '../../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== here && entry.name !== 'node_modules') walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8');
          if (/from\s+['"][^'"]*coins\/variants\/(?!lazy)[^'"]*['"]/.test(text)) {
            offenders.push(relative(src, path));
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
