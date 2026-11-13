import {
  EMPTY_BODY_SHA256,
  ErrorEnvelopeSchema,
  HEADERS,
  buildPath,
  canonicalRequest,
  endpoints,
  requiresIdempotencyKey,
  type ApiError,
  type Endpoint,
  type EndpointBodyInput,
  type EndpointName,
  type EndpointParamsInput,
  type EndpointQueryInput,
  type EndpointResponse,
  type IdempotencyKey,
} from '@coinposh/shared';
import type { DeviceKey } from './device.ts';
import { sha256Hex } from './encoding.ts';
import { ApiRequestError } from './errors.ts';
import type { WireRequest, WireResponse } from './wire.ts';

type BodyField<N extends EndpointName> = [EndpointBodyInput<N>] extends [never]
  ? { readonly body?: never }
  : { readonly body: EndpointBodyInput<N> };
type ParamsField<N extends EndpointName> = [EndpointParamsInput<N>] extends [never]
  ? { readonly params?: never }
  : { readonly params: EndpointParamsInput<N> };

type QueryField<N extends EndpointName> = [EndpointQueryInput<N>] extends [never]
  ? { readonly query?: never }
  : { readonly query?: EndpointQueryInput<N> };

/** What a caller may put on the wire for endpoint `N`: its body, path params and query, nothing else. */
export type CallInput<N extends EndpointName> = BodyField<N> & ParamsField<N> & QueryField<N>;

export interface SignedRequestInput {
  readonly idempotencyKey: IdempotencyKey | null;
  readonly accessToken: string | null;
}

/** A server answered outside its zod contract. Retrying cannot fix that, so it is never retried. */
export class ContractViolationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContractViolationError';
  }
}

export function newIdempotencyKey(): IdempotencyKey {
  return crypto.randomUUID() as IdempotencyKey;
}

function encodeQuery(name: EndpointName, endpoint: Endpoint, query: unknown): string {
  if (endpoint.query === undefined) {
    if (query !== undefined) {
      throw new ContractViolationError(`${name} takes no query, so refusing to send one.`);
    }
    return '';
  }
  const parsed = endpoint.query.safeParse(query ?? {});
  if (!parsed.success) {
    throw new ContractViolationError(
      `Refusing to send an invalid ${name} query: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      { cause: parsed.error },
    );
  }
  const fields = Object.entries(parsed.data as Record<string, string | undefined>).filter(
    (field): field is [string, string] => field[1] !== undefined,
  );
  const search = new URLSearchParams(fields).toString();
  return search === '' ? '' : `?${search}`;
}

function encodeBody(name: EndpointName, endpoint: Endpoint, body: unknown): string | null {
  if (endpoint.body === null) return null;
  const parsed = endpoint.body.safeParse(body);
  if (!parsed.success) {
    throw new ContractViolationError(
      `Refusing to send an invalid ${name} body: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      { cause: parsed.error },
    );
  }
  return JSON.stringify(parsed.data);
}

/** Builds the exact bytes, headers and device signature for one call to endpoint `name`. */
export async function signRequest<N extends EndpointName>(
  name: N,
  input: CallInput<N>,
  signed: SignedRequestInput,
  device: DeviceKey,
): Promise<WireRequest> {
  const endpoint: Endpoint = endpoints[name];
  const path =
    (buildPath as (n: EndpointName, params?: unknown) => string)(name, input.params) +
    encodeQuery(name, endpoint, input.query);
  const body = encodeBody(name, endpoint, input.body);
  const idempotencyKey = requiresIdempotencyKey(endpoint) ? signed.idempotencyKey : null;
  if (requiresIdempotencyKey(endpoint) && idempotencyKey === null) {
    throw new ContractViolationError(`${name} mutates state and needs an Idempotency-Key.`);
  }
  const signature = await device.sign(
    canonicalRequest({
      method: endpoint.method,
      pathWithQuery: path,
      idempotencyKey,
      bodySha256: body === null ? EMPTY_BODY_SHA256 : await sha256Hex(body),
    }),
  );
  const headers: Record<string, string> = { [HEADERS.deviceSignature]: signature };
  if (idempotencyKey !== null) headers[HEADERS.idempotencyKey] = idempotencyKey;
  if (endpoint.auth === 'bearer') {
    if (signed.accessToken === null) {
      throw new ContractViolationError(`${name} needs a bearer access token.`);
    }
    headers[HEADERS.authorization] = `Bearer ${signed.accessToken}`;
  }
  return { method: endpoint.method, path, headers, body };
}

function fallbackError(status: number): ApiError {
  if (status === 429) return { code: 'rate_limited', message: 'Rate limited (no error body).' };
  if (status === 503)
    return { code: 'unavailable', message: 'Service unavailable (no error body).' };
  if (status >= 500)
    return { code: 'internal', message: `Server error ${status} (no error body).` };
  return { code: 'bad_request', message: `HTTP ${status} without an error envelope.` };
}

/** Parses a 2xx through the endpoint's response schema; anything else throws {@link ApiRequestError}. */
export function readResponse<N extends EndpointName>(
  name: N,
  response: WireResponse,
): EndpointResponse<N> {
  if (response.status >= 200 && response.status < 300) {
    const endpoint: Endpoint = endpoints[name];
    const parsed = endpoint.response.safeParse(response.body);
    if (!parsed.success) {
      throw new ContractViolationError(
        `${name} answered ${response.status} with a body outside its contract: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    return parsed.data as EndpointResponse<N>;
  }
  const envelope = ErrorEnvelopeSchema.safeParse(response.body);
  throw new ApiRequestError(
    name,
    response.status,
    envelope.success ? envelope.data.error : fallbackError(response.status),
  );
}
