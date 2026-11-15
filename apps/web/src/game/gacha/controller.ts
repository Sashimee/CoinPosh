import {
  endpoints,
  ErrorCodeSchema,
  IdempotencyKeySchema,
  type ErrorCode,
  type GachaPullRequest,
  type GachaPullResponse,
  type IdempotencyKey,
  type PityCounters,
  type Roll,
  type Wallet,
} from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { GachaEvents, GachaRejection } from './events.ts';

/** The machine dispenses one capsule per crank. */
export const PULL_COUNT = 1;

/**
 * The one network call the gacha makes. Resolve with the server's response, or reject with the
 * net layer's error: an `ApiRequestError` carries the envelope `code`, a `NetworkError` means
 * the request may never have arrived.
 */
export interface GachaApi {
  pull(body: GachaPullRequest, idempotencyKey: IdempotencyKey): Promise<GachaPullResponse>;
}

const REJECTIONS: Partial<Record<ErrorCode, GachaRejection>> = {
  insufficient_funds: 'noTickets',
  forbidden: 'unavailable',
  feature_disabled: 'unavailable',
  rate_limited: 'busy',
};

function errorCode(error: unknown): ErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const parsed = ErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : null;
}

export function classifyGachaRejection(error: unknown): GachaRejection {
  const code = errorCode(error);
  if (code !== null) return REJECTIONS[code] ?? 'error';
  if (error instanceof Error && error.name === 'NetworkError') return 'offline';
  return 'error';
}

export type GachaOutcome =
  | {
      readonly ok: true;
      readonly roll: Roll;
      readonly wallet: Wallet;
      readonly pity: PityCounters;
    }
  | { readonly ok: false; readonly reason: GachaRejection; readonly error: unknown };

export interface GachaControllerOptions {
  readonly api: GachaApi;
  readonly events: Bus<GachaEvents>;
  readonly newKey?: () => IdempotencyKey;
}

export interface GachaController {
  /** One pull at a time: a second call while one is in flight gets the same promise. */
  pull(): Promise<GachaOutcome>;
  readonly busy: boolean;
}

function freshKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

/**
 * Sends pulls. The client only asks for one capsule; the Ticket cost, the roll and every
 * balance come back from the server. A pull that went offline may have landed, so its retry
 * reuses the same Idempotency-Key and the server replays it instead of rolling, or charging,
 * twice.
 */
export function createGachaController(options: GachaControllerOptions): GachaController {
  const { api, events } = options;
  const newKey = options.newKey ?? freshKey;
  let retryKey: IdempotencyKey | null = null;
  let inFlight: Promise<GachaOutcome> | null = null;

  async function send(): Promise<GachaOutcome> {
    const key = retryKey ?? newKey();
    retryKey = key;
    try {
      const body = endpoints.gachaPull.body.parse({ count: PULL_COUNT });
      const response = await api.pull(body, key);
      retryKey = null;
      const [roll] = response.pulls;
      if (roll === undefined) throw new Error('The server answered a gacha pull with no roll');
      return { ok: true, roll, wallet: response.wallet, pity: roll.pity };
    } catch (error) {
      const reason = classifyGachaRejection(error);
      if (reason !== 'offline') retryKey = null;
      return { ok: false, reason, error };
    }
  }

  return {
    get busy() {
      return inFlight !== null;
    },
    pull() {
      if (inFlight !== null) return inFlight;
      events.emit('gacha:requested', { count: PULL_COUNT });
      const request = send().then((outcome) => {
        inFlight = null;
        if (outcome.ok) {
          events.emit('gacha:pulled', { roll: outcome.roll, wallet: outcome.wallet });
          events.emit('gacha:pity', { pity: outcome.pity });
        } else {
          events.emit('gacha:rejected', { reason: outcome.reason });
        }
        return outcome;
      });
      inFlight = request;
      return request;
    },
  };
}
