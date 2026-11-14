import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { openingHeap } from '@coinposh/economy';
import { APP_DIR, VIEWPORT } from './env.ts';
import { expect, gameUrl, reviewShot, test } from './fixtures.ts';

const POSTER_FILE = join(APP_DIR, 'public', 'poster-riviera.webp');
const POSTER_MAX_BYTES = 40_000;
const HEAP_TARGET = Math.ceil(openingHeap.coins * 0.9);
/** The table band P-213 compares: the shelf heap and the front deck at 390x844. */
const BAND = { top: 300, bottom: 560 } as const;
const MAX_LUMINANCE_DIFF = 0.08;
/**
 * scripts/capture-poster.ts renders the poster on the high tier, the table a phone that holds the
 * frame rate shows; SwiftShader would otherwise boot the low tier.
 */
const POSTER_QUALITY = '?quality=high';

interface PosterExit {
  /** `fade` when the poster took `is-lit`, `removed` when it left the DOM. */
  readonly kind: 'fade' | 'removed';
  readonly coins: number;
  readonly transition: string;
}

declare global {
  interface Window {
    __posterExits?: PosterExit[];
    /** The live table, copied from #stage in the task that started the poster's exit. */
    __posterFrame?: OffscreenCanvas;
  }
}

/**
 * Records, before any app script runs, the sim's coin count at each step of the poster's exit and
 * the table it uncovers. The copy is taken in the observer's microtask, inside the frame that
 * starts the exit, from a drawing buffer kept past presentation: a screenshot lands hundreds of ms
 * later under SwiftShader, with the pusher moved.
 */
async function watchPoster(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const exits: PosterExit[] = [];
    window.__posterExits = exits;
    let poster: HTMLElement | null = null;
    let transition = '';
    const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
      ?.value as HTMLCanvasElement['getContext'];
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      options?: Record<string, unknown>,
    ) {
      const keep = kind.startsWith('webgl') ? { ...options, preserveDrawingBuffer: true } : options;
      return getContext.call(this, kind, keep);
    } as typeof getContext;
    const record = (kind: PosterExit['kind']): void => {
      if (exits.some((e) => e.kind === kind)) return;
      const stage = document.getElementById('stage');
      if (exits.length === 0 && stage instanceof HTMLCanvasElement) {
        const frame = new OffscreenCanvas(innerWidth, innerHeight);
        frame.getContext('2d')?.drawImage(stage, 0, 0, innerWidth, innerHeight);
        window.__posterFrame = frame;
      }
      exits.push({ kind, coins: window.__coinposh?.sim?.coins ?? 0, transition });
    };
    new MutationObserver(() => {
      if (!poster) {
        poster = document.getElementById('cp-poster');
        if (!poster) return;
        transition = getComputedStyle(poster).transitionDuration;
      }
      if (poster.classList.contains('is-lit')) record('fade');
      if (!poster.isConnected) record('removed');
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

async function untilPosterGone(page: Page): Promise<PosterExit[]> {
  await page.waitForFunction(
    () => window.__coinposh?.playable === true && document.getElementById('cp-poster') === null,
    null,
    { timeout: 60_000, polling: 16 },
  );
  return page.evaluate(() => window.__posterExits ?? []);
}

interface BandComparison {
  /** Mean absolute Rec. 709 luminance difference, 0 to 1. */
  readonly diff: number;
  /** Mean luminance of the live table, so a blank copy cannot pass as a match. */
  readonly liveLuma: number;
}

/**
 * Compares, over the table band, the poster as index.html lays it over the viewport
 * (object-fit: cover at 50% 40%) with the table copied when its exit started.
 */
function compareBand(page: Page): Promise<BandComparison> {
  return page.evaluate(
    async ({ width, height, band }) => {
      const live = window.__posterFrame;
      if (!live) throw new Error('The poster left without the live table being copied');
      const response = await fetch('/poster-riviera.webp');
      if (!response.ok) throw new Error(`The poster did not load: HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      const liveContext = live.getContext('2d');
      if (!context || !liveContext) throw new Error('OffscreenCanvas has no 2d context');
      const scale = Math.max(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      context.drawImage(bitmap, (width - w) * 0.5, (height - h) * 0.4, w, h);
      const rows = band.bottom - band.top;
      const poster = context.getImageData(0, band.top, width, rows).data;
      const table = liveContext.getImageData(0, band.top, width, rows).data;
      const luma = (d: Uint8ClampedArray, i: number): number =>
        (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      let diff = 0;
      let liveLuma = 0;
      for (let i = 0; i < poster.length; i += 4) {
        const l = luma(table, i);
        liveLuma += l;
        diff += Math.abs(luma(poster, i) - l);
      }
      const pixels = poster.length / 4;
      return { diff: diff / pixels, liveLuma: liveLuma / pixels };
    },
    { ...VIEWPORT, band: BAND },
  );
}

test.describe('boot poster (P-213)', () => {
  // The pixel ratio scripts/capture-poster.ts renders the poster at, so both frames are one render.
  test.use({ deviceScaleFactor: 1.5 });

  test('stays up until the opening heap is drawn, then fades onto a table that matches it', async ({
    page,
  }) => {
    await watchPoster(page);
    await page.goto(gameUrl(POSTER_QUALITY));
    const exits = await untilPosterGone(page);
    await reviewShot(page, 'poster-live-table');

    const [first] = exits;
    expect(first?.kind, 'the poster fades before it is removed').toBe('fade');
    expect(first?.transition, 'the fade is a CSS transition').not.toBe('0s');
    expect(
      first?.coins,
      'the live table holds the opening heap when the fade starts',
    ).toBeGreaterThanOrEqual(HEAP_TARGET);

    const fadeFrame = await page.evaluate(async () => {
      const blob = await window.__posterFrame?.convertToBlob({ type: 'image/png' });
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    if (fadeFrame) {
      const path = test.info().outputPath('table-at-fade.png');
      await writeFile(path, Buffer.from(fadeFrame, 'base64'));
      await test.info().attach('table-at-fade', { path, contentType: 'image/png' });
    }
    const { diff, liveLuma } = await compareBand(page);
    expect(liveLuma, 'the live table was copied, not a blank buffer').toBeGreaterThan(0.05);
    test.info().annotations.push({
      type: 'luminance',
      description: `mean |ΔL| over y ${BAND.top}-${BAND.bottom}: ${(diff * 100).toFixed(2)} %`,
    });
    expect(diff, 'the poster matches the live table over the table band').toBeLessThanOrEqual(
      MAX_LUMINANCE_DIFF,
    );
  });

  test('cuts instead of fading under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await watchPoster(page);
    await page.goto(gameUrl());
    const exits = await untilPosterGone(page);
    expect(exits.map((e) => e.kind)).toEqual(['removed']);
    expect(exits[0]?.transition).toBe('0s');
    expect(exits[0]?.coins).toBeGreaterThanOrEqual(HEAP_TARGET);
  });

  test(`weighs at most ${POSTER_MAX_BYTES / 1000} kB`, async () => {
    const { size } = await stat(POSTER_FILE);
    expect(size).toBeLessThanOrEqual(POSTER_MAX_BYTES);
  });
});
