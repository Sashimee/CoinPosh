import {
  endpoints,
  ErrorCodeSchema,
  IdempotencyKeySchema,
  type ErrorCode,
  type IdempotencyKey,
  type ScratchCardId,
  type ScratchRevealRequest,
  type ScratchRevealResponse,
} from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import { scratchMatch, type ScratchMatch } from '../../vfx/scratch/plan.ts';
import type { ScratchEvents, ScratchRejection } from './events.ts';

/**
 * The one network call scratch cards make. Resolve with the server's response, or reject with
 * the net layer's error: an `ApiRequestError` carries the envelope `code`, a `NetworkError`
 * means the request may never have arrived.
 */
export interface ScratchApi {
  reveal(
    body: ScratchRevealRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ScratchRevealResponse>;
}

const REJECTIONS: Partial<Record<ErrorCode, ScratchRejection>> = {
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

export function classifyScratchRejection(error: unknown): ScratchRejection {
  const code = errorCode(error);
  if (code !== null) return REJECTIONS[code] ?? 'error';
  if (error instanceof Error && error.name === 'NetworkError') return 'offline';
  return 'error';
}

export type ScratchOutcome =
  | {
      readonly ok: true;
      readonly response: ScratchRevealResponse;
      /** Where the roll's three gems sit in the grid. */
      readonly match: ScratchMatch;
    }
  | { readonly ok: false; readonly reason: ScratchRejection; readonly error: unknown };

export interface ScratchControllerOptions {
  readonly api: ScratchApi;
  readonly events: Bus<ScratchEvents>;
  readonly newKey?: () => IdempotencyKey;
}

export interface ScratchController {
  /** One reveal per card at a time: a second call while one is in flight gets the same promise. */
  reveal(cardId: ScratchCardId): Promise<ScratchOutcome>;
  pending(cardId: ScratchCardId): boolean;
  readonly busy: boolean;
}

function freshKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

/**
 * Sends reveals. The client names only the card; the grid, the roll and every balance come
 * back from the server, and a grid that does not hold three of the roll's rarity is refused
 * rather than painted. A reveal that went offline may have landed, so its retry reuses the
 * same Idempotency-Key and the server replays the roll instead of rolling twice.
 */
export function createScratchController(options: ScratchControllerOptions): ScratchController {
  const { api, events } = options;
  const newKey = options.newKey ?? freshKey;
  const retryKeys = new Map<ScratchCardId, IdempotencyKey>();
  const inFlight = new Map<ScratchCardId, Promise<ScratchOutcome>>();

  async function send(cardId: ScratchCardId): Promise<ScratchOutcome> {
    const key = retryKeys.get(cardId) ?? newKey();
    retryKeys.set(cardId, key);
    let response: ScratchRevealResponse;
    try {
      const body = endpoints.scratchReveal.body.parse({ cardId });
      response = await api.reveal(body, key);
    } catch (error) {
      const reason = classifyScratchRejection(error);
      if (reason !== 'offline') retryKeys.delete(cardId);
      return { ok: false, reason, error };
    }
    retryKeys.delete(cardId);
    try {
      return { ok: true, response, match: scratchMatch(response.grid, response.roll.rarity) };
    } catch (error) {
      console.error(
        'CoinPosh scratch: the server answered with a grid the card cannot show',
        error,
      );
      return { ok: false, reason: 'error', error };
    }
  }

  return {
    get busy() {
      return inFlight.size > 0;
    },

    pending(cardId) {
      return inFlight.has(cardId);
    },

    reveal(cardId) {
      const current = inFlight.get(cardId);
      if (current !== undefined) return current;
      events.emit('scratch:requested', { cardId });
      const request = send(cardId).then((outcome) => {
        inFlight.delete(cardId);
        if (outcome.ok) {
          const { response } = outcome;
          events.emit('scratch:revealed', {
            cardId: response.cardId,
            grid: response.grid,
            roll: response.roll,
            wallet: response.wallet,
          });
          events.emit('scratch:pity', { cardId: response.cardId, pity: response.roll.pity });
        } else {
          events.emit('scratch:rejected', { cardId, reason: outcome.reason });
        }
        return outcome;
      });
      inFlight.set(cardId, request);
      return request;
    },
  };
}
