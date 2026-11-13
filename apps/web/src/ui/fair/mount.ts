import './fair.css';
import { ODDS_SCALE, type OddsRow } from '@coinposh/economy';
import {
  RARITIES,
  type ActiveSeed,
  type DropSourceId,
  type FairProof,
  type Rarity,
  type RevealedSeed,
} from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { AudioEngine } from '../../audio/index.ts';
import { cratesKey } from '../../game/crates/i18n.ts';
import { oddsShare, oddsTotalPercent } from '../../game/crates/odds.ts';
import { sealIcon } from '../../game/crates/oddsSheet.ts';
import { formatInteger } from '../../i18n/index.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import { makePressable } from '../components/pressable.ts';
import { Odometer } from '../components/odometer.ts';
import { feedback, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { Localizer } from '../localize.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { createSheet } from '../panels/sheet.ts';
import type { FairData } from './data.ts';
import { fairT, registerFairStrings, type FairKey } from './i18n.ts';
import { fairCuePlan, type FairCue, type FairCuePlan } from './juice.ts';
import {
  digestWords,
  FAIR_SOURCES,
  FAIR_TABS,
  inputFromProof,
  inputFromSeed,
  lastNonce,
  newestFirst,
  nextClientSeed,
  oddsFor,
  oneIn,
  part,
  pityProgress,
  pityRows,
  seedForProof,
  shortHex,
  stepNonce,
  VERIFY_FIELDS,
  verifyRoll,
  type FairTab,
  type PityRow,
  type VerifyField,
  type VerifyInput,
  type VerifyResult,
} from './model.ts';

export type FairAudioPort = Pick<AudioEngine, 'playImpact'>;

export interface FairMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** Usually the UI root over the canvas. */
  readonly host: HTMLElement;
  readonly data: FairData;
  readonly audio?: (() => FairAudioPort | null) | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  /** Called after the panel closes itself (close button, backdrop, drag or Escape). */
  readonly onClose: () => void;
}

export interface FairOpenOptions {
  readonly tab?: FairTab;
  readonly source?: DropSourceId;
  /** A roll to check: the verify tab opens on it and checks it once its seed is revealed. */
  readonly proof?: FairProof;
}

export interface FairPanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(trigger: HTMLElement, options?: FairOpenOptions): void;
  close(): void;
  /** Re-reads the seed ledger and the pity counts, e.g. after a crate opens. */
  refresh(): Promise<void>;
  dispose(): void;
}

type LedgerPhase = 'loading' | 'ready' | 'error';
type VerifyState = { readonly status: 'idle' } | { readonly status: 'checking' } | VerifyResult;

const ROW_STAGGER_MS = 45;
const WORD_STAGGER_MS = 40;
const GLINTS = 4;

function accentStyle(el: HTMLElement, rarity: Rarity): void {
  el.style.setProperty('--cp-fair-accent', RARITY_COLORS[rarity]);
  if (rarity === 'heirloom') el.style.setProperty('--cp-fair-prism', HEIRLOOM_PRISM.join(', '));
}

export function mountFair(options: FairMountOptions): FairPanel {
  registerFairStrings(options.ui.i18n);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(options.ui.i18n);
  const ctx: UiContext = {
    i18n: options.ui.i18n,
    loc,
    store: options.ui.store,
    bus: options.ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const { i18n } = ctx;
  const t = fairT(i18n);
  const language = () => i18n.language;
  const rarityName = (rarity: Rarity) => i18n.t(cratesKey(`rarity.${rarity}`));
  const sourceName = (source: DropSourceId) => t(`source.${source}`);
  const count = (value: number) => formatInteger(value, language());

  let disposed = false;
  let tab: FairTab = 'odds';
  let source: DropSourceId = 'vaultCrate';
  let phase: LedgerPhase = 'loading';
  let active: ActiveSeed | null = null;
  let revealed: readonly RevealedSeed[] = [];
  let selected: RevealedSeed | null = null;
  let pendingProof: FairProof | null = null;
  let verifyState: VerifyState = { status: 'idle' };
  let verifyToken = 0;
  let rotating = false;
  let rotateError = false;
  let loadGeneration = 0;

  function play(cue: FairCue, withBus: boolean): FairCuePlan {
    const plan = fairCuePlan(cue, isReducedMotion());
    if (withBus) feedback(ctx, plan.feedback);
    if (plan.haptic) options.haptics?.pulse(plan.haptic);
    const audio = options.audio?.() ?? null;
    if (audio) {
      for (const step of plan.chime) {
        setTimeout(() => {
          if (!disposed) audio.playImpact(step.impact);
        }, step.at);
      }
    }
    return plan;
  }

  function sparks(host: HTMLElement, total: number): void {
    for (let i = 0; i < total; i++) {
      const spark = h('span', { class: 'cp-fair-spark', attrs: { 'aria-hidden': 'true' } });
      const angle = (i / total) * Math.PI * 2 + Math.random() * 0.4;
      const reach = 46 + Math.random() * 54;
      spark.style.setProperty('--cp-fair-dx', `${(Math.cos(angle) * reach).toFixed(1)}px`);
      spark.style.setProperty('--cp-fair-dy', `${(Math.sin(angle) * reach).toFixed(1)}px`);
      spark.style.setProperty('--cp-fair-delay', `${Math.round(Math.random() * 90)}ms`);
      spark.addEventListener('animationend', () => {
        spark.remove();
      });
      host.append(spark);
    }
  }

  const status = h('p', {
    class: 'cp-sr-only',
    attrs: { 'aria-live': 'polite', 'data-testid': 'fair-status' },
  });

  const crest = h('span', { class: 'cp-fair-crest', attrs: { 'aria-hidden': 'true' } }, sealIcon());
  for (let index = 0; index < GLINTS; index++) {
    const glint = h('span', { class: 'cp-fair-glint' });
    glint.style.setProperty('--cp-fair-glint', String(index));
    crest.append(glint);
  }

  const pill = h('span', { class: 'cp-fair-pill', attrs: { 'aria-hidden': 'true' } });
  const tabList = h('div', { class: 'cp-fair-tabs', attrs: { role: 'tablist' } }, pill);
  loc.attr(tabList, 'aria-label', () => t('tabs'));
  const tabButtons = new Map<FairTab, HTMLButtonElement>();
  const panes = new Map<FairTab, HTMLElement>();
  for (const id of FAIR_TABS) {
    const button = h('button', {
      class: 'cp-fair-tab',
      attrs: {
        type: 'button',
        role: 'tab',
        id: `cp-fair-tab-${id}`,
        'aria-controls': `cp-fair-pane-${id}`,
        'data-tab': id,
        'data-testid': `fair-tab-${id}`,
      },
    });
    loc.text(button, () => t(`tab.${id}`));
    makePressable(button, ctx, {
      feedback: 'toggle',
      onPress: () => {
        selectTab(id, true);
      },
    });
    tabButtons.set(id, button);
    tabList.append(button);
    panes.set(
      id,
      h('section', {
        class: 'cp-fair-pane',
        attrs: {
          role: 'tabpanel',
          id: `cp-fair-pane-${id}`,
          'aria-labelledby': `cp-fair-tab-${id}`,
          'data-pane': id,
        },
      }),
    );
  }
  ctx.own(
    listen(tabList, 'keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = FAIR_TABS[(FAIR_TABS.indexOf(tab) + step + FAIR_TABS.length) % FAIR_TABS.length];
      if (next === undefined) return;
      feedback(ctx, 'toggle');
      selectTab(next, true);
      tabButtons.get(next)?.focus();
    }),
  );
  const pillX = new SpringValue(0, SPRINGS.bouncy, (x) => {
    pill.style.translate = `${x}px 0`;
  });
  const pillW = new SpringValue(0, SPRINGS.snappy, (w) => {
    pill.style.width = `${Math.max(0, w)}px`;
  });

  function placePill(animate: boolean): void {
    const button = tabButtons.get(tab);
    if (!button || button.offsetWidth === 0) return;
    const x = button.offsetLeft;
    const w = button.offsetWidth;
    if (animate && pillW.value > 0) {
      void pillX.to(x);
      void pillW.to(w);
    } else {
      pillX.jump(x);
      pillW.jump(w);
    }
    restartAnimation(pill, 'is-gleaming');
  }

  const sourceRow = h('div', {
    class: 'cp-fair-sources',
    attrs: { role: 'group', 'data-testid': 'fair-sources' },
  });
  loc.attr(sourceRow, 'aria-label', () => t('sources'));
  const sourceChips = new Map<DropSourceId, HTMLButtonElement>();
  for (const id of FAIR_SOURCES) {
    const chip = h('button', {
      class: 'cp-fair-source',
      attrs: { type: 'button', 'data-source': id },
    });
    loc.text(chip, () => sourceName(id));
    makePressable(chip, ctx, {
      feedback: 'tick',
      onPress: () => {
        selectSource(id, true);
      },
    });
    sourceChips.set(id, chip);
    sourceRow.append(chip);
  }

  const oddsPane = panes.get('odds');
  const pityPane = panes.get('pity');
  const verifyPane = panes.get('verify');
  if (!oddsPane || !pityPane || !verifyPane)
    throw new Error('Certified Fair: a tab pane is missing');

  const oddsHeading = h('h3', { class: 'cp-fair-heading' });
  loc.text(oddsHeading, () => t('odds.heading', { source: sourceName(source) }));
  const oddsList = h('ol', { class: 'cp-fair-odds', attrs: { 'data-testid': 'fair-odds' } });
  const oddsBroken = h('p', { class: 'cp-fair-broken', attrs: { role: 'note', hidden: '' } });
  loc.text(oddsBroken, () => t('odds.broken'));
  const totalLabel = h('span');
  loc.text(totalLabel, () => t('odds.total'));
  const totalOdo = new Odometer();
  const total = h('p', { class: 'cp-fair-total' }, totalLabel, totalOdo.el);
  const oddsNote = h('p', { class: 'cp-fair-note' });
  loc.text(oddsNote, () => t('odds.note'));

  interface OddsLine {
    readonly el: HTMLElement;
    readonly odo: Odometer;
    readonly sub: HTMLElement;
    readonly bar: SpringValue;
    row: OddsRow | null;
  }
  const oddsLines = new Map<Rarity, OddsLine>();
  RARITIES.forEach((rarity, index) => {
    const name = h('span', { class: 'cp-fair-name' });
    loc.text(name, () => rarityName(rarity));
    const sub = h('span', { class: 'cp-fair-sub' });
    const odo = new Odometer();
    const fill = h('span', { class: 'cp-fair-fill' });
    const el = h(
      'li',
      { class: 'cp-fair-row', attrs: { 'data-rarity': rarity } },
      h(
        'span',
        { class: 'cp-fair-row-head' },
        h('span', { class: 'cp-fair-gem', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'cp-fair-label' }, name, sub),
        h('span', { class: 'cp-fair-value' }, odo.el),
      ),
      h('span', { class: 'cp-fair-bar', attrs: { 'aria-hidden': 'true' } }, fill),
    );
    accentStyle(el, rarity);
    el.style.setProperty('--cp-fair-stagger', `${index * ROW_STAGGER_MS}ms`);
    const bar = new SpringValue(0, SPRINGS.gentle, (value) => {
      fill.style.setProperty('--cp-fair-share', String(Math.max(0, value)));
    });
    oddsLines.set(rarity, { el, odo, sub, bar, row: null });
    oddsList.append(el);
  });
  oddsPane.append(oddsHeading, oddsList, oddsBroken, total, oddsNote);

  function shareText(percent: number): string {
    return t('odds.share', { value: oddsShare(percent, language()) });
  }

  function paintOdds(fromZero: boolean): void {
    const rows = oddsFor(source);
    if (!rows.ok) console.error('[CoinPosh] Certified Fair odds could not be shown', rows.error);
    oddsList.hidden = !rows.ok;
    total.hidden = !rows.ok;
    oddsBroken.hidden = rows.ok;
    if (!rows.ok) return;
    for (const row of rows.value) {
      const line = oddsLines.get(row.rarity);
      if (!line) continue;
      const previous = line.row;
      line.row = row;
      const text = shareText(row.percent);
      if (fromZero) line.odo.jump(shareText(0));
      line.odo.set(text, previous && previous.weight > row.weight ? -1 : 1);
      line.el.classList.toggle('is-empty', row.weight === 0);
      line.el.setAttribute('aria-label', `${rarityName(row.rarity)}: ${text}`);
      const odds = oneIn(row);
      line.sub.textContent =
        odds === null ? t('odds.none') : t('odds.oneIn', { value: count(odds) });
      if (fromZero) line.bar.jump(0);
      void line.bar.to(row.weight / ODDS_SCALE);
      if (fromZero || previous?.weight !== row.weight) restartAnimation(line.el, 'is-lit');
    }
    const sum = shareText(oddsTotalPercent(rows.value));
    if (fromZero) totalOdo.jump(shareText(0));
    totalOdo.set(sum, 1);
    total.setAttribute('aria-label', `${t('odds.total')}: ${sum}`);
  }

  const pityHeading = h('h3', { class: 'cp-fair-heading' });
  loc.text(pityHeading, () => t('pity.heading', { source: sourceName(source) }));
  const pityIntro = h('p', { class: 'cp-fair-note' });
  loc.text(pityIntro, () => t('pity.intro'));
  const pityList = h('ul', { class: 'cp-fair-pity', attrs: { 'data-testid': 'fair-pity' } });
  const pityEmpty = h('p', { class: 'cp-fair-broken', attrs: { role: 'note', hidden: '' } });
  pityPane.append(pityHeading, pityIntro, pityList, pityEmpty);
  const pityMeters = new Map<Rarity, SpringValue>();
  const pityOdos = new Map<Rarity, Odometer>();
  const pityDisposers: (() => void)[] = [];

  function pityCopy(row: PityRow): string {
    if (row.left === null) return t('pity.unknown');
    return row.left === 1 ? t('pity.next') : t('pity.left', { count: row.left });
  }

  function paintPity(fromZero: boolean): void {
    for (const dispose of pityDisposers.splice(0)) dispose();
    const counters = options.data.pity?.()[source] ?? null;
    const rows = part(() => pityRows(source, counters));
    if (!rows.ok) console.error('[CoinPosh] Certified Fair pity could not be shown', rows.error);
    const list = rows.ok ? rows.value : [];
    pityEmpty.hidden = rows.ok && list.length > 0;
    pityEmpty.textContent = rows.ok ? t('pity.none') : t('pity.broken');
    pityList.hidden = list.length === 0;
    const keep = new Set(list.map((row) => row.rarity));
    for (const rarity of [...pityMeters.keys()]) {
      if (keep.has(rarity)) continue;
      pityMeters.delete(rarity);
      pityOdos.delete(rarity);
    }
    pityList.replaceChildren(
      ...list.map((row, index) => {
        const fill = h('span', { class: 'cp-fair-meter-fill' });
        const meter = h(
          'span',
          {
            class: 'cp-fair-meter',
            attrs: {
              role: 'progressbar',
              'aria-valuemin': '0',
              'aria-valuemax': String(row.within),
              'aria-valuenow': String(row.misses ?? 0),
            },
          },
          fill,
          ...Array.from({ length: Math.min(row.within, 40) - 1 }, (_, notch) => {
            const tick = h('span', { class: 'cp-fair-notch' });
            tick.style.left = `${(((notch + 1) / Math.min(row.within, 40)) * 100).toFixed(2)}%`;
            return tick;
          }),
        );
        const previous = pityMeters.get(row.rarity)?.value ?? 0;
        const spring = new SpringValue(fromZero ? 0 : previous, SPRINGS.gentle, (value) => {
          fill.style.setProperty('--cp-fair-share', String(Math.max(0, value)));
        });
        pityMeters.set(row.rarity, spring);
        void spring.to(pityProgress(row));
        const odo = new Odometer();
        const before = pityOdos.get(row.rarity);
        pityOdos.set(row.rarity, odo);
        const floor = h('span', { class: 'cp-fair-floor' });
        const state = h('span', { class: 'cp-fair-left' });
        const within = h('span', { class: 'cp-fair-within' });
        const tally = h('span', { class: 'cp-fair-tally' }, odo.el);
        tally.hidden = row.misses === null;
        const floorCopy = () => t('pity.floor', { rarity: rarityName(row.rarity) });
        pityDisposers.push(
          loc.text(floor, floorCopy),
          loc.text(state, () => pityCopy(row)),
          loc.text(within, () => t('pity.within', { count: row.within })),
          loc.attr(meter, 'aria-label', floorCopy),
          loc.bind(() => {
            const text = t('pity.tally', {
              misses: count(row.misses ?? 0),
              within: count(row.within),
            });
            if (fromZero || !before)
              odo.jump(t('pity.tally', { misses: count(0), within: count(row.within) }));
            odo.set(text, 1);
          }),
        );
        const item = h(
          'li',
          {
            class: `cp-fair-guarantee${row.left === 1 ? ' is-next' : ''}`,
            attrs: { 'data-rarity': row.rarity },
          },
          h(
            'span',
            { class: 'cp-fair-guarantee-head' },
            h('span', { class: 'cp-fair-gem', attrs: { 'aria-hidden': 'true' } }),
            floor,
            tally,
          ),
          meter,
          h('span', { class: 'cp-fair-guarantee-foot' }, state, within),
        );
        accentStyle(item, row.rarity);
        item.style.setProperty('--cp-fair-stagger', `${index * ROW_STAGGER_MS}ms`);
        restartAnimation(item, 'is-lit');
        return item;
      }),
    );
  }

  const ledgerLoading = h(
    'div',
    { class: 'cp-fair-loading', attrs: { 'aria-busy': 'true' } },
    ...Array.from({ length: 3 }, () => h('span', { class: 'cp-fair-shimmer' })),
  );
  const ledgerError = h('div', { class: 'cp-fair-error', attrs: { hidden: '' } });
  const ledgerErrorText = h('p');
  loc.text(ledgerErrorText, () => t('verify.unavailable'));
  const retry = h('button', { class: 'cp-chip', attrs: { type: 'button' } });
  loc.text(retry, () => t('verify.retry'));
  makePressable(retry, ctx, { feedback: 'tap', onPress: () => void refresh() });
  ledgerError.append(ledgerErrorText, retry);

  const fact = (labelKey: FairKey, code: HTMLElement) => {
    const term = h('dt');
    loc.text(term, () => t(labelKey));
    return [term, h('dd', {}, code)];
  };
  const activeCommitment = h('code', { attrs: { 'data-testid': 'fair-active-commitment' } });
  const activeClientSeed = h('code');
  const activeOdo = new Odometer();
  const activeRolls = h('span', { class: 'cp-fair-rolls' }, activeOdo.el);
  const activeHeading = h('h3', { class: 'cp-fair-heading' });
  loc.text(activeHeading, () => t('verify.activeHeading'));
  const activeHint = h('p', { class: 'cp-fair-note' });
  loc.text(activeHint, () => t('verify.activeHint'));
  const activeFacts = h(
    'dl',
    { class: 'cp-fair-facts' },
    ...fact('verify.commitment', activeCommitment),
    ...fact('verify.clientSeed', activeClientSeed),
  );
  const clientSeedId = 'cp-fair-next-client-seed';
  const clientSeedLabel = h('label', { class: 'cp-fair-label-text', attrs: { for: clientSeedId } });
  loc.text(clientSeedLabel, () => t('verify.nextClientSeed'));
  const clientSeedInput = h('input', {
    class: 'cp-fair-input',
    attrs: {
      id: clientSeedId,
      type: 'text',
      maxlength: '64',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-describedby': `${clientSeedId}-hint`,
      'data-testid': 'fair-next-client-seed',
    },
  });
  const clientSeedHint = h('p', { class: 'cp-fair-hint', attrs: { id: `${clientSeedId}-hint` } });
  const pendingHint = h('p', {
    class: 'cp-fair-hint is-pending',
    attrs: { 'data-testid': 'fair-pending-hint' },
  });
  loc.text(pendingHint, () => t('verify.pendingActive'));
  const rotateLabel = h('span');
  const rotateButton = h(
    'button',
    { class: 'cp-fair-button is-primary', attrs: { type: 'button', 'data-testid': 'fair-rotate' } },
    rotateLabel,
  );
  const activeCard = h(
    'div',
    { class: 'cp-fair-card cp-fair-active', attrs: { 'data-testid': 'fair-active' } },
    h('div', { class: 'cp-fair-card-head' }, activeHeading, activeRolls),
    activeHint,
    activeFacts,
    clientSeedLabel,
    clientSeedInput,
    clientSeedHint,
    pendingHint,
    rotateButton,
  );

  const revealedHeading = h('h3', { class: 'cp-fair-heading' });
  loc.text(revealedHeading, () => t('verify.revealedHeading'));
  const revealedList = h('ul', {
    class: 'cp-fair-revealed',
    attrs: { 'data-testid': 'fair-revealed' },
  });
  const revealedEmpty = h('p', { class: 'cp-fair-note' });
  loc.text(revealedEmpty, () => t('verify.revealedEmpty'));
  const revealedDisposers: (() => void)[] = [];

  const checkHeading = h('h3', { class: 'cp-fair-heading' });
  loc.text(checkHeading, () => t('verify.checkHeading'));
  const checkHint = h('p', { class: 'cp-fair-note' });
  loc.text(checkHint, () => t('verify.checkHint'));
  const inputs = {} as Record<VerifyField, HTMLInputElement>;
  const formFields = VERIFY_FIELDS.map((name) => {
    const id = `cp-fair-${name}`;
    const label = h('label', { class: 'cp-fair-label-text', attrs: { for: id } });
    loc.text(label, () => t(`verify.${name}`));
    const input = h('input', {
      class: `cp-fair-input${name === 'nonce' ? ' is-nonce' : ' is-hex'}`,
      attrs: {
        id,
        type: 'text',
        inputmode: name === 'nonce' ? 'numeric' : 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        'data-testid': `fair-${name}`,
      },
    });
    inputs[name] = input;
    ctx.own(
      listen(input, 'input', () => {
        if (verifyState.status === 'idle') return;
        verifyToken++;
        verifyState = { status: 'idle' };
        paintVerdict();
      }),
    );
    ctx.own(
      listen(input, 'keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        verifyButton.click();
      }),
    );
    if (name !== 'nonce') return h('div', { class: 'cp-fair-field' }, label, input);
    const stepper = (delta: -1 | 1, key: FairKey) => {
      const button = h(
        'button',
        {
          class: 'cp-fair-step',
          attrs: {
            type: 'button',
            'data-step': String(delta),
            'data-testid': `fair-nonce-${delta > 0 ? 'next' : 'prev'}`,
          },
        },
        delta > 0 ? '+' : '−',
      );
      loc.attr(button, 'aria-label', () => t(key));
      makePressable(button, ctx, {
        feedback: 'tick',
        enabled: () => canStep(delta),
        onPress: () => {
          stepSelected(delta);
        },
      });
      return button;
    };
    return h(
      'div',
      { class: 'cp-fair-field is-nonce' },
      label,
      h(
        'div',
        { class: 'cp-fair-stepper' },
        stepper(-1, 'verify.previousNonce'),
        input,
        stepper(1, 'verify.nextNonce'),
      ),
    );
  });
  const verifyLabel = h('span');
  const verifyButton = h(
    'button',
    { class: 'cp-fair-button is-primary', attrs: { type: 'button', 'data-testid': 'fair-verify' } },
    verifyLabel,
  );
  const verdictSeal = h('span', { class: 'cp-fair-stamp', attrs: { 'aria-hidden': 'true' } });
  const verdictTitle = h('strong', { class: 'cp-fair-verdict-title' });
  const verdictText = h('span', { class: 'cp-fair-verdict-text' });
  const digestLabel = h('span', { class: 'cp-fair-label-text' });
  loc.text(digestLabel, () => t('verify.digest'));
  const digestGrid = h('code', {
    class: 'cp-fair-digest',
    attrs: { 'data-testid': 'fair-digest' },
  });
  const digestBlock = h('div', { class: 'cp-fair-digest-block' }, digestLabel, digestGrid);
  const computedLabel = h('span', { class: 'cp-fair-label-text' });
  loc.text(computedLabel, () => t('verify.computed'));
  const computedValue = h('code', { class: 'cp-fair-computed' });
  const computedBlock = h('div', { class: 'cp-fair-digest-block' }, computedLabel, computedValue);
  const sparkHost = h('span', { class: 'cp-fair-sparks', attrs: { 'aria-hidden': 'true' } });
  const verdict = h(
    'div',
    {
      class: 'cp-fair-verdict',
      attrs: { role: 'status', 'data-state': 'idle', 'data-testid': 'fair-verdict' },
    },
    h(
      'div',
      { class: 'cp-fair-verdict-head' },
      verdictSeal,
      h('span', { class: 'cp-fair-verdict-copy' }, verdictTitle, verdictText),
      sparkHost,
    ),
    digestBlock,
    computedBlock,
  );
  const checkCard = h(
    'div',
    { class: 'cp-fair-card cp-fair-check' },
    checkHeading,
    checkHint,
    h('div', { class: 'cp-fair-form' }, ...formFields),
    verifyButton,
    verdict,
  );
  const ledger = h(
    'div',
    { class: 'cp-fair-ledger' },
    activeCard,
    h('div', { class: 'cp-fair-card' }, revealedHeading, revealedList, revealedEmpty),
    checkCard,
  );
  verifyPane.append(ledgerLoading, ledgerError, ledger);

  function readInput(): VerifyInput {
    return {
      serverSeed: inputs.serverSeed.value,
      commitment: inputs.commitment.value,
      clientSeed: inputs.clientSeed.value,
      nonce: inputs.nonce.value,
    };
  }

  function fill(input: VerifyInput): void {
    for (const name of VERIFY_FIELDS) inputs[name].value = input[name];
    verifyToken++;
    verifyState = { status: 'idle' };
  }

  function currentNonce(): number {
    const value = Number(inputs.nonce.value.trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function canStep(delta: -1 | 1): boolean {
    if (!selected) return false;
    return stepNonce(selected, currentNonce(), delta) !== currentNonce();
  }

  function stepSelected(delta: -1 | 1): void {
    if (!selected) return;
    const nonce = stepNonce(selected, currentNonce(), delta);
    inputs.nonce.value = String(nonce);
    restartAnimation(inputs.nonce, 'is-rolled');
    play('step', false);
    void runVerify(false);
  }

  function choose(seed: RevealedSeed, nonce: number, announce: boolean): void {
    selected = seed;
    fill(inputFromSeed(seed, nonce));
    paintRevealed();
    paintVerdict();
    if (announce) void runVerify(false);
  }

  function dateText(epochMs: number): string {
    return new Intl.DateTimeFormat(language(), { dateStyle: 'medium', timeStyle: 'short' }).format(
      epochMs,
    );
  }

  function paintRevealed(): void {
    for (const dispose of revealedDisposers.splice(0)) dispose();
    const seeds = newestFirst(revealed);
    revealedEmpty.hidden = seeds.length > 0;
    revealedList.hidden = seeds.length === 0;
    revealedList.replaceChildren(
      ...seeds.map((seed, index) => {
        const isSelected = selected?.serverSeedHash === seed.serverSeedHash;
        const when = h('span', { class: 'cp-fair-seed-when' });
        const rolls = h('span', { class: 'cp-fair-seed-rolls' });
        const hash = h('code', { class: 'cp-fair-seed-hash', text: shortHex(seed.serverSeedHash) });
        const button = h(
          'button',
          {
            class: `cp-fair-seed${isSelected ? ' is-active' : ''}`,
            attrs: {
              type: 'button',
              'aria-pressed': String(isSelected),
              title: seed.serverSeedHash,
              'data-testid': 'fair-seed',
            },
          },
          h('span', { class: 'cp-fair-seed-main' }, when, rolls),
          hash,
        );
        button.style.setProperty('--cp-fair-stagger', `${Math.min(index, 8) * ROW_STAGGER_MS}ms`);
        revealedDisposers.push(
          loc.text(when, () => t('verify.revealedAt', { date: dateText(seed.revealedAt) })),
          loc.text(rolls, () => t('verify.rolls', { count: seed.finalNonce })),
        );
        const rowCtx: UiContext = { ...ctx, own: (dispose) => revealedDisposers.push(dispose) };
        makePressable(button, rowCtx, {
          feedback: 'tick',
          onPress: () => {
            play('step', false);
            choose(seed, lastNonce(seed) ?? 0, true);
          },
        });
        return h('li', {}, button);
      }),
    );
  }

  /** The roll a crate reveal opened the panel on was spent under the seed still in play. */
  function proofAwaitsReveal(): boolean {
    return (
      pendingProof !== null &&
      active !== null &&
      pendingProof.serverSeedHash === active.serverSeedHash
    );
  }

  function paintActive(fromZero: boolean): void {
    const rolls = active?.nonce ?? 0;
    const text = t('verify.rolls', { count: rolls });
    if (fromZero) activeOdo.jump(t('verify.rolls', { count: 0 }));
    activeOdo.set(text, 1);
    activeRolls.setAttribute('aria-label', text);
    activeCommitment.textContent = active?.serverSeedHash ?? '';
    activeClientSeed.textContent = active?.clientSeed ?? '';
    rotateButton.hidden = options.data.rotate === undefined;
    clientSeedInput.hidden = rotateButton.hidden;
    clientSeedLabel.hidden = rotateButton.hidden;
    clientSeedHint.hidden = rotateButton.hidden;
    rotateButton.setAttribute('aria-disabled', String(rotating || active === null));
    rotateButton.classList.toggle('is-busy', rotating);
    const awaiting = proofAwaitsReveal() && !rotateButton.hidden;
    pendingHint.hidden = !awaiting;
    rotateButton.classList.toggle('is-beckoning', awaiting && !rotating);
    rotateLabel.textContent = rotating ? t('verify.rotating') : t('verify.rotate');
    const clientSeed = nextClientSeed(clientSeedInput.value);
    clientSeedHint.classList.toggle('is-error', !clientSeed.ok || rotateError);
    clientSeedHint.textContent = rotateError
      ? t('verify.rotateFailed')
      : clientSeed.ok
        ? t('verify.nextClientSeedHint')
        : t('verify.nextClientSeedInvalid');
  }

  ctx.own(
    listen(clientSeedInput, 'input', () => {
      rotateError = false;
      paintActive(false);
    }),
  );

  function paintLedger(fromZero: boolean): void {
    ledgerLoading.hidden = phase !== 'loading';
    ledgerError.hidden = phase !== 'error';
    ledger.hidden = phase !== 'ready';
    if (phase !== 'ready') return;
    paintActive(fromZero);
    paintRevealed();
    paintVerdict();
  }

  function verdictCopy(state: VerifyState): { title: string; text: string } {
    switch (state.status) {
      case 'idle':
        return {
          title: '',
          text: proofAwaitsReveal() ? t('verify.pendingActive') : t('verify.idle'),
        };
      case 'checking':
        return { title: '', text: t('verify.checking') };
      case 'invalid':
        return { title: t('verify.invalidTitle'), text: t(`verify.invalid.${state.field}`) };
      case 'mismatch':
        return {
          title: t('verify.mismatchTitle'),
          text:
            state.reason === 'unspent'
              ? t('verify.mismatch.unspent', { count: selected?.finalNonce ?? 0 })
              : t(`verify.mismatch.${state.reason}`),
        };
      case 'match':
        return { title: t('verify.matchTitle'), text: t('verify.match') };
      case 'consistent':
        return { title: t('verify.consistentTitle'), text: t('verify.consistent') };
    }
  }

  function paintVerdict(): void {
    const state = verifyState;
    verdict.dataset.state = state.status;
    const copy = verdictCopy(state);
    verdictTitle.textContent = copy.title;
    verdictTitle.hidden = copy.title === '';
    verdictText.textContent = copy.text;
    verdictSeal.hidden = state.status !== 'match' && state.status !== 'mismatch';
    if (verdictSeal.dataset.state !== state.status) {
      verdictSeal.dataset.state = state.status;
      verdictSeal.replaceChildren(state.status === 'mismatch' ? icon('close') : sealIcon());
    }
    const digest =
      state.status === 'match' || state.status === 'mismatch' || state.status === 'consistent'
        ? state.digest
        : null;
    digestBlock.hidden = digest === null;
    const words = digest === null ? [] : digestWords(digest);
    if (digestGrid.dataset.digest !== (digest ?? '')) {
      digestGrid.dataset.digest = digest ?? '';
      digestGrid.replaceChildren(
        ...words.map((word, index) => {
          const span = h('span', { class: 'cp-fair-word', text: word });
          span.style.setProperty('--cp-fair-stagger', `${index * WORD_STAGGER_MS}ms`);
          return span;
        }),
      );
    }
    const showComputed = state.status === 'mismatch' && state.reason === 'commitment';
    computedBlock.hidden = !showComputed;
    computedValue.textContent = showComputed ? state.computed : '';
    verifyButton.setAttribute('aria-disabled', String(state.status === 'checking'));
    verifyLabel.textContent =
      state.status === 'checking' ? t('verify.checking') : t('verify.action');
    for (const name of VERIFY_FIELDS) {
      inputs[name].setAttribute(
        'aria-invalid',
        String(state.status === 'invalid' && state.field === name),
      );
    }
  }
  ctx.own(
    loc.bind(() => {
      if (phase === 'ready') paintLedger(false);
    }),
  );

  /** `cue` plays the stamp's full juice; a quiet re-check (stepping a nonce) only lights it. */
  async function runVerify(cue: boolean): Promise<void> {
    if (proofAwaitsReveal() && inputs.serverSeed.value.trim() === '') {
      verifyToken++;
      verifyState = { status: 'idle' };
      paintVerdict();
      status.textContent = t('verify.pendingActive');
      if (cue) {
        play('step', true);
        restartAnimation(rotateButton, 'is-lit');
      }
      return;
    }
    const token = ++verifyToken;
    verifyState = { status: 'checking' };
    paintVerdict();
    const published =
      selected !== null && selected.serverSeedHash === inputs.commitment.value.trim().toLowerCase()
        ? selected
        : (revealed.find(
            (seed) => seed.serverSeedHash === inputs.commitment.value.trim().toLowerCase(),
          ) ?? null);
    let result: VerifyResult;
    try {
      result = await verifyRoll(readInput(), published);
    } catch (error) {
      console.error('[CoinPosh] Web Crypto could not recompute the roll', error);
      result = { status: 'invalid', field: 'serverSeed' };
    }
    if (token !== verifyToken || disposed) return;
    if (published) selected = published;
    const land = () => {
      if (token !== verifyToken || disposed) return;
      verifyState = result;
      paintVerdict();
      paintRevealed();
      restartAnimation(verdict, 'is-landing');
      status.textContent = verdictCopy(result).text;
      if (result.status === 'match' && plan.sparks > 0) sparks(sparkHost, plan.sparks);
    };
    const kind: FairCue =
      result.status === 'match' ? 'match' : result.status === 'consistent' ? 'step' : 'mismatch';
    const plan = cue ? play(kind, true) : fairCuePlan(kind, isReducedMotion());
    if (!cue) {
      land();
      return;
    }
    if (plan.hold > 0) setTimeout(land, plan.hold);
    else land();
  }

  makePressable(verifyButton, ctx, {
    feedback: 'tap',
    enabled: () => verifyState.status !== 'checking',
    onPress: () => void runVerify(true),
  });

  makePressable(rotateButton, ctx, {
    feedback: 'open',
    enabled: () => !rotating && active !== null && nextClientSeed(clientSeedInput.value).ok,
    onPress: () => void rotate(),
  });

  async function rotate(): Promise<void> {
    const send = options.data.rotate;
    const clientSeed = nextClientSeed(clientSeedInput.value);
    if (!send || !clientSeed.ok || rotating) return;
    rotating = true;
    rotateError = false;
    paintActive(false);
    try {
      const response = await send(clientSeed.value);
      if (disposed) return;
      active = response.active;
      revealed = [
        ...revealed.filter((seed) => seed.serverSeedHash !== response.revealed.serverSeedHash),
        response.revealed,
      ];
      clientSeedInput.value = '';
      rotating = false;
      const plan = play('rotate', true);
      restartAnimation(activeCard, 'is-rotated');
      if (plan.sparks > 0) sparks(activeCard, plan.sparks);
      status.textContent = t('verify.rotated');
      paintActive(true);
      choose(response.revealed, lastNonce(response.revealed) ?? 0, false);
      const proof = pendingProof;
      if (proof && seedForProof(proof, [response.revealed])) {
        pendingProof = null;
        fill(inputFromProof(proof, response.revealed));
      }
      void runVerify(false);
    } catch (error) {
      if (disposed) return;
      console.warn('[CoinPosh] the fair seed could not be rotated', error);
      rotating = false;
      rotateError = true;
      feedback(ctx, 'deny');
      status.textContent = t('verify.rotateFailed');
      paintActive(false);
    }
  }

  const body = h(
    'div',
    { class: 'cp-fair', attrs: { 'data-testid': 'fair' } },
    h('div', { class: 'cp-fair-top' }, crest, tabList),
    sourceRow,
    oddsPane,
    pityPane,
    verifyPane,
    status,
  );

  const sheet = createSheet(ctx, {
    id: 'fair',
    title: () => t('title'),
    subtitle: () => t('subtitle'),
    body,
    onRequestClose: () => {
      panel.close();
      options.onClose();
    },
  });
  const root = h('div', { class: 'cp-ui cp-fair-root' }, sheet.el);
  options.host.append(root);
  root.classList.toggle('is-reduced', isReducedMotion());
  ctx.own(
    onReducedMotionChange((reduced) => {
      root.classList.toggle('is-reduced', reduced);
    }),
  );
  const resize = new ResizeObserver(() => {
    placePill(false);
  });
  resize.observe(tabList);
  ctx.own(() => {
    resize.disconnect();
  });

  function selectTab(next: FairTab, cue: boolean): void {
    const changed = next !== tab;
    tab = next;
    for (const [id, button] of tabButtons) {
      const on = id === next;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle('is-active', on);
    }
    for (const [id, pane] of panes) {
      pane.hidden = id !== next;
      if (id === next && changed) restartAnimation(pane, 'is-entering');
    }
    sourceRow.hidden = next === 'verify';
    root.dataset.tab = next;
    placePill(cue);
    if (!changed && cue) return;
    if (next === 'odds') paintOdds(true);
    if (next === 'pity') paintPity(true);
    if (next === 'verify') paintLedger(true);
    if (cue) play('tab', false);
  }

  function selectSource(next: DropSourceId, cue: boolean): void {
    const changed = next !== source;
    source = next;
    for (const [id, chip] of sourceChips) {
      const on = id === next;
      chip.setAttribute('aria-pressed', String(on));
      chip.classList.toggle('is-active', on);
    }
    loc.refresh();
    if (!changed) return;
    paintOdds(false);
    paintPity(false);
    if (cue) {
      play('source', false);
      restartAnimation(tab === 'pity' ? pityHeading : oddsHeading, 'is-lit');
    }
  }

  async function load(): Promise<void> {
    const generation = ++loadGeneration;
    try {
      const ledgerData = await options.data.seeds();
      if (generation !== loadGeneration || disposed) return;
      active = ledgerData.active;
      revealed = ledgerData.revealed;
      phase = 'ready';
      const proof = pendingProof;
      if (proof) {
        const seed = seedForProof(proof, revealed);
        fill(inputFromProof(proof, seed));
        if (seed) {
          pendingProof = null;
          selected = seed;
        }
      } else if (selected) {
        selected =
          revealed.find((seed) => seed.serverSeedHash === selected?.serverSeedHash) ?? null;
      } else {
        const newest = newestFirst(revealed)[0];
        if (newest) {
          selected = newest;
          fill(inputFromSeed(newest, lastNonce(newest) ?? 0));
        }
      }
    } catch (error) {
      if (generation !== loadGeneration || disposed) return;
      console.warn('[CoinPosh] the fair seed ledger could not be loaded', error);
      phase = 'error';
    }
    paintLedger(true);
    if (phase === 'ready' && selected && tab === 'verify' && inputs.serverSeed.value !== '') {
      void runVerify(false);
    }
  }

  function refresh(): Promise<void> {
    if (active === null) {
      phase = 'loading';
      paintLedger(false);
    }
    paintPity(false);
    return load();
  }

  const panel: FairPanel = {
    el: root,
    get isOpen() {
      return sheet.isOpen;
    },
    open(trigger, openOptions = {}) {
      if (sheet.isOpen) return;
      const proof = openOptions.proof ?? null;
      pendingProof = proof;
      if (proof) {
        selected = null;
        fill(inputFromProof(proof, null));
      }
      play('open', true);
      sheet.open(trigger);
      restartAnimation(root, 'is-opening');
      selectSource(openOptions.source ?? source, false);
      tab = openOptions.tab ?? (proof ? 'verify' : tab);
      selectTab(tab, false);
      paintOdds(true);
      paintPity(true);
      requestAnimationFrame(() => {
        placePill(false);
      });
      void refresh();
    },
    close() {
      sheet.close();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of pityDisposers.splice(0)) dispose();
      for (const dispose of revealedDisposers.splice(0)) dispose();
      for (const dispose of disposers.splice(0)) dispose();
      loc.dispose();
      root.remove();
    },
  };
  selectSource(source, false);
  selectTab(tab, false);
  return panel;
}
