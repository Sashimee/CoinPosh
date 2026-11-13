import {
  endpoints,
  ErrorCodeSchema,
  IdempotencyKeySchema,
  type ErrorCode,
  type IdempotencyKey,
  type PityCounters,
  type SafeId,
  type SafeOpenMethod,
  type SafeOpenRequest,
  type SafeOpenResponse,
} from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { SafeEvents, SafeRejection } from './events.ts';

/**
 * The one network call safes make. Resolve with the server's response, or reject with the net
 * layer's error: an `ApiRequestError` carries the envelope `code`, a `NetworkError` means the
 * request may never have arrived.
 */
export interface SafesApi {
  open(body: SafeOpenRequest, idempotencyKey: IdempotencyKey): Promise<SafeOpenResponse>;
}

const REJECTIONS: Partial<Record<ErrorCode, SafeRejection>> = {
  not_ready: 'notReady',
  insufficient_funds: 'noKeys',
  not_found: 'gone',
  conflict: 'gone',
  forbidden: 'unavailable',
  feature_disabled: 'unavailable',
};

function errorCode(error: unknown): ErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const parsed = ErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : null;
}

export function classifySafeRejection(error: unknown): SafeRejection {
  const code = errorCode(error);
  if (code !== null) return REJECTIONS[code] ?? 'error';
  if (error instanceof Error && error.name === 'NetworkError') return 'offline';
  return 'error';
}

export type SafeOutcome =
  | {
      readonly ok: true;
      readonly method: SafeOpenMethod;
      readonly response: SafeOpenResponse;
      /** The server's pity counters after this roll. */
      readonly pity: PityCounters;
    }
  | {
      readonly ok: false;
      readonly method: SafeOpenMethod;
      readonly reason: SafeRejection;
      readonly error: unknown;
    };

export interface SafesControllerOptions {
  readonly api: SafesApi;
  readonly events: Bus<SafeEvents>;
  readonly newKey?: () => IdempotencyKey;
}

export interface SafesController {
  /** One open per safe at a time: a second call while one is in flight gets the same promise. */
  open(safeId: SafeId, method: SafeOpenMethod): Promise<SafeOutcome>;
  pending(safeId: SafeId): SafeOpenMethod | null;
  readonly busy: boolean;
}

function freshKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

/**
 * Sends safe opens. The client names only the safe and how it wants it opened; the Key cost,
 * the timer check, the roll and every balance come back from the server. An open that went
 * offline may have landed, so its retry reuses the same Idempotency-Key and the server replays
 * it instead of rolling, or charging, twice.
 */
export function createSafesController(options: SafesControllerOptions): SafesController {
  const { api, events } = options;
  const newKey = options.newKey ?? freshKey;
  const retryKeys = new Map<string, IdempotencyKey>();
  const inFlight = new Map<SafeId, { method: SafeOpenMethod; request: Promise<SafeOutcome> }>();

  async function send(safeId: SafeId, method: SafeOpenMethod): Promise<SafeOutcome> {
    const slot = `${safeId}:${method}`;
    const key = retryKeys.get(slot) ?? newKey();
    retryKeys.set(slot, key);
    try {
      const body = endpoints.safesOpen.body.parse({ safeId, method });
      const response = await api.open(body, key);
      retryKeys.delete(slot);
      return { ok: true, method, response, pity: response.roll.pity };
    } catch (error) {
      const reason = classifySafeRejection(error);
      if (reason !== 'offline') retryKeys.delete(slot);
      return { ok: false, method, reason, error };
    }
  }

  return {
    get busy() {
      return inFlight.size > 0;
    },

    pending(safeId) {
      return inFlight.get(safeId)?.method ?? null;
    },

    open(safeId, method) {
      const current = inFlight.get(safeId);
      if (current !== undefined) return current.request;
      events.emit('safe:requested', { safeId, method });
      const request = send(safeId, method).then((outcome) => {
        inFlight.delete(safeId);
        if (outcome.ok) {
          const { response } = outcome;
          events.emit('safe:opened', {
            safeId: response.safeId,
            method,
            roll: response.roll,
            wallet: response.wallet,
          });
          events.emit('safe:pity', { safeId: response.safeId, pity: outcome.pity });
        } else {
          events.emit('safe:rejected', { safeId, method, reason: outcome.reason });
        }
        return outcome;
      });
      inFlight.set(safeId, { method, request });
      return request;
    },
  };
}
