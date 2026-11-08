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

/** Every change lands within this long, however many credits pile up behind it. */
export const ROLL_MS = 240;
/** Changes arriving this soon after a roll starts join it and keep its landing time. */
export const COALESCE_MS = 150;
/** A wheel that would pass more digits than this in one roll ticks whole digits instead. */
const SPIN_DIGITS = 10;

export type OdometerColumn =
  | { readonly id: number; readonly kind: 'digit'; readonly position: number }
  | { readonly id: number; readonly kind: 'static'; readonly char: string };

export interface OdometerFrame {
  readonly columns: readonly OdometerColumn[];
  readonly settled: boolean;
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

/** The counter turns as one number: each wheel follows the value, carries included. */
interface CountingRoll extends RollTiming {
  readonly kind: 'counting';
  readonly fromValue: number;
  readonly toValue: number;
  readonly ticksBelow: number;
}

/** The text changed shape (a new compact suffix, say): each wheel rolls straight to its digit. */
interface DirectRoll extends RollTiming {
  readonly kind: 'direct';
  readonly from: readonly number[];
  readonly to: readonly number[];
}

type Roll = CountingRoll | DirectRoll;

function easeOutQuart(t: number): number {
  const x = 1 - Math.min(1, Math.max(0, t));
  return 1 - x * x * x * x;
}

function digitsValue(glyphs: readonly Glyph[]): number {
  let value = 0;
  for (const glyph of glyphs) if (glyph.kind === 'digit') value = value * 10 + glyph.digit;
  return value;
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
  private roll: Roll | null = null;
  private nextId = 0;

  /** Shows `text` at once, with no roll. */
  jump(text: string): void {
    this.roll = null;
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
    const joined = this.roll && nowMs - this.roll.batchStartMs < COALESCE_MS ? this.roll : null;
    const timing: RollTiming = {
      startMs: nowMs,
      batchStartMs: joined?.batchStartMs ?? nowMs,
      endMs: joined?.endMs ?? nowMs + ROLL_MS,
    };
    const counting = this.roll === null || this.roll.kind === 'counting';
    if (
      counting &&
      canCount(
        this.slots.map((slot) => slot.glyph),
        glyphs,
      )
    ) {
      const fromValue = this.countedValue(nowMs);
      const toValue = digitsValue(glyphs);
      if (glyphs.length > this.slots.length) this.relayout(glyphs);
      const turns = Math.abs(toValue - fromValue);
      let ticksBelow = 0;
      while (turns / 10 ** ticksBelow > SPIN_DIGITS) ticksBelow++;
      this.roll = { kind: 'counting', fromValue, toValue, ticksBelow, ...timing };
    } else {
      const current = this.positions(nowMs);
      const reuse = this.relayout(glyphs);
      const from = glyphs.map((glyph, i) => {
        const oldIndex = reuse[i];
        const old = oldIndex === null || oldIndex === undefined ? undefined : current[oldIndex];
        return glyph.kind === 'digit' ? (old ?? glyph.digit) : 0;
      });
      const to = glyphs.map((glyph, i) =>
        glyph.kind === 'digit' ? rollTarget(from[i] ?? 0, glyph.digit, direction) : 0,
      );
      this.roll = { kind: 'direct', from, to, ...timing };
    }
    this.target = glyphs;
  }

  sample(nowMs: number): OdometerFrame {
    this.advance(nowMs);
    const positions = this.positions(nowMs);
    const columns = this.slots.map((slot, i): OdometerColumn =>
      slot.glyph.kind === 'static'
        ? { id: slot.id, kind: 'static', char: slot.glyph.char }
        : { id: slot.id, kind: 'digit', position: positions[i] ?? 0 },
    );
    return { columns, settled: this.roll === null };
  }

  private advance(nowMs: number): void {
    if (this.roll && nowMs >= this.roll.endMs) {
      this.roll = null;
      this.relayout(this.target);
    }
  }

  private countedValue(nowMs: number): number {
    const roll = this.roll;
    if (roll?.kind !== 'counting') return digitsValue(this.target);
    return roll.fromValue + (roll.toValue - roll.fromValue) * progress(roll, nowMs);
  }

  private positions(nowMs: number): number[] {
    const roll = this.roll;
    if (!roll) {
      return this.slots.map((slot) => (slot.glyph.kind === 'digit' ? slot.glyph.digit : 0));
    }
    if (roll.kind === 'direct') {
      const t = progress(roll, nowMs);
      return roll.from.map((from, i) => from + ((roll.to[i] ?? from) - from) * t);
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

function progress(roll: RollTiming, nowMs: number): number {
  return easeOutQuart((nowMs - roll.startMs) / (roll.endMs - roll.startMs));
}
