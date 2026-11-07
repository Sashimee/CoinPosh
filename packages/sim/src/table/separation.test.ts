import type { RigidBody, Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { loadRapier, type Rapier } from '../rapier.ts';
import { CoinSeparator, type Obstacle } from './separation.ts';
import { COIN_MATERIAL, TABLE_SOLVER } from './tuning.ts';

const SCALE = TABLE_SOLVER.worldScale;
const RIM = COIN_MATERIAL.rimRadius * SCALE;
const GEOMETRY = {
  coreHalfHeight: COIN.halfThickness * SCALE - RIM,
  coreRadius: COIN.radius * SCALE - RIM,
  rim: RIM,
};
const SLOP = TABLE_SOLVER.separationSlop * SCALE;
const SETTINGS = { slop: SLOP, passes: TABLE_SOLVER.separationPasses };
const FLAT = { x: 0, y: 0, z: 0, w: 1 } as const;
const DIAMETER = 2 * COIN.radius * SCALE;
const THICKNESS = 2 * COIN.halfThickness * SCALE;

interface Rig {
  readonly rapier: Rapier;
  readonly world: World;
  readonly separator: CoinSeparator;
  coin(at: Vector): RigidBody;
}

const live: World[] = [];

afterEach(() => {
  for (const world of live.splice(0)) {
    world.free();
  }
});

async function createRig(obstacles: (rapier: Rapier) => Obstacle[] = () => []): Promise<Rig> {
  const rapier = await loadRapier();
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  live.push(world);
  const shape = new rapier.RoundCylinder(GEOMETRY.coreHalfHeight, GEOMETRY.coreRadius, RIM);
  return {
    rapier,
    world,
    separator: new CoinSeparator(rapier, shape, GEOMETRY, obstacles(rapier), SETTINGS),
    coin(at) {
      return world.createRigidBody(
        rapier.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(FLAT),
      );
    },
  };
}

/**
 * How deep two flat coins overlap, worked out from the geometry rather than asked of
 * Rapier: the lesser of the side-by-side and the face-to-face overlap. Exact while one
 * of the two is well clear of the rim, as in every case here.
 */
function flatDepth(a: RigidBody, b: RigidBody): number {
  const p = a.translation();
  const q = b.translation();
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const side = DIAMETER - Math.sqrt(dx * dx + dz * dz);
  const face = THICKNESS - Math.abs(q.y - p.y);
  return Math.max(0, Math.min(side, face));
}

/** A floor slab whose top face is at y = 0. */
function floor(rapier: Rapier): Obstacle[] {
  const half = { x: 5, y: 0.5, z: 5 };
  return [
    {
      shape: new rapier.Cuboid(half.x, half.y, half.z),
      half,
      centre: () => ({ x: 0, y: -half.y, z: 0 }),
    },
  ];
}

function poses(bodies: readonly RigidBody[]): number[] {
  return bodies.flatMap((body) => {
    const t = body.translation();
    return [t.x, t.y, t.z];
  });
}

describe('CoinSeparator', () => {
  it('moves a deep pair apart to half the slop, half the push each, and leaves velocities alone', async () => {
    const rig = await createRig();
    const a = rig.coin({ x: 0, y: 1, z: 0 });
    const b = rig.coin({ x: DIAMETER - 0.02, y: 1, z: 0 });
    a.setLinvel({ x: 1, y: 0, z: 0 }, true);
    b.setLinvel({ x: -1, y: 0, z: 0 }, true);
    expect(rig.separator.separate([a, b])).toBe(2);

    expect(flatDepth(a, b)).toBeCloseTo(SLOP / 2, 4);
    expect(a.translation().x).toBeCloseTo(-(0.02 - SLOP / 2) / 2, 5);
    expect(b.translation().x - (DIAMETER - 0.02)).toBeCloseTo(-a.translation().x, 6);
    expect(a.translation().y).toBeCloseTo(1, 4);
    expect(b.translation().y).toBeCloseTo(1, 4);
    expect(a.linvel()).toEqual({ x: 1, y: 0, z: 0 });
    expect(b.linvel()).toEqual({ x: -1, y: 0, z: 0 });
  });

  it('leaves a pair alone while it is within the slop', async () => {
    const rig = await createRig();
    const a = rig.coin({ x: 0, y: 1, z: 0 });
    const b = rig.coin({ x: DIAMETER - SLOP / 2, y: 1, z: 0 });
    const before = poses([a, b]);
    expect(rig.separator.separate([a, b])).toBe(0);
    expect(poses([a, b])).toEqual(before);
  });

  it('parts two flat coins side by side sideways when Rapier reports them deep along their axis', async () => {
    const rig = await createRig();
    const a = rig.coin({ x: 0, y: 1, z: 0 });
    const b = rig.coin({ x: DIAMETER - 1.25 * SLOP, y: 1 - 0.00001, z: 0 });
    const ya = a.translation().y;
    const yb = b.translation().y;
    expect(rig.separator.separate([a, b])).toBe(2);
    expect(flatDepth(a, b)).toBeCloseTo(SLOP / 2, 4);
    expect(a.translation().y).toBe(ya);
    expect(b.translation().y).toBe(yb);
  });

  it('clears a jammed row, where each push drives a coin into the next', async () => {
    const rig = await createRig();
    const row = Array.from({ length: 6 }, (_, i) =>
      rig.coin({ x: i * (DIAMETER - 0.015), y: 1, z: 0 }),
    );
    rig.separator.separate(row);
    row.reduce((previous, coin) => {
      expect(flatDepth(previous, coin)).toBeLessThanOrEqual(SLOP);
      return coin;
    });
  });

  it('pushes a coin sunk into a slab out of it, and holds it there while the coin above is cleared', async () => {
    const rig = await createRig(floor);
    const bottom = rig.coin({ x: 0, y: THICKNESS / 2 - 0.01, z: 0 });
    const top = rig.coin({ x: 0.03, y: THICKNESS * 1.5 - 0.03, z: 0 });
    rig.separator.separate([bottom, top]);
    expect(bottom.translation().y - THICKNESS / 2).toBeGreaterThanOrEqual(-SLOP);
    expect(flatDepth(bottom, top)).toBeLessThanOrEqual(SLOP);
    // The coin above takes the push the floor will not.
    expect(top.translation().y).toBeGreaterThan(THICKNESS * 1.5 - 0.03);
  });

  it('gives the same poses, bit for bit, for the same input', async () => {
    const run = async (): Promise<number[]> => {
      const rig = await createRig(floor);
      const tilted = rig.coin({ x: 0.05, y: THICKNESS * 1.5 - 0.02, z: -0.02 });
      tilted.setRotation({ x: 0.1, y: 0, z: 0.05, w: Math.sqrt(1 - 0.0125) }, true);
      const coins = [
        rig.coin({ x: 0, y: THICKNESS / 2 - 0.004, z: 0 }),
        rig.coin({ x: DIAMETER - 0.012, y: THICKNESS / 2, z: 0.01 }),
        tilted,
        rig.coin({ x: -DIAMETER + 0.01, y: THICKNESS / 2 + 0.002, z: 0.03 }),
      ];
      rig.separator.separate(coins);
      return poses(coins);
    };
    const first = await run();
    expect(await run()).toEqual(first);
  });
});
