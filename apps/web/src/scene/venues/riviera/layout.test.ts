import { describe, expect, it } from 'vitest';
import { Box3, type Mesh, PerspectiveCamera, Raycaster, Vector3 } from 'three/webgpu';
import { BACKBOARD, GUTTER_START_Z, PLAYFIELD, PUSHER } from '@coinposh/sim/layout';
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
import { createRivieraTable, type RivieraTable } from './table.ts';

const COIN_RADIUS = 0.0135;
const COIN_THICKNESS = 0.0026;
const materials = createRivieraMaterials({ noise: createNoiseTexture(16) });

interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Bottom of the Vault plaque and top of the dock in Demo Mode, in CSS px. */
  readonly plaqueBottom: number;
  readonly dockTop: number;
  /** P-154 as amended by P-170: share of the plaque-to-dock band the playfield spans, at least. */
  readonly minPlayfieldShare: number;
  /** Lowest share of the height, from the top, at which the payout lip may sit. */
  readonly minLipDepth: number;
}

const PORTRAIT: Viewport = {
  width: 390,
  height: 844,
  plaqueBottom: 164,
  dockTop: 774,
  minPlayfieldShare: 0.55,
  minLipDepth: 0.55,
};
const LANDSCAPE: Viewport = {
  width: 844,
  height: 390,
  plaqueBottom: 137,
  dockTop: 324,
  minPlayfieldShare: 0.7,
  minLipDepth: 0.6,
};
const DESKTOP: Viewport = {
  width: 1440,
  height: 900,
  plaqueBottom: 147,
  dockTop: 830,
  minPlayfieldShare: 0.7,
  minLipDepth: 0.6,
};

/**
 * P-171: the Decorum and Cascade meters may cover at most 15 CSS px of the coin floor edge, so
 * the floor stays clear of that strip along both screen edges.
 */
const PORTRAIT_METER_STRIP = 15;

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

  it("leaves a coin's width of flat velvet behind the front moulding", () => {
    const velvet = staticMesh(table, 'table-velvet');
    const solid = table.meshes.filter((m) => m.name !== 'table-glass');
    for (const mesh of solid) mesh.updateMatrixWorld(true);
    const floorY = firstHit(velvet, new Vector3(0, -0.01, T.fieldFrontZ + 0.002), down).y;
    const run = 2 * COIN_RADIUS + 0.004;
    for (let i = 0; i <= 10; i += 1) {
      const z = T.fieldFrontZ + 0.002 + (run * i) / 10;
      for (const x of [-(T.fieldHalfWidth - COIN_RADIUS), 0, T.fieldHalfWidth - COIN_RADIUS]) {
        const hit = new Raycaster(new Vector3(x, -0.01, z), down).intersectObjects(solid, false)[0];
        expect(hit?.object.name, `first surface at x ${x}, z ${z}`).toBe('table-velvet');
        expect(hit?.point.y, `velvet height at x ${x}, z ${z}`).toBeCloseTo(floorY, 6);
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

/**
 * First row from the top, in CSS px, where any of a few columns across the backboard meets the
 * table: everything above it is deck.
 */
function crestTop(camera: PerspectiveCamera, view: Viewport, table: RivieraTable): number {
  for (const mesh of table.meshes) mesh.updateMatrixWorld(true);
  const columns = [-0.5, -0.25, 0, 0.25, 0.5].map((f) =>
    toPixels(new Vector3(f * T.fieldHalfWidth, 0, T.backboardFrontZ), camera, view),
  );
  const raycaster = new Raycaster();
  for (let y = 0; y < view.height; y += 1) {
    for (const column of columns) {
      const ndc = new Vector3(
        (column.x / view.width) * 2 - 1,
        1 - ((y + 0.5) / view.height) * 2,
        0.5,
      );
      raycaster.set(camera.position, ndc.unproject(camera).sub(camera.position).normalize());
      if (raycaster.intersectObjects([...table.meshes], false).length > 0) return y;
    }
  }
  throw new Error('no table surface anywhere down the backboard columns');
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

    it(`puts the payout lip at or below ${view.minLipDepth * 100} % of the height at ${label}`, () => {
      expect(lip / view.height).toBeGreaterThanOrEqual(view.minLipDepth);
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
      const top = crestTop(camera, view, table);
      expect(top / view.height).toBeLessThanOrEqual(0.15);
      expect(top).toBeGreaterThan(0);
    });

    it(`fills at least ${view.minPlayfieldShare * 100} % of the HUD band with the playfield at ${label}`, () => {
      const top = Math.max(crestTop(camera, view, table), view.plaqueBottom);
      const bottom = Math.min(lip, view.dockTop);
      expect((bottom - top) / band).toBeGreaterThanOrEqual(view.minPlayfieldShare);
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

  it('keeps the whole portrait coin floor on screen, clear of the slimmed side meter strips', () => {
    const camera = presetCamera(PORTRAIT.width / PORTRAIT.height);
    const floorAt = (x: number, z: number): Vector3 => {
      const behind = (T.fieldFrontZ - z) / (T.fieldFrontZ - T.backboardFrontZ);
      return toPixels(new Vector3(x, behind * T.pusherHeight, z), camera, PORTRAIT);
    };
    const steps = 64;
    const outline: Vector3[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const z = T.backboardFrontZ + ((T.fieldFrontZ - T.backboardFrontZ) * i) / steps;
      outline.push(floorAt(-T.fieldHalfWidth, z), floorAt(T.fieldHalfWidth, z));
      const x = -T.fieldHalfWidth + (2 * T.fieldHalfWidth * i) / steps;
      outline.push(floorAt(x, T.fieldFrontZ));
    }
    for (const p of outline) {
      const at = `floor at ${p.x.toFixed(0)},${p.y.toFixed(0)} px`;
      expect(p.x, at).toBeGreaterThanOrEqual(PORTRAIT_METER_STRIP);
      expect(p.x, at).toBeLessThanOrEqual(PORTRAIT.width - PORTRAIT_METER_STRIP);
    }
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

    it(`keeps the payout lip and the landing in the tray on screen on ${label}`, () => {
      const camera = presetCamera(aspect);
      const landingZ = T.fieldFrontZ + COIN_RADIUS;
      for (const point of [
        new Vector3(-T.fieldHalfWidth, 0, T.fieldFrontZ),
        new Vector3(T.fieldHalfWidth, 0, T.fieldFrontZ),
        new Vector3(-T.fieldHalfWidth, -T.trayDepth, landingZ),
        new Vector3(0, -T.trayDepth, landingZ),
        new Vector3(T.fieldHalfWidth, -T.trayDepth, landingZ),
      ]) {
        const ndc = point.clone().project(camera);
        const at = point.toArray().join(',');
        expect(Math.abs(ndc.x), `x of ${at}`).toBeLessThanOrEqual(0.98);
        expect(ndc.y, `y of ${at}`).toBeGreaterThanOrEqual(-0.95);
        expect(ndc.y, `y of ${at}`).toBeLessThanOrEqual(1);
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
