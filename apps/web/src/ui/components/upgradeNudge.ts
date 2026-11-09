import { upgradeLines } from '@coinposh/economy';
import type { SettingsStorage } from '../../app/settings.ts';
import { watch } from '../../app/store.ts';
import { feedback, tr, type UiContext } from '../context.ts';
import { fromMarkup, h, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { schedule } from '../motion/loop.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { makePressable } from './pressable.ts';
import { createFirstUpgradeNudge } from './upgradeNudgeTrigger.ts';

/** The line folds away after this long; the dock keeps its glow until Upgrades is opened. */
const HINT_LINGER_MS = 12_000;

export interface UpgradeNudgeOptions {
  /** The dock's Upgrades button: it pulses once, then keeps a gold glow until it is opened. */
  readonly trigger: HTMLElement;
  readonly storage: SettingsStorage | null;
  readonly playable: () => boolean;
  readonly openUpgrades: () => void;
  /** Scrolls the open Upgrades sheet to a line and lights it. */
  readonly reveal: (lineId: string) => void;
}

const CHEVRON =
  '<svg class="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';

/**
 * The Concierge's one-time word that the first upgrade is affordable: a line under the
 * balance, a single pulse on the Upgrades button, and a tap that opens the sheet on that line.
 * It retires the moment it fires (or the profile already owns an upgrade), across reloads.
 */
export function createUpgradeNudge(ctx: UiContext, options: UpgradeNudgeOptions): HTMLElement {
  const title = h('span', { class: 'cp-upgrade-hint-title' });
  const hint = h('span', { class: 'cp-upgrade-hint-hint' });
  const notice = h(
    'button',
    {
      class: 'cp-upgrade-hint cp-panel',
      attrs: { type: 'button', 'data-testid': 'hud-upgrade-hint', hidden: '' },
    },
    h('span', { class: 'cp-upgrade-hint-seal', attrs: { 'aria-hidden': 'true' } }, icon('coin')),
    h('span', { class: 'cp-upgrade-hint-text' }, title, hint),
    h(
      'span',
      { class: 'cp-upgrade-hint-go', attrs: { 'aria-hidden': 'true' } },
      fromMarkup(CHEVRON),
    ),
    h('span', { class: 'cp-glint', attrs: { 'aria-hidden': 'true' } }),
  );
  const nudge = createFirstUpgradeNudge(upgradeLines, options.storage);
  if (nudge.retired) return notice;

  const { trigger } = options;
  const drop = new SpringValue(0, SPRINGS.bouncy, (value) => {
    notice.style.translate = value === 1 ? '' : `0 ${(1 - value) * -18}px`;
    notice.style.scale = value === 1 ? '' : String(0.94 + 0.06 * Math.min(1, value));
    notice.style.opacity = String(Math.min(1, Math.max(0, value)));
  });
  let lineId: string | null = null;
  let linger: ReturnType<typeof setTimeout> | undefined;
  let folding = false;

  const paint = (): void => {
    if (!lineId) return;
    const name = tr(ctx, `upgrades.line.${lineId}.name`);
    title.textContent = tr(ctx, 'hud.upgradeHint.title', { name });
    hint.textContent = tr(ctx, 'hud.upgradeHint.hint');
    notice.setAttribute('aria-label', tr(ctx, 'hud.upgradeHint.aria', { name }));
  };
  const show = (id: string): void => {
    lineId = id;
    paint();
    notice.hidden = false;
    drop.jump(0);
    void drop.to(1);
    trigger.classList.add('is-hinted');
    if (!isReducedMotion()) {
      restartAnimation(notice, 'is-glinting');
      restartAnimation(trigger, 'is-beckoning');
    }
    // Before the first gesture audio is still locked and Chrome logs an error for vibrate().
    if (navigator.userActivation.hasBeenActive) feedback(ctx, 'open');
    linger = setTimeout(fold, HINT_LINGER_MS);
  };
  const fold = (): void => {
    clearTimeout(linger);
    if (notice.hidden || folding) return;
    folding = true;
    void drop.to(0, SPRINGS.snappy).then(() => {
      folding = false;
      notice.hidden = true;
    });
  };
  const dismiss = (): void => {
    if (!lineId) return;
    lineId = null;
    trigger.classList.remove('is-hinted', 'is-beckoning');
    fold();
  };
  const evaluate = (): void => {
    const state = ctx.store.getState();
    const id = nudge.evaluate({
      coins: state.coins,
      goldBars: state.goldBars,
      upgradeLevels: state.upgradeLevels,
      playable: options.playable(),
    });
    if (!id) return;
    if (state.panel === 'upgrades') options.reveal(id);
    else show(id);
  };

  makePressable(notice, ctx, {
    feedback: 'open',
    onPress() {
      options.openUpgrades();
    },
  });
  trigger.addEventListener('animationend', (event) => {
    if (event.target === trigger) trigger.classList.remove('is-beckoning');
  });
  notice.addEventListener('animationend', () => {
    notice.classList.remove('is-glinting');
  });

  ctx.own(
    ctx.store.subscribe((state, previous) => {
      if (
        state.coins !== previous.coins ||
        state.goldBars !== previous.goldBars ||
        state.upgradeLevels !== previous.upgradeLevels
      ) {
        evaluate();
      }
    }),
  );
  const stopWaiting = schedule(() => {
    if (nudge.retired) return false;
    if (!options.playable()) return true;
    evaluate();
    return false;
  });
  ctx.own(() => {
    stopWaiting();
  });
  ctx.own(
    watch(
      ctx.store,
      (s) => s.panel,
      (panel) => {
        if (panel !== 'upgrades' || !lineId) return;
        const id = lineId;
        dismiss();
        requestAnimationFrame(() => {
          options.reveal(id);
        });
      },
    ),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => Object.values(s.upgradeLevels).some((level) => level > 0),
      (owned) => {
        if (owned) dismiss();
      },
    ),
  );
  ctx.own(ctx.loc.bind(paint));
  ctx.own(() => {
    clearTimeout(linger);
    drop.stop();
  });
  return notice;
}
