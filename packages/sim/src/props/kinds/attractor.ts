import type { PropKind } from '../kind.ts';
import { bool, fields, numberAbove } from '../params.ts';
import { acts, tiers } from './common.ts';

export interface AttractorParams {
  /** Metres from its centre to the farthest coin centre it pulls. */
  readonly reach: number;
  /** The change of velocity, in m/s per tick, it gives a coin at its centre. */
  readonly pull: number;
  readonly tiers: readonly string[];
  /** Wakes coins at rest; otherwise it pulls only coins already moving. */
  readonly stirs: boolean;
}

export const MAX_ATTRACTOR_REACH = 0.1;
export const MAX_ATTRACTOR_PULL = 0.05;
/** Closer than this to the centre, in metres, a coin feels no pull, so it settles there. */
export const ATTRACTOR_DEAD_ZONE = 0.001;

/**
 * A force field: every tick it draws coins within `reach` towards its centre across the
 * table, harder the nearer they are.
 */
export const ATTRACTOR: PropKind<AttractorParams> = {
  body: 'ghost',
  parse(raw, what) {
    const f = fields(raw, what, ['reach', 'pull', 'tiers', 'stirs']);
    return {
      reach: numberAbove(f.reach, `${what}.reach`, 0, MAX_ATTRACTOR_REACH),
      pull: numberAbove(f.pull, `${what}.pull`, 0, MAX_ATTRACTOR_PULL),
      tiers: tiers(f.tiers, `${what}.tiers`),
      stirs: bool(f.stirs, `${what}.stirs`),
    };
  },
  field: {
    reach: (params) => params.reach,
    kick(coin, { params, pose }) {
      if ((coin.sleeping && !params.stirs) || !acts(params.tiers, coin.tier)) {
        return null;
      }
      const dx = pose.translation.x - coin.translation.x;
      const dz = pose.translation.z - coin.translation.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < ATTRACTOR_DEAD_ZONE || d > params.reach) {
        return null;
      }
      const k = (params.pull * (1 - d / params.reach)) / d;
      return { x: dx * k, y: 0, z: dz * k };
    },
  },
};
