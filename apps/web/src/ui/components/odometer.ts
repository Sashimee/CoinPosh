import { h } from '../dom.ts';
import type { SpringConfig } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { alignFromRight, rollTarget, splitGlyphs, wrapDigit, type Glyph } from './odometerMath.ts';

interface Column {
  readonly el: HTMLElement;
  readonly glyph: Glyph;
  readonly roll: SpringValue | null;
}

/** Right-hand columns roll faster, like the light wheels of a real counter. */
function columnSpring(fromRight: number): SpringConfig {
  const stiffness = 280 - 26 * Math.min(fromRight, 6);
  return { stiffness, damping: 1.7 * Math.sqrt(stiffness), restDelta: 0.002 };
}

function digitColumn(start: number, fromRight: number): Column {
  const strip = h('span', { class: 'cp-odo-strip' });
  for (let d = 0; d <= 10; d++) strip.append(h('span', { text: String(d % 10) }));
  const el = h('span', { class: 'cp-odo-col' }, strip);
  const roll = new SpringValue(start, columnSpring(fromRight), (position) => {
    strip.style.transform = `translateY(${-wrapDigit(position)}em)`;
  });
  return { el, glyph: { kind: 'digit', digit: wrapDigit(start) }, roll };
}

function staticColumn(char: string): Column {
  return {
    el: h('span', { class: 'cp-odo-static', text: char }),
    glyph: { kind: 'static', char },
    roll: null,
  };
}

/** Serif rolling counter. Feed it formatted text; digits roll, separators and suffixes stay. */
export class Odometer {
  readonly el = h('span', { class: 'cp-odo', attrs: { 'aria-hidden': 'true' } });
  private columns: Column[] = [];

  set(text: string, direction: 1 | -1): void {
    const glyphs = splitGlyphs(text);
    const previous = this.columns;
    const reuse = alignFromRight(
      previous.map((column) => column.glyph),
      glyphs,
    );
    const next: Column[] = glyphs.map((glyph, i) => {
      const oldIndex = reuse[i];
      const fromRight = glyphs.length - 1 - i;
      const old = oldIndex === null || oldIndex === undefined ? undefined : previous[oldIndex];
      if (glyph.kind === 'static') return old ?? staticColumn(glyph.char);
      if (old?.roll) {
        void old.roll.to(rollTarget(old.roll.target, glyph.digit, direction));
        return { ...old, glyph };
      }
      const column = digitColumn(0, fromRight);
      if (previous.length > 0) column.el.classList.add('cp-odo-enter');
      void column.roll?.to(rollTarget(0, glyph.digit, 1));
      return { ...column, glyph };
    });
    const kept = new Set(next.map((column) => column.el));
    for (const column of previous) {
      if (!kept.has(column.el)) {
        column.roll?.stop();
        column.el.remove();
      }
    }
    this.el.replaceChildren(...next.map((column) => column.el));
    this.columns = next;
  }

  /** Shows `text` immediately, with no roll. */
  jump(text: string): void {
    for (const column of this.columns) column.roll?.stop();
    this.columns = [];
    this.el.replaceChildren();
    this.set(text, 1);
    for (const column of this.columns) {
      if (column.glyph.kind === 'digit') column.roll?.jump(column.glyph.digit);
    }
  }
}
