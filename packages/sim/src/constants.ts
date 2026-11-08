export const TICK_RATE_HZ = 60;

/** Seconds per tick. Rapier stores it as f32, so the world reports 0.016666668. */
export const FIXED_DT = 1 / TICK_RATE_HZ;

/** World units are metres; +Y is up, +Z points from the back wall to the player. */
export const GRAVITY = { x: 0, y: -9.81, z: 0 } as const;

/**
 * Engine-wide solver settings. The pusher table's world is configured from
 * TABLE_SOLVER in table/tuning.ts (applied by configureTableWorld), which documents
 * its world scale, substeps, length unit, look-ahead, iterations and contact
 * stiffness; it takes `maxCcdSubsteps` from here. Pinned explicitly so a Rapier
 * upgrade that changes a default cannot silently change replays.
 *
 * - 1 CCD substep: the coins' swept CCD only has to stop a drop from tunnelling
 *   into the pile; the table's impact brake (COIN_MATERIAL.impactSpeed) handles the
 *   fast coin-on-coin contacts CCD misses.
 */
export const SOLVER = {
  maxCcdSubsteps: 1,
} as const;

/**
 * Version of the simulation's replay output, recorded with every input log so the
 * auditor only replays a log against the sim that produced it. Bump it with every
 * change that moves a pinned hash (sim.test.ts, table/table.test.ts).
 *
 * - 1: placeholder tray (T-0.03).
 * - 2: the two-tier pusher table (T-1.01), stepped once per tick by Sim (P-42).
 *   Pinned table hash c090d32a142ce2b7 (was 0f07d3e911f71f99, then 18542c554c6831a6
 *   during T-1.01); pinned sim hash in sim.test.ts.
 */
export const SIM_VERSION = 2;
