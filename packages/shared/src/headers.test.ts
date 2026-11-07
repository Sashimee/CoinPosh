import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeviceSignatureSchema,
  EMPTY_BODY_SHA256,
  HEADERS,
  IdempotencyKeySchema,
  canonicalRequest,
} from './headers.ts';
import { ids } from './test/fixtures.ts';
import { roundTrip } from './test/roundTrip.ts';

const key = IdempotencyKeySchema.parse(ids.idempotencyKey);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('IdempotencyKeySchema', () => {
  it('accepts crypto.randomUUID() output and round-trips it', () => {
    const generated = webcrypto.randomUUID();
    const { parsed, reparsed } = roundTrip(IdempotencyKeySchema, generated);
    expect(parsed).toBe(generated);
    expect(reparsed).toBe(generated);
  });

  it.each(['', 'drop-1', '3b241101e2bb42558caf4136c566a962', `${ids.idempotencyKey}x`])(
    'rejects %j',
    (value) => {
      expect(IdempotencyKeySchema.safeParse(value).success).toBe(false);
    },
  );

  it('uses the standard header name', () => {
    expect(HEADERS.idempotencyKey).toBe('Idempotency-Key');
  });
});

describe('DeviceSignatureSchema', () => {
  it('accepts a real WebCrypto ECDSA P-256 signature as base64url', async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const signature = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode('payload'),
    );
    const encoded = Buffer.from(signature).toString('base64url');
    expect(DeviceSignatureSchema.parse(encoded)).toBe(encoded);
  });

  it('rejects padded, short and DER-sized signatures', () => {
    expect(DeviceSignatureSchema.safeParse(`${'A'.repeat(86)}==`).success).toBe(false);
    expect(DeviceSignatureSchema.safeParse('A'.repeat(85)).success).toBe(false);
    expect(DeviceSignatureSchema.safeParse('A'.repeat(96)).success).toBe(false);
  });
});

describe('canonicalRequest', () => {
  it('matches SHA-256 of the empty string for bodiless requests', () => {
    expect(EMPTY_BODY_SHA256).toBe(sha256(''));
  });

  it('lays out scheme, method, path, key and body hash on separate lines', () => {
    const body = JSON.stringify({ x: 0.25, tick: 120 });
    expect(
      canonicalRequest({
        method: 'POST',
        pathWithQuery: '/v1/table/drop',
        idempotencyKey: key,
        bodySha256: sha256(body),
      }),
    ).toBe(
      ['COINPOSH-SIG-V1', 'POST', '/v1/table/drop', ids.idempotencyKey, sha256(body)].join('\n'),
    );
  });

  it('marks the absent idempotency key of a GET explicitly', () => {
    expect(
      canonicalRequest({
        method: 'GET',
        pathWithQuery: '/v1/state',
        idempotencyKey: null,
        bodySha256: EMPTY_BODY_SHA256,
      }).split('\n')[3],
    ).toBe('-');
  });

  it('signs and verifies end to end with a device key', async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const parts = {
      method: 'POST',
      pathWithQuery: '/v1/table/claims',
      idempotencyKey: key,
      bodySha256: sha256('{"claims":[]}'),
    } as const;
    const algorithm = { name: 'ECDSA', hash: 'SHA-256' };
    const message = new TextEncoder().encode(canonicalRequest(parts));
    const signature = await webcrypto.subtle.sign(algorithm, pair.privateKey, message);
    expect(await webcrypto.subtle.verify(algorithm, pair.publicKey, signature, message)).toBe(true);

    const tampered = new TextEncoder().encode(
      canonicalRequest({ ...parts, pathWithQuery: '/v1/table/drop' }),
    );
    expect(await webcrypto.subtle.verify(algorithm, pair.publicKey, signature, tampered)).toBe(
      false,
    );
  });

  it('refuses a relative path or a malformed body hash', () => {
    const parts = {
      method: 'GET',
      pathWithQuery: '/v1/state',
      idempotencyKey: null,
      bodySha256: EMPTY_BODY_SHA256,
    } as const;
    expect(() => canonicalRequest({ ...parts, pathWithQuery: 'v1/state' })).toThrow(/start with/);
    expect(() => canonicalRequest({ ...parts, bodySha256: 'abc' })).toThrow(/bodySha256/);
  });
});
