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

/** Every change lands within this long, however many credits pile up behind it. */
export const ROLL_MS = 240;
/** Changes arriving this soon after a roll starts join it and keep its landing time. */
export const COALESCE_MS = 150;
/** A wheel that would pass more digits than this in one roll ticks whole digits instead. */
const SPIN_DIGITS = 10;

export type OdometerColumn =
  | {
      readonly id: number;
      readonly kind: 'digit';
      readonly position: number;
      readonly hidden: boolean;
    }
  | {
      readonly id: number;
      readonly kind: 'static';
      readonly char: string;
      readonly hidden: boolean;
    };

/** A whole readout easing in after a change of scale: 0 just swapped, 1 at rest. */
export interface OdometerSwap {
  readonly direction: 1 | -1;
  readonly progress: number;
}

export interface OdometerFrame {
  readonly columns: readonly OdometerColumn[];
  readonly settled: boolean;
  readonly swap: OdometerSwap | null;
}

interface Slot {
  readonly id: number;
  readonly glyph: Glyph;
}

interface RollTiming {
  readonly startMs: number;
  readonly batchStartMs: number;
  readonly endMs: number;
}

/** One change's share of a count, eased in over its own window. */
interface Leg {
  readonly startMs: number;
  readonly endMs: number;
  readonly delta: number;
}

/**
 * The counter turns as one number: each wheel follows the value, carries included. The value
 * is the sum of every change's own eased leg, so a change pushed mid-roll never slows the
 * changes already under way and each one is fully counted in by its own landing.
 */
interface CountingRoll extends RollTiming {
  readonly baseValue: number;
  readonly legs: readonly Leg[];
  readonly ticksBelow: number;
  /** Wheels that always show: more than the value needs only when a text shows leading zeros. */
  readonly minPlaces: number;
}

/**
 * The text changed scale (a new compact suffix, say), so no wheel's old digit relates to its
 * new one: rolling them would read as numbers the balance never held. The wheels show the new
 * text at once and the whole readout eases in instead.
 */
interface Swap {
  readonly direction: 1 | -1;
  readonly startMs: number;
  readonly endMs: number;
}

function easeOutQuart(t: number): number {
  const x = 1 - Math.min(1, Math.max(0, t));
  return 1 - x * x * x * x;
}

function digitsValue(glyphs: readonly Glyph[]): number {
  let value = 0;
  for (const glyph of glyphs) if (glyph.kind === 'digit') value = value * 10 + glyph.digit;
  return value;
}

function digitCount(glyphs: readonly Glyph[]): number {
  return glyphs.filter((glyph) => glyph.kind === 'digit').length;
}

/** The wheels a reading of `places` digits keeps for `value`: all of them only if it pads with zeros. */
function paddedPlaces(places: number, value: number): number {
  return String(Math.max(0, Math.round(value))).length < places ? places : 1;
}

function sameGlyphs(a: readonly Glyph[], b: readonly Glyph[]): boolean {
  return (
    a.length === b.length &&
    a.every((glyph, i) => {
      const other = b[i];
      if (glyph.kind === 'digit') return other?.kind === 'digit' && other.digit === glyph.digit;
      return other?.kind === 'static' && other.char === glyph.char;
    })
  );
}

/**
 * Two texts can count into each other when they agree glyph for glyph from the right and
 * the longer one only adds leading digits (with their group separators). Their digits then
 * read as integers on one scale, so "999" → "1,000" counts but "9.9K" → "10K" cannot.
 */
export function canCount(a: readonly Glyph[], b: readonly Glyph[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.some((glyph) => glyph.kind === 'digit')) return false;
  for (let i = 1; i <= short.length; i++) {
    const x = short[short.length - i];
    const y = long[long.length - i];
    if (!x || !y) return false;
    if (x.kind !== y.kind) return false;
    if (x.kind === 'static' && y.kind === 'static' && x.char !== y.char) return false;
  }
  return long.length === short.length || long[0]?.kind === 'digit';
}

/**
 * Wheel `place` (0 = units) of a mechanical counter showing `value`: it rests on its digit
 * and turns only while every wheel below it rolls over from 9 to 0.
 */
export function wheelPosition(value: number, place: number): number {
  if (place === 0) return value;
  const unit = 10 ** place;
  const whole = Math.floor(value / unit);
  return whole + Math.max(0, value - whole * unit - (unit - 1));
}

/** The text a frame shows: each wheel reads as the digit filling most of its window. */
export function readout(columns: readonly OdometerColumn[]): string {
  return columns
    .filter((column) => !column.hidden)
    .map((column) =>
      column.kind === 'static' ? column.char : String(wrapDigit(Math.round(column.position))),
    )
    .join('');
}

/**
 * The odometer's motion as a pure function of an injected clock: `push` aims at new text,
 * `sample` says where every wheel sits at a given time. Steady credits cannot keep it
 * rolling, since each lands within ROLL_MS and those inside COALESCE_MS share one landing.
 */
export class OdometerTrack {
  private slots: Slot[] = [];
  private target: Glyph[] = [];
  private roll: CountingRoll | null = null;
  private swap: Swap | null = null;
  private nextId = 0;

  /** Shows `text` at once, with no roll. */
  jump(text: string): void {
    this.roll = null;
    this.swap = null;
    this.target = splitGlyphs(text);
    this.relayout(this.target);
  }

  push(text: string, direction: 1 | -1, nowMs: number, reduced: boolean): void {
    this.advance(nowMs);
    if (reduced || this.slots.length === 0) {
      this.jump(text);
      return;
    }
    const glyphs = splitGlyphs(text);
    if (sameGlyphs(glyphs, this.target)) return;
    if (
      !canCount(
        this.slots.map((slot) => slot.glyph),
        glyphs,
      )
    ) {
      this.roll = null;
      this.target = glyphs;
      this.relayout(glyphs);
      this.swap = { direction, startMs: nowMs, endMs: nowMs + ROLL_MS };
      return;
    }
    const joined = this.roll && nowMs - this.roll.batchStartMs < COALESCE_MS ? this.roll : null;
    const timing: RollTiming = {
      startMs: nowMs,
      batchStartMs: joined?.batchStartMs ?? nowMs,
      endMs: joined?.endMs ?? nowMs + ROLL_MS,
    };
    const fromValue = this.countedValue(nowMs);
    const toValue = digitsValue(glyphs);
    const previous = this.roll;
    const minPlaces = Math.max(
      paddedPlaces(this.shownPlaces(nowMs), fromValue),
      paddedPlaces(digitCount(glyphs), toValue),
    );
    if (glyphs.length > this.slots.length) this.relayout(glyphs);
    const turns = Math.abs(toValue - fromValue);
    let ticksBelow = previous?.ticksBelow ?? 0;
    while (turns / 10 ** ticksBelow > SPIN_DIGITS) ticksBelow++;
    const running = previous?.legs.filter((leg) => leg.endMs > nowMs) ?? [];
    const baseValue =
      (previous?.baseValue ?? digitsValue(this.target)) +
      (previous?.legs ?? []).reduce((sum, leg) => (leg.endMs > nowMs ? sum : sum + leg.delta), 0);
    const leg = {
      startMs: nowMs,
      endMs: timing.endMs,
      delta: toValue - digitsValue(this.target),
    };
    this.roll = {
      baseValue,
      legs: [...running, leg],
      ticksBelow,
      minPlaces,
      ...timing,
    };
    this.target = glyphs;
  }

  sample(nowMs: number): OdometerFrame {
    this.advance(nowMs);
    const positions = this.positions(nowMs);
    const hidden = this.leadingZeros(nowMs);
    const columns = this.slots.map((slot, i): OdometerColumn =>
      slot.glyph.kind === 'static'
        ? { id: slot.id, kind: 'static', char: slot.glyph.char, hidden: hidden[i] ?? false }
        : { id: slot.id, kind: 'digit', position: positions[i] ?? 0, hidden: hidden[i] ?? false },
    );
    const swap = this.swap
      ? { direction: this.swap.direction, progress: progress(this.swap, nowMs) }
      : null;
    return { columns, settled: this.roll === null && swap === null, swap };
  }

  /**
   * How many columns on the left to hide mid-count: a wider layout kept for a shrink, or a
   * new column added for a grow, would otherwise read as a leading zero. A hidden wheel
   * shows again once the counted value reaches it, which is exactly when it starts to read 1.
   */
  private leadingZeros(nowMs: number): boolean[] {
    const hidden = new Array<boolean>(this.slots.length).fill(false);
    const roll = this.roll;
    if (!roll) return hidden;
    const places = Math.max(
      roll.minPlaces,
      String(Math.max(0, Math.round(this.countedValue(nowMs)))).length,
    );
    let hiddenDigits = digitCount(this.slots.map((slot) => slot.glyph)) - places;
    let index = this.slots.findIndex((slot) => slot.glyph.kind === 'digit');
    for (; hiddenDigits > 0 && index < this.slots.length; index++) {
      if (this.slots[index]?.glyph.kind === 'digit') hiddenDigits--;
      hidden[index] = true;
    }
    for (; this.slots[index]?.glyph.kind === 'static'; index++) hidden[index] = true;
    return hidden;
  }

  private shownPlaces(nowMs: number): number {
    const hidden = this.leadingZeros(nowMs);
    return this.slots.filter((slot, i) => slot.glyph.kind === 'digit' && !hidden[i]).length;
  }

  private advance(nowMs: number): void {
    if (this.roll && nowMs >= this.roll.endMs) {
      this.roll = null;
      this.relayout(this.target);
    }
    if (this.swap && nowMs >= this.swap.endMs) this.swap = null;
  }

  private countedValue(nowMs: number): number {
    const roll = this.roll;
    if (!roll) return digitsValue(this.target);
    return roll.legs.reduce(
      (value, leg) => value + leg.delta * progress(leg, nowMs),
      roll.baseValue,
    );
  }

  private positions(nowMs: number): number[] {
    const roll = this.roll;
    if (!roll) {
      return this.slots.map((slot) => (slot.glyph.kind === 'digit' ? slot.glyph.digit : 0));
    }
    const value = this.countedValue(nowMs);
    const positions = new Array<number>(this.slots.length).fill(0);
    let place = 0;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      if (this.slots[i]?.glyph.kind !== 'digit') continue;
      const position = wheelPosition(value, place);
      positions[i] = place < roll.ticksBelow ? Math.round(position) : position;
      place++;
    }
    return positions;
  }

  /** Swaps the layout for `glyphs`, keeping the ids of the columns that stay. */
  private relayout(glyphs: readonly Glyph[]): (number | null)[] {
    const reuse = alignFromRight(
      this.slots.map((slot) => slot.glyph),
      glyphs,
    );
    this.slots = glyphs.map((glyph, i) => {
      const oldIndex = reuse[i];
      const old = oldIndex === null || oldIndex === undefined ? undefined : this.slots[oldIndex];
      return { id: old?.id ?? this.nextId++, glyph };
    });
    return reuse;
  }
}

function progress(
  span: { readonly startMs: number; readonly endMs: number },
  nowMs: number,
): number {
  return easeOutQuart((nowMs - span.startMs) / (span.endMs - span.startMs));
}
