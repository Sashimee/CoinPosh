import { upgradeLines, type UpgradeLineDef } from '@coinposh/economy';
import { browserVibrate, type HapticPattern } from '../../app/feedback.ts';
import { upgradeRow, type StatFormat, type UpgradeRow } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal, formatInteger, formatPrice, type Language } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
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

function formatStat(ctx: UiContext, format: StatFormat, value: number, language: Language): string {
  if (format === 'multiplier') {
    return tr(ctx, 'upgrades.effect.multiplier', { value: formatDecimal(value, language) });
  }
  if (format === 'hours') {
    return tr(ctx, 'upgrades.effect.hours', { value: formatDecimal(value, language) });
  }
  return tr(ctx, 'upgrades.effect.count', { value: formatInteger(Math.round(value), language) });
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
  const buy = h(
    'button',
    {
      class: 'cp-buy',
      attrs: { type: 'button', 'data-testid': `upgrade-buy-${line.id}` },
    },
    buyLabel,
    h('span', { class: 'cp-buy-cost' }, currencyIcon, price),
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

  const current = (): UpgradeRow => {
    const state = ctx.store.getState();
    return upgradeRow(line, state.upgradeLevels[line.id] ?? 0, {
      coins: state.coins,
      goldBars: state.goldBars,
    });
  };

  const paint = (view: UpgradeRow): void => {
    const language = ctx.i18n.language;
    const state = ctx.store.getState();
    const pending = state.pendingUpgrade === line.id;
    const lineName = tr(ctx, `upgrades.line.${line.id}.name`);
    name.textContent = lineName;
    description.textContent = tr(ctx, `upgrades.line.${line.id}.description`);
    const currentText = formatStat(ctx, view.format, view.current, language);
    effect.textContent =
      view.nextValue === null
        ? currentText
        : tr(ctx, 'upgrades.effect.next', {
            current: currentText,
            next: formatStat(ctx, view.format, view.nextValue, language),
          });
    levelText.textContent = tr(ctx, 'upgrades.level', { level: view.level });
    pipBar.setAttribute(
      'aria-label',
      tr(ctx, 'upgrades.levelAria', { level: view.level, max: line.maxLevel }),
    );
    pipBar.setAttribute('role', 'img');
    levelBar.style.setProperty('--cp-level', String(view.level / line.maxLevel));
    medallion.replaceChildren(
      icon(view.maxed ? 'laurel' : line.scope === 'venue' ? 'upgrades' : 'goldBar'),
    );

    row.classList.toggle('is-maxed', view.maxed);
    row.classList.toggle('is-affordable', view.affordable);
    row.classList.toggle('is-pending', pending);
    buy.classList.toggle('is-pending', pending);
    const disabled = view.maxed || !view.affordable || state.pendingUpgrade !== null;
    buy.setAttribute('aria-disabled', String(disabled));
    if (view.maxed) {
      buyLabel.textContent = tr(ctx, 'upgrades.maxed');
      price.textContent = '';
      currencyIcon.setAttribute('hidden', '');
      buy.setAttribute('aria-label', `${lineName}: ${tr(ctx, 'upgrades.maxed')}`);
      return;
    }
    currencyIcon.removeAttribute('hidden');
    const cost = view.cost ?? 0;
    const costText = formatPrice(cost, language);
    price.textContent = costText;
    buyLabel.textContent = pending ? tr(ctx, 'upgrades.pending') : tr(ctx, 'upgrades.buy');
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
      view.affordable || pending ? label : `${label}. ${tr(ctx, 'upgrades.cannotAfford')}`,
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
      effectPop.textContent = formatStat(ctx, view.format, view.current, ctx.i18n.language);
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

export function createUpgradesPanel(ctx: UiContext): HTMLElement {
  return h(
    'div',
    { class: 'cp-upgrades' },
    createSection(
      ctx,
      'venue',
      'upgrades.venueSection',
      null,
      upgradeLines.filter((line) => line.scope === 'venue'),
    ),
    createSection(
      ctx,
      'global',
      'upgrades.globalSection',
      'upgrades.globalHint',
      upgradeLines.filter((line) => line.scope === 'global'),
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
  const fits = row.offsetHeight + REVEAL_HEADROOM <= body.clientHeight;
  const target = Math.max(
    0,
    Math.min(body.scrollHeight - body.clientHeight, fits ? rowTop - REVEAL_HEADROOM : rowTop),
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
