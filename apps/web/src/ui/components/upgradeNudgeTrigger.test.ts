import { upgradeCost, upgradeLines } from '@coinposh/economy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upgradeRows } from '../../app/model.ts';
import type { SettingsStorage } from '../../app/settings.ts';
import {
  NUDGE_CONFIRM_MS,
  NUDGE_HEADROOM_COINS,
  NUDGE_STEADY_MS,
  UPGRADE_NUDGE_STORAGE_KEY,
  cheapestAffordable,
  createFirstUpgradeNudge,
  hasBeenActivated,
  nudgeStillAffordable,
  type FirstUpgradeNudge,
  type NudgeSnapshot,
} from './upgradeNudgeTrigger.ts';
import { UPGRADE_SHEET_LINES } from '../panels/upgradesPanel.ts';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function line(id: string) {
  const found = upgradeLines.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`economy has no upgrade line "${id}"`);
  return found;
}

const coinLines = upgradeLines.filter((candidate) => candidate.currency === 'coins');
const cheapestCoinCost = Math.min(...coinLines.map((candidate) => upgradeCost(candidate, 0)));
const cheapestCoinLine = coinLines.find(
  (candidate) => upgradeCost(candidate, 0) === cheapestCoinCost,
);

const roomy = cheapestCoinCost + NUDGE_HEADROOM_COINS;

function snapshot(patch: Partial<NudgeSnapshot> = {}): NudgeSnapshot {
  return { coins: 0, goldBars: 0, upgradeLevels: {}, playable: true, ...patch };
}

/** Shows the nudge one wallet held through the confirm beat, and returns what it fired. */
function offer(nudge: FirstUpgradeNudge, wallet: NudgeSnapshot, at = 0): string | null {
  const early = nudge.evaluate(wallet, at);
  if (early !== null) return early;
  return nudge.evaluate(wallet, at + NUDGE_CONFIRM_MS);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cheapestAffordable', () => {
  it('returns null when nothing is affordable', () => {
    expect(cheapestAffordable(upgradeRows(upgradeLines, {}, { coins: 0, goldBars: 0 }))).toBe(null);
  });

  it('picks the lowest coin price among the affordable lines', () => {
    const rows = upgradeRows(upgradeLines, {}, { coins: 10_000, goldBars: 0 });
    expect(cheapestAffordable(rows)?.line.id).toBe(cheapestCoinLine?.id);
  });

  it('prefers a coin line over a gold-bar line with a smaller number on its tag', () => {
    const bars = line('oldMoney');
    const rows = upgradeRows(upgradeLines, {}, { coins: cheapestCoinCost, goldBars: 1_000 });
    expect(upgradeCost(bars, 0)).toBeLessThan(cheapestCoinCost);
    expect(cheapestAffordable(rows)?.line.currency).toBe('coins');
  });

  it('falls back to a gold-bar line when no coin line is affordable', () => {
    const rows = upgradeRows(upgradeLines, {}, { coins: 0, goldBars: 1_000 });
    expect(cheapestAffordable(rows)?.line.currency).toBe('goldBars');
  });

  it('skips maxed lines', () => {
    const tempo = line('pusherSpeed');
    const rows = upgradeRows(
      upgradeLines,
      { [tempo.id]: tempo.maxLevel },
      { coins: 1e12, goldBars: 0 },
    );
    expect(cheapestAffordable(rows)?.line.id).not.toBe(tempo.id);
  });
});

describe('createFirstUpgradeNudge', () => {
  it('stays quiet while nothing is affordable, then fires once with headroom', () => {
    const storage = new MemoryStorage();
    const nudge = createFirstUpgradeNudge(upgradeLines, storage);
    expect(nudge.evaluate(snapshot({ coins: cheapestCoinCost - 1 }), 0)).toBe(null);
    expect(nudge.retired).toBe(false);
    expect(nudge.wakeAt).toBe(null);
    expect(storage.items.size).toBe(0);

    expect(offer(nudge, snapshot({ coins: roomy }), 10)).toBe(cheapestCoinLine?.id);
    expect(nudge.retired).toBe(true);
    expect(nudge.wakeAt).toBe(null);
    expect(storage.getItem(UPGRADE_NUDGE_STORAGE_KEY)).not.toBe(null);

    expect(nudge.evaluate(snapshot({ coins: roomy }), 20)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: 0 }), 30)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }), 40)).toBe(null);
  });

  it('never fires again after a reload once it has fired', () => {
    const storage = new MemoryStorage();
    expect(
      offer(createFirstUpgradeNudge(upgradeLines, storage), snapshot({ coins: 10_000 })),
    ).not.toBe(null);
    const reloaded = createFirstUpgradeNudge(upgradeLines, storage);
    expect(reloaded.retired).toBe(true);
    expect(offer(reloaded, snapshot({ coins: 10_000 }))).toBe(null);
  });

  it('retires for good, without firing, for a profile that has already bought something', () => {
    const storage = new MemoryStorage();
    const nudge = createFirstUpgradeNudge(upgradeLines, storage);
    expect(nudge.evaluate(snapshot({ coins: 10_000, upgradeLevels: { pusherSpeed: 1 } }), 0)).toBe(
      null,
    );
    expect(nudge.retired).toBe(true);
    expect(offer(nudge, snapshot({ coins: 10_000 }))).toBe(null);
    expect(createFirstUpgradeNudge(upgradeLines, storage).retired).toBe(true);
  });

  it('treats levels listed at 0 as a fresh profile', () => {
    const nudge = createFirstUpgradeNudge(upgradeLines, new MemoryStorage());
    expect(offer(nudge, snapshot({ coins: roomy, upgradeLevels: { pusherSpeed: 0 } }))).toBe(
      cheapestCoinLine?.id,
    );
  });

  it('waits for the table to be playable before judging the wallet', () => {
    const storage = new MemoryStorage();
    const nudge = createFirstUpgradeNudge(upgradeLines, storage);
    expect(offer(nudge, snapshot({ coins: 10_000, playable: false }))).toBe(null);
    expect(nudge.retired).toBe(false);
    expect(offer(nudge, snapshot({ coins: 10_000 }), 1_000)).not.toBe(null);
  });

  it('still fires only once per session when storage is unavailable', () => {
    const nudge = createFirstUpgradeNudge(upgradeLines, null);
    expect(offer(nudge, snapshot({ coins: 10_000 }))).not.toBe(null);
    expect(offer(nudge, snapshot({ coins: 10_000 }), 1_000)).toBe(null);
  });

  it('warns and still fires once per session when storage throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: SettingsStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      },
    };
    const nudge = createFirstUpgradeNudge(upgradeLines, broken);
    expect(offer(nudge, snapshot({ coins: 10_000 }))).not.toBe(null);
    expect(offer(nudge, snapshot({ coins: 10_000 }), 1_000)).toBe(null);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('first-upgrade headroom', () => {
  const price = cheapestCoinCost;
  const fresh = () => createFirstUpgradeNudge(upgradeLines, new MemoryStorage());

  it('cushions the price by a few taps, so reading the line cannot spend the Vault under it', () => {
    expect(NUDGE_HEADROOM_COINS).toBeGreaterThanOrEqual(3);
    expect(NUDGE_HEADROOM_COINS).toBeLessThan(price);
    expect(NUDGE_STEADY_MS).toBeGreaterThanOrEqual(1_000);
    expect(NUDGE_STEADY_MS).toBeLessThanOrEqual(2_000);
    expect(NUDGE_CONFIRM_MS).toBeLessThan(NUDGE_STEADY_MS / 4);
  });

  it('fires a beat after the Vault clears the price by the headroom, and not a coin sooner', () => {
    const nudge = fresh();
    expect(nudge.evaluate(snapshot({ coins: roomy - 1 }), 0)).toBe(null);
    expect(nudge.wakeAt).toBe(NUDGE_STEADY_MS);
    expect(nudge.evaluate(snapshot({ coins: roomy }), 100)).toBe(null);
    expect(nudge.wakeAt).toBe(100 + NUDGE_CONFIRM_MS);
    expect(nudge.evaluate(snapshot({ coins: roomy }), 100 + NUDGE_CONFIRM_MS - 1)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: roomy + 3 }), 100 + NUDGE_CONFIRM_MS)).toBe(
      cheapestCoinLine?.id,
    );
  });

  it('ignores a reading that overstates the Vault for a moment, as when wallet and buffer land apart', () => {
    const nudge = fresh();
    expect(nudge.evaluate(snapshot({ coins: price * 2 }), 0)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price - 5 }), 7)).toBe(null);
    expect(nudge.wakeAt).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price - 5 }), NUDGE_STEADY_MS * 2)).toBe(null);
    expect(nudge.retired).toBe(false);
  });

  it('restarts the confirm beat when the Vault dips under the headroom', () => {
    const nudge = fresh();
    expect(nudge.evaluate(snapshot({ coins: roomy }), 0)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: roomy - 1 }), 100)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: roomy + 4 }), 200)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: roomy + 4 }), NUDGE_CONFIRM_MS)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: roomy + 4 }), 200 + NUDGE_CONFIRM_MS)).toBe(
      cheapestCoinLine?.id,
    );
  });

  it('never fires while every tap keeps spending the Vault back across the price', () => {
    const nudge = fresh();
    const tape = [price, price - 1, price - 2, price + 1, price, price - 1, price + 2, price + 1];
    tape.forEach((coins, tap) => {
      expect(nudge.evaluate(snapshot({ coins }), tap * 400)).toBe(null);
    });
    expect(nudge.retired).toBe(false);
  });

  it('fires a tight balance only after it has held the price for the steady window', () => {
    const nudge = fresh();
    expect(nudge.evaluate(snapshot({ coins: price }), 1_000)).toBe(null);
    expect(nudge.wakeAt).toBe(1_000 + NUDGE_STEADY_MS);
    expect(nudge.evaluate(snapshot({ coins: price }), 1_000 + NUDGE_STEADY_MS - 1)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price }), 1_000 + NUDGE_STEADY_MS)).toBe(
      cheapestCoinLine?.id,
    );
    expect(nudge.wakeAt).toBe(null);
  });

  it('restarts the steady window on every drop, even one that stays above the price', () => {
    const nudge = fresh();
    expect(nudge.evaluate(snapshot({ coins: price + 2 }), 0)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price + 1 }), 1_000)).toBe(null);
    expect(nudge.wakeAt).toBe(1_000 + NUDGE_STEADY_MS);
    expect(nudge.evaluate(snapshot({ coins: price + 1 }), NUDGE_STEADY_MS)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price + 1 }), 1_000 + NUDGE_STEADY_MS)).toBe(
      cheapestCoinLine?.id,
    );
  });

  it('keeps the steady window running while the Vault only climbs', () => {
    const nudge = fresh();
    expect(nudge.evaluate(snapshot({ coins: price }), 0)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price + 1 }), 700)).toBe(null);
    expect(nudge.wakeAt).toBe(NUDGE_STEADY_MS);
    expect(nudge.evaluate(snapshot({ coins: price + 1 }), NUDGE_STEADY_MS)).toBe(
      cheapestCoinLine?.id,
    );
  });

  it('forgets the steady window once the Vault falls under the price', () => {
    const nudge = fresh();
    nudge.evaluate(snapshot({ coins: price }), 0);
    expect(nudge.evaluate(snapshot({ coins: price - 1 }), 500)).toBe(null);
    expect(nudge.wakeAt).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price }), 1_000)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price }), NUDGE_STEADY_MS)).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price }), 1_000 + NUDGE_STEADY_MS)).toBe(
      cheapestCoinLine?.id,
    );
  });

  it('forgets the steady window while the table is not playable', () => {
    const nudge = fresh();
    nudge.evaluate(snapshot({ coins: price }), 0);
    expect(nudge.evaluate(snapshot({ coins: price, playable: false }), 500)).toBe(null);
    expect(nudge.wakeAt).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: price }), NUDGE_STEADY_MS)).toBe(null);
  });

  it('only ever suggests a line the wallet it fired on can buy', () => {
    const roomyNudge = fresh();
    const roomyId = offer(roomyNudge, snapshot({ coins: roomy }));
    expect(nudgeStillAffordable(upgradeLines, roomyId ?? '', snapshot({ coins: roomy }))).toBe(
      true,
    );

    const steadyNudge = fresh();
    steadyNudge.evaluate(snapshot({ coins: price }), 0);
    const steadyId = steadyNudge.evaluate(snapshot({ coins: price }), NUDGE_STEADY_MS);
    expect(nudgeStillAffordable(upgradeLines, steadyId ?? '', snapshot({ coins: price }))).toBe(
      true,
    );
  });

  it('needs no cushion for a gold-bar price, which taps never spend', () => {
    const barLines = upgradeLines.filter((candidate) => candidate.currency === 'goldBars');
    const barPrice = Math.min(...barLines.map((candidate) => upgradeCost(candidate, 0)));
    const nudge = fresh();
    const id = offer(nudge, snapshot({ goldBars: barPrice }));
    expect(barLines.map((candidate) => candidate.id)).toContain(id);
  });

  it('never points at a Family Office line when given only the lines the sheet lists', () => {
    const barLines = upgradeLines.filter((candidate) => candidate.currency === 'goldBars');
    const barPrice = Math.max(...barLines.map((candidate) => upgradeCost(candidate, 0)));
    const nudge = createFirstUpgradeNudge(UPGRADE_SHEET_LINES, new MemoryStorage());
    expect(offer(nudge, snapshot({ goldBars: barPrice }))).toBe(null);
    expect(offer(nudge, snapshot({ goldBars: barPrice, coins: roomy }), 10_000)).toBe(
      cheapestCoinLine?.id,
    );
  });
});

describe('nudgeStillAffordable', () => {
  const price = cheapestCoinCost;
  const id = cheapestCoinLine?.id ?? '';

  it('holds while the wallet covers the next level, and lapses one coin under it', () => {
    expect(nudgeStillAffordable(upgradeLines, id, snapshot({ coins: price }))).toBe(true);
    expect(nudgeStillAffordable(upgradeLines, id, snapshot({ coins: price - 1 }))).toBe(false);
  });

  it('prices the level the profile is on, not level 0', () => {
    const owned = { [id]: 1 };
    const next = upgradeCost(line(id), 1);
    expect(next).toBeGreaterThan(price);
    expect(
      nudgeStillAffordable(upgradeLines, id, snapshot({ coins: price, upgradeLevels: owned })),
    ).toBe(false);
    expect(
      nudgeStillAffordable(upgradeLines, id, snapshot({ coins: next, upgradeLevels: owned })),
    ).toBe(true);
  });

  it('is false for a maxed or unknown line', () => {
    const tempo = line('pusherSpeed');
    const maxed = { [tempo.id]: tempo.maxLevel };
    expect(
      nudgeStillAffordable(upgradeLines, tempo.id, snapshot({ coins: 1e12, upgradeLevels: maxed })),
    ).toBe(false);
    expect(nudgeStillAffordable(upgradeLines, 'noSuchLine', snapshot({ coins: 1e12 }))).toBe(false);
  });
});

describe('hasBeenActivated', () => {
  it('follows userActivation.hasBeenActive where the API exists', () => {
    expect(hasBeenActivated({ userActivation: { hasBeenActive: false } })).toBe(false);
    expect(hasBeenActivated({ userActivation: { hasBeenActive: true } })).toBe(true);
  });

  it('treats a browser without the User Activation API as activated instead of throwing', () => {
    expect(hasBeenActivated({})).toBe(true);
    expect(hasBeenActivated({ userActivation: undefined })).toBe(true);
    expect(hasBeenActivated(undefined)).toBe(true);
  });
});
