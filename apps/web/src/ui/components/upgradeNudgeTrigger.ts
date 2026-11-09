import type { UpgradeLineDef } from '@coinposh/economy';
import { upgradeRows, type UpgradeRow, type Wallet } from '../../app/model.ts';
import type { SettingsStorage } from '../../app/settings.ts';

export const UPGRADE_NUDGE_STORAGE_KEY = 'coinposh.nudge.firstUpgrade.v1';

export interface ActivationNavigator {
  readonly userActivation?: { readonly hasBeenActive: boolean } | undefined;
}

/**
 * Whether the page has had a user gesture, so audio and vibrate() will be allowed. Browsers
 * without the User Activation API (Safari < 16.4, Firefox < 120) count as activated.
 */
export function hasBeenActivated(nav: ActivationNavigator | undefined): boolean {
  return nav?.userActivation?.hasBeenActive ?? true;
}

export interface NudgeSnapshot extends Wallet {
  readonly upgradeLevels: Readonly<Record<string, number>>;
  /** False until the table is hydrated: a wallet seen before the levels arrive proves nothing. */
  readonly playable: boolean;
}

/**
 * The affordable line with the lowest price. Coin lines come first: a price in gold bars is
 * not comparable to one in coins, and bars are the scarcer purse.
 */
export function cheapestAffordable(rows: readonly UpgradeRow[]): UpgradeRow | null {
  const rank = (row: UpgradeRow): [number, number] => [
    row.line.currency === 'coins' ? 0 : 1,
    row.cost ?? Infinity,
  ];
  let best: UpgradeRow | null = null;
  for (const row of rows) {
    if (!row.affordable) continue;
    if (!best) {
      best = row;
      continue;
    }
    const [currency, cost] = rank(row);
    const [bestCurrency, bestCost] = rank(best);
    if (currency < bestCurrency || (currency === bestCurrency && cost < bestCost)) best = row;
  }
  return best;
}

export interface FirstUpgradeNudge {
  /** True once the hint has been offered or the player has bought anything; it never resets. */
  readonly retired: boolean;
  /** Returns the line to suggest the one time the hint fires, and null on every other call. */
  evaluate(snapshot: NudgeSnapshot): string | null;
}

function readRetired(storage: SettingsStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(UPGRADE_NUDGE_STORAGE_KEY) !== null;
  } catch (error) {
    console.warn('[CoinPosh] the upgrade hint flag could not be read; it may show again', error);
    return false;
  }
}

function writeRetired(storage: SettingsStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(UPGRADE_NUDGE_STORAGE_KEY, 'retired');
  } catch (error) {
    console.warn('[CoinPosh] the upgrade hint flag could not be saved; it may show again', error);
  }
}

/**
 * The once-per-profile "your first upgrade is affordable" hint. It fires for a fresh profile
 * (no line above level 0) the first time something becomes affordable, and is retired for
 * good, across reloads, the moment it fires or the player buys anything.
 */
export function createFirstUpgradeNudge(
  lines: readonly UpgradeLineDef[],
  storage: SettingsStorage | null,
): FirstUpgradeNudge {
  let retired = readRetired(storage);
  const retire = (): void => {
    retired = true;
    writeRetired(storage);
  };
  return {
    get retired() {
      return retired;
    },
    evaluate(snapshot) {
      if (retired || !snapshot.playable) return null;
      if (Object.values(snapshot.upgradeLevels).some((level) => level > 0)) {
        retire();
        return null;
      }
      const pick = cheapestAffordable(upgradeRows(lines, snapshot.upgradeLevels, snapshot));
      if (!pick) return null;
      retire();
      return pick.line.id;
    },
  };
}
