import './safes.css';
import { safes as safesConfig } from '@coinposh/economy';
import type { Safe, SafeId, SafeOpenMethod } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { formatInteger, type InterpolationValues } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { h, restartAnimation } from '../../ui/dom.ts';
import { icon } from '../../ui/icons.ts';
import { Localizer } from '../../ui/localize.ts';
import { sharedSheetFocus } from '../../ui/panels/sheetFocus.ts';
import { cratesKey, registerCratesStrings } from '../crates/i18n.ts';
import { crateOdds, oddsShare } from '../crates/odds.ts';
import { formatCountdown, msToNextSecond } from './countdown.ts';
import { registerSafesStrings, safesKey, safeTypeKey, type SafesKey } from './i18n.ts';
import { safeActions, type SafeActions } from './plan.ts';

/** A ratchet click as a row's timer runs out and its free Open appears. */
const READY_SOUND: readonly ImpactEvent[] = [
  { material: 'metal', velocity: 0.9, pan: 0 },
  { material: 'coin', velocity: 0.6, pan: 0.2 },
];
const STATUS_ID = 'cp-safes-status';

export interface SafesPanelOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  readonly host: HTMLElement;
  /** The server-clock estimate; null until the session has synced. */
  readonly serverNow: () => number | null;
  readonly safes: () => readonly Safe[];
  /** Keys to show, with any Key open still in flight already taken off. */
  readonly keys: () => number | null;
  /** Keys still to be confirmed by the server: the balance is marked provisional. */
  readonly keysProvisional: () => boolean;
  readonly pending: (safeId: SafeId) => SafeOpenMethod | null;
  /** Any safe is opening; every row waits. */
  readonly busy: () => boolean;
  readonly onOpen: (safe: Safe, method: SafeOpenMethod) => void;
  readonly onClose: () => void;
  readonly audio?: () => { playImpact(event: ImpactEvent): void } | null;
  readonly reducedMotion: boolean;
}

export interface SafesPanel {
  readonly el: HTMLElement;
  /** Repaints every row from the current safes, Keys and server clock. */
  render(): void;
  /** Puts a line in the live status region, e.g. a refusal. */
  say(message: string, safeId?: SafeId): void;
  dispose(): void;
}

interface Row {
  readonly item: HTMLElement;
  readonly render: (safe: Safe) => SafeActions;
  readonly deny: () => void;
  ready: boolean | null;
}

/**
 * The safes sheet: each owned safe with its server-clocked countdown, "Open with N Keys" while
 * it is locked and a free "Open" once its timer has run out, the Keys balance, and the odds the
 * server rolls with. It never decides an open: presses go to `onOpen` and the server answers.
 */
export function showSafesPanel(options: SafesPanelOptions): SafesPanel {
  const { ui } = options;
  registerSafesStrings(ui.i18n);
  registerCratesStrings(ui.i18n);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(ui.i18n);
  const ctx: UiContext = {
    i18n: ui.i18n,
    loc,
    store: ui.store,
    bus: ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const t = (key: SafesKey, values?: InterpolationValues) => ui.i18n.t(safesKey(key), values);
  const int = (value: number) => formatInteger(value, ui.i18n.language);
  const typeName = (type: string) => ui.i18n.t(safeTypeKey(type));
  const opener = document.activeElement;
  const trigger = opener instanceof HTMLElement && opener !== document.body ? opener : null;

  const title = h('h2', { class: 'cp-safes-title', attrs: { id: 'cp-safes-title' } });
  const subtitle = h('p', { class: 'cp-safes-subtitle' });
  const close = h(
    'button',
    { class: 'cp-safes-close', attrs: { type: 'button', 'data-testid': 'safes-close' } },
    icon('close'),
  );
  const keysValue = h('span', { class: 'cp-safes-keys-value' });
  const keysNote = h('span', { class: 'cp-safes-keys-note' });
  const keys = h(
    'p',
    { class: 'cp-safes-keys', attrs: { 'data-testid': 'safes-keys' } },
    keysValue,
    keysNote,
  );
  const empty = h('p', { class: 'cp-safes-empty', attrs: { 'data-testid': 'safes-empty' } });
  const list = h('ul', { class: 'cp-safes-list' });
  const status = h('p', {
    class: 'cp-safes-status',
    attrs: { id: STATUS_ID, 'aria-live': 'polite', 'data-testid': 'safes-status' },
  });
  const oddsList = h('dl', { class: 'cp-safes-odds' });
  const card = h(
    'div',
    { class: 'cp-safes-card' },
    close,
    title,
    subtitle,
    keys,
    status,
    empty,
    list,
    oddsList,
  );
  const root = h(
    'div',
    {
      class: 'cp-safes',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'cp-safes-title',
        'data-motion': options.reducedMotion ? 'reduced' : 'full',
        'data-testid': 'safes-panel',
      },
    },
    card,
  );

  ctx.own(loc.text(title, () => t('title')));
  ctx.own(loc.text(subtitle, () => t('subtitle')));
  ctx.own(loc.attr(close, 'aria-label', () => t('close')));
  ctx.own(loc.text(empty, () => t('empty')));
  ctx.own(
    loc.bind(() => {
      oddsList.replaceChildren(
        ...safesConfig.types.flatMap((type) => [
          h('dt', { text: `${typeName(type.id)} · ${t('odds')}` }),
          h('dd', {
            text: crateOdds(type.dropSource)
              .map((row) =>
                t('oddsShare', {
                  rarity: ui.i18n.t(cratesKey(`chip.${row.rarity}`)),
                  value: oddsShare(row.percent, ui.i18n.language),
                }),
              )
              .join(' · '),
          }),
        ]),
      );
    }),
  );

  const rows = new Map<SafeId, Row>();

  const buildRow = (safe: Safe): Row => {
    const name = h('span', { class: 'cp-safes-row-name' });
    const timer = h('span', {
      class: 'cp-safes-row-timer',
      attrs: { 'data-testid': 'safe-timer' },
    });
    const fill = h('span', { class: 'cp-safes-row-fill' });
    const bar = h(
      'span',
      {
        class: 'cp-safes-row-bar',
        attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
      },
      fill,
    );
    const hint = h('span', {
      class: 'cp-safes-row-hint',
      attrs: { id: `cp-safe-hint-${safe.id}` },
    });
    const keyLabel = h('span', { class: 'cp-safes-row-key-label' });
    const keyButton = h(
      'button',
      {
        class: 'cp-buy cp-safes-row-key',
        attrs: { type: 'button', 'data-testid': 'safe-open-key' },
      },
      keyLabel,
    );
    const timerButton = h('button', {
      class: 'cp-buy cp-safes-row-open',
      attrs: { type: 'button', 'data-testid': 'safe-open-timer' },
    });
    const item = h(
      'li',
      { class: 'cp-safes-row', attrs: { 'data-safe': safe.id, 'data-testid': 'safe-row' } },
      h('span', { class: 'cp-safes-row-vault', attrs: { 'aria-hidden': 'true' } }, h('span')),
      h('span', { class: 'cp-safes-row-text' }, name, timer, bar, hint),
      h('span', { class: 'cp-safes-row-actions' }, keyButton, timerButton),
    );
    let current = safe;
    let actions: SafeActions | null = null;

    const render = (next: Safe): SafeActions => {
      current = next;
      const view = safeActions({
        safe: next,
        serverNow: options.serverNow(),
        keys: options.keys(),
        pending: options.pending(next.id),
        busy: options.busy(),
      });
      actions = view;
      const safeName = typeName(next.type);
      const pending = options.pending(next.id);
      name.textContent = safeName;
      const { countdown } = view;
      timer.textContent =
        countdown.state === 'syncing'
          ? t('syncing')
          : countdown.state === 'ready'
            ? t('ready')
            : t('unlocksIn', { time: formatCountdown(countdown.remainingMs ?? 0) });
      const percent = Math.round((countdown.fraction ?? 0) * 100);
      fill.style.setProperty('--cp-safes-fill', String(countdown.fraction ?? 0));
      bar.setAttribute('aria-valuenow', String(percent));
      bar.setAttribute('aria-label', t('timerLabel', { safe: safeName }));
      bar.hidden = countdown.state === 'syncing';
      item.dataset.state = countdown.state;

      keyButton.hidden = !view.key.visible;
      keyButton.setAttribute('aria-disabled', view.key.enabled ? 'false' : 'true');
      keyLabel.textContent =
        pending === 'key' ? t('opening') : t('openWithKeys', { count: view.key.cost });
      keyButton.setAttribute(
        'aria-label',
        t('openWithKeysLabel', { count: view.key.cost, safe: safeName }),
      );
      hint.textContent =
        view.key.blocked === 'noKeys' ? t('needKeys', { count: view.key.cost }) : '';
      if (view.key.blocked === 'noKeys') keyButton.setAttribute('aria-describedby', hint.id);
      else keyButton.removeAttribute('aria-describedby');

      timerButton.hidden = !view.timer.visible;
      timerButton.setAttribute('aria-disabled', view.timer.enabled ? 'false' : 'true');
      timerButton.textContent = pending === 'timer' ? t('opening') : t('openFree');
      timerButton.setAttribute('aria-label', t('openFreeLabel', { safe: safeName }));
      item.classList.toggle('is-pending', pending !== null);
      return view;
    };

    const deny = () => {
      if (!options.reducedMotion) restartAnimation(item, 'is-denied');
    };
    makePressable(keyButton, ctx, {
      feedback: 'tap',
      onPress: () => {
        options.onOpen(current, 'key');
      },
    });
    makePressable(timerButton, ctx, {
      feedback: 'confirm',
      enabled: () => actions?.timer.enabled === true,
      onPress: () => {
        options.onOpen(current, 'timer');
      },
    });
    return { item, render, deny, ready: null };
  };

  let tick: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const render = () => {
    if (closed) return;
    const owned = options.safes();
    const seen = new Set<SafeId>();
    let nextRepaint: number | null = null;
    for (const safe of owned) {
      seen.add(safe.id);
      let row = rows.get(safe.id);
      if (row === undefined) {
        row = buildRow(safe);
        rows.set(safe.id, row);
      }
      list.append(row.item);
      const view = row.render(safe);
      const ready = view.countdown.state === 'ready';
      if (row.ready === false && ready) {
        for (const sound of READY_SOUND) options.audio?.()?.playImpact(sound);
        feedback(ctx, 'toggle');
        if (!options.reducedMotion) restartAnimation(row.item, 'is-ready');
      }
      if (view.countdown.state !== 'syncing') row.ready = ready;
      const remaining = view.countdown.remainingMs;
      if (view.countdown.state === 'syncing') nextRepaint = Math.min(nextRepaint ?? 1_000, 1_000);
      else if (!ready && remaining !== null) {
        const wait = msToNextSecond(remaining);
        nextRepaint = nextRepaint === null ? wait : Math.min(nextRepaint, wait);
      }
    }
    for (const [safeId, row] of rows) {
      if (seen.has(safeId)) continue;
      row.item.remove();
      rows.delete(safeId);
    }
    empty.hidden = owned.length > 0;
    list.hidden = owned.length === 0;
    const shown = options.keys();
    keysValue.textContent = t('keys', { value: shown === null ? '–' : int(shown) });
    const provisional = options.keysProvisional();
    keysNote.textContent = provisional ? t('keysProvisional') : '';
    keys.dataset.provisional = String(provisional);
    if (tick !== null) clearTimeout(tick);
    tick = nextRepaint === null ? null : setTimeout(render, nextRepaint + 5);
  };
  ctx.own(loc.bind(render));

  const say = (message: string, safeId?: SafeId) => {
    status.textContent = message;
    restartAnimation(status, 'is-new');
    if (safeId !== undefined) rows.get(safeId)?.deny();
  };

  makePressable(close, ctx, { feedback: 'close', onPress: options.onClose });
  const focus = sharedSheetFocus().register(root, () => {
    feedback(ctx, 'close');
    options.onClose();
  });

  options.host.append(root);
  focus.opened();
  feedback(ctx, 'open');
  root.tabIndex = -1;
  root.focus({ preventScroll: true });

  let disposed = false;
  return {
    el: root,
    render,
    say(message, safeId) {
      say(message, safeId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      closed = true;
      if (tick !== null) clearTimeout(tick);
      for (const off of disposers.splice(0)) off();
      loc.dispose();
      const restoreFocus = focus.closing(trigger);
      root.remove();
      restoreFocus();
      focus.dispose();
    },
  };
}
