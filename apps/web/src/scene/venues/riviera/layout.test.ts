import { describe, expect, it } from 'vitest';
import { Box3, type Mesh, PerspectiveCamera, Raycaster, Vector3 } from 'three/webgpu';
import {
  BACKBOARD,
  GUTTER_START_Z,
  PLAYFIELD,
  PUSHER,
} from '../../../../../../packages/sim/src/table/layout.ts';
import { createNoiseTexture } from '../../env/noise-texture.ts';
import {
  applyCameraPreset,
  PLAYFIELD_FRONT,
  PLAYFIELD_TOP,
  PORTRAIT_FIELD_MAX_X,
  RIVIERA_SUN_DIRECTION,
  RIVIERA_TABLE as T,
  rivieraCameraPreset,
} from './layout.ts';
import { createRivieraMaterials } from './materials.ts';
import { createRivieraTable, TABLE_BOUNDS, type RivieraTable } from './table.ts';

const COIN_RADIUS = 0.0135;
const materials = createRivieraMaterials({ noise: createNoiseTexture(16) });

interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Bottom of the Vault plaque and top of the dock in Demo Mode, in CSS px. */
  readonly plaqueBottom: number;
  readonly dockTop: number;
}

const PORTRAIT: Viewport = { width: 390, height: 844, plaqueBottom: 164, dockTop: 774 };
const LANDSCAPE: Viewport = { width: 844, height: 390, plaqueBottom: 137, dockTop: 324 };

/**
 * Share of the band between the plaque and the dock that the play area (top of the sim's back
 * wall down to the payout edge) fills. Portrait stops short of the 55 % P-99 asked for: with the
 * coin floor held inside |NDC x| <= PORTRAIT_FIELD_MAX_X for the side meters, no pitch or field
 * of view gets past about 47 %; see the P-115 report.
 */
const MIN_PLAY_SHARE = { portrait: 0.43, landscape: 0.55 } as const;

function presetCamera(aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, aspect, 0.05, 2000);
  applyCameraPreset(camera, rivieraCameraPreset(aspect));
  camera.updateMatrixWorld();
  return camera;
}

function toPixels(point: Vector3, camera: PerspectiveCamera, view: Viewport): Vector3 {
  const ndc = point.clone().project(camera);
  return new Vector3(((ndc.x + 1) / 2) * view.width, ((1 - ndc.y) / 2) * view.height, ndc.z);
}

function staticMesh(table: RivieraTable, name: string): Mesh {
  const found = table.meshes.find((m) => m.name === name);
  if (!found) throw new Error(`createRivieraTable no longer builds a "${name}" mesh`);
  return found;
}

function firstHit(mesh: Mesh, origin: Vector3, direction: Vector3): Vector3 {
  mesh.updateMatrixWorld(true);
  const hits = new Raycaster(origin, direction.clone().normalize()).intersectObject(mesh, false);
  const hit = hits[0];
  if (!hit)
    throw new Error(`no ${mesh.name} surface along the ray from ${origin.toArray().join(',')}`);
  return hit.point;
}

describe('RIVIERA_TABLE', () => {
  it('takes every surface a coin can touch from the sim table layout', () => {
    expect(T.fieldHalfWidth).toBe(PLAYFIELD.fieldHalfWidth);
    expect(T.fieldFrontZ).toBe(PLAYFIELD.fieldFrontZ);
    expect(T.gutterWidth).toBe(PLAYFIELD.gutterWidth);
    expect(T.gutterStartZ).toBe(GUTTER_START_Z);
    expect(T.wallHeight + T.glassHeight).toBeCloseTo(PLAYFIELD.wallHeight, 10);
    expect(T.pusherHeight).toBe(PUSHER.height);
    expect(T.pusherFrontZ).toBe(PUSHER.frontZ);
    expect(T.pusherStroke).toBe(PUSHER.stroke);
    expect(T.pusherDepth).toBe(PUSHER.depth);
    expect(T.backboardFrontZ).toBe(BACKBOARD.frontZ);
  });

  it('keeps the fully retracted pusher inside the cabinet', () => {
    expect(T.cabinetBackZ).toBeLessThan(T.pusherFrontZ - T.pusherDepth);
  });

  it('raises the backboard face to the top of the sim back wall', () => {
    expect(T.pusherHeight + T.backboardHeight).toBeGreaterThanOrEqual(PLAYFIELD.wallHeight);
  });

  it('puts the catch tray ahead of the payout edge', () => {
    expect(T.cabinetFrontZ).toBeGreaterThan(T.fieldFrontZ + 2 * COIN_RADIUS);
  });
});

describe('createRivieraTable on the sim layout', () => {
  const table = createRivieraTable(materials, false);
  const teak = staticMesh(table, 'table-teak');
  const lacquer = staticMesh(table, 'table-lacquer');
  const down = new Vector3(0, -1, 0);

  it('renders the coin floor front edge exactly where the sim drops coins off it', () => {
    const onFloor = firstHit(teak, new Vector3(0, 0.1, T.fieldFrontZ - 0.01), down);
    expect(onFloor.y).toBeCloseTo(0, 6);
    const floor = new Box3().setFromObject(teak);
    expect(floor.max.z).toBeCloseTo(PLAYFIELD.fieldFrontZ, 6);
    const pastEdge = new Raycaster(new Vector3(0, 0.1, T.fieldFrontZ + 0.002), down);
    const below = pastEdge.intersectObject(teak, false).filter((h) => h.point.y > -0.01);
    expect(below).toHaveLength(0);
  });

  it('walls the coin floor in at ±fieldHalfWidth behind the gutter start', () => {
    const y = T.pusherHeight + 0.02;
    for (const side of [-1, 1]) {
      const outward = new Vector3(side, 0, 0);
      const behind = firstHit(lacquer, new Vector3(0, y, T.gutterStartZ - 0.1), outward);
      expect(Math.abs(behind.x)).toBeCloseTo(T.fieldHalfWidth, 4);
      const ahead = firstHit(lacquer, new Vector3(0, y, T.gutterStartZ + 0.02), outward);
      expect(Math.abs(ahead.x)).toBeCloseTo(T.fieldHalfWidth + T.gutterWidth, 4);
    }
  });

  it('moves the body front and the tray with cabinetFrontZ', () => {
    const shift = 0.05;
    const moved = createRivieraTable(materials, false, {
      ...T,
      cabinetFrontZ: T.cabinetFrontZ + shift,
    });
    for (const name of ['table-lacquer', 'table-velvet']) {
      const before = new Box3().setFromObject(staticMesh(table, name));
      const after = new Box3().setFromObject(staticMesh(moved, name));
      expect(after.max.z - before.max.z, name).toBeCloseTo(shift, 6);
    }
    const trayBefore = firstHit(
      staticMesh(table, 'table-velvet'),
      new Vector3(0, 0.1, T.cabinetFrontZ - 0.04),
      down,
    );
    const trayAfter = firstHit(
      staticMesh(moved, 'table-velvet'),
      new Vector3(0, 0.1, T.cabinetFrontZ + shift - 0.04),
      down,
    );
    expect(trayAfter.y).toBeCloseTo(trayBefore.y, 6);
    const floor = new Box3().setFromObject(staticMesh(moved, 'table-teak'));
    expect(floor.max.z).toBeCloseTo(PLAYFIELD.fieldFrontZ, 6);
    moved.dispose();
  });
});

describe('rivieraCameraPreset', () => {
  for (const [orientation, view] of [
    ['portrait', PORTRAIT],
    ['landscape', LANDSCAPE],
  ] as const) {
    const label = `${view.width}x${view.height}`;
    const camera = presetCamera(view.width / view.height);
    const band = view.dockTop - view.plaqueBottom;

    it(`gives the play area at least ${MIN_PLAY_SHARE[orientation] * 100} % of the HUD band at ${label}`, () => {
      const top = Math.max(toPixels(PLAYFIELD_TOP, camera, view).y, view.plaqueBottom);
      const bottom = Math.min(toPixels(PLAYFIELD_FRONT, camera, view).y, view.dockTop);
      expect((bottom - top) / band).toBeGreaterThanOrEqual(MIN_PLAY_SHARE[orientation]);
    });

    it(`draws front-row coins at least 16 CSS px wide at ${label}`, () => {
      for (const x of [0, T.fieldHalfWidth - COIN_RADIUS]) {
        const z = T.fieldFrontZ - COIN_RADIUS;
        const left = toPixels(new Vector3(x - COIN_RADIUS, 0, z), camera, view);
        const right = toPixels(new Vector3(x + COIN_RADIUS, 0, z), camera, view);
        expect(right.x - left.x).toBeGreaterThanOrEqual(16);
      }
    });

    it(`keeps the coin floor between the plaque and the dock at ${label}`, () => {
      for (const side of [-1, 1]) {
        for (const point of [
          new Vector3(side * T.fieldHalfWidth, 0, T.fieldFrontZ),
          new Vector3(side * T.fieldHalfWidth, T.pusherHeight, T.backboardFrontZ),
        ]) {
          const px = toPixels(point, camera, view);
          const at = point.toArray().join(',');
          expect(px.y, `y of ${at}`).toBeGreaterThan(view.plaqueBottom);
          expect(px.y, `y of ${at}`).toBeLessThan(view.dockTop);
          expect(px.x, `x of ${at}`).toBeGreaterThan(0);
          expect(px.x, `x of ${at}`).toBeLessThan(view.width);
          expect(px.z).toBeLessThan(1);
        }
      }
    });
  }

  it('keeps the portrait coin floor clear of the Decorum and Cascade meters at the edges', () => {
    const camera = presetCamera(PORTRAIT.width / PORTRAIT.height);
    for (const side of [-1, 1]) {
      for (const z of [T.fieldFrontZ, T.backboardFrontZ]) {
        const ndc = new Vector3(side * T.fieldHalfWidth, 0, z).project(camera);
        expect(Math.abs(ndc.x)).toBeLessThanOrEqual(PORTRAIT_FIELD_MAX_X + 1e-6);
      }
    }
  });

  const corners = [
    new Vector3(-TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(-TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(0, TABLE_BOUNDS.trayFloor, TABLE_BOUNDS.frontZ),
    new Vector3(-TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.trayFloor, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.trayFloor, TABLE_BOUNDS.frontZ),
  ];

  for (const [label, aspect] of [
    ['desktop 16:10', 1.6],
    ['desktop 16:9', 16 / 9],
    ['tablet 4:3', 4 / 3],
  ] as const) {
    it(`keeps the playfield, tray, finials and backboard in frame on ${label}`, () => {
      const camera = presetCamera(aspect);
      for (const corner of corners) {
        const ndc = corner.clone().project(camera);
        expect(Math.abs(ndc.x), `x of ${corner.toArray().join(',')}`).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.y), `y of ${corner.toArray().join(',')}`).toBeLessThanOrEqual(1);
      }
    });
  }

  for (const [label, aspect] of [
    ['1280x800', 1280 / 800],
    ['1920x1080', 1920 / 1080],
    ['1024x768', 1024 / 768],
  ] as const) {
    it(`shows the horizon and the sun above the backboard crest at ${label}`, () => {
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

      let crestTop = -Infinity;
      for (const x of [-TABLE_BOUNDS.halfWidth, 0, TABLE_BOUNDS.halfWidth]) {
        for (const z of [TABLE_BOUNDS.backZ, T.backboardFrontZ]) {
          crestTop = Math.max(crestTop, new Vector3(x, TABLE_BOUNDS.top, z).project(camera).y);
        }
      }
      expect(crestTop, 'backboard crest stays below the horizon').toBeLessThan(horizon.y);
      const sunRadiusNdc =
        Math.tan((0.62 * Math.PI) / 180) / Math.tan((camera.fov * Math.PI) / 360);
      expect(sunOnDome.y - sunRadiusNdc, 'sun disc clears the backboard crest').toBeGreaterThan(
        crestTop,
      );
    });
  }

  it('returns a finite preset that looks down at the table for extreme and invalid aspects', () => {
    for (const aspect of [0.05, 0.1, 0.3, 1, 3, 4, 0, -1, Number.NaN, Infinity]) {
      const preset = rivieraCameraPreset(aspect);
      for (const value of [...preset.position.toArray(), ...preset.target.toArray(), preset.fov]) {
        expect(Number.isFinite(value), `aspect ${aspect}`).toBe(true);
      }
      expect(preset.position.y).toBeGreaterThan(preset.target.y);
      expect(preset.position.z).toBeGreaterThan(T.fieldFrontZ);
    }
  });
});
