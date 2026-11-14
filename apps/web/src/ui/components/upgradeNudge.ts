import { upgradeLines, type UpgradeLineDef } from '@coinposh/economy';
import type { Wallet } from '../../app/model.ts';
import type { SettingsStorage } from '../../app/settings.ts';
import { watch, type Store } from '../../app/store.ts';
import { feedback, tr, type UiContext } from '../context.ts';
import { fromMarkup, h, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { schedule } from '../motion/loop.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { announcementHoldFor, type AnnouncementHold } from './announcementHold.ts';
import { makePressable } from './pressable.ts';
import {
  createFirstUpgradeNudge,
  hasBeenActivated,
  nudgeStillAffordable,
  type NudgeSnapshot,
} from './upgradeNudgeTrigger.ts';

/** The line folds away after this long; the dock keeps its glow until Upgrades is opened. */
export const HINT_LINGER_MS = 6_000;

/**
 * Folds the line after `lingerMs`, or the moment a crate cinematic takes the screen: the
 * crate:fell handler in cinematicHold.ts engages the shared announcement hold synchronously.
 * Returns a cancel for the pending fold.
 */
export function foldNudgeOnCue(
  hold: AnnouncementHold,
  fold: () => void,
  lingerMs: number = HINT_LINGER_MS,
): () => void {
  if (hold.held) {
    fold();
    return () => undefined;
  }
  let off = (): void => undefined;
  const timer = setTimeout(() => {
    off();
    fold();
  }, lingerMs);
  const cancel = (): void => {
    clearTimeout(timer);
    off();
  };
  off = hold.onChange((held) => {
    if (!held) return;
    cancel();
    fold();
  });
  return cancel;
}

export interface NudgeWallet extends Wallet {
  readonly upgradeLevels: Readonly<Record<string, number>>;
}

/**
 * Folds the line, once, the moment the suggested upgrade is no longer affordable (or at once
 * if it already is not), so a tap on the hint never lands on a greyed-out BUY. Every tap
 * spends a coin, so a balance that just cleared the price can slip under it while it is read.
 * Returns a cancel.
 */
export function foldWhenOutOfReach<S extends NudgeWallet>(
  store: Store<S>,
  lineId: string,
  fold: () => void,
  lines: readonly UpgradeLineDef[] = upgradeLines,
): () => void {
  if (!nudgeStillAffordable(lines, lineId, store.getState())) {
    fold();
    return () => undefined;
  }
  const stop = store.subscribe((state) => {
    if (nudgeStillAffordable(lines, lineId, state)) return;
    stop();
    fold();
  });
  return stop;
}

/** What the first-upgrade hint judges: the Vault as shown and the part the server can spend. */
export function nudgeSnapshot(
  state: NudgeWallet & { readonly spendableCoins: number },
  playable: boolean,
): NudgeSnapshot {
  return {
    coins: state.coins,
    spendableCoins: state.spendableCoins,
    goldBars: state.goldBars,
    upgradeLevels: state.upgradeLevels,
    playable,
  };
}

export interface UpgradeNudgeOptions {
  /** The dock's Upgrades button: it pulses once, then keeps a gold glow until it is opened. */
  readonly trigger: HTMLElement;
  readonly storage: SettingsStorage | null;
  readonly playable: () => boolean;
  readonly openUpgrades: () => void;
  /** Scrolls the open Upgrades sheet to a line and lights it. */
  readonly reveal: (lineId: string) => void;
  /** The lines the Upgrades sheet lists; the nudge never points past them. */
  readonly lines?: readonly UpgradeLineDef[];
}

const CHEVRON =
  '<svg class="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';

/**
 * The Concierge's one-time word that the first upgrade is affordable: a line under the
 * balance, a single pulse on the Upgrades button, and a tap that opens the sheet on that line.
 * It waits for headroom so the BUY it points at is still lit when the sheet opens, and folds
 * the moment the line slips out of reach. It retires the moment it fires (or the profile
 * already owns an upgrade), across reloads.
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
  const lines = options.lines ?? upgradeLines;
  const nudge = createFirstUpgradeNudge(lines, options.storage);
  if (nudge.retired) return notice;

  const { trigger } = options;
  const drop = new SpringValue(0, SPRINGS.bouncy, (value) => {
    notice.style.translate = value === 1 ? '' : `0 ${(1 - value) * -18}px`;
    notice.style.scale = value === 1 ? '' : String(0.94 + 0.06 * Math.min(1, value));
    notice.style.opacity = String(Math.min(1, Math.max(0, value)));
  });
  let lineId: string | null = null;
  const hold = announcementHoldFor(ctx.store);
  let cancelLinger = (): void => undefined;
  let folding = false;
  let cancelReach = (): void => undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

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
    notice.inert = false;
    drop.jump(0);
    void drop.to(1);
    trigger.classList.add('is-hinted');
    if (!isReducedMotion()) {
      restartAnimation(notice, 'is-glinting');
      restartAnimation(trigger, 'is-beckoning');
    }
    // Before the first gesture audio is still locked and Chrome logs an error for vibrate().
    if (hasBeenActivated(navigator)) feedback(ctx, 'open');
    cancelLinger = foldNudgeOnCue(hold, fold);
    cancelReach = foldWhenOutOfReach(ctx.store, id, dismiss);
  };
  const fold = (): void => {
    cancelLinger();
    if (notice.hidden || folding) return;
    folding = true;
    notice.inert = true;
    void drop.to(0, SPRINGS.snappy).then(() => {
      folding = false;
      notice.hidden = true;
    });
  };
  const dismiss = (): void => {
    if (!lineId) return;
    lineId = null;
    cancelReach();
    trigger.classList.remove('is-hinted', 'is-beckoning');
    fold();
  };
  const armWake = (): void => {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    const { wakeAt } = nudge;
    if (wakeAt === null) return;
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null;
        evaluate();
      },
      Math.max(0, wakeAt - performance.now()),
    );
  };

  const evaluate = (): void => {
    const state = ctx.store.getState();
    const id = nudge.evaluate(nudgeSnapshot(state, options.playable()), performance.now());
    armWake();
    if (!id) return;
    if (state.panel === 'upgrades') options.reveal(id);
    else show(id);
  };

  makePressable(notice, ctx, {
    feedback: 'open',
    enabled: () => lineId !== null && nudgeStillAffordable(lines, lineId, ctx.store.getState()),
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
        state.spendableCoins !== previous.spendableCoins ||
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
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    cancelReach();
    cancelLinger();
    drop.stop();
  });
  return notice;
}
