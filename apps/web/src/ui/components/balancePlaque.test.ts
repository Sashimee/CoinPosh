import { readFileSync } from 'node:fs';
import { WalletSchema, type Wallet } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import { BUNDLED_RESOURCES, createI18n, type Language } from '../../i18n/index.ts';
import type { UiContext } from '../context.ts';
import { Localizer } from '../localize.ts';
import { setMotionPreference } from '../motion/reduced.ts';
import {
  createBalancePlaque,
  CreditHold,
  PAYOUT_FLIGHT_MS,
  PAYOUT_HOLD_CAP_MS,
  PAYOUT_STAGGER_MS,
  PayoutLedger,
  PROVISIONAL_REVEAL_MS,
  walletPayoutFor,
  type PayoutLine,
  type WalletPayout,
} from './balancePlaque.ts';

const wallet = (over: Partial<Wallet>): Wallet =>
  WalletSchema.parse({
    coins: 0,
    bullion: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
    ...over,
  });

const line = (currency: PayoutLine['currency'], amount: number): PayoutLine => ({
  currency,
  amount,
  source: null,
});

describe('CreditHold keeps an opened crate off the Vault until it is let go', () => {
  it('absorbs the credit when it reaches the balance and shows it on release', () => {
    const hold = new CreditHold();
    hold.observe(80);
    hold.hold('a', 12);
    expect(hold.shown).toBe(80);
    hold.observe(92);
    expect(hold.shown).toBe(80);
    expect(hold.release('a')).toBe(12);
    expect(hold.shown).toBe(92);
  });

  it('lets other gains through once the held amount is absorbed', () => {
    const hold = new CreditHold();
    hold.observe(80);
    hold.hold('a', 12);
    hold.observe(137);
    expect(hold.shown).toBe(125);
    hold.release('a');
    expect(hold.shown).toBe(137);
  });

  it('absorbs across several rises and never more than the hold', () => {
    const hold = new CreditHold();
    hold.observe(10);
    hold.hold('a', 12);
    hold.observe(15);
    hold.observe(20);
    expect(hold.shown).toBe(10);
    hold.observe(40);
    expect(hold.shown).toBe(28);
    expect(hold.withheld).toBe(12);
  });

  it('follows spending down while holding, and never withholds more than the balance', () => {
    const hold = new CreditHold();
    hold.observe(5);
    hold.hold('a', 12);
    hold.observe(17);
    expect(hold.shown).toBe(5);
    hold.observe(13);
    expect(hold.shown).toBe(1);
    hold.observe(4);
    expect(hold.shown).toBe(0);
    expect(hold.withheld).toBe(4);
    hold.release('a');
    expect(hold.shown).toBe(4);
  });

  it('fills holds in the order the crates opened', () => {
    const hold = new CreditHold();
    hold.observe(0);
    hold.hold('a', 5);
    hold.hold('b', 7);
    hold.observe(8);
    expect(hold.release('a')).toBe(5);
    expect(hold.shown).toBe(5);
    hold.observe(20);
    expect(hold.release('b')).toBe(7);
    expect(hold.shown).toBe(20);
  });

  it('keeps the readout flat when a held fall is refused after its estimate rose the balance', () => {
    const hold = new CreditHold();
    hold.observe(0);
    hold.hold('crate', 12);
    hold.hold('falls', 5);
    hold.observe(5);
    expect(hold.shown).toBe(0);
    hold.retract('falls', 5);
    expect(hold.shown).toBe(0);
    hold.observe(0);
    expect(hold.shown).toBe(0);
    hold.observe(12);
    expect(hold.shown).toBe(0);
    expect(hold.release('crate')).toBe(12);
    expect(hold.shown).toBe(12);
    expect(hold.release('falls')).toBe(0);
    expect(hold.shown).toBe(12);
  });

  it('takes a refusal out of the same answer that pays the other held falls', () => {
    const hold = new CreditHold();
    hold.observe(40);
    hold.hold('crate', 12);
    hold.observe(52);
    hold.hold('falls', 5);
    hold.observe(57);
    hold.hold('falls', 6);
    hold.observe(63);
    expect(hold.shown).toBe(40);
    hold.retract('falls', 5);
    hold.hold('falls', 2);
    hold.observe(60);
    expect(hold.shown).toBe(40);
    expect(hold.release('crate')).toBe(12);
    expect(hold.shown).toBe(52);
    expect(hold.release('falls')).toBe(8);
    expect(hold.shown).toBe(60);
  });

  it('retracts no more than the hold kept or expects, and ignores an unknown id', () => {
    const hold = new CreditHold();
    hold.observe(10);
    hold.retract('missing', 5);
    expect(hold.shown).toBe(10);
    hold.hold('falls', 3);
    hold.observe(13);
    hold.retract('falls', 9);
    expect(hold.shown).toBe(10);
    hold.observe(4);
    expect(hold.shown).toBe(4);
    expect(hold.release('falls')).toBe(0);
    expect(() => {
      hold.retract('falls', -1);
    }).toThrow(RangeError);
  });

  it('ignores a zero credit and refuses a negative or non-finite one', () => {
    const hold = new CreditHold();
    hold.observe(3);
    hold.hold('a', 0);
    expect(hold.has('a')).toBe(false);
    expect(() => {
      hold.hold('b', -1);
    }).toThrow(RangeError);
    expect(() => {
      hold.hold('c', Number.NaN);
    }).toThrow(RangeError);
  });

  it('reports nothing before a balance and releases an unknown id as 0', () => {
    const hold = new CreditHold();
    expect(hold.shown).toBeNull();
    expect(hold.release('missing')).toBe(0);
  });

  it('always reconciles with the balance once every hold is released', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 50; run += 1) {
      const hold = new CreditHold();
      let balance = 100;
      hold.observe(balance);
      const ids: string[] = [];
      for (let step = 0; step < 40; step += 1) {
        const roll = next();
        if (roll < 0.2) {
          const id = `c${run}-${step}`;
          ids.push(id);
          hold.hold(id, Math.floor(next() * 30) + 1);
        } else if (roll < 0.3 && ids.length > 0) {
          hold.release(ids.splice(Math.floor(next() * ids.length), 1)[0] ?? '');
        } else {
          balance = Math.max(0, balance + Math.floor(next() * 40) - 15);
          hold.observe(balance);
        }
        const shown = hold.shown ?? -1;
        expect(shown).toBeGreaterThanOrEqual(0);
        expect(shown).toBeLessThanOrEqual(balance);
      }
      for (const id of ids) hold.release(id);
      expect(hold.shown).toBe(balance);
    }
  });
});

describe('PayoutLedger pays a crate out on collect and never keeps it for good', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ledger = (capMs = PAYOUT_HOLD_CAP_MS) => {
    const warnings: string[] = [];
    const changes = { count: 0 };
    const made = new PayoutLedger(
      () => {
        changes.count += 1;
      },
      { capMs, warn: (message) => warnings.push(message) },
    );
    return { ledger: made, warnings, changes };
  };

  it('holds the coins from open to the coin line landing, then counts them in', () => {
    const { ledger: book } = ledger();
    book.coins.observe(80);
    book.hold('a', { coins: 12, pearls: 1 });
    book.coins.observe(92);
    expect(book.coins.shown).toBe(80);
    book.collect('a', { wallet: wallet({ coins: 92, pearls: 1 }), lines: [line('coins', 12)] });
    expect(book.coins.shown).toBe(80);
    book.land('a', 'coins');
    expect(book.coins.shown).toBe(92);
  });

  it('counts a purse chip from what it showed to the server wallet on landing', () => {
    const { ledger: book } = ledger();
    book.hold('a', { pearls: 20 });
    const counts = book.collect('a', {
      wallet: wallet({ pearls: 20 }),
      lines: [line('pearls', 20)],
    });
    expect(counts).toEqual([{ currency: 'pearls', from: 0, to: 20 }]);
    expect(book.chip('pearls')).toBe(0);
    expect(book.chip('keys')).toBe(0);
    book.land('a', 'pearls');
    expect(book.chip('pearls')).toBe(20);

    const second = book.collect('b', {
      wallet: wallet({ pearls: 21, keys: 1 }),
      lines: [line('pearls', 1), line('keys', 1)],
    });
    expect(second).toEqual([
      { currency: 'pearls', from: 20, to: 21 },
      { currency: 'keys', from: 0, to: 1 },
    ]);
    book.finish('b');
    expect(book.chip('pearls')).toBe(21);
    expect(book.chip('keys')).toBe(1);
  });

  it('shows the server value for a chip it never saw counted, starting below it by the gain', () => {
    const { ledger: book } = ledger();
    const counts = book.collect('a', {
      wallet: wallet({ tickets: 9 }),
      lines: [line('tickets', 2)],
    });
    expect(counts).toEqual([{ currency: 'tickets', from: 7, to: 9 }]);
    book.finish('a');
    expect(book.chip('tickets')).toBe(9);
    expect(book.chip('pearls')).toBe(0);
  });

  it('finish shows every line that has not landed yet', () => {
    const { ledger: book } = ledger();
    book.coins.observe(10);
    book.hold('a', { coins: 5 });
    book.coins.observe(15);
    book.collect('a', {
      wallet: wallet({ coins: 15, keys: 1 }),
      lines: [line('coins', 5), line('keys', 1)],
    });
    book.finish('a');
    expect(book.coins.shown).toBe(15);
    expect(book.chip('keys')).toBe(1);
  });

  it('releases a crate dismissed without a collect at once', () => {
    const { ledger: book, changes } = ledger();
    book.coins.observe(40);
    book.hold('a', { coins: 6 });
    book.coins.observe(46);
    const before = changes.count;
    book.release('a');
    expect(book.coins.shown).toBe(46);
    expect(changes.count).toBe(before + 1);
  });

  it('keeps a payout in flight when the card is disposed mid-flight', () => {
    const { ledger: book } = ledger();
    book.coins.observe(40);
    book.hold('a', { coins: 6 });
    book.coins.observe(46);
    book.collect('a', { wallet: wallet({ coins: 46 }), lines: [line('coins', 6)] });
    book.release('a');
    expect(book.coins.shown).toBe(40);
    book.land('a', 'coins');
    expect(book.coins.shown).toBe(46);
  });

  it('lets a card left up uncollected go after the cap, with a warning', () => {
    const { ledger: book, warnings } = ledger();
    book.coins.observe(40);
    book.hold('a', { coins: 6 });
    book.coins.observe(46);
    book.arm('a');
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS - 1);
    expect(book.coins.shown).toBe(40);
    vi.advanceTimersByTime(1);
    expect(book.coins.shown).toBe(46);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('a');
  });

  it('does not cap a crate once it is collected', () => {
    const { ledger: book, warnings } = ledger(100);
    book.coins.observe(0);
    book.hold('a', { coins: 6 });
    book.coins.observe(6);
    book.arm('a');
    book.collect('a', { wallet: wallet({ coins: 6 }), lines: [line('coins', 6)] });
    book.arm('a');
    vi.advanceTimersByTime(1000);
    expect(warnings).toEqual([]);
    expect(book.coins.shown).toBe(0);
  });

  it('holds gold bars like coins and arms no cap for a crate with nothing to hold', () => {
    const { ledger: book, warnings } = ledger(100);
    book.goldBars.observe(1);
    book.hold('a', { goldBars: 2 });
    book.goldBars.observe(3);
    expect(book.goldBars.shown).toBe(1);
    book.hold('b', { pearls: 3 });
    book.arm('a');
    book.arm('b');
    vi.advanceTimersByTime(100);
    expect(book.goldBars.shown).toBe(3);
    expect(warnings).toHaveLength(1);
  });

  it('keeps a crate that waits its turn for longer than the cap until it is collected', () => {
    const { ledger: book, warnings } = ledger();
    book.coins.observe(40);
    book.hold('a', { coins: 6 });
    book.coins.observe(46);
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 3);
    expect(book.coins.shown).toBe(40);
    book.arm('a');
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS - 1);
    book.collect('a', { wallet: wallet({ coins: 46 }), lines: [line('coins', 6)] });
    expect(book.coins.shown).toBe(40);
    book.land('a', 'coins');
    expect(book.coins.shown).toBe(46);
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS);
    expect(warnings).toEqual([]);
  });

  it('pauses the cap while the card is out of sight and restarts it when it is back', () => {
    const { ledger: book, warnings } = ledger();
    book.coins.observe(0);
    book.hold('a', { coins: 6 });
    book.coins.observe(6);
    book.arm('a');
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS - 1000);
    book.disarm('a');
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 2);
    book.arm('a');
    vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS - 1);
    expect(book.coins.shown).toBe(0);
    expect(warnings).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(book.coins.shown).toBe(6);
    expect(warnings).toHaveLength(1);
  });

  it('is busy from any open, even one that credits nothing, until it lands or goes', () => {
    const { ledger: book } = ledger(100);
    book.coins.observe(0);
    expect(book.busy).toBe(false);
    book.hold('keys-only', { keys: 2 });
    expect(book.busy, 'a reveal is open even with no coins to hold').toBe(true);
    book.release('keys-only');
    expect(book.busy).toBe(false);
    book.hold('a', { coins: 4 });
    book.collect('a', { wallet: wallet({ coins: 4 }), lines: [line('coins', 4)] });
    expect(book.busy, 'the coin line is still in flight').toBe(true);
    book.finish('a');
    expect(book.busy).toBe(false);
    book.hold('b', { coins: 3 });
    book.arm('b');
    vi.advanceTimersByTime(100);
    expect(book.busy, 'the cap let an uncollected card go').toBe(false);
    book.hold('c', {});
    book.releaseAll();
    expect(book.busy).toBe(false);
  });

  it('releaseAll empties every hold and timer, as on teardown', () => {
    const { ledger: book, warnings } = ledger(100);
    book.coins.observe(0);
    book.hold('a', { coins: 4 });
    book.hold('b', { coins: 4 });
    book.arm('a');
    book.arm('b');
    book.coins.observe(8);
    book.collect('a', { wallet: wallet({ coins: 8, pearls: 2 }), lines: [line('pearls', 2)] });
    book.releaseAll();
    expect(book.coins.shown).toBe(8);
    expect(book.chip('pearls')).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(warnings).toEqual([]);
  });
});

describe('walletPayoutFor', () => {
  it('hands one channel per owner to the plaque and the crates', () => {
    const owner = {};
    expect(walletPayoutFor(owner)).toBe(walletPayoutFor(owner));
    expect(walletPayoutFor({})).not.toBe(walletPayoutFor(owner));
  });

  it('forwards to the attached view only, and drops calls before or after it', () => {
    const channel = walletPayoutFor({});
    const calls: string[] = [];
    const view: WalletPayout = {
      hold: (id) => calls.push(`hold ${id}`),
      retract: (id) => calls.push(`retract ${id}`),
      arm: (id) => calls.push(`arm ${id}`),
      disarm: (id) => calls.push(`disarm ${id}`),
      collect: (id) => calls.push(`collect ${id}`),
      release: (id) => calls.push(`release ${id}`),
    };
    channel.hold('early', { coins: 1 });
    const detach = channel.attach(view);
    channel.hold('a', { coins: 1 });
    channel.retract('a', { coins: 1 });
    channel.arm('a');
    channel.disarm('a');
    channel.collect('a', { wallet: wallet({}), lines: [] });
    channel.release('b');
    detach();
    channel.release('late');
    expect(calls).toEqual(['hold a', 'retract a', 'arm a', 'disarm a', 'collect a', 'release b']);
  });
});

/** Just enough DOM for the plaque, its odometers and its flights: the suite runs in node. */
class FakeNode {
  parent: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly style: Record<string, string> = { opacity: '' };
  readonly dataset: Record<string, string> = {};
  #text = '';

  constructor(readonly tagName: string) {}

  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(value: string) {
    this.attrs.set('class', value);
  }

  readonly classList = {
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
    add: (name: string): void => {
      if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(/\s+/)
        .filter((part) => part !== name)
        .join(' ');
    },
    toggle: (name: string, on: boolean): void => {
      if (on) this.classList.add(name);
      else this.classList.remove(name);
    },
  };

  get hidden(): boolean {
    return this.attrs.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }

  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren();
    this.#text = value;
  }

  get isConnected(): boolean {
    return this.tagName === 'body' || (this.parent?.isConnected ?? false);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.#text += node;
        continue;
      }
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of [...this.children]) child.remove();
    this.#text = '';
    this.append(...nodes);
  }
  remove(): void {
    const siblings = this.parent?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const testId = /^\[data-testid="(.+)"\]$/.exec(selector);
    if (testId) return this.attrs.get('data-testid') === testId[1];
    throw new Error(`FakeNode cannot match ${selector}`);
  }
  closest(selector: string): FakeNode | null {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
  }
  all(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  querySelector(selector: string): FakeNode | null {
    return this.all().find((node) => node.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.all().filter((node) => node.matches(selector));
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 40, height: 20 } as DOMRect;
  }
  animate(): { onfinish: (() => void) | null } {
    return { onfinish: null };
  }

  /** `fromMarkup` reads a template's first element; icons are opaque here. */
  set innerHTML(_markup: string) {
    this.replaceChildren(new FakeNode('svg'));
  }
  get content(): { firstElementChild: FakeNode | null } {
    return { firstElementChild: this.children[0] ?? null };
  }
}

const COLLECT_WALLET = wallet({ coins: 92, pearls: 25 });

function mountPlaque(language: Language = 'en') {
  const body = new FakeNode('body');
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeNode(tag), body });
  vi.stubGlobal('HTMLElement', FakeNode);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  const store = createStore(initialUiState(defaultSettings(language)));
  store.setState({ coins: 80 });
  const bus = createBus<UiEvents>();
  const feedback: string[] = [];
  bus.on('ui:feedback', ({ kind }) => feedback.push(kind));
  const disposers: (() => void)[] = [];
  const ctx: UiContext = {
    i18n,
    loc: new Localizer(i18n),
    store,
    bus,
    own: (dispose) => disposers.push(dispose),
  };
  const host = new FakeNode('div');
  host.className = 'cp-ui-host';
  body.append(host);
  host.append(createBalancePlaque(ctx) as unknown as FakeNode);
  const find = (selector: string): FakeNode => {
    const found = host.querySelector(selector);
    if (!found) throw new Error(`no ${selector} in the plaque`);
    return found;
  };
  const cardLine = new FakeNode('li');
  body.append(cardLine);
  return {
    store,
    i18n,
    host,
    feedback,
    plaque: () => find('[data-testid="hud-balance"]'),
    cardLine,
    payout: walletPayoutFor(store),
    vault: () => find('[data-testid="hud-balance"]').querySelector('.cp-sr-only')?.textContent,
    chip: (currency: string) => find(`[data-testid="hud-wallet-${currency}"]`),
    dispose: () => {
      for (const off of disposers.splice(0).reverse()) off();
    },
  };
}

type Plaque = ReturnType<typeof mountPlaque>;

describe('createBalancePlaque pays a collected crate out on its readouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    setMotionPreference('system');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const open = (plaque: Plaque): void => {
    plaque.payout.hold('a', { coins: 12, pearls: 25 });
    plaque.store.setState({ coins: 92 });
  };
  const collect = (plaque: Plaque, source: FakeNode | null): void => {
    plaque.payout.collect('a', {
      wallet: COLLECT_WALLET,
      lines: [
        { currency: 'coins', amount: 12, source: source as unknown as Element | null },
        { currency: 'pearls', amount: 25, source: null },
      ],
    });
  };

  it('keeps the Vault flat while an opened crate holds its coins', () => {
    const plaque = mountPlaque();
    expect(plaque.vault()).toBe('Vault balance: 80 coins');
    open(plaque);
    expect(plaque.vault()).toBe('Vault balance: 80 coins');
    plaque.store.setState({ coins: 95 });
    expect(plaque.vault()).toBe('Vault balance: 83 coins');
    plaque.dispose();
  });

  it('under reduced motion rolls the Vault by the coin line alone when a held fall is refused', () => {
    setMotionPreference('reduced');
    const plaque = mountPlaque();
    const seen: (string | undefined)[] = [];
    open(plaque);
    plaque.payout.hold('falls', { coins: 5 });
    plaque.store.setState({ coins: 97 });
    seen.push(plaque.vault());
    plaque.payout.retract('falls', { coins: 5 });
    plaque.store.setState({ coins: 92 });
    seen.push(plaque.vault());
    collect(plaque, null);
    seen.push(plaque.vault());
    expect(seen).toEqual([
      'Vault balance: 80 coins',
      'Vault balance: 80 coins',
      'Vault balance: 92 coins',
    ]);
    plaque.dispose();
  });

  it('under reduced motion shows the whole payout at once, with no flight', () => {
    setMotionPreference('reduced');
    const plaque = mountPlaque();
    open(plaque);
    collect(plaque, plaque.cardLine);
    expect(plaque.vault()).toBe('Vault balance: 92 coins');
    expect(plaque.chip('pearls').dataset.value).toBe('25');
    expect(plaque.chip('pearls').hidden).toBe(false);
    expect(plaque.host.querySelectorAll('.cp-wallet-flight')).toEqual([]);
    expect(plaque.cardLine.style.opacity).toBe('');
    expect(plaque.feedback).toEqual(['tick']);
    plaque.dispose();
  });

  it('flies each line to its readout and counts it in as it lands', () => {
    setMotionPreference('full');
    const plaque = mountPlaque();
    open(plaque);
    collect(plaque, plaque.cardLine);
    expect(plaque.host.querySelectorAll('.cp-wallet-flight')).toHaveLength(1);
    expect(plaque.cardLine.style.opacity).toBe('0');
    expect(plaque.vault()).toBe('Vault balance: 80 coins');
    expect(plaque.chip('pearls').hidden).toBe(false);

    vi.advanceTimersByTime(PAYOUT_FLIGHT_MS - 1);
    expect(plaque.vault()).toBe('Vault balance: 80 coins');
    vi.advanceTimersByTime(1);
    expect(plaque.vault()).toBe('Vault balance: 92 coins');
    expect(plaque.cardLine.style.opacity).toBe('');
    expect(plaque.host.querySelectorAll('.cp-wallet-flight')).toEqual([]);

    vi.advanceTimersByTime(PAYOUT_STAGGER_MS);
    expect(plaque.chip('pearls').dataset.value).toBe(String(COLLECT_WALLET.pearls));
    expect(plaque.chip('pearls').getAttribute('aria-label')).toBe('Pearls: 25');
    expect(plaque.feedback).toEqual(['tick', 'tick']);
    plaque.dispose();
  });

  it('labels the purse chips in the player language and hides the empty ones', () => {
    setMotionPreference('reduced');
    const plaque = mountPlaque('de');
    collect(plaque, null);
    expect(plaque.chip('pearls').getAttribute('aria-label')).toBe('Perlen: 25');
    expect(plaque.chip('keys').hidden).toBe(true);
    expect(plaque.host.querySelector('[data-testid="hud-wallet"]')?.hidden).toBe(false);
    plaque.dispose();
  });

  it('tears down mid-flight with no flight layer, timer or blanked card line left', () => {
    setMotionPreference('full');
    const plaque = mountPlaque();
    open(plaque);
    collect(plaque, plaque.cardLine);
    expect(plaque.host.querySelectorAll('.cp-wallet-flights')).toHaveLength(1);
    plaque.dispose();
    expect(plaque.host.querySelectorAll('.cp-wallet-flights')).toEqual([]);
    expect(plaque.cardLine.style.opacity).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
});

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function rulesMatching(test: (selector: string) => boolean): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((part) => test(part.trim()))) continue;
    const rule: Record<string, string> = {};
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      rule[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    out.push(rule);
  }
  return out;
}

/** Properties that repaint or composite but never move a box. */
const PAINT_ONLY = new Set([
  'opacity',
  'animation',
  'transition',
  'filter',
  'color',
  'text-shadow',
]);

/** The plaque as layout sees it: every node, its classes but the state class, and what is hidden. */
function layoutShape(node: FakeNode): string {
  const own = node.className
    .split(/\s+/)
    .filter((name) => name !== 'is-provisional')
    .join('.');
  const self = `${node.tagName}.${own}${node.hidden ? '[hidden]' : ''}`;
  return `${self}(${node.children.map(layoutShape).join(',')})`;
}

describe('createBalancePlaque waits for the house without moving the Vault', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows nothing on a normal round trip that confirms inside the reveal delay', () => {
    const plaque = mountPlaque();
    plaque.store.setState({ provisional: true });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS - 1);
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(false);
    plaque.store.setState({ provisional: false });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS * 2);
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(false);
    expect(plaque.plaque().getAttribute('aria-label')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    plaque.dispose();
  });

  it('says so once the balance has stayed provisional for the delay, and clears on confirm', () => {
    const plaque = mountPlaque();
    plaque.store.setState({ provisional: true });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS);
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(true);
    expect(plaque.plaque().getAttribute('role')).toBe('group');
    expect(plaque.plaque().getAttribute('aria-label')).toBe('Awaiting the house');
    plaque.store.setState({ provisional: false });
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(false);
    expect(plaque.plaque().getAttribute('aria-label')).toBeNull();
    plaque.dispose();
  });

  it('does not restart the delay when new claims arrive while it is already waiting', () => {
    const plaque = mountPlaque();
    plaque.store.setState({ provisional: true });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS / 2);
    plaque.store.setState({ provisional: true, coins: 81 });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS / 2);
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(true);
    plaque.dispose();
  });

  it('flickers nothing when the sync toggles faster than the delay', () => {
    const plaque = mountPlaque();
    for (let i = 0; i < 20; i += 1) {
      plaque.store.setState({ provisional: true });
      vi.advanceTimersByTime(300);
      plaque.store.setState({ provisional: false });
      vi.advanceTimersByTime(300);
      expect(plaque.plaque().classList.contains('is-provisional')).toBe(false);
    }
    plaque.dispose();
  });

  it('keeps the label in the player language, across a language switch', () => {
    const plaque = mountPlaque('fr');
    plaque.store.setState({ provisional: true });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS);
    expect(plaque.plaque().getAttribute('aria-label')).toBe('En attente de la maison');
    plaque.i18n.changeLanguage('de');
    expect(plaque.plaque().getAttribute('aria-label')).toBe('Das Haus bestätigt');
    plaque.dispose();
  });

  it('adds, shows or hides no node in the plaque while provisional', () => {
    const plaque = mountPlaque();
    const before = layoutShape(plaque.host);
    plaque.store.setState({ provisional: true });
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS);
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(true);
    expect(layoutShape(plaque.host)).toBe(before);
    expect(plaque.plaque().textContent).not.toContain('Awaiting the house');
    plaque.dispose();
  });

  it('styles the provisional state with paint-only properties', () => {
    const rules = rulesMatching((selector) => selector.includes('.cp-plaque.is-provisional'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const property of Object.keys(rule)) expect(PAINT_ONLY).toContain(property);
    }
    expect(css).not.toContain('.cp-plaque-provisional');
  });

  it('under reduced motion keeps the dim but drops the shimmer', () => {
    const [reduced] = rulesMatching(
      (selector) =>
        selector === ".cp-ui-host[data-motion='reduced'] .cp-plaque.is-provisional::after",
    );
    expect(reduced).toEqual({ animation: 'none', opacity: '0' });
    const [dim] = rulesMatching((selector) => selector === '.cp-plaque.is-provisional .cp-odo');
    expect(dim).toEqual({ opacity: '0.78' });
  });

  it('tears down with a reveal still pending and leaves no timer', () => {
    const plaque = mountPlaque();
    plaque.store.setState({ provisional: true });
    plaque.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PROVISIONAL_REVEAL_MS);
    expect(plaque.plaque().classList.contains('is-provisional')).toBe(false);
  });
});
