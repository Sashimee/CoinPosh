import { defineConfig, loadEnv } from 'vite';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function resolveApiUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `VITE_API_URL is not a valid absolute URL: "${value}". Set it to the API origin (for example https://api.devcoinposh.bas.lu) or leave it empty to build Demo Mode.`,
    );
  }
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) {
    throw new Error(
      `VITE_API_URL must use https:// (http:// is only allowed for localhost): "${value}". The site is served over HTTPS and browsers block mixed-content API calls.`,
    );
  }
  return url.href.replace(/\/+$/, '');
}

const TURNSTILE_SITE_KEY = /^[\w-]+$/;

function resolveTurnstileSiteKey(raw: string | undefined): string | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return undefined;
  }
  if (!TURNSTILE_SITE_KEY.test(value)) {
    throw new Error(
      `VITE_TURNSTILE_SITE_KEY is not a Cloudflare Turnstile site key: "${value}". Copy the site key (not the secret key) from the Turnstile dashboard.`,
    );
  }
  return value;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const apiUrl = resolveApiUrl(env.VITE_API_URL);
  const turnstileSiteKey = resolveTurnstileSiteKey(env.VITE_TURNSTILE_SITE_KEY);
  if (apiUrl !== undefined && turnstileSiteKey === undefined) {
    throw new Error(
      `VITE_API_URL is set (${apiUrl}) but VITE_TURNSTILE_SITE_KEY is empty, so live guest sign-up could not pass Cloudflare Turnstile. Set the repository variable VITE_TURNSTILE_SITE_KEY to the site key paired with the server's TURNSTILE_SECRET_KEY (for local runs, Cloudflare's always-pass test key 1x00000000000000000000AA), or unset VITE_API_URL to build Demo Mode.`,
    );
  }

  return {
    define: {
      // An empty VITE_API_URL (an unset repo variable expands to '') must reach the client as undefined, which selects Demo Mode.
      'import.meta.env.VITE_API_URL': apiUrl === undefined ? 'undefined' : JSON.stringify(apiUrl),
      'import.meta.env.VITE_TURNSTILE_SITE_KEY':
        turnstileSiteKey === undefined ? 'undefined' : JSON.stringify(turnstileSiteKey),
    },
    build: {
      // The lazily imported stage chunk is three/webgpu (~815 kB minified). It loads after first paint, so the budget sits just above it to keep flagging real growth.
      chunkSizeWarningLimit: 900,
    },
  };
});
