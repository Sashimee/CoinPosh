import { describe, expect, it } from 'vitest';
import {
  Box3,
  DataTexture,
  Euler,
  Mesh,
  PerspectiveCamera,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import { CALM_SEA } from '../../env/sway.ts';
import { createRivieraDeck } from './deck.ts';
import { halfRoundProfile, line, mergeAll, roundedBox, sweepProfile } from './geometry.ts';
import {
  applyCameraPreset,
  RIVIERA_SUN_DIRECTION,
  RIVIERA_TABLE,
  rivieraCameraPreset,
} from './layout.ts';
import { createRivieraMaterials } from './materials.ts';
import { RIVIERA_QUALITY } from './quality.ts';
import { createRivieraTable, TABLE_BOUNDS } from './table.ts';

const tile = (): DataTexture => new DataTexture(new Uint8Array([200, 160, 120, 128]), 1, 1);
const materials = createRivieraMaterials({ sole: tile(), deck: tile() }, RIVIERA_QUALITY.high);

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
});

describe('createRivieraDeck', () => {
  it('builds the deck, bulwark, trim, rails and stanchions in six merged meshes', () => {
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

function presetCamera(aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, aspect, 0.05, 120);
  applyCameraPreset(camera, rivieraCameraPreset(aspect));
  camera.updateMatrixWorld();
  return camera;
}

function expectInFrame(camera: PerspectiveCamera, points: readonly Vector3[], limit = 1): void {
  for (const point of points) {
    const ndc = point.clone().project(camera);
    const at = point
      .toArray()
      .map((v) => v.toFixed(3))
      .join(',');
    expect(Math.abs(ndc.x), `x of ${at}`).toBeLessThanOrEqual(limit);
    expect(Math.abs(ndc.y), `y of ${at}`).toBeLessThanOrEqual(limit);
  }
}

describe('rivieraCameraPreset', () => {
  const field = [
    new Vector3(-TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(-RIVIERA_TABLE.fieldHalfWidth, 0, RIVIERA_TABLE.fieldFrontZ),
    new Vector3(RIVIERA_TABLE.fieldHalfWidth, 0, RIVIERA_TABLE.fieldFrontZ),
  ];
  const cabinetFront = [
    new Vector3(-TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(0, -0.04, TABLE_BOUNDS.frontZ),
  ];

  for (const [label, aspect] of [
    ['desktop 16:10', 1.6],
    ['desktop 16:9', 16 / 9],
    ['tablet 4:3', 4 / 3],
  ] as const) {
    it(`keeps the playfield, tray lip and backboard in frame on ${label}`, () => {
      expectInFrame(presetCamera(aspect), [...field, ...cabinetFront]);
    });
  }

  it('frames portrait tight on the playfield and crops the front panel', () => {
    const camera = presetCamera(390 / 844);
    expectInFrame(camera, field);
    const frontPanel = new Vector3(0, -0.45, TABLE_BOUNDS.frontZ).project(camera);
    expect(frontPanel.y).toBeLessThan(-1);
    const fieldCorner = new Vector3(RIVIERA_TABLE.fieldHalfWidth, 0, RIVIERA_TABLE.fieldFrontZ);
    fieldCorner.project(camera);
    expect(Math.abs(fieldCorner.x)).toBeGreaterThan(0.8);
  });

  for (const [label, aspect] of [
    ['16:10', 1.6],
    ['16:9', 16 / 9],
  ] as const) {
    it(`keeps the whole sun disc in frame on ${label} through the sway extremes`, () => {
      const camera = presetCamera(aspect);
      const centre = RIVIERA_SUN_DIRECTION.clone().multiplyScalar(90);
      const discRadius = Math.tan((0.62 * Math.PI) / 180) * 90;
      const tangent = new Vector3(0, 1, 0).cross(RIVIERA_SUN_DIRECTION).normalize();
      const bitangent = RIVIERA_SUN_DIRECTION.clone().cross(tangent).normalize();
      const rim = [tangent, tangent.clone().negate(), bitangent, bitangent.clone().negate()].map(
        (axis) => centre.clone().addScaledVector(axis, discRadius),
      );
      const { rollAmplitude: roll, pitchAmplitude: pitch, heaveAmplitude: heave } = CALM_SEA;
      for (const r of [-roll, roll]) {
        for (const p of [-pitch, pitch]) {
          for (const h of [-heave, heave]) {
            const sway = new Euler(-p, 0, -r);
            const swayed = rim.map((v) =>
              v
                .clone()
                .applyEuler(sway)
                .add(new Vector3(0, -h, 0)),
            );
            expectInFrame(camera, swayed, 0.97);
          }
        }
      }
    });
  }

  it('keeps the horizon in the upper part of a landscape frame', () => {
    const camera = presetCamera(1.6);
    const farAhead = camera.position.clone().add(new Vector3(0, 0, -1000));
    const ndc = farAhead.project(camera);
    expect(ndc.y).toBeGreaterThan(0.6);
    expect(ndc.y).toBeLessThan(1);
  });
});
