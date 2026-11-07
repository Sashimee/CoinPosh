import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { endpointFixtures } from '../test/fixtures.ts';
import { DevicePublicKeySchema, GuestAuthRequestSchema } from './auth.ts';

const { devicePublicKey } = endpointFixtures.authGuest.body;

describe('DevicePublicKeySchema', () => {
  it('accepts a public key exported by WebCrypto as JWK', async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    expect(DevicePublicKeySchema.parse(jwk)).toEqual(jwk);
  });

  it('rejects a JWK that leaks the private scalar', () => {
    const leaked = { ...devicePublicKey, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' };
    expect(DevicePublicKeySchema.safeParse(leaked).success).toBe(false);
  });

  it.each([
    ['another curve', { ...devicePublicKey, crv: 'P-384' }],
    ['an RSA key', { ...devicePublicKey, kty: 'RSA' }],
    ['a short coordinate', { ...devicePublicKey, x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVE' }],
    ['padded base64', { ...devicePublicKey, y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a=' }],
    ['a signing key_op', { ...devicePublicKey, key_ops: ['sign'] }],
  ])('rejects %s', (_label, jwk) => {
    expect(DevicePublicKeySchema.safeParse(jwk).success).toBe(false);
  });
});

describe('GuestAuthRequestSchema', () => {
  const body = endpointFixtures.authGuest.body;

  it('rejects an unsupported locale and an empty Turnstile token', () => {
    expect(GuestAuthRequestSchema.safeParse({ ...body, locale: 'es' }).success).toBe(false);
    expect(GuestAuthRequestSchema.safeParse({ ...body, turnstileToken: '' }).success).toBe(false);
  });

  it('never accepts a client-chosen player id', () => {
    const result = GuestAuthRequestSchema.safeParse({
      ...body,
      playerId: '0198f6a2-7c1e-7d3b-9a4f-2b6c8e1d0a55',
    });
    expect(result.success).toBe(false);
  });
});
