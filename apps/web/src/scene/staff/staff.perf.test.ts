import { STAFF_ROLES } from '@coinposh/shared';
import { type Mesh, SkinnedMesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PROFILES, QUALITY_TIERS, type QualityTier } from '../quality/tiers.ts';
import { ACTION_SECONDS, createStaffFigure, STAFF_BUDGET, type StaffFigure } from './index.ts';

/**
 * The household is three figures at the table edge, a garnish beside the coins: it must fit
 * the mid profile's frame with room to spare. Draw calls and triangles are counted from the
 * scene graph as the renderer would issue them; the CPU cost is the per-frame pose of all
 * three, measured on a desktop so a mid phone at roughly 5x slower still fits.
 */
const ROUNDS = 12;
const FRAMES = 120;

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Infinity;
}

function household(quality: QualityTier): StaffFigure[] {
  return STAFF_ROLES.map((role, i) => createStaffFigure(role, { quality, phase: i * 1.7 }));
}

function drawn(figures: readonly StaffFigure[]): Mesh[] {
  const found: Mesh[] = [];
  for (const figure of figures) {
    figure.object3d.traverse((node) => {
      if (node instanceof SkinnedMesh && node.visible) found.push(node);
    });
  }
  return found;
}

function triangles(mesh: Mesh): number {
  const index = mesh.geometry.getIndex();
  return (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
}

describe('staff household frame cost', () => {
  it.each(QUALITY_TIERS)('fits the %s draw-call and triangle budget', (quality) => {
    const figures = household(quality);
    const meshes = drawn(figures);
    const shadowCasters = QUALITY_PROFILES[quality].coinShadows
      ? meshes.filter((mesh) => mesh.castShadow).length
      : 0;
    const drawCalls = meshes.length + shadowCasters;
    const tris = meshes.reduce((sum, mesh) => sum + triangles(mesh), 0);
    console.info(
      `[staff] ${quality}: ${drawCalls} draw calls (${meshes.length} colour + ${shadowCasters} shadow), ${Math.round(tris)} triangles`,
    );
    expect(drawCalls).toBeLessThanOrEqual(STAFF_BUDGET.drawCalls);
    expect(tris).toBeLessThanOrEqual(STAFF_BUDGET.triangles[quality]);
    for (const figure of figures) figure.dispose();
  });

  it(`poses all three figures in under ${STAFF_BUDGET.updateMs} ms a frame`, () => {
    const figures = household('medium');
    figures.forEach((figure, i) => {
      if (i !== 1) figure.act();
    });
    const frameMs = (frame: number): number => {
      const t = 1 + (frame / FRAMES) * Math.max(...Object.values(ACTION_SECONDS));
      const start = performance.now();
      for (const figure of figures) figure.update(t);
      return performance.now() - start;
    };
    for (let frame = 0; frame < FRAMES; frame++) frameMs(frame);

    const fastest = Array.from({ length: FRAMES }, () => Infinity);
    for (let round = 0; round < ROUNDS; round++) {
      for (const figure of figures) figure.act();
      for (let frame = 0; frame < FRAMES; frame++) {
        fastest[frame] = Math.min(fastest[frame] ?? Infinity, frameMs(frame));
      }
    }
    const median = percentile(fastest, 0.5);
    const worst = Math.max(...fastest);
    console.info(
      `[staff] pose of three figures over ${FRAMES} frames: median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`,
    );
    expect(median).toBeLessThan(STAFF_BUDGET.updateMs);
    expect(worst).toBeLessThan(STAFF_BUDGET.updateMs * 3);
    for (const figure of figures) figure.dispose();
  });
});
