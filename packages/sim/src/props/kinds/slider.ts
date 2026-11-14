import type { PropKind } from '../kind.ts';
import { fields, intIn, numberIn } from '../params.ts';
import { surface, type SurfaceParams } from './common.ts';

export interface SliderParams extends SurfaceParams {
  /** The far end of the stroke from home, in metres along x and z. */
  readonly stroke: { readonly x: number; readonly z: number };
  readonly periodTicks: number;
  readonly phaseTicks: number;
}

/** The longest a slider's stroke may reach along x or z. */
export const MAX_SLIDER_STROKE = 0.1;
export const MAX_SLIDER_PERIOD_TICKS = 3600;

/**
 * A kinematic block that eases out to `stroke` and back once every `periodTicks`,
 * starting `phaseTicks` into its cycle: a smoothstep on each half, so it sets off and
 * stops without a jolt, like the pusher.
 */
export const SLIDER: PropKind<SliderParams> = {
  body: 'kinematic',
  parse(raw, what) {
    const f = fields(raw, what, ['friction', 'restitution', 'stroke', 'periodTicks', 'phaseTicks']);
    const stroke = fields(f.stroke, `${what}.stroke`, ['x', 'z']);
    const periodTicks = intIn(f.periodTicks, `${what}.periodTicks`, 2, MAX_SLIDER_PERIOD_TICKS);
    return {
      ...surface(f, what),
      stroke: {
        x: numberIn(stroke.x, `${what}.stroke.x`, -MAX_SLIDER_STROKE, MAX_SLIDER_STROKE),
        z: numberIn(stroke.z, `${what}.stroke.z`, -MAX_SLIDER_STROKE, MAX_SLIDER_STROKE),
      },
      periodTicks,
      phaseTicks: intIn(f.phaseTicks, `${what}.phaseTicks`, 0, periodTicks - 1),
    };
  },
  material: ({ friction, restitution }) => ({ friction, restitution, restitutionCombine: 'min' }),
  path(clock, params, home) {
    const u = ((clock + params.phaseTicks) % params.periodTicks) / params.periodTicks;
    const t = u < 0.5 ? 2 * u : 2 - 2 * u;
    const s = t * t * (3 - 2 * t);
    return {
      translation: {
        x: home.translation.x + params.stroke.x * s,
        y: home.translation.y,
        z: home.translation.z + params.stroke.z * s,
      },
      rotation: home.rotation,
    };
  },
  travel: ({ stroke }) => Math.sqrt(stroke.x * stroke.x + stroke.z * stroke.z),
};
