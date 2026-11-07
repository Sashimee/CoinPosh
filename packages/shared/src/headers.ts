import { z } from 'zod';
import { Sha256HexSchema, type Sha256Hex } from './primitives.ts';

export const HEADERS = {
  authorization: 'Authorization',
  idempotencyKey: 'Idempotency-Key',
  deviceSignature: 'X-CoinPosh-Signature',
  requestId: 'X-Request-Id',
} as const;

/** Client-generated with `crypto.randomUUID()`, required on every mutating request. */
export const IdempotencyKeySchema = z.uuid().brand<'IdempotencyKey'>();
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/** Raw IEEE P1363 ECDSA P-256 signature (r ‖ s, 64 bytes) as unpadded base64url. */
export const DeviceSignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/, 'Expected a 64-byte ECDSA P-256 signature as base64url.')
  .brand<'DeviceSignature'>();
export type DeviceSignature = z.infer<typeof DeviceSignatureSchema>;

export const SIGNING_SCHEME = 'COINPOSH-SIG-V1';

/** SHA-256 of the empty body, signed for GET requests. */
export const EMPTY_BODY_SHA256: Sha256Hex =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SignedRequestParts {
  readonly method: 'GET' | 'POST';
  /** Path plus query string exactly as sent, e.g. `/v1/table/drop`. */
  readonly pathWithQuery: string;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly bodySha256: Sha256Hex;
}

/** The exact bytes the device key signs and the server verifies; both sides must build it here. */
export function canonicalRequest(parts: SignedRequestParts): string {
  if (!parts.pathWithQuery.startsWith('/')) {
    throw new Error(`canonicalRequest: path must start with "/", got "${parts.pathWithQuery}".`);
  }
  if (!Sha256HexSchema.safeParse(parts.bodySha256).success) {
    throw new Error('canonicalRequest: bodySha256 must be a lowercase hex SHA-256 digest.');
  }
  return [
    SIGNING_SCHEME,
    parts.method,
    parts.pathWithQuery,
    parts.idempotencyKey ?? '-',
    parts.bodySha256,
  ].join('\n');
}
