import {
  EMPTY_BODY_SHA256,
  HEADERS,
  canonicalRequest,
  type Currency,
  type IdempotencyKey,
  type PlayerId,
  type Tick,
  type Wallet,
} from '@coinposh/shared';
import { ApiClient } from '../client.ts';
import { ServerClock } from '../clock.ts';
import { loadOrCreateDeviceKey, type DeviceKey } from '../device.ts';
import { sha256Hex } from '../encoding.ts';
import { createMockServer, type MockServer } from '../mock/server.ts';
import { newIdempotencyKey } from '../request.ts';
import { Session } from '../session.ts';
import { memoryStore, type KeyValueStore } from '../store.ts';
import type { Transport, WireRequest, WireResponse } from '../wire.ts';

export const START = 1_800_000_000_000;

/** Server time for the mock, plus the sim tick a well-behaved 60 Hz client would be on. */
export class FakeTime {
  #now = START;

  readonly now = (): number => this.#now;

  advance(ms: number): void {
    this.#now += ms;
  }

  tick(): Tick {
    return Math.floor(((this.#now - START) / 1000) * 60);
  }
}

export interface Player {
  readonly device: DeviceKey;
  readonly store: KeyValueStore;
  readonly session: Session;
  readonly client: ApiClient;
  readonly clock: ServerClock;
  readonly requests: WireRequest[];
  /** Everything the session reported through `onError`. */
  readonly errors: Error[];
}

export interface PlayerOptions {
  /** The client's own monotonic clock; defaults to the server's, i.e. no drift. */
  readonly monotonic?: () => number;
  readonly store?: KeyValueStore;
  readonly device?: DeviceKey;
}

let turnstileCounter = 0;

export async function connectPlayer(
  server: MockServer,
  time: FakeTime,
  options: PlayerOptions = {},
): Promise<Player> {
  const store = options.store ?? memoryStore();
  const device = options.device ?? (await loadOrCreateDeviceKey(store));
  const requests: WireRequest[] = [];
  const errors: Error[] = [];
  const transport: Transport = (request) => {
    requests.push(request);
    return server.transport(request);
  };
  const monotonic = options.monotonic ?? time.now;
  const session = new Session({
    transport,
    device,
    store,
    monotonic,
    locale: () => 'en',
    turnstileToken: () => Promise.resolve(`test-turnstile-${String(++turnstileCounter)}`),
    onError: (error) => errors.push(error),
  });
  const clock = new ServerClock(monotonic);
  const client = new ApiClient({
    transport,
    device,
    session,
    clock,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
  });
  return { device, store, session, client, clock, requests, errors };
}

export function requirePlayerId(player: Player): PlayerId {
  const id = player.session.playerId;
  if (id === null) throw new Error('Test player has not signed in yet.');
  return id;
}

export interface ForgeInput {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** Raw body bytes, sent exactly as given: lets a test put anything on the wire. */
  readonly body: string | null;
  readonly key?: IdempotencyKey | null;
  readonly token?: string | null;
  /** Signs this instead of `body`, to send a body the signature does not cover. */
  readonly signedBody?: string | null;
  readonly signer?: DeviceKey;
  readonly signature?: string;
}

/** A request built by hand the way a compromised client would, bypassing every client-side check. */
export async function forge(
  server: MockServer,
  device: DeviceKey,
  input: ForgeInput,
): Promise<WireResponse> {
  const key =
    input.key === undefined ? (input.method === 'POST' ? newIdempotencyKey() : null) : input.key;
  const signed = input.signedBody === undefined ? input.body : input.signedBody;
  const signature =
    input.signature ??
    (await (input.signer ?? device).sign(
      canonicalRequest({
        method: input.method,
        pathWithQuery: input.path,
        idempotencyKey: key,
        bodySha256: signed === null ? EMPTY_BODY_SHA256 : await sha256Hex(signed),
      }),
    ));
  const headers: Record<string, string> = { [HEADERS.deviceSignature]: signature };
  if (key !== null) headers[HEADERS.idempotencyKey] = key;
  if (input.token !== undefined && input.token !== null) {
    headers[HEADERS.authorization] = `Bearer ${input.token}`;
  }
  return server.transport({ method: input.method, path: input.path, headers, body: input.body });
}

export function errorCode(response: WireResponse): string | null {
  const body = response.body as { error?: { code?: unknown } } | undefined;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : null;
}

/** Replays a player's ledger from zero; conservation means it lands exactly on the wallet. */
export function ledgerWallet(server: MockServer, playerId: PlayerId): Wallet {
  const wallet: Wallet = {
    coins: 0,
    bullion: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
  };
  for (const entry of server.ledger()) {
    if (entry.playerId !== playerId) continue;
    for (const [currency, amount] of Object.entries(entry.delta) as [Currency, number][]) {
      wallet[currency] += amount;
    }
  }
  return wallet;
}

export function serverWallet(server: MockServer, playerId: PlayerId): Wallet {
  const player = server.world.player(playerId);
  if (player === undefined) throw new Error(`No mock player ${playerId}.`);
  return player.wallet;
}

export { createMockServer };
