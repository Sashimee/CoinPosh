import { upgradeLines } from '@coinposh/economy';
import type { DecorumState } from './model.ts';
import type { Settings } from './settings.ts';

export type PanelId = 'upgrades' | 'settings';

/**
 * Presentation state only. Every number here is what the server (or the Demo Mode mock)
 * last reported; the UI never computes value, it only shows it.
 */
export interface UiState {
  /** The Vault as shown: wallet, drop buffer and winnings still waiting on the server. */
  readonly coins: number;
  /** The share of `coins` the server can spend now; what upgrade prices are checked against. */
  readonly spendableCoins: number;
  readonly goldBars: number;
  /** True while claims are queued offline and not yet confirmed by the server. */
  readonly provisional: boolean;
  readonly cascadeCount: number;
  readonly decorum: DecorumState;
  readonly upgradeLevels: Readonly<Record<string, number>>;
  /** Upgrade line whose purchase request is waiting on the server. */
  readonly pendingUpgrade: string | null;
  readonly panel: PanelId | null;
  readonly settings: Settings;
}

export type FeedbackKind = 'tap' | 'open' | 'close' | 'confirm' | 'deny' | 'tick' | 'toggle';

export interface UiEvents {
  /** Every press: the feedback layer turns it into sound and haptics. */
  'ui:feedback': { readonly kind: FeedbackKind };
  /** The player asked to buy the next level of a line; the game layer sends it to the server. */
  'upgrades:request': { readonly lineId: string; readonly fromLevel: number };
}

const BASE_DECORUM_CAPACITY =
  upgradeLines.find((line) => line.effect.stat === 'decorumCapacity')?.effect.base ?? 0;

export function initialUiState(settings: Settings): UiState {
  return {
    coins: 0,
    spendableCoins: 0,
    goldBars: 0,
    provisional: false,
    cascadeCount: 0,
    decorum: { used: 0, capacity: BASE_DECORUM_CAPACITY, frozenSeconds: 0 },
    upgradeLevels: {},
    pendingUpgrade: null,
    panel: null,
    settings,
  };
}
