/**
 * The physical pusher table, in metres. +Y is up, +Z points from the backboard to
 * the player, and the lower playfield surface is y = 0. The renderer's venue shells
 * (RIVIERA_TABLE and later venues) import these so the visual table and the
 * simulated one cannot drift apart.
 *
 * Side view, player on the right:
 *
 *   backboard ─┐            drop
 *              │             ↓
 *              │  ┌──────────────── upper tier (pusher top) ──┐
 *              │  │                pusher block               │ → stroke
 *   ───────────┴──┴─────────────── lower tier ────────────────┴────────── front edge
 *
 * Top view: the lower tier floor spans ±fieldHalfWidth. Guide walls run along both
 * sides of the pusher; from GUTTER_START_Z forward an open gutter `gutterWidth` wide
 * runs between the floor and each outer side wall, so a coin shoved sideways is lost
 * to the house. Only coins that leave over the front edge pay out.
 */
export const PLAYFIELD = {
  /** Half-width of the lower tier floor. Drops reach ±150 mm, so this leaves a coin's width spare. */
  fieldHalfWidth: 0.18,
  /** Open channel between the floor and each side wall: wider than a coin, so one falls flat in. */
  gutterWidth: 0.032,
  /**
   * z of the front (payout) edge of the lower tier, 5 cm ahead of the pusher's
   * default reach (PUSHER.stroke). At 11 cm the 250-coin budget filled both tiers without the lower
   * pile ever reaching the edge, and the table could settle with nothing paying out.
   */
  fieldFrontZ: 0.05,
  /** Lower-tier floor slab thickness. Its underside is the bottom of the cabinet interior. */
  floorThickness: 0.02,
  wallThickness: 0.012,
  /** Height of the side walls and backboard above the lower tier; higher than any bounce. */
  wallHeight: 0.22,
  /** Fall detection plane: a coin whose centre drops below it has left the table. */
  fallY: -0.03,
} as const;

/** Inner half-width between the side walls: the floor plus one gutter. */
export const TABLE_INNER_HALF_WIDTH = PLAYFIELD.fieldHalfWidth + PLAYFIELD.gutterWidth;

/**
 * The pusher block. Its top is the upper tier, where dropped coins land; its front
 * face shoves the lower tier toward the front edge. A fixed backboard closes the
 * rear of the upper tier, so on the return stroke it holds back the coins riding on
 * top while the block slides out from under them, and the heap creeps toward the
 * front lip until coins spill over it.
 */
export const PUSHER = {
  /** Upper tier height above the lower tier: a 35 mm fall gives a solid clack, not a bounce. */
  height: 0.035,
  /** Front face z at full retraction (extension 0). */
  frontZ: -0.12,
  /**
   * Default travel of the front face, retracted to extended: the full 12 cm the guides
   * allow, matching the renderer's pusher. At 8 cm the block stopped 9 cm short of the
   * lip, so the lower tier had to hold some 180 coins before a shove reached the edge:
   * the opening heap sat still and a centre drop moved nothing. At 12 cm the face
   * reaches 5 cm from the lip and a single drop onto the opening heap tips coins over
   * within one or two strokes, while the heap on its own stands.
   */
  stroke: 0.12,
  /** Longest stroke a motion may ask for; the guide walls end just ahead of it. */
  maxStroke: 0.12,
  /** Block depth front to back; long enough that its top never clears the backboard. */
  depth: 0.26,
  /** Clearance between the block and each side wall: thinner than a coin, so none can wedge in. */
  sideClearance: 0.001,
  /** Default ticks per full cycle (4 s at 60 Hz): a slow, deliberate shove. */
  periodTicks: 240,
  /** Fraction of each cycle spent pushing forward; the return is quicker, like a crank on a cam. */
  pushFraction: 0.6,
} as const;

/**
 * z where the side gutters open. Behind it, guide walls hug the pusher so coins on the
 * upper tier can only leave over the front lip; ahead of it the lower tier floor is
 * flanked by the open gutters. It sits at the pusher's longest reach, so the block
 * never slides past the end of its guides.
 */
export const GUTTER_START_Z = PUSHER.frontZ + PUSHER.maxStroke;

/**
 * The fixed backboard over the rear of the upper tier. Its lower edge sinks into the
 * pusher block (the solver ignores fixed-against-kinematic overlap), so there is no
 * seam at all: with even a 1 mm gap, a crowded upper tier squeezed coins edge first
 * under the board and onto the hidden rear of the block, where they stayed for good.
 */
export const BACKBOARD = {
  frontZ: -0.22,
  /** How far the board's lower edge reaches below the pusher top. */
  embed: 0.003,
} as const;

/**
 * Where dropped coins enter: centred on the upper tier between the backboard and the
 * pusher lip at full retraction, so every drop lands on the upper tier.
 */
export const DROP_ZONE = {
  z: (BACKBOARD.frontZ + PUSHER.frontZ) / 2,
  /** Height of the coin's centre above the upper tier at spawn. */
  height: 0.12,
} as const;
