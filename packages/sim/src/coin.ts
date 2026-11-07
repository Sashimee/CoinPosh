/**
 * Physical coin, starting values for T-1.01 to tune on the real table.
 *
 * - 27 mm across, 2.6 mm thick: a little chunkier than a 2-euro coin, so a pile
 *   reads as substantial and the rim catches light.
 * - Density 8,700 kg/m³ (brass): about 13 g per coin, so the pusher has to shove.
 * - Friction 0.42: high enough that a coin hanging over the edge holds until it
 *   is pushed, low enough that a stack slides as a block rather than toppling.
 * - Restitution 0.06 with `Min` combine: coins land with a dull clack and stay
 *   down; bouncing is what makes coins feel like tin.
 * - Linear damping 0.05, angular damping 0.6: almost free in flight, but a coin
 *   spinning on its rim settles fast instead of wobbling for seconds.
 * - CCD on: a coin dropped from 12 cm lands at ~1.5 m/s, 2.5 cm per tick, ten
 *   times its thickness, so it would tunnel through a resting coin without it.
 */
export const COIN = {
  radius: 0.0135,
  halfThickness: 0.0013,
  density: 8700,
  friction: 0.42,
  restitution: 0.06,
  linearDamping: 0.05,
  angularDamping: 0.6,
} as const;

/** Drop height above the playfield surface, in metres. */
export const COIN_DROP_HEIGHT = 0.12;

/** Largest random tilt applied to a dropped coin, as a quaternion x/z component (~6°). */
export const COIN_DROP_MAX_TILT = 0.05;

/** Largest random depth offset of a dropped coin, so a column of drops does not stack perfectly. */
export const COIN_DROP_MAX_JITTER = 0.002;
