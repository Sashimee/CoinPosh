import { WalletSchema, type Wallet } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHold,
  PAYOUT_HOLD_CAP_MS,
  PayoutLedger,
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

  it('lets an uncollected crate go after the cap, with a warning', () => {
    const { ledger: book, warnings } = ledger();
    book.coins.observe(40);
    book.hold('a', { coins: 6 });
    book.coins.observe(46);
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
    book.collect('a', { wallet: wallet({ coins: 6 }), lines: [line('coins', 6)] });
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
    vi.advanceTimersByTime(100);
    expect(book.goldBars.shown).toBe(3);
    expect(warnings).toHaveLength(1);
  });

  it('releaseAll empties every hold and timer, as on teardown', () => {
    const { ledger: book, warnings } = ledger(100);
    book.coins.observe(0);
    book.hold('a', { coins: 4 });
    book.hold('b', { coins: 4 });
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
      collect: (id) => calls.push(`collect ${id}`),
      release: (id) => calls.push(`release ${id}`),
    };
    channel.hold('early', { coins: 1 });
    const detach = channel.attach(view);
    channel.hold('a', { coins: 1 });
    channel.collect('a', { wallet: wallet({}), lines: [] });
    channel.release('b');
    detach();
    channel.release('late');
    expect(calls).toEqual(['hold a', 'collect a', 'release b']);
  });
});
