import {
  endpoints,
  ErrorCodeSchema,
  IdempotencyKeySchema,
  type AscendRequest,
  type AscendResponse,
  type ErrorCode,
  type IdempotencyKey,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
  type VenueId,
} from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { AscensionEvents, AscensionRejection } from './events.ts';

/**
 * The network calls the prestige loop makes. Resolve with the server's response, or reject
 * with the net layer's error: an `ApiRequestError` carries the envelope `code`, a
 * `NetworkError` means the request may never have arrived.
 */
export interface AscensionApi {
  ascend(body: AscendRequest, idempotencyKey: IdempotencyKey): Promise<AscendResponse>;
  buyFamilyOffice(
    body: UpgradeBuyRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<UpgradeBuyResponse>;
}

const REJECTIONS: Partial<Record<ErrorCode, AscensionRejection>> = {
  not_ready: 'notReady',
  conflict: 'stale',
  forbidden: 'locked',
  not_found: 'locked',
  feature_disabled: 'locked',
  insufficient_funds: 'unaffordable',
};

function errorCode(error: unknown): ErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const parsed = ErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : null;
}

export function classifyAscensionRejection(error: unknown): AscensionRejection {
  const code = errorCode(error);
  if (code !== null) return REJECTIONS[code] ?? 'error';
  if (error instanceof Error && error.name === 'NetworkError') return 'offline';
  return 'error';
}

export type Outcome<T> =
  | { readonly ok: true; readonly response: T }
  | { readonly ok: false; readonly reason: AscensionRejection; readonly error: unknown };

export interface AscensionControllerOptions {
  readonly api: AscensionApi;
  readonly events: Bus<AscensionEvents>;
  readonly newKey?: () => IdempotencyKey;
}

export interface AscensionController {
  /** One ascension at a time: a second call while one is in flight gets the same promise. */
  ascend(venueId: VenueId): Promise<Outcome<AscendResponse>>;
  buyFamilyOffice(
    venueId: VenueId,
    lineId: string,
    level: number,
  ): Promise<Outcome<UpgradeBuyResponse>>;
  readonly busy: boolean;
}

function freshKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

/**
 * Sends ascensions and Family Office purchases. The client names only the venue (and the
 * line and level it expects); eligibility, the payout and every balance come back from the
 * server. A request that went offline may have landed, so its retry reuses the same
 * Idempotency-Key and the server replays it instead of paying twice.
 */
export function createAscensionController(
  options: AscensionControllerOptions,
): AscensionController {
  const { api, events } = options;
  const newKey = options.newKey ?? freshKey;
  const retryKeys = new Map<string, IdempotencyKey>();
  let ascending: Promise<Outcome<AscendResponse>> | null = null;
  const buying = new Map<string, Promise<Outcome<UpgradeBuyResponse>>>();

  async function send<T>(
    slot: string,
    run: (key: IdempotencyKey) => Promise<T>,
  ): Promise<Outcome<T>> {
    const key = retryKeys.get(slot) ?? newKey();
    retryKeys.set(slot, key);
    try {
      const response = await run(key);
      retryKeys.delete(slot);
      return { ok: true, response };
    } catch (error) {
      const reason = classifyAscensionRejection(error);
      if (reason !== 'offline') retryKeys.delete(slot);
      return { ok: false, reason, error };
    }
  }

  return {
    get busy() {
      return ascending !== null;
    },

    ascend(venueId) {
      if (ascending !== null) return ascending;
      events.emit('ascension:requested', { venueId });
      const body = endpoints.ascend.body.parse({ venueId });
      ascending = send(`ascend:${venueId}`, (key) => api.ascend(body, key)).then((outcome) => {
        ascending = null;
        if (outcome.ok) {
          events.emit('ascension:confirmed', {
            venueId: outcome.response.venueId,
            goldBarsGranted: outcome.response.goldBarsGranted,
            unlockedVenueId: outcome.response.unlockedVenueId,
            wallet: outcome.response.wallet,
          });
        } else {
          events.emit('ascension:rejected', { venueId, reason: outcome.reason });
        }
        return outcome;
      });
      return ascending;
    },

    buyFamilyOffice(venueId, lineId, level) {
      const slot = `familyOffice:${lineId}:${level}`;
      const pending = buying.get(lineId);
      if (pending !== undefined) return pending;
      events.emit('familyOffice:requested', { lineId, level });
      const body = endpoints.upgradesBuy.body.parse({ venueId, lineId, level });
      const request = send(slot, (key) => api.buyFamilyOffice(body, key)).then((outcome) => {
        buying.delete(lineId);
        if (outcome.ok) {
          events.emit('familyOffice:purchased', {
            lineId: outcome.response.lineId,
            level: outcome.response.level,
            wallet: outcome.response.wallet,
          });
        } else {
          events.emit('familyOffice:rejected', { lineId, level, reason: outcome.reason });
        }
        return outcome;
      });
      buying.set(lineId, request);
      return request;
    },
  };
}
