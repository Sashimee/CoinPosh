import { h } from '../dom.ts';
import { schedule } from '../motion/loop.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import {
  OdometerTrack,
  wrapDigit,
  type OdometerColumn,
  type OdometerSwap,
} from './odometerMath.ts';

/** How far, in em, a swapped readout rises (or drops) into place. */
const SWAP_LIFT_EM = 0.35;
/** A swapped readout's opacity the moment it appears. */
const SWAP_FROM_OPACITY = 0.2;

interface Cell {
  readonly el: HTMLElement;
  readonly strip: HTMLElement | null;
}

function digitCell(): Cell {
  const strip = h('span', { class: 'cp-odo-strip' });
  for (let d = 0; d <= 10; d++) strip.append(h('span', { text: String(d % 10) }));
  return { el: h('span', { class: 'cp-odo-col' }, strip), strip };
}

function staticCell(char: string): Cell {
  return { el: h('span', { class: 'cp-odo-static', text: char }), strip: null };
}

/**
 * Serif rolling counter. Feed it formatted text; digits roll, separators and suffixes stay.
 * The wheels turn as one mechanical counter, so a mid-roll frame always reads as a number
 * between the old and new values, with no blank or half-faded column. A change of scale
 * (into compact notation, say) cannot count, so the whole readout eases in at its new value.
 */
export class Odometer {
  readonly el = h('span', { class: 'cp-odo', attrs: { 'aria-hidden': 'true' } });
  private readonly track = new OdometerTrack();
  private readonly cells = new Map<number, Cell>();
  private order: readonly number[] = [];
  private cancel: (() => void) | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  set(text: string, direction: 1 | -1): void {
    const now = this.now();
    this.track.push(text, direction, now, isReducedMotion());
    if (!this.render(now)) this.run();
  }

  /** Shows `text` immediately, with no roll. */
  jump(text: string): void {
    this.cancel?.();
    this.cancel = null;
    this.track.jump(text);
    this.render(this.now());
  }

  private run(): void {
    if (this.cancel) return;
    this.cancel = schedule(() => {
      const settled = this.render(this.now());
      if (settled) this.cancel = null;
      return !settled;
    });
  }

  /** Paints the current frame; returns true once every wheel is at rest. */
  private render(nowMs: number): boolean {
    const frame = this.track.sample(nowMs);
    for (const column of frame.columns) this.paint(column, frame.swap);
    const ids = frame.columns.map((column) => column.id);
    if (ids.length !== this.order.length || ids.some((id, i) => id !== this.order[i])) {
      const live = new Set(ids);
      for (const id of this.cells.keys()) if (!live.has(id)) this.cells.delete(id);
      this.el.replaceChildren(...ids.map((id) => this.cell(id).el));
      this.order = ids;
    }
    return frame.settled;
  }

  private paint(column: OdometerColumn, swap: OdometerSwap | null): void {
    let cell = this.cells.get(column.id);
    if (!cell) {
      cell = column.kind === 'digit' ? digitCell() : staticCell(column.char);
      this.cells.set(column.id, cell);
    }
    cell.el.style.display = column.hidden ? 'none' : '';
    cell.el.style.opacity = swap
      ? String(SWAP_FROM_OPACITY + (1 - SWAP_FROM_OPACITY) * swap.progress)
      : '';
    cell.el.style.transform = swap
      ? `translateY(${(1 - swap.progress) * SWAP_LIFT_EM * swap.direction}em)`
      : '';
    if (column.kind === 'digit' && cell.strip) {
      cell.strip.style.transform = `translateY(${-wrapDigit(column.position)}em)`;
    }
  }

  private cell(id: number): Cell {
    const cell = this.cells.get(id);
    if (!cell) throw new Error(`Odometer: no cell painted for column ${id}`);
    return cell;
  }
}
