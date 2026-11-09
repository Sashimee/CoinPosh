import { describe, expect, it } from 'vitest';
import { base64UrlEncode, sha256Hex, utf8 } from '../../crypto.ts';
import { ID_TOKEN_IAT_LEEWAY_MS, maskEmail, nonceMatches, verifyIdToken } from './idToken.ts';
import { JwksCache } from './jwks.ts';
import { PROVIDERS, type ReadyProvider } from './providers.ts';
import { LocalJwks, newSigningKey, signIdToken } from './testIssuer.ts';

const NOW = 1_800_000_000_000;
const AUDIENCE = 'coinposh-web.apps.googleusercontent.com';
const google: ReadyProvider = { config: PROVIDERS.google, audience: AUDIENCE };
const apple: ReadyProvider = { config: PROVIDERS.apple, audience: 'lu.bas.coinposh.web' };

const jwks = new LocalJwks();
const genuine = await newSigningKey('google-1');
const appleKey = await newSigningKey('apple-1');
const attacker = await newSigningKey('google-1');
jwks.publish(PROVIDERS.google.jwksUrl, [genuine]);
jwks.publish(PROVIDERS.apple.jwksUrl, [appleKey]);
const cache = new JwksCache(jwks.fetcher, () => NOW);

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '110169484474386276334',
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    nonce: 'n'.repeat(43),
    email: 'lucie@gmail.com',
    email_verified: true,
    ...overrides,
  };
}

async function rejection(token: string, provider: ReadyProvider = google) {
  return verifyIdToken(token, provider, cache, NOW).then(
    () => 'accepted',
    (error: unknown) => (error as { code: string; message: string }).message,
  );
}

describe('verifyIdToken', () => {
  it('accepts a genuine token and returns only a masked email', async () => {
    const verified = await verifyIdToken(await signIdToken(genuine, claims()), google, cache, NOW);
    expect(verified).toEqual({
      provider: 'google',
      subject: '110169484474386276334',
      nonce: 'n'.repeat(43),
      emailHint: 'l•••@gmail.com',
    });
  });

  it('accepts the legacy Google issuer spelling and an Apple token with string booleans', async () => {
    await expect(
      verifyIdToken(
        await signIdToken(genuine, claims({ iss: 'accounts.google.com' })),
        google,
        cache,
        NOW,
      ),
    ).resolves.toMatchObject({ provider: 'google' });
    const appleToken = await signIdToken(
      appleKey,
      claims({
        iss: 'https://appleid.apple.com',
        aud: 'lu.bas.coinposh.web',
        email: 'x7k2@privaterelay.appleid.com',
        email_verified: 'true',
      }),
    );
    await expect(verifyIdToken(appleToken, apple, cache, NOW)).resolves.toMatchObject({
      provider: 'apple',
      emailHint: 'x•••@privaterelay.appleid.com',
    });
  });

  it('refuses a forged signature made with a different key under the genuine kid', async () => {
    expect(await rejection(await signIdToken(attacker, claims()))).toMatch(/signature/);
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const token = await signIdToken(genuine, claims());
    const [header, , signature] = token.split('.');
    const edited = base64UrlEncode(utf8(JSON.stringify(claims({ sub: 'someone-else' }))));
    expect(await rejection(`${header}.${edited}.${signature}`)).toMatch(/signature/);
  });

  it('refuses alg none and HS256 tokens (algorithm confusion)', async () => {
    const payload = base64UrlEncode(utf8(JSON.stringify(claims())));
    const none = base64UrlEncode(utf8(JSON.stringify({ alg: 'none', kid: 'google-1' })));
    expect(await rejection(`${none}.${payload}.AA`)).toMatch(/`none` is refused/);
    expect(await rejection(await signIdToken(genuine, claims(), { alg: 'HS256' }))).toMatch(
      /`HS256` is refused/,
    );
  });

  it('refuses a key the provider does not publish', async () => {
    const rogue = await newSigningKey('rogue');
    expect(await rejection(await signIdToken(rogue, claims()))).toMatch(/does not publish/);
  });

  it("refuses an Apple-signed token presented as Google's", async () => {
    const crossed = await signIdToken(appleKey, claims({ iss: 'https://appleid.apple.com' }));
    expect(await rejection(crossed)).toMatch(/does not publish/);
  });

  it('refuses the wrong issuer', async () => {
    expect(
      await rejection(await signIdToken(genuine, claims({ iss: 'https://evil.test' }))),
    ).toMatch(/not issued by Google/);
  });

  it('refuses the wrong audience, and a multi-audience token not authorised for CoinPosh', async () => {
    expect(await rejection(await signIdToken(genuine, claims({ aud: 'other-app' })))).toMatch(
      /another app/,
    );
    expect(
      await rejection(
        await signIdToken(genuine, claims({ aud: [AUDIENCE, 'other'], azp: 'other' })),
      ),
    ).toMatch(/another app/);
    await expect(
      verifyIdToken(
        await signIdToken(genuine, claims({ aud: [AUDIENCE, 'other'], azp: AUDIENCE })),
        google,
        cache,
        NOW,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses an expired token by the server clock, to the second', async () => {
    expect(await rejection(await signIdToken(genuine, claims({ exp: NOW / 1000 })))).toMatch(
      /expired/,
    );
    expect(await rejection(await signIdToken(genuine, claims({ exp: NOW / 1000 + 1 })))).toBe(
      'accepted',
    );
  });

  it('refuses a token issued in the future beyond the leeway (clock skew)', async () => {
    const skewed = NOW / 1000 + ID_TOKEN_IAT_LEEWAY_MS / 1000 + 1;
    expect(
      await rejection(await signIdToken(genuine, claims({ iat: skewed, exp: skewed + 3600 }))),
    ).toMatch(/future/);
  });

  it('refuses tokens missing sub, exp or iat', async () => {
    for (const missing of ['sub', 'exp', 'iat']) {
      const partial = Object.fromEntries(
        Object.entries(claims()).filter(([name]) => name !== missing),
      );
      expect(await rejection(await signIdToken(genuine, partial))).toMatch(/missing required/);
    }
  });

  it('withholds the email hint when the provider has not verified the address', async () => {
    const verified = await verifyIdToken(
      await signIdToken(genuine, claims({ email_verified: false })),
      google,
      cache,
      NOW,
    );
    expect(verified.emailHint).toBeNull();
  });
});

describe('nonceMatches', () => {
  const nonce = 'q'.repeat(43);
  const token = (value: string | null) => ({
    provider: 'google' as const,
    subject: 's',
    nonce: value,
    emailHint: null,
  });

  it('matches the exact nonce only, for Google', async () => {
    expect(await nonceMatches(google, token(nonce), nonce)).toBe(true);
    expect(await nonceMatches(google, token(await sha256Hex(nonce)), nonce)).toBe(false);
    expect(await nonceMatches(google, token(null), nonce)).toBe(false);
    expect(await nonceMatches(google, token('r'.repeat(43)), nonce)).toBe(false);
  });

  it('also accepts the SHA-256 form native Sign in with Apple embeds', async () => {
    expect(await nonceMatches(apple, token(await sha256Hex(nonce)), nonce)).toBe(true);
    expect(await nonceMatches(apple, token(nonce), nonce)).toBe(true);
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('lucie@gmail.com')).toBe('l•••@gmail.com');
    expect(maskEmail('@gmail.com')).toBeNull();
    expect(maskEmail('nobody')).toBeNull();
  });
});
