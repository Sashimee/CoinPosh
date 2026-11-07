import { upgradeLines, type UpgradeLineDef } from '../../app/economy.ts';
import { upgradeRow, type StatFormat, type UpgradeRow } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal, formatInteger, formatPrice, type Language } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { makePressable } from '../components/pressable.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';

const LEVEL_UP_GLOW = 1.2;

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
  );

  const glow = new SpringValue(0, SPRINGS.gentle, (value) => {
    row.style.setProperty('--cp-glow', String(Math.max(0, value)));
  });

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
    watch(
      ctx.store,
      () => current(),
      (view, previous) => {
        if (previous && view.level > previous.level) {
          glow.jump(LEVEL_UP_GLOW);
          void glow.to(0);
          restartAnimation(row, 'is-levelled');
        }
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
