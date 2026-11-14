import { feedback, tr, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { makePressable } from '../components/pressable.ts';
import { sharedLayoutMorph } from '../motion/morph.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { sharedSheetFocus } from './sheetFocus.ts';

const SHEET_RADIUS = 20;
const DISMISS_DISTANCE = 110;
const DISMISS_SPEED = 0.7;
const RUBBER_BAND = 0.18;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

export interface SheetOptions {
  readonly id: string;
  readonly title: () => string;
  readonly subtitle: () => string;
  readonly body: HTMLElement;
  readonly onRequestClose: () => void;
}

export interface Sheet {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(trigger: HTMLElement): void;
  close(): void;
}

/**
 * Bottom sheet that grows out of the button that opened it and shrinks back into it. Drag
 * the grip down (or press Escape, or tap the backdrop) to dismiss.
 */
export function createSheet(ctx: UiContext, options: SheetOptions): Sheet {
  const titleId = `${options.id}-title`;
  const title = h('h2', { class: 'cp-sheet-title', attrs: { id: titleId } });
  const subtitle = h('p', { class: 'cp-sheet-subtitle' });
  const closeButton = h(
    'button',
    { class: 'cp-icon-button cp-sheet-close', attrs: { type: 'button' } },
    icon('close'),
  );
  const grip = h('div', { class: 'cp-sheet-grip' }, h('span', { class: 'cp-sheet-grip-bar' }));
  const header = h(
    'header',
    { class: 'cp-sheet-header' },
    h('div', { class: 'cp-sheet-heading' }, title, subtitle),
    closeButton,
  );
  const content = h(
    'div',
    { class: 'cp-sheet-content' },
    grip,
    header,
    h('div', { class: 'cp-sheet-body' }, options.body),
  );
  const panel = h(
    'section',
    {
      class: 'cp-sheet cp-panel',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        tabindex: '-1',
        'data-testid': `sheet-${options.id}`,
      },
    },
    content,
  );
  const backdrop = h('div', { class: 'cp-backdrop', attrs: { 'aria-hidden': 'true' } });
  const layer = h('div', { class: 'cp-sheet-layer', attrs: { hidden: '' } }, backdrop, panel);

  ctx.loc.text(title, options.title);
  ctx.loc.text(subtitle, options.subtitle);
  ctx.loc.attr(closeButton, 'aria-label', () => tr(ctx, 'common.close'));
  ctx.loc.attr(grip, 'title', () => tr(ctx, 'common.dragToClose'));

  const morph = sharedLayoutMorph(panel, content, SHEET_RADIUS);
  const drag = new SpringValue(0, SPRINGS.snappy, (y) => {
    panel.style.translate = y === 0 ? '' : `0 ${y}px`;
  });
  let trigger: HTMLElement | null = null;
  let open = false;
  let generation = 0;

  const requestClose = (): void => {
    if (open) options.onRequestClose();
  };
  makePressable(closeButton, ctx, { feedback: 'close', onPress: requestClose });
  ctx.own(
    listen(backdrop, 'pointerdown', () => {
      feedback(ctx, 'close');
      requestClose();
    }),
  );
  const focus = sharedSheetFocus().register(
    layer,
    () => {
      feedback(ctx, 'close');
      requestClose();
    },
    content,
  );
  ctx.own(() => {
    focus.dispose();
  });
  // The shrinking panel still swallows taps, so they never fall through to the table as drops,
  // but it must not take focus back from the trigger while it closes.
  ctx.own(
    listen(panel, 'mousedown', (event) => {
      if (!open) event.preventDefault();
    }),
  );
  ctx.own(
    listen(layer, 'keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }),
  );

  let dragStart: { y: number; t: number } | null = null;
  let lastMove = { y: 0, t: 0 };
  let speed = 0;
  const onDragStart = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    dragStart = { y: event.clientY, t: event.timeStamp };
    lastMove = { y: event.clientY, t: event.timeStamp };
    speed = 0;
    drag.stop();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: PointerEvent): void => {
    if (!dragStart) return;
    const dy = event.clientY - dragStart.y;
    const dt = Math.max(1, event.timeStamp - lastMove.t);
    speed = (event.clientY - lastMove.y) / dt;
    lastMove = { y: event.clientY, t: event.timeStamp };
    drag.jump(dy >= 0 ? dy : dy * RUBBER_BAND);
  };
  const onDragEnd = (): void => {
    if (!dragStart) return;
    dragStart = null;
    if (drag.value > DISMISS_DISTANCE || speed > DISMISS_SPEED) {
      feedback(ctx, 'close');
      requestClose();
    } else {
      void drag.to(0, SPRINGS.bouncy);
    }
  };
  for (const handle of [grip, header]) {
    ctx.own(listen(handle, 'pointerdown', onDragStart));
    ctx.own(listen(handle, 'pointermove', onDragMove));
    ctx.own(listen(handle, 'pointerup', onDragEnd));
    ctx.own(listen(handle, 'pointercancel', onDragEnd));
  }

  return {
    el: layer,
    get isOpen() {
      return open;
    },
    open(source) {
      if (open) return;
      open = true;
      generation++;
      trigger = source;
      layer.hidden = false;
      layer.classList.toggle('is-reduced', isReducedMotion());
      drag.jump(0);
      restartAnimation(layer, 'is-open');
      if (isReducedMotion()) morph.jump(true);
      else void morph.open(source.getBoundingClientRect());
      focus.opened();
      panel.focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      open = false;
      const closing = ++generation;
      layer.classList.remove('is-open');
      layer.classList.toggle('is-reduced', isReducedMotion());
      void drag.to(0);
      const restoreFocus = focus.closing(trigger);
      const finish = (): void => {
        if (closing !== generation) return;
        restoreFocus();
        layer.hidden = true;
      };
      if (isReducedMotion() || !trigger) {
        morph.jump(false);
        setTimeout(finish, 180);
      } else {
        void morph.close(trigger.getBoundingClientRect()).then(finish);
      }
    },
  };
}
