import { describe, expect, it } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { BACKBOARD, PLAYFIELD, PUSHER } from '../../../../../../packages/sim/src/table/layout.ts';
import { createNoiseTexture } from '../../env/noise-texture.ts';
import {
  applyCameraPreset,
  RIVIERA_SUN_DIRECTION,
  RIVIERA_TABLE as T,
  rivieraCameraPreset,
} from './layout.ts';
import { createRivieraMaterials } from './materials.ts';
import { createRivieraTable, TABLE_BOUNDS } from './table.ts';

const COIN_RADIUS = 0.0135;
const CREST = new Vector3(0, T.pusherHeight + 0.004 + T.backboardHeight + 0.034, T.backboardFrontZ);
const PAYOUT_LANDING = new Vector3(0, -0.12, T.fieldFrontZ + 0.04);

interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Bottom of the Vault plaque and top of the dock, in CSS px, as the HUD lays them out. */
  readonly plaqueBottom: number;
  readonly dockTop: number;
}

const PORTRAIT: Viewport = { width: 390, height: 844, plaqueBottom: 86, dockTop: 774 };
const LANDSCAPE: Viewport = { width: 844, height: 390, plaqueBottom: 76, dockTop: 324 };

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

describe('RIVIERA_TABLE', () => {
  it('takes every surface a coin can touch from the sim table layout', () => {
    expect(T.fieldHalfWidth).toBe(PLAYFIELD.fieldHalfWidth);
    expect(T.fieldFrontZ).toBe(PLAYFIELD.fieldFrontZ);
    expect(T.gutterWidth).toBe(PLAYFIELD.gutterWidth);
    expect(T.wallHeight + T.glassHeight).toBeCloseTo(PLAYFIELD.wallHeight, 10);
    expect(T.pusherHeight).toBe(PUSHER.height);
    expect(T.pusherFrontZ).toBe(PUSHER.frontZ);
    expect(T.pusherStroke).toBe(PUSHER.stroke);
    expect(T.pusherDepth).toBe(PUSHER.depth);
    expect(T.backboardFrontZ).toBe(BACKBOARD.frontZ);
  });

  it('keeps the fully retracted pusher inside the cabinet', () => {
    expect(T.backboardFrontZ - T.backboardDepth).toBeLessThan(T.pusherFrontZ - T.pusherDepth);
  });

  it('renders the coin floor front edge exactly where the sim drops coins off it', () => {
    const table = createRivieraTable(
      createRivieraMaterials({ noise: createNoiseTexture(16) }),
      false,
    );
    const teak = table.meshes.find((m) => m.name === 'table-teak');
    if (!teak) throw new Error('createRivieraTable no longer builds a "table-teak" coin floor');
    const floor = new Box3().setFromObject(teak);
    expect(floor.max.z).toBeCloseTo(PLAYFIELD.fieldFrontZ, 6);
    expect(floor.max.y).toBeCloseTo(0, 6);
    expect(floor.max.x).toBeCloseTo(PLAYFIELD.fieldHalfWidth, 6);
    table.setPusherStroke(1);
    expect(table.pusher.position.z).toBeCloseTo(PUSHER.stroke, 10);
  });
});

describe('rivieraCameraPreset', () => {
  for (const view of [PORTRAIT, LANDSCAPE]) {
    const label = `${view.width}x${view.height}`;
    const camera = presetCamera(view.width / view.height);
    const band = view.dockTop - view.plaqueBottom;

    it(`gives the playfield at least 55 % of the HUD band at ${label}`, () => {
      const top = Math.max(toPixels(CREST, camera, view).y, view.plaqueBottom);
      const bottom = Math.min(toPixels(PAYOUT_LANDING, camera, view).y, view.dockTop);
      expect((bottom - top) / band).toBeGreaterThanOrEqual(0.55);
    });

    it(`draws front-row coins at least 16 CSS px wide at ${label}`, () => {
      for (const x of [0, T.fieldHalfWidth - COIN_RADIUS]) {
        const z = T.fieldFrontZ - COIN_RADIUS;
        const left = toPixels(new Vector3(x - COIN_RADIUS, 0, z), camera, view);
        const right = toPixels(new Vector3(x + COIN_RADIUS, 0, z), camera, view);
        expect(right.x - left.x).toBeGreaterThanOrEqual(16);
      }
    });

    it(`keeps the coin floor, upper tier and payout between the plaque and the dock at ${label}`, () => {
      const inner = T.fieldHalfWidth + T.gutterWidth;
      const playPoints = [
        new Vector3(-inner, 0, T.fieldFrontZ),
        new Vector3(inner, 0, T.fieldFrontZ),
        new Vector3(-inner, T.pusherHeight, T.backboardFrontZ),
        new Vector3(inner, T.pusherHeight, T.backboardFrontZ),
        PAYOUT_LANDING,
      ];
      for (const point of playPoints) {
        const px = toPixels(point, camera, view);
        expect(px.y, `y of ${point.toArray().join(',')}`).toBeGreaterThan(view.plaqueBottom);
        expect(px.y, `y of ${point.toArray().join(',')}`).toBeLessThan(view.dockTop);
        expect(px.x).toBeGreaterThan(0);
        expect(px.x).toBeLessThan(view.width);
        expect(px.z).toBeLessThan(1);
      }
    });
  }

  it('keeps the portrait coin floor clear of the Decorum and Cascade meters at the edges', () => {
    const camera = presetCamera(PORTRAIT.width / PORTRAIT.height);
    const inner = T.fieldHalfWidth + T.gutterWidth;
    for (const side of [-1, 1]) {
      const ndc = new Vector3(side * inner, 0, T.fieldFrontZ).project(camera);
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(0.7 + 1e-6);
    }
  });

  const corners = [
    new Vector3(-TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, 0.1, TABLE_BOUNDS.frontZ),
    new Vector3(-TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(TABLE_BOUNDS.halfWidth, TABLE_BOUNDS.top, TABLE_BOUNDS.backZ),
    new Vector3(0, -0.04, TABLE_BOUNDS.frontZ),
    new Vector3(-TABLE_BOUNDS.halfWidth, -0.12, TABLE_BOUNDS.frontZ),
    new Vector3(TABLE_BOUNDS.halfWidth, -0.12, TABLE_BOUNDS.frontZ),
  ];

  for (const [label, aspect] of [
    ['desktop 16:10', 1.6],
    ['desktop 16:9', 16 / 9],
    ['tablet 4:3', 4 / 3],
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

  it('puts the horizon in the upper half and the sun disc inside the frame at 1280x800', () => {
    const camera = presetCamera(1280 / 800);
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

  it('returns a finite preset that looks down at the table for extreme and invalid aspects', () => {
    for (const aspect of [0.05, 0.1, 0.3, 1, 3, 4, 0, -1]) {
      const preset = rivieraCameraPreset(aspect);
      for (const value of [...preset.position.toArray(), ...preset.target.toArray(), preset.fov]) {
        expect(Number.isFinite(value), `aspect ${aspect}`).toBe(true);
      }
      expect(preset.position.y).toBeGreaterThan(preset.target.y);
      expect(preset.position.z).toBeGreaterThan(T.fieldFrontZ);
    }
  });
});
