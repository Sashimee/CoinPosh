import { rateEnvelopeDerivation } from '@coinposh/economy';
import type { NudgeDirection, TableCrate } from '@coinposh/shared';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import { CRATE_SIZE } from '../../vfx/cinematics/unbox/stage.ts';
import type { TablePoint } from '../systems/events.ts';

const HALF = CRATE_SIZE / 2;
/** Upper-tier spot the crate drops onto from the chute, just behind the pusher's reach. */
const SPAWN_Z = RIVIERA_TABLE.pusherFrontZ - 0.01;
/** Front of the pusher block at full stroke: past it the crate steps down to the lower tier. */
const STEP_Z = RIVIERA_TABLE.pusherFrontZ + RIVIERA_TABLE.pusherStroke;
/**
 * Share of the pusher's forward travel the crate rides along with. The heap slips under it,
 * so it creeps rather than surfs: about two and a half strokes from the chute to the lip.
 */
const CARRY = 0.6;
/** Even with the pusher held (a Concierge freeze), the pile settles it forward this fast. */
const CREEP_M_PER_S = 0.0015;
/** A forward nudge shoves it this far; a side nudge rocks it across. */
const NUDGE_FORWARD_M = 0.01;
const NUDGE_SIDE_M = 0.008;
/** It hangs over the lip from here, centre short of the edge. */
const TEETER_Z = RIVIERA_TABLE.fieldFrontZ - HALF * 0.4;
/** Past this its centre is over the edge and it goes. */
const TIP_Z = RIVIERA_TABLE.fieldFrontZ + HALF * 0.35;
const MAX_TILT = 1.1;
const SIDE_LIMIT = RIVIERA_TABLE.fieldHalfWidth - HALF;
const SPREAD_X = 0.05;

export type CrateRidePhase = 'riding' | 'teeter' | 'fell';

/**
 * Seconds a crate may sit on the table, from the economy's derivation: it never tips before
 * `min` (so its claim tick is always after its spawn tick) and the pile always pushes it off
 * by `max`, even if the pusher stalls.
 */
export const CRATE_RIDE_SECONDS = rateEnvelopeDerivation.crateFallSeconds;

/**
 * A crate's path across the table. The sim has no crate body yet, so the crate is a kinematic
 * passenger of the pusher: it rides each forward stroke, holds on the return, steps down to the
 * lower tier and teeters at the lip before it goes over the front edge. The server still judges
 * the claim; this only decides when the client reports it.
 */
export class CrateRide {
  readonly crate: TableCrate;
  private x: number;
  private z = SPAWN_Z;
  private lastStroke: number;
  private elapsed = 0;
  private stage: CrateRidePhase = 'riding';

  constructor(crate: TableCrate, stroke: number) {
    this.crate = crate;
    this.x = spawnX(crate.id);
    this.lastStroke = clampStroke(stroke);
  }

  get phase(): CrateRidePhase {
    return this.stage;
  }

  get seconds(): number {
    return this.elapsed;
  }

  /** Centre of the crate's base, in table metres. */
  get position(): TablePoint {
    const lower = this.z - HALF > STEP_Z;
    return { x: this.x, y: lower ? 0 : RIVIERA_TABLE.pusherHeight, z: this.z };
  }

  /** Forward pitch in radians as it hangs over the lip. */
  get tilt(): number {
    if (this.z <= TEETER_Z) return 0;
    return Math.min(1, (this.z - TEETER_Z) / (TIP_Z - TEETER_Z)) * MAX_TILT;
  }

  /** `stroke` is the pusher's extension, 0 retracted to 1 at full reach. */
  update(dt: number, stroke: number): CrateRidePhase {
    if (this.stage === 'fell') return this.stage;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.elapsed += step;
    const next = clampStroke(stroke);
    const forward = Math.max(0, next - this.lastStroke) * RIVIERA_TABLE.pusherStroke;
    this.lastStroke = next;
    this.advance(forward * CARRY + CREEP_M_PER_S * step);
    if (this.elapsed >= CRATE_RIDE_SECONDS.max) this.z = Math.max(this.z, TIP_Z);
    return this.settle();
  }

  nudge(direction: NudgeDirection, strength = 1): void {
    if (this.stage === 'fell') return;
    const s = Math.min(1, Math.max(0, strength));
    if (direction === 'forward') this.advance(NUDGE_FORWARD_M * s);
    else this.x = clampSide(this.x + (direction === 'left' ? -1 : 1) * NUDGE_SIDE_M * s);
    this.settle();
  }

  private advance(metres: number): void {
    this.z += metres;
    if (this.elapsed < CRATE_RIDE_SECONDS.min) this.z = Math.min(this.z, TEETER_Z);
  }

  private settle(): CrateRidePhase {
    if (this.z >= TIP_Z) this.stage = 'fell';
    else if (this.z >= TEETER_Z) this.stage = 'teeter';
    return this.stage;
  }
}

function clampStroke(stroke: number): number {
  return Number.isFinite(stroke) ? Math.min(1, Math.max(0, stroke)) : 0;
}

function clampSide(x: number): number {
  return Math.min(SIDE_LIMIT, Math.max(-SIDE_LIMIT, x));
}

/** Spreads crates across the chute mouth by id, so two in a row don't stack on one spot. */
function spawnX(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return clampSide((((hash >>> 0) / 0xffffffff) * 2 - 1) * SPREAD_X);
}
