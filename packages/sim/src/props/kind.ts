import type { PropShape, Quat, Vec3 } from './shape.ts';

/**
 * How a prop's body moves.
 * - `fixed`: a static collider that never moves (pegs, ropes, bumpers).
 * - `kinematic`: a collider driven along PropKind.path, one pose per tick, that pushes
 *   coins and is never pushed back (butler, atomizer puff).
 * - `dynamic`: a body of PropSpec.mass that coins and the pusher shove, and that can
 *   fall off the table (prizes, a jackpot ball).
 * - `ghost`: no collider at all; it acts only through its field and enter hooks
 *   (magnet, target pockets). A ghost with a path moves along it.
 */
export type PropBody = 'fixed' | 'kinematic' | 'dynamic' | 'ghost';

/** A prop's place on the table, in metres. */
export interface PropPose {
  readonly translation: Vec3;
  readonly rotation: Quat;
}

/** Surface response of a solid prop; restitution combines with the coin's by `restitutionCombine`. */
export interface PropMaterial {
  readonly friction: number;
  readonly restitution: number;
  /** `min` keeps the table's never-adds-bounce rule; `max` lets a bumper kick back. */
  readonly restitutionCombine: 'min' | 'max';
}

/** Velocity damping of a dynamic prop, per second. */
export interface PropDamping {
  readonly linear: number;
  readonly angular: number;
}

/** A coin as a hook sees it, in metres. */
export interface PropCoin {
  readonly id: number;
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly sleeping: boolean;
  /** Null on a Sim without mechanics. */
  readonly tier: string | null;
}

/** A prop as a hook sees it this tick. */
export interface PropView<P> {
  readonly id: number;
  readonly params: P;
  /** Ticks the prop has been on the table: 0 on the tick it is laid. */
  readonly clock: number;
  readonly pose: PropPose;
}

/** What an enter hook does with the coin that entered; null reports nothing. */
export interface PropEnterResult {
  /** Takes the coin off the table, as a fusion does; it is reported as consumed. */
  readonly consume: boolean;
  /** A label the prop puts on the coin, carried by the prop.enter event. */
  readonly tag: string | null;
}

export interface PropField<P> {
  /** How far from the prop's centre, in metres, the field reaches a coin's centre. */
  readonly reach: (params: P) => number;
  /**
   * The change of velocity, in m/s, the field gives `coin` this tick, or null for none.
   * A coin at rest that is given one wakes.
   */
  readonly kick: (coin: PropCoin, prop: PropView<P>) => Vec3 | null;
}

export interface PropEnter<P> {
  /**
   * A coin is in the prop while its centre lies within `margin(params)` metres of the
   * prop's shape (negative: that deep inside it). Entering fires once, on the tick a
   * coin goes from out to in; a coin laid in the prop starts in and fires nothing.
   */
  readonly margin: (params: P) => number;
  readonly onEnter: (coin: PropCoin, prop: PropView<P>) => PropEnterResult | null;
}

/**
 * One kind of prop. Everything here is pure and Rapier-free: a kind reads its own
 * parameters and the views the sim hands it, and returns numbers, so the server can
 * check a prop config without loading the physics engine. Hooks run in ascending prop
 * id order, then ascending coin id order, and must not keep state of their own: all
 * prop state is the sim's, so it is hashed and snapshotted.
 */
export interface PropKind<P> {
  readonly body: PropBody;
  /** Checks raw parameters from the config and returns them typed; throws if malformed. */
  readonly parse: (raw: unknown, what: string) => P;
  /** For fixed, kinematic and dynamic props; TABLE_MATERIAL's wall response when omitted. */
  readonly material?: (params: P) => PropMaterial;
  /** For dynamic props; none when omitted. */
  readonly damping?: (params: P) => PropDamping;
  /**
   * Required for kinematic props, optional for ghosts: the pose at `clock`, from the
   * pose the config lays it at. It must be a pure function of its arguments.
   */
  readonly path?: (clock: number, params: P, home: PropPose) => PropPose;
  /** For a prop with a path: the farthest its centre gets from home, in metres. */
  readonly travel?: (params: P) => number;
  readonly field?: PropField<P>;
  readonly enter?: PropEnter<P>;
}

/** One prop in the sim config: which kind, its collider, and where it is laid. */
export interface PropSpec<K extends string = string, P = unknown> {
  /** Unique across the config; props step in ascending id order. */
  readonly id: number;
  readonly kind: K;
  readonly shape: PropShape;
  /** In kilograms; positive for a dynamic prop and 0 for every other. */
  readonly mass: number;
  readonly pose: PropPose;
  readonly params: P;
}
