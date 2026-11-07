export const TICK_RATE_HZ = 60;

/** Seconds per tick. Rapier stores it as f32, so the world reports 0.016666668. */
export const FIXED_DT = 1 / TICK_RATE_HZ;

/** World units are metres; +Y is up, +Z points from the back wall to the player. */
export const GRAVITY = { x: 0, y: -9.81, z: 0 } as const;

/**
 * Solver settings, pinned explicitly so a Rapier upgrade that changes a default
 * cannot silently change replays.
 *
 * - `lengthUnit` 0.1 m: Rapier scales its contact tolerances by it. At 0.1 the
 *   predictive contact margin is 2 mm and the allowed penetration 0.1 mm, so a coin
 *   lands cleanly at 1.5 m/s. Smaller values shrink the margin below one tick of
 *   travel and the coin sinks ~15 mm into the floor before being pushed out (a
 *   visible pop); 1 m costs ~30% more per step for no visible gain.
 * - 4 solver iterations: 8 cost ~30% more per step on a 180-coin heap with no
 *   visible difference at this stage. Revisit with the real table in T-1.01.
 */
export const SOLVER = {
  lengthUnit: 0.1,
  numSolverIterations: 4,
  maxCcdSubsteps: 1,
} as const;
