import { COIN } from '../../coin.ts';
import type { Fields } from '../params.ts';
import { distinctStrings, numberIn } from '../params.ts';

/** How close a coin's centre comes to a solid prop's surface while it touches it, edge on. */
export const TOUCH_MARGIN = COIN.radius + 0.001;

/** Most tiers a prop may single out. */
export const MAX_PROP_TIERS = 16;

/** A solid prop's surface, as its parameters hold it. */
export interface SurfaceParams {
  readonly friction: number;
  readonly restitution: number;
}

export function surface(f: Fields, what: string): SurfaceParams {
  return {
    friction: numberIn(f.friction, `${what}.friction`, 0, 1),
    restitution: numberIn(f.restitution, `${what}.restitution`, 0, 1),
  };
}

/** The tiers a hook acts on; empty for every coin, tiered or not. */
export function tiers(value: unknown, what: string): readonly string[] {
  return distinctStrings(value, what, MAX_PROP_TIERS);
}

export function acts(on: readonly string[], tier: string | null): boolean {
  return on.length === 0 || (tier !== null && on.includes(tier));
}
