// Headless render check for the coin field: boots the lookdev page in Chromium on the WebGL2
// fallback and on the WebGPU path, screenshots every scene at deviceScaleFactor 1, measures
// the pixels, and rehearses GPU loss on both backends.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node apps/web/src/scene/coins/lookdev/verify.mjs [outDir]
//
// Playwright is not a repo dependency yet, so the module path comes from the environment
// (any playwright >= 1.50 works). CHROMIUM_PATH optionally points at a Chromium binary.
// Exits non-zero on the first failed scenario; the report lands in outDir/report.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../../../..');
const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'coinposh-coin-verify'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const VIEWPORT = { width: 1280, height: 800 };
const BACKGROUND = [7, 11, 20];

const scenarios = [
  {
    name: 'webgl-hero',
    query: 'backend=webgl&t=1',
    expect: { backend: 'webgl2', losses: 0, drawCalls: 6 },
  },
  {
    name: 'webgl-macro-gold',
    query: 'backend=webgl&scene=macro&tier=gold&t=2',
    expect: { backend: 'webgl2', losses: 0 },
  },
  {
    name: 'webgl-macro-heirloom',
    query: 'backend=webgl&scene=macro&tier=heirloom&t=2',
    expect: { backend: 'webgl2', losses: 0 },
  },
  {
    name: 'webgl-edge-silver',
    query: 'backend=webgl&scene=edge&tier=silver&t=1',
    expect: { backend: 'webgl2', losses: 0 },
  },
  {
    name: 'webgl-pile',
    query: 'backend=webgl&scene=pile&t=1',
    expect: { backend: 'webgl2', losses: 0, far: true },
  },
  {
    name: 'webgl-context-loss',
    query: 'backend=webgl&t=1&loseAfter=8',
    expect: { backend: 'webgl2', losses: 1, boots: 2 },
  },
  { name: 'webgpu-hero', query: 't=1', expect: { webgpuOrFallback: true } },
  {
    name: 'webgpu-device-loss',
    query: 't=1&loseAfter=8',
    expect: { backend: 'webgl2', losses: 1, boots: 2 },
  },
];

function fail(scenario, message) {
  throw new Error(`${scenario}: ${message}`);
}

async function measure(analysisPage, png) {
  return analysisPage.evaluate(
    async ({ data, background }) => {
      const image = new globalThis.Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new globalThis.OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const { data: px } = context.getImageData(0, 0, image.width, image.height);
      let lit = 0;
      let chromatic = 0;
      let highlights = 0;
      let lumaSum = 0;
      const hues = new Set();
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        const distance =
          Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]);
        if (distance < 24) continue;
        lit += 1;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (max > 235) highlights += 1;
        if (max - min > 40) {
          chromatic += 1;
          const d = max - min;
          let h;
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          hues.add(Math.floor(((h * 60 + 360) % 360) / 30));
        }
      }
      const total = px.length / 4;
      return {
        coverage: lit / total,
        chromatic: chromatic / Math.max(lit, 1),
        highlights: highlights / Math.max(lit, 1),
        meanLuma: lumaSum / Math.max(lit, 1),
        hueBuckets: hues.size,
        uniform: lit === 0 || lit === total,
      };
    },
    { data: png.toString('base64'), background: BACKGROUND },
  );
}

const server = await createServer({
  root: webRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, forwardConsole: false },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('vite did not report a port');
const base = `http://127.0.0.1:${address.port}/src/scene/coins/lookdev/`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'],
});
await mkdir(outDir, { recursive: true });
const analysisPage = await browser.newPage();
const report = [];
let failures = 0;

try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (message) => logs.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => logs.push({ type: 'pageerror', text: error.message }));
    const entry = { name: scenario.name, query: scenario.query, ok: false };
    report.push(entry);
    try {
      await page.goto(`${base}?${scenario.query}`);
      await page.waitForFunction(
        () => globalThis.__lookdev?.ready === true || globalThis.__lookdev?.failed,
        null,
        { timeout: 60_000 },
      );
      await page.waitForTimeout(400);
      const state = await page.evaluate(() => globalThis.__lookdev);
      const png = await page.screenshot();
      await writeFile(join(outDir, `${scenario.name}.png`), png);
      const pixels = await measure(analysisPage, png);
      Object.assign(entry, { state, pixels, logs });

      const expected = scenario.expect;
      if (state.failed) fail(scenario.name, `lookdev failed: ${state.failed}`);
      const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
      if (errors.length > 0) fail(scenario.name, `console errors: ${JSON.stringify(errors)}`);
      if (expected.backend && state.backend !== expected.backend)
        fail(scenario.name, `rendered on ${state.backend}, expected ${expected.backend}`);
      if (expected.webgpuOrFallback && state.backend === 'webgl2') {
        const warned = logs.some(
          (l) => l.type === 'warning' && l.text.startsWith('[coins] WebGPU'),
        );
        if (!warned) fail(scenario.name, 'fell back to WebGL2 without a [coins] warning');
      }
      if (expected.losses !== undefined && state.losses.length !== expected.losses)
        fail(scenario.name, `saw ${state.losses.length} losses, expected ${expected.losses}`);
      if (expected.losses) {
        const logged = logs.filter((l) => l.type === 'warning' && l.text.startsWith('[coins]'));
        if (logged.length !== expected.losses)
          fail(scenario.name, `expected ${expected.losses} [coins] loss warning(s) in the console`);
      }
      if (expected.drawCalls !== undefined && state.stats.drawCalls !== expected.drawCalls)
        fail(
          scenario.name,
          `${state.stats.drawCalls} coin draw calls, expected ${expected.drawCalls}`,
        );
      if (expected.boots !== undefined && state.boots !== expected.boots)
        fail(scenario.name, `booted ${state.boots} times, expected ${expected.boots}`);
      if (expected.far && !(state.stats.far > 0 && state.stats.near > 0))
        fail(scenario.name, `pile should mix LODs, got ${JSON.stringify(state.stats)}`);
      if (state.stats.drawCalls < 1 || state.stats.drawCalls > 12)
        fail(scenario.name, `coin draw calls ${state.stats.drawCalls} outside 1..12`);
      if (pixels.uniform || pixels.coverage < 0.03)
        fail(scenario.name, `canvas is blank (coverage ${pixels.coverage.toFixed(3)})`);
      if (pixels.highlights < 0.002)
        fail(scenario.name, `no specular highlights (${pixels.highlights.toFixed(4)})`);
      if (pixels.meanLuma < 40 || pixels.meanLuma > 225)
        fail(scenario.name, `mean coin luma ${pixels.meanLuma.toFixed(1)} is crushed or blown`);
      if (scenario.name === 'webgl-macro-heirloom' && pixels.hueBuckets < 6)
        fail(scenario.name, `heirloom should be prismatic, saw ${pixels.hueBuckets} hue buckets`);
      if (scenario.name === 'webgl-macro-gold' && pixels.chromatic < 0.3)
        fail(scenario.name, `gold reads grey (chromatic ${pixels.chromatic.toFixed(2)})`);
      entry.ok = true;
      console.info(
        `ok   ${scenario.name.padEnd(22)} ${state.backend} boots=${state.boots} losses=${state.losses.length} draws=${state.stats.drawCalls} coverage=${pixels.coverage.toFixed(3)}`,
      );
    } catch (error) {
      failures += 1;
      entry.error = error instanceof Error ? error.message : String(error);
      entry.logs = logs;
      console.error(`FAIL ${entry.error}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await server.close();
}

console.info(
  `${scenarios.length - failures}/${scenarios.length} scenarios passed; output in ${outDir}`,
);
process.exitCode = failures > 0 ? 1 : 0;
