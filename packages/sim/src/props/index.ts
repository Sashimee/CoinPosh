import { BACKBOARD, PLAYFIELD, TABLE_INNER_HALF_WIDTH } from '../table/layout.ts';
import { TABLE_MATERIAL } from '../table/tuning.ts';
import type {
  PropBody,
  PropCoin,
  PropDamping,
  PropEnterResult,
  PropKind,
  PropMaterial,
  PropPose,
  PropSpec,
} from './kind.ts';
import { ATTRACTOR } from './kinds/attractor.ts';
import { POCKET } from './kinds/pocket.ts';
import { POST } from './kinds/post.ts';
import { SLIDER } from './kinds/slider.ts';
import { WEIGHT } from './kinds/weight.ts';
import { fields, intIn, numberAbove, numberIn, oneOf, unitQuat } from './params.ts';
import { boundingRadius, parseShape, type PropShape, type Vec3 } from './shape.ts';

export type * from './kind.ts';
export {
  boundingRadius,
  conjugate,
  distanceAt,
  MAX_PROP_EXTENT,
  MIN_PROP_EXTENT,
  multiply,
  PROP_SHAPE_KINDS,
  type PropShape,
  type Quat,
  rotate,
  signedDistance,
  type Vec3,
} from './shape.ts';
export { ATTRACTOR, type AttractorParams } from './kinds/attractor.ts';
export { POCKET, type PocketParams } from './kinds/pocket.ts';
export { POST, type PostParams } from './kinds/post.ts';
export { SLIDER, type SliderParams } from './kinds/slider.ts';
export { WEIGHT, type WeightParams } from './kinds/weight.ts';

/**
 * Every prop kind the sim knows, by the name a PropSpec gives. A new kind is a new entry
 * here: its parameters, body and hooks, all Rapier-free.
 */
export const PROP_KINDS = {
  post: POST,
  slider: SLIDER,
  weight: WEIGHT,
  pocket: POCKET,
  attractor: ATTRACTOR,
} as const;

export type PropKindName = keyof typeof PROP_KINDS;

export const PROP_KIND_NAMES = Object.keys(PROP_KINDS) as readonly PropKindName[];

export type PropParamsOf<K extends PropKindName> =
  (typeof PROP_KINDS)[K] extends PropKind<infer P> ? P : never;

/** A prop config entry, its parameters typed by its kind. */
export type AnyPropSpec = {
  [K in PropKindName]: PropSpec<K, PropParamsOf<K>>;
}[PropKindName];

/** Most props one Sim may hold. */
export const MAX_PROPS = 32;
/** Heaviest dynamic prop, in kilograms: about forty coins. */
export const MAX_PROP_MASS = 0.25;
export const MAX_PROP_ID = 0x7fffffff;

/**
 * A prop bound to its kind, with the parameter type erased: what the sim's runtime
 * steps. Every method is pure.
 */
export interface BoundProp {
  readonly id: number;
  readonly kind: PropKindName;
  readonly body: PropBody;
  readonly shape: PropShape;
  readonly mass: number;
  readonly home: PropPose;
  /** Null for a ghost. */
  readonly material: PropMaterial | null;
  /** Null unless dynamic. */
  readonly damping: PropDamping | null;
  /** Whether its pose follows a path; false for a dynamic prop, which physics moves. */
  readonly moves: boolean;
  /** The farthest its centre gets from home along its path, in metres. */
  readonly travel: number;
  /** Null without a field. */
  readonly fieldReach: number | null;
  /** Null without an enter hook. */
  readonly enterMargin: number | null;
  poseAt(clock: number): PropPose;
  kick(coin: PropCoin, clock: number, pose: PropPose): Vec3 | null;
  onEnter(coin: PropCoin, clock: number, pose: PropPose): PropEnterResult | null;
}

/** The cabinet walls' response, for a solid prop whose kind names no material. */
const WALL_MATERIAL: PropMaterial = {
  friction: TABLE_MATERIAL.wallFriction,
  restitution: TABLE_MATERIAL.restitution,
  restitutionCombine: 'min',
};

function bind<P>(
  id: number,
  name: PropKindName,
  kind: PropKind<P>,
  shape: PropShape,
  mass: number,
  home: PropPose,
  params: P,
): BoundProp {
  const { field, enter } = kind;
  if (kind.body === 'kinematic' && !kind.path) {
    throw new Error(`prop kind "${name}" is kinematic but has no path`);
  }
  const path = kind.body === 'dynamic' ? undefined : kind.path;
  const moves = path !== undefined;
  const view = (clock: number, pose: PropPose) => ({ id, params, clock, pose });
  return {
    id,
    kind: name,
    body: kind.body,
    shape,
    mass,
    home,
    material: kind.body === 'ghost' ? null : (kind.material?.(params) ?? WALL_MATERIAL),
    damping: kind.body === 'dynamic' ? (kind.damping?.(params) ?? { linear: 0, angular: 0 }) : null,
    moves,
    travel: moves ? (kind.travel?.(params) ?? 0) : 0,
    fieldReach: field ? field.reach(params) : null,
    enterMargin: enter ? enter.margin(params) : null,
    poseAt: path ? (clock) => path(clock, params, home) : () => home,
    kick: (coin, clock, pose) => (field ? field.kick(coin, view(clock, pose)) : null),
    onEnter: (coin, clock, pose) => (enter ? enter.onEnter(coin, view(clock, pose)) : null),
  };
}

function parsePose(raw: unknown, what: string): PropPose {
  const f = fields(raw, what, ['translation', 'rotation']);
  const t = fields(f.translation, `${what}.translation`, ['x', 'y', 'z']);
  return {
    translation: {
      x: numberIn(t.x, `${what}.translation.x`, -TABLE_INNER_HALF_WIDTH, TABLE_INNER_HALF_WIDTH),
      y: numberIn(t.y, `${what}.translation.y`, 0, PLAYFIELD.wallHeight),
      z: numberIn(t.z, `${what}.translation.z`, BACKBOARD.frontZ, PLAYFIELD.fieldFrontZ),
    },
    rotation: unitQuat(f.rotation, `${what}.rotation`),
  };
}

function bindSpec<P>(
  raw: Readonly<Record<string, unknown>>,
  what: string,
  name: PropKindName,
  kind: PropKind<P>,
): BoundProp {
  const id = intIn(raw.id, `${what}.id`, 0, MAX_PROP_ID);
  const mass =
    kind.body === 'dynamic'
      ? numberAbove(raw.mass, `${what}.mass`, 0, MAX_PROP_MASS)
      : numberIn(raw.mass, `${what}.mass (a ${kind.body} prop has none)`, 0, 0);
  return bind(
    id,
    name,
    kind,
    parseShape(raw.shape, `${what}.shape`),
    mass,
    parsePose(raw.pose, `${what}.pose`),
    kind.parse(raw.params, `${what}.params`),
  );
}

/**
 * Checks a prop config from outside the sim and binds each entry to its kind, in
 * ascending id order whatever order the config lists them in. Throws on anything
 * malformed: an unknown kind or field, a repeated id, a shape or pose out of range,
 * parameters the kind refuses, or more than MAX_PROPS entries.
 */
export function bindProps(raw: unknown): BoundProp[] {
  if (!Array.isArray(raw)) {
    throw new TypeError('props must be an array of prop specs');
  }
  if (raw.length > MAX_PROPS) {
    throw new RangeError(`props holds ${raw.length} entries; a Sim takes at most ${MAX_PROPS}`);
  }
  const props = raw.map((entry: unknown, i) => {
    const what = `props[${i}]`;
    const f = fields(entry, what, ['id', 'kind', 'shape', 'mass', 'pose', 'params']);
    const name = oneOf(f.kind, `${what}.kind`, PROP_KIND_NAMES);
    switch (name) {
      case 'post':
        return bindSpec(f, what, name, PROP_KINDS.post);
      case 'slider':
        return bindSpec(f, what, name, PROP_KINDS.slider);
      case 'weight':
        return bindSpec(f, what, name, PROP_KINDS.weight);
      case 'pocket':
        return bindSpec(f, what, name, PROP_KINDS.pocket);
      case 'attractor':
        return bindSpec(f, what, name, PROP_KINDS.attractor);
    }
  });
  props.sort((a, b) => a.id - b.id);
  props.forEach((prop, i) => {
    if (i > 0 && props[i - 1]?.id === prop.id) {
      throw new RangeError(`props repeats id ${prop.id}; every prop needs its own`);
    }
  });
  return props;
}

/** The horizontal radius a prop may sweep about its home, in metres. */
export function sweepRadius(prop: BoundProp): number {
  return boundingRadius(prop.shape) + prop.travel;
}
