import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import type { Xoshiro128ss } from '../prng.ts';
import { BACKBOARD, PLAYFIELD } from './layout.ts';
import { COIN_MATERIAL } from './tuning.ts';

/**
 * The opening heap: a table laid out at the brink, so the first coins the player adds
 * are what tips it. Coins lie flat in hexagonal rows, in this order until the count
 * runs out:
 *
 * 1. The lower-tier sheet, from the front lip back to just ahead of the pusher's full
 *    reach. The front row overhangs the lip by more than half a coin's radius but keeps
 *    its centre over the wood, so it holds until something shoves the sheet; the back
 *    row stays `reachClearance` short of the block, so the pusher only kisses it. Any
 *    coin the pusher sweeps into the gap then pushes the front row over.
 * 2. The upper tier, from the pusher lip back to the backboard, its front row
 *    overhanging the lip the same way, so the block carries it to the edge of spilling.
 * 3. A second layer over the upper tier, then over the lower sheet, each coin over the
 *    hollow between three below it, so a pile reads as heaped rather than tiled. Those
 *    coins rest on the ones below and so touch them from the first tick; a table that
 *    fuses lays the heap without this layer (`secondLayer: false`).
 *
 * Values, in metres:
 *
 * - gap 1.5 mm between neighbours in a layer: with the jitter below, two neighbours
 *   stay more than Contact Fusion's 1 mm touch gap apart, so a single-layer heap does
 *   not start fusing until the pusher packs it.
 * - lipInset 5 mm: the front rows' centres sit this far inside their lip, overhanging
 *   it by 8.5 mm. Closer and the separation pass or a neighbour's nudge tips them early.
 * - reachClearance 6 mm: between the sheet's back row and the front of the block at
 *   full reach, so the opening strokes leave the sheet standing until a coin falls into
 *   the gap.
 * - jitter 0.15 mm: each coin is moved a little off its lattice point, and turned to a
 *   random heading, so the coin faces do not all line up. At most (gap − 1 mm) / (2√2),
 *   or two neighbours jittered towards each other could start inside the touch gap.
 */
export const HEAP_TUNING = {
  gap: 0.0015,
  lipInset: 0.005,
  reachClearance: 0.006,
  jitter: 0.00015,
} as const;

/** A spot that the heap leaves bare, such as the Champagne Tower's pedestal. */
export interface HeapKeepClear {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

/** The parts of the heap's geometry its caller chooses; the table supplies the rest. */
export type HeapLayout = Pick<HeapGeometry, 'keepClear' | 'secondLayer'>;

export interface HeapPose {
  readonly translation: Vector;
  readonly rotation: Rotation;
}

export interface HeapGeometry {
  /** z of the upper tier's front lip when the heap is laid. */
  readonly upperLipZ: number;
  /** z of the pusher's front face at full reach. */
  readonly reachZ: number;
  /** Height of the upper tier above the lower. */
  readonly upperY: number;
  readonly keepClear?: readonly HeapKeepClear[];
  /**
   * Whether to lay the second layer (step 3 above); true when omitted. A table that
   * fuses leaves it off: each of its coins rests on three below, already touching them.
   */
  readonly secondLayer?: boolean;
}

const PITCH = 2 * COIN.radius + HEAP_TUNING.gap;
/** Hexagonal row spacing: PITCH × √3 / 2, written out so the lattice is the same everywhere. */
const ROW_SPACING = PITCH * 0.8660254037844386;
const SKIN = COIN_MATERIAL.contactSkin;
/** A coin's centre height when it lies flat on a surface, and the rise of each layer on top. */
const LIE_Y = COIN.halfThickness + SKIN;
const LAYER_RISE = 2 * (COIN.halfThickness + SKIN);
/** The coins' centres stay a millimetre inside the floor's sides, clear of the gutters. */
const ROW_HALF_SPAN = PLAYFIELD.fieldHalfWidth - COIN.radius - 0.001;

interface Row {
  readonly z: number;
  readonly xs: readonly number[];
}

/** A hexagonal layer's rows, front first, alternating full and offset. */
function layer(front: number, backLimit: number): Row[] {
  const full = Math.floor((2 * ROW_HALF_SPAN) / PITCH) + 1;
  const rows: Row[] = [];
  for (let z = front; z - COIN.radius >= backLimit; z -= ROW_SPACING) {
    const count = rows.length % 2 === 0 ? full : full - 1;
    const start = -((count - 1) * PITCH) / 2;
    rows.push({ z, xs: Array.from({ length: count }, (_, k) => start + k * PITCH) });
  }
  return rows;
}

/**
 * The layer that rests on `below`: one coin over each hollow formed by two neighbours
 * in a row and the coin between them in the row in front, where it rests on all three.
 */
function hollows(below: readonly Row[]): Row[] {
  return below.slice(1).map((row) => ({
    z: row.z + ROW_SPACING / 3,
    xs: row.xs.slice(1).map((x) => x - PITCH / 2),
  }));
}

/** Every lattice point of the full heap, in laying order; a heap of n coins takes the first n. */
function lattice(geometry: HeapGeometry): Vector[] {
  const { upperLipZ, reachZ, upperY } = geometry;
  const { lipInset, reachClearance, gap } = HEAP_TUNING;
  const lower = layer(PLAYFIELD.fieldFrontZ - lipInset, reachZ + reachClearance);
  const upper = layer(upperLipZ - lipInset, BACKBOARD.frontZ + gap);
  const layers: [readonly Row[], number][] = [
    [lower, LIE_Y],
    [upper, upperY + LIE_Y],
  ];
  if (geometry.secondLayer ?? true) {
    layers.push(
      [hollows(upper), upperY + LIE_Y + LAYER_RISE],
      [hollows(lower), LIE_Y + LAYER_RISE],
    );
  }
  const clear = geometry.keepClear ?? [];
  const points: Vector[] = [];
  for (const [rows, y] of layers) {
    for (const { z, xs } of rows) {
      for (const x of xs) {
        const blocked = clear.some((spot) => {
          const dx = x - spot.x;
          const dz = z - spot.z;
          const reach = spot.radius + COIN.radius + gap;
          return dx * dx + dz * dz < reach * reach;
        });
        if (!blocked) points.push({ x, y, z });
      }
    }
  }
  return points;
}

/** How many coins the opening heap holds on this geometry. */
export function heapCapacity(geometry: HeapGeometry): number {
  return lattice(geometry).length;
}

/**
 * The first `count` poses of the heap, each nudged off its lattice point and turned to
 * a heading drawn from `rng`. Throws if `count` is more than the heap holds.
 */
export function heapPoses(count: number, geometry: HeapGeometry, rng: Xoshiro128ss): HeapPose[] {
  const points = lattice(geometry);
  if (!Number.isInteger(count) || count < 0 || count > points.length) {
    throw new RangeError(
      `Opening heap: count must be an integer in [0, ${points.length}], got ${count}`,
    );
  }
  const { jitter } = HEAP_TUNING;
  return points.slice(0, count).map((point) => ({
    translation: {
      x: point.x + rng.nextRange(-jitter, jitter),
      y: point.y,
      z: point.z + rng.nextRange(-jitter, jitter),
    },
    rotation: randomHeading(rng),
  }));
}

/** A turn about the vertical axis, uniform over the circle, from + − * / and sqrt only. */
function randomHeading(rng: Xoshiro128ss): Rotation {
  for (;;) {
    const c = rng.nextRange(-1, 1);
    const s = rng.nextRange(-1, 1);
    const lengthSq = c * c + s * s;
    if (lengthSq > 1e-6 && lengthSq <= 1) {
      const length = Math.sqrt(lengthSq);
      return { x: 0, y: s / length, z: 0, w: c / length };
    }
  }
}
