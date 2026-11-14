import type { PropKind } from '../kind.ts';
import { bool, fields } from '../params.ts';
import { surface, type SurfaceParams, TOUCH_MARGIN } from './common.ts';

export interface PostParams extends SurfaceParams {
  /** Combines restitution by max instead of min, so it kicks coins back: a bumper. */
  readonly bounce: boolean;
  /** Reports a prop.enter when a coin touches it. */
  readonly reports: boolean;
}

/** A static collider: a peg, a rope, or with `bounce` a bumper. */
export const POST: PropKind<PostParams> = {
  body: 'fixed',
  parse(raw, what) {
    const f = fields(raw, what, ['friction', 'restitution', 'bounce', 'reports']);
    return {
      ...surface(f, what),
      bounce: bool(f.bounce, `${what}.bounce`),
      reports: bool(f.reports, `${what}.reports`),
    };
  },
  material: ({ friction, restitution, bounce }) => ({
    friction,
    restitution,
    restitutionCombine: bounce ? 'max' : 'min',
  }),
  enter: {
    margin: () => TOUCH_MARGIN,
    onEnter: (_coin, prop) => (prop.params.reports ? { consume: false, tag: null } : null),
  },
};
