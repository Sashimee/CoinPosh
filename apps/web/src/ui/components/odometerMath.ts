export type Glyph =
  | { readonly kind: 'digit'; readonly digit: number }
  | { readonly kind: 'static'; readonly char: string };

export function splitGlyphs(text: string): Glyph[] {
  return Array.from(text, (char): Glyph =>
    char >= '0' && char <= '9'
      ? { kind: 'digit', digit: char.charCodeAt(0) - 48 }
      : { kind: 'static', char },
  );
}

export function wrapDigit(position: number): number {
  return ((position % 10) + 10) % 10;
}

/**
 * A digit column's position is an unbounded count of turns; the shown digit is it mod 10.
 * Rising values always roll forward (9 → 0 passes through the top) and falling values roll
 * backward, the way a mechanical counter does.
 */
export function rollTarget(from: number, digit: number, direction: 1 | -1): number {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    throw new RangeError(`Odometer digit must be 0..9, got ${digit}`);
  }
  const current = wrapDigit(Math.round(from));
  const base = Math.round(from);
  if (direction > 0) return base + ((digit - current + 10) % 10);
  return base - ((current - digit + 10) % 10);
}

/**
 * Pairs new glyphs with existing columns from the right, so units stay aligned when the
 * number grows a digit. Returns, for each new glyph, the index of the old column it reuses.
 */
export function alignFromRight(
  previous: readonly Glyph[],
  next: readonly Glyph[],
): (number | null)[] {
  return next.map((glyph, i) => {
    const fromRight = next.length - 1 - i;
    const oldIndex = previous.length - 1 - fromRight;
    const old = previous[oldIndex];
    if (old?.kind !== glyph.kind) return null;
    if (glyph.kind === 'static' && old.kind === 'static' && old.char !== glyph.char) return null;
    return oldIndex;
  });
}
