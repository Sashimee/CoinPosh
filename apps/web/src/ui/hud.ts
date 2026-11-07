import { upgradeLines } from '@coinposh/economy';
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
import { h } from './dom.ts';
import { icon } from './icons.ts';
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

  const hud = h(
    'div',
    { class: 'cp-hud' },
    h(
      'div',
      { class: 'cp-hud-top' },
      bannerSlot,
      createBalancePlaque(ctx),
      createConciergeNotice(ctx),
    ),
    h('div', { class: 'cp-hud-middle' }, createDecorumMeter(ctx), createComboLadder(ctx)),
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
