import { z } from 'zod';
import { ApiFailure } from '../../http/errors.ts';

export type JwksFetcher = (url: string) => Promise<Response>;

export const JWKS_DEFAULT_TTL_MS = 60 * 60 * 1000;
export const JWKS_MIN_TTL_MS = 5 * 60 * 1000;
export const JWKS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` refetches at most this often, so forged kids cannot hammer the provider. */
export const JWKS_REFETCH_INTERVAL_MS = 60 * 1000;
/** Keys outlive their max-age by design; an outage may serve cached keys this long past expiry. */
export const JWKS_MAX_STALE_MS = 24 * 60 * 60 * 1000;

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

const JwkSchema = z.object({
  kty: z.string(),
  kid: z.string().min(1).max(256).optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
});

const JwksSchema = z.object({ keys: z.array(z.unknown()).max(64) });

interface Entry {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly fetchedAt: number;
  readonly expiresAt: number;
  /** Earliest time a refetch is attempted again, after a fetch or a failed one. */
  readonly retryAt: number;
}

function maxAgeMs(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  const seconds = match?.[1];
  if (seconds === undefined) return JWKS_DEFAULT_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, Number(seconds) * 1000));
}

async function importSigningKeys(body: unknown): Promise<Map<string, CryptoKey>> {
  const parsed = JwksSchema.safeParse(body);
  if (!parsed.success) throw new Error('The JWKS document has no `keys` array.');
  const keys = new Map<string, CryptoKey>();
  for (const candidate of parsed.data.keys) {
    const jwk = JwkSchema.safeParse(candidate);
    if (!jwk.success) continue;
    const { kty, kid, alg, use, n, e } = jwk.data;
    const usable =
      kty === 'RSA' &&
      kid !== undefined &&
      n !== undefined &&
      e !== undefined &&
      (alg === undefined || alg === 'RS256') &&
      (use === undefined || use === 'sig');
    if (!usable) continue;
    try {
      keys.set(
        kid,
        await crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true }, RS256, false, [
          'verify',
        ]),
      );
    } catch {
      // A malformed key in the set must not take the provider's other keys down with it.
      continue;
    }
  }
  return keys;
}

/**
 * Per-isolate cache of each provider's signing keys. It honours `Cache-Control: max-age`
 * (clamped), refetches on an unknown `kid` at most once per JWKS_REFETCH_INTERVAL_MS to pick
 * up key rotation, collapses concurrent fetches into one, and rides out a provider outage on
 * the last good keys for up to JWKS_MAX_STALE_MS.
 */
export class JwksCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();

  constructor(
    private readonly fetcher: JwksFetcher,
    private readonly clock: () => number = Date.now,
  ) {}

  async key(url: string, kid: string, label: string): Promise<CryptoKey | null> {
    let entry = this.entries.get(url);
    if (entry === undefined || (entry.expiresAt <= this.clock() && entry.retryAt <= this.clock())) {
      entry = await this.refresh(url, label);
    }
    const hit = entry.keys.get(kid);
    if (hit !== undefined || entry.retryAt > this.clock()) return hit ?? null;
    entry = await this.refresh(url, label);
    return entry.keys.get(kid) ?? null;
  }

  private refresh(url: string, label: string): Promise<Entry> {
    const pending = this.inflight.get(url);
    if (pending !== undefined) return pending;
    const request = this.load(url, label).finally(() => this.inflight.delete(url));
    this.inflight.set(url, request);
    return request;
  }

  private async load(url: string, label: string): Promise<Entry> {
    const now = this.clock();
    try {
      const response = await this.fetcher(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const keys = await importSigningKeys(await response.json());
      if (keys.size === 0) throw new Error('no usable RS256 signing keys');
      const entry: Entry = {
        keys,
        fetchedAt: now,
        expiresAt: now + maxAgeMs(response.headers.get('Cache-Control')),
        retryAt: now + JWKS_REFETCH_INTERVAL_MS,
      };
      this.entries.set(url, entry);
      return entry;
    } catch (error) {
      const stale = this.entries.get(url);
      if (stale !== undefined && now - stale.expiresAt < JWKS_MAX_STALE_MS) {
        console.warn(`Serving cached ${label} signing keys: refreshing ${url} failed.`, error);
        const held: Entry = { ...stale, retryAt: now + JWKS_REFETCH_INTERVAL_MS };
        this.entries.set(url, held);
        return held;
      }
      console.error(`Could not load ${label} signing keys from ${url}.`, error);
      throw new ApiFailure(
        'provider_unavailable',
        `${label} sign-in cannot be checked right now. Try again in a minute; guest play is unaffected.`,
        { retryAfterMs: JWKS_REFETCH_INTERVAL_MS },
      );
    }
  }
}
