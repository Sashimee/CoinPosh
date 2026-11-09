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
 * - 3: 12 cm pusher stroke so the block sweeps the heap over the lip (P-120), nudge
 *   input, contact events, opening heap and fusion run inside Sim (P-111). Pinned
 *   table hash a4e6238cc93d4acc, sim hash c5b0aeb071b1065b (was 590da61d0e98c762),
 *   mechanics digest 729f6f15f07d6198 (was 5b133732fd75a28e).
 * - 4: the pusher's cam knocks at full reach (PUSHER_CAM, P-176), so a heap with room
 *   in front creeps forward instead of riding the block. Pinned table hash
 *   ee25f4b04dd687a6 (was a4e6238cc93d4acc), sim hash d715fa236eb0783f (was
 *   c5b0aeb071b1065b), mechanics digest 5935d058d1943638 (was 729f6f15f07d6198).
 * - 5: coins come to rest (COIN_REST, P-215): a coin still for half a second freezes
 *   in place, riding the block when it lies on the pusher top, until something moving
 *   wakes it; the separation pass moves and wakes frozen coins; the cam is a plain
 *   smoothstep again (the knock is gone). Pinned table hash 71d877a1ccb423be (was
 *   ee25f4b04dd687a6), sim hash 28d84a03ebbb1757 (was d715fa236eb0783f), mechanics
 *   digest 729f6f15f07d6198 again: its rig steps its own world with only the cam from
 *   the table, so it is back on the version 3 motion.
 * - 6: a push wakes the frozen coins in its way before the tick's substeps, passing on
 *   from coin to coin (COIN_REST cascade, P-215), so drops and the face move the pile
 *   they press on; frozen coins on the lower tier are fixed bodies. Pinned table hash
 *   8934f7ea73a155b0 (was 71d877a1ccb423be), sim hash bdd732e82cbaab2c (was
 *   28d84a03ebbb1757), nudge hash 4df094d60c3198e0 (was 884d44f49d22eee9), fused heap
 *   996bcdc84b3175fb (was cd8bafbb696a1667), opening heap 53ff5809aefa4642 (was
 *   1408f3ec4741a856), Demo pour 10 strokes bb41e00c43e62270 (was 55447c368ba0736d).
 *   The rest tests now run the Demo table through Sim (the economy's opening heap):
 *   idle 10 minutes 2c475ed06fbdb4fb and 2 minutes of drops 30afd7256494fcfe, against
 *   a044318612a6692b and d12afc06736517d7 for the 160-coin pour they replaced.
 *   Mechanics digest 729f6f15f07d6198 is unchanged.
 * - 7: tables restore from snapshots (Sim.create({ restore }), T-92.02), and the opening
 *   heap is laid through the same path, as every heap slot in order. Restoring the
 *   checked-in settled-table fixture (the poses validateSnapshot keeps, snapshot/
 *   restore.test.ts) hashes 3b0c71dac53f6038, 0609e515127fb408 after a second of drops
 *   and ae7e0b2e8272d895 after a minute. Fused heap 5659c314480b9ede (was
 *   996bcdc84b3175fb), idle Demo table 3e6951ced226e46a (was 2c475ed06fbdb4fb), 2
 *   minutes of drops b4f254b6bc329ea8 (was 30afd7256494fcfe); the scripted minute
 *   bdd732e82cbaab2c, nudge 4df094d60c3198e0, opening heap 53ff5809aefa4642 and Demo
 *   pour bb41e00c43e62270 are unchanged.
 */
export const SIM_VERSION = 7;
