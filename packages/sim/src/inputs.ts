/** Mirrors NudgeDirection in packages/shared, which packages/sim cannot import yet. */
export type NudgeDirection = 'left' | 'right' | 'forward';

export const NUDGE_DIRECTIONS: readonly NudgeDirection[] = ['left', 'right', 'forward'];

/**
 * Player inputs, replayed tick by tick by the server auditor. Positions are integer
 * millimetres so an input log round-trips through JSON or a binary encoding
 * without any float drift.
 */
export interface DropCoinInput {
  readonly kind: 'dropCoin';
  /** Lateral drop position from the table centre line, in millimetres. */
  readonly xMm: number;
  /**
   * The tier of the dropped coin, from the ladder the Sim was created with; the lowest
   * when omitted. Only a Sim with mechanics takes one.
   */
  readonly tier?: string;
}

/** A jolt to the cabinet that shoves every coin the same way; see NUDGE. */
export interface NudgeInput {
  readonly kind: 'nudge';
  readonly direction: NudgeDirection;
}

/**
 * A Vault Crate the server spawned, dropped onto the front of the upper tier (CRATE_BODY).
 * Its depth offset and turn are drawn from the Sim's PRNG, like a coin's.
 */
export interface DropCrateInput {
  readonly kind: 'dropCrate';
  /** Lateral drop position from the table centre line, in millimetres. */
  readonly xMm: number;
}

export type SimInput = DropCoinInput | NudgeInput | DropCrateInput;

export const MAX_DROP_OFFSET_MM = 150;

/** Narrower than a coin's: a crate keeps its bounding sphere clear of the guide walls (CRATE_MAX_X). */
export const MAX_CRATE_OFFSET_MM = 120;

/**
 * Throws unless `input` is well formed. `tiers` is the Sim's tier ladder, or null for
 * a Sim without mechanics, which takes no tier.
 */
export function assertValidInput(
  input: SimInput,
  tick: number,
  tiers: readonly string[] | null,
): void {
  const kind: string = input.kind;
  switch (input.kind) {
    case 'dropCoin':
      if (
        !Number.isInteger(input.xMm) ||
        input.xMm < -MAX_DROP_OFFSET_MM ||
        input.xMm > MAX_DROP_OFFSET_MM
      ) {
        throw new RangeError(
          `Tick ${tick}: dropCoin.xMm must be an integer in [-${MAX_DROP_OFFSET_MM}, ${MAX_DROP_OFFSET_MM}], got ${input.xMm}`,
        );
      }
      if (input.tier !== undefined && !tiers?.includes(input.tier)) {
        throw new RangeError(
          tiers
            ? `Tick ${tick}: dropCoin.tier must be one of ${tiers.join(', ')}, got ${JSON.stringify(input.tier)}`
            : `Tick ${tick}: dropCoin.tier needs a Sim created with mechanics, got ${JSON.stringify(input.tier)}`,
        );
      }
      return;
    case 'nudge':
      if (!NUDGE_DIRECTIONS.includes(input.direction)) {
        throw new RangeError(
          `Tick ${tick}: nudge.direction must be one of ${NUDGE_DIRECTIONS.join(', ')}, got ${JSON.stringify(input.direction)}`,
        );
      }
      return;
    case 'dropCrate':
      if (
        !Number.isInteger(input.xMm) ||
        input.xMm < -MAX_CRATE_OFFSET_MM ||
        input.xMm > MAX_CRATE_OFFSET_MM
      ) {
        throw new RangeError(
          `Tick ${tick}: dropCrate.xMm must be an integer in [-${MAX_CRATE_OFFSET_MM}, ${MAX_CRATE_OFFSET_MM}], got ${input.xMm}`,
        );
      }
      return;
    default:
      throw new TypeError(`Tick ${tick}: unknown sim input kind ${JSON.stringify(kind)}`);
  }
}
