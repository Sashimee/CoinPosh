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
  COIN_FLOOR_FRONT,
  PORTRAIT_FIELD_MAX_X,
  RIVIERA_DECK,
  RIVIERA_TABLE as T,
  rivieraCameraPreset,
} from './layout.ts';
import { createRivieraMaterials } from './materials.ts';
import { createRivieraTable, TABLE_BOUNDS, type RivieraTable } from './table.ts';

const COIN_RADIUS = 0.0135;
const COIN_THICKNESS = 0.0026;
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
const DESKTOP: Viewport = { width: 1440, height: 900, plaqueBottom: 147, dockTop: 830 };

/**
 * Share of the band between the plaque and the dock that the playfield (backboard crest down to
 * the payout lip) fills. Portrait cannot reach P-154's 70 %: the frame is width-bound, so with
 * the floor's front corners inside |NDC x| <= PORTRAIT_FIELD_MAX_X the crest-to-lip height is
 * at most about 1.15 times the field width on screen, about 58 % of the band, unless the frame
 * crops the coin floor or shows more than 15 % deck above the backboard. The lead decides the
 * portrait target (P-154 follow-up); this pins what the preset reaches.
 */
const MIN_PLAYFIELD_SHARE = new Map<Viewport, number>([
  [PORTRAIT, 0.55],
  [LANDSCAPE, 0.7],
  [DESKTOP, 0.7],
]);

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

  it('carries the guide walls up to the sim wall height in glass behind the gutter start', () => {
    const glass = staticMesh(table, 'table-glass');
    for (const y of [
      T.wallHeight + 0.01,
      (T.wallHeight + PLAYFIELD.wallHeight) / 2,
      PLAYFIELD.wallHeight - 0.005,
    ]) {
      for (const z of [T.backboardFrontZ + 0.01, T.gutterStartZ - 0.01]) {
        for (const side of [-1, 1]) {
          const hit = firstHit(glass, new Vector3(0, y, z), new Vector3(side, 0, 0));
          expect(Math.abs(hit.x), `glass at y ${y}, z ${z}`).toBeCloseTo(T.fieldHalfWidth, 4);
        }
      }
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

/**
 * Share of the frame showing open sea or sky: view rays on a grid that hit neither the deck
 * inside its outline nor the stern bulwark below its top.
 */
function skyFraction(camera: PerspectiveCamera, samples = 60): number {
  const D = RIVIERA_DECK;
  let sky = 0;
  for (let i = 0; i < samples; i += 1) {
    for (let j = 0; j < samples; j += 1) {
      const ndc = new Vector3(((i + 0.5) / samples) * 2 - 1, ((j + 0.5) / samples) * 2 - 1, 0.5);
      const dir = ndc.unproject(camera).sub(camera.position).normalize();
      if (dir.y < 0) {
        const onDeck = camera.position
          .clone()
          .addScaledVector(dir, (T.deckY - camera.position.y) / dir.y);
        if (Math.abs(onDeck.x) <= D.halfWidth && onDeck.z >= D.sternZ && onDeck.z <= D.forwardZ) {
          continue;
        }
      }
      if (dir.z < 0) {
        const atStern = camera.position
          .clone()
          .addScaledVector(dir, (D.sternZ - camera.position.z) / dir.z);
        if (atStern.y <= T.deckY + D.bulwarkHeight && Math.abs(atStern.x) <= D.halfWidth) continue;
      }
      sky += 1;
    }
  }
  return sky / (samples * samples);
}

/** Highest screen point of the backboard crest, in CSS px from the top. */
function crestTop(camera: PerspectiveCamera, view: Viewport): number {
  let top = Infinity;
  for (const x of [-TABLE_BOUNDS.halfWidth, 0, TABLE_BOUNDS.halfWidth]) {
    for (const z of [TABLE_BOUNDS.backZ, T.backboardFrontZ]) {
      top = Math.min(top, toPixels(new Vector3(x, TABLE_BOUNDS.top, z), camera, view).y);
    }
  }
  return top;
}

/** Rows of the centre column below the lip whose first surface is the empty catch tray. */
function trayRows(camera: PerspectiveCamera, view: Viewport, table: RivieraTable): number {
  const solid = table.meshes.filter((m) => m.name !== 'table-glass');
  for (const mesh of solid) mesh.updateMatrixWorld(true);
  const lip = Math.ceil(toPixels(COIN_FLOOR_FRONT, camera, view).y);
  const raycaster = new Raycaster();
  let rows = 0;
  for (let y = lip; y < view.height; y += 1) {
    const ndc = new Vector3(0, 1 - ((y + 0.5) / view.height) * 2, 0.5);
    const dir = ndc.unproject(camera).sub(camera.position).normalize();
    raycaster.set(camera.position, dir);
    const hit = raycaster.intersectObjects(solid, false)[0];
    if (!hit) continue;
    const inTray = hit.point.z > T.fieldFrontZ && hit.point.z <= T.cabinetFrontZ;
    if (inTray && hit.point.y < 0) rows += 1;
  }
  return rows;
}

describe('rivieraCameraPreset', () => {
  const table = createRivieraTable(materials, false);

  for (const view of [PORTRAIT, LANDSCAPE, DESKTOP]) {
    const label = `${view.width}x${view.height}`;
    const preset = rivieraCameraPreset(view.width / view.height);
    const camera = presetCamera(view.width / view.height);
    const band = view.dockTop - view.plaqueBottom;
    const lip = toPixels(COIN_FLOOR_FRONT, camera, view).y;

    it(`keeps open sea and sky to at most 5 % of the frame at ${label}`, () => {
      expect(skyFraction(camera)).toBeLessThanOrEqual(0.05);
      const horizon = camera.position
        .clone()
        .add(new Vector3(0, 0, -1000))
        .project(camera);
      expect(horizon.y).toBeGreaterThan(0.9);
    });

    it(`puts the payout lip in the lower 40 % of the frame at ${label}`, () => {
      expect(lip / view.height).toBeGreaterThanOrEqual(0.6);
      expect(lip).toBeLessThan(view.dockTop);
    });

    it(`draws front-row coins at least 16 CSS px wide with their rims showing at ${label}`, () => {
      const z = T.fieldFrontZ - COIN_RADIUS;
      for (const x of [0, T.fieldHalfWidth - COIN_RADIUS, -(T.fieldHalfWidth - COIN_RADIUS)]) {
        const left = toPixels(new Vector3(x - COIN_RADIUS, 0, z), camera, view);
        const right = toPixels(new Vector3(x + COIN_RADIUS, 0, z), camera, view);
        expect(right.x - left.x, `coin at x ${x}`).toBeGreaterThanOrEqual(16);
        const face = toPixels(new Vector3(x, COIN_THICKNESS, z + COIN_RADIUS), camera, view);
        const foot = toPixels(new Vector3(x, 0, z + COIN_RADIUS), camera, view);
        expect(foot.y - face.y, `rim of the coin at x ${x}`).toBeGreaterThanOrEqual(1);
      }
      expect(camera.position.y).toBeGreaterThan(COIN_THICKNESS);
      expect(camera.position.z).toBeGreaterThan(T.fieldFrontZ);
    });

    it(`looks down at the table at 35 to 45 degrees at ${label}`, () => {
      const offset = preset.position.clone().sub(preset.target);
      const pitch = (Math.asin(offset.y / offset.length()) * 180) / Math.PI;
      expect(pitch).toBeGreaterThanOrEqual(35);
      expect(pitch).toBeLessThanOrEqual(45);
    });

    it(`shows at most 15 % deck above the backboard at ${label}`, () => {
      const top = crestTop(camera, view);
      expect(top / view.height).toBeLessThanOrEqual(0.15);
      expect(top).toBeGreaterThan(0);
    });

    it(`fills at least ${(MIN_PLAYFIELD_SHARE.get(view) ?? 1) * 100} % of the HUD band with the playfield at ${label}`, () => {
      const top = Math.max(crestTop(camera, view), view.plaqueBottom);
      const bottom = Math.min(lip, view.dockTop);
      expect((bottom - top) / band).toBeGreaterThanOrEqual(MIN_PLAYFIELD_SHARE.get(view) ?? 1);
    });

    it(`keeps the empty catch tray to at most 10 % of the height at ${label}`, () => {
      const rows = trayRows(camera, view, table);
      expect(rows).toBeGreaterThan(0);
      expect(rows / view.height).toBeLessThanOrEqual(0.1);
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

  for (const [label, aspect] of [
    ['1280x800', 1280 / 800],
    ['1920x1080', 1920 / 1080],
    ['1024x768', 1024 / 768],
    ['360x780', 360 / 780],
    ['430x932', 430 / 932],
    ['2560x1080', 2560 / 1080],
  ] as const) {
    it(`keeps open sea and sky to at most 5 % of the frame at ${label}`, () => {
      expect(skyFraction(presetCamera(aspect))).toBeLessThanOrEqual(0.05);
    });
  }

  for (const [label, aspect] of [
    ['desktop 16:10', 1.6],
    ['desktop 16:9', 16 / 9],
    ['tablet 4:3', 4 / 3],
  ] as const) {
    it(`keeps the coin floor and both gutters in frame on ${label}`, () => {
      const camera = presetCamera(aspect);
      const outer = T.fieldHalfWidth + T.gutterWidth;
      for (const point of [
        new Vector3(-outer, 0, T.fieldFrontZ),
        new Vector3(outer, 0, T.fieldFrontZ),
        new Vector3(-T.fieldHalfWidth, T.pusherHeight, T.backboardFrontZ),
        new Vector3(T.fieldHalfWidth, T.pusherHeight, T.backboardFrontZ),
      ]) {
        const ndc = point.clone().project(camera);
        expect(Math.abs(ndc.x), `x of ${point.toArray().join(',')}`).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.y), `y of ${point.toArray().join(',')}`).toBeLessThanOrEqual(1);
      }
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
