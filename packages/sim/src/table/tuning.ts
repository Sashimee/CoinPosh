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
 *   from the chute lands with at most a tiny hop, 0.4 mm in the worst of 12 drops,
 *   then lies flat.
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
   * Coins faster than this (m/s) are cast along their motion before every substep
   * and braked against the first thing they would strike (PusherTable#absorbImpacts),
   * the momentum they lose going to the coin they strike. The cast reaches as far as
   * the gap could close with the coin struck coming the other way at the speed of the
   * fastest coin on the table, so two coins converging head on, each faster than the
   * cast of its own motion, meet instead of passing through. The solver alone lets fast
   * coins sink deep into the pile: on first contact Rapier builds a sparse manifold
   * (at most four points, only those inside the 2 mm look-ahead), so a coin arriving
   * at 1 m/s or more takes an off-centre impulse, spins, and its far rim slams
   * through the neighbour within the same substep. Neither swept CCD (blind to that
   * spin) nor soft CCD (which itself added 80 to 90 rad/s of spurious spin to a flat
   * drop) stopped it, and more solver iterations or a stiffer contact did not
   * either; a wider global look-ahead did, at 6 ms a tick. Below 0.3 m/s a coin
   * moves under 2.5 mm a substep and the ordinary contacts catch it. With the
   * separation pass (TABLE_SOLVER) but no brake, the deepest pair over a minute
   * reached 2.3 to 3.6 mm on the seven seeds measured: the pass only runs after the
   * step, when the spin has already been taken.
   */
  impactSpeed: 0.3,
  /** Gap in metres the brake leaves between a coin and what it would strike. */
  impactMargin: 0.0001,
  /**
   * Casts per coin per substep. Each cast skips what earlier casts found, so a coin
   * sliding fast along the floor or the pusher top, whose first hit is that surface
   * and not closing, still finds the coin it is sliding into.
   */
  impactPasses: 3,
  /**
   * Contact skin in metres: Rapier treats every coin as 0.3 mm larger all round, so
   * two coins push apart when their real surfaces are still 0.6 mm short of
   * touching. A pile settles with that hairline gap instead of resting at the
   * solver's allowed sink, and a squeezed pair has 0.6 mm of give before the real
   * shapes overlap. With the impact brake and 600 Hz contacts (TABLE_SOLVER),
   * 0.3 mm left 4 times fewer pair-ticks past 0.5 mm than 0.15 mm; 0.4 mm was no
   * better.
   */
  contactSkin: 0.0003,
  /**
   * The collider is a rounded cylinder with this edge radius in metres. Where two
   * sharp cylinder rims meet Rapier finds a poor contact normal and the pair
   * interpenetrates; N-gon hulls of 8 to 24 sides let a drop onto a resting coin
   * sink 4.9 to 7.1 mm, the rounded rim (with the impact brake) 0.3 mm. A 0.8 mm
   * rim was worse on the full table, 7.5 mm deepest against 2.9.
   */
  rimRadius: 0.0005,
} as const;

/**
 * Cabinet materials. The floor grips harder than coin on coin, so the bottom layer
 * of a pushed sheet does not skate out from under the coins above it. Walls and
 * backboard are polished and slicker, so a coin dragged along a wall does not climb
 * it and the backboard scrapes coins forward instead of pinning them. The pusher
 * top (0.2, 0.225 against a coin) is slicker than the floor: coins ride it forward,
 * but on the return the ones held by the backboard slip over the retreating block
 * instead of being dragged hard into the board. The backboard only holds coins that
 * reach it, though: a heap with room in front of it rides the block out and back as
 * one raft and never meets the board, and stays on it (COIN_REST).
 */
export const TABLE_MATERIAL = {
  floorFriction: 0.42,
  wallFriction: 0.15,
  pusherFriction: 0.2,
  restitution: 0.06,
} as const;

/**
 * Rest (P-215): rapier3d 0.21 exposes no sleep thresholds, and a body only sleeps with
 * its whole contact island, which on a working table is nearly every coin. Left awake, a
 * coin lying half on another see-sawed on it for good (53 mm/s and 178 °/s at worst over
 * an idle minute), and the coins on the pusher top crept off it: the Demo's opening heap
 * with nobody playing dropped 100 coins over the front lip in 10 minutes. So the table
 * freezes coins itself (PusherTable): a coin that stays within `drift` metres and `turn`
 * degrees of one pose for more than `ticks` ticks becomes a body that holds that pose
 * exactly: fixed on the lower tier, so Rapier does not move it or refit its bounds every
 * substep as it does a kinematic body, and kinematic on the pusher top. Its pose is
 * taken relative to the block there, and a frozen coin there rides the block, moved with
 * it every substep: the shelf
 * carries its coins with no slip at all. Friction cannot do that on its own: a higher
 * coefficient only delays the slip of a coin its neighbours jostle, and from 0.3 coin on
 * coin the upper tier locks into a mound (COIN_MATERIAL). A coin on the top whose centre
 * is past the block's front face never freezes; it is falling off.
 *
 * - drift 1 mm, turn 3°, ticks 30 (half a second): a pose window rather than a speed
 *   threshold, because a see-sawing coin is never slow for long but never gets
 *   anywhere either. 20 and 24 ticks freeze the coin below one balanced a full radius
 *   off its centre (rest.test.ts) while the top one is still tipping, and it rocks for
 *   seconds; 45 and 60 left the settling heap awake long enough to shed 6 and 9 coins
 *   over the lip after the first 10 s.
 * - slowSpeed 0.01 m/s, angularDamping 60: below that speed (relative to what it lies
 *   on) a coin's spin is damped hard, so it settles flat in a few ticks with the dead
 *   stop of a heavy coin instead of rocking on its rim.
 *
 * It wakes, back into a dynamic body carrying the velocity of what it lay on, when:
 * - a coin moving into it will touch it within the tick, or one that coin wakes will
 *   (the cascade below);
 * - a fast coin is about to strike it (the impact brake, COIN_MATERIAL.impactSpeed);
 * - an awake coin touching it, or closing on it within the tick, moves at more than
 *   `wakeSpeed` across it or `wakeFall` down onto it, or presses on it with a contact
 *   impulse over `wakeImpulse` in a substep;
 * - the pusher's face comes within `pusherMargin` of it, or, riding the block back,
 *   it comes within `pusherMargin` of the backboard, which then scrapes it;
 * - the separation pass moves it (CoinSeparator reports it in `loosened`);
 * - the cabinet is nudged, or a coin it may lean on is taken off the table.
 *
 * The cascade: woken only by contact after a tick, every frozen coin in a push was a
 * wall for the tick it was struck in, so a drop or the face moved the coin it touched
 * and little beyond, and the Demo heap paid 0.27 to 0.50 front falls per coin dropped.
 * So before each tick's substeps every awake coin moving faster than `cascadeSpeed`
 * across what it lies on, and every coin the face or the backboard wakes (at the
 * block's speed), wakes the frozen coins whose centres it reaches within the tick:
 * within a touch (two coin radii, the skin and `cascadeGap`) plus its travel, and
 * within the cone whose half-angle has cosine `cascadeConeCos` around its direction. Each coin woken passes the push on at
 * `cascadeKeep` of the speed for as long as that stays over `wakeSpeed`.
 * - cascadeSpeed 0.03 m/s: starting pushes from 0.01 m/s kept the jostle in a working
 *   pile waking itself, 42 coins frozen in table.bench.ts against 84, for 0.9 ms more
 *   at the 99th percentile. Passing pushes on only above 0.03 m/s, rather than down to
 *   `wakeSpeed`, stopped them a link or two from the face: 0.43 falls per drop at worst.
 * - cascadeConeCos 0.5 (60°, kept as a cosine since Math.cos is engine-approximated): a
 *   half-space (90°) also woke the coins beside a push, which it
 *   barely moves, and cost 0.3 ms at the 99th percentile; 45° was no cheaper.
 * - cascadeKeep 0.6: 0.5 left the worst case at 0.48 falls per drop.
 *
 * Measured with these values on the Demo heap (Sim with the worker's mechanics and the
 * economy's 100-coin silver opening heap, as in rest.test.ts) on ten seeds, the Demo's
 * among them: idle for 10 minutes, no coin over the front lip after the first 10 s and
 * the pusher top keeping all of its 77 coins; one drop every 2 s for 2 minutes,
 * scattered across the table, sweeping across it or near the centre line, 0.53 to 1.10
 * front falls per drop, 0.78 on average. Coins spread across the table build up on the
 * pusher top before they push its front row off (77 rising to as many as 93 in those
 * two minutes), so scattered drops pay the least, 0.53 to 0.73.
 */
export const COIN_REST = {
  drift: 0.001,
  turn: 3,
  ticks: 30,
  slowSpeed: 0.01,
  angularDamping: 60,
  wakeSpeed: 0.01,
  wakeFall: 0.08,
  wakeImpulse: 0.003,
  pusherMargin: 0.002,
  cascadeSpeed: 0.03,
  cascadeKeep: 0.6,
  cascadeGap: 0.0005,
  cascadeConeCos: 0.5,
} as const;

/**
 * The cabinet nudge: a shove to the whole cabinet that every coin feels at once, as a
 * change of velocity (m/s) the same for every coin whatever its mass, like the cabinet
 * jolting under the pile. Each tier's coins are on a surface that moved, so each one
 * gets the same kick and the pile shifts as one rather than squirting apart.
 *
 * - push 0.2 forward, sideways 0.15: on the coin-on-wood friction (about 0.34, so
 *   3.3 m/s² of braking), a coin sliding free travels 6 mm forward or 3.4 mm sideways.
 *   A packed pile shifts less, the coins at the lip just enough to tip one that was
 *   already hanging, so a nudge teases a ledge rather than clearing it. Sideways is
 *   gentler because the gutters are the house's: a shove toward them should cost the
 *   player a coin now and then, not a row.
 * - lift 0.12: a small hop (an airborne 25 ms, 0.7 mm high) that breaks the pile's
 *   static friction, so the horizontal kick moves coins instead of being swallowed by
 *   friction on contact. Kept under the impact brake's 0.3 m/s together with the push
 *   (0.23 m/s), so the brake never fires on a nudge and no contact event is faked.
 */
export const NUDGE = {
  push: 0.2,
  sideways: 0.15,
  lift: 0.12,
} as const;

/**
 * The Vault Crate as a rigid body (P-181): a 42 mm oak cube with brass corner straps
 * and the loot inside, dropped onto the upper tier and worked off the lip by the
 * pusher and the pile like any coin. Values in metres, kg/m³, m/s and ticks:
 *
 * - size 42 mm: about three coins across, so it reads as a prize among them and its
 *   centre has to travel a coin and a half past the lip before it tips.
 * - roundRadius 2 mm: rounded edges, like the coin's rim (COIN_MATERIAL.rimRadius),
 *   give clean contact normals against the thin coins, and let it roll over the lip
 *   rather than snag on it.
 * - density 1,100: about 80 g, six or seven coins' worth. Heavy enough that it lands
 *   with a thump that shoves the heap, light enough that the pile behind it, not only
 *   the pusher face, carries it forward across the lower tier. At 1,900 (140 g) it
 *   parked in front of the face's full reach and outlasted two minutes of drops.
 * - friction 0.1: averaged against the pusher top's 0.2 it slides at 0.15, so the
 *   heap holds it while the block draws back and it walks to the lip instead of riding
 *   the block back and forth as one piece; against the floor's 0.42 it grips at 0.26,
 *   a coin's grip, so it moves with the pile rather than skating off on one shove. At
 *   0.3 it rode the top for over a minute.
 * - restitution 0.02 (Min combine): a dead, wooden landing with no hop.
 * - linearDamping 0.05, angularDamping 0.8: free in flight so the fall off the lip
 *   reads as weight; a tumble on its edge settles in a few hundred milliseconds.
 * - behindLip 2 cm, dropHeight 6 cm: its centre drops 2 cm behind where the pusher's
 *   lip is on that tick, from above the heap, and lands at about 1 m/s. A fixed spot
 *   would land it deep in the heap, 12 cm behind the lip, whenever the block is out;
 *   3 cm behind put the slowest rides past 100 s.
 * - maxJitter 2 mm, maxYaw 0.08 (a quaternion y component, about 9°): a seeded
 *   offset and turn so no two crates land alike.
 * - keepAwake 2 mm: a coin whose centre is within a coin's reach of the crate plus this
 *   never comes to rest (COIN_REST): a frozen coin is a fixed or kinematic body, which
 *   the crate could neither push nor ride, and one frozen on a crate sitting on the
 *   lower tier would ride the pusher. Frozen coins the crate moves toward are woken,
 *   with the same reach plus its travel in the tick, and passed on through the pile as
 *   any other push (COIN_REST cascade).
 * - thudSpeed 0.25 m/s, fullSpeed 1 m/s, cooldownTicks 6: a change of velocity in one
 *   tick beyond what gravity gave it is a landing or a knock, reported as a crate
 *   impact (strength 1 at fullSpeed, one per 100 ms); the pusher's shove changes it by
 *   under 0.01 m/s a tick.
 * - maxOnTable 16: the most crates a table holds, as packages/shared's
 *   MAX_SNAPSHOT_CRATES stores; a log asking for more is refused.
 *
 * Measured on the Demo table (the economy's 100-coin silver opening heap settled for
 * 10 s, then a coin every 2 s; seeds 0xc0196051 and 1 to 5, crates at x 0, -60 and
 * 90 mm): every crate went over the front lip, after 19 s at the median and 72 s at the
 * longest, inside the economy's crateFallSeconds.max of 90 s. Four of the eighteen
 * landed on the heap's overhang in front of the lip and tipped off within 1.3 s.
 */
export const CRATE_BODY = {
  size: 0.042,
  roundRadius: 0.002,
  density: 1100,
  friction: 0.1,
  restitution: 0.02,
  linearDamping: 0.05,
  angularDamping: 0.8,
  behindLip: 0.02,
  dropHeight: 0.06,
  maxJitter: 0.002,
  maxYaw: 0.08,
  keepAwake: 0.002,
  thudSpeed: 0.25,
  fullSpeed: 1,
  cooldownTicks: 6,
  maxOnTable: 16,
} as const;

/**
 * Laying a restored table (PusherTable.restore), in metres:
 *
 * - liftStep 0.5 mm: a heap slot that overlaps a coin already placed, or the pusher, is
 *   raised this much at a time until it clears, so it drops at most 0.5 mm further than
 *   it has to: a soft landing well under COIN_MATERIAL.impactSpeed.
 * - probe 1 mm: how far down a coin that was asleep is cast to look for what holds it.
 *   Settled coins lie a contact skin (0.3 mm) clear of their support, well inside it.
 * - probeGrip 0.25: the cast must drive the coin at least this share of the probe into
 *   what it hits, so a neighbour touching it from the side (contact normal more than
 *   75° from vertical) does not count as holding it up.
 */
export const COIN_RESTORE = {
  liftStep: 0.0005,
  probe: 0.001,
  probeGrip: 0.25,
} as const;

/**
 * Contact events for the renderer and audio: a coin striking something at or above
 * COIN_MATERIAL.impactSpeed (0.3 m/s) is braked by the impact brake (PusherTable),
 * which knows the closing speed and what was struck, so that is where the event comes
 * from. Slower contacts (the pusher's shove, coins settling) make no sound worth a
 * sample and are not reported.
 *
 * - fullSpeed 1.5 m/s: a coin dropped down the chute onto the pusher top (12 cm, about
 *   1.5 m/s) is the hardest hit the table makes, strength 1; a coin falling off the
 *   upper lip (35 mm, 0.83 m/s) lands at about 0.55.
 * - cooldownTicks 6 (100 ms): one landing can be braked on two or three substeps in a
 *   row as the coin settles; one event a coin per 100 ms reads as one clack.
 */
export const CONTACT_EVENTS = {
  fullSpeed: 1.5,
  cooldownTicks: 6,
} as const;

/**
 * Solver settings the table is tuned against, measured over a minute of play with
 * an exact minimum-translation overlap check between coin pairs (see table.test.ts),
 * taken on every tick from the first drop to the end of the minute.
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
 *   caught it. At 2 mm, with the coin's contact skin, none of 12 drops reaches
 *   the pusher top.
 * - contactNaturalFrequency 600 Hz (Rapier default 30): at 30 Hz the thin coins
 *   sink 1 to 1.5 mm into each other under the weight of a stack and the upper
 *   tier clogs. 240 Hz left 1.5 times as many deep pairs as 360. With the rounded
 *   rim and the impact brake (COIN_MATERIAL), 600 Hz with a 0.3 mm skin left a
 *   quarter of the pair-ticks past 0.5 mm that 360 Hz with 0.15 mm did.
 * - substeps 2: the narrow phase runs once per substep, and a stale contact set
 *   between runs is what lets flat neighbours slide into each other rim first (one
 *   step of 6 iterations was four times worse). Three substeps cost 4.3 to 4.9 ms
 *   a tick, over the 4 ms budget.
 * - numSolverIterations 1 with numInternalPgsIterations 6: the separation pass
 *   (below) caps the depth Rapier leaves, so the solver only has to carry the
 *   dynamics, and the outer iteration is the expensive part of Rapier's step. Over
 *   the scripted minute and four more seeds (table.test.ts), all checked on every
 *   tick:
 *
 *   | outer x inner | mean, p99 ms a tick   | deepest | most passes | front falls a minute |
 *   | ------------- | --------------------- | ------- | ----------- | -------------------- |
 *   | 2 x 4         | 3.58, 4.19            | 0.29 mm | 28          | 191 to 224           |
 *   | 2 x 2         | 3.47, 4.21            | 0.34 mm | 37          | 161 to 216           |
 *   | 1 x 8         | 3.09, 3.88            | 0.28 mm | 31          | 145 to 186           |
 *   | 1 x 6         | 3.01-3.06, 3.72-3.83  | 0.28 mm | 39          | 119 to 202           |
 *   | 1 x 4         | 3.09, 4.03            | 0.32 mm | 55          | 145 to 202           |
 *   | 1 x 2         | 3.55, 5.36            | 0.36 mm | over 40     | 187 to 218           |
 *
 *   Two outer iterations alone reach 4 ms at the 99th percentile. With one, fewer
 *   inner iterations leave the separation pass more to do, which is what puts 1 x 4
 *   and 1 x 2 back over the budget. 1 x 6 is the cheapest at the tail. A full table
 *   drains about a sixth slower over the front than with 2 x 4 (173 against 207 a
 *   minute on average over the five seeds, while the script drops a coin every
 *   6 ticks), a rate far above what a player feeds it.
 * - separationSlop 0.2 mm, separationPasses 60: after the last substep of every tick
 *   a position pass (CoinSeparator) moves every coin pair, or coin and slab, deeper
 *   than the slop apart along Rapier's contact normal, to half the slop. Velocities
 *   are left alone, so Rapier's contacts still do all the dynamics. Every
 *   pair on every tick of the minute on five seeds (table.test.ts) stays within
 *   0.24 to 0.28 mm, and the pass clears every pair within 39 passes; the tests fail
 *   on any tick where it runs out. A jammed column takes that many because each push
 *   drives a coin into the next. Pushing pairs apart to the full slop instead of
 *   half rebounds the pile into itself and takes more passes, not fewer.
 *
 * Rapier itself puts nothing on a full table to sleep: rapier3d 0.21 exposes no sleep
 * thresholds, a body only sleeps with its whole contact island, and the moving pusher
 * wakes every coin it touches, which on a full table connect to nearly all the others.
 * The table's own rest (COIN_REST) freezes up to two thirds of the 250 coins in
 * table.bench.ts, which took the mean tick about a tenth lower and the 99th percentile
 * about 5% lower than with every coin awake, measured back to back (see table.bench.ts
 * for the numbers). Before rest, Rapier's step was about 2.75 ms of a 3.05 ms tick
 * (3.25 ms at its own 99th percentile), the separation pass 0.19 ms (0.72 ms at its
 * 99th, on ticks that need 14 or more passes) and the impact brake and fall detection
 * 0.09 ms.
 */
export const TABLE_SOLVER = {
  worldScale: 10,
  substeps: 2,
  lengthUnit: 0.03,
  normalizedPredictionDistance: 0.067,
  numSolverIterations: 1,
  numInternalPgsIterations: 6,
  maxCcdSubsteps: SOLVER.maxCcdSubsteps,
  contactNaturalFrequency: 600,
  separationSlop: 0.0002,
  separationPasses: 60,
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
  p.numInternalPgsIterations = TABLE_SOLVER.numInternalPgsIterations;
  p.maxCcdSubsteps = TABLE_SOLVER.maxCcdSubsteps;
  p.contact_natural_frequency = TABLE_SOLVER.contactNaturalFrequency;
}
