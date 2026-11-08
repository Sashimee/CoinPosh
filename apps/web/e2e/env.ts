import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREVIEW_PORT = 4417;
export const DEV_PORT = 4418;

export const GAME_URL = `http://127.0.0.1:${PREVIEW_PORT}/CoinPosh/`;
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
