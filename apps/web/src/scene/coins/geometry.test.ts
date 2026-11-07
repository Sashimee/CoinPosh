import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three/webgpu';
import {
  CoinPart,
  createCoinGeometry,
  FAR_COIN_GEOMETRY,
  NEAR_COIN_GEOMETRY,
  NEAR_COIN_TRIANGLE_BUDGET,
  type CoinGeometryOptions,
} from './geometry.ts';

function triangles(geometry: BufferGeometry): number[][] {
  const index = geometry.getIndex();
  if (!index) throw new Error('coin geometry must be indexed');
  const out: number[][] = [];
  for (let i = 0; i < index.count; i += 3)
    out.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)]);
  return out;
}

function vertex(geometry: BufferGeometry, i: number): [number, number, number] {
  const p = geometry.getAttribute('position');
  return [p.getX(i), p.getY(i), p.getZ(i)];
}

function signedVolume(geometry: BufferGeometry): number {
  let volume = 0;
  for (const [a = 0, b = 0, c = 0] of triangles(geometry)) {
    const [ax, ay, az] = vertex(geometry, a);
    const [bx, by, bz] = vertex(geometry, b);
    const [cx, cy, cz] = vertex(geometry, c);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

function openEdges(geometry: BufferGeometry): number {
  const key = (i: number): string =>
    vertex(geometry, i)
      .map((v) => Math.round(v * 1e5))
      .join(',');
  const uses = new Map<string, number>();
  for (const tri of triangles(geometry)) {
    for (let e = 0; e < 3; e += 1) {
      const a = key(tri[e] ?? 0);
      const b = key(tri[(e + 1) % 3] ?? 0);
      if (a === b) continue;
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((n) => n !== 2).length;
}

function bandRadii(geometry: BufferGeometry): number[] {
  const part = geometry.getAttribute('coinPart');
  const radii: number[] = [];
  for (let i = 0; i < part.count; i += 1) {
    const [x, , z] = vertex(geometry, i);
    if (part.getX(i) === CoinPart.edge) radii.push(Math.hypot(x, z));
  }
  return radii;
}

describe.each([
  ['near', NEAR_COIN_GEOMETRY],
  ['far', FAR_COIN_GEOMETRY],
] as const)('createCoinGeometry (%s)', (_, options: CoinGeometryOptions) => {
  const geometry = createCoinGeometry(options);

  it('is a closed solid with outward-facing triangles', () => {
    expect(openEdges(geometry)).toBe(0);
    const fullCylinder = Math.PI * 2 * options.halfThickness;
    const volume = signedVolume(geometry);
    expect(volume).toBeGreaterThan(fullCylinder * 0.8);
    expect(volume).toBeLessThan(fullCylinder * 1.02);
  });

  it('winds every triangle to agree with its vertex normals', () => {
    const normal = geometry.getAttribute('normal');
    let disagreeing = 0;
    for (const [a = 0, b = 0, c = 0] of triangles(geometry)) {
      const [ax, ay, az] = vertex(geometry, a);
      const [bx, by, bz] = vertex(geometry, b);
      const [cx, cy, cz] = vertex(geometry, c);
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      const nx = normal.getX(a) + normal.getX(b) + normal.getX(c);
      const ny = normal.getY(a) + normal.getY(b) + normal.getY(c);
      const nz = normal.getZ(a) + normal.getZ(b) + normal.getZ(c);
      if (fx * nx + fy * ny + fz * nz <= 0) disagreeing += 1;
    }
    expect(disagreeing).toBe(0);
  });

  it('stays within the unit radius and its declared thickness', () => {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      const [x, y, z] = vertex(geometry, i);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(options.halfThickness + 1e-6);
    }
    expect(geometry.boundingSphere?.radius).toBeGreaterThanOrEqual(1);
  });

  it('tags faces and edge band and keeps uvs in the unit square', () => {
    const part = geometry.getAttribute('coinPart');
    const uv = geometry.getAttribute('uv');
    const parts = new Set<number>();
    for (let i = 0; i < part.count; i += 1) {
      parts.add(part.getX(i));
      expect(uv.getX(i)).toBeGreaterThanOrEqual(-1e-6);
      expect(uv.getX(i)).toBeLessThanOrEqual(1 + 1e-6);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(-1e-6);
      expect(uv.getY(i)).toBeLessThanOrEqual(1 + 1e-6);
    }
    expect([...parts].sort()).toEqual([CoinPart.face, CoinPart.edge]);
  });
});

describe('reeded edge', () => {
  it('cuts reeds into the near band only', () => {
    const near = bandRadii(createCoinGeometry(NEAR_COIN_GEOMETRY));
    const far = bandRadii(createCoinGeometry(FAR_COIN_GEOMETRY));
    expect(Math.max(...near) - Math.min(...near)).toBeCloseTo(NEAR_COIN_GEOMETRY.reedDepth, 3);
    expect(Math.max(...far) - Math.min(...far)).toBeLessThan(1e-6);
  });

  it('keeps the near mesh within its triangle budget', () => {
    const triangles = (createCoinGeometry(NEAR_COIN_GEOMETRY).getIndex()?.count ?? 0) / 3;
    expect(triangles).toBeGreaterThan(0);
    expect(triangles).toBeLessThanOrEqual(NEAR_COIN_TRIANGLE_BUDGET);
  });

  it('keeps the far mesh much lighter than the near mesh', () => {
    const near = createCoinGeometry(NEAR_COIN_GEOMETRY).getIndex()?.count ?? 0;
    const far = createCoinGeometry(FAR_COIN_GEOMETRY).getIndex()?.count ?? 0;
    expect(far * 4).toBeLessThan(near);
  });
});
