import type {
  ClientSeed,
  DropSourceId,
  FairRotateResponse,
  FairSeedsResponse,
  PityCounters,
} from '@coinposh/shared';
import type { ApiClient } from '../../net/client.ts';
import type { PityCountersBySource } from './model.ts';

/** Where the Certified Fair panel reads the seed ledger and the player's pity counts. */
export interface FairData {
  /** `GET /v1/fair/seeds`: the seed in play and every seed revealed so far. */
  seeds(): Promise<FairSeedsResponse>;
  /** `POST /v1/fair/rotate`; without it the panel hides the reveal action. */
  readonly rotate?: (clientSeed: ClientSeed | undefined) => Promise<FairRotateResponse>;
  /** The latest counters the server reported per source; a source missing has none yet. */
  readonly pity?: () => PityCountersBySource;
}

export type FairClient = Pick<ApiClient, 'call'>;

/** The panel over the API client (Demo Mode's mock answers the same two endpoints). */
export function apiFairData(client: FairClient, pity?: () => PityCountersBySource): FairData {
  return {
    seeds: () => client.call('fairSeeds'),
    rotate: (clientSeed) =>
      client.call('fairRotate', { body: clientSeed === undefined ? {} : { clientSeed } }),
    ...(pity ? { pity } : {}),
  };
}

/**
 * Pity counts arrive only on rolls (`Roll.pity`), so the game keeps the latest per source here
 * and the panel reads them back. Counts are the server's; this only remembers them.
 */
export interface PityLog {
  record(source: DropSourceId, counters: PityCounters): void;
  read(): PityCountersBySource;
}

export function createPityLog(): PityLog {
  const latest = new Map<DropSourceId, PityCounters>();
  return {
    record(source, counters) {
      latest.set(source, { ...counters });
    },
    read() {
      return Object.fromEntries(latest);
    },
  };
}
