import {
  BoxGeometry,
  BufferAttribute,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  InstancedBufferAttribute,
  LatheGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type CatmullRomCurve3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GACHA, type PileCapsule } from './layout.ts';

/**
 * The surface each vertex of the machine is shaded as, carried in the `gachaPart` attribute so
 * the cabinet and the crank draw with one material and one pipeline.
 */
export const MachinePart = {
  lacquer: 0,
  brushedGold: 1,
  polishedGold: 2,
  velvet: 3,
  ivory: 4,
  slot: 5,
  guilloche: 6,
  lamp: 7,
} as const;

export type MachinePartId = (typeof MachinePart)[keyof typeof MachinePart];

/** Which part of a capsule a vertex is, in the `capsuleShell` attribute. */
export const CapsuleShell = { base: 0, seam: 0.5, dome: 1 } as const;

const PART_ATTRIBUTES = 'gachaPart,normal,position,uv';

type Triple = readonly [number, number, number];

const matrix = new Matrix4();
const turn = new Quaternion();
const euler = new Euler();
const place = new Vector3();
const size = new Vector3();

/** Places `geometry` and tags it as one surface; the result is non-indexed and owns its data. */
function piece(
  geometry: BufferGeometry,
  part: number,
  at: Triple = [0, 0, 0],
  rotation: Triple = [0, 0, 0],
  attribute = 'gachaPart',
): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') flat.deleteAttribute(name);
  }
  const count = flat.getAttribute('position').count;
  flat.setAttribute(attribute, new BufferAttribute(new Float32Array(count).fill(part), 1));
  euler.set(rotation[0], rotation[1], rotation[2], 'YXZ');
  matrix.compose(place.set(...at), turn.setFromEuler(euler), size.setScalar(1));
  flat.applyMatrix4(matrix);
  return flat;
}

/** Points `geometry`'s +Y axis along `direction` and centres it on `at`. */
function aligned(geometry: BufferGeometry, part: number, at: Vector3, direction: Vector3) {
  const flat = piece(geometry, part);
  turn.setFromUnitVectors(UP, direction.clone().normalize());
  matrix.compose(at, turn, size.setScalar(1));
  flat.applyMatrix4(matrix);
  return flat;
}

const UP = new Vector3(0, 1, 0);

function merge(parts: BufferGeometry[], name: string, expected = PART_ATTRIBUTES): BufferGeometry {
  for (const part of parts) {
    const names = Object.keys(part.attributes).sort().join(',');
    if (part.index || names !== expected)
      throw new Error(`Gacha ${name} has a part with attributes ${names}, not ${expected}`);
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.name = name;
  return merged;
}

/** A rounded rectangle in the XY plane centred on the origin, as a path for a shape or hole. */
function roundedRect<T extends Shape | Path>(path: T, w: number, h: number, corner: number): T {
  path.moveTo(-w / 2 + corner, -h / 2);
  path.lineTo(w / 2 - corner, -h / 2);
  path.absarc(w / 2 - corner, -h / 2 + corner, corner, -Math.PI / 2, 0, false);
  path.lineTo(w / 2, h / 2 - corner);
  path.absarc(w / 2 - corner, h / 2 - corner, corner, 0, Math.PI / 2, false);
  path.lineTo(-w / 2 + corner, h / 2);
  path.absarc(-w / 2 + corner, h / 2 - corner, corner, Math.PI / 2, Math.PI, false);
  path.lineTo(-w / 2, -h / 2 + corner);
  path.absarc(-w / 2 + corner, -h / 2 + corner, corner, Math.PI, Math.PI * 1.5, false);
  return path;
}

/**
 * A rounded-rectangle slab lying flat: `halfWidth` along X, `halfDepth` along Z, from `y` up by
 * `height`, its upright edges softened by a bevel of `bevel`.
 */
function slab(
  halfWidth: number,
  halfDepth: number,
  corner: number,
  y: number,
  height: number,
  bevel = 0,
  hole?: { halfWidth: number; halfDepth: number; corner: number },
): BufferGeometry {
  const shape = roundedRect(new Shape(), (halfWidth - bevel) * 2, (halfDepth - bevel) * 2, corner);
  if (hole)
    shape.holes.push(roundedRect(new Path(), hole.halfWidth * 2, hole.halfDepth * 2, hole.corner));
  const geometry = new ExtrudeGeometry(shape, {
    depth: height - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y + bevel, 0);
  return geometry;
}

/** A fluted column: `flutes` concave channels cut into a cylinder, with true normals. */
function flutedColumn(radius: number, height: number, flutes: number): BufferGeometry {
  const radial = flutes * 6;
  const geometry = new CylinderGeometry(radius, radius, height, radial, 1, true);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const angle = Math.atan2(z, x);
    const channel = Math.max(0, Math.cos(angle * flutes)) ** 1.6;
    const r = radius * (1 - 0.13 * channel);
    position.setXYZ(i, Math.cos(angle) * r, position.getY(i), Math.sin(angle) * r);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function lathe(profile: readonly (readonly [number, number])[], segments = 56): BufferGeometry {
  const geometry = new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, y)),
    segments,
  );
  return geometry;
}

/**
 * The cabinet: a gold plinth, the navy lacquer body between four fluted gold columns, a gold
 * hairline frame round the front, the guilloche crank plate and the ticket slot, the turned
 * collar the globe sits in with its lamp ring, the domed cap and finial, the velvet-lined tray
 * and the gold fittings that hold the glass chute.
 */
export function machineBodyGeometry(chute: CatmullRomCurve3): BufferGeometry {
  const { plinth, body, column, crank, tray, globe } = GACHA;
  const front = body.halfDepth;
  const parts: BufferGeometry[] = [
    piece(
      slab(plinth.halfWidth, plinth.halfDepth, plinth.corner, 0, plinth.height, 0.004),
      MachinePart.brushedGold,
    ),
    piece(
      slab(body.halfWidth, body.halfDepth, body.corner, body.bottom, body.top - body.bottom, 0.003),
      MachinePart.lacquer,
    ),
    piece(
      slab(
        body.halfWidth + 0.004,
        body.halfDepth + 0.004,
        body.corner + 0.004,
        body.top,
        0.007,
        0.0025,
      ),
      MachinePart.lacquer,
    ),
    piece(
      slab(
        body.halfWidth + 0.0048,
        body.halfDepth + 0.0048,
        body.corner + 0.0048,
        body.top + 0.0035,
        0.005,
        0.0012,
        {
          halfWidth: body.halfWidth + 0.0018,
          halfDepth: body.halfDepth + 0.0018,
          corner: body.corner + 0.0018,
        },
      ),
      MachinePart.polishedGold,
    ),
    piece(
      slab(
        body.halfWidth + 0.003,
        body.halfDepth + 0.003,
        body.corner + 0.003,
        body.bottom,
        0.006,
        0.002,
      ),
      MachinePart.polishedGold,
    ),
  ];

  const columnHeight = body.top - body.bottom - 0.016;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (body.halfWidth - column.inset);
      const z = sz * (body.halfDepth - column.inset);
      parts.push(
        piece(flutedColumn(column.radius, columnHeight, column.flutes), MachinePart.polishedGold, [
          x,
          body.bottom + 0.008 + columnHeight / 2,
          z,
        ]),
        piece(
          lathe(
            [
              [0, 0],
              [column.radius + 0.004, 0],
              [column.radius + 0.004, 0.003],
              [column.radius + 0.0015, 0.005],
              [column.radius + 0.0025, 0.0065],
              [column.radius, 0.008],
              [0, 0.008],
            ],
            40,
          ),
          MachinePart.brushedGold,
          [x, body.bottom + 0.0005, z],
        ),
        piece(
          lathe(
            [
              [0, 0],
              [column.radius, 0],
              [column.radius + 0.0025, 0.0015],
              [column.radius + 0.0015, 0.003],
              [column.radius + 0.004, 0.005],
              [column.radius + 0.004, 0.008],
              [0, 0.008],
            ],
            40,
          ),
          MachinePart.brushedGold,
          [x, body.top - 0.0085, z],
        ),
      );
    }
  }

  const frameHalfWidth = body.halfWidth - 0.021;
  const frameBottom = tray.top + 0.008;
  const frameTop = body.top - 0.012;
  const frameShape = roundedRect(new Shape(), frameHalfWidth * 2, frameTop - frameBottom, 0.012);
  frameShape.holes.push(
    roundedRect(new Path(), frameHalfWidth * 2 - 0.003, frameTop - frameBottom - 0.003, 0.0105),
  );
  parts.push(
    piece(
      new ExtrudeGeometry(frameShape, { depth: 0.0012, bevelEnabled: false, curveSegments: 10 }),
      MachinePart.polishedGold,
      [0, (frameTop + frameBottom) / 2, front],
    ),
  );
  for (const sx of [-1, 1]) {
    const sideShape = roundedRect(
      new Shape(),
      body.halfDepth * 2 - 0.042,
      frameTop - frameBottom,
      0.012,
    );
    sideShape.holes.push(
      roundedRect(new Path(), body.halfDepth * 2 - 0.045, frameTop - frameBottom - 0.003, 0.0105),
    );
    parts.push(
      piece(
        new ExtrudeGeometry(sideShape, { depth: 0.0012, bevelEnabled: false, curveSegments: 10 }),
        MachinePart.polishedGold,
        [sx * body.halfWidth, (frameTop + frameBottom) / 2, 0],
        [0, sx * (Math.PI / 2), 0],
      ),
    );
  }

  parts.push(
    piece(
      new CylinderGeometry(crank.plateRadius, crank.plateRadius, 0.004, 72, 1),
      MachinePart.guilloche,
      [0, crank.pivotY, front + 0.002],
      [Math.PI / 2, 0, 0],
    ),
    piece(new TorusGeometry(crank.plateRadius, 0.0024, 10, 56), MachinePart.brushedGold, [
      0,
      crank.pivotY,
      front + 0.004,
    ]),
    piece(new TorusGeometry(crank.plateRadius * 0.34, 0.0014, 10, 48), MachinePart.polishedGold, [
      0,
      crank.pivotY,
      front + 0.0042,
    ]),
    piece(slab(0.03, 0.0021, 0.002, -0.009, 0.018, 0.0012), MachinePart.brushedGold, [
      0,
      GACHA.slotY,
      front + 0.0021,
    ]),
    piece(new BoxGeometry(0.034, 0.0034, 0.002), MachinePart.slot, [
      0,
      GACHA.slotY,
      front + 0.0034,
    ]),
  );

  const collarBase = body.top + 0.007;
  parts.push(
    piece(
      lathe([
        [0, collarBase],
        [0.083, collarBase],
        [0.084, collarBase + 0.004],
        [0.08, collarBase + 0.006],
        [0.078, collarBase + 0.0075],
        [0.0735, GACHA.collarTop - 0.002],
        [0.075, GACHA.collarTop],
        [0.0705, GACHA.collarTop + 0.0005],
        [0.06, GACHA.collarTop - 0.004],
      ]),
      MachinePart.brushedGold,
    ),
    piece(
      new TorusGeometry(0.0795, 0.0019, 8, 72),
      MachinePart.lamp,
      [0, collarBase + 0.0068, 0],
      [Math.PI / 2, 0, 0],
    ),
  );

  const capRing = Math.sqrt(globe.radius ** 2 - (GACHA.capBase - globe.centerY) ** 2);
  const capTop = GACHA.capBase + 0.04;
  const dome: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    dome.push([
      0.011 + (capRing - 0.007) * Math.cos(a),
      GACHA.capBase + 0.011 + 0.026 * Math.sin(a),
    ]);
  }
  parts.push(
    piece(
      lathe([
        [capRing - 0.008, GACHA.capBase - 0.0015],
        [capRing + 0.0015, GACHA.capBase - 0.001],
        [capRing + 0.004, GACHA.capBase + 0.003],
        [capRing + 0.0015, GACHA.capBase + 0.0065],
        [capRing + 0.003, GACHA.capBase + 0.009],
        ...dome,
        [0.0075, capTop - 0.002],
        [0.0062, capTop + 0.002],
        [0, capTop + 0.002],
      ]),
      MachinePart.brushedGold,
    ),
    piece(
      new TorusGeometry(capRing + 0.0012, 0.0016, 8, 64),
      MachinePart.lamp,
      [0, GACHA.capBase + 0.0075, 0],
      [Math.PI / 2, 0, 0],
    ),
    piece(new SphereGeometry(0.0115, 32, 20), MachinePart.polishedGold, [0, capTop + 0.012, 0]),
    piece(
      new TorusGeometry(0.0068, 0.0016, 10, 32),
      MachinePart.polishedGold,
      [0, capTop + 0.0015, 0],
      [Math.PI / 2, 0, 0],
    ),
  );

  const trayHole = {
    halfWidth: tray.halfWidth - tray.wall,
    halfDepth: (tray.front - front) / 2 - tray.wall,
    corner: 0.008,
  };
  const trayCentreZ = (front + tray.front) / 2;
  const trayHalfDepth = (tray.front - front) / 2;
  const walls = slab(
    tray.halfWidth,
    trayHalfDepth,
    0.012,
    tray.floor - 0.004,
    tray.top - tray.floor + 0.004,
    0,
    trayHole,
  );
  walls.translate(0, 0, trayCentreZ);
  const lip = slab(tray.halfWidth + 0.002, trayHalfDepth + 0.002, 0.014, tray.top, 0.0035, 0.0012, {
    halfWidth: trayHole.halfWidth - 0.001,
    halfDepth: trayHole.halfDepth - 0.001,
    corner: 0.007,
  });
  lip.translate(0, 0, trayCentreZ);
  const floor = slab(trayHole.halfWidth, trayHole.halfDepth, trayHole.corner, tray.floor, 0.003);
  floor.translate(0, 0, trayCentreZ);
  parts.push(
    piece(walls, MachinePart.brushedGold),
    piece(lip, MachinePart.brushedGold),
    piece(floor, MachinePart.velvet),
  );

  const at = new Vector3();
  const along = new Vector3();
  const fitting = (u: number, radius: number, tube: number, part: number): void => {
    chute.getPointAt(u, at);
    chute.getTangentAt(u, along);
    const ring = new TorusGeometry(radius, tube, 12, 48);
    ring.rotateX(Math.PI / 2);
    parts.push(aligned(ring, part, at, along));
  };
  fitting(0.025, GACHA.chuteRadius + 0.002, 0.0028, MachinePart.polishedGold);
  fitting(0.06, GACHA.chuteRadius + 0.0015, 0.0016, MachinePart.brushedGold);
  fitting(0.52, GACHA.chuteRadius + 0.0012, 0.0019, MachinePart.brushedGold);
  fitting(0.985, GACHA.chuteRadius + 0.0018, 0.0026, MachinePart.brushedGold);

  chute.getPointAt(0.0, at);
  const portCollar = new CylinderGeometry(
    GACHA.chuteRadius + 0.004,
    GACHA.chuteRadius + 0.006,
    0.016,
    40,
    1,
    true,
  );
  chute.getTangentAt(0.0, along);
  parts.push(aligned(portCollar, MachinePart.brushedGold, at, along));

  chute.getPointAt(0.52, at);
  const columnPoint = new Vector3(
    body.halfWidth - column.inset + column.radius * 0.6,
    at.y,
    body.halfDepth - column.inset + column.radius * 0.6,
  );
  const strut = at.clone().sub(columnPoint);
  const strutLength = Math.max(strut.length() - GACHA.chuteRadius, 0.002);
  parts.push(
    aligned(
      new CylinderGeometry(0.0022, 0.0028, strutLength, 16, 1),
      MachinePart.brushedGold,
      columnPoint.clone().addScaledVector(strut.normalize(), strutLength / 2),
      strut,
    ),
  );

  return merge(parts, 'gacha-body');
}

/**
 * The crank, built round its pivot with the arm pointing up at rest and turning about +Z: a
 * domed hub, a tapered brushed arm with a counterweight lobe, and a turned ivory grip on a gold
 * spindle. It shares the cabinet's material.
 */
export function crankGeometry(): BufferGeometry {
  const { arm } = GACHA.crank;
  const parts: BufferGeometry[] = [
    piece(
      new CylinderGeometry(0.0125, 0.014, 0.008, 48, 1),
      MachinePart.polishedGold,
      [0, 0, 0.008],
      [Math.PI / 2, 0, 0],
    ),
    piece(
      new SphereGeometry(0.0108, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      MachinePart.polishedGold,
      [0, 0, 0.012],
      [Math.PI / 2, 0, 0],
    ),
  ];
  const armShape = new Shape();
  armShape.moveTo(-0.0072, 0);
  armShape.lineTo(-0.0042, arm);
  armShape.absarc(0, arm, 0.0042, Math.PI, 0, true);
  armShape.lineTo(0.0072, 0);
  armShape.absarc(0, 0, 0.0072, 0, Math.PI, true);
  const armGeometry = new ExtrudeGeometry(armShape, {
    depth: 0.003,
    bevelEnabled: true,
    bevelThickness: 0.001,
    bevelSize: 0.0008,
    bevelSegments: 2,
    curveSegments: 16,
  });
  parts.push(piece(armGeometry, MachinePart.brushedGold, [0, 0, 0.0095]));
  parts.push(
    piece(
      new CylinderGeometry(0.0095, 0.0095, 0.004, 40, 1),
      MachinePart.polishedGold,
      [0, -0.014, 0.011],
      [Math.PI / 2, 0, 0],
    ),
  );
  const gripLength = 0.028;
  const grip: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const swell = 0.0052 + 0.0018 * Math.sin(t * Math.PI) ** 0.8;
    grip.push([swell, t * gripLength]);
  }
  parts.push(
    piece(
      new CylinderGeometry(0.0022, 0.0022, 0.008, 16, 1),
      MachinePart.polishedGold,
      [0, arm, 0.016],
      [Math.PI / 2, 0, 0],
    ),
    piece(
      lathe([[0, 0], ...grip, [0, gripLength]], 40),
      MachinePart.ivory,
      [0, arm, 0.019],
      [Math.PI / 2, 0, 0],
    ),
    piece(
      new SphereGeometry(0.0046, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      MachinePart.polishedGold,
      [0, arm, 0.019 + gripLength],
      [Math.PI / 2, 0, 0],
    ),
    piece(new TorusGeometry(0.0054, 0.0012, 8, 32), MachinePart.polishedGold, [0, arm, 0.0195]),
  );
  return merge(parts, 'gacha-crank');
}

/** The globe and the chute as one glass draw. */
export function glassGeometry(chute: CatmullRomCurve3): BufferGeometry {
  const strip = (geometry: BufferGeometry): BufferGeometry => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    return flat;
  };
  const globe = strip(new SphereGeometry(GACHA.globe.radius, 56, 36));
  globe.translate(0, GACHA.globe.centerY, 0);
  const tube = strip(new TubeGeometry(chute, 96, GACHA.chuteRadius, 18, false));
  const merged = mergeGeometries([globe, tube], false);
  globe.dispose();
  tube.dispose();
  merged.computeBoundingSphere();
  merged.name = 'gacha-glass';
  return merged;
}

const CAPSULE_ATTRIBUTES = 'capsuleShell,normal,position,uv';

/** One capsule shell, dome up (`dome`) or base down, with the gold seam band on the base. */
function shell(part: 'dome' | 'base', segments: number): BufferGeometry[] {
  const r = GACHA.capsuleRadius;
  if (part === 'dome') {
    return [
      piece(
        new SphereGeometry(r, segments, segments / 2, 0, Math.PI * 2, 0, Math.PI / 2),
        CapsuleShell.dome,
        [0, 0, 0],
        [0, 0, 0],
        'capsuleShell',
      ),
    ];
  }
  return [
    piece(
      new SphereGeometry(r, segments, segments / 2, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      CapsuleShell.base,
      [0, 0, 0],
      [0, 0, 0],
      'capsuleShell',
    ),
    piece(
      new TorusGeometry(r * 1.004, r * 0.075, 6, segments),
      CapsuleShell.seam,
      [0, -r * 0.03, 0],
      [Math.PI / 2, 0, 0],
      'capsuleShell',
    ),
  ];
}

/** A closed capsule for the pile, with a per-instance shell colour in `capsuleTint`. */
export function pileGeometry(
  pile: readonly PileCapsule[],
  tints: readonly Triple[],
): BufferGeometry {
  const merged = merge(
    [...shell('dome', 14), ...shell('base', 14)],
    'gacha-pile',
    CAPSULE_ATTRIBUTES,
  );
  const colors = new Float32Array(pile.length * 3);
  pile.forEach((capsule, i) => {
    const tint = tints[capsule.tint];
    if (!tint) throw new Error(`Gacha pile capsule ${i} has no tint ${capsule.tint}`);
    colors.set(tint, i * 3);
  });
  merged.setAttribute('capsuleTint', new InstancedBufferAttribute(colors, 3));
  return merged;
}

/** The dispensed capsule's two halves, built round the capsule's centre so they can twist apart. */
export function capsuleHalfGeometry(part: 'dome' | 'base'): BufferGeometry {
  return merge(shell(part, 32), `gacha-capsule-${part}`, CAPSULE_ATTRIBUTES);
}
