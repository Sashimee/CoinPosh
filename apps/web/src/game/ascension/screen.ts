import './ascension.css';
import type { AscendResponse, VenueId } from '@coinposh/shared';
import type { UiApp, UiAudio } from '../../app/index.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { formatBalance, formatInteger, type InterpolationValues } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { h, listen, restartAnimation } from '../../ui/dom.ts';
import { icon } from '../../ui/icons.ts';
import { Localizer } from '../../ui/localize.ts';
import { schedule } from '../../ui/motion/loop.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import type { AscensionController } from './controller.ts';
import {
  ascensionKey,
  lineNameKey,
  registerAscensionStrings,
  rejectionKey,
  venueKey,
} from './i18n.ts';
import {
  ascensionProgress,
  canRequestAscension,
  familyOfficeRows,
  holdFraction,
  holdTick,
  type FamilyOfficeRow,
} from './plan.ts';

/** Rising coin taps under the hold ring, landing on brass when it completes. */
const HOLD_TICK_SOUND: ImpactEvent = { material: 'coin', velocity: 0.35, pan: 0 };
const HOLD_DONE_SOUND: ImpactEvent = { material: 'metal', velocity: 1.3, pan: 0 };
const PURCHASE_CHIME: readonly ImpactEvent[] = [
  { material: 'coin', velocity: 1.0, pan: -0.15 },
  { material: 'metal', velocity: 1.1, pan: 0.15 },
];
const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface AscensionScreenOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n' | 'setWallet'>;
  /** The overlay is appended here; usually the UI root laid over the canvas. */
  readonly host: HTMLElement;
  readonly venueId: VenueId;
  /** Lifetime Bullion as the server last reported it; null when the client has no figure. */
  readonly bullion: number | null;
  readonly controller: AscensionController;
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
  /** The server confirmed the ascension; the caller plays the cinematic and swaps the venue. */
  readonly onConfirmed: (response: AscendResponse) => void;
  readonly onClose: () => void;
  /** Re-reads GET /v1/state when the server says the screen was stale. */
  readonly refresh?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly reducedMotion?: boolean;
}

export interface AscensionScreen {
  readonly el: HTMLElement;
  /** A fresher lifetime Bullion figure from the server; null when the read failed. */
  setBullion(bullion: number | null): void;
  dispose(): void;
}

function ring(className: string): SVGCircleElement {
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('class', className);
  circle.setAttribute('cx', '60');
  circle.setAttribute('cy', '60');
  circle.setAttribute('r', String(RING_RADIUS));
  return circle;
}

function setRing(circle: SVGCircleElement, fraction: number): void {
  circle.style.strokeDasharray = `${RING_LENGTH}`;
  circle.style.strokeDashoffset = `${RING_LENGTH * (1 - Math.min(1, Math.max(0, fraction)))}`;
}

export function showAscension(options: AscensionScreenOptions): AscensionScreen {
  const { ui, controller, venueId } = options;
  registerAscensionStrings(ui.i18n);
  const reduced = options.reducedMotion ?? isReducedMotion();
  const disposers: (() => void)[] = [];
  const loc = new Localizer(ui.i18n);
  const ctx: UiContext = {
    i18n: ui.i18n,
    loc,
    store: ui.store,
    bus: ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const t = (key: Parameters<typeof ascensionKey>[0], values?: InterpolationValues) =>
    ui.i18n.t(ascensionKey(key), values);
  const venueName = (id: VenueId) => ui.i18n.t(venueKey(id));
  const int = (value: number) => formatInteger(value, ui.i18n.language);
  const play = (sound: ImpactEvent) => options.audio()?.playImpact(sound);
  let progress = ascensionProgress(venueId, options.bullion);

  const title = h('h2', { class: 'cp-ascension-title', attrs: { id: 'cp-ascension-title' } });
  const subtitle = h('p', { class: 'cp-ascension-subtitle' });
  const close = h(
    'button',
    { class: 'cp-ascension-close', attrs: { type: 'button', 'data-testid': 'ascension-close' } },
    icon('close'),
  );

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'cp-ascension-ring');
  svg.setAttribute('aria-hidden', 'true');
  const track = ring('cp-ascension-ring-track');
  const fill = ring('cp-ascension-ring-fill');
  const hold = ring('cp-ascension-ring-hold');
  svg.append(track, fill, hold);
  setRing(hold, 0);
  const laurel = h('span', { class: 'cp-ascension-laurel' }, icon('laurel'));
  const dial = h('div', { class: 'cp-ascension-dial' }, svg, laurel);
  const progressText = h('p', { class: 'cp-ascension-progress' });
  const estimateLabel = h('span', { class: 'cp-ascension-estimate-label' });
  const estimateValue = h('span', { class: 'cp-ascension-estimate-value' });
  const provisional = h('span', { class: 'cp-ascension-provisional' });
  const estimate = h(
    'p',
    { class: 'cp-ascension-estimate', attrs: { 'data-provisional': 'true' } },
    estimateLabel,
    estimateValue,
    provisional,
  );

  const resetsTitle = h('dt');
  const resetsList = h('dd');
  const keepsTitle = h('dt');
  const keepsList = h('dd');
  const ledger = h(
    'dl',
    { class: 'cp-ascension-ledger' },
    h('div', { class: 'cp-ascension-resets' }, resetsTitle, resetsList),
    h('div', { class: 'cp-ascension-keeps' }, keepsTitle, keepsList),
  );
  const next = h('p', { class: 'cp-ascension-next' });

  const holdLabel = h('span');
  const holdButton = h(
    'button',
    {
      class: 'cp-buy cp-ascension-hold',
      attrs: { type: 'button', 'data-testid': 'ascension-hold' },
    },
    holdLabel,
  );
  const status = h('p', { class: 'cp-ascension-status', attrs: { 'aria-live': 'polite' } });

  const officeTitle = h('h3', { class: 'cp-ascension-office-title' });
  const officeSubtitle = h('p', { class: 'cp-ascension-office-subtitle' });
  const officeList = h('ul', { class: 'cp-ascension-office-list' });
  const office = h(
    'section',
    { class: 'cp-ascension-office', attrs: { 'data-testid': 'family-office' } },
    officeTitle,
    officeSubtitle,
    officeList,
  );

  const card = h(
    'div',
    { class: 'cp-ascension-card' },
    close,
    title,
    subtitle,
    dial,
    progressText,
    estimate,
    ledger,
    next,
    holdButton,
    status,
    office,
  );
  const root = h(
    'div',
    {
      class: 'cp-ascension',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'cp-ascension-title',
        'data-motion': reduced ? 'reduced' : 'full',
        'data-testid': 'ascension-screen',
      },
    },
    card,
  );

  ctx.own(loc.text(title, () => t('title')));
  ctx.own(loc.text(subtitle, () => t('subtitle', { venue: venueName(venueId) })));
  ctx.own(loc.attr(close, 'aria-label', () => t('close')));
  const renderProgress = () => {
    setRing(fill, progress.fraction);
    progressText.textContent =
      progress.bullion === null
        ? t('progressUnknown')
        : t('progress', { current: int(progress.bullion), target: int(progress.threshold) });
    estimate.hidden = progress.estimatedGoldBars === null;
    estimateValue.textContent = t('estimate', { amount: int(progress.estimatedGoldBars ?? 0) });
  };
  ctx.own(loc.bind(renderProgress));
  ctx.own(loc.text(estimateLabel, () => t('estimateLabel')));
  ctx.own(loc.text(provisional, () => t('provisional')));
  ctx.own(loc.text(resetsTitle, () => t('resets')));
  ctx.own(loc.text(resetsList, () => t('resetsList')));
  ctx.own(loc.text(keepsTitle, () => t('keeps')));
  ctx.own(loc.text(keepsList, () => t('keepsList')));
  ctx.own(
    loc.text(next, () =>
      progress.nextVenueId === null
        ? t('finalVenue')
        : t('next', { venue: venueName(progress.nextVenueId) }),
    ),
  );
  ctx.own(loc.text(officeTitle, () => t('familyOffice')));
  ctx.own(loc.text(officeSubtitle, () => t('familyOfficeSubtitle')));

  type HoldState = 'idle' | 'holding' | 'sending' | 'blocked';
  let state: HoldState = canRequestAscension(progress) ? 'idle' : 'blocked';
  let blockedHint = '';
  let heldMs = 0;
  let lastTick = 0;
  let stopHold: (() => void) | null = null;
  let closed = false;

  const renderHold = () => {
    holdButton.setAttribute(
      'aria-disabled',
      state === 'idle' || state === 'holding' ? 'false' : 'true',
    );
    holdButton.dataset.state = state;
    holdLabel.textContent =
      state === 'holding' ? t('holding') : state === 'sending' ? t('sending') : t('hold');
    if (state === 'blocked' && status.textContent === '') {
      blockedHint = t('notReadyHint', {
        venue: venueName(venueId),
        target: int(progress.threshold),
      });
      status.textContent = blockedHint;
    }
  };
  ctx.own(loc.bind(renderHold));

  const say = (message: string) => {
    status.textContent = message;
    restartAnimation(status, 'is-new');
  };

  const send = async () => {
    state = 'sending';
    renderHold();
    play(HOLD_DONE_SOUND);
    feedback(ctx, 'confirm');
    root.classList.add('is-sending');
    const outcome = await controller.ascend(venueId);
    if (closed) return;
    root.classList.remove('is-sending');
    if (outcome.ok) {
      options.onConfirmed(outcome.response);
      return;
    }
    if (outcome.reason === 'error') options.onError?.(outcome.error);
    say(ui.i18n.t(rejectionKey(outcome.reason)));
    feedback(ctx, 'deny');
    restartAnimation(holdButton, 'is-denied');
    state = outcome.reason === 'notReady' || outcome.reason === 'locked' ? 'blocked' : 'idle';
    heldMs = 0;
    setRing(hold, 0);
    renderHold();
    if (outcome.reason === 'stale') options.refresh?.();
  };

  const endHold = () => {
    stopHold?.();
    stopHold = null;
    if (state !== 'holding') return;
    state = 'idle';
    heldMs = 0;
    lastTick = 0;
    setRing(hold, 0);
    root.classList.remove('is-holding');
    renderHold();
  };

  const beginHold = () => {
    if (state !== 'idle') {
      if (state === 'blocked') {
        feedback(ctx, 'deny');
        restartAnimation(holdButton, 'is-denied');
      }
      return;
    }
    state = 'holding';
    heldMs = 0;
    lastTick = 0;
    root.classList.add('is-holding');
    renderHold();
    stopHold = schedule((dt) => {
      if (state !== 'holding') return false;
      heldMs += dt * 1000;
      const fraction = holdFraction(heldMs);
      setRing(hold, fraction);
      const tick = holdTick(fraction);
      if (tick > lastTick) {
        lastTick = tick;
        play({ ...HOLD_TICK_SOUND, velocity: HOLD_TICK_SOUND.velocity + tick * 0.12 });
        feedback(ctx, 'tick');
      }
      if (fraction >= 1) {
        stopHold = null;
        root.classList.remove('is-holding');
        void send();
        return false;
      }
      return true;
    });
  };

  ctx.own(
    listen(holdButton, 'pointerdown', (event) => {
      event.preventDefault();
      holdButton.setPointerCapture(event.pointerId);
      feedback(ctx, 'tap');
      beginHold();
    }),
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    ctx.own(listen(holdButton, type, endHold));
  }
  ctx.own(
    listen(holdButton, 'keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (event.repeat) return;
      feedback(ctx, 'tap');
      beginHold();
    }),
  );
  ctx.own(
    listen(holdButton, 'keyup', (event) => {
      if (event.key === 'Enter' || event.key === ' ') endHold();
    }),
  );
  ctx.own(listen(holdButton, 'blur', endHold));

  const rows = new Map<string, { item: HTMLElement; render: (row: FamilyOfficeRow) => void }>();
  const buildRow = (lineId: string) => {
    const name = h('span', { class: 'cp-ascension-office-name' });
    const level = h('span', { class: 'cp-ascension-office-level' });
    const price = h('span', { class: 'cp-ascension-office-price' });
    const buy = h(
      'button',
      {
        class: 'cp-buy cp-ascension-office-buy',
        attrs: { type: 'button', 'data-testid': `family-office-buy-${lineId}` },
      },
      icon('goldBar'),
      price,
    );
    const item = h(
      'li',
      { class: 'cp-ascension-office-row', attrs: { 'data-line': lineId } },
      h('span', { class: 'cp-ascension-office-text' }, name, level),
      buy,
    );
    let current: FamilyOfficeRow | null = null;
    let pending = false;
    const render = (row: FamilyOfficeRow) => {
      current = row;
      name.textContent = ui.i18n.t(lineNameKey(lineId));
      level.textContent = row.maxed ? t('maxed') : t('level', { level: int(row.level) });
      price.textContent =
        row.cost === null ? t('maxed') : formatBalance(row.cost, ui.i18n.language);
      buy.setAttribute(
        'aria-disabled',
        !row.maxed && row.affordable && !pending ? 'false' : 'true',
      );
      buy.setAttribute(
        'aria-label',
        row.cost === null
          ? `${name.textContent} ${t('maxed')}`
          : t('buyLabel', {
              level: int(row.level + 1),
              line: name.textContent,
              price: int(row.cost),
            }),
      );
      item.dataset.maxed = String(row.maxed);
    };
    makePressable(buy, ctx, {
      feedback: 'tap',
      onPress: () => {
        if (current === null || current.maxed || pending) return;
        pending = true;
        item.classList.add('is-pending');
        const level = current.level + 1;
        void controller.buyFamilyOffice(venueId, lineId, level).then((outcome) => {
          pending = false;
          if (closed) return;
          item.classList.remove('is-pending');
          if (outcome.ok) {
            ui.setWallet(outcome.response.wallet);
            levels = { ...levels, [lineId]: outcome.response.level };
            PURCHASE_CHIME.forEach(play);
            feedback(ctx, 'confirm');
            restartAnimation(item, 'is-purchased');
            say(
              t('purchased', {
                line: ui.i18n.t(lineNameKey(lineId)),
                level: int(outcome.response.level),
              }),
            );
          } else {
            if (outcome.reason === 'error') options.onError?.(outcome.error);
            feedback(ctx, 'deny');
            restartAnimation(item, 'is-denied');
            say(ui.i18n.t(rejectionKey(outcome.reason)));
            if (outcome.reason === 'stale') options.refresh?.();
          }
          renderOffice();
        });
        renderOffice();
      },
    });
    rows.set(lineId, { item, render });
    officeList.append(item);
  };

  let levels: Readonly<Record<string, number>> = ui.store.getState().upgradeLevels;
  const renderOffice = () => {
    for (const row of familyOfficeRows(levels, ui.store.getState().goldBars)) {
      if (!rows.has(row.lineId)) buildRow(row.lineId);
      rows.get(row.lineId)?.render(row);
    }
  };
  ctx.own(loc.bind(renderOffice));
  ctx.own(
    ui.store.subscribe((next, previous) => {
      if (next.upgradeLevels !== previous.upgradeLevels) levels = next.upgradeLevels;
      if (next.goldBars !== previous.goldBars || next.upgradeLevels !== previous.upgradeLevels) {
        renderOffice();
      }
    }),
  );

  const requestClose = () => {
    if (state === 'sending') return;
    options.onClose();
  };
  makePressable(close, ctx, { feedback: 'close', onPress: requestClose });
  ctx.own(
    listen(root, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      }
    }),
  );

  const setBullion = (bullion: number | null) => {
    if (closed) return;
    const wasReady = progress.ready === true;
    progress = ascensionProgress(venueId, bullion);
    renderProgress();
    if (state === 'idle' || state === 'blocked') {
      state = canRequestAscension(progress) ? 'idle' : 'blocked';
      if (state === 'idle' && status.textContent === blockedHint) status.textContent = '';
      renderHold();
    }
    if (!reduced && !wasReady && progress.ready === true) restartAnimation(dial, 'is-ready');
  };

  options.host.append(root);
  feedback(ctx, 'open');
  root.tabIndex = -1;
  root.focus({ preventScroll: true });
  if (!reduced && progress.ready === true) restartAnimation(dial, 'is-ready');

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    closed = true;
    stopHold?.();
    for (const off of disposers.splice(0)) off();
    loc.dispose();
    root.remove();
  }

  return { el: root, setBullion, dispose };
}
