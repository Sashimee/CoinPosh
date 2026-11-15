import './upgrades.css';
import { upgradeLines, type UpgradeLineDef } from '@coinposh/economy';
import { browserVibrate, type HapticPattern } from '../../app/feedback.ts';
import {
  spendableCoins,
  upgradeRow,
  type StatFormat,
  type UpgradeRow,
  type Wallet,
} from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import {
  formatBalance,
  formatDecimal,
  formatInteger,
  formatPrice,
  type InterpolationValues,
  type Language,
} from '../../i18n/index.ts';
import { feedback, tr, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { Odometer } from '../components/odometer.ts';
import { makePressable } from '../components/pressable.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';

const LEVEL_UP_GLOW = 1.2;
/** The medallion is squashed to this and released on the pop spring, which overshoots to ~1.3. */
const MEDAL_SQUASH = 0.62;
const MEDAL_TILT_DEG = 36;

type Celebration = (haptic: HapticPattern) => void;
const celebrations = new Map<string, Set<Celebration>>();

/**
 * Celebrates a server-confirmed level on every mounted row of `lineId`: medallion spring,
 * gold glint, a pop of the new effect and a haptic. A UI with no upgrades panel has nothing
 * to light, so it stays silent.
 */
export function celebrateUpgradeLine(lineId: string, haptic: HapticPattern): void {
  for (const celebrate of celebrations.get(lineId) ?? []) celebrate(haptic);
}

function register(lineId: string, celebrate: Celebration): () => void {
  let rows = celebrations.get(lineId);
  if (!rows) {
    rows = new Set();
    celebrations.set(lineId, rows);
  }
  rows.add(celebrate);
  return () => {
    rows.delete(celebrate);
    if (rows.size === 0) celebrations.delete(lineId);
  };
}

type Translate = (key: string, values?: InterpolationValues) => string;

function formatStat(t: Translate, format: StatFormat, value: number, language: Language): string {
  if (format === 'multiplier') {
    return t('upgrades.effect.multiplier', { value: formatDecimal(value, language) });
  }
  if (format === 'hours') {
    return t('upgrades.effect.hours', { value: formatDecimal(value, language) });
  }
  return t('upgrades.effect.count', { value: formatInteger(Math.round(value), language) });
}

export interface UpgradeRowCopy {
  /** The stat line: the current effect, then the next level's when there is one. */
  readonly effect: string;
  readonly level: string;
  readonly buyLabel: string;
  /** Empty once the line is maxed. */
  readonly price: string;
}

/** Every string a row shows that changes with its level or the pending purchase. */
export function upgradeRowCopy(
  t: Translate,
  view: UpgradeRow,
  language: Language,
  pending: boolean,
): UpgradeRowCopy {
  const current = formatStat(t, view.format, view.current, language);
  const effect =
    view.nextValue === null
      ? current
      : t('upgrades.effect.next', {
          current,
          next: formatStat(t, view.format, view.nextValue, language),
        });
  const level = t('upgrades.level', { level: view.level });
  if (view.maxed) return { effect, level, buyLabel: t('upgrades.maxed'), price: '' };
  return {
    effect,
    level,
    buyLabel: pending ? t('upgrades.pending') : t('upgrades.buy'),
    price: formatPrice(view.cost ?? 0, language),
  };
}

/** What a row's next level costs beyond what the wallet can spend; null once it is in reach. */
export function upgradeShortfall(view: UpgradeRow, wallet: Wallet): number | null {
  if (view.maxed || view.affordable || view.cost === null) return null;
  const spendable = view.line.currency === 'coins' ? spendableCoins(wallet) : wallet.goldBars;
  return view.cost - spendable;
}

export interface ShortfallCopy {
  /** Short enough for the buy button's label line: "22 more". */
  readonly label: string;
  /** The full sentence a screen reader hears, currency and plural included. */
  readonly spoken: string;
}

export function shortfallCopy(
  t: Translate,
  shortfall: number,
  currency: UpgradeLineDef['currency'],
  language: Language,
): ShortfallCopy {
  const values = { count: shortfall, value: formatInteger(shortfall, language) };
  return {
    label: t('upgrades.shortfall', values),
    spoken: t(`upgrades.shortfallAria.${currency}`, values),
  };
}

export interface BalanceCopy {
  /** The chip's readout, in the same notation as the Vault plaque. */
  readonly amount: string;
  readonly spoken: string;
}

export function balanceCopy(t: Translate, coins: number, language: Language): BalanceCopy {
  return {
    amount: formatBalance(coins, language),
    spoken: t('upgrades.balance.aria', {
      count: coins,
      value: formatInteger(coins, language),
    }),
  };
}

/** How far the chip dips when a purchase leaves the wallet, released on the pop spring. */
const CHIP_SPEND_DIP = 0.9;
/** Matches the `cp-upgrades-spend` keyframes, so the "−37" leaves the chip before it is reused. */
export const SPEND_TICK_MS = 1100;

/**
 * The sheet's own purse: what the server says the wallet can spend, as the rows are priced
 * against it. It never guesses a purchase's cost: a buy counts down only once the server's
 * wallet arrives, so the figure is always the one the server reported.
 */
function createBalanceChip(ctx: UiContext): HTMLElement {
  const odometer = new Odometer();
  const label = h('span', { class: 'cp-upgrades-purse-label', attrs: { 'aria-hidden': 'true' } });
  const spent = h('span', { class: 'cp-upgrades-spent', attrs: { 'aria-hidden': 'true' } });
  const chip = h(
    'span',
    { class: 'cp-chip cp-upgrades-chip', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-upgrades-sheen' }, h('span', { class: 'cp-glint' })),
    icon('coin'),
    odometer.el,
    spent,
  );
  const spoken = h('span', {
    class: 'cp-sr-only',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const purse = h(
    'div',
    { class: 'cp-upgrades-purse', attrs: { 'data-testid': 'upgrades-balance' } },
    label,
    chip,
    spoken,
  );
  ctx.loc.text(label, () => tr(ctx, 'upgrades.balance.label'));

  const dip = new SpringValue(1, SPRINGS.pop, (value) => {
    chip.style.scale = value === 1 ? '' : String(value);
  });
  let shown: number | null = null;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTick = (): void => {
    if (tickTimer !== null) clearTimeout(tickTimer);
    tickTimer = null;
    purse.classList.remove('is-spending');
  };
  ctx.own(clearTick);

  const tick = (amount: number): void => {
    const calm = isReducedMotion();
    spent.textContent = tr(ctx, 'upgrades.balance.spent', {
      value: formatInteger(amount, ctx.i18n.language),
    });
    purse.classList.toggle('is-calm', calm);
    clearTick();
    restartAnimation(purse, 'is-spending');
    tickTimer = setTimeout(clearTick, SPEND_TICK_MS);
    feedback(ctx, 'tick');
    if (calm) return;
    dip.jump(CHIP_SPEND_DIP);
    void dip.to(1);
  };

  const show = (coins: number): void => {
    const state = ctx.store.getState();
    const copy = balanceCopy((key, values) => tr(ctx, key, values), coins, ctx.i18n.language);
    const live = state.panel === 'upgrades' && shown !== null && !isReducedMotion();
    if (!live || shown === null) odometer.jump(copy.amount);
    else if (coins !== shown) odometer.set(copy.amount, coins > shown ? 1 : -1);
    const spend = state.panel === 'upgrades' && state.pendingUpgrade !== null;
    if (shown !== null && coins < shown && spend) tick(shown - coins);
    shown = coins;
    purse.dataset.value = String(coins);
    if (spoken.textContent !== copy.spoken) spoken.textContent = copy.spoken;
  };

  ctx.own(
    watch(
      ctx.store,
      (s) => spendableCoins(s),
      (coins) => {
        show(coins);
      },
    ),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => s.pendingUpgrade !== null,
      (pending) => {
        purse.classList.toggle('is-pending', pending);
      },
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      if (shown === null) return;
      const copy = balanceCopy((key, values) => tr(ctx, key, values), shown, ctx.i18n.language);
      odometer.jump(copy.amount);
      spoken.textContent = copy.spoken;
    }),
  );
  return purse;
}

/** How far a button part shrinks to sit whole inside the fixed buy column; never enlarges. */
export function fitScale(natural: number, available: number): number {
  if (!(natural > 0) || !(available > 0)) return 1;
  return Math.min(1, available / natural);
}

function fitWithin(button: HTMLElement, parts: readonly HTMLElement[]): void {
  const style = getComputedStyle(button);
  const available =
    button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  for (const part of parts) {
    const fit = fitScale(part.offsetWidth, available);
    part.style.scale = fit === 1 ? '' : String(fit);
  }
}

function sameRow(a: UpgradeRow, b: UpgradeRow): boolean {
  return a.level === b.level && a.affordable === b.affordable && a.cost === b.cost;
}

function createUpgradeRow(ctx: UiContext, line: UpgradeLineDef): HTMLElement {
  const name = h('span', { class: 'cp-upgrade-name' });
  const description = h('span', { class: 'cp-upgrade-desc' });
  const effect = h('span', { class: 'cp-upgrade-effect' });
  const levelText = h('span', { class: 'cp-upgrade-level' });
  const levelBar = h(
    'span',
    { class: 'cp-level-bar', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-level-fill' }),
  );
  const pipBar = h('span', { class: 'cp-upgrade-progress' }, levelText, levelBar);
  const price = h('span', { class: 'cp-buy-price' });
  const buyLabel = h('span', { class: 'cp-buy-label' });
  const currencyIcon = icon(line.currency === 'coins' ? 'coin' : 'goldBar');
  const costBox = h('span', { class: 'cp-buy-cost' }, currencyIcon, price);
  const buy = h(
    'button',
    {
      class: 'cp-buy',
      attrs: { type: 'button', 'data-testid': `upgrade-buy-${line.id}` },
    },
    buyLabel,
    costBox,
  );
  const medallion = h('span', { class: 'cp-medallion', attrs: { 'aria-hidden': 'true' } });
  const effectPop = h('span', { class: 'cp-upgrade-pop', attrs: { 'aria-hidden': 'true' } });
  const sheen = h(
    'span',
    { class: 'cp-upgrade-sheen', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-glint cp-upgrade-glint' }),
  );
  const row = h(
    'li',
    {
      class: 'cp-upgrade',
      attrs: { 'data-testid': `upgrade-${line.id}`, 'data-line': line.id },
    },
    medallion,
    h(
      'span',
      { class: 'cp-upgrade-text' },
      name,
      description,
      h('span', { class: 'cp-upgrade-meta' }, effect, pipBar),
    ),
    buy,
    sheen,
    effectPop,
  );

  const glow = new SpringValue(0, SPRINGS.gentle, (value) => {
    row.style.setProperty('--cp-glow', String(Math.max(0, value)));
  });
  const medal = new SpringValue(1, SPRINGS.pop, (value) => {
    medallion.style.scale = value === 1 ? '' : String(value);
    medallion.style.rotate = value === 1 ? '' : `${(value - 1) * MEDAL_TILT_DEG}deg`;
  });
  const vibrate = browserVibrate();
  const fitBuy = (): void => {
    fitWithin(buy, [buyLabel, costBox]);
  };
  const buyResizes = new ResizeObserver(fitBuy);
  buyResizes.observe(buy);
  document.fonts.addEventListener('loadingdone', fitBuy);
  ctx.own(() => {
    buyResizes.disconnect();
    document.fonts.removeEventListener('loadingdone', fitBuy);
  });

  const current = (): UpgradeRow => {
    const state = ctx.store.getState();
    return upgradeRow(line, state.upgradeLevels[line.id] ?? 0, state);
  };

  const paint = (view: UpgradeRow): void => {
    const language = ctx.i18n.language;
    const state = ctx.store.getState();
    const pending = state.pendingUpgrade === line.id;
    const lineName = tr(ctx, `upgrades.line.${line.id}.name`);
    name.textContent = lineName;
    description.textContent = tr(ctx, `upgrades.line.${line.id}.description`);
    const copy = upgradeRowCopy((key, values) => tr(ctx, key, values), view, language, pending);
    effect.textContent = copy.effect;
    levelText.textContent = copy.level;
    pipBar.setAttribute(
      'aria-label',
      tr(ctx, 'upgrades.levelAria', { level: view.level, max: line.maxLevel }),
    );
    pipBar.setAttribute('role', 'img');
    levelBar.style.setProperty('--cp-level', String(view.level / line.maxLevel));
    medallion.replaceChildren(
      icon(view.maxed ? 'laurel' : line.scope === 'venue' ? 'upgrades' : 'goldBar'),
    );

    const shortfall = upgradeShortfall(view, state);
    const short =
      shortfall === null
        ? null
        : shortfallCopy((key, values) => tr(ctx, key, values), shortfall, line.currency, language);

    row.classList.toggle('is-maxed', view.maxed);
    row.classList.toggle('is-affordable', view.affordable);
    row.classList.toggle('is-pending', pending);
    buy.classList.toggle('is-pending', pending);
    buy.classList.toggle('is-short', short !== null);
    const disabled = view.maxed || !view.affordable || state.pendingUpgrade !== null;
    buy.setAttribute('aria-disabled', String(disabled));
    buyLabel.textContent = short?.label ?? copy.buyLabel;
    price.textContent = copy.price;
    if (view.maxed) {
      currencyIcon.setAttribute('hidden', '');
      buy.setAttribute('aria-label', `${lineName}: ${tr(ctx, 'upgrades.maxed')}`);
      fitBuy();
      return;
    }
    currencyIcon.removeAttribute('hidden');
    fitBuy();
    const cost = view.cost ?? 0;
    const costWords = tr(ctx, `currency.${line.currency}`, {
      count: cost,
      value: formatInteger(cost, language),
    });
    const label = tr(ctx, 'upgrades.buyAria', {
      name: lineName,
      level: view.level + 1,
      cost: costWords,
    });
    buy.setAttribute(
      'aria-label',
      short === null || pending
        ? label
        : `${label}. ${tr(ctx, 'upgrades.cannotAfford')}. ${short.spoken}`,
    );
  };

  makePressable(buy, ctx, {
    feedback: 'confirm',
    onPress() {
      const view = current();
      if (view.maxed || !view.affordable || ctx.store.getState().pendingUpgrade !== null) return;
      ctx.store.setState({ pendingUpgrade: line.id });
      ctx.bus.emit('upgrades:request', { lineId: line.id, fromLevel: view.level });
    },
  });

  ctx.own(
    register(line.id, (haptic) => {
      const view = current();
      effectPop.textContent = formatStat(
        (key, values) => tr(ctx, key, values),
        view.format,
        view.current,
        ctx.i18n.language,
      );
      if (ctx.store.getState().settings.haptics) vibrate?.(haptic);
      const calm = isReducedMotion();
      row.classList.toggle('is-calm', calm);
      restartAnimation(row, 'is-celebrating');
      if (calm) return;
      glow.jump(LEVEL_UP_GLOW);
      void glow.to(0);
      medal.jump(MEDAL_SQUASH);
      void medal.to(1);
    }),
  );
  ctx.own(
    watch(
      ctx.store,
      () => current(),
      (view) => {
        paint(view);
      },
      sameRow,
    ),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => s.pendingUpgrade,
      () => {
        paint(current());
      },
    ),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => upgradeShortfall(current(), s),
      () => {
        paint(current());
      },
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      paint(current());
    }),
  );
  return row;
}

function createSection(
  ctx: UiContext,
  id: string,
  titleKey: string,
  hintKey: string | null,
  lines: readonly UpgradeLineDef[],
): HTMLElement {
  const titleId = `cp-upgrades-${id}`;
  const title = h('h3', { class: 'cp-section-title', attrs: { id: titleId } });
  ctx.loc.text(title, () => tr(ctx, titleKey));
  const hint = hintKey ? h('p', { class: 'cp-section-hint' }) : null;
  if (hint && hintKey) ctx.loc.text(hint, () => tr(ctx, hintKey));
  const list = h('ul', { class: 'cp-upgrade-list', attrs: { 'aria-labelledby': titleId } });
  for (const line of lines) list.append(createUpgradeRow(ctx, line));
  return h(
    'section',
    { class: 'cp-section', attrs: { 'data-testid': `upgrades-${id}` } },
    title,
    hint,
    list,
  );
}

export interface UpgradeSheetSection {
  readonly id: string;
  readonly titleKey: string;
  readonly hintKey: string | null;
  readonly lines: readonly UpgradeLineDef[];
}

/** Family Office lines are bought on the ascension screen, so the sheet lists venue lines only. */
export const UPGRADE_SHEET_SECTIONS: readonly UpgradeSheetSection[] = [
  {
    id: 'venue',
    titleKey: 'upgrades.venueSection',
    hintKey: null,
    lines: upgradeLines.filter((line) => line.scope === 'venue'),
  },
];

export const UPGRADE_SHEET_LINES: readonly UpgradeLineDef[] = UPGRADE_SHEET_SECTIONS.flatMap(
  (section) => section.lines,
);

export function createUpgradesPanel(ctx: UiContext): HTMLElement {
  return h(
    'div',
    { class: 'cp-upgrades' },
    createBalanceChip(ctx),
    ...UPGRADE_SHEET_SECTIONS.map((section) =>
      createSection(ctx, section.id, section.titleKey, section.hintKey, section.lines),
    ),
  );
}

/** Space left above a revealed row, so its section title and the row before it stay in view. */
const REVEAL_HEADROOM = 56;
const SPOTLIGHT_GLOW = 1.4;
/** Matches the `cp-spotlight` keyframes; reduced motion holds the static ring this long. */
const SPOTLIGHT_MS = 1800;

/**
 * Glides the sheet body to one line and lights it, for a hint that points at that line. Any
 * touch or wheel on the sheet hands scrolling straight back to the player.
 */
export function revealUpgradeLine(panel: HTMLElement, lineId: string): void {
  const row = panel.querySelector<HTMLElement>(`.cp-upgrade[data-line="${CSS.escape(lineId)}"]`);
  const body = row?.closest<HTMLElement>('.cp-sheet-body');
  if (!row || !body) throw new Error(`revealUpgradeLine: no upgrade row for line "${lineId}"`);
  const bodyRect = body.getBoundingClientRect();
  const scale = body.offsetHeight > 0 ? bodyRect.height / body.offsetHeight : 1;
  const rowTop = (row.getBoundingClientRect().top - bodyRect.top) / (scale || 1) + body.scrollTop;
  // The purse stays stuck over the top of the body, so a row is only in view below it.
  const covered = panel.querySelector<HTMLElement>('.cp-upgrades-purse')?.offsetHeight ?? 0;
  const headroom = REVEAL_HEADROOM + covered;
  const fits = row.offsetHeight + headroom <= body.clientHeight;
  const target = Math.max(
    0,
    Math.min(body.scrollHeight - body.clientHeight, rowTop - (fits ? headroom : covered)),
  );
  const scroll = new SpringValue(body.scrollTop, SPRINGS.sheet, (value) => {
    body.scrollTop = value;
  });
  const release: (() => void)[] = [];
  const handBack = (): void => {
    scroll.stop();
    for (const off of release.splice(0)) off();
  };
  release.push(
    listen(body, 'pointerdown', handBack, { passive: true }),
    listen(body, 'wheel', handBack, { passive: true }),
  );
  void scroll.to(target).then(handBack);

  const glow = new SpringValue(SPOTLIGHT_GLOW, SPRINGS.gentle, (value) => {
    row.style.setProperty('--cp-glow', String(Math.max(0, value)));
  });
  void glow.to(0);
  restartAnimation(row, 'is-spotlit');
  setTimeout(() => {
    row.classList.remove('is-spotlit');
  }, SPOTLIGHT_MS);
}
