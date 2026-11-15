import type { PrizeFamily } from '@coinposh/shared';
import type { PropPose, PropSpec } from '../kind.ts';
import type { WeightParams } from '../kinds/weight.ts';
import type { CompoundPart, PrimitiveShape, Quat, Vec3 } from '../shape.ts';

/**
 * The four prize families as rigid bodies: compound colliders on one dynamic `weight`
 * prop each, laid flat in their own frame (+y up, +z towards the player when unturned).
 * The renderer builds each family's mesh over these parts (T-11.07), so the look and the
 * physics cannot drift apart.
 *
 * Shared choices, against a 13 g brass coin 27 mm across (COIN) and the 80 g oak Vault
 * Crate (CRATE_BODY), which the pile already carries to the lip:
 *
 * - Size about one and a half coins across and a crate's reach (35 to 76 mm long): big
 *   enough to read as the prize among the coins, small enough that the pusher face and
 *   the pile behind it, not a lucky shove, walk it forward.
 * - Mass 45 to 95 g, three and a half to seven coins: it lands with a thump that shifts
 *   the heap and never gets kicked about by a single coin, yet stays lighter than the
 *   crate's 140 g that parked in front of the face for minutes (P-181). Each part's share
 *   is its volume, so the dense bits (a watch case, a perfume cap, a key fob) pull the
 *   centre of mass their way and a prize half over the lip hangs on its heavy end.
 * - Friction 0.1 to 0.18: averaged against the floor's 0.42 it grips like a coin, so it
 *   moves with the pile; averaged against the pusher top's 0.2 it slides, so the heap
 *   holds it while the block draws back (the crate's 0.3 rode the block for a minute).
 * - Restitution 0.02 to 0.06 with `min` combine: a dead, heavy landing; the glass flacon
 *   gets the most so its impact reads as a ting, never a hop.
 * - Linear damping 0.05: free in flight, so the fall off the lip reads as weight.
 * - Angular damping 0.5 to 1: the tall flacon rocks longest when it teeters, the flat
 *   cufflinks settle fastest.
 *
 * Measured on 2026-11-15 (prizes.test.ts and a sweep beside it): each family laid flat at
 * rest stays within 0.3 mm; laid on the lip with its centre of mass 3 mm behind the edge
 * and its front end out over it, each hangs for 1.5 s and goes over on a forward nudge;
 * car keys with the fob 3 mm past it tip off on their own within 1.5 s. Laid at x 0 and
 * -70 mm on the lower tier or at x 0 and 90 mm at the back of the upper one, with a coin
 * every half second from an empty table, all sixteen rides went over the front lip,
 * after 38 s at the soonest and 90 s at the longest (median 58 s), none into a gutter.
 *
 * Cost, on a host loaded to 28 with other runs, so only the ratio holds: the 250-coin
 * table played as in prizes.bench.ts, stepped tick for tick beside the same table bare
 * over the ten seconds the four prizes rode the upper tier, took 7.29 ms a tick on
 * average against 6.62 (median 6.61 against 6.02): a tenth more, of which half is the
 * compound parts (four single boxes cost 7.01) and half the 27 more coins the moving
 * prizes keep awake (207 against 180), as for the crate (CRATE_BODY).
 */
export interface PrizeBody {
  readonly shape: { readonly kind: 'compound'; readonly parts: readonly CompoundPart[] };
  /** In kilograms. */
  readonly mass: number;
  readonly params: WeightParams;
  /** Height of the body's origin above a flat surface it lies at rest on, in metres. */
  readonly restHeight: number;
}

/** The prop kind a prize binds to: a loose dynamic body (WEIGHT). */
export const PRIZE_PROP_KIND = 'weight';

const UPRIGHT: Quat = { x: 0, y: 0, z: 0, w: 1 };
const HALF = Math.sqrt(0.5);
/** Turns a part's y axis onto x, for a crown or a toggle lying sideways. */
const ALONG_X: Quat = { x: 0, y: 0, z: HALF, w: HALF };
/** Turns a part's y axis onto z. */
const ALONG_Z: Quat = { x: HALF, y: 0, z: 0, w: HALF };

function part(shape: PrimitiveShape, translation: Vec3, rotation: Quat = UPRIGHT): CompoundPart {
  return { shape, translation, rotation };
}

function box(x: number, y: number, z: number): PrimitiveShape {
  return { kind: 'box', halfExtents: { x, y, z } };
}

function cylinder(radius: number, halfHeight: number): PrimitiveShape {
  return { kind: 'cylinder', radius, halfHeight };
}

function capsule(radius: number, halfHeight: number): PrimitiveShape {
  return { kind: 'capsule', radius, halfHeight };
}

/**
 * Watch, dial up: a 32 mm steel case 9 mm deep with its crown at 3 o'clock, and a short
 * folded bracelet each side (12 and 6 o'clock), 72 mm end to end. It lies on the case
 * back and both bracelet ends, steady, and goes over the lip once the case does.
 */
const WATCH: PrizeBody = {
  shape: {
    kind: 'compound',
    parts: [
      part(cylinder(0.016, 0.0045), { x: 0, y: 0, z: 0 }),
      part(cylinder(0.0025, 0.002), { x: 0.0175, y: 0, z: 0 }, ALONG_X),
      part(box(0.009, 0.0025, 0.011), { x: 0, y: -0.002, z: -0.025 }),
      part(box(0.009, 0.0025, 0.011), { x: 0, y: -0.002, z: 0.025 }),
    ],
  },
  mass: 0.075,
  params: { friction: 0.12, restitution: 0.04, linearDamping: 0.05, angularDamping: 0.8 },
  restHeight: 0.0045,
};

/**
 * Perfume, standing: a faceted 26 by 16 mm flacon 32 mm tall, a short neck and a heavy
 * square cap, 52 mm in all. Twice as tall as it is wide and capped heavy, it is the
 * prize that topples: a shove from the pile rocks it, and on the lip it tips over.
 */
const PERFUME: PrizeBody = {
  shape: {
    kind: 'compound',
    parts: [
      part(box(0.013, 0.016, 0.008), { x: 0, y: 0, z: 0 }),
      part(cylinder(0.0045, 0.003), { x: 0, y: 0.019, z: 0 }),
      part(box(0.008, 0.007, 0.008), { x: 0, y: 0.029, z: 0 }),
    ],
  },
  mass: 0.095,
  params: { friction: 0.1, restitution: 0.06, linearDamping: 0.05, angularDamping: 0.5 },
  restHeight: 0.016,
};

/**
 * Cufflinks, a pair side by side, faces up: each a 17 mm enamel face on a short post over
 * a toggle bar 14 mm long, the pair 38 mm across. It stands on the two toggles, so a
 * pair half over the lip rocks on the toggle still on the floor before it drops.
 */
const CUFFLINKS: PrizeBody = {
  shape: {
    kind: 'compound',
    parts: [-0.0095, 0.0095].flatMap((x) => [
      part(cylinder(0.0085, 0.0018), { x, y: 0.004, z: 0 }),
      part(cylinder(0.0018, 0.0016), { x, y: 0.0006, z: 0 }),
      part(capsule(0.002, 0.005), { x, y: -0.003, z: 0 }, ALONG_Z),
    ]),
  },
  mass: 0.045,
  params: { friction: 0.12, restitution: 0.03, linearDamping: 0.05, angularDamping: 1 },
  restHeight: 0.005,
};

/**
 * Car keys, flat: a 22 by 32 mm leather fob 10 mm thick with a chrome blade out of one
 * end and a key ring off the other, 76 mm end to end. The fob is most of its mass, so
 * with blade or ring over the lip it hangs there, teetering, until the fob goes too.
 */
const CAR_KEYS: PrizeBody = {
  shape: {
    kind: 'compound',
    parts: [
      part(box(0.011, 0.005, 0.016), { x: 0, y: 0, z: -0.008 }),
      part(box(0.0035, 0.0015, 0.015), { x: 0, y: -0.0035, z: 0.022 }),
      part(cylinder(0.009, 0.0012), { x: 0, y: -0.0038, z: -0.03 }),
    ],
  },
  mass: 0.065,
  params: { friction: 0.18, restitution: 0.02, linearDamping: 0.05, angularDamping: 0.9 },
  restHeight: 0.005,
};

export const PRIZE_BODIES: Readonly<Record<PrizeFamily, PrizeBody>> = {
  watch: WATCH,
  perfume: PERFUME,
  cufflinks: CUFFLINKS,
  carKeys: CAR_KEYS,
};

/** The prop config entry that lays a prize of `family` at `pose`, as prop `id`. */
export function prizeSpec(
  family: PrizeFamily,
  id: number,
  pose: PropPose,
): PropSpec<typeof PRIZE_PROP_KIND, WeightParams> {
  const { shape, mass, params } = PRIZE_BODIES[family];
  return { id, kind: PRIZE_PROP_KIND, shape, mass, pose, params };
}
