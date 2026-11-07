import type { FeedbackKind } from '../../app/state.ts';
import { feedback, type UiContext } from '../context.ts';
import { listen } from '../dom.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';

export const PRESSED_SCALE = 0.96;
const DENY_SHAKE = 260;

export interface PressableOptions {
  readonly feedback: FeedbackKind | (() => FeedbackKind);
  readonly onPress: () => void;
  /** Refused presses play the deny shake instead of `onPress`. Defaults to `aria-disabled`. */
  readonly enabled?: () => boolean;
}

/**
 * The house press: springs down to 0.96 with a collapsing shadow, a sound and a haptic tick
 * on touch-down, then overshoots back on release. Keyboard activation gets the same cues.
 */
export function makePressable(el: HTMLElement, ctx: UiContext, options: PressableOptions): void {
  const scale = new SpringValue(1, SPRINGS.press, (value) => {
    el.style.scale = value === 1 ? '' : String(value);
  });
  const shake = new SpringValue(0, SPRINGS.pop, (value) => {
    el.style.translate = value === 0 ? '' : `${value}px 0`;
  });
  let pointerCued = false;
  const enabled = options.enabled ?? (() => el.getAttribute('aria-disabled') !== 'true');

  const kind = (): FeedbackKind =>
    typeof options.feedback === 'function' ? options.feedback() : options.feedback;
  const release = (): void => {
    el.classList.remove('is-pressed');
    void scale.to(1, SPRINGS.release);
  };

  ctx.own(
    listen(el, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      el.classList.add('is-pressed');
      void scale.to(PRESSED_SCALE, SPRINGS.press);
      pointerCued = true;
      if (enabled()) feedback(ctx, kind());
    }),
  );
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    ctx.own(listen(el, type, release));
  }
  ctx.own(
    listen(el, 'click', () => {
      const cued = pointerCued;
      pointerCued = false;
      if (!enabled()) {
        feedback(ctx, 'deny');
        shake.kick(DENY_SHAKE);
        return;
      }
      if (!cued) {
        feedback(ctx, kind());
        scale.jump(PRESSED_SCALE);
        release();
      }
      options.onPress();
    }),
  );
}
