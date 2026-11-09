import { upgradeCost, upgradeLines } from '@coinposh/economy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upgradeRows } from '../../app/model.ts';
import type { SettingsStorage } from '../../app/settings.ts';
import {
  UPGRADE_NUDGE_STORAGE_KEY,
  cheapestAffordable,
  createFirstUpgradeNudge,
  hasBeenActivated,
  type NudgeSnapshot,
} from './upgradeNudgeTrigger.ts';

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

function snapshot(patch: Partial<NudgeSnapshot> = {}): NudgeSnapshot {
  return { coins: 0, goldBars: 0, upgradeLevels: {}, playable: true, ...patch };
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
  it('stays quiet while nothing is affordable, then fires once at the first affordable line', () => {
    const storage = new MemoryStorage();
    const nudge = createFirstUpgradeNudge(upgradeLines, storage);
    expect(nudge.evaluate(snapshot({ coins: cheapestCoinCost - 1 }))).toBe(null);
    expect(nudge.retired).toBe(false);
    expect(storage.items.size).toBe(0);

    expect(nudge.evaluate(snapshot({ coins: cheapestCoinCost }))).toBe(cheapestCoinLine?.id);
    expect(nudge.retired).toBe(true);
    expect(storage.getItem(UPGRADE_NUDGE_STORAGE_KEY)).not.toBe(null);

    expect(nudge.evaluate(snapshot({ coins: cheapestCoinCost }))).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: 0 }))).toBe(null);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).toBe(null);
  });

  it('never fires again after a reload once it has fired', () => {
    const storage = new MemoryStorage();
    expect(
      createFirstUpgradeNudge(upgradeLines, storage).evaluate(snapshot({ coins: 10_000 })),
    ).not.toBe(null);
    const reloaded = createFirstUpgradeNudge(upgradeLines, storage);
    expect(reloaded.retired).toBe(true);
    expect(reloaded.evaluate(snapshot({ coins: 10_000 }))).toBe(null);
  });

  it('retires for good, without firing, for a profile that has already bought something', () => {
    const storage = new MemoryStorage();
    const nudge = createFirstUpgradeNudge(upgradeLines, storage);
    expect(nudge.evaluate(snapshot({ coins: 10_000, upgradeLevels: { pusherSpeed: 1 } }))).toBe(
      null,
    );
    expect(nudge.retired).toBe(true);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).toBe(null);
    expect(createFirstUpgradeNudge(upgradeLines, storage).retired).toBe(true);
  });

  it('treats levels listed at 0 as a fresh profile', () => {
    const nudge = createFirstUpgradeNudge(upgradeLines, new MemoryStorage());
    expect(
      nudge.evaluate(snapshot({ coins: cheapestCoinCost, upgradeLevels: { pusherSpeed: 0 } })),
    ).toBe(cheapestCoinLine?.id);
  });

  it('waits for the table to be playable before judging the wallet', () => {
    const storage = new MemoryStorage();
    const nudge = createFirstUpgradeNudge(upgradeLines, storage);
    expect(nudge.evaluate(snapshot({ coins: 10_000, playable: false }))).toBe(null);
    expect(nudge.retired).toBe(false);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).not.toBe(null);
  });

  it('still fires only once per session when storage is unavailable', () => {
    const nudge = createFirstUpgradeNudge(upgradeLines, null);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).not.toBe(null);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).toBe(null);
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
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).not.toBe(null);
    expect(nudge.evaluate(snapshot({ coins: 10_000 }))).toBe(null);
    expect(warn).toHaveBeenCalledTimes(2);
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
