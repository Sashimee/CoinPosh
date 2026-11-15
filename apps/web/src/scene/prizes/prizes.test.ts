import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIZE_FAMILIES, PRIZE_RARITIES, type PrizeFamily } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  type MeshPhysicalNodeMaterial,
} from 'three/webgpu';
import { RARITY_COLORS } from '../../vfx/palette.ts';
import { QUALITY_TIERS } from '../quality/tiers.ts';
import {
  GLINT_PARKED,
  MODEL_DETAIL,
  PRIZE_DIMENSIONS,
  PRIZE_GLINT_SECONDS,
  PRIZE_LOOKS,
  PRIZE_REDUCED_GLINT_SECONDS,
  buildPrizeGeometry,
  createPrizeKit,
  createPrizeMaterials,
  createPrizeUniforms,
  isPrizeFamily,
  isPrizeRarity,
  prizeGlintAt,
  type PrizeLook,
} from './index.ts';
import { merge, paint, withTangents } from './shapes.ts';

/** Distance between two sRGB hex colours in display space, 0..sqrt(3). */
function colourDistance(a: string, b: string): number {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [x, y] = [channels(a), channels(b)];
  return Math.hypot(...x.map((v, i) => v - (y[i] ?? 0)));
}

function parts(family: PrizeFamily): BufferGeometry[] {
  const g = buildPrizeGeometry(family, PRIZE_LOOKS.rare, MODEL_DETAIL.medium);
  return [g.metal, g.glass, g.scent, g.leather, g.hand].filter(
    (p): p is BufferGeometry => p !== null,
  );
}

function meshes(root: { traverse(fn: (o: unknown) => void): void }): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) found.push(o as Mesh);
  });
  return found;
}

describe('prize looks', () => {
  it('covers every family and rarity of the shared contract', () => {
    expect(Object.keys(PRIZE_LOOKS).sort()).toEqual([...PRIZE_RARITIES].sort());
    expect(Object.keys(PRIZE_DIMENSIONS).sort()).toEqual([...PRIZE_FAMILIES].sort());
    for (const family of PRIZE_FAMILIES) expect(isPrizeFamily(family)).toBe(true);
    for (const rarity of PRIZE_RARITIES) expect(isPrizeRarity(rarity)).toBe(true);
    expect(isPrizeFamily('yacht')).toBe(false);
    expect(isPrizeRarity('mythic')).toBe(false);
  });

  it('tells neighbouring rarities apart by their enamel and lifts the metal to gold at the top', () => {
    let previous: PrizeLook | null = null;
    for (const rarity of PRIZE_RARITIES) {
      const look = PRIZE_LOOKS[rarity];
      if (previous) {
        expect(colourDistance(previous.enamel, look.enamel)).toBeGreaterThan(0.15);
        expect(colourDistance(previous.scent, look.scent)).toBeGreaterThan(0.15);
      }
      previous = look;
    }
    const gold = new Color(PRIZE_LOOKS.legendary.metal);
    expect(gold.r - gold.b).toBeGreaterThan(0.4);
    const steel = new Color(PRIZE_LOOKS.common.metal);
    expect(Math.abs(steel.r - steel.b)).toBeLessThan(0.1);
    expect(PRIZE_LOOKS.fine.accent).toBe(RARITY_COLORS.fine);
    expect(PRIZE_LOOKS.legendary.accent).toBe(RARITY_COLORS.legendary);
  });

  it('polishes the precious metals smoother than steel', () => {
    expect(PRIZE_LOOKS.legendary.brush).toBeLessThan(PRIZE_LOOKS.exquisite.brush);
    expect(PRIZE_LOOKS.exquisite.brush).toBeLessThan(PRIZE_LOOKS.common.brush);
  });
});

describe('prize geometry', () => {
  it.each(PRIZE_FAMILIES)('builds %s to its published size', (family) => {
    const bounds = new Box3();
    for (const part of parts(family)) {
      part.computeBoundingBox();
      if (part.boundingBox) bounds.union(part.boundingBox);
    }
    const size = bounds.getSize(bounds.min.clone()).toArray();
    PRIZE_DIMENSIONS[family].forEach((expected, axis) => {
      expect(size[axis]).toBeCloseTo(expected, 3);
    });
  });

  it.each(PRIZE_FAMILIES)(
    'gives every %s vertex a finite finish, pattern and unit tangent',
    (family) => {
      for (const part of parts(family)) {
        for (const name of ['position', 'normal', 'uv', 'color', 'finish', 'pattern', 'tangent']) {
          const attr = part.getAttribute(name);
          expect(attr, `${part.name} ${name}`).toBeDefined();
          expect(Array.from(attr.array as ArrayLike<number>).every(Number.isFinite)).toBe(true);
        }
        const t = part.getAttribute('tangent');
        for (let i = 0; i < t.count; i += 1) {
          expect(Math.hypot(t.getX(i), t.getY(i), t.getZ(i))).toBeCloseTo(1, 3);
        }
      }
    },
  );

  it('changes only colours between rarities, never the shape', () => {
    for (const family of PRIZE_FAMILIES) {
      const common = buildPrizeGeometry(family, PRIZE_LOOKS.common, MODEL_DETAIL.low);
      const legendary = buildPrizeGeometry(family, PRIZE_LOOKS.legendary, MODEL_DETAIL.low);
      expect(legendary.metal.getAttribute('position').array).toEqual(
        common.metal.getAttribute('position').array,
      );
      expect(legendary.metal.getAttribute('color').array).not.toEqual(
        common.metal.getAttribute('color').array,
      );
    }
  });

  it('refuses to merge a part that was never painted', () => {
    const painted = paint(new BoxGeometry(1, 1, 1), '#ffffff');
    expect(() => merge([painted, new BoxGeometry(1, 1, 1)], 'test')).toThrow(/paint every part/);
  });

  it('replaces a tangent that collapsed with a direction in the surface', () => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3),
    );
    g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), 2));
    g.setIndex([0, 2, 1]);
    withTangents(g);
    const t = g.getAttribute('tangent');
    for (let i = 0; i < 3; i += 1) {
      expect(Math.hypot(t.getX(i), t.getY(i), t.getZ(i))).toBeCloseTo(1, 5);
      expect(t.getY(i)).toBeCloseTo(0, 5);
    }
  });
});

describe('prize materials', () => {
  const material = (quality: (typeof QUALITY_TIERS)[number]) =>
    createPrizeMaterials(quality, createPrizeUniforms('#ffffff', 0.04));

  it('drops clearcoat, sheen, anisotropy and transmission on the low tier', () => {
    const low = material('low');
    expect(low.metal.clearcoat).toBe(0);
    expect(low.metal.clearcoatNode).toBeNull();
    expect(low.metal.anisotropyNode).toBeNull();
    expect(low.leather.sheen).toBe(0);
    expect(low.leather.sheenNode).toBeNull();
    expect(low.glass.transmission).toBe(0);
    expect(low.glass.transparent).toBe(true);
  });

  it('brushes and lacquers the metal on medium and refracts the glass only on high', () => {
    const medium = material('medium');
    expect(medium.metal.anisotropyNode).not.toBeNull();
    expect(medium.metal.clearcoatNode).not.toBeNull();
    expect(medium.leather.sheenNode).not.toBeNull();
    expect(medium.glass.transmission).toBe(0);
    const high = material('high');
    expect(high.glass.transmission).toBe(1);
    expect(high.glass.transparent).toBe(false);
  });

  it('keeps the scent opaque so the transmission pass sees it through the glass', () => {
    for (const quality of QUALITY_TIERS) expect(material(quality).scent.transparent).toBe(false);
  });
});

describe('prize kit', () => {
  it.each(PRIZE_FAMILIES)(
    'centres a %s on its box and draws it in at most five calls',
    (family) => {
      const kit = createPrizeKit({ quality: 'medium' });
      const view = kit.create(family, { rarity: 'exquisite' });
      const [x, y, z] = PRIZE_DIMENSIONS[family];
      expect(view.halfExtents.x * 2).toBeCloseTo(x, 4);
      expect(view.halfExtents.y * 2).toBeCloseTo(y, 4);
      expect(view.halfExtents.z * 2).toBeCloseTo(z, 4);
      const solid = meshes(view.object3d).filter((m) => !m.name.endsWith('contact'));
      const bounds = new Box3();
      view.object3d.updateMatrixWorld(true);
      for (const mesh of solid) bounds.expandByObject(mesh);
      const centre = bounds.getCenter(bounds.min.clone());
      expect(centre.length()).toBeLessThan(1e-4);
      expect(view.drawCalls).toBe(meshes(view.object3d).length);
      expect(view.drawCalls).toBeLessThanOrEqual(5);
      expect(meshes(view.object3d).some((m) => m.name.endsWith('hand'))).toBe(family === 'watch');
      kit.dispose();
    },
  );

  it('shares geometry across views of one family and rarity but gives each its own materials', () => {
    const kit = createPrizeKit({ quality: 'high' });
    const a = kit.create('watch', { rarity: 'rare' });
    const b = kit.create('watch', { rarity: 'rare' });
    const metal = (v: typeof a) => meshes(v.object3d).find((m) => m.name.endsWith('metal'));
    expect(metal(a)?.geometry).toBe(metal(b)?.geometry);
    expect(metal(a)?.material).not.toBe(metal(b)?.material);
    expect(a.uniforms).not.toBe(b.uniforms);
    kit.dispose();
  });

  it('sweeps the glint across and parks it, or flashes the accent under reduced motion', () => {
    const kit = createPrizeKit({ quality: 'low' });
    const view = kit.create('perfume', { rarity: 'legendary' });
    expect(view.uniforms.glint.value).toBe(GLINT_PARKED);
    view.glint();
    const start = view.uniforms.glint.value;
    view.update(PRIZE_GLINT_SECONDS / 2);
    expect(view.uniforms.glint.value).toBeGreaterThan(start);
    view.update(PRIZE_GLINT_SECONDS);
    expect(view.uniforms.glint.value).toBe(GLINT_PARKED);
    expect(view.uniforms.flash.value).toBe(0);

    view.setReducedMotion(true);
    view.glint();
    view.update(PRIZE_REDUCED_GLINT_SECONDS / 2);
    expect(view.uniforms.glint.value).toBe(GLINT_PARKED);
    expect(view.uniforms.flash.value).toBeCloseTo(1, 5);
    view.update(PRIZE_REDUCED_GLINT_SECONDS);
    expect(view.uniforms.flash.value).toBe(0);
    kit.dispose();
  });

  it('times the glint over its window and nowhere else', () => {
    expect(prizeGlintAt(-0.01, false)).toBeNull();
    expect(prizeGlintAt(0, false)).toBe(0);
    expect(prizeGlintAt(PRIZE_GLINT_SECONDS, false)).toBeNull();
    expect(prizeGlintAt(PRIZE_GLINT_SECONDS, true)).not.toBeNull();
    expect(prizeGlintAt(PRIZE_REDUCED_GLINT_SECONDS, true)).toBeNull();
  });

  it('ticks the seconds hand once a second and holds it still under reduced motion', () => {
    const kit = createPrizeKit({ quality: 'low' });
    const view = kit.create('watch', { rarity: 'common' });
    const hand = meshes(view.object3d).find((m) => m.name.endsWith('hand'));
    if (!hand) throw new Error('watch has no seconds hand');
    const rest = hand.rotation.y;
    view.update(0.5);
    expect(hand.rotation.y).toBe(rest);
    view.update(0.6);
    expect(hand.rotation.y).toBeCloseTo(rest - Math.PI / 30, 6);
    view.setReducedMotion(true);
    expect(hand.rotation.y).toBe(rest);
    view.update(5);
    expect(hand.rotation.y).toBe(rest);
    kit.dispose();
  });

  it('rejects unknown families and rarities, and use after dispose', () => {
    const kit = createPrizeKit({ quality: 'low' });
    expect(() => kit.create('yacht' as PrizeFamily, { rarity: 'rare' })).toThrow(
      /Unknown prize family/,
    );
    expect(() => kit.create('watch', { rarity: 'mythic' as 'rare' })).toThrow(
      /Unknown prize rarity/,
    );
    kit.dispose();
    expect(() => kit.create('watch', { rarity: 'rare' })).toThrow(/disposed/);
  });

  it('hands out a warm-up part for every program a prize can draw with', () => {
    for (const quality of QUALITY_TIERS) {
      const kit = createPrizeKit({ quality });
      const batch = kit.warmParts();
      const names = batch.parts.map((p) => {
        if (!(p instanceof Mesh)) throw new Error('warm part is not a mesh');
        return (p.material as MeshPhysicalNodeMaterial).name;
      });
      expect(names.sort()).toEqual(
        ['prize/contact', 'prize/glass', 'prize/leather', 'prize/metal', 'prize/scent'].sort(),
      );
      batch.release();
      kit.dispose();
    }
  });
});

describe('module boundary', () => {
  it('is reached from outside the folder only through lazy.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, '../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== here && entry.name !== 'node_modules') walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8');
          if (/from\s+['"][^'"]*(?:^|[/.'"])prizes\/(?!lazy)[^'"]*['"]/.test(text)) {
            offenders.push(relative(src, path));
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
