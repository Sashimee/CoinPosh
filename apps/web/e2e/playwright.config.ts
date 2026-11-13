import { defineConfig, devices } from '@playwright/test';
import { APP_DIR, GAME_URL, PREVIEW_PORT, REPORT_DIR, RESULTS_DIR, VIEWPORT } from './env.ts';

const ci = Boolean(process.env.CI);

/**
 * The suites run against the Demo Mode build (no `VITE_API_URL`) served by `vite preview`, the
 * same bundle GitHub Pages ships, at the same root base `/`.
 *
 * Chromium is pinned to WebGL2 on SwiftShader: CI runners have no GPU, and the perf budgets in
 * budgets.ts are calibrated for exactly that rasteriser.
 *
 * This file sits in e2e/ rather than the app root because the shared ESLint config type-checks
 * every .ts file through the nearest tsconfig, and only e2e/tsconfig.json is this suite's own.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: ci
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: REPORT_DIR }]]
    : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    hasTouch: false,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [
    { name: 'e2e', testMatch: /\.spec\.ts$/, outputDir: `${RESULTS_DIR}/e2e` },
    { name: 'perf', testMatch: /\.perf\.ts$/, outputDir: `${RESULTS_DIR}/perf` },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
    cwd: APP_DIR,
    url: GAME_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_API_URL: '' },
  },
});
