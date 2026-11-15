import './concierge.css';
import type { UiApp } from '../../app/index.ts';
import type { ConciergeVoice } from '../../audio/concierge/index.ts';
import type {
  ConciergeExpression,
  ConciergeHushReason,
  ConciergeLine,
} from '../../game/concierge/index.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { makePressable } from '../components/pressable.ts';
import type { UiContext } from '../context.ts';
import { fromMarkup, h, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { Localizer } from '../localize.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { conciergeT, loadConciergeStrings } from './i18n.ts';
import { conciergeCuePlan, type ConciergeCuePlan } from './juice.ts';
import { createPortrait } from './portrait.ts';
import { lineText } from './present.ts';
import { wireConciergeStage, type ConciergeBrainPort, type ConciergeShowMode } from './stage.ts';

export type ConciergeVoicePort = Pick<ConciergeVoice, 'play'>;

export interface ConciergeMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** Usually the UI root over the canvas. */
  readonly host: HTMLElement;
  readonly brain: ConciergeBrainPort;
  /** Read at each line, so a voice built after the first user gesture is picked up. */
  readonly voice?: (() => ConciergeVoicePort | null) | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
}

export interface ConciergeView {
  readonly el: HTMLElement;
  /** The face on the card while a line is up, for whoever voices it; null while it is down. */
  readonly expression: ConciergeExpression | null;
  readonly line: ConciergeLine | null;
  dispose(): void;
}

const EXIT_MS = 240;
const GLINT_LIFE_MS = 1100;
const TWINKLE_FADE_MS = 500;
const WORD_STAGGER_MS = 42;
const BLINK_MIN_MS = 2400;
const BLINK_SPREAD_MS = 2600;
const ENTER_SCALE = 0.72;
const HOP_VELOCITY = -150;
const SWAP_KICK = -1.6;

const KEY_MARKUP =
  '<svg class="cp-icon cp-concierge-key" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="12" r="3.6"/><path d="M11.1 12h9.4M17.2 12v3M20.2 12v2.2"/></svg>';

/**
 * Augustin's medallion and speech card, low over the dock. It only ever listens: the brain
 * decides what is said and when, and the card never takes a touch except on its own dismiss.
 * Loads its strings first, so it resolves once every line it could speak is registered.
 */
export async function mountConcierge(options: ConciergeMountOptions): Promise<ConciergeView> {
  await loadConciergeStrings(options.ui.i18n);
  const disposers: (() => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const loc = new Localizer(options.ui.i18n);
  const ctx: UiContext = {
    i18n: options.ui.i18n,
    loc,
    store: options.ui.store,
    bus: options.ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const { i18n } = ctx;
  const t = conciergeT(i18n);
  const { brain } = options;

  const later = (ms: number, run: () => void): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const portrait = createPortrait((expression) => t(`card.portrait.${expression}`));
  const glints = h('span', { class: 'cp-concierge-glints', attrs: { 'aria-hidden': 'true' } });
  const medallion = h(
    'div',
    { class: 'cp-concierge-medallion' },
    h('span', { class: 'cp-concierge-ring', attrs: { 'aria-hidden': 'true' } }),
    portrait.el,
    glints,
  );

  const eyebrowIcon = fromMarkup(KEY_MARKUP);
  const eyebrowText = h('span', { class: 'cp-concierge-eyebrow-text' });
  const eyebrow = h('p', { class: 'cp-concierge-eyebrow' }, eyebrowIcon, eyebrowText);
  const words = h('p', { class: 'cp-concierge-text', attrs: { 'aria-hidden': 'true' } });
  const timer = h('span', { class: 'cp-concierge-timer', attrs: { 'aria-hidden': 'true' } });
  const sheen = h('span', { class: 'cp-concierge-sheen', attrs: { 'aria-hidden': 'true' } });
  const dismiss = h(
    'button',
    {
      class: 'cp-concierge-dismiss',
      attrs: { type: 'button', 'data-testid': 'concierge-dismiss' },
    },
    icon('close'),
  );
  const card = h(
    'div',
    { class: 'cp-panel cp-concierge-card' },
    sheen,
    eyebrow,
    words,
    timer,
    dismiss,
  );
  const live = h('p', {
    class: 'cp-sr-only',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'concierge-live' },
  });
  const stage = h('div', { class: 'cp-concierge', attrs: { hidden: '' } }, medallion, card);
  const root = h(
    'section',
    { class: 'cp-ui cp-concierge-root', attrs: { 'data-testid': 'concierge' } },
    live,
    stage,
  );
  ctx.own(loc.attr(root, 'aria-label', () => t('card.region')));
  ctx.own(loc.attr(dismiss, 'aria-label', () => t('card.dismiss')));

  let line: ConciergeLine | null = null;
  let plan: ConciergeCuePlan | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cardScale = new SpringValue(1, SPRINGS.bouncy, (value) => {
    // Squash and stretch: while the card grows it is a touch tall, and its overshoot flattens it.
    const stretch = 1 + (1 - value) * 0.5;
    card.style.scale = value === 1 ? '' : `${String(value)} ${String(value * stretch)}`;
  });
  const hop = new SpringValue(0, SPRINGS.pop, (value) => {
    medallion.style.translate = value === 0 ? '' : `0 ${String(value)}px`;
  });

  const paintEyebrow = (): void => {
    const tip = line?.kind === 'tip';
    eyebrowIcon.toggleAttribute('hidden', !tip);
    eyebrowText.textContent = tip ? t('card.tip') : `${t('card.name')} · ${t('card.role')}`;
  };

  const paintWords = (reveal: ConciergeCuePlan['reveal']): void => {
    if (line === null) return;
    const text = lineText(i18n, line);
    live.textContent = text;
    words.replaceChildren();
    if (reveal === 'whole') {
      words.textContent = text;
      return;
    }
    const tokens = text.split(/(\s+)/);
    let index = 0;
    for (const token of tokens) {
      if (token === '') continue;
      if (/^\s+$/.test(token)) {
        words.append(token);
        continue;
      }
      const word = h('span', { class: 'cp-concierge-word', text: token });
      word.style.animationDelay = `${String(index * WORD_STAGGER_MS)}ms`;
      words.append(word);
      index += 1;
    }
  };

  const scatterGlints = (cue: ConciergeCuePlan): void => {
    const count = cue.glints;
    const offset = Math.random() * 360;
    for (let i = 0; i < count; i += 1) {
      const glint = h('span', { class: `cp-concierge-glint is-${cue.glintMotion}` });
      glint.style.setProperty('--a', `${String(offset + (360 / count) * i)}deg`);
      glint.style.setProperty('--d', `${String(46 + Math.random() * 22)}px`);
      glint.style.animationDelay = `${String(Math.round(Math.random() * 120))}ms`;
      glints.append(glint);
      // Reduced motion clamps every animation to 1 ms, so a twinkle fades out by transition.
      if (cue.glintMotion === 'twinkle') {
        later(GLINT_LIFE_MS - TWINKLE_FADE_MS, () => {
          glint.classList.add('is-out');
        });
      }
      later(GLINT_LIFE_MS, () => {
        glint.remove();
      });
    }
  };

  const scheduleBlink = (): void => {
    if (blinkTimer !== null) clearTimeout(blinkTimer);
    blinkTimer = null;
    if (disposed || line === null || isReducedMotion()) return;
    blinkTimer = later(BLINK_MIN_MS + Math.random() * BLINK_SPREAD_MS, () => {
      blinkTimer = null;
      portrait.blink();
      scheduleBlink();
    });
  };

  const cue = (next: ConciergeCuePlan): void => {
    if (!brain.muted) options.voice?.()?.play(next.bark);
    options.haptics?.pulse(next.haptic);
    sheen.classList.remove('is-sweep', 'is-glow');
    restartAnimation(sheen, next.light === 'sweep' ? 'is-sweep' : 'is-glow');
    scatterGlints(next);
  };

  const show = (next: ConciergeLine, mode: ConciergeShowMode): void => {
    if (exitTimer !== null) {
      clearTimeout(exitTimer);
      timers.delete(exitTimer);
      exitTimer = null;
    }
    const reduced = isReducedMotion();
    const entering = mode === 'enter' || stage.hidden;
    line = next;
    plan = conciergeCuePlan(next.expression, next.kind, reduced);
    portrait.setExpression(next.expression);
    stage.dataset.expression = next.expression;
    stage.dataset.kind = next.kind;
    stage.dataset.reveal = plan.reveal;
    stage.style.setProperty('--cp-concierge-duration', `${String(next.durationMs)}ms`);
    stage.hidden = false;
    stage.classList.remove('is-leaving');
    paintEyebrow();
    paintWords(plan.reveal);
    restartAnimation(timer, 'is-running');
    if (entering) {
      stage.getBoundingClientRect();
      stage.classList.add('is-open');
      if (plan.squash) {
        cardScale.jump(ENTER_SCALE);
        void cardScale.to(1, SPRINGS.bouncy);
      }
    } else if (plan.squash) {
      cardScale.kick(SWAP_KICK, SPRINGS.bouncy);
    }
    if (plan.squash) hop.kick(HOP_VELOCITY, SPRINGS.pop);
    cue(plan);
    scheduleBlink();
  };

  const hide = (reason: ConciergeHushReason): void => {
    line = null;
    plan = null;
    live.textContent = '';
    stage.dataset.hush = reason;
    stage.classList.remove('is-open');
    stage.classList.add('is-leaving');
    scheduleBlink();
    exitTimer = later(isReducedMotion() ? 0 : EXIT_MS, () => {
      exitTimer = null;
      stage.classList.remove('is-leaving');
      stage.hidden = true;
      words.replaceChildren();
      glints.replaceChildren();
    });
  };

  makePressable(dismiss, ctx, {
    feedback: 'close',
    onPress: () => {
      brain.dismiss();
    },
  });

  const syncMotion = (reduced: boolean): void => {
    root.classList.toggle('is-reduced', reduced);
    if (reduced) {
      cardScale.jump(1);
      hop.jump(0);
    }
    scheduleBlink();
  };
  syncMotion(isReducedMotion());
  ctx.own(onReducedMotionChange(syncMotion));

  const syncMuted = (muted: boolean): void => {
    root.dataset.muted = String(muted);
  };
  syncMuted(brain.muted);
  ctx.own(
    brain.events.on('concierge:muted', ({ muted }) => {
      syncMuted(muted);
    }),
  );

  ctx.own(
    loc.bind(() => {
      if (line === null) return;
      paintEyebrow();
      paintWords('whole');
    }),
  );

  options.host.append(root);
  ctx.own(wireConciergeStage(brain, { show, hide }));

  return {
    el: root,
    get expression() {
      return line?.expression ?? null;
    },
    get line() {
      return line;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const pending of timers) clearTimeout(pending);
      timers.clear();
      cardScale.stop();
      hop.stop();
      for (const dispose of disposers.splice(0)) dispose();
      loc.dispose();
      root.remove();
    },
  };
}
