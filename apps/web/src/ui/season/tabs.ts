import { makePressable } from '../components/pressable.ts';
import type { UiContext } from '../context.ts';
import { listen } from '../dom.ts';

export interface SeasonTabsOptions<T extends string> {
  readonly buttons: Readonly<Record<T, HTMLElement>>;
  readonly list: HTMLElement;
  readonly order: readonly T[];
  readonly current: () => T;
  /**
   * Shows `next`. `withBus` is true only on the keyboard path: a press already sent the bus
   * cue from its pressable, so the tab cue must not send it again.
   */
  readonly select: (next: T, withBus: boolean) => void;
}

/** Wires presses and the arrow, Home and End keys of a tab list. */
export function wireSeasonTabs<T extends string>(
  ctx: UiContext,
  options: SeasonTabsOptions<T>,
): void {
  const { buttons, list, order } = options;
  for (const name of order) {
    makePressable(buttons[name], ctx, {
      feedback: 'toggle',
      enabled: () => true,
      onPress: () => {
        options.select(name, false);
      },
    });
  }
  ctx.own(
    listen(list, 'keydown', (event) => {
      if (
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowRight' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      )
        return;
      event.preventDefault();
      const index = order.indexOf(options.current());
      const next =
        event.key === 'Home'
          ? order[0]
          : event.key === 'End'
            ? order[order.length - 1]
            : order[(index + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      if (next === undefined) return;
      options.select(next, true);
      buttons[next].focus();
    }),
  );
}
