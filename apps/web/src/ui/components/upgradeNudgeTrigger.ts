import { coinTiers, rateEnvelopeDerivation, type UpgradeLineDef } from '@coinposh/economy';
import { spendableCoins, upgradeRows, type UpgradeRow, type Wallet } from '../../app/model.ts';
import type { SettingsStorage } from '../../app/settings.ts';

export const UPGRADE_NUDGE_STORAGE_KEY = 'coinposh.nudge.firstUpgrade.v1';

/** How long spendable coins must sit at or above a price without dropping before a tight buy is offered. */
export const NUDGE_STEADY_MS = 1_500;

/**
 * How long a balance with headroom must hold it before the hint fires. The wallet and the
 * table's balance events can land a few milliseconds apart, so a single reading can overstate
 * it for a moment.
 */
export const NUDGE_CONFIRM_MS = 250;

/**
 * Coins above the price that fire the hint after only `NUDGE_CONFIRM_MS`: what the fastest
 * honest tapping spends, one copper drop a tap, while the line is read, so BUY is still lit.
 */
export const NUDGE_HEADROOM_COINS =
  Math.ceil((NUDGE_STEADY_MS / 1000) * rateEnvelopeDerivation.honestTapsPerSecond) *
  coinTiers[0].value;

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

/** What the server can spend on the row's price: drop-buffer coins never count. */
function purse(wallet: Wallet, row: UpgradeRow): number {
  return row.line.currency === 'coins' ? spendableCoins(wallet) : wallet.goldBars;
}

/** Drops spend coins only, so a gold-bar price needs no cushion. */
function headroomFor(row: UpgradeRow): number {
  return row.line.currency === 'coins' ? NUDGE_HEADROOM_COINS : 0;
}

/** Whether the suggested line can still be bought with this wallet; false for an unknown line. */
export function nudgeStillAffordable(
  lines: readonly UpgradeLineDef[],
  lineId: string,
  snapshot: Wallet & Pick<NudgeSnapshot, 'upgradeLevels'>,
): boolean {
  const row = upgradeRows(lines, snapshot.upgradeLevels, snapshot).find(
    (candidate) => candidate.line.id === lineId,
  );
  return row?.affordable ?? false;
}

export interface FirstUpgradeNudge {
  /** True once the hint has been offered or the player has bought anything; it never resets. */
  readonly retired: boolean;
  /**
   * When a tight but steady balance will be ripe, in the clock `evaluate` was given; evaluate
   * again then even if the wallet has not changed. Null when nothing is waiting.
   */
  readonly wakeAt: number | null;
  /**
   * Returns the line to suggest the one time the hint fires, and null on every other call.
   * It fires once the balance has cleared the price by `NUDGE_HEADROOM_COINS` for
   * `NUDGE_CONFIRM_MS`, or has stayed affordable for `NUDGE_STEADY_MS` without dropping.
   * `now` is in milliseconds.
   */
  evaluate(snapshot: NudgeSnapshot, now: number): string | null;
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
 * (no line above level 0) the first time something is affordable with room to spare, and is
 * retired for good, across reloads, the moment it fires or the player buys anything.
 */
export function createFirstUpgradeNudge(
  lines: readonly UpgradeLineDef[],
  storage: SettingsStorage | null,
): FirstUpgradeNudge {
  let retired = readRetired(storage);
  let steady: {
    lineId: string;
    since: number;
    balance: number;
    roomySince: number | null;
  } | null = null;
  const retire = (): void => {
    retired = true;
    steady = null;
    writeRetired(storage);
  };
  const fire = (lineId: string): string => {
    retire();
    return lineId;
  };
  return {
    get retired() {
      return retired;
    },
    get wakeAt() {
      if (!steady) return null;
      const settled = steady.since + NUDGE_STEADY_MS;
      return steady.roomySince === null
        ? settled
        : Math.min(settled, steady.roomySince + NUDGE_CONFIRM_MS);
    },
    evaluate(snapshot, now) {
      if (retired) return null;
      if (!snapshot.playable) {
        steady = null;
        return null;
      }
      if (Object.values(snapshot.upgradeLevels).some((level) => level > 0)) {
        retire();
        return null;
      }
      const pick = cheapestAffordable(upgradeRows(lines, snapshot.upgradeLevels, snapshot));
      if (!pick) {
        steady = null;
        return null;
      }
      const balance = purse(snapshot, pick);
      const roomy = balance >= (pick.cost ?? Infinity) + headroomFor(pick);
      if (steady?.lineId !== pick.line.id) {
        steady = { lineId: pick.line.id, since: now, balance, roomySince: null };
      }
      if (balance < steady.balance) steady.since = now;
      steady.balance = balance;
      steady.roomySince = roomy ? (steady.roomySince ?? now) : null;
      const confirmed = steady.roomySince !== null && now - steady.roomySince >= NUDGE_CONFIRM_MS;
      return confirmed || now - steady.since >= NUDGE_STEADY_MS ? fire(pick.line.id) : null;
    },
  };
}
