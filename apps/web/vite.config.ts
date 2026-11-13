import {
  RAPIER_COMPAT_MODULE,
  RAPIER_WASM_NAME,
  streamRapierWasm,
} from '@coinposh/sim/rapier-wasm';
import { defineConfig, loadEnv, parseSync, type ESTree, type Plugin } from 'vite';

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

/**
 * Ships Rapier's wasm as a hashed asset beside the sim worker instead of 4 MB of base64 inside
 * it, so the browser compiles it while it streams in and caches it on its own. Build only: the
 * dev server keeps the inlined copy, which loads the same bytes.
 */
function rapierWasmAsset(): Plugin {
  return {
    name: 'coinposh:rapier-wasm-asset',
    apply: 'build',
    enforce: 'pre',
    transform: {
      filter: { id: RAPIER_COMPAT_MODULE },
      handler(code) {
        const streamed = streamRapierWasm(code, (wasm) => {
          const referenceId = this.emitFile({
            type: 'asset',
            name: RAPIER_WASM_NAME,
            source: wasm,
          });
          return `import.meta.ROLLUP_FILE_URL_${referenceId}`;
        });
        return {
          code: streamed,
          map: null,
        };
      },
    },
  };
}

const SHARED_SOURCE = /[\\/]packages[\\/]shared[\\/]src[\\/].*\.ts$/;

/** Where every call or `new` in `node` starts, not looking into function or class bodies. */
function callStarts(node: unknown, starts: Set<number>): void {
  if (Array.isArray(node)) {
    for (const child of node) callStarts(child, starts);
    return;
  }
  if (typeof node !== 'object' || node === null || !('type' in node)) return;
  const { type, start } = node as ESTree.Node;
  if (/Function|Class/.test(type)) return;
  if (type === 'CallExpression' || type === 'NewExpression') starts.add(start);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && typeof value === 'object') callStarts(value, starts);
  }
}

/**
 * Marks the values packages/shared declares at module level (zod schemas, mostly) as pure in
 * the sim worker, which reads only its constants, so the bundler drops every schema the worker
 * never uses and zod with them. Building a schema has no effect beyond the value it returns.
 */
function pureSharedValues(): Plugin {
  return {
    name: 'coinposh:pure-shared-values',
    apply: 'build',
    enforce: 'pre',
    transform: {
      filter: { id: SHARED_SOURCE },
      handler(code, id) {
        const { program, errors } = parseSync(id, code);
        if (errors.length > 0) {
          this.error(`could not parse ${id}: ${errors.map((e) => e.message).join('; ')}`);
        }
        const starts = new Set<number>();
        for (const statement of program.body) {
          const declaration =
            statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
          if (declaration?.type !== 'VariableDeclaration') continue;
          for (const { init } of declaration.declarations) callStarts(init, starts);
        }
        let annotated = code;
        for (const start of [...starts].sort((a, b) => b - a)) {
          annotated = `${annotated.slice(0, start)}/* @__PURE__ */ ${annotated.slice(start)}`;
        }
        return { code: annotated, map: null };
      },
    },
  };
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
    worker: {
      plugins: () => [rapierWasmAsset(), pureSharedValues()],
      rolldownOptions: {
        treeshake: {
          moduleSideEffects: [{ test: SHARED_SOURCE, sideEffects: false }],
          // Rapier's -compat entry freezes its whole namespace into its default export at load,
          // which would keep every binding the sim never touches (src/rapier.ts names the rest).
          manualPureFunctions: ['Object.freeze'],
        },
      },
    },
    build: {
      // The lazily imported stage chunk is three/webgpu (~815 kB minified). It loads after first paint, so the budget sits just above it to keep flagging real growth.
      chunkSizeWarningLimit: 900,
      // Only Safari before 17 lacks modulepreload, and there the preloaded chunks still load through
      // their imports, so the polyfill is bytes on the critical path for no change in behavior.
      modulePreload: { polyfill: false },
    },
  };
});
