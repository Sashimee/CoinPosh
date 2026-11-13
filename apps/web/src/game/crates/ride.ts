import { rateEnvelopeDerivation } from '@coinposh/economy';
import type { NudgeDirection, TableCrate } from '@coinposh/shared';
import { checkCratePose, CRATE_RIDE, type CratePose, POSITION_UNIT } from '@coinposh/sim/snapshot';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import type { TablePoint } from '../systems/events.ts';

const HALF = CRATE_RIDE.size / 2;
/**
 * The teeter and tip lines on the pose grid, rounded as checkCratePose rounds them: a
 * snapshot clamps to them, so a crate a few µm short of a line never poses past it.
 */
const POSE_TEETER_Z = Math.round(CRATE_RIDE.teeterZ / POSITION_UNIT);
const POSE_TIP_Z = Math.round(CRATE_RIDE.tipZ / POSITION_UNIT);

export type CrateRidePhase = 'riding' | 'teeter' | 'fell';

/**
 * Seconds a crate may sit on the table, from the economy's derivation: it never tips before
 * `min` (so its claim tick is always after its spawn tick) and the pile always pushes it off
 * by `max`, even if the pusher stalls.
 */
export const CRATE_RIDE_SECONDS = rateEnvelopeDerivation.crateFallSeconds;

const POSE_MAX_ELAPSED_MS = Math.floor(CRATE_RIDE_SECONDS.max * 1000);

/**
 * A crate's path across the table. The sim has no crate body yet, so the crate is a kinematic
 * passenger of the pusher: it rides each forward stroke, holds on the return, steps down to the
 * lower tier and teeters at the lip before it goes over the front edge. The server still judges
 * the claim; this only decides when the client reports it. Its bounds are CRATE_RIDE, the
 * numbers the server judges a restored crate by.
 */
export class CrateRide {
  readonly crate: TableCrate;
  private x: number;
  private z: number = CRATE_RIDE.spawnZ;
  private lastStroke: number;
  private elapsed = 0;
  private stage: CrateRidePhase = 'riding';

  constructor(crate: TableCrate, stroke: number) {
    this.crate = crate;
    this.x = spawnX(crate.id);
    this.lastStroke = clampStroke(stroke);
  }

  /**
   * Resumes a ride from a pose the server kept. `stroke` is the restored pusher's extension:
   * forward travel counts from there, so the first stroke after a reload does not jump the
   * crate. Throws for a pose checkCratePose refuses.
   */
  static restore(crate: TableCrate, pose: CratePose, stroke: number): CrateRide {
    const verdict = checkCratePose(pose, CRATE_RIDE_SECONDS.max);
    if (!verdict.ok) {
      throw new RangeError(
        `CrateRide.restore: crate ${crate.id} has an invalid pose (${verdict.reason}); leave it off the table and let the server settle it`,
      );
    }
    const ride = new CrateRide(crate, stroke);
    ride.seat(pose);
    return ride;
  }

  get phase(): CrateRidePhase {
    return this.stage;
  }

  get seconds(): number {
    return this.elapsed;
  }

  /** Centre of the crate's base, in table metres. */
  get position(): TablePoint {
    const lower = this.z - HALF > CRATE_RIDE.stepZ;
    return { x: this.x, y: lower ? 0 : RIVIERA_TABLE.pusherHeight, z: this.z };
  }

  /** Forward pitch in radians as it hangs over the lip. */
  get tilt(): number {
    const { teeterZ, tipZ, maxTilt } = CRATE_RIDE;
    if (this.z <= teeterZ) return 0;
    return Math.min(1, (this.z - teeterZ) / (tipZ - teeterZ)) * maxTilt;
  }

  /**
   * The ride state to persist, on the pose grid and always one checkCratePose accepts.
   *
   * The ride also takes that pose as its own state (a move of at most half a POSITION_UNIT
   * and half a millisecond): the server keeps only the last pose uploaded, so from here a
   * reload resumes on exactly the path this ride goes on to take, tipping on the same frame.
   * Throws once the crate has fallen: its claim is already in the outbox, so it is never posed.
   */
  snapshot(): CratePose {
    if (this.stage === 'fell') {
      throw new Error(
        `CrateRide.snapshot: crate ${this.crate.id} has fallen; leave it out of the table snapshot`,
      );
    }
    const z = whole(this.z / POSITION_UNIT);
    const pose: CratePose = {
      x: whole(this.x / POSITION_UNIT),
      z:
        this.stage === 'teeter'
          ? Math.min(Math.max(z, POSE_TEETER_Z), POSE_TIP_Z - 1)
          : Math.min(z, POSE_TEETER_Z - 1),
      elapsedMs: Math.min(Math.round(this.elapsed * 1000), POSE_MAX_ELAPSED_MS),
      phase: this.stage,
    };
    this.seat(pose);
    return pose;
  }

  /** `stroke` is the pusher's extension, 0 retracted to 1 at full reach. */
  update(dt: number, stroke: number): CrateRidePhase {
    if (this.stage === 'fell') return this.stage;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.elapsed += step;
    const next = clampStroke(stroke);
    const forward = Math.max(0, next - this.lastStroke) * RIVIERA_TABLE.pusherStroke;
    this.lastStroke = next;
    this.advance(forward * CRATE_RIDE.carry + CRATE_RIDE.creepPerSecond * step);
    if (this.elapsed >= CRATE_RIDE_SECONDS.max) this.z = Math.max(this.z, CRATE_RIDE.tipZ);
    return this.settle();
  }

  nudge(direction: NudgeDirection, strength = 1): void {
    if (this.stage === 'fell') return;
    const s = Math.min(1, Math.max(0, strength));
    if (direction === 'forward') this.advance(CRATE_RIDE.nudgeForward * s);
    else this.x = clampSide(this.x + (direction === 'left' ? -1 : 1) * CRATE_RIDE.nudgeSide * s);
    this.settle();
  }

  private seat(pose: CratePose): void {
    this.x = clampSide(pose.x * POSITION_UNIT);
    this.z = pose.z * POSITION_UNIT;
    // POSE_TEETER_Z can round below teeterZ; a teeter pose must stay over the lip.
    if (pose.phase === 'teeter') this.z = Math.max(this.z, CRATE_RIDE.teeterZ);
    this.elapsed = pose.elapsedMs / 1000;
    this.stage = pose.phase;
  }

  private advance(metres: number): void {
    this.z += metres;
    if (this.elapsed < CRATE_RIDE_SECONDS.min) this.z = Math.min(this.z, CRATE_RIDE.teeterZ);
  }

  private settle(): CrateRidePhase {
    if (this.z >= CRATE_RIDE.tipZ) this.stage = 'fell';
    else if (this.z >= CRATE_RIDE.teeterZ) this.stage = 'teeter';
    return this.stage;
  }
}

/** Math.round without the -0 that a pose would otherwise carry for a crate dead on centre. */
function whole(n: number): number {
  const r = Math.round(n);
  return r === 0 ? 0 : r;
}

function clampStroke(stroke: number): number {
  return Number.isFinite(stroke) ? Math.min(1, Math.max(0, stroke)) : 0;
}

function clampSide(x: number): number {
  return Math.min(CRATE_RIDE.sideLimit, Math.max(-CRATE_RIDE.sideLimit, x));
}

/** Spreads crates across the chute mouth by id, so two in a row don't stack on one spot. */
function spawnX(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return clampSide((((hash >>> 0) / 0xffffffff) * 2 - 1) * CRATE_RIDE.spreadX);
}
