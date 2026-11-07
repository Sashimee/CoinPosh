import {
  EMPTY_BODY_SHA256,
  HEADERS,
  IdempotencyKeySchema,
  type ApiError,
  type DevicePublicKey,
  type IdempotencyKey,
  type Sha256Hex,
  type SignedRequestParts,
} from '@coinposh/shared';
import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import { verifyDeviceSignature } from '../auth/device.ts';
import { authSecret, verifyAccessToken, type AccessGrant } from '../auth/tokens.ts';
import { sha256Hex } from '../crypto.ts';
import type { DoResult } from '../do/PlayerDO.ts';
import type { AppContext, AppEnv } from './context.ts';
import { IDEMPOTENT_REPLAYED_HEADER, isAllowedOrigin } from './cors.ts';
import { ApiFailure } from './errors.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const supplied = c.req.header(HEADERS.requestId);
  const requestId =
    supplied !== undefined && REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  c.set('requestId', requestId);
  c.header(HEADERS.requestId, requestId);
  await next();
};

/** CORS only hides responses from other sites; this refuses to act for them at all. */
export const originGuardMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    throw new ApiFailure('forbidden', `Requests from origin ${origin} are not allowed.`);
  }
  await next();
};

export interface SignedRequest {
  readonly rawBody: string;
  readonly bodySha256: Sha256Hex;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly parts: SignedRequestParts;
}

function payloadTooLarge(): ApiFailure {
  return new ApiFailure(
    'payload_too_large',
    `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`,
  );
}

/** Reads at most MAX_BODY_BYTES, so a chunked upload without Content-Length cannot buffer more. */
async function readRawBody(c: AppContext): Promise<string> {
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw payloadTooLarge();
  const stream = c.req.raw.body;
  if (stream === null) return '';
  const reader = stream.getReader();
  const body = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const chunk: unknown = result.value;
    if (!(chunk instanceof Uint8Array)) {
      throw new ApiFailure('bad_request', 'The request body must be sent as bytes.');
    }
    if (length + chunk.byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw payloadTooLarge();
    }
    body.set(chunk, length);
    length += chunk.byteLength;
  }
  return new TextDecoder().decode(body.subarray(0, length));
}

function readIdempotencyKey(c: AppContext): IdempotencyKey | null {
  const header = c.req.header(HEADERS.idempotencyKey);
  if (c.req.method !== 'POST') return null;
  if (header === undefined) {
    throw new ApiFailure(
      'idempotency_key_missing',
      'Mutating requests need an Idempotency-Key header (a fresh crypto.randomUUID()).',
    );
  }
  const parsed = IdempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new ApiFailure('bad_request', 'Idempotency-Key must be a UUID.');
  }
  return parsed.data;
}

/** Reads what the device key signed: method, exact path and query, idempotency key, body hash. */
export async function readSignedRequest(c: AppContext): Promise<SignedRequest> {
  const rawBody = c.req.method === 'GET' ? '' : await readRawBody(c);
  const idempotencyKey = readIdempotencyKey(c);
  const bodySha256 = rawBody === '' ? EMPTY_BODY_SHA256 : await sha256Hex(rawBody);
  const url = new URL(c.req.url);
  const method = c.req.method;
  if (method !== 'GET' && method !== 'POST') {
    throw new ApiFailure('bad_request', `Method ${method} is not supported.`);
  }
  return {
    rawBody,
    bodySha256,
    idempotencyKey,
    parts: { method, pathWithQuery: url.pathname + url.search, idempotencyKey, bodySha256 },
  };
}

export function parseBody<S extends z.ZodType>(schema: S, rawBody: string): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new ApiFailure('bad_request', 'The request body must be JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw ApiFailure.validation(parsed.error, 'The request body does not match the contract.');
  }
  return parsed.data;
}

export async function verifySigned(
  c: AppContext,
  request: SignedRequest,
  key: DevicePublicKey,
): Promise<void> {
  await verifyDeviceSignature(key, request.parts, c.req.header(HEADERS.deviceSignature));
}

export interface BearerRequest extends SignedRequest {
  readonly grant: AccessGrant;
}

/** Bearer token first (cheap, says which key to check), then the device signature over it all. */
export async function authenticate(c: AppContext): Promise<BearerRequest> {
  const grant = await verifyAccessToken(
    authSecret(c.env.AUTH_SECRET),
    c.req.header(HEADERS.authorization),
    Date.now(),
  );
  const request = await readSignedRequest(c);
  await verifySigned(c, request, grant.deviceKey);
  return { ...request, grant };
}

/** The PlayerDO idempotency fingerprint: one key may only ever name one exact request. */
export function fingerprint(request: SignedRequest): string {
  return `${request.parts.method} ${request.parts.pathWithQuery} ${request.bodySha256}`;
}

export function requireIdempotencyKey(request: SignedRequest): IdempotencyKey {
  if (request.idempotencyKey === null) {
    throw new ApiFailure('idempotency_key_missing', 'This request needs an Idempotency-Key.');
  }
  return request.idempotencyKey;
}

function failureFrom(error: ApiError): ApiFailure {
  const { code, message, ...extra } = error;
  return new ApiFailure(code, message, extra);
}

/** Turns a PlayerDO result into the endpoint's response, checked against its contract. */
export function respond(c: AppContext, schema: z.ZodType, result: DoResult<unknown>): Response {
  if (!result.ok) throw failureFrom(result.error);
  if (result.replayed) c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
  return c.json(schema.parse(result.body) as object);
}
