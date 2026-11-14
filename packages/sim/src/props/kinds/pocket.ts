import type { PropKind } from '../kind.ts';
import { bool, fields } from '../params.ts';
import { acts, tiers } from './common.ts';

export interface PocketParams {
  /** Takes the coin off the table as it enters. */
  readonly take: boolean;
  /** Carried by the prop.enter event; null for none. */
  readonly tag: string | null;
  /** The tiers it acts on; empty for every coin. */
  readonly tiers: readonly string[];
}

export const MAX_TAG_LENGTH = 32;

function tag(value: unknown, what: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TAG_LENGTH) {
    throw new TypeError(
      `${what} must be null or a string of 1 to ${MAX_TAG_LENGTH} characters, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** A target with no collider: a coin whose centre comes inside its shape enters it. */
export const POCKET: PropKind<PocketParams> = {
  body: 'ghost',
  parse(raw, what) {
    const f = fields(raw, what, ['take', 'tag', 'tiers']);
    return {
      take: bool(f.take, `${what}.take`),
      tag: tag(f.tag, `${what}.tag`),
      tiers: tiers(f.tiers, `${what}.tiers`),
    };
  },
  enter: {
    margin: () => 0,
    onEnter: (coin, { params }) =>
      acts(params.tiers, coin.tier) ? { consume: params.take, tag: params.tag } : null,
  },
};
