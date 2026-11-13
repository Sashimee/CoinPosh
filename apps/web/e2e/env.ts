import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixed ports, served with `--strictPort` so a leftover server fails the run loudly. Parallel
 * worktrees each pick their own pair through E2E_PREVIEW_PORT and E2E_DEV_PORT.
 */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? '';
  if (raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} must be a port between 1024 and 65535, got "${raw}"`);
  }
  return port;
}

export const PREVIEW_PORT = portFromEnv('E2E_PREVIEW_PORT', 4417);
export const DEV_PORT = portFromEnv('E2E_DEV_PORT', 4418);

/** The app is served at the root: vite.config.ts keeps Vite's default base `/`, as Pages does. */
export const GAME_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;
export const CRATE_HARNESS_URL = `http://127.0.0.1:${DEV_PORT}/e2e/harness/crates.html`;

/** iPhone 12-class portrait at DPR 1, the reference phone in 01-ARCHITECTURE.md. */
export const VIEWPORT = { width: 390, height: 844 } as const;

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS_DIR = join(APP_DIR, 'test-results');
export const REPORT_DIR = join(APP_DIR, 'playwright-report');

/**
 * The reviewer screenshot set and the perf JSON, which perf.yml uploads. They sit beside the
 * projects' output dirs, not inside them, so running one project does not wipe the other's.
 */
export const SCREENSHOT_DIR = join(RESULTS_DIR, 'screenshots');
export const PERF_DIR = join(RESULTS_DIR, 'perf-report');
