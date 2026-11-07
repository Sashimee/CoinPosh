import { describe, expect, it } from 'vitest';
import { Box3, Mesh, PerspectiveCamera, Vector3, type BufferGeometry } from 'three/webgpu';
import { createRivieraDeck } from './deck.ts';
import { halfRoundProfile, line, mergeAll, roundedBox, sweepProfile } from './geometry.ts';
import {
  applyCameraPreset,
  RIVIERA_SUN_DIRECTION,
  RIVIERA_TABLE,
  rivieraCameraPreset,
} from './layout.ts';
import { createNoiseTexture } from '../../env/noise-texture.ts';
import { createRivieraMaterials } from './materials.ts';
import { createRivieraTable, TABLE_BOUNDS } from './table.ts';

const materials = createRivieraMaterials({ noise: createNoiseTexture(16) });

function meshCount(root: { traverse(cb: (o: unknown) => void): void }): number {
  let count = 0;
  root.traverse((o) => {
    if (o instanceof Mesh) count += 1;
  });
  return count;
}

describe('createRivieraTable', () => {
  const table = createRivieraTable(materials, true);

  it('draws the whole cabinet in a handful of merged meshes, one per material', () => {
    expect(meshCount(table.group)).toBe(table.meshes.length);
    expect(table.meshes.length).toBeLessThanOrEqual(9);
    const staticMaterials = table.meshes
      .filter((m) => m.parent === table.group)
      .map((m) => m.material);
    expect(new Set(staticMaterials).size).toBe(staticMaterials.length);
  });

  it('builds valid, indexed geometry with uvs for every mesh', () => {
    for (const m of table.meshes) {
      const geometry: BufferGeometry = m.geometry;
      expect(geometry.index, m.name).not.toBeNull();
      expect(geometry.getAttribute('uv'), m.name).toBeDefined();
      const position = geometry.getAttribute('position');
      expect(Array.from(position.array).every(Number.isFinite), m.name).toBe(true);
    }
  });

  it('keeps the cabinet inside its published bounds', () => {
    const box = new Box3().setFromObject(table.group);
    expect(box.max.x).toBeLessThanOrEqual(TABLE_BOUNDS.halfWidth + 0.02);
    expect(box.min.x).toBeGreaterThanOrEqual(-TABLE_BOUNDS.halfWidth - 0.02);
    expect(box.max.z).toBeLessThanOrEqual(TABLE_BOUNDS.frontZ + 0.02);
    expect(box.max.y).toBeLessThanOrEqual(TABLE_BOUNDS.top + 0.02);
    expect(box.min.y).toBeCloseTo(RIVIERA_TABLE.deckY, 2);
  });

  it('moves the pusher through its stroke and clamps out-of-range input', () => {
    table.setPusherStroke(0);
    expect(table.pusher.position.z).toBe(0);
    table.setPusherStroke(1);
    expect(table.pusher.position.z).toBeCloseTo(RIVIERA_TABLE.pusherStroke, 10);
    table.setPusherStroke(0.5);
    expect(table.pusher.position.z).toBeCloseTo(RIVIERA_TABLE.pusherStroke / 2, 10);
    table.setPusherStroke(4);
    expect(table.pusher.position.z).toBeCloseTo(RIVIERA_TABLE.pusherStroke, 10);
    table.setPusherStroke(-4);
    expect(table.pusher.position.z).toBe(0);
  });

  it('rejects a non-finite stroke instead of moving the pusher to NaN', () => {
    table.setPusherStroke(0.5);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => {
        table.setPusherStroke(bad);
      }).toThrow(RangeError);
    }
    expect(table.pusher.position.z).toBeCloseTo(RIVIERA_TABLE.pusherStroke / 2, 10);
  });
});

describe('createRivieraDeck', () => {
  it('builds the deck, bulwark, gold pinstripe, rails and stanchions in six merged meshes', () => {
    const deck = createRivieraDeck(materials, true);
    expect(deck.meshes).toHaveLength(6);
    expect(meshCount(deck.group)).toBe(6);
    const box = new Box3().setFromObject(deck.group);
    expect(box.min.y).toBeGreaterThanOrEqual(RIVIERA_TABLE.deckY - 0.1);
    deck.dispose();
  });
});

describe('geometry helpers', () => {
  it('sweeps a profile with U running along the path in metres', () => {
    const rod = sweepProfile(
      line(new Vector3(0, 0, 0), new Vector3(2, 0, 0)),
      halfRoundProfile(0.01, 4),
      {
        up: new Vector3(0, 1, 0),
      },
    );
    const uv = rod.getAttribute('uv');
    let maxU = 0;
    for (let i = 0; i < uv.count; i += 1) maxU = Math.max(maxU, uv.getX(i));
    expect(maxU).toBeCloseTo(2, 6);
  });

  it('rejects degenerate paths and profiles', () => {
    const up = new Vector3(0, 1, 0);
    expect(() => sweepProfile([new Vector3()], halfRoundProfile(0.01), { up })).toThrow(
      /two points/,
    );
    expect(() => sweepProfile(line(new Vector3(), new Vector3(1, 0, 0)), [], { up })).toThrow(
      /two points/,
    );
  });

  it('merges indexed and non-indexed pieces into one geometry', () => {
    const merged = mergeAll(
      [
        roundedBox(new Vector3(1, 1, 1), new Vector3(), 0.1),
        sweepProfile(line(new Vector3(), new Vector3(1, 0, 0)), halfRoundProfile(0.01), {
          up: new Vector3(0, 1, 0),
        }),
      ],
      'test',
    );
    expect(merged.index).not.toBeNull();
    expect(merged.name).toBe('test');
    expect(Object.keys(merged.attributes).sort()).toEqual(['normal', 'position', 'uv']);
  });
});

describe('rivieraCameraPreset', () => {
  const corners = [
    new Vector3(-TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(-TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(0, -0.04, TABLE_BOUNDS.frontZ),
    new Vector3(-TABLE_BOUNDS.halfWidth, -0.12, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, -0.12, TABLE_BOUNDS.frontZ),
  ];

  function presetCamera(aspect: number): PerspectiveCamera {
    const camera = new PerspectiveCamera(50, aspect, 0.05, 2000);
    applyCameraPreset(camera, rivieraCameraPreset(aspect));
    camera.updateMatrixWorld();
    return camera;
  }

  for (const [label, aspect] of [
    ['desktop 16:10', 1.6],
    ['desktop 16:9', 16 / 9],
    ['tablet 4:3', 4 / 3],
    ['phone portrait', 390 / 844],
  ] as const) {
    it(`keeps the playfield, tray lip, finials and backboard in frame on ${label}`, () => {
      const camera = presetCamera(aspect);
      for (const corner of corners) {
        const ndc = corner.clone().project(camera);
        expect(Math.abs(ndc.x), `x of ${corner.toArray().join(',')}`).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.y), `y of ${corner.toArray().join(',')}`).toBeLessThanOrEqual(1);
      }
      const frontFrameTop = new Vector3(0, -0.2, TABLE_BOUNDS.frontZ).project(camera);
      expect(frontFrameTop.y, 'front panel frame clears the bottom edge').toBeGreaterThan(-0.92);
    });
  }

  for (const [label, aspect] of [
    ['1280x800', 1280 / 800],
    ['390x844', 390 / 844],
  ] as const) {
    it(`puts the horizon in the upper half and the sun disc inside the frame at ${label}`, () => {
      const camera = presetCamera(aspect);
      const horizon = camera.position
        .clone()
        .add(new Vector3(0, 0, -1000))
        .project(camera);
      expect(horizon.y).toBeGreaterThan(0.25);
      expect(horizon.y).toBeLessThan(0.85);
      const sunOnDome = RIVIERA_SUN_DIRECTION.clone().multiplyScalar(90).project(camera);
      expect(Math.abs(sunOnDome.x)).toBeLessThan(0.85);
      expect(sunOnDome.y).toBeGreaterThan(horizon.y);
      expect(sunOnDome.y).toBeLessThan(0.9);
      expect(sunOnDome.z).toBeLessThan(1);
    });
  }
});
