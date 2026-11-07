import {
  BoxGeometry,
  Group,
  LatheGeometry,
  Mesh,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import {
  beadAndCoveProfile,
  halfRoundProfile,
  line,
  mergeAll,
  roundProfile,
  roundedBox,
  roundedRectPath,
  sweepProfile,
} from './geometry.ts';
import { RIVIERA_TABLE as T } from './layout.ts';
import type { RivieraMaterials } from './materials.ts';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

const FIELD_X = T.fieldHalfWidth;
const GUTTER_X = FIELD_X + T.gutterWidth;
const OUTER_X = GUTTER_X + T.wallThickness;
const WALL_X = (GUTTER_X + OUTER_X) / 2;
const BACK_Z = T.backboardFrontZ - T.backboardDepth;
const BODY_TOP = -T.gutterDepth - 0.005;
const TRAY_FLOOR = -0.12;
const PLINTH_TOP = T.deckY + 0.07;
const BOARD_BOTTOM = T.pusherHeight + 0.004;
const BOARD_TOP = BOARD_BOTTOM + T.backboardHeight;
const EMBLEM = new Vector3(0, BOARD_BOTTOM + T.backboardHeight * 0.52, T.backboardFrontZ);
const GLASS_TOP = T.wallHeight + T.glassHeight;
const GLASS_FRONT_Z = 0.3;

export interface RivieraTable {
  readonly group: Group;
  /** The pusher carriage; its local z = 0 is the fully retracted position. */
  readonly pusher: Group;
  /** Moves the pusher forward by `stroke01` of its stroke (0 = retracted, 1 = full). */
  setPusherStroke(stroke01: number): void;
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

function box(min: Vector3, max: Vector3, radius: number, segments = 3): BufferGeometry {
  const size = max.clone().sub(min);
  const centre = min.clone().add(max).multiplyScalar(0.5);
  return roundedBox(size, centre, Math.min(radius, size.x / 2, size.y / 2, size.z / 2), segments);
}

function rod(from: Vector3, to: Vector3, radius: number, up = Y): BufferGeometry {
  return sweepProfile(line(from, to), roundProfile(radius, 18), { up });
}

function ball(centre: Vector3, radius: number): BufferGeometry {
  const g = new SphereGeometry(radius, 24, 16);
  g.translate(centre.x, centre.y, centre.z);
  return g;
}

function lacquerPieces(): BufferGeometry[] {
  return [
    box(
      new Vector3(-OUTER_X - 0.01, PLINTH_TOP, BACK_Z),
      new Vector3(OUTER_X + 0.01, BODY_TOP, 0.36),
      0.022,
    ),
    box(
      new Vector3(-OUTER_X - 0.01, PLINTH_TOP, 0.33),
      new Vector3(OUTER_X + 0.01, TRAY_FLOOR, T.cabinetFrontZ),
      0.022,
    ),
    box(
      new Vector3(-GUTTER_X, TRAY_FLOOR - 0.01, T.cabinetFrontZ - 0.035),
      new Vector3(GUTTER_X, -0.035, T.cabinetFrontZ),
      0.01,
    ),
    box(
      new Vector3(-OUTER_X + 0.012, T.deckY, BACK_Z + 0.015),
      new Vector3(OUTER_X - 0.012, PLINTH_TOP + 0.01, T.cabinetFrontZ - 0.015),
      0.01,
    ),
    ...[-1, 1].map((side) =>
      box(
        new Vector3(side < 0 ? -OUTER_X : GUTTER_X, BODY_TOP - 0.01, BACK_Z),
        new Vector3(side < 0 ? -GUTTER_X : OUTER_X, T.wallHeight, T.cabinetFrontZ),
        0.012,
      ),
    ),
    box(
      new Vector3(-OUTER_X, BOARD_BOTTOM, BACK_Z),
      new Vector3(OUTER_X, BOARD_TOP, T.backboardFrontZ),
      0.016,
    ),
    box(
      new Vector3(-OUTER_X - 0.012, BOARD_TOP - 0.004, BACK_Z - 0.01),
      new Vector3(OUTER_X + 0.012, BOARD_TOP + 0.03, T.backboardFrontZ + 0.016),
      0.012,
    ),
  ];
}

function teakPieces(): BufferGeometry[] {
  return [
    box(
      new Vector3(-FIELD_X, BODY_TOP - 0.01, BACK_Z),
      new Vector3(FIELD_X, 0, T.fieldFrontZ),
      0.004,
      2,
    ),
  ];
}

function velvetPieces(): BufferGeometry[] {
  return [
    ...[-1, 1].map((side) =>
      box(
        new Vector3(side < 0 ? -GUTTER_X : FIELD_X, BODY_TOP - 0.005, BACK_Z),
        new Vector3(side < 0 ? -FIELD_X : GUTTER_X, BODY_TOP + 0.006, T.fieldFrontZ + 0.01),
        0.003,
        2,
      ),
    ),
    box(
      new Vector3(-GUTTER_X, TRAY_FLOOR - 0.005, T.fieldFrontZ - 0.01),
      new Vector3(GUTTER_X, TRAY_FLOOR + 0.008, T.cabinetFrontZ - 0.03),
      0.004,
      2,
    ),
  ];
}

function sunburstRays(): BufferGeometry[] {
  const rays: BufferGeometry[] = [];
  const count = 32;
  for (let i = 0; i < count; i += 1) {
    const long = i % 2 === 0;
    const length = long ? 0.095 : 0.07;
    const ray = new BoxGeometry(0.009, length, 0.003, 1, 4, 1);
    const pos = ray.getAttribute('position');
    for (let v = 0; v < pos.count; v += 1) {
      const t = (pos.getY(v) + length / 2) / length;
      pos.setX(v, pos.getX(v) * (1 - 0.85 * t));
      pos.setZ(v, pos.getZ(v) * (1 - 0.6 * t));
    }
    ray.computeVertexNormals();
    ray.translate(0, 0.052 + length / 2, 0.0035);
    ray.rotateZ((i / count) * Math.PI * 2);
    ray.translate(EMBLEM.x, EMBLEM.y, EMBLEM.z);
    rays.push(ray);
  }
  return rays;
}

function medallion(): BufferGeometry {
  const steps = [
    [0, 0.012],
    [0.01, 0.012],
    [0.012, 0.009],
    [0.02, 0.009],
    [0.022, 0.011],
    [0.03, 0.011],
    [0.033, 0.006],
    [0.04, 0.004],
    [0.04, 0],
  ];
  const lathe = new LatheGeometry(steps.map(([r, h]) => new Vector2(r, h)).reverse(), 48);
  lathe.rotateX(Math.PI / 2);
  lathe.translate(EMBLEM.x, EMBLEM.y, EMBLEM.z);
  return lathe;
}

function goldPieces(): BufferGeometry[] {
  const pieces: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    pieces.push(
      sweepProfile(
        line(
          new Vector3(side * WALL_X, T.wallHeight, T.cabinetFrontZ),
          new Vector3(side * WALL_X, T.wallHeight, BACK_Z),
        ),
        halfRoundProfile(T.wallThickness / 2 + 0.002, 16),
        { up: Y },
      ),
    );
    pieces.push(
      rod(
        new Vector3(side * (OUTER_X + 0.008), PLINTH_TOP, T.cabinetFrontZ + 0.008),
        new Vector3(side * (OUTER_X + 0.008), TRAY_FLOOR + 0.005, T.cabinetFrontZ + 0.008),
        0.009,
        Z,
      ),
    );
  }
  pieces.push(
    rod(
      new Vector3(-FIELD_X - T.gutterWidth, -0.0095, T.fieldFrontZ + 0.006),
      new Vector3(FIELD_X + T.gutterWidth, -0.0095, T.fieldFrontZ + 0.006),
      0.0085,
    ),
    rod(
      new Vector3(-GUTTER_X, -0.035, T.cabinetFrontZ - 0.012),
      new Vector3(GUTTER_X, -0.035, T.cabinetFrontZ - 0.012),
      0.011,
    ),
    rod(
      new Vector3(-OUTER_X - 0.012, BOARD_TOP + 0.03, T.backboardFrontZ + 0.016),
      new Vector3(OUTER_X + 0.012, BOARD_TOP + 0.03, T.backboardFrontZ + 0.016),
      0.008,
    ),
    rod(
      new Vector3(-OUTER_X - 0.012, BOARD_TOP - 0.004, T.backboardFrontZ + 0.016),
      new Vector3(OUTER_X + 0.012, BOARD_TOP - 0.004, T.backboardFrontZ + 0.016),
      0.005,
    ),
    sweepProfile(
      roundedRectPath(
        new Vector3(0, PLINTH_TOP + 0.004, (BACK_Z + T.cabinetFrontZ) / 2),
        X,
        Z,
        (OUTER_X + 0.012) * 2,
        T.cabinetFrontZ - BACK_Z + 0.004,
        0.024,
      ),
      roundProfile(0.007, 14),
      { up: Y, closed: true },
    ),
    sweepProfile(
      roundedRectPath(
        new Vector3(0, BOARD_BOTTOM + T.backboardHeight / 2, T.backboardFrontZ),
        X,
        Y,
        OUTER_X * 2 - 0.05,
        T.backboardHeight - 0.05,
        0.03,
      ),
      beadAndCoveProfile(0.016, 0.008),
      { up: Z, closed: true },
    ),
    ...sunburstRays(),
    medallion(),
  );
  const panelHeight = TRAY_FLOOR - PLINTH_TOP;
  for (const [inset, radius] of [
    [0.05, 0.0032],
    [0.068, 0.0016],
  ] as const) {
    pieces.push(
      sweepProfile(
        roundedRectPath(
          new Vector3(0, PLINTH_TOP + panelHeight / 2, T.cabinetFrontZ),
          X,
          Y,
          (OUTER_X - inset) * 2,
          panelHeight - inset * 2,
          0.028,
        ),
        halfRoundProfile(radius, 8),
        { up: Z, closed: true },
      ),
    );
  }
  return pieces;
}

function polishedGoldPieces(): BufferGeometry[] {
  const pieces: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    pieces.push(
      ball(new Vector3(side * WALL_X, T.wallHeight + 0.004, T.cabinetFrontZ + 0.002), 0.03),
    );
    pieces.push(
      ball(
        new Vector3(side * (OUTER_X + 0.008), TRAY_FLOOR + 0.012, T.cabinetFrontZ + 0.008),
        0.014,
      ),
    );
    pieces.push(
      rod(
        new Vector3(side * WALL_X, T.wallHeight + 0.02, GLASS_FRONT_Z),
        new Vector3(side * WALL_X, GLASS_TOP, GLASS_FRONT_Z),
        0.007,
        Z,
      ),
    );
    pieces.push(ball(new Vector3(side * WALL_X, GLASS_TOP + 0.006, GLASS_FRONT_Z), 0.012));
  }
  const ring = new TorusGeometry(0.047, 0.0045, 12, 64);
  ring.translate(EMBLEM.x, EMBLEM.y, EMBLEM.z + 0.006);
  pieces.push(ring);
  pieces.push(
    sweepProfile(
      roundedRectPath(
        new Vector3(0, BOARD_BOTTOM + T.backboardHeight / 2, T.backboardFrontZ),
        X,
        Y,
        OUTER_X * 2 - 0.1,
        T.backboardHeight - 0.1,
        0.02,
      ),
      halfRoundProfile(0.0035, 8),
      { up: Z, closed: true },
    ),
  );
  return pieces;
}

function glassPieces(): BufferGeometry[] {
  return [-1, 1].map((side) =>
    box(
      new Vector3(side * WALL_X - 0.003, T.wallHeight + 0.01, T.backboardFrontZ),
      new Vector3(side * WALL_X + 0.003, GLASS_TOP, GLASS_FRONT_Z),
      0.0029,
      2,
    ),
  );
}

function pusherPieces(): {
  lacquer: BufferGeometry[];
  teak: BufferGeometry[];
  gold: BufferGeometry[];
} {
  const front = T.pusherFrontZ;
  const back = front - T.pusherDepth;
  const inset = 0.004;
  return {
    lacquer: [
      box(
        new Vector3(-FIELD_X + inset, 0.0005, back),
        new Vector3(FIELD_X - inset, T.pusherHeight - 0.008, front),
        0.008,
      ),
    ],
    teak: [
      box(
        new Vector3(-FIELD_X + inset, T.pusherHeight - 0.012, back),
        new Vector3(FIELD_X - inset, T.pusherHeight, front - 0.004),
        0.003,
        2,
      ),
    ],
    gold: [
      rod(
        new Vector3(-FIELD_X + inset, T.pusherHeight - 0.006, front - 0.002),
        new Vector3(FIELD_X - inset, T.pusherHeight - 0.006, front - 0.002),
        0.006,
      ),
      box(
        new Vector3(-FIELD_X + inset + 0.002, 0.001, front - 0.004),
        new Vector3(FIELD_X - inset - 0.002, 0.02, front + 0.0015),
        0.0015,
        2,
      ),
    ],
  };
}

function mesh(geometry: BufferGeometry, material: Material, name: string, shadows: boolean): Mesh {
  const m = new Mesh(geometry, material);
  m.name = name;
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

export function createRivieraTable(materials: RivieraMaterials, shadows: boolean): RivieraTable {
  const group = new Group();
  group.name = 'riviera-table';
  const pusher = new Group();
  pusher.name = 'riviera-pusher';

  const statics = [
    mesh(mergeAll(lacquerPieces(), 'table/lacquer'), materials.lacquer, 'table-lacquer', shadows),
    mesh(mergeAll(teakPieces(), 'table/teak'), materials.teak, 'table-teak', shadows),
    mesh(mergeAll(velvetPieces(), 'table/velvet'), materials.velvet, 'table-velvet', shadows),
    mesh(mergeAll(goldPieces(), 'table/gold'), materials.gold, 'table-gold', shadows),
    mesh(
      mergeAll(polishedGoldPieces(), 'table/gold-polished'),
      materials.goldPolished,
      'table-gold-polished',
      shadows,
    ),
  ];
  const glass = mesh(mergeAll(glassPieces(), 'table/glass'), materials.glass, 'table-glass', false);
  glass.renderOrder = 2;

  const parts = pusherPieces();
  const pusherMeshes = [
    mesh(mergeAll(parts.lacquer, 'pusher/lacquer'), materials.lacquer, 'pusher-lacquer', shadows),
    mesh(mergeAll(parts.teak, 'pusher/teak'), materials.teak, 'pusher-teak', shadows),
    mesh(mergeAll(parts.gold, 'pusher/gold'), materials.gold, 'pusher-gold', shadows),
  ];
  pusher.add(...pusherMeshes);
  group.add(...statics, glass, pusher);
  const meshes = [...statics, glass, ...pusherMeshes];

  return {
    group,
    pusher,
    meshes,
    setPusherStroke(stroke01: number) {
      const k = Math.min(Math.max(stroke01, 0), 1);
      pusher.position.z = k * T.pusherStroke;
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
    },
  };
}

export const TABLE_BOUNDS = {
  halfWidth: OUTER_X + 0.012,
  frontZ: T.cabinetFrontZ + 0.032,
  backZ: BACK_Z,
  top: BOARD_TOP + 0.03,
  emblem: EMBLEM,
} as const;
