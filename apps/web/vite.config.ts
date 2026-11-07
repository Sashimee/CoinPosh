import { defineConfig, loadEnv } from 'vite';

const PAGES_BASE = '/CoinPosh/';
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
      `VITE_API_URL is not a valid absolute URL: "${value}". Set it to the Worker origin (for example https://coinposh-server.<account>.workers.dev) or leave it empty to build Demo Mode.`,
    );
  }
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) {
    throw new Error(
      `VITE_API_URL must use https:// (http:// is only allowed for localhost): "${value}". The Pages site is served over HTTPS and browsers block mixed-content API calls.`,
    );
  }
  return url.href.replace(/\/+$/, '');
}

export default defineConfig(({ command, mode }) => {
  const apiUrl = resolveApiUrl(loadEnv(mode, '.', 'VITE_').VITE_API_URL);

  return {
    base: command === 'build' ? PAGES_BASE : '/',
    define: {
      // An empty VITE_API_URL (an unset repo variable expands to '') must reach the client as undefined, which selects Demo Mode.
      'import.meta.env.VITE_API_URL': apiUrl === undefined ? 'undefined' : JSON.stringify(apiUrl),
    },
    build: {
      // The lazily imported stage chunk is three/webgpu (~815 kB minified). It loads after first paint, so the budget sits just above it to keep flagging real growth.
      chunkSizeWarningLimit: 900,
    },
  };
});
