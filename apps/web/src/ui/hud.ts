import { stewardAllowance, upgradeLines } from '@coinposh/economy';
import { affordableCount, upgradeRows } from '../app/model.ts';
import type { PanelId } from '../app/state.ts';
import { watch } from '../app/store.ts';
import { formatInteger } from '../i18n/index.ts';
import { createBalancePlaque } from './components/balancePlaque.ts';
import { createComboLadder } from './components/comboLadder.ts';
import { createConciergeNotice, createDecorumMeter } from './components/decorumMeter.ts';
import { makePressable } from './components/pressable.ts';
import { createTierStamp } from './components/tierStamp.ts';
import { tr, type UiContext } from './context.ts';
import { fromMarkup, h, listen, restartAnimation } from './dom.ts';
import { icon } from './icons.ts';
import { schedule } from './motion/loop.ts';
import { isReducedMotion } from './motion/reduced.ts';
import { SPRINGS } from './motion/spring.ts';
import { SpringValue } from './motion/value.ts';
import { createSettingsPanel } from './panels/settingsPanel.ts';
import { createSheet, type Sheet } from './panels/sheet.ts';
import { createUpgradesPanel } from './panels/upgradesPanel.ts';

export interface Hud {
  readonly root: HTMLElement;
  /** Top-of-screen slot reserved for the net layer's connection banner. */
  readonly bannerSlot: HTMLElement;
}

function createBadge(ctx: UiContext): HTMLElement {
  const badge = h('span', {
    class: 'cp-badge',
    attrs: { 'data-testid': 'dock-upgrades-badge', hidden: '' },
  });
  const pop = new SpringValue(1, SPRINGS.pop, (value) => {
    badge.style.scale = value === 1 ? '' : String(value);
  });
  const count = (): number => {
    const state = ctx.store.getState();
    return affordableCount(
      upgradeRows(upgradeLines, state.upgradeLevels, {
        coins: state.coins,
        goldBars: state.goldBars,
      }),
    );
  };
  const paint = (value: number): void => {
    badge.hidden = value === 0;
    badge.textContent = formatInteger(value, ctx.i18n.language);
    badge.setAttribute('aria-label', tr(ctx, 'dock.affordable', { count: value }));
  };
  ctx.own(
    watch(ctx.store, count, (value, previous) => {
      if (previous !== undefined && value > previous) pop.kick(4);
      paint(value);
    }),
  );
  ctx.own(
    ctx.loc.bind(() => {
      paint(count());
    }),
  );
  return badge;
}

const POSTER_ID = 'cp-poster';
/** Outlasts the poster's CSS cross-fade, so it is removed even if `transitionend` never fires. */
const POSTER_FADE_MS = 1000;

interface BootProbe {
  readonly sim: { readonly renderTick: number } | null;
  readonly playable: boolean;
}

function retirePoster(poster: HTMLElement): void {
  if (isReducedMotion()) {
    poster.remove();
    return;
  }
  poster.classList.add('is-lit');
  const remove = (): void => {
    clearTimeout(timer);
    poster.remove();
  };
  const timer = setTimeout(remove, POSTER_FADE_MS);
  poster.addEventListener('transitionend', remove, { once: true });
}

/**
 * The first frame that syncs sim coins is the first one drawn with the venue lit, so the poster
 * from index.html leaves on it. Without a probe (the UI preview) there is no boot to wait for.
 */
function followBoot(ctx: UiContext, meters: HTMLElement): void {
  const probe: BootProbe | undefined = window.__coinposh;
  const entrance = new SpringValue(probe ? 0 : 1, SPRINGS.bouncy, (value) => {
    meters.style.setProperty('--cp-meters-in', String(value));
  });
  if (!probe) return;
  meters.classList.add('is-waiting');
  meters.inert = true;
  let poster = document.getElementById(POSTER_ID);
  const stop = schedule(() => {
    if (poster && (probe.playable || (probe.sim?.renderTick ?? 0) > 0)) {
      retirePoster(poster);
      poster = null;
    }
    if (!probe.playable) return true;
    meters.classList.remove('is-waiting');
    meters.inert = false;
    void entrance.to(1);
    return false;
  });
  ctx.own(() => {
    stop();
    entrance.stop();
  });
}

/** A Vault that empties for a moment between a drop and the fall it pays is not news. */
const EMPTY_SETTLE_MS = 600;
/** How long a tap at an empty Vault keeps the notice lit. */
const ASKED_MS = 900;
const LEDGE_POINTER =
  '<svg class="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5v12.5"/><path d="m6.5 12 5.5 5.5 5.5-5.5"/><path d="M7 20.5h10" opacity="0.55"/></svg>';

function isPlayable(): boolean {
  const probe: BootProbe | undefined = window.__coinposh;
  return probe?.playable ?? true;
}

/** Presses on HUD controls are theirs; anything else lands on the table. */
function isTableTap(event: PointerEvent): boolean {
  return !(event.target instanceof Element && event.target.closest('.cp-ui-host'));
}

/**
 * Dims the plaque and has the Concierge point at the ledge while the Vault the server reports
 * cannot pay for a drop. It only reads the balance: refilling an empty Vault is the server's
 * Steward's allowance (02-ECONOMY.md), and its credit clears this like any other.
 */
function createVaultEmptyNotice(ctx: UiContext, plaque: HTMLElement): HTMLElement {
  const title = h('span', { class: 'cp-vault-empty-title' });
  const hint = h('span', { class: 'cp-vault-empty-hint' });
  const pointer = h(
    'span',
    { class: 'cp-vault-empty-pointer', attrs: { 'aria-hidden': 'true' } },
    fromMarkup(LEDGE_POINTER),
  );
  const notice = h(
    'div',
    {
      class: 'cp-vault-empty cp-panel',
      attrs: { role: 'status', 'data-testid': 'hud-vault-empty', hidden: '' },
    },
    h('span', { class: 'cp-vault-empty-text' }, title, hint),
    pointer,
  );
  const reveal = new SpringValue(0, SPRINGS.bouncy, (value) => {
    notice.style.translate = value === 1 ? '' : `0 ${(1 - value) * -14}px`;
    notice.style.opacity = String(Math.min(1, Math.max(0, value)));
  });
  ctx.loc.text(title, () => tr(ctx, 'hud.vaultEmpty.title'));
  ctx.loc.text(hint, () => tr(ctx, 'hud.vaultEmpty.hint'));

  const isEmpty = (): boolean => ctx.store.getState().coins < stewardAllowance.emptyBelowCoins;
  let shown = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let asked: ReturnType<typeof setTimeout> | undefined;

  const show = (): void => {
    clearTimeout(settle);
    if (shown) return;
    shown = true;
    notice.hidden = false;
    plaque.classList.add('is-empty');
    reveal.jump(0);
    void reveal.to(1);
  };
  const hide = (): void => {
    clearTimeout(settle);
    clearTimeout(asked);
    if (!shown) return;
    shown = false;
    plaque.classList.remove('is-empty');
    notice.classList.remove('is-asked', 'is-nudged');
    void reveal.to(0, SPRINGS.snappy).then(() => {
      if (!shown) notice.hidden = true;
    });
  };
  const answerTap = (): void => {
    if (!isEmpty() || !isPlayable()) return;
    show();
    notice.classList.add('is-asked');
    if (!isReducedMotion()) restartAnimation(notice, 'is-nudged');
    clearTimeout(asked);
    asked = setTimeout(() => {
      notice.classList.remove('is-asked');
    }, ASKED_MS);
  };

  ctx.own(
    watch(
      ctx.store,
      () => isEmpty(),
      (empty) => {
        if (!empty) hide();
        else if (!shown && isPlayable()) {
          clearTimeout(settle);
          settle = setTimeout(show, EMPTY_SETTLE_MS);
        }
      },
    ),
  );
  ctx.own(
    listen(
      window,
      'pointerdown',
      (event) => {
        if (isTableTap(event)) answerTap();
      },
      { capture: true, passive: true },
    ),
  );
  ctx.own(
    ctx.bus.on('ui:feedback', ({ kind }) => {
      if (kind === 'deny') answerTap();
    }),
  );
  notice.addEventListener('animationend', () => {
    notice.classList.remove('is-nudged');
  });
  ctx.own(() => {
    clearTimeout(settle);
    clearTimeout(asked);
    reveal.stop();
  });
  return notice;
}

export function createHud(ctx: UiContext): Hud {
  const bannerSlot = h('div', {
    class: 'cp-banner-slot',
    attrs: { 'data-testid': 'net-banner-slot' },
  });

  const settingsButton = h(
    'button',
    {
      class: 'cp-dock-button cp-panel',
      attrs: { type: 'button', 'data-testid': 'dock-settings', 'aria-haspopup': 'dialog' },
    },
    icon('settings'),
  );
  const upgradesLabel = h('span', { class: 'cp-dock-label' });
  const upgradesButton = h(
    'button',
    {
      class: 'cp-dock-button cp-dock-primary cp-panel',
      attrs: { type: 'button', 'data-testid': 'dock-upgrades', 'aria-haspopup': 'dialog' },
    },
    icon('upgrades'),
    upgradesLabel,
    createBadge(ctx),
  );
  ctx.loc.attr(settingsButton, 'aria-label', () => tr(ctx, 'dock.settings'));
  ctx.loc.text(upgradesLabel, () => tr(ctx, 'dock.upgrades'));

  const setPanel = (panel: PanelId | null): void => {
    ctx.store.setState({ panel });
  };
  const closePanel = (): void => {
    setPanel(null);
  };
  const sheets: Record<PanelId, { sheet: Sheet; trigger: HTMLElement }> = {
    upgrades: {
      trigger: upgradesButton,
      sheet: createSheet(ctx, {
        id: 'upgrades',
        title: () => tr(ctx, 'upgrades.title'),
        subtitle: () => tr(ctx, 'upgrades.subtitle'),
        body: createUpgradesPanel(ctx),
        onRequestClose: closePanel,
      }),
    },
    settings: {
      trigger: settingsButton,
      sheet: createSheet(ctx, {
        id: 'settings',
        title: () => tr(ctx, 'settings.title'),
        subtitle: () => tr(ctx, 'settings.subtitle'),
        body: createSettingsPanel(ctx),
        onRequestClose: closePanel,
      }),
    },
  };
  makePressable(settingsButton, ctx, {
    feedback: () => (ctx.store.getState().panel === 'settings' ? 'close' : 'open'),
    onPress() {
      setPanel(ctx.store.getState().panel === 'settings' ? null : 'settings');
    },
  });
  makePressable(upgradesButton, ctx, {
    feedback: () => (ctx.store.getState().panel === 'upgrades' ? 'close' : 'open'),
    onPress() {
      setPanel(ctx.store.getState().panel === 'upgrades' ? null : 'upgrades');
    },
  });

  const dock = h(
    'nav',
    { class: 'cp-dock', attrs: { 'data-testid': 'hud-dock' } },
    settingsButton,
    upgradesButton,
  );
  ctx.loc.attr(dock, 'aria-label', () => tr(ctx, 'app.hudLabel'));

  const meters = h(
    'div',
    { class: 'cp-hud-middle', attrs: { 'data-testid': 'hud-meters' } },
    createDecorumMeter(ctx),
    createComboLadder(ctx),
  );
  followBoot(ctx, meters);

  const plaque = createBalancePlaque(ctx);
  const hud = h(
    'div',
    { class: 'cp-hud' },
    h(
      'div',
      { class: 'cp-hud-top' },
      bannerSlot,
      plaque,
      createVaultEmptyNotice(ctx, plaque),
      createConciergeNotice(ctx),
    ),
    meters,
    dock,
  );
  const root = h(
    'div',
    { class: 'cp-ui', attrs: { 'data-testid': 'ui-root' } },
    hud,
    createTierStamp(ctx),
    sheets.upgrades.sheet.el,
    sheets.settings.sheet.el,
  );

  ctx.own(
    watch(
      ctx.store,
      (s) => s.panel,
      (panel) => {
        root.classList.toggle('has-panel', panel !== null);
        for (const [id, { sheet, trigger }] of Object.entries(sheets)) {
          const active = id === panel;
          trigger.setAttribute('aria-expanded', String(active));
          trigger.classList.toggle('is-active', active);
          if (active) sheet.open(trigger);
          else sheet.close();
        }
      },
    ),
  );

  return { root, bannerSlot };
}
