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
import { announcementHoldFor, type AnnouncementQuiet } from './announcementHold.ts';
import { announcementSlotFor } from './announcementSlot.ts';
import { makePressable } from './pressable.ts';
import { createFirstUpgradeNudge, hasBeenActivated } from './upgradeNudgeTrigger.ts';

/** The line folds away after this long; the dock keeps its glow until Upgrades is opened. */
export const HINT_LINGER_MS = 6_000;
/** A line put off by a bigger moment comes back once, briefly, as a reminder. */
export const REAPPEAR_LINGER_MS = 4_000;
/** How long the slot must stay free before a put-off line comes back, so it never flickers in. */
export const NUDGE_SETTLE_MS = 700;
/** The first appearance plus the one reappearance after being put off. */
export const NUDGE_MAX_APPEARANCES = 2;

export interface NudgeView {
  /** `reappearing` is true for the comeback after the line was put off. */
  show(reappearing: boolean): void;
  fold(): void;
}

export type NudgePhase = 'idle' | 'waiting' | 'showing' | 'resting' | 'done';

export interface NudgeSchedule {
  readonly phase: NudgePhase;
  /** The nudge fired: show the line now, or as soon as the announcement slot frees up. */
  offer(): void;
  /** The player acted on it (opened Upgrades, bought something): fold for good. */
  dismiss(): void;
  dispose(): void;
}

export interface NudgeTiming {
  readonly lingerMs?: number;
  readonly reappearLingerMs?: number;
  readonly settleMs?: number;
}

/**
 * When the first-upgrade line is on screen. It is the lowest callout in the announcement slot:
 * offered while something outranks it (a crate on the table, its hint, a rank stamp, a crate
 * cinematic) it waits; put off while showing it folds at once and comes back at most once,
 * after the slot has been free for `settleMs`. Otherwise it folds after its linger.
 */
export function scheduleNudge(
  quiet: AnnouncementQuiet,
  view: NudgeView,
  timing: NudgeTiming = {},
): NudgeSchedule {
  const lingerMs = timing.lingerMs ?? HINT_LINGER_MS;
  const reappearLingerMs = timing.reappearLingerMs ?? REAPPEAR_LINGER_MS;
  const settleMs = timing.settleMs ?? NUDGE_SETTLE_MS;
  let phase: NudgePhase = 'idle';
  let appearances = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const display = (): void => {
    clear();
    appearances += 1;
    phase = 'showing';
    const reappearing = appearances > 1;
    view.show(reappearing);
    timer = setTimeout(
      () => {
        timer = null;
        phase = 'done';
        view.fold();
      },
      reappearing ? reappearLingerMs : lingerMs,
    );
  };

  const off = quiet.onChange((held) => {
    if (held) {
      clear();
      if (phase !== 'showing') return;
      phase = appearances < NUDGE_MAX_APPEARANCES ? 'resting' : 'done';
      view.fold();
      return;
    }
    if (phase !== 'waiting' && phase !== 'resting') return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (!quiet.held) display();
    }, settleMs);
  });

  return {
    get phase() {
      return phase;
    },
    offer() {
      if (phase !== 'idle') return;
      if (quiet.held) phase = 'waiting';
      else display();
    },
    dismiss() {
      clear();
      const wasShowing = phase === 'showing';
      phase = 'done';
      if (wasShowing) view.fold();
    },
    dispose() {
      clear();
      off();
    },
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
  let folding = false;
  const drop = new SpringValue(0, SPRINGS.bouncy, (value) => {
    // The fold's spring dips past zero and swings back; the line is gone the first time it does.
    if (folding && value <= 0) notice.hidden = true;
    notice.style.translate = value === 1 ? '' : `0 ${(1 - value) * -18}px`;
    notice.style.scale = value === 1 ? '' : String(0.94 + 0.06 * Math.min(1, value));
    notice.style.opacity = String(Math.min(1, Math.max(0, value)));
  });
  let lineId: string | null = null;

  const paint = (): void => {
    if (!lineId) return;
    const name = tr(ctx, `upgrades.line.${lineId}.name`);
    title.textContent = tr(ctx, 'hud.upgradeHint.title', { name });
    hint.textContent = tr(ctx, 'hud.upgradeHint.hint');
    notice.setAttribute('aria-label', tr(ctx, 'hud.upgradeHint.aria', { name }));
  };
  const turns = scheduleNudge(
    announcementSlotFor(announcementHoldFor(ctx.store)).quietFor('upgrade-nudge'),
    {
      show(reappearing) {
        folding = false;
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
        // A reminder comes back silently: the chime belongs to the news, not the repeat.
        if (!reappearing && hasBeenActivated(navigator)) feedback(ctx, 'open');
      },
      fold() {
        if (notice.hidden) return;
        folding = true;
        void drop.to(0, SPRINGS.snappy).then(() => {
          if (folding) notice.hidden = true;
        });
      },
    },
  );
  const show = (id: string): void => {
    lineId = id;
    turns.offer();
  };
  const dismiss = (): void => {
    if (!lineId) return;
    lineId = null;
    trigger.classList.remove('is-hinted', 'is-beckoning');
    turns.dismiss();
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
    turns.dispose();
    drop.stop();
  });
  return notice;
}
