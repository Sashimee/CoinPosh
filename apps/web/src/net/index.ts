import type { Locale } from '@coinposh/shared';
import { ApiClient } from './client.ts';
import { ServerClock, monotonicNow, type Monotonic } from './clock.ts';
import {
  browserConnectivity,
  neverOnline,
  realScheduler,
  type Connectivity,
  type Scheduler,
} from './connectivity.ts';
import { loadOrCreateDeviceKey } from './device.ts';
import { currentNetMode, type NetMode } from './env.ts';
import { createMockServer, type MockServer } from './mock/server.ts';
import { Outbox } from './outbox.ts';
import { Session } from './session.ts';
import { indexedDbStore, memoryStore, type KeyValueStore } from './store.ts';
import { TableSync } from './tableSync.ts';
import { fetchTransport, type Transport } from './wire.ts';

export { mountDemoBanner, type DemoBannerColors, type Translate } from './demoBanner.ts';
export { NET_I18N_KEYS, NET_I18N_SOURCE, type NetI18nKey } from './i18nKeys.ts';
export { resolveNetMode, currentNetMode, type NetMode } from './env.ts';
export { ApiRequestError, NetworkError } from './errors.ts';
export { ContractViolationError } from './request.ts';
export type { ApiClient } from './client.ts';
export type { Session } from './session.ts';
export type { ServerClock } from './clock.ts';
export type { TableSync, TableEvent, SyncStatus, Balance, DropTicket } from './tableSync.ts';

export interface NetOptions {
  readonly mode?: NetMode;
  readonly locale: () => Locale;
  /**
   * A fresh Cloudflare Turnstile token for guest sign-up in live mode. Demo Mode has no
   * Turnstile, so it is not called there.
   */
  readonly turnstileToken: () => Promise<string>;
  readonly onError: (error: unknown) => void;
  readonly store?: KeyValueStore;
  readonly connectivity?: Connectivity;
  readonly scheduler?: Scheduler;
  readonly monotonic?: Monotonic;
}

export interface Net {
  readonly mode: NetMode;
  readonly client: ApiClient;
  readonly session: Session;
  readonly table: TableSync;
  readonly clock: ServerClock;
  /** The in-browser server behind Demo Mode; `null` when talking to the real API. */
  readonly mock: MockServer | null;
}

/**
 * Boots the net layer. With `VITE_API_URL` set it talks to the Workers API and keeps the
 * session and offline queue in IndexedDB. Without it, Demo Mode runs the same contracts
 * against an in-browser server held in memory: unranked, and gone when the tab closes.
 */
export async function createNet(options: NetOptions): Promise<Net> {
  const mode = options.mode ?? currentNetMode();
  const monotonic = options.monotonic ?? monotonicNow;
  const mock = mode.kind === 'demo' ? createMockServer() : null;
  const transport: Transport = mock?.transport ?? fetchTransport(liveUrl(mode));
  const store = options.store ?? (mode.kind === 'demo' ? memoryStore() : indexedDbStore());
  const device = await loadOrCreateDeviceKey(store);
  const clock = new ServerClock(monotonic);
  const session = new Session({
    transport,
    device,
    store,
    monotonic,
    locale: options.locale,
    turnstileToken:
      mode.kind === 'demo'
        ? () => Promise.resolve(`demo-${crypto.randomUUID()}`)
        : options.turnstileToken,
    onError: options.onError,
  });
  const client = new ApiClient({ transport, device, session, clock });
  const outbox = await Outbox.open(store, options.onError);
  const table = new TableSync({
    client,
    outbox,
    connectivity:
      options.connectivity ?? (typeof window === 'undefined' ? neverOnline : browserConnectivity()),
    scheduler: options.scheduler ?? realScheduler,
    onError: options.onError,
  });
  return { mode, client, session, table, clock, mock };
}

function liveUrl(mode: NetMode): string {
  if (mode.kind !== 'live') throw new Error('CoinPosh net: live transport requested in Demo Mode.');
  return mode.apiUrl;
}
