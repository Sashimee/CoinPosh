import type { Currency, Wallet } from '@coinposh/shared';
import { watch } from '../../app/store.ts';
import { formatBalance, formatInteger } from '../../i18n/index.ts';
import { feedback, tr, type UiContext } from '../context.ts';
import { fromMarkup, h, rectOf, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { Odometer } from './odometer.ts';

const POP_VELOCITY = 0.9;
const CHIP_POP_VELOCITY = 1.6;

/** The currencies the Vault plaque has no readout for, shown in the compact purse beside it. */
export const WALLET_CHIPS = ['pearls', 'keys', 'tickets'] as const;
export type WalletChip = (typeof WALLET_CHIPS)[number];

/**
 * How long a crate's card may stand in front of the player, uncollected, before the Vault shows
 * its credit anyway. It runs only while the card is on screen: a crate waiting its turn in the
 * queue or behind a sheet is not left up, and keeps its credit until its card is.
 */
export const PAYOUT_HOLD_CAP_MS = 30_000;
/** One line's flight from the reward card to its readout. */
export const PAYOUT_FLIGHT_MS = 620;
export const PAYOUT_STAGGER_MS = 110;
/** Air after the last landing before the payout settles whatever has not landed. */
const PAYOUT_SETTLE_MS = 120;

interface Held {
  readonly id: string;
  pending: number;
  absorbed: number;
}

/**
 * Holds part of a server balance back from its readout. A hold names an amount the server has
 * already credited (or is about to report); the next rises in the balance are absorbed into it,
 * up to that amount, and stay off the readout until the hold is released. Only rises are
 * absorbed, so a credit that reaches the balance late, or never, can only hold back other gains
 * for a while, never show a number the server did not report; once every hold is released the
 * readout is the balance again.
 */
export class CreditHold {
  readonly #holds: Held[] = [];
  #seen: number | null = null;

  hold(id: string, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`A credit hold needs a finite amount ≥ 0, got ${amount} for ${id}.`);
    }
    if (amount === 0) return;
    const found = this.#holds.find((held) => held.id === id);
    if (found) found.pending += amount;
    else this.#holds.push({ id, pending: amount, absorbed: 0 });
  }

  /** Feeds the balance as the server last reported it. */
  observe(balance: number): void {
    const previous = this.#seen;
    this.#seen = balance;
    if (previous !== null && balance > previous) {
      let gain = balance - previous;
      for (const held of this.#holds) {
        if (gain <= 0) break;
        const take = Math.min(gain, held.pending);
        held.pending -= take;
        held.absorbed += take;
        gain -= take;
      }
    }
    let excess = this.withheld - balance;
    for (let i = this.#holds.length - 1; i >= 0 && excess > 0; i -= 1) {
      const held = this.#holds[i];
      if (!held) continue;
      const cut = Math.min(excess, held.absorbed);
      held.absorbed -= cut;
      excess -= cut;
    }
  }

  has(id: string): boolean {
    return this.#holds.some((held) => held.id === id);
  }

  /** Lets `id`'s hold go; returns how much it had kept off the readout. */
  release(id: string): number {
    const at = this.#holds.findIndex((held) => held.id === id);
    if (at < 0) return 0;
    const [held] = this.#holds.splice(at, 1);
    return held?.absorbed ?? 0;
  }

  releaseAll(): void {
    this.#holds.length = 0;
  }

  get withheld(): number {
    return this.#holds.reduce((sum, held) => sum + held.absorbed, 0);
  }

  /** What the readout shows: the balance less what the holds keep back; null before any balance. */
  get shown(): number | null {
    return this.#seen === null ? null : this.#seen - this.withheld;
  }
}

/** A currency line on a reward card, with the element its gain lifts off. */
export interface PayoutLine {
  readonly currency: Currency;
  readonly amount: number;
  readonly source: Element | null;
}

export interface Payout {
  /** The server's wallet that includes the crate. */
  readonly wallet: Wallet;
  readonly lines: readonly PayoutLine[];
}

/** How a crate's credit reaches the HUD: held from its open, paid out on collect. */
export interface WalletPayout {
  /** The server credited `credit` with this open; keep it off the readouts until collect. */
  hold(id: string, credit: Readonly<Partial<Record<Currency, number>>>): void;
  /** The crate's card is on screen: start (or restart) the cap on its hold. */
  arm(id: string): void;
  /** The card left the screen for a while (a sheet over it): the cap waits until it is back. */
  disarm(id: string): void;
  /** The player collected: fly each line to its readout, which then counts up. */
  collect(id: string, payout: Payout): void;
  /** The crate went away without a collect (dismissed, dropped, torn down): show it all now. */
  release(id: string): void;
}

export interface ChipCount {
  readonly currency: WalletChip;
  readonly from: number;
  readonly to: number;
}

export interface PayoutLedgerOptions {
  readonly capMs?: number;
  readonly warn?: (message: string) => void;
}

/**
 * The bookkeeping behind the payout, free of the DOM: coin and gold-bar holds against the
 * store's balances, the purse chips' shown and server values, and the cap that lets a hold go
 * if its card is left up and never collected. `changed` runs whenever a readout should repaint.
 */
export class PayoutLedger {
  readonly coins = new CreditHold();
  readonly goldBars = new CreditHold();
  readonly #chips = new Map<WalletChip, { shown: number; target: number }>();
  readonly #caps = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #collecting = new Set<string>();
  readonly #capMs: number;
  readonly #warn: (message: string) => void;

  constructor(
    private readonly changed: () => void,
    options: PayoutLedgerOptions = {},
  ) {
    this.#capMs = options.capMs ?? PAYOUT_HOLD_CAP_MS;
    this.#warn =
      options.warn ??
      ((message) => {
        console.warn(message);
      });
  }

  hold(id: string, credit: Readonly<Partial<Record<Currency, number>>>): void {
    this.coins.hold(id, credit.coins ?? 0);
    this.goldBars.hold(id, credit.goldBars ?? 0);
  }

  arm(id: string): void {
    this.#clearCap(id);
    if (!this.#holds(id) || this.#collecting.has(id)) return;
    this.#caps.set(
      id,
      setTimeout(() => {
        this.#caps.delete(id);
        this.#warn(
          `CoinPosh HUD: crate ${id} was not collected within ${this.#capMs} ms; the Vault shows its credit now.`,
        );
        this.#settle(id);
      }, this.#capMs),
    );
  }

  disarm(id: string): void {
    this.#clearCap(id);
  }

  /** Starts the payout; returns how each purse chip should count. */
  collect(id: string, payout: Payout): readonly ChipCount[] {
    this.#clearCap(id);
    if (this.#holds(id)) this.#collecting.add(id);
    const counts: ChipCount[] = [];
    for (const currency of WALLET_CHIPS) {
      const to = payout.wallet[currency];
      const gained = payout.lines
        .filter((line) => line.currency === currency)
        .reduce((sum, line) => sum + line.amount, 0);
      const known = this.#chips.get(currency);
      const from = known?.shown ?? Math.max(0, to - gained);
      this.#chips.set(currency, { shown: from, target: to });
      if (from !== to || gained > 0) counts.push({ currency, from, to });
    }
    this.changed();
    return counts;
  }

  /** One line of `id`'s payout reached its readout. */
  land(id: string, currency: Currency): void {
    if (currency === 'coins') this.coins.release(id);
    else if (currency === 'goldBars') this.goldBars.release(id);
    else if (isWalletChip(currency)) this.#reach(currency);
    this.changed();
  }

  /** Ends `id`'s payout: whatever has not landed shows at once. */
  finish(id: string): void {
    this.#collecting.delete(id);
    this.#clearCap(id);
    this.coins.release(id);
    this.goldBars.release(id);
    for (const currency of WALLET_CHIPS) this.#reach(currency);
    this.changed();
  }

  /** `id` left without a collect; a payout already in flight finishes on its own. */
  release(id: string): void {
    if (this.#collecting.has(id)) return;
    this.#settle(id);
  }

  releaseAll(): void {
    for (const timer of this.#caps.values()) clearTimeout(timer);
    this.#caps.clear();
    this.#collecting.clear();
    this.coins.releaseAll();
    this.goldBars.releaseAll();
    for (const currency of WALLET_CHIPS) this.#reach(currency);
    this.changed();
  }

  /** The chip's readout; null until the server has reported that currency. */
  chip(currency: WalletChip): number | null {
    return this.#chips.get(currency)?.shown ?? null;
  }

  #holds(id: string): boolean {
    return this.coins.has(id) || this.goldBars.has(id);
  }

  #settle(id: string): void {
    this.#clearCap(id);
    const had = this.#holds(id);
    this.coins.release(id);
    this.goldBars.release(id);
    if (had) this.changed();
  }

  #reach(currency: WalletChip): void {
    const chip = this.#chips.get(currency);
    if (chip) chip.shown = chip.target;
  }

  #clearCap(id: string): void {
    clearTimeout(this.#caps.get(id));
    this.#caps.delete(id);
  }
}

function isWalletChip(currency: Currency): currency is WalletChip {
  return (WALLET_CHIPS as readonly Currency[]).includes(currency);
}

interface PayoutChannel extends WalletPayout {
  attach(view: WalletPayout): () => void;
}

const channels = new WeakMap<object, PayoutChannel>();

/**
 * The payout shared by everything that credits `owner`'s HUD, such as a UI's store. Until the
 * plaque attaches, holds are ignored and the readouts show the server balances as they come.
 */
export function walletPayoutFor(owner: object): PayoutChannel {
  let channel = channels.get(owner);
  if (!channel) {
    let view: WalletPayout | null = null;
    const made: PayoutChannel = {
      hold: (id, credit) => view?.hold(id, credit),
      arm: (id) => view?.arm(id),
      disarm: (id) => view?.disarm(id),
      collect: (id, payout) => view?.collect(id, payout),
      release: (id) => view?.release(id),
      attach(next) {
        view = next;
        return () => {
          if (view === next) view = null;
        };
      },
    };
    channels.set(owner, made);
    channel = made;
  }
  return channel;
}

const CHIP_ICONS: Readonly<Record<WalletChip, string>> = {
  pearls:
    '<circle cx="12" cy="12.5" r="7" fill="currentColor" fill-opacity=".2"/><path d="M8.7 10.6a3.9 3.9 0 0 1 3.2-2.4"/>',
  keys: '<circle cx="8" cy="12" r="3.6" fill="currentColor" fill-opacity=".18"/><path d="M11.6 12h8.9M17.4 12v3.2M20.5 12v2.4"/>',
  tickets:
    '<path d="M4 7.5h16v3a1.8 1.8 0 0 0 0 3.6v3H4v-3a1.8 1.8 0 0 0 0-3.6Z" fill="currentColor" fill-opacity=".16"/><path d="M14.5 8.5v7" stroke-dasharray="1.4 1.6"/>',
};

function chipIcon(currency: WalletChip): Element {
  return fromMarkup(
    `<svg class="cp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${CHIP_ICONS[currency]}</svg>`,
  );
}

function currencyIcon(currency: Currency): Element {
  if (isWalletChip(currency)) return chipIcon(currency);
  return icon(currency === 'goldBars' ? 'goldBar' : 'coin');
}

interface PurseChip {
  readonly currency: WalletChip;
  readonly el: HTMLElement;
  readonly odometer: Odometer;
  readonly pop: SpringValue;
  shown: number | null;
}

function createPurseChip(currency: WalletChip): PurseChip {
  const odometer = new Odometer();
  const el = h(
    'span',
    {
      class: `cp-wallet-chip cp-wallet-chip--${currency}`,
      attrs: { 'data-testid': `hud-wallet-${currency}`, role: 'img', hidden: '' },
    },
    chipIcon(currency),
    odometer.el,
  );
  const pop = new SpringValue(1, SPRINGS.pop, (value) => {
    el.style.scale = value === 1 ? '' : String(value);
  });
  return { currency, el, odometer, pop, shown: null };
}

/** Sparks per landing; transforms and opacity only. */
const SPARKS = 9;
const SPARK_MS = 520;
const FLIGHT_SAMPLES = 14;

function center(rect: DOMRect): { readonly x: number; readonly y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** An arc over the table: a quadratic curve lifted above the higher end, scaled down as it lands. */
function flightFrames(from: DOMRect, to: DOMRect): Keyframe[] {
  const a = center(from);
  const b = center(to);
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const lift = Math.min(150, Math.max(40, distance * 0.28));
  const control = { x: (a.x + b.x) / 2 + (a.x - b.x) * 0.18, y: Math.min(a.y, b.y) - lift };
  const frames: Keyframe[] = [];
  for (let i = 0; i <= FLIGHT_SAMPLES; i += 1) {
    const t = i / FLIGHT_SAMPLES;
    const e = easeInOut(t);
    const u = 1 - e;
    const x = u * u * a.x + 2 * u * e * control.x + e * e * b.x;
    const y = u * u * a.y + 2 * u * e * control.y + e * e * b.y;
    const scale = t < 0.3 ? 1 + 0.4 * t : 1.12 - 0.62 * ((t - 0.3) / 0.7);
    frames.push({
      offset: t,
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`,
      opacity: t < 0.08 ? t / 0.08 : 1 - 0.25 * Math.max(0, (t - 0.8) / 0.2),
    });
  }
  return frames;
}

function sparkle(layer: HTMLElement, rect: DOMRect, currency: Currency): void {
  const { x, y } = center(rect);
  const reach = Math.max(28, Math.min(64, rect.width * 0.4));
  for (let i = 0; i < SPARKS; i += 1) {
    const spark = h('span', {
      class: `cp-wallet-spark cp-wallet-spark--${currency}`,
      attrs: { 'aria-hidden': 'true' },
    });
    layer.append(spark);
    const angle = (i / SPARKS) * Math.PI * 2 + (i % 2) * 0.35;
    const r = reach * (0.7 + 0.3 * ((i * 7) % 5) * 0.25);
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r * 0.7;
    const at = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    const animation = spark.animate(
      [
        { transform: `${at} scale(1.2)`, opacity: 1 },
        {
          transform: `${at} translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(0.2)`,
          opacity: 0,
        },
      ],
      { duration: SPARK_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'both' },
    );
    animation.onfinish = () => {
      spark.remove();
    };
    setTimeout(() => {
      spark.remove();
    }, SPARK_MS + 200);
  }
}

export function createBalancePlaque(ctx: UiContext): HTMLElement {
  const odometer = new Odometer();
  const spoken = h('span', { class: 'cp-sr-only' });
  const label = h('span', { class: 'cp-plaque-label' });
  const provisional = h('span', { class: 'cp-plaque-provisional' });
  const barsValue = h('span', { class: 'cp-chip-value' });
  const bars = h(
    'span',
    { class: 'cp-chip cp-chip-bars', attrs: { hidden: '' } },
    icon('goldBar'),
    barsValue,
  );
  const glint = h('span', { class: 'cp-glint', attrs: { 'aria-hidden': 'true' } });
  const amount = h('span', { class: 'cp-plaque-amount' }, icon('coin'), odometer.el);
  const plaque = h(
    'div',
    { class: 'cp-plaque cp-panel', attrs: { 'data-testid': 'hud-balance' } },
    glint,
    label,
    amount,
    provisional,
    spoken,
  );
  const chips = WALLET_CHIPS.map(createPurseChip);
  const purse = h(
    'div',
    { class: 'cp-wallet', attrs: { role: 'group', 'data-testid': 'hud-wallet', hidden: '' } },
    ...chips.map((chip) => chip.el),
  );
  const wrap = h('div', { class: 'cp-plaque-wrap' }, purse, plaque, bars);

  const pop = new SpringValue(1, SPRINGS.pop, (value) => {
    plaque.style.scale = value === 1 ? '' : String(value);
  });
  const barsPop = new SpringValue(1, SPRINGS.pop, (value) => {
    bars.style.scale = value === 1 ? '' : String(value);
  });

  ctx.loc.text(label, () => tr(ctx, 'hud.vault'));
  ctx.loc.text(provisional, () => tr(ctx, 'hud.provisional'));
  ctx.loc.attr(purse, 'aria-label', () => tr(ctx, 'hud.wallet.label'));

  let shown: number | null = null;
  const show = (coins: number, animate: boolean): void => {
    const language = ctx.i18n.language;
    const text = formatBalance(coins, language);
    if (!animate || shown === null) odometer.jump(text);
    else if (coins !== shown) odometer.set(text, coins > shown ? 1 : -1);
    if (animate && shown !== null && coins > shown) {
      pop.kick(POP_VELOCITY);
      restartAnimation(plaque, 'is-gaining');
    }
    shown = coins;
    spoken.textContent = tr(ctx, 'hud.balanceAria', {
      value: tr(ctx, 'currency.coins', { count: coins, value: formatInteger(coins, language) }),
    });
  };

  let barsShown: number | null = null;
  const showBars = (animate: boolean): void => {
    const count = ledger.goldBars.shown ?? ctx.store.getState().goldBars;
    if (animate && barsShown !== null && count > barsShown) barsPop.kick(CHIP_POP_VELOCITY);
    barsShown = count;
    bars.hidden = count <= 0;
    barsValue.textContent = formatBalance(count, ctx.i18n.language);
    bars.setAttribute(
      'aria-label',
      tr(ctx, 'hud.goldBarsAria', { value: formatInteger(count, ctx.i18n.language) }),
    );
  };

  const flying = new Set<WalletChip>();
  const showChip = (chip: PurseChip, animate: boolean): void => {
    const value = ledger.chip(chip.currency);
    chip.el.hidden = value === null || (value <= 0 && !flying.has(chip.currency));
    if (value === null) return;
    const language = ctx.i18n.language;
    const text = formatBalance(value, language);
    if (!animate || chip.shown === null) chip.odometer.jump(text);
    else if (value !== chip.shown) chip.odometer.set(text, value > chip.shown ? 1 : -1);
    if (animate && chip.shown !== null && value > chip.shown) chip.pop.kick(CHIP_POP_VELOCITY);
    chip.shown = value;
    chip.el.dataset.value = String(value);
    chip.el.setAttribute(
      'aria-label',
      tr(ctx, `hud.wallet.${chip.currency}Aria`, { value: formatInteger(value, language) }),
    );
  };

  const paint = (animate: boolean): void => {
    show(Math.max(0, ledger.coins.shown ?? ctx.store.getState().coins), animate);
    showBars(animate);
    for (const chip of chips) showChip(chip, animate);
    purse.hidden = chips.every((chip) => chip.el.hidden);
  };
  const ledger = new PayoutLedger(() => {
    paint(true);
  });

  const targetOf = (currency: Currency): HTMLElement => {
    if (currency === 'goldBars') return bars.hidden ? plaque : bars;
    const chip = chips.find((candidate) => candidate.currency === currency);
    return chip ? chip.el : plaque;
  };

  let layer: HTMLElement | null = null;
  const flightLayer = (): HTMLElement | null => {
    if (layer?.isConnected) return layer;
    const host = wrap.closest('.cp-ui-host');
    if (!host) return null;
    layer = h('div', { class: 'cp-wallet-flights', attrs: { 'aria-hidden': 'true' } });
    host.append(layer);
    return layer;
  };

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  const lifted = new Set<() => void>();
  /** Blanks the card's line while its ghost flies; the returned call puts it back. */
  const liftOff = (source: Element): (() => void) | null => {
    if (!(source instanceof HTMLElement)) return null;
    const before = source.style.opacity;
    source.style.opacity = '0';
    const restore = (): void => {
      lifted.delete(restore);
      source.style.opacity = before;
    };
    lifted.add(restore);
    return restore;
  };

  const launch = (id: string, line: PayoutLine, index: number, into: HTMLElement): number => {
    const source = line.source;
    const delay = index * PAYOUT_STAGGER_MS;
    const landAt = delay + PAYOUT_FLIGHT_MS;
    const land = (): void => {
      if (isWalletChip(line.currency)) flying.delete(line.currency);
      ledger.land(id, line.currency);
      const target = targetOf(line.currency);
      sparkle(into, rectOf(target), line.currency);
      feedback(ctx, 'tick');
    };
    if (!source) {
      later(landAt, land);
      return landAt;
    }
    const value = h('span', { class: 'cp-wallet-flight-value' });
    value.textContent = tr(ctx, 'hud.wallet.gain', {
      value: formatBalance(line.amount, ctx.i18n.language),
    });
    const ghost = h(
      'span',
      { class: `cp-wallet-flight cp-wallet-flight--${line.currency}` },
      currencyIcon(line.currency),
      value,
    );
    into.append(ghost);
    const from = rectOf(source);
    const lift = liftOff(source);
    ghost.animate(flightFrames(from, rectOf(targetOf(line.currency))), {
      duration: PAYOUT_FLIGHT_MS,
      delay,
      easing: 'linear',
      fill: 'both',
    });
    later(landAt, () => {
      ghost.remove();
      lift?.();
      land();
    });
    return landAt;
  };

  const payout: WalletPayout = {
    hold(id, credit) {
      ledger.hold(id, credit);
    },
    arm(id) {
      ledger.arm(id);
    },
    disarm(id) {
      ledger.disarm(id);
    },
    collect(id, given) {
      const counts = ledger.collect(id, given);
      const into = isReducedMotion() ? null : flightLayer();
      if (!into) {
        ledger.finish(id);
        if (counts.length > 0 || given.lines.length > 0) feedback(ctx, 'tick');
        return;
      }
      for (const count of counts) if (count.to > 0) flying.add(count.currency);
      paint(true);
      let last = 0;
      given.lines.forEach((line, index) => {
        last = Math.max(last, launch(id, line, index, into));
      });
      later(last + PAYOUT_SETTLE_MS, () => {
        flying.clear();
        ledger.finish(id);
      });
    },
    release(id) {
      ledger.release(id);
    },
  };
  ctx.own(walletPayoutFor(ctx.store).attach(payout));

  ctx.own(
    watch(
      ctx.store,
      (s) => s.coins,
      (coins, previous) => {
        ledger.coins.observe(coins);
        show(Math.max(0, ledger.coins.shown ?? coins), previous !== undefined);
      },
    ),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => s.goldBars,
      (goldBars, previous) => {
        ledger.goldBars.observe(goldBars);
        showBars(previous !== undefined);
      },
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      paint(false);
    }),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => s.provisional,
      (value) => {
        plaque.classList.toggle('is-provisional', value);
      },
    ),
  );
  ctx.own(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const restore of [...lifted]) restore();
    flying.clear();
    ledger.releaseAll();
    layer?.remove();
  });
  return wrap;
}
