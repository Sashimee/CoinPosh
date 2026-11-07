import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { FIXED_DT, SOLVER } from '../constants.ts';

/**
 * Coin body material. A real 27 mm brass token is dense (8.7 g/cm³), barely bounces
 * on felt-lined steel and slides a short way before stopping. These values give
 * that "heavy" read:
 *
 * - friction 0.42: brass on brushed steel. Coins shove each other as a sheet instead
 *   of skating apart, yet a coin nudged over the lip still slides off cleanly.
 * - restitution 0.06 (combined with Min, so the table never adds bounce): a drop
 *   from the chute lands with one tiny hop, under 1 mm, then lies flat.
 * - linearDamping 0.05: almost none, so a coin knocked over the front edge keeps its
 *   momentum and the fall reads as weight, not drag.
 * - angularDamping 0.6: kills the long "wobbling plate" spin a thin cylinder gets from
 *   an edge landing; the coin rings down in about half a second instead of five.
 */
export const COIN_MATERIAL = {
  friction: 0.42,
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
 * Cabinet materials. The floor matches the coins so a pushed sheet moves as one.
 * Walls and backboard are polished and slicker, so a coin dragged along a wall does
 * not climb it and the backboard scrapes coins forward instead of pinning them.
 * The pusher is a little slicker than the floor: coins still ride it forward, but on
 * the return the ones held by the backboard slip over the retreating block instead
 * of being dragged hard into the board, which is what lets the upper tier creep
 * forward and drain over the lip.
 */
export const TABLE_MATERIAL = {
  floorFriction: 0.42,
  wallFriction: 0.15,
  pusherFriction: 0.3,
  restitution: 0.06,
} as const;

/**
 * Solver settings the table is tuned against. Only the contact stiffness differs
 * from the generic SOLVER defaults. contactNaturalFrequency 120 Hz (Rapier default 30):
 * at 30 Hz the thin 2.6 mm coins sink 1 to 1.5 mm into each other, the upper tier
 * clogs into a soft, interlocked heap that never drains over the lip, and the solver
 * costs twice as much chasing the overlap. At 120 Hz stacks sit within 0.2 mm of
 * their true spacing and the upper tier drains; stiffer starts to rattle.
 *
 * More solver iterations (6 or 8) trimmed the worst overlap in a static pile but made
 * no visible difference on the moving table and cost 0.5 to 1 ms a step, so the
 * table keeps SOLVER's 4.
 */
export const TABLE_SOLVER = {
  lengthUnit: SOLVER.lengthUnit,
  numSolverIterations: SOLVER.numSolverIterations,
  maxCcdSubsteps: SOLVER.maxCcdSubsteps,
  contactNaturalFrequency: 120,
} as const;

/** Applies the fixed timestep and TABLE_SOLVER to a world the table will live in. */
export function configureTableWorld(world: World): void {
  world.timestep = FIXED_DT;
  const p = world.integrationParameters;
  p.lengthUnit = TABLE_SOLVER.lengthUnit;
  p.numSolverIterations = TABLE_SOLVER.numSolverIterations;
  p.maxCcdSubsteps = TABLE_SOLVER.maxCcdSubsteps;
  p.contact_natural_frequency = TABLE_SOLVER.contactNaturalFrequency;
}
