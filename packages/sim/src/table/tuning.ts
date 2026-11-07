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
   * Coins faster than this (m/s) are swept along their motion before every substep
   * and landed on the first thing in their path (PusherTable#absorbImpacts). The
   * solver alone lets fast coins sink deep into the pile: on first contact Rapier
   * builds a sparse manifold (at most four points, only those inside the 2 mm
   * look-ahead), so a coin arriving at 1 m/s or more takes an off-centre impulse,
   * spins, and its far rim slams through the neighbour within the same substep.
   * Neither swept CCD (blind to that spin) nor soft CCD (which itself added 80 to
   * 90 rad/s of spurious spin to a flat drop) stopped it, and more solver
   * iterations or a stiffer contact did not either; a wider global look-ahead did,
   * at 6 ms a tick. Below 0.3 m/s a coin moves under 2.5 mm a substep and the
   * ordinary contacts catch it. On the scripted minute, checked every tick, this
   * took the deepest pair from 10.2 mm to 2.9 mm and the pair-ticks past 0.5 mm
   * from 3546 to 772, for no measurable cost.
   */
  impactSpeed: 0.3,
  /** Gap in metres the sweep leaves between a landed coin and what it hit. */
  impactMargin: 0.0001,
  /**
   * Sweeps per coin per substep. A glancing landing leaves the coin sliding into
   * the next coin along; one pass left the deepest pair at 4.8 mm, three at 2.9.
   */
  impactPasses: 3,
  /**
   * Contact skin in metres: Rapier treats every coin as 0.3 mm larger all round, so
   * two coins push apart when their real surfaces are still 0.6 mm short of
   * touching. A pile settles with that hairline gap instead of resting at the
   * solver's allowed sink, and a squeezed pair has 0.6 mm of give before the real
   * shapes overlap. With the impact sweep and 600 Hz contacts (TABLE_SOLVER),
   * 0.3 mm left 4 times fewer pair-ticks past 0.5 mm than 0.15 mm; 0.4 mm was no
   * better.
   */
  contactSkin: 0.0003,
  /**
   * The collider is a rounded cylinder with this edge radius in metres. Where two
   * sharp cylinder rims meet Rapier finds a poor contact normal and the pair
   * interpenetrates; N-gon hulls of 8 to 24 sides let a drop onto a resting coin
   * sink 4.9 to 7.1 mm, the rounded rim (with the impact sweep) 0.3 mm. A 0.8 mm
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
 * - contactNaturalFrequency 600 Hz (Rapier default 30): at 30 Hz the thin coins
 *   sink 1 to 1.5 mm into each other under the weight of a stack and the upper
 *   tier clogs. 240 Hz left 1.5 times as many deep pairs as 360. With the rounded
 *   rim and the impact sweep (COIN_MATERIAL), 600 Hz with a 0.3 mm skin left a
 *   quarter of the pair-ticks past 0.5 mm that 360 Hz with 0.15 mm did.
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
 * Measured with these settings, every coin pair on every tick of the minute: on
 * 0x7ab1e001 the deepest pair reaches 2.89 mm, with 770 pair-ticks past 0.5 mm
 * (0.2 a tick against 450 to 700 touching pairs), and no pair stays past 0.5 mm
 * for more than 16 ticks. Six more seeds (12345, 777, 99, 424242, 31337, 2024) gave
 * 698 to 1073 pair-ticks past 0.5 mm and a deepest pair of 4.0 to 7.5 mm. What is
 * left is a pair squeezed rim to rim under the pusher loading the upper heap, a
 * coin rocking across another's rim, or two coins tumbling over the lip together.
 * Checked only once a second, as before, these peaks were missed: the same minute
 * then read 1.65 mm deepest while it really peaked at 10.2 mm. 6 inner PGS
 * iterations trimmed the pair-ticks by a third but not the peaks (3.0 to 7.0 mm)
 * and made the step about 1.5 times slower; a much wider contact look-ahead
 * removed the peaks but cost 6 ms a tick.
 *
 * Nothing on a full table sleeps: rapier3d 0.21 exposes no sleep thresholds, a body
 * only sleeps with its whole contact island, and the moving pusher wakes every coin
 * it touches, which on a full table connect to nearly all the others. The 4 ms
 * budget is for 250 coins all awake: table.bench.ts measures 3.41 ms a tick on
 * average, 3.91 ms at the 99th percentile.
 */
export const TABLE_SOLVER = {
  worldScale: 10,
  substeps: 2,
  lengthUnit: 0.03,
  normalizedPredictionDistance: 0.067,
  numSolverIterations: 2,
  numInternalPgsIterations: 4,
  maxCcdSubsteps: SOLVER.maxCcdSubsteps,
  contactNaturalFrequency: 600,
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
