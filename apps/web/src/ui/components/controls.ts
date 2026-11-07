import { feedback, tr, type UiContext } from '../context.ts';
import { h, listen } from '../dom.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { makePressable } from './pressable.ts';

const SLIDER_DETENT = 10;

export interface SliderOptions {
  readonly id: string;
  readonly label: () => string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}

export interface Control<T> {
  readonly el: HTMLElement;
  set(value: T): void;
}

/** 0..1 slider with a gold coin thumb; every 10 % detent ticks with sound and haptics. */
export function createSlider(ctx: UiContext, options: SliderOptions): Control<number> {
  const input = h('input', {
    class: 'cp-slider-input',
    attrs: {
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      id: options.id,
      'data-testid': options.id,
    },
  });
  const name = h('label', { class: 'cp-field-name', attrs: { for: options.id } });
  const readout = h('span', { class: 'cp-field-value', attrs: { 'aria-hidden': 'true' } });
  const el = h(
    'div',
    { class: 'cp-field cp-slider' },
    h('div', { class: 'cp-field-row' }, name, readout),
    input,
  );
  let detent = 0;

  const paint = (percent: number): void => {
    input.value = String(percent);
    el.style.setProperty('--cp-slider-fill', `${percent}%`);
    readout.textContent = String(percent);
    input.setAttribute('aria-valuetext', tr(ctx, 'settings.sliderValue', { value: percent }));
    detent = Math.floor(percent / SLIDER_DETENT);
  };
  ctx.loc.text(name, options.label);
  ctx.own(
    ctx.loc.bind(() => {
      paint(Number(input.value));
    }),
  );
  ctx.own(
    listen(input, 'input', () => {
      const percent = Number(input.value);
      const nextDetent = Math.floor(percent / SLIDER_DETENT);
      if (nextDetent !== detent) feedback(ctx, 'tick');
      paint(percent);
      options.onChange(percent / 100);
    }),
  );
  ctx.own(
    listen(input, 'pointerdown', () => {
      el.classList.add('is-dragging');
      feedback(ctx, 'tap');
    }),
  );
  for (const type of ['pointerup', 'pointercancel', 'blur'] as const) {
    ctx.own(
      listen(input, type, () => {
        el.classList.remove('is-dragging');
      }),
    );
  }
  paint(Math.round(options.value * 100));
  return {
    el,
    set(value) {
      paint(Math.round(value * 100));
    },
  };
}

export interface ToggleOptions {
  readonly id: string;
  readonly label: () => string;
  readonly hint: () => string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export function createToggle(ctx: UiContext, options: ToggleOptions): Control<boolean> {
  const knob = h('span', { class: 'cp-switch-knob' });
  const button = h(
    'button',
    {
      class: 'cp-switch',
      attrs: {
        type: 'button',
        role: 'switch',
        id: options.id,
        'aria-describedby': `${options.id}-hint`,
        'data-testid': options.id,
      },
    },
    knob,
  );
  const name = h('label', { class: 'cp-field-name', attrs: { for: options.id } });
  const hint = h('span', { class: 'cp-field-hint', attrs: { id: `${options.id}-hint` } });
  const el = h(
    'div',
    { class: 'cp-field cp-toggle' },
    h('div', { class: 'cp-field-text' }, name, hint),
    button,
  );
  let value = options.value;
  const travel = new SpringValue(value ? 1 : 0, SPRINGS.bouncy, (t) => {
    button.style.setProperty('--cp-switch', String(t));
  });
  const paint = (): void => {
    button.setAttribute('aria-checked', String(value));
    void travel.to(value ? 1 : 0);
  };
  ctx.loc.text(name, options.label);
  ctx.loc.text(hint, options.hint);
  makePressable(button, ctx, {
    feedback: 'toggle',
    onPress() {
      value = !value;
      paint();
      options.onChange(value);
    },
  });
  paint();
  return {
    el,
    set(next) {
      if (next === value) return;
      value = next;
      paint();
    },
  };
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: () => string;
}

export interface SegmentedOptions<T extends string> {
  readonly id: string;
  readonly label: () => string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

/** Radio group whose gold pill glides to the chosen option (a shared-layout indicator). */
export function createSegmented<T extends string>(
  ctx: UiContext,
  options: SegmentedOptions<T>,
): Control<T> {
  const labelId = `${options.id}-label`;
  const name = h('span', { class: 'cp-field-name', attrs: { id: labelId } });
  const pill = h('span', { class: 'cp-seg-pill', attrs: { 'aria-hidden': 'true' } });
  const group = h(
    'div',
    {
      class: 'cp-seg',
      attrs: { role: 'radiogroup', 'aria-labelledby': labelId, 'data-testid': options.id },
    },
    pill,
  );
  const el = h('div', { class: 'cp-field cp-segmented' }, name, group);
  let value = options.value;
  const buttons = new Map<T, HTMLButtonElement>();

  const left = new SpringValue(0, SPRINGS.snappy, (x) => {
    pill.style.translate = `${x}px 0`;
  });
  const width = new SpringValue(0, SPRINGS.snappy, (w) => {
    pill.style.width = `${w}px`;
  });
  const placePill = (animate: boolean): void => {
    const target = buttons.get(value);
    if (!target || target.offsetWidth === 0) return;
    if (animate) {
      void left.to(target.offsetLeft);
      void width.to(target.offsetWidth);
    } else {
      left.jump(target.offsetLeft);
      width.jump(target.offsetWidth);
    }
  };
  const paint = (animate: boolean): void => {
    for (const [optionValue, button] of buttons) {
      const checked = optionValue === value;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    placePill(animate);
  };
  const choose = (next: T, focus: boolean): void => {
    if (next !== value) {
      value = next;
      paint(true);
      options.onChange(next);
    }
    if (focus) buttons.get(next)?.focus();
  };

  for (const option of options.options) {
    const button = h('button', {
      class: 'cp-seg-option',
      attrs: { type: 'button', role: 'radio', 'data-value': option.value },
    });
    ctx.loc.text(button, option.label);
    makePressable(button, ctx, {
      feedback: 'tap',
      onPress() {
        choose(option.value, false);
      },
    });
    buttons.set(option.value, button);
    group.append(button);
  }
  ctx.own(
    listen(group, 'keydown', (event) => {
      const order = options.options.map((option) => option.value);
      const index = order.indexOf(value);
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const next = order[(index + step + order.length) % order.length];
      if (next !== undefined) {
        feedback(ctx, 'tap');
        choose(next, true);
      }
    }),
  );
  ctx.loc.text(name, options.label);
  ctx.own(
    ctx.loc.bind(() => {
      requestAnimationFrame(() => {
        placePill(false);
      });
    }),
  );
  const observer = new ResizeObserver(() => {
    placePill(false);
  });
  observer.observe(group);
  ctx.own(() => {
    observer.disconnect();
  });
  paint(false);
  return {
    el,
    set(next) {
      if (next === value) return;
      value = next;
      paint(true);
    },
  };
}
