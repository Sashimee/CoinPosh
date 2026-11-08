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

// The real venue at phone size: the front row of copper, silver and gold coins where the player
// actually looks, rendered through the game's post stack with its bloom.
const TABLE_VIEWPORT = { width: 390, height: 844 };
const tableScenarios = [
  { name: 'table-front-row', query: 'quality=high&t=1' },
  { name: 'table-front-row-low', query: 'quality=low&t=1' },
];
// Scene-linear luminance a coin may reach; diamond and heirloom carry their own sparkle and
// are allowed a brighter ceiling (see highlightCeiling in tiers.ts).
const PEAK_LIMIT = { copper: 2, silver: 2, gold: 2, platinum: 2, diamond: 3.5, heirloom: 3.5 };

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
        // Coin highlights roll off below white on purpose (compressHighlight in materials.ts), so
        // a glint is a near-white pixel rather than a clipped one.
        if (max > 215) highlights += 1;
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

async function measureFrontRow(analysisPage, png, rect, tiers) {
  return analysisPage.evaluate(
    async ({ data, rect, tiers }) => {
      const image = new globalThis.Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new globalThis.OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const { data: px } = context.getImageData(0, 0, image.width, image.height);
      const out = {};
      for (const [tier, mask] of Object.entries(tiers)) {
        const lumas = [];
        const sum = [0, 0, 0];
        let index = 0;
        let inside = false;
        for (const run of mask) {
          if (inside) {
            for (let i = index; i < index + run; i++) {
              const x = i % image.width;
              const y = Math.floor(i / image.width);
              if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height)
                continue;
              const r = px[i * 4];
              const g = px[i * 4 + 1];
              const b = px[i * 4 + 2];
              sum[0] += r;
              sum[1] += g;
              sum[2] += b;
              lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
            }
          }
          index += run;
          inside = !inside;
        }
        const n = lumas.length;
        if (n === 0) {
          out[tier] = { pixels: 0 };
          continue;
        }
        lumas.sort((a, b) => a - b);
        const [r, g, b] = sum.map((v) => v / n / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        const light = (max + min) / 2;
        let hue = 0;
        if (d > 0) {
          if (max === r) hue = ((g - b) / d) % 6;
          else if (max === g) hue = (b - r) / d + 2;
          else hue = (r - g) / d + 4;
        }
        out[tier] = {
          pixels: n,
          mean: [r, g, b].map((v) => Math.round(v * 255)),
          hue: (hue * 60 + 360) % 360,
          saturation: d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1)),
          blueOverRed: b / Math.max(r, 1e-3),
          lumaP10: lumas[Math.floor(n * 0.1)],
          lumaP98: lumas[Math.floor(n * 0.98)],
        };
      }
      return out;
    },
    { data: png.toString('base64'), rect, tiers },
  );
}

function checkTable(name, state, report, front) {
  if (state.failed) fail(name, `table lookdev failed: ${state.failed}`);
  if (!state.frontRow) fail(name, 'table lookdev did not report a front row');
  const { bloomThreshold, sunburst } = report;
  if (!(sunburst.pixels > 0)) fail(name, 'the sunburst emblem is not in view');
  for (const [tier, stats] of Object.entries(report.tiers)) {
    if (!stats || stats.pixels === 0) continue;
    if (stats.peak > PEAK_LIMIT[tier])
      fail(name, `${tier} peaks at ${stats.peak.toFixed(2)}, limit ${PEAK_LIMIT[tier]}`);
    if (stats.peak - bloomThreshold > sunburst.peak - bloomThreshold)
      fail(name, `${tier} blooms harder than the sunburst (${stats.peak} > ${sunburst.peak})`);
  }
  for (const tier of ['copper', 'silver', 'gold']) {
    const f = front[tier];
    if (!f || f.pixels < 200) fail(name, `front row has only ${f?.pixels ?? 0} ${tier} pixels`);
    // Rim highlight against the shaded field and recesses: a flat chip has almost no spread.
    if (f.lumaP98 - f.lumaP10 < 30)
      fail(
        name,
        `${tier} reads flat (luma p10 ${f.lumaP10.toFixed(0)}, p98 ${f.lumaP98.toFixed(0)})`,
      );
    if (f.lumaP98 > 250) fail(name, `${tier} front-row coins clip to white`);
  }
  const { copper, silver, gold } = front;
  if (copper.hue < 8 || copper.hue > 30 || copper.saturation < 0.3)
    fail(name, `copper reads off-hue ${JSON.stringify(copper)}`);
  if (gold.hue < 30 || gold.hue > 52 || gold.saturation < 0.3)
    fail(name, `gold reads off-hue or khaki ${JSON.stringify(gold)}`);
  if (silver.blueOverRed > 1 || silver.saturation > 0.3 || (silver.hue > 180 && silver.hue < 330))
    fail(name, `silver should read neutral, not blue-grey ${JSON.stringify(silver)}`);
  if (silver.saturation > gold.saturation * 0.7 || silver.saturation > copper.saturation * 0.7)
    fail(name, 'silver is nearly as saturated as gold or copper');
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

  for (const scenario of tableScenarios) {
    const page = await browser.newPage({ viewport: TABLE_VIEWPORT, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (message) => logs.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => logs.push({ type: 'pageerror', text: error.message }));
    const entry = { name: scenario.name, query: scenario.query, ok: false };
    report.push(entry);
    try {
      await page.goto(`${base}table.html?${scenario.query}`);
      await page.waitForFunction(
        () => globalThis.__table?.ready === true || globalThis.__table?.failed,
        null,
        { timeout: 90_000 },
      );
      await page.waitForTimeout(600);
      const state = await page.evaluate(() => ({ ...globalThis.__table, measure: undefined }));
      const png = await page.screenshot();
      await writeFile(join(outDir, `${scenario.name}.png`), png);
      if (state.frontRow)
        await writeFile(
          join(outDir, `${scenario.name}-crop.png`),
          await page.screenshot({ clip: state.frontRow }),
        );
      const hdr = await page.evaluate(() => globalThis.__table.measure());
      const masks = Object.fromEntries(
        ['copper', 'silver', 'gold'].map((tier) => [tier, hdr.tiers[tier]?.mask ?? []]),
      );
      const front = await measureFrontRow(analysisPage, png, state.frontRow, masks);
      const peaks = Object.fromEntries(
        Object.entries(hdr.tiers).map(([tier, stats]) => [tier, stats.peak]),
      );
      Object.assign(entry, { state, peaks, sunburst: hdr.sunburst.peak, front, logs });
      const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
      if (errors.length > 0) fail(scenario.name, `console errors: ${JSON.stringify(errors)}`);
      checkTable(scenario.name, state, hdr, front);
      entry.ok = true;
      console.info(
        `ok   ${scenario.name.padEnd(22)} ${state.backend} sunburst=${hdr.sunburst.peak.toFixed(1)} coins=${hdr.coins.peak.toFixed(2)} silver b/r=${front.silver.blueOverRed.toFixed(2)}`,
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
  `${scenarios.length + tableScenarios.length - failures}/${scenarios.length + tableScenarios.length} scenarios passed; output in ${outDir}`,
);
process.exitCode = failures > 0 ? 1 : 0;
