// Headless timing review for the juice effects: boots the vfx preview in Chromium on the
// WebGL2 fallback (CPU particles) and on WebGPU (TSL compute), plays each effect, takes
// screenshots at the beats that matter, records a video per run and fails on any console
// error or on an effect that leaves no trace in the stats.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node apps/web/src/vfx/verify.mjs [outDir]
//
// Playwright is not a repo dependency yet, so the module path comes from the environment.
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'coinposh-vfx-verify'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const VIEWPORT = { width: 540, height: 960 };

/** Each beat: play an effect, then shoot at these ms offsets (wall clock, approximate). */
const BEATS = [
  { effect: 'drop', shots: [120, 380], settle: 1600, expect: (s) => s.played.includes('drop') },
  { effect: 'fusion', shots: [200, 360, 520, 800], settle: 1800, expect: (s) => s.arrivals >= 1 },
  { effect: 'cascade', shots: [300, 1200], settle: 1200 },
  { effect: 'obscene', shots: [250, 900, 2000], settle: 3200, expect: (s) => s.stats.confetti > 0 },
];

const runs = [
  { name: 'webgl', query: 'webgl&manual', mode: 'cpu' },
  { name: 'webgl-reduced', query: 'webgl&manual&reduced', mode: 'cpu' },
  { name: 'webgl-fr-low', query: 'webgl&manual&lang=fr&quality=low', mode: 'cpu' },
  { name: 'webgpu', query: 'manual', mode: 'gpu', optional: true },
];

/**
 * Headless Chromium on SwiftShader can hand out a GPUDevice that Dawn drops within a second
 * ("A valid external Instance reference no longer exists"), with no app code involved. Check a
 * bare device first so that environment fault is reported as such, not blamed on the effects.
 */
async function probeWebGpu(browser, url) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL('/@vite/client', url).href);
    return await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return 'no adapter';
      const device = await adapter.requestDevice();
      let lost = '';
      void device.lost.then((info) => (lost = info.message || 'lost'));
      await new Promise((r) => setTimeout(r, 2000));
      return lost ? `device lost: ${lost}` : 'ok';
    });
  } finally {
    await context.close();
  }
}

const server = await createServer({
  root: webRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, forwardConsole: false },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('vite did not report a port');
const base = `http://127.0.0.1:${address.port}/src/vfx/preview.html`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'],
});
await mkdir(outDir, { recursive: true });
const report = [];
let failures = 0;

try {
  for (const run of runs) {
    const dir = join(outDir, run.name);
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      recordVideo: { dir, size: VIEWPORT },
    });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.message }));
    const entry = { name: run.name, ok: false, beats: [] };
    report.push(entry);
    try {
      if (run.mode === 'gpu') {
        const probe = await probeWebGpu(browser, base);
        if (probe !== 'ok') {
          if (!run.optional) throw new Error(`WebGPU unusable here: ${probe}`);
          entry.skipped = `WebGPU unusable in this browser (${probe})`;
          entry.ok = true;
          console.info(`skip ${run.name}: ${entry.skipped}`);
          continue;
        }
      }
      await page.goto(`${base}?${run.query}`);
      await page.waitForFunction(() => globalThis.__vfx?.ready || globalThis.__vfx?.error, null, {
        timeout: 90_000,
      });
      let state = await page.evaluate(() => globalThis.__vfx);
      if (state.error) throw new Error(`preview failed: ${state.error}`);
      if (run.mode === 'gpu' && state.backend !== 'webgpu') {
        if (run.optional) {
          entry.skipped = `WebGPU unavailable here (${state.backend})`;
          entry.ok = true;
          console.info(`skip ${run.name}: ${entry.skipped}`);
          continue;
        }
        throw new Error(`expected WebGPU, got ${state.backend}`);
      }
      await page.waitForTimeout(500);
      for (const beat of BEATS) {
        const t0 = Date.now();
        await page.evaluate((e) => globalThis.__vfxPlay(e), beat.effect);
        const samples = [];
        for (const at of beat.shots) {
          const wait = at - (Date.now() - t0);
          if (wait > 0) await page.waitForTimeout(wait);
          await page.screenshot({
            path: join(dir, `${beat.effect}-${String(at).padStart(4, '0')}ms.png`),
          });
          const s = await page.evaluate(() => globalThis.__vfx.stats);
          samples.push({ at, ...s });
        }
        const rest = beat.settle - (Date.now() - t0);
        if (rest > 0) await page.waitForTimeout(rest);
        state = await page.evaluate(() => globalThis.__vfx);
        entry.beats.push({ effect: beat.effect, samples });
        if (state.stats.mode !== run.mode)
          throw new Error(`particles ran on ${state.stats.mode}, expected ${run.mode}`);
        const peak = Math.max(
          ...samples.map((s) => s.particles + s.confetti + s.flashes + s.shockwaves),
        );
        if (peak === 0) throw new Error(`${beat.effect} left no particles, flashes or rings`);
        if (beat.expect && !beat.expect(state))
          throw new Error(`${beat.effect} expectation failed: ${JSON.stringify(state)}`);
      }
      const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
      if (errors.length > 0) throw new Error(`console errors: ${JSON.stringify(errors)}`);
      entry.ok = true;
      entry.frames = state.frames;
      console.info(
        `ok   ${run.name.padEnd(14)} ${state.backend} frames=${state.frames} arrivals=${state.arrivals}`,
      );
    } catch (error) {
      failures++;
      entry.error = error instanceof Error ? error.message : String(error);
      console.error(`FAIL ${run.name}: ${entry.error}`);
    } finally {
      entry.logs = logs;
      await context.close();
    }
  }
} finally {
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await server.close();
}

console.info(`${runs.length - failures}/${runs.length} runs passed; output in ${outDir}`);
process.exitCode = failures > 0 ? 1 : 0;
