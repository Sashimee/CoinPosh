export type NetMode =
  { readonly kind: 'live'; readonly apiUrl: string } | { readonly kind: 'demo' };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `vite.config.ts` already normalises `VITE_API_URL` at build time (empty becomes undefined).
 * This re-checks it at runtime because a hand-edited bundle or a test can hand us anything.
 */
export function resolveNetMode(apiUrl: string | undefined): NetMode {
  const value = apiUrl?.trim() ?? '';
  if (value === '') return { kind: 'demo' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `CoinPosh net: VITE_API_URL "${value}" is not an absolute URL. Rebuild with the Worker origin or leave it unset for Demo Mode.`,
    );
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(
      `CoinPosh net: VITE_API_URL "${value}" must use https:// (http:// only for localhost).`,
    );
  }
  return { kind: 'live', apiUrl: url.href.replace(/\/+$/, '') };
}

export function currentNetMode(): NetMode {
  const raw: unknown = import.meta.env.VITE_API_URL;
  return resolveNetMode(typeof raw === 'string' ? raw : undefined);
}
