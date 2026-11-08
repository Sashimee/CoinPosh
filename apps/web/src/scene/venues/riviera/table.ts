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
import { RIVIERA_TABLE, type RivieraTableLayout } from './layout.ts';
import type { RivieraMaterials } from './materials.ts';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/** The backboard sunburst, its frames and medallion were drawn for a board this tall. */
const EMBLEM_DESIGN_HEIGHT = 0.36;
/** Depth of the catch tray's front lip, and how far its top sits down the tray, as a fraction. */
const LIP_DEPTH = 0.026;
const LIP_TOP_FRACTION = 0.3;
/** Overlap that seats the tray box under the body so no seam opens at the payout edge. */
const TRAY_SEAT = 0.03;
/** The backboard crest: a lacquer moulding under a varnished teak cap rail, as on the yacht. */
const CREST_CAP_BOTTOM = 0.014;
const CREST_TOP = 0.026;
/** The body front sits a hair behind the teak so the two never fight over one plane. */
const BODY_FRONT_INSET = 0.002;
const GLASS_THICKNESS = 0.006;
/**
 * The cabinet front under the tray is reeded lacquer between two gold beads rather than a flat
 * framed panel, so the strip a portrait camera shows below the lip reads as furniture, not as
 * an empty box. The brass plate over the tray lip, under its nosing, makes the tray itself a
 * thin brass line.
 */
const LIP_PLATE_TOP = 0.004;
const LIP_PLATE_HEIGHT = 0.018;
const LIP_PLATE_PROUD = 0.0025;
const FLUTE_PITCH = 0.016;
const FLUTE_DEPTH = 0.0075;
const FLUTE_BEAD_RADIUS = 0.0065;
const FLUTE_FOOT = 0.045;

interface Dimensions {
  readonly t: RivieraTableLayout;
  readonly fieldX: number;
  readonly gutterX: number;
  readonly outerX: number;
  readonly wallX: number;
  readonly backZ: number;
  readonly boardBackZ: number;
  readonly bodyTop: number;
  readonly trayFloor: number;
  readonly lipTop: number;
  readonly plinthTop: number;
  readonly fluteTop: number;
  readonly fluteBottom: number;
  readonly boardBottom: number;
  readonly boardTop: number;
  readonly emblem: Vector3;
  readonly emblemScale: number;
  readonly glassTop: number;
  readonly glassFrontZ: number;
}

function dimensions(t: RivieraTableLayout): Dimensions {
  const fieldX = t.fieldHalfWidth;
  const gutterX = fieldX + t.gutterWidth;
  const outerX = gutterX + t.wallThickness;
  const boardBottom = t.pusherHeight + 0.004;
  const trayFloor = -t.trayDepth;
  const lipTop = trayFloor * LIP_TOP_FRACTION;
  const plinthTop = t.deckY + 0.07;
  return {
    t,
    fieldX,
    gutterX,
    outerX,
    wallX: (gutterX + outerX) / 2,
    backZ: t.cabinetBackZ,
    boardBackZ: t.backboardFrontZ - t.backboardDepth,
    bodyTop: -t.gutterDepth - 0.005,
    trayFloor,
    lipTop,
    plinthTop,
    fluteTop: lipTop - LIP_PLATE_TOP - LIP_PLATE_HEIGHT - FLUTE_BEAD_RADIUS * 0.4,
    fluteBottom: plinthTop + FLUTE_FOOT,
    boardBottom,
    boardTop: boardBottom + t.backboardHeight,
    emblem: new Vector3(0, boardBottom + t.backboardHeight * 0.52, t.backboardFrontZ),
    emblemScale: t.backboardHeight / EMBLEM_DESIGN_HEIGHT,
    glassTop: t.wallHeight + t.glassHeight,
    glassFrontZ: t.fieldFrontZ,
  };
}

export interface RivieraTable {
  readonly group: Group;
  /** The pusher carriage; its local z = 0 is the fully retracted position. */
  readonly pusher: Group;
  /**
   * Moves the pusher forward by `stroke01` of its stroke (0 = retracted, 1 = full); finite
   * values outside 0..1 clamp, non-finite ones throw a RangeError.
   */
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

/** An elliptical reed, `halfWidth` across and standing `depth` proud of its face. */
function reedProfile(halfWidth: number, depth: number, segments = 10): Vector2[] {
  const points: Vector2[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI - (Math.PI * i) / segments;
    points.push(new Vector2(Math.cos(a) * halfWidth, Math.sin(a) * depth));
  }
  return points;
}

function reeds(d: Dimensions): BufferGeometry[] {
  const span = (d.outerX - 0.02) * 2;
  const count = Math.floor(span / FLUTE_PITCH);
  const z = d.t.cabinetFrontZ;
  const profile = reedProfile(FLUTE_PITCH / 2, FLUTE_DEPTH);
  return Array.from({ length: count }, (_, i) => {
    const x = (i - (count - 1) / 2) * FLUTE_PITCH;
    return sweepProfile(
      line(new Vector3(x, d.fluteTop, z), new Vector3(x, d.fluteBottom, z)),
      profile,
      { up: Z },
    );
  });
}

function lacquerPieces(d: Dimensions): BufferGeometry[] {
  const { t } = d;
  return [
    box(
      new Vector3(-d.outerX - 0.01, d.plinthTop, d.backZ),
      new Vector3(d.outerX + 0.01, d.bodyTop, t.fieldFrontZ - BODY_FRONT_INSET),
      0.02,
    ),
    box(
      new Vector3(-d.outerX - 0.01, d.plinthTop, t.fieldFrontZ - TRAY_SEAT),
      new Vector3(d.outerX + 0.01, d.trayFloor, t.cabinetFrontZ),
      0.02,
    ),
    box(
      new Vector3(-d.gutterX, d.trayFloor - 0.01, t.cabinetFrontZ - LIP_DEPTH),
      new Vector3(d.gutterX, d.lipTop, t.cabinetFrontZ),
      0.008,
    ),
    ...reeds(d),
    box(
      new Vector3(-d.outerX + 0.012, t.deckY, d.backZ + 0.015),
      new Vector3(d.outerX - 0.012, d.plinthTop + 0.01, t.cabinetFrontZ - 0.015),
      0.01,
    ),
    ...[-1, 1].flatMap((side) => [
      box(
        new Vector3(side < 0 ? -d.outerX : d.gutterX, d.trayFloor - 0.005, d.backZ),
        new Vector3(side < 0 ? -d.gutterX : d.outerX, t.wallHeight, t.cabinetFrontZ),
        0.01,
      ),
      box(
        new Vector3(side < 0 ? -d.gutterX - 0.004 : d.fieldX, d.bodyTop - 0.01, d.backZ),
        new Vector3(side < 0 ? -d.fieldX : d.gutterX + 0.004, t.wallHeight, t.gutterStartZ),
        0.005,
      ),
    ]),
    box(
      new Vector3(-d.outerX, d.boardBottom, d.boardBackZ),
      new Vector3(d.outerX, d.boardTop, t.backboardFrontZ),
      0.012,
    ),
    box(
      new Vector3(-d.outerX, d.bodyTop - 0.01, d.backZ),
      new Vector3(d.outerX, t.wallHeight, d.boardBackZ + 0.01),
      0.01,
    ),
    box(
      new Vector3(-d.outerX - 0.01, d.boardTop - 0.004, d.boardBackZ - 0.008),
      new Vector3(d.outerX + 0.01, d.boardTop + CREST_CAP_BOTTOM, t.backboardFrontZ + 0.013),
      0.008,
    ),
  ];
}

function teakPieces(d: Dimensions): BufferGeometry[] {
  return [
    box(
      new Vector3(-d.fieldX, d.bodyTop - 0.01, d.backZ),
      new Vector3(d.fieldX, 0, d.t.fieldFrontZ),
      0.003,
      2,
    ),
    box(
      new Vector3(-d.outerX - 0.004, d.boardTop + CREST_CAP_BOTTOM - 0.002, d.boardBackZ - 0.003),
      new Vector3(d.outerX + 0.004, d.boardTop + CREST_TOP, d.t.backboardFrontZ + 0.008),
      0.004,
      2,
    ),
  ];
}

function velvetPieces(d: Dimensions): BufferGeometry[] {
  const { t } = d;
  return [
    ...[-1, 1].map((side) =>
      box(
        new Vector3(side < 0 ? -d.gutterX : d.fieldX, d.bodyTop - 0.005, t.gutterStartZ - 0.01),
        new Vector3(side < 0 ? -d.fieldX : d.gutterX, d.bodyTop + 0.006, t.fieldFrontZ + 0.01),
        0.003,
        2,
      ),
    ),
    box(
      new Vector3(-d.gutterX, d.trayFloor - 0.005, t.fieldFrontZ - 0.01),
      new Vector3(d.gutterX, d.trayFloor + 0.006, t.cabinetFrontZ - LIP_DEPTH + 0.004),
      0.003,
      2,
    ),
  ];
}

function sunburstRays(d: Dimensions): BufferGeometry[] {
  const k = d.emblemScale;
  const rays: BufferGeometry[] = [];
  const count = 32;
  for (let i = 0; i < count; i += 1) {
    const long = i % 2 === 0;
    const length = (long ? 0.095 : 0.07) * k;
    const ray = new BoxGeometry(0.009 * k, length, 0.003 * k, 1, 4, 1);
    const pos = ray.getAttribute('position');
    for (let v = 0; v < pos.count; v += 1) {
      const s = (pos.getY(v) + length / 2) / length;
      pos.setX(v, pos.getX(v) * (1 - 0.85 * s));
      pos.setZ(v, pos.getZ(v) * (1 - 0.6 * s));
    }
    ray.computeVertexNormals();
    ray.translate(0, 0.052 * k + length / 2, 0.0035 * k);
    ray.rotateZ((i / count) * Math.PI * 2);
    ray.translate(d.emblem.x, d.emblem.y, d.emblem.z);
    rays.push(ray);
  }
  return rays;
}

function medallion(d: Dimensions): BufferGeometry {
  const steps: readonly (readonly [number, number])[] = [
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
  const k = d.emblemScale;
  const lathe = new LatheGeometry(steps.map(([r, h]) => new Vector2(r * k, h * k)).reverse(), 48);
  lathe.rotateX(Math.PI / 2);
  lathe.translate(d.emblem.x, d.emblem.y, d.emblem.z);
  return lathe;
}

function goldPieces(d: Dimensions): BufferGeometry[] {
  const { t } = d;
  const k = d.emblemScale;
  const pieces: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    pieces.push(
      sweepProfile(
        line(
          new Vector3(side * d.wallX, t.wallHeight, t.cabinetFrontZ),
          new Vector3(side * d.wallX, t.wallHeight, d.backZ),
        ),
        halfRoundProfile(t.wallThickness / 2 + 0.002, 16),
        { up: Y },
      ),
    );
    pieces.push(
      rod(
        new Vector3(side * (d.outerX + 0.007), d.plinthTop, t.cabinetFrontZ + 0.007),
        new Vector3(side * (d.outerX + 0.007), d.trayFloor + 0.004, t.cabinetFrontZ + 0.007),
        0.0075,
        Z,
      ),
    );
  }
  pieces.push(
    rod(
      new Vector3(-d.gutterX, -0.0078, t.fieldFrontZ + 0.005),
      new Vector3(d.gutterX, -0.0078, t.fieldFrontZ + 0.005),
      0.007,
    ),
    ...[t.backboardFrontZ + 0.013, d.boardBackZ - 0.008].map((z) =>
      rod(
        new Vector3(-d.outerX - 0.01, d.boardTop + CREST_CAP_BOTTOM, z),
        new Vector3(d.outerX + 0.01, d.boardTop + CREST_CAP_BOTTOM, z),
        0.0055,
      ),
    ),
    rod(
      new Vector3(-d.outerX - 0.01, d.boardTop - 0.004, t.backboardFrontZ + 0.013),
      new Vector3(d.outerX + 0.01, d.boardTop - 0.004, t.backboardFrontZ + 0.013),
      0.004,
    ),
    sweepProfile(
      roundedRectPath(
        new Vector3(0, d.plinthTop + 0.004, (d.backZ + t.cabinetFrontZ) / 2),
        X,
        Z,
        (d.outerX + 0.012) * 2,
        t.cabinetFrontZ - d.backZ + 0.004,
        0.02,
      ),
      roundProfile(0.006, 14),
      { up: Y, closed: true },
    ),
    sweepProfile(
      roundedRectPath(
        new Vector3(0, d.boardBottom + t.backboardHeight / 2, t.backboardFrontZ),
        X,
        Y,
        d.outerX * 2 - 0.05 * k,
        t.backboardHeight - 0.05 * k,
        0.03 * k,
      ),
      beadAndCoveProfile(0.016 * k, 0.008 * k),
      { up: Z, closed: true },
    ),
    ...sunburstRays(d),
    medallion(d),
  );
  pieces.push(
    box(
      new Vector3(-d.gutterX, d.lipTop - LIP_PLATE_TOP - LIP_PLATE_HEIGHT, t.cabinetFrontZ - 0.001),
      new Vector3(d.gutterX, d.lipTop - LIP_PLATE_TOP, t.cabinetFrontZ + LIP_PLATE_PROUD),
      0.0012,
      2,
    ),
    ...[d.fluteTop, d.fluteBottom].map((y) =>
      rod(
        new Vector3(-d.outerX - 0.002, y, t.cabinetFrontZ + 0.002),
        new Vector3(d.outerX + 0.002, y, t.cabinetFrontZ + 0.002),
        FLUTE_BEAD_RADIUS,
      ),
    ),
  );
  return pieces;
}

function polishedGoldPieces(d: Dimensions): BufferGeometry[] {
  const { t } = d;
  const k = d.emblemScale;
  const pieces: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    pieces.push(
      ball(new Vector3(side * d.wallX, t.wallHeight + 0.004, t.cabinetFrontZ + 0.002), 0.022),
      ball(
        new Vector3(side * (d.outerX + 0.007), d.trayFloor + 0.01, t.cabinetFrontZ + 0.007),
        0.011,
      ),
      rod(
        new Vector3(side * d.wallX, t.wallHeight + 0.016, d.glassFrontZ),
        new Vector3(side * d.wallX, d.glassTop, d.glassFrontZ),
        0.0055,
        Z,
      ),
      ball(new Vector3(side * d.wallX, d.glassTop + 0.005, d.glassFrontZ), 0.0095),
      rod(
        new Vector3(side * (d.fieldX + 0.0035), t.wallHeight, t.backboardFrontZ),
        new Vector3(side * (d.fieldX + 0.0035), t.wallHeight, t.gutterStartZ - 0.004),
        0.0035,
        Z,
      ),
      ball(new Vector3(side * (d.fieldX + 0.0035), t.wallHeight, t.gutterStartZ - 0.004), 0.0062),
      rod(
        new Vector3(side * (d.fieldX + 0.0045), t.wallHeight, t.gutterStartZ),
        new Vector3(side * (d.fieldX + 0.0045), d.glassTop, t.gutterStartZ),
        0.0045,
        Z,
      ),
      ball(new Vector3(side * (d.fieldX + 0.0045), d.glassTop + 0.004, t.gutterStartZ), 0.008),
    );
  }
  pieces.push(
    rod(
      new Vector3(-d.gutterX, d.lipTop, t.cabinetFrontZ - LIP_DEPTH * 0.35),
      new Vector3(d.gutterX, d.lipTop, t.cabinetFrontZ - LIP_DEPTH * 0.35),
      0.009,
    ),
  );
  const ring = new TorusGeometry(0.047 * k, 0.0045 * k, 12, 64);
  ring.translate(d.emblem.x, d.emblem.y, d.emblem.z + 0.006 * k);
  pieces.push(ring);
  pieces.push(
    sweepProfile(
      roundedRectPath(
        new Vector3(0, d.boardBottom + t.backboardHeight / 2, t.backboardFrontZ),
        X,
        Y,
        d.outerX * 2 - 0.1 * k,
        t.backboardHeight - 0.1 * k,
        0.02 * k,
      ),
      halfRoundProfile(0.0035 * k, 8),
      { up: Z, closed: true },
    ),
  );
  return pieces;
}

/**
 * The glass carries every sim wall up to its full height: over the guide walls at
 * ±fieldHalfWidth behind the gutter start, and over the outer walls ahead of it.
 */
function glassPieces(d: Dimensions): BufferGeometry[] {
  const { t } = d;
  return [-1, 1].flatMap((side) => [
    box(
      new Vector3(
        side < 0 ? -d.fieldX - GLASS_THICKNESS : d.fieldX,
        t.wallHeight + 0.004,
        t.backboardFrontZ,
      ),
      new Vector3(side < 0 ? -d.fieldX : d.fieldX + GLASS_THICKNESS, d.glassTop, t.gutterStartZ),
      0.0029,
      2,
    ),
    box(
      new Vector3(side * d.wallX - GLASS_THICKNESS / 2, t.wallHeight + 0.008, t.gutterStartZ),
      new Vector3(side * d.wallX + GLASS_THICKNESS / 2, d.glassTop, d.glassFrontZ),
      0.0029,
      2,
    ),
  ]);
}

function pusherPieces(d: Dimensions): {
  lacquer: BufferGeometry[];
  teak: BufferGeometry[];
  gold: BufferGeometry[];
} {
  const { t, fieldX } = d;
  const front = t.pusherFrontZ;
  const back = front - t.pusherDepth;
  const inset = 0.004;
  return {
    lacquer: [
      box(
        new Vector3(-fieldX + inset, 0.0005, back),
        new Vector3(fieldX - inset, t.pusherHeight - 0.008, front),
        0.008,
      ),
    ],
    teak: [
      box(
        new Vector3(-fieldX + inset, t.pusherHeight - 0.012, back),
        new Vector3(fieldX - inset, t.pusherHeight, front - 0.004),
        0.003,
        2,
      ),
    ],
    gold: [
      rod(
        new Vector3(-fieldX + inset, t.pusherHeight - 0.006, front - 0.002),
        new Vector3(fieldX - inset, t.pusherHeight - 0.006, front - 0.002),
        0.006,
      ),
      box(
        new Vector3(-fieldX + inset + 0.002, 0.001, front - 0.004),
        new Vector3(fieldX - inset - 0.002, 0.016, front + 0.0015),
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

/**
 * Builds the cabinet around `layout` (the Riviera table unless a test reshapes it): every
 * position, from the payout edge and tray to the glass and guide walls, derives from it.
 */
export function createRivieraTable(
  materials: RivieraMaterials,
  shadows: boolean,
  layout: RivieraTableLayout = RIVIERA_TABLE,
): RivieraTable {
  const d = dimensions(layout);
  const group = new Group();
  group.name = 'riviera-table';
  const pusher = new Group();
  pusher.name = 'riviera-pusher';

  const statics = [
    mesh(mergeAll(lacquerPieces(d), 'table/lacquer'), materials.lacquer, 'table-lacquer', shadows),
    mesh(mergeAll(teakPieces(d), 'table/teak'), materials.teak, 'table-teak', shadows),
    mesh(mergeAll(velvetPieces(d), 'table/velvet'), materials.velvet, 'table-velvet', shadows),
    mesh(mergeAll(goldPieces(d), 'table/gold'), materials.gold, 'table-gold', shadows),
    mesh(
      mergeAll(polishedGoldPieces(d), 'table/gold-polished'),
      materials.goldPolished,
      'table-gold-polished',
      shadows,
    ),
  ];
  const glass = mesh(
    mergeAll(glassPieces(d), 'table/glass'),
    materials.glass,
    'table-glass',
    false,
  );
  glass.renderOrder = 2;

  const parts = pusherPieces(d);
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
      if (!Number.isFinite(stroke01)) {
        throw new RangeError(`Pusher stroke must be a finite number, got ${stroke01}`);
      }
      const k = Math.min(Math.max(stroke01, 0), 1);
      pusher.position.z = k * layout.pusherStroke;
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
    },
  };
}

const RIVIERA = dimensions(RIVIERA_TABLE);

export const TABLE_BOUNDS = {
  halfWidth: RIVIERA.outerX + 0.012,
  frontZ: RIVIERA_TABLE.cabinetFrontZ + 0.03,
  backZ: RIVIERA.backZ,
  top: RIVIERA.boardTop + CREST_TOP,
  trayFloor: RIVIERA.trayFloor,
  emblem: RIVIERA.emblem,
} as const;
