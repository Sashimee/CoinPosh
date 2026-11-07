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
   * Soft-CCD prediction distance in metres. Rapier's swept CCD misses a flat coin
   * falling face first (a 12 cm drop tunnels straight through the upper tier); soft
   * CCD widens the contact prediction instead and catches it.
   */
  softCcdPrediction: 0.03,
  /**
   * The widened soft-CCD prediction is switched on only above this speed (m/s),
   * checked after every tick; swept (hard) CCD stays on for every coin all the
   * time. Below it a coin moves under 2.5 mm a substep, inside the 2 mm contact
   * look-ahead (TABLE_SOLVER) plus both coins' skins, so the ordinary contacts catch
   * it. Keeping the widened prediction off the slow pile cut the narrow phase by
   * half on the full table.
   */
  softCcdSpeed: 0.3,
  /**
   * Contact skin in metres: Rapier treats every coin as 0.15 mm larger all round,
   * so two coins push apart when their real surfaces are still 0.3 mm short of
   * touching. A pile settles with that hairline gap, which the renderer's bevel
   * hides, instead of resting at the solver's allowed sink, and a squeezed pair has
   * 0.3 mm of give before the real shapes overlap. It cut the pairs sunk past
   * 0.5 mm by four on the full table and made the step 5% cheaper. 0.1 mm left
   * twice as many; 0.2 mm was no better than 0.15.
   */
  contactSkin: 0.00015,
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
 * Solver settings the table is tuned against, measured over a minute of play with
 * an exact minimum-translation overlap check between coin pairs (see table.test.ts),
 * sampled from 30 s on, when the table is full.
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
 * - contactNaturalFrequency 360 Hz (Rapier default 30): at 30 Hz the thin coins
 *   sink 1 to 1.5 mm into each other under the weight of a stack and the upper
 *   tier clogs. 240 Hz left 1.5 times as many deep pairs as 360; 480 was no better.
 * - substeps 2: the narrow phase runs once per substep, and a stale contact set
 *   between runs is what lets flat neighbours slide into each other rim first (one
 *   step of 6 iterations was four times worse). Three substeps cost 4.3 to 4.9 ms
 *   a tick, over the 4 ms budget.
 * - numSolverIterations 2 with numInternalPgsIterations 4: the pile is a wide,
 *   shallow web of contacts that each outer iteration only partly resolves, and the
 *   inner PGS passes are where a squeezed pair gets pushed apart. 3 outer with 1
 *   inner left 3 to 4 times as many pairs past 0.5 mm as 2 with 4; 3 with 2 matched
 *   2 with 4 but cost 3.8 ms a tick against 3.3.
 *
 * Measured with these settings on four seeds (0x7ab1e001, 12345, 777, 99), once a
 * second from 30 s to 60 s with about 700 touching pairs per sample: 0.7 to 1.2
 * pairs past 0.5 mm per sample (4.9 to 11 with 3 outer, 1 inner and no skin), 0.2
 * past 1 mm, the deepest 1.65 to 1.93 mm (was 2.7 to 4.9), and no pair past 0.5 mm
 * in more than 3 samples in a row (was 6). Checked every tick on 0x7ab1e001, no
 * pair stays past 0.5 mm for more than 16 ticks or past 1.5 mm for more than 5:
 * what is left is the instant of an impact (a drop landing on the heap, a coin
 * falling over the lip onto the lower tier, the pusher loading the pile), which
 * can peak at a few millimetres for a tick or two and clears straight away.
 *
 * Nothing on a full table sleeps: rapier3d 0.21 exposes no sleep thresholds, a body
 * only sleeps with its whole contact island, and the moving pusher wakes every coin
 * it touches, which on a full table connect to nearly all the others. The 4 ms
 * budget is for 250 coins all awake: table.bench.ts measures 3.5 ms a tick on
 * average, 4.0 ms at the 99th percentile.
 */
export const TABLE_SOLVER = {
  worldScale: 10,
  substeps: 2,
  lengthUnit: 0.03,
  normalizedPredictionDistance: 0.067,
  numSolverIterations: 2,
  numInternalPgsIterations: 4,
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
  p.numInternalPgsIterations = TABLE_SOLVER.numInternalPgsIterations;
  p.maxCcdSubsteps = TABLE_SOLVER.maxCcdSubsteps;
  p.contact_natural_frequency = TABLE_SOLVER.contactNaturalFrequency;
}
