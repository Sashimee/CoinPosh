/**
 * The `@coinposh/sim/layout` entry: the table's geometry, the coin, the input ranges and the
 * tick rate, for code that lays out or drives the table without simulating it (the renderer's
 * venue shells, the render thread's sim bridge). It must never load Rapier, which is several
 * megabytes; layout.test.ts walks its import graph to keep it that way.
 */
export { COIN, COIN_DROP_HEIGHT } from './coin.ts';
export { TICK_RATE_HZ } from './constants.ts';
export { MAX_DROP_OFFSET_MM, NUDGE_DIRECTIONS, type NudgeDirection } from './inputs.ts';
export {
  BACKBOARD,
  DROP_ZONE,
  GUTTER_START_Z,
  PLAYFIELD,
  PUSHER,
  TABLE_INNER_HALF_WIDTH,
} from './table/layout.ts';
