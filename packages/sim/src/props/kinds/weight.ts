import type { PropKind } from '../kind.ts';
import { fields, numberIn } from '../params.ts';
import { surface, type SurfaceParams } from './common.ts';

export interface WeightParams extends SurfaceParams {
  /** Per second. */
  readonly linearDamping: number;
  /** Per second. */
  readonly angularDamping: number;
}

export const MAX_PROP_DAMPING = 10;

/** A loose dynamic body the coins and pusher shove about, and that can fall: a prize. */
export const WEIGHT: PropKind<WeightParams> = {
  body: 'dynamic',
  parse(raw, what) {
    const f = fields(raw, what, ['friction', 'restitution', 'linearDamping', 'angularDamping']);
    return {
      ...surface(f, what),
      linearDamping: numberIn(f.linearDamping, `${what}.linearDamping`, 0, MAX_PROP_DAMPING),
      angularDamping: numberIn(f.angularDamping, `${what}.angularDamping`, 0, MAX_PROP_DAMPING),
    };
  },
  material: ({ friction, restitution }) => ({ friction, restitution, restitutionCombine: 'min' }),
  damping: ({ linearDamping, angularDamping }) => ({
    linear: linearDamping,
    angular: angularDamping,
  }),
};
