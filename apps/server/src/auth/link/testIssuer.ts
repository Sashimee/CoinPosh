import { base64UrlEncode, utf8 } from '../../crypto.ts';
import type { JwksFetcher } from './jwks.ts';

/** Test-only stand-ins for Google and Apple: local RS256 keys served as a JWKS document. */
export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { kid: string };
}

const RS256_PARAMS = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

export async function newSigningKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(RS256_PARAMS, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const { kty, n, e } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  if (n === undefined || e === undefined) {
    throw new Error('The runtime exported an RSA public key without n or e.');
  }
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { kty, n, e, alg: 'RS256', use: 'sig', kid },
  };
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(utf8(JSON.stringify(value)));
}

export async function signIdToken(
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const signingInput = `${encodeJson({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    utf8(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** A JWKS endpoint per URL whose key sets tests can rotate, break and count fetches of. */
export class LocalJwks {
  readonly fetches: string[] = [];
  private readonly sets = new Map<string, SigningKey[]>();
  failing = false;
  maxAgeSeconds = 3600;

  publish(url: string, keys: SigningKey[]): void {
    this.sets.set(url, keys);
  }

  readonly fetcher: JwksFetcher = (url) => {
    this.fetches.push(url);
    if (this.failing) return Promise.resolve(new Response('upstream down', { status: 503 }));
    const keys = this.sets.get(url);
    if (keys === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(
      Response.json(
        { keys: keys.map((key) => key.publicJwk) },
        { headers: { 'Cache-Control': `public, max-age=${this.maxAgeSeconds}` } },
      ),
    );
  };
}
