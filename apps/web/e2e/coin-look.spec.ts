import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { BOOT_HOLD_MS, PLAYABLE_MARK } from '../src/scene/quality/scaleHold.ts';
import { SCREENSHOT_DIR } from './env.ts';
import { bootGame, expect, expectDemoMode, gameUrl, tapDrop, test } from './fixtures.ts';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Layout {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * Where coins rest on the front deck, clear of the side posts. The shelf heap is not measured:
   * the glass back panel ghosts coins into it by an amount that follows the pusher's phase.
   */
  readonly deck: Rect;
  /**
   * Silhouette pixels per coin pixel on the front deck. Portrait: round coins 0.109 to 0.136, the
   * crumpled look (a dark notched outline bitten into each coin) 0.200 to 0.203. Landscape, where
   * coins are half the size: round 0.130 to 0.180 (the poster included), crumpled 0.203 to 0.208.
   */
  readonly maxRoughness: number;
  /**
   * Whether the poster frames the table as the live camera does. In landscape index.html shows
   * the portrait poster centred on a blurred copy of itself, so its deck and lip are elsewhere.
   */
  readonly posterFramesTable: boolean;
}

const PORTRAIT: Layout = {
  name: 'portrait',
  viewport: { width: 390, height: 844 },
  deck: { left: 20, top: 470, right: 370, bottom: 545 },
  maxRoughness: 0.16,
  posterFramesTable: true,
};

const LAYOUTS: readonly Layout[] = [
  PORTRAIT,
  {
    name: 'landscape',
    viewport: { width: 844, height: 390 },
    deck: { left: 305, top: 266, right: 555, bottom: 297 },
    maxRoughness: 0.195,
    posterFramesTable: false,
  },
];

/** Silver reads as bright and nearly neutral; the felt is dark blue and the rails gold. */
const COIN_MIN_LUMA = 0.42;
const COIN_MAX_SATURATION = 0.3;
/** Mean luminance of the coin pixels: polished silver 0.62 to 0.70, the grey blobs 0.51 to 0.55. */
const MIN_COIN_LUMA = 0.59;
/** The front deck is always covered by the opening heap; less means coins were not found. */
const MIN_FRONT_COVERAGE = 0.25;

/**
 * The front rails and fascia are found as a profile of gold per row, over the lower table and
 * two column strips that miss the tap marker in the middle. Each frame's profile is matched to
 * the playable frame's within `LIP_SEARCH_PX`; the best offset is how far the lip moved.
 */
const LIP_ROWS = { from: 0.5, to: 0.8 } as const;
const LIP_STRIPS = [
  [0.36, 0.46],
  [0.54, 0.64],
] as const;
const LIP_SEARCH_PX = 8;
const MAX_LIP_SHIFT_PX = 2;

const TAPS = 10;
const SHOT_AFTER_TAPS = new Set([1, 2, 5, 10]);
const TAP_GAP_MS = 250;
const AFTER_SHEET_CLOSE_MS = 600;

interface FrameLook {
  readonly label: string;
  /** Share of the deck's pixels that read as coin. */
  readonly coverage: number;
  readonly roughness: number;
  readonly luma: number;
  /** Gold per row of the lower table, for the lip match. */
  readonly lip: readonly number[];
}

/** Measures a screenshot inside the page, which can decode the PNG. */
async function measure(page: Page, layout: Layout, label: string, png: Buffer): Promise<FrameLook> {
  const look = await page.evaluate(
    async ({ data, deck, viewport, minLuma, maxSaturation, rows, strips }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('OffscreenCanvas has no 2d context');
      context.drawImage(bitmap, 0, 0);

      const w = deck.right - deck.left;
      const h = deck.bottom - deck.top;
      const pixels = context.getImageData(deck.left, deck.top, w, h).data;
      const coin = new Uint8Array(w * h);
      const luma = new Float32Array(w * h);
      for (let i = 0; i < w * h; i += 1) {
        const r = (pixels[i * 4] ?? 0) / 255;
        const g = (pixels[i * 4 + 1] ?? 0) / 255;
        const b = (pixels[i * 4 + 2] ?? 0) / 255;
        const max = Math.max(r, g, b);
        const saturation = (max - Math.min(r, g, b)) / Math.max(max, 1e-4);
        luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        coin[i] = (luma[i] ?? 0) > minLuma && saturation < maxSaturation ? 1 : 0;
      }
      let area = 0;
      let edge = 0;
      let lumaSum = 0;
      for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
          const i = y * w + x;
          if (coin[i] !== 1) continue;
          area += 1;
          lumaSum += luma[i] ?? 0;
          const inside = coin[i - 1] && coin[i + 1] && coin[i - w] && coin[i + w];
          if (!inside) edge += 1;
        }
      }

      const top = Math.floor(rows.from * viewport.height);
      const bottom = Math.floor(rows.to * viewport.height);
      const lipPixels = context.getImageData(0, top, viewport.width, bottom - top).data;
      const columns = strips.flatMap(([from, to]) => {
        const start = Math.floor(from * viewport.width);
        const end = Math.floor(to * viewport.width);
        return Array.from({ length: end - start }, (_, k) => start + k);
      });
      const lip = Array.from({ length: bottom - top }, (_, y) => {
        let gold = 0;
        for (const x of columns) {
          const i = (y * viewport.width + x) * 4;
          const r = (lipPixels[i] ?? 0) / 255;
          const b = (lipPixels[i + 2] ?? 0) / 255;
          if (r > 0.45) gold += r - b;
        }
        return gold / columns.length;
      });

      return {
        coverage: area / ((w - 2) * (h - 2)),
        roughness: area === 0 ? 0 : edge / area,
        luma: area === 0 ? 0 : lumaSum / area,
        lip,
      };
    },
    {
      data: png.toString('base64'),
      deck: layout.deck,
      viewport: layout.viewport,
      minLuma: COIN_MIN_LUMA,
      maxSaturation: COIN_MAX_SATURATION,
      rows: LIP_ROWS,
      strips: LIP_STRIPS,
    },
  );
  return { label, ...look };
}

/** How many pixels `frame`'s lip sits below `reference`'s: the offset that best matches them. */
function lipShift(reference: readonly number[], frame: readonly number[]): number {
  let best = { shift: 0, error: Infinity };
  for (let shift = -LIP_SEARCH_PX; shift <= LIP_SEARCH_PX; shift += 1) {
    let error = 0;
    for (let y = LIP_SEARCH_PX; y < reference.length - LIP_SEARCH_PX; y += 1) {
      error += Math.abs((reference[y] ?? 0) - (frame[y + shift] ?? 0));
    }
    if (error < best.error) best = { shift, error };
  }
  return best.shift;
}

async function shoot(page: Page, layout: Layout, label: string): Promise<FrameLook> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const png = await page.screenshot({
    path: join(SCREENSHOT_DIR, `coin-look-${layout.name}-${label}.png`),
  });
  return measure(page, layout, label, png);
}

function expectRoundSilver(layout: Layout, look: FrameLook, reference: FrameLook): void {
  const shift = lipShift(reference.lip, look.lip);
  test.info().annotations.push({
    type: 'coin look',
    description: `${layout.name} ${look.label}: cover ${look.coverage.toFixed(2)} rough ${look.roughness.toFixed(3)} luma ${look.luma.toFixed(3)} lip ${shift} px`,
  });
  expect(look.coverage, `${look.label}: coins on the front deck`).toBeGreaterThan(
    MIN_FRONT_COVERAGE,
  );
  expect(look.roughness, `${look.label}: front deck coin rims are round`).toBeLessThanOrEqual(
    layout.maxRoughness,
  );
  expect(look.luma, `${look.label}: front deck coins read as silver`).toBeGreaterThanOrEqual(
    MIN_COIN_LUMA,
  );
  expect(Math.abs(shift), `${look.label}: the front lip stays where it was`).toBeLessThanOrEqual(
    MAX_LIP_SHIFT_PX,
  );
}

for (const layout of LAYOUTS) {
  test.describe(`coin look after the first taps, ${layout.name} (P-721)`, () => {
    test.use({ viewport: layout.viewport, deviceScaleFactor: 1 });

    test('coins stay round and the table steady from poster to after a sheet closes', async ({
      page,
    }) => {
      test.setTimeout(300_000);
      await page.goto(gameUrl());
      await expect(page.locator('#cp-poster')).toBeVisible();
      const poster = await shoot(page, layout, 'poster');

      await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
        timeout: 60_000,
        polling: 16,
      });
      const playable = await shoot(page, layout, 'playable');
      await expectDemoMode(page);

      const looks = layout.posterFramesTable ? [poster, playable] : [playable];
      for (let tap = 1; tap <= TAPS; tap += 1) {
        await tapDrop(page);
        await page.waitForTimeout(TAP_GAP_MS);
        if (SHOT_AFTER_TAPS.has(tap)) looks.push(await shoot(page, layout, `tap-${tap}`));
      }

      await page.getByTestId('dock-settings').click();
      const sheet = page.getByTestId('sheet-settings');
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await page.waitForTimeout(AFTER_SHEET_CLOSE_MS);
      looks.push(await shoot(page, layout, 'sheet-closed'));

      for (const look of looks) expectRoundSilver(layout, look, playable);
    });
  });
}

test.describe('coin look across scene scales (P-681)', () => {
  test('coins stay round silver at the lowest and the highest scene scale', async ({ page }) => {
    test.setTimeout(240_000);
    const [portrait] = LAYOUTS;
    if (!portrait) throw new Error('LAYOUTS lists no portrait layout');
    const looks: FrameLook[] = [];
    for (const pin of ['min', 'max'] as const) {
      await bootGame(page, { query: `?scene-scale=${pin}` });
      looks.push(await shoot(page, portrait, `pinned-${pin}`));
    }
    const [min, max] = looks;
    if (!min || !max) throw new Error('A pinned capture is missing');
    for (const look of looks) expectRoundSilver(portrait, look, max);
    expect(
      Math.abs(min.luma - max.luma),
      'the coins keep their shade when the scene scale drops to the floor',
    ).toBeLessThanOrEqual(0.06);
  });
});

interface BootWindowCase {
  readonly layout: Layout;
  readonly locale: string;
}

/** The narrow phone runs in German, whose longer labels crowd the header and dock the most. */
const BOOT_WINDOW_CASES: readonly BootWindowCase[] = [
  { layout: { ...PORTRAIT, name: 'boot-390x844' }, locale: 'en-US' },
  {
    layout: {
      name: 'boot-360x640',
      viewport: { width: 360, height: 640 },
      deck: { left: 20, top: 415, right: 340, bottom: 452 },
      maxRoughness: 0.17,
      posterFramesTable: true,
    },
    locale: 'de-DE',
  },
];

/** Capture times after the playable mark (P-747). */
const BOOT_SHOTS_MS = [200, 800, 3000] as const;

interface SceneScaleProbe {
  readonly scale: string | undefined;
  readonly pin: string | undefined;
  readonly tier: string | undefined;
  /** Page time since the playable mark, on the clock the boot pin runs on. */
  readonly sincePlayableMs: number;
}

/** What the quality loop last rendered at, mirrored onto the canvas by `reportSceneScale`. */
function readSceneScale(page: Page): Promise<SceneScaleProbe> {
  return page.evaluate((mark) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#stage');
    if (!canvas) throw new Error('No #stage canvas to read the scene scale from');
    const [playable] = performance.getEntriesByName(mark, 'mark');
    if (!playable) throw new Error(`No ${mark} performance mark to time the boot pin from`);
    const { sceneScale, scenePin, qualityTier } = canvas.dataset;
    return {
      scale: sceneScale,
      pin: scenePin,
      tier: qualityTier,
      sincePlayableMs: performance.now() - playable.startTime,
    };
  }, PLAYABLE_MARK);
}

for (const { layout, locale } of BOOT_WINDOW_CASES) {
  test.describe(`coin look through the boot window, ${layout.name} (P-747)`, () => {
    test.use({ viewport: layout.viewport, deviceScaleFactor: 1, locale });

    test('the first frames and the first tap render round silver coins at full scale', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.goto(gameUrl());
      await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
        timeout: 60_000,
        polling: 16,
      });
      const playableAt = Date.now();

      const capture = async (label: string): Promise<FrameLook> => {
        const before = await readSceneScale(page);
        const look = await shoot(page, layout, label);
        const after = await readSceneScale(page);
        test.info().annotations.push({
          type: 'scene scale',
          description: `${layout.name} ${label}: ${before.scale} -> ${after.scale} (pin ${before.pin} -> ${after.pin}, tier ${after.tier}), done by playable + ${after.sincePlayableMs.toFixed(0)} ms`,
        });
        for (const probe of [before, after]) {
          // The pin lasts BOOT_HOLD_MS of active play, never longer, so on a slow host the later
          // captures can land after it; inside the window it must hold at full scale.
          if (probe.sincePlayableMs >= BOOT_HOLD_MS) continue;
          expect(probe.pin, `${label}: the boot pin still holds`).toBe('boot');
          expect(probe.scale, `${label}: the scene renders at full scale`).toBe('1.000');
        }
        return look;
      };

      const looks: FrameLook[] = [];
      for (const at of BOOT_SHOTS_MS) {
        const wait = playableAt + at - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
        looks.push(await capture(`playable+${at}ms`));
      }
      await expectDemoMode(page);
      await tapDrop(page);
      await page.waitForTimeout(TAP_GAP_MS);
      looks.push(await capture('tap-1'));

      const [first] = looks;
      if (!first) throw new Error('The playable + 200 ms capture is missing');
      for (const look of looks) expectRoundSilver(layout, look, first);
    });
  });
}
