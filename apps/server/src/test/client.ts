import {
  canonicalRequest,
  DevicePublicKeySchema,
  EMPTY_BODY_SHA256,
  endpoints,
  HEADERS,
  IdempotencyKeySchema,
  type AuthTokens,
  type DevicePublicKey,
  type IdempotencyKey,
  type Locale,
} from '@coinposh/shared';
import { exports } from 'cloudflare:workers';
import { base64UrlEncode, sha256Hex, utf8 } from '../crypto.ts';

export const API_ORIGIN = 'https://api.coinposh.test';

export interface Device {
  readonly privateKey: CryptoKey;
  readonly publicKey: DevicePublicKey;
}

export async function newDevice(): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    publicKey: DevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }),
  };
}

export function newIdempotencyKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

export interface SendOptions {
  readonly method?: 'GET' | 'POST';
  /** Sent verbatim; a string bypasses JSON encoding so tests can send malformed bodies. */
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly idempotencyKey?: IdempotencyKey | null;
  readonly origin?: string;
  /** Overrides the computed signature header; `null` omits it. */
  readonly signature?: string | null;
  /** Signs these parts instead of the ones actually sent, to forge mismatches. */
  readonly signPath?: string;
  readonly signBody?: string;
  readonly signWith?: CryptoKey;
  /** Delivers the request somewhere other than the deployed worker, e.g. an app with a failing binding. */
  readonly via?: (request: Request) => Promise<Response>;
}

export async function signParts(
  key: CryptoKey,
  method: 'GET' | 'POST',
  pathWithQuery: string,
  idempotencyKey: IdempotencyKey | null,
  rawBody: string,
): Promise<string> {
  const bodySha256 = rawBody === '' ? EMPTY_BODY_SHA256 : await sha256Hex(rawBody);
  const message = canonicalRequest({ method, pathWithQuery, idempotencyKey, bodySha256 });
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(message),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/** Sends a device-signed request through the deployed worker entrypoint. */
export async function send(
  device: Device,
  path: string,
  options: SendOptions = {},
): Promise<Response> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const rawBody =
    options.body === undefined
      ? ''
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
  const idempotencyKey =
    options.idempotencyKey === undefined
      ? method === 'POST'
        ? newIdempotencyKey()
        : null
      : options.idempotencyKey;
  const headers = new Headers();
  if (rawBody !== '') headers.set('Content-Type', 'application/json');
  if (options.accessToken !== undefined) {
    headers.set(HEADERS.authorization, `Bearer ${options.accessToken}`);
  }
  if (idempotencyKey !== null) headers.set(HEADERS.idempotencyKey, idempotencyKey);
  if (options.origin !== undefined) headers.set('Origin', options.origin);
  const signature =
    options.signature === undefined
      ? await signParts(
          options.signWith ?? device.privateKey,
          method,
          options.signPath ?? path,
          idempotencyKey,
          options.signBody ?? rawBody,
        )
      : options.signature;
  if (signature !== null) headers.set(HEADERS.deviceSignature, signature);
  const deliver = options.via ?? ((request: Request) => exports.default.fetch(request));
  return deliver(
    new Request(`${API_ORIGIN}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: rawBody } : {}),
    }),
  );
}

export async function guestSignIn(
  device: Device,
  options: { locale?: Locale; idempotencyKey?: IdempotencyKey } = {},
): Promise<Response> {
  return send(device, endpoints.authGuest.path, {
    body: {
      devicePublicKey: device.publicKey,
      turnstileToken: 'test-turnstile-token',
      locale: options.locale ?? 'en',
    },
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  });
}

export interface Session {
  readonly device: Device;
  readonly tokens: AuthTokens;
  readonly call: (path: string, options?: SendOptions) => Promise<Response>;
}

export async function newSession(): Promise<Session> {
  const device = await newDevice();
  const response = await guestSignIn(device);
  if (response.status !== 200) {
    throw new Error(`Guest sign-in failed with ${response.status}: ${await response.text()}`);
  }
  const tokens = endpoints.authGuest.response.parse(await response.json());
  return {
    device,
    tokens,
    call: (path, options = {}) =>
      send(device, path, { accessToken: tokens.accessToken, ...options }),
  };
}
