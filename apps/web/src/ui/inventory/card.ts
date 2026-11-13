import type { Rarity } from '@coinposh/shared';
import type { I18n } from '../../i18n/index.ts';
import { cratesKey } from '../../game/crates/i18n.ts';
import { albumPlace } from '../../game/crates/loot.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import { makePressable } from '../components/pressable.ts';
import { Odometer } from '../components/odometer.ts';
import type { UiContext } from '../context.ts';
import { h, restartAnimation } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import type { CardArt } from './art.ts';
import { inventoryKey } from './i18n.ts';
import type { CuePlan } from './juice.ts';
import { fuseProgress, type ItemStack } from './model.ts';

const FLIP_SQUASH = 0.07;
const POP_KICK = 3.2;

export function itemName(i18n: I18n, stack: Pick<ItemStack, 'kind' | 'type'>): string {
  switch (stack.kind) {
    case 'charm':
      return i18n.t(cratesKey(`item.${albumPlace(stack.type).item}`));
    case 'safe':
      return i18n.t(cratesKey('safe'));
    case 'scratchCard':
      return i18n.t(cratesKey('scratchCard'));
  }
}

export function rarityName(i18n: I18n, rarity: Rarity): string {
  return i18n.t(cratesKey(`chip.${rarity}`));
}

/** The frame colours as CSS custom properties; heirloom borrows the prism for its border. */
export function rarityStyle(rarity: Rarity | null): string {
  const accent = RARITY_COLORS[rarity ?? 'common'];
  const prism = HEIRLOOM_PRISM.join(', ');
  return `--cp-inv-accent: ${accent}; --cp-inv-prism: ${prism}`;
}

export interface CardOptions {
  readonly duplicatesPerLevel: number | null;
  readonly canFuse: boolean;
  readonly onTurn: (card: ItemCard, toBack: boolean) => void;
  readonly onFuse: (card: ItemCard) => void;
}

/**
 * One grid card: a rarity-framed front with the offscreen-rendered hero, and a back with the
 * details and the duplicate fuse. It turns over on a spring that squashes mid-flip.
 */
export class ItemCard {
  readonly el: HTMLLIElement;
  private readonly disposers: (() => void)[] = [];
  private readonly ctx: UiContext;
  private readonly card: HTMLElement;
  private readonly flipper: HTMLElement;
  private readonly front: HTMLButtonElement;
  private readonly back: HTMLElement;
  private readonly sprite: HTMLElement;
  private readonly levelOdometer = new Odometer();
  private readonly backLevel = new Odometer();
  private readonly copies: HTMLElement;
  private readonly ribbon: HTMLElement;
  private readonly duplicates: HTMLElement;
  private readonly fuseNote: HTMLElement;
  private readonly fuseButton: HTMLButtonElement;
  private readonly pips: HTMLElement;
  private readonly texts: readonly (readonly [Element, () => string])[];
  private readonly angle: SpringValue;
  private readonly pop: SpringValue;
  private turned = false;
  private busy = false;
  private options: CardOptions;

  constructor(
    ctx: UiContext,
    private current: ItemStack,
    options: CardOptions,
  ) {
    this.options = options;
    this.ctx = { ...ctx, own: (dispose) => this.disposers.push(dispose) };
    const { i18n } = ctx;
    const name = (): string => itemName(i18n, this.current);
    const rarity = this.current.rarity;

    this.sprite = h('span', { class: 'cp-inv-sprite', attrs: { 'aria-hidden': 'true' } });
    this.copies = h('span', { class: 'cp-inv-copies' });
    this.ribbon = h('span', { class: 'cp-inv-ribbon' });
    const nameplate = h('span', { class: 'cp-inv-name' });
    const rarityLine = h('span', { class: 'cp-inv-rarity' });
    const levelShort = h('span', { class: 'cp-inv-level-label' });
    this.front = h(
      'button',
      { class: 'cp-inv-face cp-inv-front', attrs: { type: 'button' } },
      h('span', { class: 'cp-inv-frame', attrs: { 'aria-hidden': 'true' } }),
      h(
        'span',
        { class: 'cp-inv-art', attrs: { 'aria-hidden': 'true' } },
        h('span', { class: 'cp-inv-medal' }),
        h('span', { class: 'cp-inv-sprite-window' }, this.sprite),
      ),
      h('span', { class: 'cp-inv-level' }, levelShort, this.levelOdometer.el),
      this.copies,
      this.ribbon,
      h('span', { class: 'cp-inv-plate' }, nameplate, rarityLine),
    );

    const backName = h('h3', { class: 'cp-inv-back-name' });
    const backRarity = h('p', { class: 'cp-inv-back-rarity' });
    const backLevelLabel = h('span', { class: 'cp-inv-back-level-label' });
    const setLine = h('p', { class: 'cp-inv-back-set' });
    const about = h('p', { class: 'cp-inv-back-about' });
    this.duplicates = h('p', { class: 'cp-inv-back-dupes' });
    this.pips = h('span', { class: 'cp-inv-pips', attrs: { 'aria-hidden': 'true' } });
    this.fuseNote = h('p', { class: 'cp-inv-back-note' });
    this.fuseButton = h('button', {
      class: 'cp-buy cp-inv-fuse',
      attrs: { type: 'button', 'data-testid': 'inventory-fuse' },
    });
    const turnBack = h('button', {
      class: 'cp-inv-turn-back',
      attrs: { type: 'button' },
    });
    this.back = h(
      'div',
      { class: 'cp-inv-face cp-inv-back', attrs: { inert: '' } },
      h('span', { class: 'cp-inv-frame', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'cp-inv-back-body' },
        backName,
        backRarity,
        h('p', { class: 'cp-inv-back-level' }, backLevelLabel, this.backLevel.el),
        setLine,
        about,
        this.duplicates,
        this.pips,
        this.fuseNote,
      ),
      h('div', { class: 'cp-inv-back-actions' }, this.fuseButton, turnBack),
    );
    this.flipper = h('div', { class: 'cp-inv-flipper' }, this.front, this.back);
    this.card = h(
      'div',
      {
        class: 'cp-inv-card',
        attrs: {
          'data-kind': this.current.kind,
          'data-rarity': rarity ?? 'none',
          style: rarityStyle(rarity),
        },
      },
      this.flipper,
      h('span', { class: 'cp-inv-glint', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'cp-inv-flash', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'cp-inv-sparks', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'cp-inv-gain', attrs: { 'aria-hidden': 'true' } }),
    );
    this.el = h(
      'li',
      {
        class: 'cp-inv-cell',
        attrs: { 'data-key': this.current.key, 'data-testid': 'inventory-card' },
      },
      this.card,
    );

    const rarityText = (): string =>
      this.current.rarity === null ? '' : rarityName(i18n, this.current.rarity);
    this.texts = [
      [nameplate, name],
      [backName, name],
      [levelShort, () => i18n.t(inventoryKey('levelShort'))],
      [backLevelLabel, () => `${i18n.t(inventoryKey('levelShort'))} `],
      [turnBack, () => i18n.t(inventoryKey('turnBack'))],
      [about, () => i18n.t(inventoryKey(`about.${this.current.kind}`))],
      [rarityLine, rarityText],
      [backRarity, rarityText],
      [
        setLine,
        () =>
          this.current.kind === 'charm'
            ? i18n.t(inventoryKey('fromSet'), {
                set: i18n.t(cratesKey(`set.${albumPlace(this.current.type).set}`)),
              })
            : '',
      ],
    ];
    this.disposers.push(
      ctx.loc.bind(() => {
        this.repaint();
      }),
    );
    setLine.hidden = this.current.kind !== 'charm';

    this.angle = new SpringValue(0, SPRINGS.bouncy, (deg) => {
      const squash = Math.abs(Math.sin((deg * Math.PI) / 180)) * FLIP_SQUASH;
      this.flipper.style.transform =
        deg === 0 ? '' : `rotateY(${deg}deg) scale(${1 - squash}, ${1 + squash * 0.4})`;
    });
    this.pop = new SpringValue(0, SPRINGS.pop, (value) => {
      this.card.style.scale = value === 0 ? '' : `${1 + value * 0.08} ${1 - value * 0.05}`;
    });
    this.levelOdometer.jump(String(this.current.level));
    this.backLevel.jump(String(this.current.level));

    makePressable(this.front, this.ctx, {
      feedback: 'toggle',
      onPress: () => {
        options.onTurn(this, true);
      },
    });
    makePressable(turnBack, this.ctx, {
      feedback: 'toggle',
      onPress: () => {
        options.onTurn(this, false);
      },
    });
    makePressable(this.fuseButton, this.ctx, {
      feedback: 'tap',
      enabled: () => this.fusable(),
      onPress: () => {
        this.options.onFuse(this);
      },
    });
  }

  get stack(): ItemStack {
    return this.current;
  }

  get isTurned(): boolean {
    return this.turned;
  }

  update(stack: ItemStack, options: CardOptions): void {
    const rose = stack.level > this.current.level;
    this.current = stack;
    this.options = options;
    if (!rose) {
      this.levelOdometer.jump(String(stack.level));
      this.backLevel.jump(String(stack.level));
    }
    this.repaint();
  }

  private repaint(): void {
    for (const [el, render] of this.texts) {
      const next = render();
      if (el.textContent !== next) el.textContent = next;
    }
    this.paintCounts();
  }

  setArt(art: CardArt): void {
    this.sprite.style.backgroundImage = `url("${art.url}")`;
    this.sprite.style.setProperty('--cp-inv-frames', String(art.frames));
    this.card.classList.toggle('has-sway', art.frames > 1);
    this.card.classList.add('has-art');
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.paintCounts();
  }

  turn(toBack: boolean, plan: CuePlan | null): void {
    if (toBack === this.turned) return;
    this.turned = toBack;
    this.card.classList.toggle('is-turned', toBack);
    this.front.inert = toBack;
    this.back.inert = !toBack;
    this.front.setAttribute('aria-expanded', String(toBack));
    if (plan?.channels.includes('light')) restartAnimation(this.card, 'is-glinting');
    if (toBack) {
      this.backLevel.jump('0');
      this.backLevel.set(String(this.current.level), 1);
    }
    if (isReducedMotion()) {
      this.angle.jump(0);
      this.card.classList.add('is-reduced');
    } else {
      this.card.classList.remove('is-reduced');
      void this.angle.to(toBack ? 180 : 0, SPRINGS.bouncy);
    }
    (toBack ? this.back.querySelector<HTMLElement>('button:not([hidden])') : this.front)?.focus({
      preventScroll: true,
    });
  }

  /** The level-up moment: hit-stop, squash pop, flash, sparks, the +1 and the rolling level. */
  celebrate(from: number, plan: CuePlan): Promise<void> {
    const to = this.current.level;
    this.levelOdometer.jump(String(from));
    this.backLevel.jump(String(from));
    this.card.classList.add('is-charging');
    return new Promise((resolve) => {
      setTimeout(() => {
        this.card.classList.remove('is-charging');
        this.levelOdometer.set(String(to), 1);
        this.backLevel.set(String(to), 1);
        if (plan.channels.includes('squash')) this.pop.kick(POP_KICK);
        if (plan.channels.includes('light')) restartAnimation(this.card, 'is-flashing');
        if (plan.channels.includes('numberPop')) {
          const gain = this.card.querySelector<HTMLElement>('.cp-inv-gain');
          if (gain) {
            gain.textContent = this.ctx.i18n.t(inventoryKey('levelGain'));
            restartAnimation(gain, 'is-rising');
          }
        }
        this.burst(plan.sparks);
        resolve();
      }, plan.hold);
    });
  }

  dispose(): void {
    this.angle.stop();
    this.pop.stop();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private burst(count: number): void {
    const layer = this.card.querySelector<HTMLElement>('.cp-inv-sparks');
    if (!layer || count === 0) return;
    const sparks = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const reach = 46 + Math.random() * 38;
      return h('span', {
        class: 'cp-inv-spark',
        attrs: {
          style: `--dx: ${Math.cos(angle) * reach}px; --dy: ${Math.sin(angle) * reach}px; --delay: ${Math.round(Math.random() * 80)}ms`,
        },
      });
    });
    layer.replaceChildren(...sparks);
    setTimeout(() => {
      layer.replaceChildren();
    }, 900);
  }

  private fusable(): boolean {
    return (
      !this.busy &&
      this.options.canFuse &&
      (fuseProgress(this.current, this.options.duplicatesPerLevel)?.levels ?? 0) > 0
    );
  }

  private frontLabel(): string {
    const i18n = this.ctx.i18n;
    const parts = [
      i18n.t(inventoryKey('turnOver'), { name: itemName(i18n, this.current) }),
      this.current.rarity === null ? '' : rarityName(i18n, this.current.rarity),
      this.current.kind === 'charm'
        ? i18n.t(inventoryKey('level'), { level: this.current.level })
        : '',
      this.current.copies > 1
        ? i18n.t(inventoryKey('duplicates'), { count: this.current.copies })
        : '',
      this.ribbonText(),
    ];
    return parts.filter((part) => part !== '').join(', ');
  }

  private ribbonText(): string {
    const i18n = this.ctx.i18n;
    if (this.current.equipped) return i18n.t(inventoryKey('equipped'));
    if (this.current.kind === 'safe') {
      return i18n.t(inventoryKey(this.current.ready ? 'ready' : 'sealed'));
    }
    return '';
  }

  private paintCounts(): void {
    const i18n = this.ctx.i18n;
    const stack = this.current;
    this.copies.textContent = i18n.t(inventoryKey('copies'), { count: stack.copies });
    this.copies.hidden = stack.copies < 2;
    const ribbon = this.ribbonText();
    this.ribbon.textContent = ribbon;
    this.ribbon.hidden = ribbon === '';
    this.card.classList.toggle('is-equipped', stack.equipped);
    this.card.classList.toggle('is-ready', stack.kind === 'safe' && stack.ready);
    this.card.classList.toggle('has-level', stack.kind === 'charm');
    this.duplicates.textContent = i18n.t(inventoryKey('duplicates'), { count: stack.copies });
    this.duplicates.hidden = stack.copies < 2;
    this.front.setAttribute('aria-label', this.frontLabel());

    const progress = fuseProgress(stack, this.options.duplicatesPerLevel);
    const isCharm = stack.kind === 'charm';
    this.pips.replaceChildren(
      ...(progress
        ? Array.from({ length: progress.need }, (_, i) =>
            h('span', { class: i < progress.have || progress.levels > 0 ? 'is-filled' : '' }),
          )
        : []),
    );
    this.pips.hidden = progress === null;
    this.fuseNote.hidden = !isCharm;
    this.fuseNote.textContent = !isCharm
      ? ''
      : progress === null || !this.options.canFuse
        ? i18n.t(inventoryKey('fuseAuto'))
        : i18n.t(inventoryKey('fuseNeed'), { have: progress.have, need: progress.need });
    this.fuseButton.hidden = !isCharm || progress === null || !this.options.canFuse;
    this.fuseButton.textContent = i18n.t(inventoryKey(this.busy ? 'fusing' : 'fuse'));
    this.fuseButton.setAttribute('aria-disabled', String(!this.fusable()));
  }
}
