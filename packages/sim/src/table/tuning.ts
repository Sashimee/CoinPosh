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
 *   from the chute lands with one tiny hop, under 1 mm, then lies flat.
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
 * of a pushed sheet does not skate out from under the coins above it. Walls and backboard are polished and slicker, so a coin dragged along a wall does
 * not climb it and the backboard scrapes coins forward instead of pinning them.
 * The pusher top (0.2, 0.225 against a coin) is slicker than the floor: coins ride it forward,
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
 * Solver settings the table is tuned against, measured on a 120-coin pile and on the
 * full 250-coin table with a geometric overlap check (sampled points of one coin
 * inside the other), because Rapier's own contact depths misreport for thin
 * cylinders.
 *
 * - worldScale 10: the table lives in the Rapier world at ten times its real size
 *   (a coin is 27 cm across inside the solver). At true scale the 2.6 mm coins hit
 *   f32 and GJK tolerance limits: rim-to-rim contacts between flat neighbours were
 *   missed or never resolved and a resting pile kept about 140 pairs interlocked
 *   deeper than 0.5 mm. At 10x the same pile keeps under 25. Everything the table
 *   exposes stays in metres; only the world is scaled, with gravity, the length
 *   unit, CCD distances and density scaled to match so the motion is unchanged.
 * - contactNaturalFrequency 120 Hz (Rapier default 30): at 30 Hz the thin coins sink
 *   1 to 1.5 mm into each other under the weight of a stack and the upper tier
 *   clogs into an interlocked heap that never drains. Contact compression goes as
 *   g / omega^2, so 120 Hz holds a stack within 0.1 mm per layer.
 * - substeps 2 at numSolverIterations 3: a 120 Hz contact needs short steps or many
 *   iterations; one 60 Hz step with 4 iterations jitters the pile. Two 120 Hz
 *   substeps of 3 iterations cost the same as one step of 8, halve how far a falling
 *   coin travels between contact checks, and left about two thirds as many deep
 *   overlaps. More iterations or substeps, stiffer contacts (180, 240 Hz) and extra
 *   PGS passes all left the overlap count where it was (about 4% of touching pairs
 *   past 0.5 mm, with a few briefly past 1 mm while the pusher is
 *   loading the pile) and only cost time. A contact skin of 0.1 to 0.3 mm made no
 *   measurable difference either. 2 iterations was cheaper but let the upper tier stall for over a
 *   minute on one seed.
 */
export const TABLE_SOLVER = {
  worldScale: 10,
  substeps: 2,
  lengthUnit: SOLVER.lengthUnit,
  numSolverIterations: 3,
  maxCcdSubsteps: SOLVER.maxCcdSubsteps,
  contactNaturalFrequency: 120,
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
  p.numSolverIterations = TABLE_SOLVER.numSolverIterations;
  p.maxCcdSubsteps = TABLE_SOLVER.maxCcdSubsteps;
  p.contact_natural_frequency = TABLE_SOLVER.contactNaturalFrequency;
}
