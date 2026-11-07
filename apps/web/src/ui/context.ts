import type { Bus } from '../app/bus.ts';
import type { FeedbackKind, UiEvents, UiState } from '../app/state.ts';
import type { Store } from '../app/store.ts';
import type { I18n, InterpolationValues } from '../i18n/index.ts';
import type { Localizer } from './localize.ts';

export interface UiContext {
  readonly i18n: I18n;
  readonly loc: Localizer;
  readonly store: Store<UiState>;
  readonly bus: Bus<UiEvents>;
  /** Registers teardown work for when the UI unmounts. */
  own(dispose: () => void): void;
}

export function tr(ctx: UiContext, key: string, values?: InterpolationValues): string {
  return ctx.i18n.t(key, values);
}

export function feedback(ctx: UiContext, kind: FeedbackKind): void {
  ctx.bus.emit('ui:feedback', { kind });
}
