import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';

export interface CoinGeometryOptions {
  readonly segments: number;
  readonly reeds: number;
  readonly reedSamples: number;
  readonly reedDepth: number;
  readonly cornerSteps: number;
  readonly fieldRings: number;
  readonly halfThickness: number;
}

export const COIN_FIELD_RADIUS = 0.84;

export const NEAR_COIN_GEOMETRY: CoinGeometryOptions = {
  segments: 96,
  reeds: 90,
  reedSamples: 4,
  reedDepth: 0.011,
  cornerSteps: 3,
  fieldRings: 3,
  halfThickness: 0.1,
};

export const FAR_COIN_GEOMETRY: CoinGeometryOptions = {
  segments: 28,
  reeds: 0,
  reedSamples: 1,
  reedDepth: 0,
  cornerSteps: 1,
  fieldRings: 1,
  halfThickness: 0.1,
};

export const CoinPart = { face: 0, edge: 1 } as const;

type UvMode = 'top' | 'bottom' | 'band';

interface ProfilePoint {
  readonly r: number;
  readonly y: number;
  readonly nr: number;
  readonly ny: number;
  readonly reed: number;
}

interface Strip {
  readonly points: readonly ProfilePoint[];
  readonly segments: number;
  readonly uv: UvMode;
  readonly part: number;
  readonly lastRingSegments?: number;
}

function point(r: number, y: number, nr: number, ny: number, reed = 0): ProfilePoint {
  const length = Math.hypot(nr, ny);
  return { r, y, nr: nr / length, ny: ny / length, reed };
}

function mirror(p: ProfilePoint): ProfilePoint {
  return { r: p.r, y: -p.y, nr: p.nr, ny: -p.ny, reed: p.reed };
}

function topProfile(
  o: CoinGeometryOptions,
  outerSegments: number,
): { inner: Strip[]; corner: ProfilePoint[] } {
  const h = o.halfThickness;
  const fieldY = h * 0.74;
  const dish = h * 0.08;
  const rf = COIN_FIELD_RADIUS;
  const lipInner = 0.875;
  const corner = h * 0.4;
  const lipOuter = 1 - corner;

  const field: ProfilePoint[] = [];
  for (let i = 0; i <= o.fieldRings; i += 1) {
    const r = (rf * i) / o.fieldRings;
    const slope = (2 * dish * r) / (rf * rf);
    field.push(point(r, fieldY + dish * (r / rf) ** 2, -slope, 1));
  }
  const bevelTop = { r: lipInner, y: h };
  const bevelBottom = { r: rf, y: fieldY + dish };
  const bevelNormal = { nr: -(bevelTop.y - bevelBottom.y), ny: bevelTop.r - bevelBottom.r };
  const bevel = [
    point(bevelBottom.r, bevelBottom.y, bevelNormal.nr, bevelNormal.ny),
    point(bevelTop.r, bevelTop.y, bevelNormal.nr, bevelNormal.ny),
  ];
  const lip = [point(lipInner, h, 0, 1), point(lipOuter, h, 0, 1)];

  const arc: ProfilePoint[] = [];
  for (let i = 0; i <= o.cornerSteps; i += 1) {
    const a = (Math.PI / 2) * (1 - i / o.cornerSteps);
    const reed = o.reeds > 0 ? Math.sin((Math.PI / 2) * (i / o.cornerSteps)) ** 2 : 0;
    arc.push(
      point(
        lipOuter + corner * Math.cos(a),
        h - corner + corner * Math.sin(a),
        Math.cos(a),
        Math.sin(a),
        reed,
      ),
    );
  }

  return {
    inner: [
      { points: field, segments: o.segments, uv: 'top', part: CoinPart.face },
      { points: bevel, segments: o.segments, uv: 'top', part: CoinPart.face },
      {
        points: lip,
        segments: o.segments,
        uv: 'top',
        part: CoinPart.face,
        lastRingSegments: outerSegments,
      },
    ],
    corner: arc,
  };
}

function buildStrips(o: CoinGeometryOptions): Strip[] {
  const outerSegments = o.reeds > 0 ? o.reeds * o.reedSamples : o.segments;
  const { inner, corner } = topProfile(o, outerSegments);
  const cornerStrip = (points: readonly ProfilePoint[], uv: UvMode): Strip => ({
    points,
    segments: outerSegments,
    uv,
    part: CoinPart.face,
  });

  const lastCorner = corner[corner.length - 1];
  if (!lastCorner)
    throw new Error('coin profile has an empty corner arc; cornerSteps must be at least 1');
  const band: Strip = {
    points: [lastCorner, mirror(lastCorner)],
    segments: outerSegments,
    uv: 'band',
    part: CoinPart.edge,
  };

  const bottomInner = inner.map((strip): Strip => ({
    ...strip,
    points: strip.points.map(mirror),
    uv: 'bottom',
  }));
  return [
    ...inner,
    cornerStrip(corner, 'top'),
    band,
    ...bottomInner,
    cornerStrip(corner.map(mirror), 'bottom'),
  ];
}

function reedOffset(theta: number, o: CoinGeometryOptions): { dr: number; dDr: number } {
  if (o.reeds === 0) return { dr: 0, dDr: 0 };
  const phase = o.reeds * theta;
  return {
    dr: -o.reedDepth * (0.5 - 0.5 * Math.cos(phase)),
    dDr: -o.reedDepth * 0.5 * o.reeds * Math.sin(phase),
  };
}

export function createCoinGeometry(options: CoinGeometryOptions): BufferGeometry {
  if (options.segments < 3)
    throw new Error(`coin geometry needs at least 3 segments, got ${options.segments}`);
  if (options.cornerSteps < 1) throw new Error('coin geometry needs cornerSteps >= 1');
  if (options.fieldRings < 1) throw new Error('coin geometry needs fieldRings >= 1');

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const parts: number[] = [];
  const indices: number[] = [];
  const n = new Vector3();

  for (const strip of buildStrips(options)) {
    const ringBases: number[] = [];
    const ringSegments = strip.points.map((_, ringIndex) =>
      ringIndex === strip.points.length - 1
        ? (strip.lastRingSegments ?? strip.segments)
        : strip.segments,
    );

    strip.points.forEach((p, ringIndex) => {
      ringBases.push(positions.length / 3);
      const segments = ringSegments[ringIndex] ?? strip.segments;
      for (let j = 0; j <= segments; j += 1) {
        const theta = (j / segments) * Math.PI * 2;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const { dr, dDr } = reedOffset(theta, options);
        const r = Math.max(p.r + dr * p.reed, 0);

        const x = r * cos;
        const z = r * sin;
        positions.push(x, p.y, z);

        const tilt = r > 0 ? (dDr * p.reed) / r : 0;
        n.set(p.nr * (cos + tilt * sin), p.ny, p.nr * (sin - tilt * cos)).normalize();
        normals.push(n.x, n.y, n.z);

        if (strip.uv === 'band') {
          uvs.push(j / segments, 0.5 + p.y / (2 * options.halfThickness));
        } else {
          const u = strip.uv === 'top' ? 0.5 + 0.5 * x : 0.5 - 0.5 * x;
          uvs.push(u, 0.5 - 0.5 * z);
        }
        parts.push(strip.part);
      }
    });

    for (let i = 0; i < strip.points.length - 1; i += 1) {
      const current = strip.points[i];
      const next = strip.points[i + 1];
      if (!current || !next) continue;
      const a = ringBases[i] ?? 0;
      const b = ringBases[i + 1] ?? 0;
      const na = ringSegments[i] ?? strip.segments;
      const nb = ringSegments[i + 1] ?? strip.segments;
      if (na === nb) {
        for (let j = 0; j < na; j += 1) {
          if (current.r > 0) pushOutward(indices, positions, normals, a + j, b + j, a + j + 1);
          if (next.r > 0) pushOutward(indices, positions, normals, a + j + 1, b + j, b + j + 1);
        }
      } else {
        zipRings(indices, positions, normals, a, na, b, nb);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('coinPart', new BufferAttribute(new Float32Array(parts), 1));
  const vertexCount = positions.length / 3;
  geometry.setIndex(
    new BufferAttribute(
      vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
      1,
    ),
  );
  geometry.boundingSphere = new Sphere(new Vector3(), Math.hypot(1, options.halfThickness));
  geometry.computeBoundingBox();
  return geometry;
}

// Joins rings with different segment counts by always advancing whichever ring's next
// vertex comes first in angle, so the fine reeded corner meets the coarse lip with shared
// edges instead of T-junctions that rasterise as pinhole cracks.
function zipRings(
  indices: number[],
  positions: readonly number[],
  normals: readonly number[],
  a: number,
  na: number,
  b: number,
  nb: number,
): void {
  let i = 0;
  let j = 0;
  while (i < na || j < nb) {
    const advanceA = j >= nb || (i < na && (i + 1) / na <= (j + 1) / nb);
    if (advanceA) {
      pushOutward(indices, positions, normals, a + i, b + j, a + i + 1);
      i += 1;
    } else {
      pushOutward(indices, positions, normals, a + i, b + j, b + j + 1);
      j += 1;
    }
  }
}

const edgeA = new Vector3();
const edgeB = new Vector3();
const vertexNormal = new Vector3();

function pushOutward(
  indices: number[],
  positions: readonly number[],
  normals: readonly number[],
  a: number,
  b: number,
  c: number,
): void {
  const read = (index: number, offset: number): number => positions[index * 3 + offset] ?? 0;
  edgeA.set(read(b, 0) - read(a, 0), read(b, 1) - read(a, 1), read(b, 2) - read(a, 2));
  edgeB.set(read(c, 0) - read(a, 0), read(c, 1) - read(a, 1), read(c, 2) - read(a, 2));
  edgeA.cross(edgeB);
  vertexNormal.set(0, 0, 0);
  for (const index of [a, b, c]) {
    vertexNormal.x += normals[index * 3] ?? 0;
    vertexNormal.y += normals[index * 3 + 1] ?? 0;
    vertexNormal.z += normals[index * 3 + 2] ?? 0;
  }
  if (edgeA.dot(vertexNormal) >= 0) indices.push(a, b, c);
  else indices.push(a, c, b);
}
