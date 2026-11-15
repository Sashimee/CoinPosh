import './gacha.css';
import type { Rarity } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { formatInteger, type InterpolationValues } from '../../i18n/index.ts';
import type { GachaEvent } from '../../scene/gacha/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { fromMarkup, h, restartAnimation } from '../../ui/dom.ts';
import { icon } from '../../ui/icons.ts';
import { Localizer } from '../../ui/localize.ts';
import { sharedSheetFocus } from '../../ui/panels/sheetFocus.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import { gachaKey, registerGachaStrings, type GachaKey } from './i18n.ts';
import type { PullAction } from './plan.ts';
import { pullPrompt, revealSteps } from './plan.ts';
import { createGachaStage, type GachaStage } from './stage.ts';
import { LOCKED_PULL_VARIABLES } from './tokens.ts';

const LOCK_ICON =
  '<svg class="cp-gacha-lock" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.4" fill="currentColor" fill-opacity=".18"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7M12 14.6v2.2"/></svg>';

/** How long one idle crank turn takes while the pull waits for the server. */
const ANTICIPATION_TURN_MS = 1_400;
const FINISH_TURN_MS = 420;
const FALLBACK_REVEAL_MS = { full: 700, reduced: 300 } as const;

export interface GachaRevealLine {
  readonly name: string;
  readonly detail: string | null;
}

export interface GachaReveal {
  readonly rarity: Rarity;
  readonly rarityName: string;
  readonly lines: readonly GachaRevealLine[];
}

export interface GachaPanelOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  readonly host: HTMLElement;
  readonly reducedMotion: boolean;
  readonly tickets: () => { readonly value: number | null; readonly provisional: boolean };
  readonly action: () => PullAction;
  readonly onPull: () => void;
  readonly onOdds: (trigger: HTMLElement) => void;
  readonly onCollect: (sources: readonly Element[]) => void;
  readonly onClose: () => void;
  /** Each beat of the machine, for sound and haptics. */
  readonly onMachineEvent: (event: GachaEvent) => void;
}

export interface GachaPanel {
  readonly el: HTMLElement;
  render(): void;
  say(message: string): void;
  /** The crank starts turning as the pull goes out, before the server answers. */
  anticipate(): void;
  /** The server refused: the crank winds back, no capsule falls. */
  cancelAnticipation(): void;
  /** Plays the server's roll: crank home, capsule down the chute, pop. Resolves once it is open. */
  reveal(reveal: GachaReveal): Promise<void>;
  /** A rarity burst over the viewport. */
  burst(rarity: Rarity): void;
  dispose(): void;
}

function accent(el: HTMLElement, rarity: Rarity): void {
  el.style.setProperty('--cp-gacha-accent', RARITY_COLORS[rarity]);
  if (rarity === 'heirloom') el.style.setProperty('--cp-gacha-prism', HEIRLOOM_PRISM.join(', '));
  else el.style.removeProperty('--cp-gacha-prism');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The capsule machine sheet: the machine in its viewport, the Tickets balance, Pull and the odds
 * link. It never decides a pull: presses go to `onPull`, and `reveal` plays whatever the server
 * rolled. Without a GPU the viewport shows a CSS capsule so a pull still reveals.
 */
export function showGachaPanel(options: GachaPanelOptions): GachaPanel {
  const { ui } = options;
  registerGachaStrings(ui.i18n);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(ui.i18n);
  const ctx: UiContext = {
    i18n: ui.i18n,
    loc,
    store: ui.store,
    bus: ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const t = (key: GachaKey, values?: InterpolationValues) => ui.i18n.t(gachaKey(key), values);
  const opener = document.activeElement;
  const trigger = opener instanceof HTMLElement && opener !== document.body ? opener : null;
  const reduced = options.reducedMotion;

  const title = h('h2', {
    class: 'cp-gacha-title',
    attrs: { id: 'cp-gacha-title', tabindex: '-1' },
  });
  const subtitle = h('p', { class: 'cp-gacha-subtitle' });
  const close = h(
    'button',
    { class: 'cp-gacha-close', attrs: { type: 'button', 'data-testid': 'gacha-close' } },
    icon('close'),
  );
  const fallback = h('div', { class: 'cp-gacha-fallback', attrs: { 'aria-hidden': 'true' } });
  const flash = h('div', { class: 'cp-gacha-flash', attrs: { 'aria-hidden': 'true' } });
  const viewport = h('div', { class: 'cp-gacha-viewport' }, fallback, flash);
  const ticketsValue = h('span', { class: 'cp-gacha-tickets-value' });
  const ticketsNote = h('span', { class: 'cp-gacha-tickets-note' });
  const tickets = h(
    'p',
    { class: 'cp-gacha-tickets', attrs: { 'data-testid': 'gacha-tickets' } },
    ticketsValue,
    ticketsNote,
  );
  const status = h('p', {
    class: 'cp-gacha-status',
    attrs: { 'aria-live': 'polite', 'data-testid': 'gacha-status' },
  });
  const revealRarity = h('p', { class: 'cp-gacha-reveal-rarity' });
  const revealList = h('ul', { class: 'cp-gacha-reveal-lines' });
  const collect = h('button', {
    class: 'cp-buy cp-gacha-collect',
    attrs: { type: 'button', 'data-testid': 'gacha-collect' },
  });
  const revealCard = h(
    'div',
    { class: 'cp-gacha-reveal', attrs: { 'data-testid': 'gacha-reveal', hidden: '' } },
    revealRarity,
    revealList,
    collect,
  );
  const hint = h('p', {
    class: 'cp-gacha-hint',
    attrs: { id: 'cp-gacha-hint', 'data-testid': 'gacha-hint' },
  });
  const sources = h('p', {
    class: 'cp-gacha-sources',
    attrs: { id: 'cp-gacha-sources', 'data-testid': 'gacha-sources' },
  });
  const pullText = h('span', { class: 'cp-gacha-pull-text' });
  const pull = h(
    'button',
    {
      class: 'cp-buy cp-gacha-pull',
      attrs: {
        type: 'button',
        'data-testid': 'gacha-pull',
        'aria-describedby': 'cp-gacha-hint cp-gacha-sources',
      },
    },
    fromMarkup(LOCK_ICON),
    pullText,
  );
  const odds = h('button', {
    class: 'cp-gacha-odds',
    attrs: { type: 'button', 'data-testid': 'gacha-odds' },
  });
  const card = h(
    'div',
    { class: 'cp-gacha-card' },
    close,
    title,
    subtitle,
    viewport,
    tickets,
    status,
    revealCard,
    pull,
    hint,
    sources,
    odds,
  );
  const root = h(
    'div',
    {
      class: 'cp-gacha',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'cp-gacha-title',
        'data-testid': 'gacha-panel',
      },
    },
    card,
  );
  if (reduced) root.classList.add('is-reduced');
  for (const [name, value] of Object.entries(LOCKED_PULL_VARIABLES)) {
    root.style.setProperty(name, value);
  }

  let stage: GachaStage | null = null;
  let wasLocked: boolean | null = null;
  let disposed = false;
  let revealing = false;
  let spin: number | null = null;
  let crankAt = 0;

  const render = () => {
    title.textContent = t('title');
    subtitle.textContent = t('subtitle');
    close.setAttribute('aria-label', t('close'));
    odds.textContent = t('odds');
    collect.textContent = t('collect');
    const shown = options.tickets();
    ticketsValue.textContent = t('tickets', {
      value: shown.value === null ? '–' : formatInteger(shown.value, ui.i18n.language),
    });
    ticketsNote.textContent = shown.provisional ? t('ticketsProvisional') : '';
    tickets.dataset.value = shown.value === null ? '' : String(shown.value);
    tickets.dataset.provisional = String(shown.provisional);
    const action = options.action();
    const showingPrize = !revealCard.hidden;
    pull.hidden = showingPrize;
    pullText.textContent = action.blocked === 'busy' ? t('pulling') : t('pull');
    pull.setAttribute('aria-label', action.blocked === 'busy' ? t('pulling') : t('pullLabel'));
    pull.setAttribute('aria-disabled', String(!action.enabled));
    const prompt = pullPrompt(action, showingPrize);
    pull.classList.toggle('is-locked', prompt.locked);
    if (wasLocked === true && !prompt.locked && action.enabled && !reduced) {
      restartAnimation(pull, 'is-unlocked');
    }
    wasLocked = prompt.locked;
    hint.textContent = prompt.reason === null ? '' : t(prompt.reason);
    sources.textContent = prompt.sources === null ? '' : t(prompt.sources);
  };
  ctx.own(loc.bind(render));

  const setCrank = (progress: number) => {
    crankAt = progress;
    stage?.machine.crank(progress % 1);
  };

  let settleTurn: (() => void) | null = null;

  /** Settles any turn in flight, so a reveal awaiting it never hangs when the sheet closes. */
  const stopSpin = () => {
    if (spin !== null) cancelAnimationFrame(spin);
    spin = null;
    const settle = settleTurn;
    settleTurn = null;
    settle?.();
  };

  const turnTo = (target: number, ms: number): Promise<void> =>
    new Promise((resolve) => {
      stopSpin();
      settleTurn = resolve;
      const from = crankAt;
      const start = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / ms);
        const eased = 1 - (1 - k) ** 3;
        setCrank(from + (target - from) * eased);
        if (k < 1) spin = requestAnimationFrame(step);
        else {
          spin = null;
          settleTurn = null;
          resolve();
        }
      };
      spin = requestAnimationFrame(step);
    });

  const anticipate = () => {
    if (reduced || stage === null) return;
    stopSpin();
    const start = performance.now() - crankAt * ANTICIPATION_TURN_MS;
    const step = () => {
      setCrank(Math.min(0.9, (performance.now() - start) / ANTICIPATION_TURN_MS));
      spin = requestAnimationFrame(step);
    };
    spin = requestAnimationFrame(step);
  };

  const showPrize = (reveal: GachaReveal) => {
    accent(revealCard, reveal.rarity);
    revealCard.dataset.rarity = reveal.rarity;
    revealRarity.textContent = reveal.rarityName;
    revealList.replaceChildren(
      ...reveal.lines.map((line) =>
        h(
          'li',
          { class: 'cp-gacha-reveal-line' },
          h('span', { class: 'cp-gacha-reveal-name' }, line.name),
          ...(line.detail === null
            ? []
            : [h('span', { class: 'cp-gacha-reveal-detail' }, line.detail)]),
        ),
      ),
    );
    revealCard.hidden = false;
    if (!reduced) restartAnimation(revealCard, 'is-new');
    render();
    collect.focus({ preventScroll: true });
  };

  const burst = (rarity: Rarity) => {
    accent(flash, rarity);
    restartAnimation(flash, reduced ? 'is-fade' : 'is-burst');
  };

  const playMachine = async (rarity: Rarity) => {
    const machine = stage?.machine;
    if (!machine) {
      accent(fallback, rarity);
      restartAnimation(fallback, 'is-dropping');
      await wait(reduced ? FALLBACK_REVEAL_MS.reduced : FALLBACK_REVEAL_MS.full);
      fallback.classList.add('is-open');
      burst(rarity);
      return;
    }
    for (const step of revealSteps(reduced)) {
      if (disposed) return;
      if (step === 'crank') await turnTo(1, FINISH_TURN_MS);
      if (step === 'dispense') {
        crankAt = 0;
        await machine.dispense(rarity);
      }
      if (step === 'pop') await machine.pop(rarity);
    }
  };

  makePressable(close, ctx, { feedback: 'close', onPress: options.onClose });
  makePressable(pull, ctx, {
    feedback: 'confirm',
    enabled: () => options.action().enabled,
    onPress: () => {
      revealCard.hidden = true;
      fallback.classList.remove('is-open', 'is-dropping');
      stopSpin();
      crankAt = 0;
      stage?.machine.reset();
      options.onPull();
    },
  });
  makePressable(odds, ctx, {
    feedback: 'open',
    onPress: () => {
      options.onOdds(odds);
    },
  });
  makePressable(collect, ctx, {
    feedback: 'confirm',
    onPress: () => {
      const sources = [...revealList.querySelectorAll('.cp-gacha-reveal-line')];
      options.onCollect(sources);
      revealCard.hidden = true;
      render();
      pull.focus({ preventScroll: true });
    },
  });
  const focus = sharedSheetFocus().register(root, () => {
    feedback(ctx, 'close');
    options.onClose();
  });

  options.host.append(root);
  focus.opened();
  root.tabIndex = -1;
  root.focus({ preventScroll: true });

  createGachaStage({
    host: viewport,
    reducedMotion: reduced,
    onEvent: options.onMachineEvent,
  }).then(
    (started) => {
      if (disposed) {
        started.dispose();
        return;
      }
      stage = started;
      viewport.classList.add('has-machine');
    },
    (error: unknown) => {
      console.warn(
        'CoinPosh gacha: the 3D machine did not start; showing the flat capsule.',
        error,
      );
    },
  );

  return {
    el: root,
    render,
    say(message) {
      status.textContent = message;
      restartAnimation(status, 'is-new');
    },
    anticipate,
    cancelAnticipation() {
      if (stage === null || reduced) return;
      void turnTo(0, FINISH_TURN_MS).then(() => {
        crankAt = 0;
      });
    },
    async reveal(reveal) {
      if (revealing) throw new Error('CoinPosh gacha: a reveal is already playing');
      revealing = true;
      try {
        await playMachine(reveal.rarity);
        if (!disposed) showPrize(reveal);
      } finally {
        revealing = false;
      }
    },
    burst,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSpin();
      stage?.dispose();
      for (const off of disposers.splice(0)) off();
      loc.dispose();
      const restoreFocus = focus.closing(trigger);
      root.remove();
      restoreFocus();
      focus.dispose();
    },
  };
}
