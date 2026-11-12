import { ODDS_SCALE } from '@coinposh/economy';
import type { FairProof, PityCounters, Rarity } from '@coinposh/shared';
import type { Language } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { fromMarkup, h, listen, restartAnimation } from '../../ui/dom.ts';
import { icon } from '../../ui/icons.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import {
  FairVerifier,
  nonceLabel,
  oddsShare,
  oddsSheetData,
  oddsTotalPercent,
  type FairSources,
  type VerifyState,
} from './odds.ts';
import type { CratesT } from './revealCard.ts';

/** How long the sheet takes to sink away before it is hidden. */
export const ODDS_CLOSE_MS = 220;
const ROW_STAGGER_MS = 55;
const GLINTS = 4;
const FOCUSABLE = 'button:not([disabled]):not([hidden]), input:not([disabled])';

export interface OddsSheetOptions extends FairSources {
  readonly ctx: UiContext;
  readonly t: CratesT;
  readonly language: () => Language;
  readonly rarity: Rarity;
  readonly proof: FairProof;
  readonly pity: PityCounters;
  readonly reducedMotion: boolean;
}

export interface OddsSheet {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(trigger: HTMLElement): void;
  close(): void;
  dispose(): void;
}

const SEAL_MARKUP =
  '<svg class="cp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 19 5.6v5.6c0 4.4-2.9 8.1-7 9.9-4.1-1.8-7-5.5-7-9.9V5.6Z" fill="currentColor" fill-opacity=".16"/><path d="m8.6 12.1 2.3 2.3 4.6-4.8"/></svg>';

export function sealIcon(): Element {
  return fromMarkup(SEAL_MARKUP);
}

/**
 * The "Certified Fair" sheet: the crate's odds straight from the economy table the server rolls
 * against, the pity guarantees filled in with the server's counters, this roll's proof, and a
 * check of the revealed seed with the shared fair spec. Nothing here is rolled or estimated.
 */
export function createOddsSheet(options: OddsSheetOptions): OddsSheet {
  const { ctx, t, proof } = options;
  const loc = ctx.loc;
  const data = oddsSheetData(options.pity);
  const nonce = () => nonceLabel(proof, options.language());
  const share = (value: string) => t('oddsShare', { value });
  const broken = (key: 'oddsBroken' | 'oddsPityBroken') => {
    const message = h('p', { class: 'cp-odds-broken', attrs: { role: 'note' } });
    ctx.own(loc.text(message, () => t(key)));
    return message;
  };

  const titleId = 'cp-odds-title';
  const seal = h('span', { class: 'cp-odds-seal', attrs: { 'aria-hidden': 'true' } }, sealIcon());
  for (let index = 0; index < GLINTS; index++) {
    const glint = h('span', { class: 'cp-odds-glint' });
    glint.style.setProperty('--cp-odds-glint', String(index));
    seal.append(glint);
  }
  const title = h('h3', { class: 'cp-odds-title', attrs: { id: titleId } });
  const subtitle = h('p', { class: 'cp-odds-subtitle' });
  const closeButton = h(
    'button',
    { class: 'cp-icon-button cp-odds-close', attrs: { type: 'button' } },
    icon('close'),
  );
  ctx.own(loc.text(title, () => t('fair')));
  ctx.own(loc.text(subtitle, () => t('oddsSubtitle', { nonce: nonce() })));
  ctx.own(loc.attr(closeButton, 'aria-label', () => ctx.i18n.t('common.close')));

  const oddsParts: HTMLElement[] = [];
  if (data.rows.ok) {
    const rows = data.rows.value;
    const oddsList = h('ol', { class: 'cp-odds-rows' });
    rows.forEach((row, index) => {
      const name = h('span', { class: 'cp-odds-name' });
      const value = h('span', { class: 'cp-odds-value' });
      const fill = h('span', { class: 'cp-odds-fill' });
      const item = h(
        'li',
        { class: 'cp-odds-row', attrs: { 'data-rarity': row.rarity } },
        h(
          'span',
          { class: 'cp-odds-row-head' },
          h('span', { class: 'cp-odds-gem', attrs: { 'aria-hidden': 'true' } }),
          name,
          value,
        ),
        h('span', { class: 'cp-odds-bar', attrs: { 'aria-hidden': 'true' } }, fill),
      );
      item.style.setProperty('--cp-odds-accent', RARITY_COLORS[row.rarity]);
      item.style.setProperty('--cp-odds-share', String(row.weight / ODDS_SCALE));
      item.style.setProperty('--cp-odds-stagger', `${index * ROW_STAGGER_MS}ms`);
      if (row.rarity === 'heirloom') {
        item.style.setProperty('--cp-odds-prism', HEIRLOOM_PRISM.join(', '));
      }
      if (row.rarity === options.rarity) {
        item.classList.add('is-this');
        const tag = h('span', { class: 'cp-odds-this' });
        ctx.own(loc.text(tag, () => t('oddsThis')));
        name.after(tag);
      }
      ctx.own(loc.text(name, () => t(`rarity.${row.rarity}`)));
      ctx.own(loc.text(value, () => share(oddsShare(row.percent, options.language()))));
      oddsList.append(item);
    });
    const totalValue = h('span');
    const totalLabel = h('span');
    const total = h('p', { class: 'cp-odds-total' }, totalLabel, totalValue);
    ctx.own(loc.text(totalLabel, () => t('oddsTotal')));
    ctx.own(
      loc.text(totalValue, () => share(oddsShare(oddsTotalPercent(rows), options.language()))),
    );
    const note = h('p', { class: 'cp-odds-note' });
    ctx.own(loc.text(note, () => t('oddsNote')));
    oddsParts.push(oddsList, total, note);
  } else {
    oddsParts.push(broken('oddsBroken'));
  }

  const pityParts: HTMLElement[] = [];
  if (data.ladder.ok) {
    const pityList = h('ul', { class: 'cp-odds-pity' });
    for (const step of data.ladder.value) {
      const floor = h('span', { class: 'cp-odds-pity-floor' });
      const left = h('span', { class: 'cp-odds-pity-left' });
      const fill = h('span', { class: 'cp-odds-pity-fill' });
      const meter = h(
        'span',
        {
          class: 'cp-odds-pity-meter',
          attrs: {
            role: 'progressbar',
            'aria-valuemin': '0',
            'aria-valuemax': String(step.within),
            'aria-valuenow': String(step.misses),
          },
        },
        fill,
      );
      const item = h(
        'li',
        { class: 'cp-odds-pity-step', attrs: { 'data-rarity': step.rarity } },
        h('span', { class: 'cp-odds-pity-head' }, floor, left),
        meter,
      );
      item.style.setProperty('--cp-odds-accent', RARITY_COLORS[step.rarity]);
      item.style.setProperty('--cp-odds-share', String(step.misses / step.within));
      item.classList.toggle('is-next', step.left === 1);
      const floorCopy = () => t('oddsPityFloor', { rarity: t(`rarity.${step.rarity}`) });
      ctx.own(loc.text(floor, floorCopy));
      ctx.own(
        loc.text(left, () =>
          step.left === 1 ? t('oddsPityNext') : t('oddsPityLeft', { count: step.left }),
        ),
      );
      ctx.own(loc.attr(meter, 'aria-label', floorCopy));
      pityList.append(item);
    }
    pityParts.push(pityList);
  } else {
    pityParts.push(broken('oddsPityBroken'));
  }

  const proofList = h('dl', { class: 'cp-odds-proof' });
  const proofRow = (label: () => string, value: () => string, wide = false) => {
    const term = h('dt');
    const code = h('code');
    const detail = h('dd', {}, code);
    if (wide) detail.classList.add('is-wide');
    ctx.own(loc.text(term, label));
    ctx.own(loc.text(code, value));
    proofList.append(term, detail);
  };
  proofRow(
    () => t('proofCommitment'),
    () => proof.serverSeedHash,
    true,
  );
  proofRow(
    () => t('proofClientSeed'),
    () => proof.clientSeed,
  );
  proofRow(() => t('proofNonce'), nonce);

  const inputId = 'cp-odds-seed';
  const seedLabel = h('label', { class: 'cp-odds-seed-label', attrs: { for: inputId } });
  const seedInput = h('input', {
    class: 'cp-odds-seed',
    attrs: {
      id: inputId,
      type: 'text',
      inputmode: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'data-testid': 'odds-seed',
    },
  });
  const verifyLabel = h('span');
  const verifyButton = h(
    'button',
    { class: 'cp-odds-verify-button', attrs: { type: 'button', 'data-testid': 'odds-verify' } },
    verifyLabel,
  );
  const revealLabel = h('span');
  const revealButton = h(
    'button',
    { class: 'cp-odds-reveal-button', attrs: { type: 'button', 'data-testid': 'odds-reveal' } },
    revealLabel,
  );
  const verdict = h('p', {
    class: 'cp-odds-verdict',
    attrs: { role: 'status', 'data-state': 'idle' },
  });
  const verdictText = h('span');
  const verdictDigest = h('code', { class: 'cp-odds-digest' });
  verdictDigest.hidden = true;
  verdict.append(verdictText, verdictDigest);
  ctx.own(loc.text(seedLabel, () => t('verifyLabel')));
  ctx.own(loc.attr(seedInput, 'placeholder', () => t('verifyPlaceholder')));
  ctx.own(loc.text(verifyLabel, () => t('verifyAction')));
  ctx.own(loc.text(revealLabel, () => t('verifyReveal')));

  let disposed = false;
  const verifier = new FairVerifier(
    proof,
    { revealedSeeds: options.revealedSeeds, rotateSeed: options.rotateSeed },
    (state) => {
      if (disposed) return;
      const seed = verifier.seed;
      if (seed !== null && (state.status === 'verified' || state.status === 'mismatch')) {
        seedInput.value = seed;
      }
      if (
        state.status === 'verified' ||
        state.status === 'mismatch' ||
        state.status === 'malformed'
      ) {
        restartAnimation(verdict, 'is-landing');
        feedback(ctx, state.status === 'verified' ? 'confirm' : 'deny');
      }
      loc.refresh();
    },
  );
  const verdictKey = (state: VerifyState): Parameters<CratesT>[0] => {
    switch (state.status) {
      case 'idle':
        return 'verifyPaste';
      case 'checking':
        return 'verifyChecking';
      case 'unrevealed':
        return verifier.canReveal ? 'verifyUnrevealed' : 'verifyPending';
      case 'unavailable':
        return 'verifyUnavailable';
      case 'malformed':
        return 'verifyMalformed';
      case 'mismatch':
        return 'verifyMismatch';
      case 'verified':
        return 'verifyOk';
    }
  };
  ctx.own(
    loc.bind(() => {
      const state = verifier.state;
      verdict.dataset.state = state.status;
      verdictText.textContent = t(verdictKey(state));
      verdictDigest.hidden = state.status !== 'verified';
      verdictDigest.textContent = state.status === 'verified' ? state.digest : '';
      revealButton.hidden = !verifier.canReveal;
    }),
  );
  makePressable(verifyButton, ctx, {
    feedback: 'tap',
    enabled: () => seedInput.value.trim().length > 0,
    onPress: () => void verifier.paste(seedInput.value),
  });
  makePressable(revealButton, ctx, {
    feedback: 'open',
    enabled: () => verifier.canReveal,
    onPress: () => void verifier.reveal(),
  });
  ctx.own(
    listen(seedInput, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      verifyButton.click();
    }),
  );

  const section = (key: Parameters<CratesT>[0], ...children: HTMLElement[]) => {
    const heading = h('h4', { class: 'cp-odds-heading' });
    ctx.own(loc.text(heading, () => t(key)));
    return h('section', { class: 'cp-odds-section' }, heading, ...children);
  };
  const verifyRow = h('div', { class: 'cp-odds-verify-row' }, seedInput, verifyButton);
  const body = h(
    'div',
    { class: 'cp-odds-body' },
    section('oddsHeading', ...oddsParts),
    section('oddsPityHeading', ...pityParts),
    section('proofHeading', proofList, seedLabel, verifyRow, verdict, revealButton),
  );
  const panel = h(
    'section',
    { class: 'cp-odds-panel' },
    h(
      'header',
      { class: 'cp-odds-header' },
      seal,
      h('div', { class: 'cp-odds-heading-text' }, title, subtitle),
      closeButton,
    ),
    body,
  );
  const scrim = h('div', { class: 'cp-odds-scrim', attrs: { 'aria-hidden': 'true' } });
  const root = h(
    'div',
    {
      class: 'cp-odds',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        'data-testid': 'crate-odds',
        'data-rarity': options.rarity,
      },
    },
    scrim,
    panel,
  );
  root.hidden = true;

  let isOpen = false;
  let trigger: HTMLElement | null = null;
  let closing: ReturnType<typeof setTimeout> | null = null;

  const settleClosed = () => {
    closing = null;
    root.hidden = true;
    root.classList.remove('is-closing');
  };
  const close = () => {
    if (!isOpen || disposed) return;
    isOpen = false;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.focus({ preventScroll: true });
    if (options.reducedMotion) {
      settleClosed();
      return;
    }
    root.classList.remove('is-opening');
    root.classList.add('is-closing');
    closing = setTimeout(settleClosed, ODDS_CLOSE_MS);
  };

  makePressable(closeButton, ctx, { feedback: 'close', onPress: close });
  const dismiss = () => {
    if (isOpen) feedback(ctx, 'close');
    close();
  };
  ctx.own(listen(scrim, 'click', dismiss));
  ctx.own(
    listen(root, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }),
  );

  return {
    el: root,
    get isOpen() {
      return isOpen;
    },
    open(from) {
      if (isOpen || disposed) return;
      isOpen = true;
      trigger = from;
      if (closing !== null) clearTimeout(closing);
      closing = null;
      root.classList.remove('is-closing');
      root.hidden = false;
      from.setAttribute('aria-expanded', 'true');
      body.scrollTop = 0;
      restartAnimation(root, 'is-opening');
      closeButton.focus({ preventScroll: true });
      void verifier.lookUp();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      verifier.dispose();
      if (closing !== null) clearTimeout(closing);
      root.remove();
    },
  };
}
