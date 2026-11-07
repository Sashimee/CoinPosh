/**
 * Player inputs, replayed tick by tick by the server auditor. Positions are integer
 * millimetres so an input log round-trips through JSON or a binary encoding
 * without any float drift.
 */
export interface DropCoinInput {
  readonly kind: 'dropCoin';
  /** Lateral drop position from the table centre line, in millimetres. */
  readonly xMm: number;
}

export type SimInput = DropCoinInput;

export const MAX_DROP_OFFSET_MM = 150;

export function assertValidInput(input: SimInput, tick: number): void {
  const kind: string = input.kind;
  switch (kind) {
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
      return;
    default:
      throw new TypeError(`Tick ${tick}: unknown sim input kind ${JSON.stringify(kind)}`);
  }
}
