import type { BossKind } from '@coinposh/shared';
import {
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The surface each vertex of a figure is shaded as, in the `bossPart` attribute, so every part
 * of a figure draws with one material and one pipeline.
 */
export const BossPart = {
  cloth: 0,
  satin: 1,
  shirt: 2,
  porcelain: 3,
  hair: 4,
  lacquer: 5,
  gold: 6,
  lens: 7,
  leather: 8,
  paper: 9,
} as const;

export type BossPartId = (typeof BossPart)[keyof typeof BossPart];

const ATTRIBUTES = 'bossPart,normal,position,uv';

type Triple = readonly [number, number, number];

const matrix = new Matrix4();
const turn = new Quaternion();
const euler = new Euler();
const place = new Vector3();
const size = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Scales, turns (YXZ) and places `geometry`, tagged as one surface; non-indexed, owns its data. */
function piece(
  geometry: BufferGeometry,
  part: BossPartId,
  at: Triple = [0, 0, 0],
  rotation: Triple = [0, 0, 0],
  scale: Triple = [1, 1, 1],
): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') flat.deleteAttribute(name);
  }
  const count = flat.getAttribute('position').count;
  flat.setAttribute('bossPart', new BufferAttribute(new Float32Array(count).fill(part), 1));
  euler.set(rotation[0], rotation[1], rotation[2], 'YXZ');
  matrix.compose(place.set(...at), turn.setFromEuler(euler), size.set(...scale));
  flat.applyMatrix4(matrix);
  return flat;
}

/** A capsule of `radius` from `a` to `b`. */
function limb(part: BossPartId, a: Vector3, b: Vector3, radius: number): BufferGeometry {
  const axis = b.clone().sub(a);
  const flat = piece(new CapsuleGeometry(radius, axis.length(), 4, 12), part);
  turn.setFromUnitVectors(UP, axis.clone().normalize());
  matrix.compose(a.clone().add(b).multiplyScalar(0.5), turn, size.setScalar(1));
  flat.applyMatrix4(matrix);
  return flat;
}

function tube(part: BossPartId, points: readonly Triple[], radius: number, segments = 24) {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
  return piece(new TubeGeometry(curve, segments, radius, 6, false), part);
}

function lathe(profile: readonly (readonly [number, number])[], segments = 32): BufferGeometry {
  return new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, y)),
    segments,
  );
}

/** A flat outline in XY extruded `depth` towards +Z with a soft bevel. */
function plate(outline: readonly (readonly [number, number])[], depth: number, bevel: number) {
  const shape = new Shape(outline.map(([x, y]) => new Vector2(x, y)));
  return new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
}

function sphere(radius: number, w = 20, h = 14): SphereGeometry {
  return new SphereGeometry(radius, w, h);
}

function merge(parts: BufferGeometry[], name: string, origin: Vector3): BufferGeometry {
  for (const part of parts) {
    const names = Object.keys(part.attributes).sort().join(',');
    if (part.index || names !== ATTRIBUTES)
      throw new Error(`Boss ${name} has a part with attributes ${names}, not ${ATTRIBUTES}`);
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.translate(-origin.x, -origin.y, -origin.z);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.name = name;
  return merged;
}

/**
 * Figure proportions in metres, in the figure's own frame: the waist at the origin, +Y up, the
 * figure facing +Z (the player). The figures are tabletop automata, small enough to peek over
 * the backboard, so the head is large for the body, the way a figurine reads from afar.
 */
export const FIGURE = {
  shoulder: new Vector3(0.056, 0.074, -0.004),
  neck: new Vector3(0, 0.104, 0),
  head: { y: 0.131, radius: 0.027 },
  hatSeat: new Vector3(0, 0.153, -0.003),
  eye: { x: 0.0098, y: 0.134, z: 0.0232 },
  /** The prop arm swings on the figure's right shoulder (the player's left, -X). */
  propSide: -1,
} as const;

/** The head, hat, prop arm and monocle pivots, each relative to its parent. */
export interface FigurePivots {
  /** Neck in the torso frame. */
  readonly neck: Vector3;
  /** Hat seat in the head frame. */
  readonly hat: Vector3;
  /** Prop shoulder in the torso frame. */
  readonly shoulder: Vector3;
  /** Monocle in the head frame, or null for a figure without one. */
  readonly monocle: Vector3 | null;
}

export interface FigureGeometry {
  readonly torso: BufferGeometry;
  readonly head: BufferGeometry;
  readonly hat: BufferGeometry;
  readonly arm: BufferGeometry;
  readonly monocle: BufferGeometry | null;
  readonly pivots: FigurePivots;
}

const P = BossPart;

function torsoParts(kind: BossKind): BufferGeometry[] {
  const inspector = kind === 'taxInspector';
  const s = -FIGURE.propSide;
  const body = piece(
    lathe(
      [
        [0, -0.07],
        [0.034, -0.07],
        [0.036, -0.02],
        [0.039, 0.02],
        [0.0425, 0.05],
        [0.0425, 0.066],
        [0.038, 0.079],
        [0.026, 0.0885],
        [0.013, 0.093],
        [0, 0.094],
      ],
      36,
    ),
    P.cloth,
    [0, 0, 0],
    [0, 0, 0],
    [1.42, 1, 0.8],
  );
  const parts = [
    body,
    piece(sphere(0.03, 20, 14), P.shirt, [0, 0.066, 0.0245], [0.12, 0, 0], [0.5, 1, 0.34]),
    piece(
      lathe(
        [
          [0.0128, 0.086],
          [0.0142, 0.089],
          [0.0142, inspector ? 0.1015 : 0.098],
          [0.0122, inspector ? 0.102 : 0.0985],
        ],
        20,
      ),
      P.shirt,
    ),
    piece(new CylinderGeometry(0.0102, 0.0112, 0.03, 16, 1, true), P.porcelain, [0, 0.1, 0]),
  ];
  for (const side of [-1, 1]) {
    const lapel: readonly (readonly [number, number])[] = inspector
      ? [
          [0.0, 0.0],
          [0.012, 0.042],
          [0.022, 0.033],
          [0.026, 0.038],
          [0.016, 0.017],
        ]
      : [
          [0.0, 0.0],
          [0.012, 0.043],
          [0.024, 0.036],
          [0.026, 0.02],
        ];
    const shape = plate(
      lapel.map(([x, y]) => [x * side, y] as const),
      0.0012,
      0.0008,
    );
    parts.push(piece(shape, P.satin, [0, 0.047, 0.0318], [0.16, -side * 0.34, 0]));
  }
  if (inspector) {
    parts.push(
      piece(
        plate(
          [
            [0, 0.044],
            [0.0036, 0.039],
            [0.0048, 0.004],
            [0, -0.002],
            [-0.0048, 0.004],
            [-0.0036, 0.039],
          ],
          0.0012,
          0.0006,
        ),
        P.satin,
        [0, 0.05, 0.0335],
        [0.14, 0, 0],
      ),
      piece(sphere(0.0034, 10, 8), P.satin, [0, 0.0915, 0.0322], [0, 0, 0], [1.1, 0.9, 0.7]),
      piece(
        new CylinderGeometry(0.0007, 0.0007, 0.014, 6),
        P.gold,
        [0, 0.068, 0.0378],
        [0, 0, Math.PI / 2],
      ),
    );
  } else {
    for (const side of [-1, 1]) {
      parts.push(
        piece(
          new CylinderGeometry(0.0006, 0.0046, 0.0085, 10),
          P.satin,
          [side * 0.0046, 0.0905, 0.0318],
          [0, 0, (-side * Math.PI) / 2],
          [1, 1, 0.6],
        ),
      );
    }
    parts.push(
      piece(sphere(0.0024, 10, 8), P.satin, [0, 0.0905, 0.0338]),
      piece(sphere(0.0019, 8, 6), P.gold, [0, 0.077, 0.0348]),
      piece(sphere(0.0019, 8, 6), P.gold, [0, 0.064, 0.0352]),
      tube(
        P.gold,
        [
          [0, 0.056, 0.0352],
          [s * 0.012, 0.05, 0.0362],
          [s * 0.026, 0.054, 0.0338],
        ],
        0.0007,
        16,
      ),
    );
  }

  const shoulder = new Vector3(s * FIGURE.shoulder.x, FIGURE.shoulder.y, FIGURE.shoulder.z);
  const elbow = new Vector3(s * 0.066, 0.026, 0.012);
  const hand = inspector ? new Vector3(s * 0.03, 0.052, 0.05) : new Vector3(s * 0.024, 0.04, 0.042);
  parts.push(
    limb(P.cloth, shoulder, elbow, 0.0128),
    limb(P.cloth, elbow, hand, 0.011),
    piece(
      sphere(0.0118, 14, 10),
      P.shirt,
      hand.clone().lerp(elbow, 0.08).toArray(),
      [0, 0, 0],
      [1, 0.82, 0.94],
    ),
    piece(sphere(0.0098, 14, 10), P.porcelain, hand.toArray(), [0, 0, 0], [1, 0.82, 1.1]),
  );
  if (inspector) {
    const ledger: Triple = [s * 0.015, 0.064, 0.058];
    const tilt: Triple = [-0.95, s * 0.28, s * 0.12];
    parts.push(
      piece(new BoxGeometry(0.05, 0.012, 0.064, 1, 1, 1), P.leather, ledger, tilt),
      piece(new BoxGeometry(0.046, 0.007, 0.059, 1, 1, 1), P.paper, ledger, tilt).translate(
        0,
        0.0035,
        0.0025,
      ),
    );
  }
  return parts;
}

function headParts(kind: BossKind): BufferGeometry[] {
  const inspector = kind === 'taxInspector';
  const { y, radius } = FIGURE.head;
  const { eye } = FIGURE;
  const parts = [
    piece(sphere(radius, 28, 20), P.porcelain, [0, y, 0.002], [0, 0, 0], [0.9, 1.08, 0.97]),
    piece(
      sphere(0.0058, 12, 10),
      P.porcelain,
      [0, y - 0.003, radius * 0.93],
      [0.25, 0, 0],
      [0.75, 1, 1.25],
    ),
  ];
  for (const side of [-1, 1]) {
    parts.push(
      piece(
        sphere(0.0065, 10, 8),
        P.porcelain,
        [side * radius * 0.86, y - 0.001, -0.001],
        [0, 0, 0],
        [0.45, 1, 0.75],
      ),
    );
  }
  const brow = (side: number, lift: number, arch: number): BufferGeometry =>
    tube(
      P.hair,
      [
        [side * 0.004, eye.y + 0.0085 + lift, eye.z + 0.0018],
        [side * 0.0098, eye.y + 0.0102 + lift + arch, eye.z + 0.0002],
        [side * 0.0158, eye.y + 0.0078 + lift, eye.z - 0.004],
      ],
      inspector ? 0.0011 : 0.0017,
      10,
    );
  if (inspector) {
    for (const side of [-1, 1]) {
      const at: Triple = [side * eye.x, eye.y, eye.z + 0.0012];
      parts.push(
        piece(new TorusGeometry(0.0074, 0.00095, 6, 24), P.gold, at),
        piece(new CylinderGeometry(0.0071, 0.0071, 0.0009, 24), P.lens, at, [Math.PI / 2, 0, 0]),
        tube(
          P.gold,
          [
            [side * (eye.x + 0.0073), eye.y + 0.0004, eye.z + 0.0008],
            [side * 0.0222, eye.y + 0.001, eye.z - 0.012],
            [side * 0.0236, eye.y - 0.0005, -0.004],
          ],
          0.0006,
          10,
        ),
        brow(side, 0.0004, 0.0012),
      );
    }
    parts.push(
      tube(
        P.gold,
        [
          [-0.0026, eye.y + 0.0006, eye.z + 0.0018],
          [0, eye.y + 0.0018, eye.z + 0.0026],
          [0.0026, eye.y + 0.0006, eye.z + 0.0018],
        ],
        0.0006,
        8,
      ),
      tube(
        P.hair,
        [
          [-0.0088, y - 0.0102, 0.0222],
          [-0.004, y - 0.0088, 0.0262],
          [0, y - 0.0091, 0.0272],
          [0.004, y - 0.0088, 0.0262],
          [0.0088, y - 0.0102, 0.0222],
        ],
        0.0011,
        16,
      ),
      piece(
        sphere(radius * 1.01, 24, 10),
        P.hair,
        [0, y + 0.002, -0.0035],
        [-0.35, 0, 0],
        [0.93, 0.62, 0.95],
      ),
    );
  } else {
    const squint = 1;
    parts.push(
      brow(-1, 0.0014, 0.0016),
      brow(1, 0.0006, 0.0022),
      tube(
        P.hair,
        [
          [squint * (eye.x - 0.0048), eye.y - 0.0006, eye.z + 0.0005],
          [squint * eye.x, eye.y - 0.0018, eye.z + 0.0012],
          [squint * (eye.x + 0.0048), eye.y - 0.0004, eye.z - 0.001],
        ],
        0.0009,
        10,
      ),
      tube(
        P.hair,
        [
          [-0.0215, y - 0.0005, 0.0128],
          [-0.0152, y - 0.0135, 0.0226],
          [-0.0058, y - 0.0094, 0.0282],
          [0, y - 0.0102, 0.0288],
          [0.0058, y - 0.0094, 0.0282],
          [0.0152, y - 0.0135, 0.0226],
          [0.0215, y - 0.0005, 0.0128],
        ],
        0.0021,
        36,
      ),
    );
    for (const side of [-1, 1]) {
      parts.push(
        piece(
          sphere(0.0062, 12, 10),
          P.hair,
          [side * 0.0222, y - 0.0068, 0.0088],
          [0, side * 0.5, 0],
          [0.55, 1.35, 0.9],
        ),
        piece(
          sphere(0.0042, 10, 8),
          P.hair,
          [side * 0.0228, y + 0.0002, 0.0128],
          [0, 0, 0],
          [0.8, 0.8, 0.8],
        ),
      );
    }
  }
  return parts;
}

function hatParts(kind: BossKind): BufferGeometry[] {
  if (kind === 'taxInspector') {
    return [
      piece(
        lathe(
          [
            [0, 0.032],
            [0.012, 0.0312],
            [0.0205, 0.0272],
            [0.0245, 0.019],
            [0.0252, 0.009],
            [0.0258, 0.0035],
            [0.032, 0.0022],
            [0.0365, 0.004],
            [0.0378, 0.0058],
            [0.0368, 0.0062],
            [0.031, 0.0014],
            [0.0258, 0.0004],
            [0.0236, 0],
            [0, 0],
          ],
          40,
        ),
        P.lacquer,
        [0, 0, 0],
        [0, 0, 0],
        [1, 1, 1.06],
      ),
      piece(
        new CylinderGeometry(0.0258, 0.026, 0.0062, 40, 1, true),
        P.satin,
        [0, 0.0072, 0],
        [0, 0, 0],
        [1, 1, 1.06],
      ),
    ];
  }
  return [
    piece(
      lathe(
        [
          [0, 0.07],
          [0.0255, 0.07],
          [0.0262, 0.0688],
          [0.0242, 0.04],
          [0.0228, 0.012],
          [0.0236, 0.0035],
          [0.033, 0.0026],
          [0.039, 0.0062],
          [0.0398, 0.0082],
          [0.0388, 0.0084],
          [0.032, 0.0018],
          [0.024, 0],
          [0, 0],
        ],
        40,
      ),
      P.lacquer,
      [0, 0, 0],
      [0, 0, 0],
      [1, 1, 1.06],
    ),
    piece(
      new CylinderGeometry(0.02335, 0.02305, 0.0085, 40, 1, true),
      P.gold,
      [0, 0.0095, 0],
      [0, 0, 0],
      [1, 1, 1.06],
    ),
  ];
}

function armParts(kind: BossKind): BufferGeometry[] {
  const inspector = kind === 'taxInspector';
  const s = FIGURE.propSide;
  const shoulder = new Vector3(s * FIGURE.shoulder.x, FIGURE.shoulder.y, FIGURE.shoulder.z);
  const elbow = new Vector3(s * 0.064, 0.03, 0.016);
  const hand = inspector
    ? new Vector3(s * 0.016, 0.06, 0.064)
    : new Vector3(s * 0.03, 0.066, 0.058);
  const parts = [
    limb(P.cloth, shoulder, elbow, 0.0128),
    limb(P.cloth, elbow, hand, 0.011),
    piece(
      sphere(0.0118, 14, 10),
      P.shirt,
      hand.clone().lerp(elbow, 0.08).toArray(),
      [0, 0, 0],
      [1, 0.82, 0.94],
    ),
    piece(sphere(0.0098, 14, 10), P.porcelain, hand.toArray(), [0, 0, 0], [1, 0.82, 1.1]),
  ];
  if (inspector) {
    const tip = hand.clone().add(new Vector3(-s * 0.019, -0.002, 0.009));
    const cap = hand.clone().add(new Vector3(s * 0.01, 0.013, -0.004));
    parts.push(
      limb(P.lacquer, tip.clone().lerp(cap, 0.18), cap, 0.0021),
      limb(P.gold, tip, tip.clone().lerp(cap, 0.2), 0.0015),
      limb(P.gold, cap.clone().lerp(tip, 0.06), cap.clone().lerp(tip, -0.05), 0.0024),
    );
  } else {
    const watch: Triple = [hand.x - s * 0.003, hand.y + 0.012, hand.z + 0.004];
    const face: Triple = [-0.55, 0, 0];
    parts.push(
      piece(
        lathe(
          [
            [0, -0.0026],
            [0.0105, -0.0026],
            [0.0122, -0.0012],
            [0.0124, 0.0012],
            [0.0112, 0.0026],
            [0, 0.0026],
          ],
          32,
        ),
        P.gold,
        watch,
        [face[0] + Math.PI / 2, 0, 0],
      ),
      piece(
        new CylinderGeometry(0.0098, 0.0098, 0.0004, 32),
        P.paper,
        [watch[0], watch[1] + 0.0022 * Math.cos(face[0]), watch[2] + 0.0028],
        [face[0] + Math.PI / 2, 0, 0],
      ),
      piece(
        new CylinderGeometry(0.0018, 0.0018, 0.0034, 10),
        P.gold,
        [watch[0], watch[1] + 0.0138, watch[2] - 0.006],
        [face[0], 0, 0],
      ),
      piece(
        new TorusGeometry(0.0024, 0.0006, 6, 14),
        P.gold,
        [watch[0], watch[1] + 0.0168, watch[2] - 0.0078],
        [face[0], 0, 0],
      ),
      tube(
        P.gold,
        [
          [watch[0], watch[1] + 0.0185, watch[2] - 0.0086],
          [watch[0] + s * 0.004, watch[1] + 0.006, watch[2] - 0.003],
          [watch[0] + s * 0.007, watch[1] - 0.012, watch[2] + 0.002],
          [watch[0] + s * 0.004, watch[1] - 0.026, watch[2] + 0.002],
        ],
        0.0007,
        18,
      ),
    );
  }
  return parts;
}

function monocleParts(): BufferGeometry[] {
  return [
    piece(new TorusGeometry(0.0086, 0.0012, 8, 28), P.gold),
    piece(new CylinderGeometry(0.0083, 0.0083, 0.0008, 28), P.lens, [0, 0, 0], [Math.PI / 2, 0, 0]),
    tube(
      P.gold,
      [
        [0.0064, -0.0058, 0],
        [0.0112, -0.016, -0.002],
        [0.0124, -0.03, 0.0],
        [0.0098, -0.044, 0.004],
      ],
      0.0005,
      16,
    ),
  ];
}

/** Builds one figure's meshes, each centred on its pivot so the pose turns it in place. */
export function figureGeometry(kind: BossKind): FigureGeometry {
  const neck = FIGURE.neck.clone();
  const shoulder = new Vector3(
    FIGURE.propSide * FIGURE.shoulder.x,
    FIGURE.shoulder.y,
    FIGURE.shoulder.z,
  );
  const hatSeat = FIGURE.hatSeat.clone();
  const monocle =
    kind === 'rivalTycoon'
      ? new Vector3(FIGURE.propSide * FIGURE.eye.x, FIGURE.eye.y, FIGURE.eye.z + 0.0016)
      : null;
  return {
    torso: merge(torsoParts(kind), `boss/${kind}/torso`, new Vector3()),
    head: merge(headParts(kind), `boss/${kind}/head`, neck),
    hat: merge(hatParts(kind), `boss/${kind}/hat`, new Vector3()),
    arm: merge(armParts(kind), `boss/${kind}/arm`, shoulder),
    monocle: monocle ? merge(monocleParts(), `boss/${kind}/monocle`, new Vector3()) : null,
    pivots: {
      neck,
      hat: hatSeat.sub(neck),
      shoulder,
      monocle: monocle ? monocle.sub(neck) : null,
    },
  };
}
