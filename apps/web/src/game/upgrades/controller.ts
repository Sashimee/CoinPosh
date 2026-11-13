import {
  endpoints,
  ErrorCodeSchema,
  IdempotencyKeySchema,
  type ErrorCode,
  type IdempotencyKey,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
  type VenueId,
} from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { UiApp } from '../../app/index.ts';
import type { UpgradeEvents, UpgradeRejection } from './events.ts';
import { isFamilyOfficeLine, isUpgradeLineV1 } from './lines.ts';

/**
 * The one network call a purchase makes. Resolve with the server's response, or reject with
 * the net layer's error: an `ApiRequestError` carries the envelope `code`, a `NetworkError`
 * means the request may never have arrived.
 */
export interface UpgradeApi {
  buy(body: UpgradeBuyRequest, idempotencyKey: IdempotencyKey): Promise<UpgradeBuyResponse>;
}

export type UpgradeUi = Pick<
  UiApp,
  'store' | 'bus' | 'onUpgradeRequest' | 'setWallet' | 'resolveUpgrade'
>;

export interface BindUpgradesOptions {
  readonly ui: UpgradeUi;
  readonly api: UpgradeApi;
  /** A getter follows the venue the player is on, which changes when they ascend. */
  readonly venueId: VenueId | (() => VenueId);
  readonly events: Bus<UpgradeEvents>;
  readonly newKey?: () => IdempotencyKey;
  /** Re-reads GET /v1/state; called when the levels on screen turned out to be stale. */
  readonly refresh?: () => void;
  /** Where errors the player cannot act on are reported. */
  readonly onError?: (error: unknown) => void;
  /**
   * Family Office lines are bought with Gold Bars on the ascension screen, never as venue
   * upgrades: a request for one is handed here instead. Without it the request is refused.
   */
  readonly onFamilyOffice?: (lineId: string) => void;
}

const REJECTIONS: Partial<Record<ErrorCode, UpgradeRejection>> = {
  insufficient_funds: 'unaffordable',
  conflict: 'stale',
  not_found: 'unavailable',
  forbidden: 'unavailable',
  feature_disabled: 'unavailable',
};

function errorCode(error: unknown): ErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const parsed = ErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : null;
}

export function classifyRejection(error: unknown): UpgradeRejection {
  const code = errorCode(error);
  if (code !== null) return REJECTIONS[code] ?? 'error';
  if (error instanceof Error && error.name === 'NetworkError') return 'offline';
  return 'error';
}

function freshKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

/**
 * Turns the upgrades panel's requests into server purchases. The client names only the
 * line and the level it expects; the price, the new level and the wallet all come back
 * from the server, and nothing on screen changes until they do.
 */
export function bindUpgrades(options: BindUpgradesOptions): () => void {
  const { ui, api, events, venueId: venue } = options;
  const venueId = typeof venue === 'function' ? venue : () => venue;
  const newKey = options.newKey ?? freshKey;
  let live = true;

  const reject = (lineId: string, level: number, reason: UpgradeRejection): void => {
    ui.resolveUpgrade();
    ui.bus.emit('ui:feedback', { kind: 'deny' });
    events.emit('upgrade:rejected', { lineId, level, reason });
    if (reason === 'stale') options.refresh?.();
  };

  const purchase = async (lineId: string, level: number): Promise<void> => {
    if (isFamilyOfficeLine(lineId) && options.onFamilyOffice) {
      ui.resolveUpgrade();
      options.onFamilyOffice(lineId);
      return;
    }
    if (!isUpgradeLineV1(lineId)) {
      reject(lineId, level, 'unavailable');
      return;
    }
    events.emit('upgrade:requested', { lineId, level });
    let response: UpgradeBuyResponse;
    try {
      const body = endpoints.upgradesBuy.body.parse({ venueId: venueId(), lineId, level });
      response = await api.buy(body, newKey());
    } catch (error) {
      if (!live) return;
      const reason = classifyRejection(error);
      if (reason === 'error') options.onError?.(error);
      reject(lineId, level, reason);
      return;
    }
    if (!live) return;
    ui.setWallet({ coins: response.wallet.coins, goldBars: response.wallet.goldBars });
    ui.resolveUpgrade({ ...ui.store.getState().upgradeLevels, [response.lineId]: response.level });
    events.emit('upgrade:purchased', {
      lineId: response.lineId,
      level: response.level,
      wallet: response.wallet,
    });
  };

  const off = ui.onUpgradeRequest(({ lineId, fromLevel }) => {
    void purchase(lineId, fromLevel + 1);
  });
  return () => {
    live = false;
    off();
  };
}
