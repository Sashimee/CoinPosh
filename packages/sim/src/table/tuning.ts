import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { FIXED_DT, GRAVITY, SOLVER } from '../constants.ts';

/**
 * Coin body material. A real 27 mm brass token is dense (8.7 g/cm³), barely bounces
 * on felt-lined steel and slides a short way before stopping. These values give
 * that "heavy" read:
 *
 * - friction 0.25 (brass on brass; the floor's 0.42 averages to 0.34 under a coin):
 *   a heap's angle of repose is about 14 degrees, so the upper tier spreads toward
 *   the lip as the pusher works it instead of standing as a steep mound. At 0.3 and
 *   above the upper tier could lock into a mound five coins deep that rode the
 *   pusher back and forth without ever spilling.
 * - restitution 0.06 (combined with Min, so the table never adds bounce): a drop
 *   from the chute lands with one tiny hop, at most about 1.5 mm, then lies flat.
 * - linearDamping 0.05: almost none, so a coin knocked over the front edge keeps its
 *   momentum and the fall reads as weight, not drag.
 * - angularDamping 0.6: kills the long "wobbling plate" spin a thin cylinder gets from
 *   an edge landing; the coin rings down in about half a second instead of five.
 */
export const COIN_MATERIAL = {
  friction: 0.25,
  restitution: 0.06,
  linearDamping: 0.05,
  angularDamping: 0.6,
  /**
   * Soft-CCD prediction distance in metres. Rapier's swept CCD misses a flat coin
   * falling face first (a 12 cm drop tunnels straight through the upper tier); soft
   * CCD widens the contact prediction instead and catches it.
   */
  softCcdPrediction: 0.03,
  /**
   * Soft CCD is switched on only above this speed (m/s), checked after every step.
   * A slower coin moves under 5 mm a tick and needs none, and keeping the widened
   * prediction off the slow pile cut the narrow phase by half and the deep overlaps
   * by a third on the full table.
   */
  softCcdSpeed: 0.3,
} as const;

/**
 * Cabinet materials. The floor grips harder than coin on coin, so the bottom layer
 * of a pushed sheet does not skate out from under the coins above it. Walls and
 * backboard are polished and slicker, so a coin dragged along a wall does not climb
 * it and the backboard scrapes coins forward instead of pinning them. The pusher
 * top (0.2, 0.225 against a coin) is slicker than the floor: coins ride it forward,
 * but on the return the ones held by the backboard slip over the retreating block
 * instead of being dragged hard into the board, which is what lets the upper tier
 * creep forward and drain over the lip.
 */
export const TABLE_MATERIAL = {
  floorFriction: 0.42,
  wallFriction: 0.15,
  pusherFriction: 0.2,
  restitution: 0.06,
} as const;

/**
 * Solver settings the table is tuned against, measured over 90 s of play on two
 * seeds with an exact minimum-translation overlap check between coin pairs (see
 * table.test.ts), sampled once a second from 30 s on, when the table is full.
 *
 * - worldScale 10: the table lives in the Rapier world at ten times its real size
 *   (a coin is 27 cm across inside the solver). At true scale the 2.6 mm coins hit
 *   f32 and GJK tolerance limits and rim-to-rim contacts between flat neighbours
 *   were missed outright. Everything the table exposes stays in metres; only the
 *   world is scaled, with gravity, the length unit, CCD distances and density
 *   scaled to match so the motion is unchanged.
 * - lengthUnit 0.03 m (SOLVER uses 0.1): Rapier lets a contact sink 0.005 length
 *   units deep before it pushes back, so at 0.1 it tolerated 0.5 mm, a fifth of a
 *   coin's thickness, and a working pile kept about 40 pairs past 0.5 mm at any
 *   moment, some interlocked for 19 s. At 0.03 it tolerates 0.15 mm. Setting the
 *   allowed error directly has no effect in rapier3d 0.21, so the length unit is
 *   the only lever. 0.02 was slightly tighter still but needs the same 2 mm
 *   look-ahead (below), which then costs 4.3 ms a tick.
 * - normalizedPredictionDistance 0.067: a contact look-ahead of 2 mm real. A coin
 *   dropped from the chute covers about that much in one substep when it lands;
 *   with a 0.8 mm look-ahead it sank 4.5 mm into the pusher top before the contact
 *   caught it. At 2 mm the worst of 12 drops sinks 0.4 mm and hops 1.5 mm.
 * - contactNaturalFrequency 360 Hz (Rapier default 30): at 30 Hz the thin coins
 *   sink 1 to 1.5 mm into each other under the weight of a stack and the upper
 *   tier clogs. 240 Hz left 1.5 times as many deep pairs as 360; 480 was no better.
 * - substeps 2 at numSolverIterations 3: the narrow phase runs once per substep,
 *   and a stale contact set between runs is what lets flat neighbours slide into
 *   each other rim first (one step of 6 iterations was four times worse). Three
 *   substeps halve the deep pairs again but cost 4.3 to 4.9 ms a tick, over the
 *   4 ms budget; 2 iterations at 2 substeps tripled them.
 *
 * Measured with these settings (0x7ab1e001 and 12345, 61 samples each): about 10 of
 * 700 touching pairs past 0.5 mm per sample (was 40), 102 and 95 pair-samples
 * still past it a second later (was 1492), none for longer than 6 s, and a few
 * transient pairs at 2 to 5 mm while the pusher loads the pile. The remaining
 * deep pairs are mostly two flat coins side by side on the same surface whose
 * contact manifold Rapier reports empty although their rims overlap; a rounded
 * cylinder or a 16-sided hull for the coin made the pile worse, not better.
 *
 * Nothing on a full table sleeps: rapier3d 0.21 exposes no sleep thresholds, a body
 * only sleeps with its whole contact island, and the moving pusher wakes every coin
 * it touches, which on a full table connect to nearly all the others. The 4 ms
 * budget is for 250 coins all awake.
 */
export const TABLE_SOLVER = {
  worldScale: 10,
  substeps: 2,
  lengthUnit: 0.03,
  normalizedPredictionDistance: 0.067,
  numSolverIterations: 3,
  maxCcdSubsteps: SOLVER.maxCcdSubsteps,
  contactNaturalFrequency: 360,
} as const;

/**
 * Applies the fixed timestep, gravity and TABLE_SOLVER to a world the table will
 * live in. The world must hold nothing but the table: it runs at worldScale.
 */
export function configureTableWorld(world: World): void {
  const scale = TABLE_SOLVER.worldScale;
  world.timestep = FIXED_DT / TABLE_SOLVER.substeps;
  world.gravity = { x: GRAVITY.x * scale, y: GRAVITY.y * scale, z: GRAVITY.z * scale };
  const p = world.integrationParameters;
  p.lengthUnit = TABLE_SOLVER.lengthUnit * scale;
  p.normalizedPredictionDistance = TABLE_SOLVER.normalizedPredictionDistance;
  p.numSolverIterations = TABLE_SOLVER.numSolverIterations;
  p.maxCcdSubsteps = TABLE_SOLVER.maxCcdSubsteps;
  p.contact_natural_frequency = TABLE_SOLVER.contactNaturalFrequency;
}
