import { COIN } from '../coin.ts';
import {
  BACKBOARD,
  GUTTER_START_Z,
  PLAYFIELD,
  PUSHER,
  TABLE_INNER_HALF_WIDTH,
} from '../table/layout.ts';
import { DEFAULT_PUSHER_MOTION, pusherExtension } from '../table/pusher.ts';
import { COIN_MATERIAL } from '../table/tuning.ts';
import {
  type Box,
  type Disc,
  type DiscShape,
  discAxis,
  discBoxDepth,
  discReach,
  discDiscDepth,
} from './geometry.ts';
import {
  type CoinPose,
  dequantizePosition,
  dequantizeRotation,
  POSITION_UNIT,
  ROTATION_UNIT,
  SIM_SNAPSHOT_VERSION,
  type SimTableSnapshot,
} from './snapshot.ts';

export type PoseRejection =
  'non_finite' | 'bad_rotation' | 'out_of_bounds' | 'in_pusher' | 'overlap' | 'frozen_unsupported';

export type PoseVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: PoseRejection };

export interface SnapshotVerdict {
  /** The poses a restore can take, in ascending id order. */
  readonly ok: CoinPose[];
  /** Why each other pose was dropped; `id` is NaN for a pose without an integer id. */
  readonly dropped: { readonly id: number; readonly reason: PoseRejection }[];
}

/**
 * How deep a pose may sit in the pusher block or the cabinet. Coins are held apart from
 * them by Rapier's contact skin and the separation pass, so anything deeper was not left
 * there by the sim.
 */
export const POSE_OVERLAP_TOLERANCE = 0.001;
/**
 * How deep a pose may sit in another coin. Two awake coins meeting mid-tick sink further
 * than into the cabinet: the deepest in 3 seeds of a minute of drops, every tick
 * snapshotted, was 1.02 mm, so this keeps twice the 1 mm a resting pair never reaches.
 */
export const COIN_OVERLAP_TOLERANCE = 0.002;
/** The decoded quaternion's norm must be within this of 1 before it is renormalized. */
export const ROTATION_NORM_TOLERANCE = 1e-3;

/** The coin collider's shape in metres, as the table builds it. */
export const COIN_SHAPE: DiscShape = {
  coreHalfHeight: COIN.halfThickness - COIN_MATERIAL.rimRadius,
  coreRadius: COIN.radius - COIN_MATERIAL.rimRadius,
  rim: COIN_MATERIAL.rimRadius,
};

/**
 * How far past the front edge a coin falling off it may be, in metres: from the floor's
 * top to fallY takes 0.08 s, so this allows leaving the edge at over 1 m/s. The furthest
 * in 3 seeds of a minute of drops, every tick snapshotted, was 2.3 cm.
 */
export const FRONT_FALL_REACH = 0.1;

/**
 * The space a coin's centre may be in, in POSITION_UNIT, each a whole number of units.
 * No coin reaches less than COIN.halfThickness toward a wall, so a tilted coin can sit
 * that close to the side walls or the backboard; a coin hangs over the gutters and the
 * front edge until its centre drops below PLAYFIELD.fallY, when the table removes it,
 * and over the open front no further than a coin's radius before it does, unless it is
 * below the pusher's top and so flying off the front, out to FRONT_FALL_REACH. The
 * cabinet's colliders (cabinetBoxes) bound it more tightly.
 */
const LIMIT_X = Math.round((TABLE_INNER_HALF_WIDTH - COIN.halfThickness) / POSITION_UNIT);
const LIMIT_Z_MIN = Math.round((BACKBOARD.frontZ + COIN.halfThickness) / POSITION_UNIT);
const LIMIT_Z_MAX = Math.round((PLAYFIELD.fieldFrontZ + COIN.radius) / POSITION_UNIT);
const LIMIT_Z_FALLING = Math.round((PLAYFIELD.fieldFrontZ + FRONT_FALL_REACH) / POSITION_UNIT);
const LIMIT_Y_MIN = Math.round(PLAYFIELD.fallY / POSITION_UNIT);
const LIMIT_Y_MAX = Math.round(PLAYFIELD.wallHeight / POSITION_UNIT);
const FALLING_Y_MAX = Math.round(PUSHER.height / POSITION_UNIT);
const FLOOR_HALF_X = Math.round(PLAYFIELD.fieldHalfWidth / POSITION_UNIT);
const FLOOR_FRONT_Z = Math.round(PLAYFIELD.fieldFrontZ / POSITION_UNIT);
const REST_STATES: readonly string[] = ['awake', 'asleep', 'frozen'];
const OVERLAP_CELL = 2 * COIN.radius;

/** The pusher block at `tickInCycle` of the default motion, in metres. */
export function pusherBox(tickInCycle: number): Box {
  assertTickInCycle(tickInCycle);
  const { stroke, periodTicks, pushFraction } = DEFAULT_PUSHER_MOTION;
  const offset = pusherExtension(tickInCycle / periodTicks, pushFraction) * stroke;
  return {
    x: 0,
    y: PUSHER.height / 2,
    z: PUSHER.frontZ + offset - PUSHER.depth / 2,
    hx: PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance,
    hy: PUSHER.height / 2,
    hz: PUSHER.depth / 2,
  };
}

/** The lower-tier floor, side walls and backboard as PusherTable builds them, in metres. */
function cabinetBoxes(): Box[] {
  const { fieldHalfWidth, fieldFrontZ, floorThickness, wallThickness, wallHeight } = PLAYFIELD;
  const backZ = PUSHER.frontZ - PUSHER.depth;
  const wallBottom = -floorThickness;
  const wallY = (wallHeight + wallBottom) / 2;
  const wallHy = (wallHeight - wallBottom) / 2;
  const boardBottom = PUSHER.height - BACKBOARD.embed;
  const boxes: Box[] = [
    {
      x: 0,
      y: -floorThickness / 2,
      z: (fieldFrontZ + backZ) / 2,
      hx: fieldHalfWidth,
      hy: floorThickness / 2,
      hz: (fieldFrontZ - backZ) / 2,
    },
    {
      x: 0,
      y: (wallHeight + boardBottom) / 2,
      z: BACKBOARD.frontZ - wallThickness / 2,
      hx: fieldHalfWidth,
      hy: (wallHeight - boardBottom) / 2,
      hz: wallThickness / 2,
    },
  ];
  for (const side of [-1, 1]) {
    boxes.push(
      {
        x: side * (fieldHalfWidth + wallThickness / 2),
        y: wallY,
        z: (GUTTER_START_Z + backZ) / 2,
        hx: wallThickness / 2,
        hy: wallHy,
        hz: (GUTTER_START_Z - backZ) / 2,
      },
      {
        x: side * (TABLE_INNER_HALF_WIDTH + wallThickness / 2),
        y: wallY,
        z: (fieldFrontZ + GUTTER_START_Z) / 2,
        hx: wallThickness / 2,
        hy: wallHy,
        hz: (fieldFrontZ - GUTTER_START_Z) / 2,
      },
    );
  }
  return boxes;
}

const CABINET = cabinetBoxes();
const COIN_REACH = discReach(COIN_SHAPE);

/** Whether the coin's bounding sphere reaches the box at all, before the exact depth. */
function nearBox(disc: Disc, box: Box): boolean {
  return (
    Math.abs(disc.x - box.x) < box.hx + COIN_REACH &&
    Math.abs(disc.y - box.y) < box.hy + COIN_REACH &&
    Math.abs(disc.z - box.z) < box.hz + COIN_REACH
  );
}

function inCabinetWalls(disc: Disc): boolean {
  return CABINET.some(
    (box) => nearBox(disc, box) && discBoxDepth(COIN_SHAPE, disc, box) > POSE_OVERLAP_TOLERANCE,
  );
}

function assertTickInCycle(tickInCycle: number): void {
  if (!Number.isInteger(tickInCycle) || tickInCycle < 0 || tickInCycle >= PUSHER.periodTicks) {
    throw new RangeError(
      `pusherTickInCycle must be an integer in [0, ${PUSHER.periodTicks}), got ${tickInCycle}`,
    );
  }
}

/** The pose as a disc in metres. Only for a pose checkPose accepts. */
export function poseDisc(pose: CoinPose): Disc {
  const t = dequantizePosition(pose.p);
  const r = dequantizeRotation(pose.q);
  return { ...t, ...discAxis(r.x, r.y, r.z, r.w) };
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

function isIntTuple(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(isInt);
}

function idOf(pose: unknown): unknown {
  return typeof pose === 'object' && pose !== null ? (pose as { id?: unknown }).id : undefined;
}

/** Snapshots come back from storage, so a pose is checked as data of any shape. */
function isWellFormed(pose: unknown): pose is CoinPose {
  if (typeof pose !== 'object' || pose === null) {
    return false;
  }
  const { id, p, q, rest } = pose as Partial<Record<keyof CoinPose, unknown>>;
  return (
    isInt(id) &&
    id >= 0 &&
    isIntTuple(p, 3) &&
    isIntTuple(q, 4) &&
    typeof rest === 'string' &&
    REST_STATES.includes(rest)
  );
}

function isCanonicalRotation(q: CoinPose['q']): boolean {
  if (q.some((c) => c < -ROTATION_UNIT || c > ROTATION_UNIT)) {
    return false;
  }
  const [x, y, z, w] = q;
  if (w < 0 || (w === 0 && (q.find((c) => c !== 0) ?? 0) < 0)) {
    return false;
  }
  const norm = Math.sqrt(x * x + y * y + z * z + w * w) / ROTATION_UNIT;
  return Math.abs(norm - 1) <= ROTATION_NORM_TOLERANCE;
}

/**
 * Whether one coin's pose is one the sim could have left, with the pusher at
 * `pusherTickInCycle` of the default motion: reasons in the order they are tested.
 * Overlap with other coins needs the whole snapshot; see validateSnapshot. Throws for a
 * tick outside the cycle, which is the caller's fault rather than the pose's.
 */
export function checkPose(pose: CoinPose, pusherTickInCycle: number): PoseVerdict {
  const box = pusherBox(pusherTickInCycle);
  if (!isWellFormed(pose)) {
    return { ok: false, reason: 'non_finite' };
  }
  if (!isCanonicalRotation(pose.q)) {
    return { ok: false, reason: 'bad_rotation' };
  }
  if (pose.rest === 'frozen') {
    return { ok: false, reason: 'frozen_unsupported' };
  }
  const [x, y, z] = pose.p;
  if (
    Math.abs(x) > LIMIT_X ||
    y < LIMIT_Y_MIN ||
    y > LIMIT_Y_MAX ||
    z < LIMIT_Z_MIN ||
    z > (y < FALLING_Y_MAX ? LIMIT_Z_FALLING : LIMIT_Z_MAX) ||
    (y < 0 && Math.abs(x) < FLOOR_HALF_X && z < FLOOR_FRONT_Z)
  ) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  const disc = poseDisc(pose);
  if (inCabinetWalls(disc)) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  if (discBoxDepth(COIN_SHAPE, disc, box) > POSE_OVERLAP_TOLERANCE) {
    return { ok: false, reason: 'in_pusher' };
  }
  return { ok: true };
}

/**
 * Splits a snapshot into the poses a restore can take and the ones it must drop, with
 * why. Of two coins deeper in each other than COIN_OVERLAP_TOLERANCE the one with the
 * higher id is dropped; a coin is only compared with the coins kept before it. Throws
 * for a wrong version, a tick outside the cycle or a repeated id: those are not one
 * coin's fault.
 */
export function validateSnapshot(snapshot: SimTableSnapshot): SnapshotVerdict {
  const version: unknown = snapshot.version;
  if (version !== SIM_SNAPSHOT_VERSION) {
    throw new RangeError(
      `validateSnapshot: version must be ${SIM_SNAPSHOT_VERSION}, got ${String(version)}`,
    );
  }
  assertTickInCycle(snapshot.pusherTickInCycle);
  const coins: readonly unknown[] = snapshot.coins;
  const seen = new Set<unknown>();
  for (const pose of coins) {
    const id = idOf(pose);
    if (seen.has(id)) {
      throw new RangeError(`validateSnapshot: coin id ${String(id)} appears more than once`);
    }
    seen.add(id);
  }
  const ordered = [...coins].sort((a, b) => {
    const ia = idOf(a);
    const ib = idOf(b);
    return isInt(ia) && isInt(ib) ? ia - ib : 0;
  });
  const ok: CoinPose[] = [];
  const dropped: { id: number; reason: PoseRejection }[] = [];
  const cells = new Map<string, Disc[]>();
  for (const pose of ordered) {
    if (!isWellFormed(pose)) {
      const id = idOf(pose);
      dropped.push({ id: isInt(id) ? id : Number.NaN, reason: 'non_finite' });
      continue;
    }
    const verdict = checkPose(pose, snapshot.pusherTickInCycle);
    if (!verdict.ok) {
      dropped.push({ id: pose.id, reason: verdict.reason });
      continue;
    }
    const disc = poseDisc(pose);
    const ix = Math.floor(disc.x / OVERLAP_CELL);
    const iz = Math.floor(disc.z / OVERLAP_CELL);
    let overlaps = false;
    for (let cx = ix - 1; cx <= ix + 1 && !overlaps; cx++) {
      for (let cz = iz - 1; cz <= iz + 1 && !overlaps; cz++) {
        for (const other of cells.get(`${cx},${cz}`) ?? []) {
          if (discDiscDepth(COIN_SHAPE, other, disc) > COIN_OVERLAP_TOLERANCE) {
            overlaps = true;
            break;
          }
        }
      }
    }
    if (overlaps) {
      dropped.push({ id: pose.id, reason: 'overlap' });
      continue;
    }
    const key = `${ix},${iz}`;
    const cell = cells.get(key);
    if (cell) {
      cell.push(disc);
    } else {
      cells.set(key, [disc]);
    }
    ok.push(pose);
  }
  return { ok, dropped };
}

const CRATE_SIZE = 0.042;
const CRATE_HALF = CRATE_SIZE / 2;

/**
 * A crate's ride across the table, in metres and seconds: the crate is a kinematic
 * passenger of the pusher, driven by CrateRide in the web client, and the server judges
 * a restored crate from the same numbers.
 *
 * - spawnZ: the upper-tier spot it drops onto, just behind the pusher's front face.
 * - stepZ: the front of the block at full stroke; past it the crate steps down.
 * - carry 0.6: share of the pusher's forward travel it rides along with, so it creeps
 *   about two and a half strokes from the chute to the lip.
 * - creepPerSecond: how fast the pile settles it forward with the pusher held.
 * - nudgeForward, nudgeSide: how far a forward nudge shoves it and a side nudge rocks it.
 * - teeterZ: it hangs over the lip from here; tipZ: past this its centre is over the
 *   edge and it goes.
 * - sideLimit: its centre stays this far from the middle, inside the walls.
 */
export const CRATE_RIDE = {
  size: CRATE_SIZE,
  spawnZ: PUSHER.frontZ - 0.01,
  stepZ: PUSHER.frontZ + PUSHER.stroke,
  carry: 0.6,
  creepPerSecond: 0.0015,
  nudgeForward: 0.01,
  nudgeSide: 0.008,
  teeterZ: PLAYFIELD.fieldFrontZ - CRATE_HALF * 0.4,
  tipZ: PLAYFIELD.fieldFrontZ + CRATE_HALF * 0.35,
  maxTilt: 1.1,
  sideLimit: PLAYFIELD.fieldHalfWidth - CRATE_HALF,
  spreadX: 0.05,
} as const;

export interface CratePose {
  /** In POSITION_UNIT. */
  readonly x: number;
  /** In POSITION_UNIT. */
  readonly z: number;
  /** Ride time so far, in whole milliseconds. */
  readonly elapsedMs: number;
  readonly phase: 'riding' | 'teeter';
}

export type CrateRejection = 'non_finite' | 'out_of_bounds' | 'bad_phase' | 'bad_elapsed';

export type CrateVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: CrateRejection };

/** CRATE_RIDE's limits in POSITION_UNIT, rounded to the nearest unit as a pose is. */
const CRATE_SIDE = Math.round(CRATE_RIDE.sideLimit / POSITION_UNIT);
const CRATE_SPAWN_Z = Math.round(CRATE_RIDE.spawnZ / POSITION_UNIT);
const CRATE_TEETER_Z = Math.round(CRATE_RIDE.teeterZ / POSITION_UNIT);
const CRATE_TIP_Z = Math.round(CRATE_RIDE.tipZ / POSITION_UNIT);

function isWellFormedCrate(pose: unknown): pose is CratePose {
  if (typeof pose !== 'object' || pose === null) {
    return false;
  }
  const { x, z, elapsedMs, phase } = pose as Partial<Record<keyof CratePose, unknown>>;
  return isInt(x) && isInt(z) && isInt(elapsedMs) && (phase === 'riding' || phase === 'teeter');
}

/**
 * Whether a crate's ride state is one CrateRide could be in. `maxRideSeconds` is the
 * economy's crateFallSeconds.max, which packages/sim cannot import: by then the pile has
 * always pushed the crate off. Throws for a `maxRideSeconds` that is not a positive
 * number.
 */
export function checkCratePose(pose: CratePose, maxRideSeconds: number): CrateVerdict {
  if (!(Number.isFinite(maxRideSeconds) && maxRideSeconds > 0)) {
    throw new RangeError(
      `checkCratePose: maxRideSeconds must be a positive number, got ${maxRideSeconds}`,
    );
  }
  if (!isWellFormedCrate(pose)) {
    return { ok: false, reason: 'non_finite' };
  }
  if (Math.abs(pose.x) > CRATE_SIDE || pose.z < CRATE_SPAWN_Z || pose.z >= CRATE_TIP_Z) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  if (pose.z >= CRATE_TEETER_Z !== (pose.phase === 'teeter')) {
    return { ok: false, reason: 'bad_phase' };
  }
  if (pose.elapsedMs < 0 || pose.elapsedMs > maxRideSeconds * 1000) {
    return { ok: false, reason: 'bad_elapsed' };
  }
  return { ok: true };
}
