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
/** The poster leaves within this of the first frame holding 90 % of the opening heap. */
const MAX_HEAP_TO_FADE_MS = 500;
/**
 * Taps drop coins from playable on, and the poster has pointer-events none, so it may not hide
 * them for long: the heap fills in after playable, then the bound above.
 */
const MAX_PLAYABLE_TO_FADE_MS = 2_000;

/**
 * The boots the poster must match: the one a new player gets (the auto-picked tier at the
 * suite's DPR 1), and the one scripts/capture-poster.ts renders it from.
 */
const BOOTS = [
  { name: 'the default boot', query: '', deviceScaleFactor: 1 },
  { name: 'the capture boot', query: '?quality=high', deviceScaleFactor: 1.5 },
] as const;

interface PosterExit {
  /** `fade` when the poster took `is-lit`, `removed` when it left the DOM. */
  readonly kind: 'fade' | 'removed';
  readonly coins: number;
  readonly transition: string;
  /** `performance.now()` when the step was seen. */
  readonly at: number;
}

interface BootMarks {
  /** When `window.__coinposh.playable` first read true. */
  playableAt?: number;
  /** When the first frame holding `heapTarget` coins had been drawn. */
  heapAt?: number;
}

declare global {
  interface Window {
    __posterExits?: PosterExit[];
    __bootMarks?: BootMarks;
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
  await page.addInitScript((heapTarget: number) => {
    const exits: PosterExit[] = [];
    window.__posterExits = exits;
    const marks: BootMarks = {};
    window.__bootMarks = marks;
    const playableTimer = setInterval(() => {
      if (window.__coinposh?.playable !== true) return;
      marks.playableAt = performance.now();
      clearInterval(playableTimer);
    }, 4);
    // Registered before the app's render loop, so each callback runs ahead of that frame's draw:
    // the heap counts as drawn at the callback after the first frame that held it. The first
    // frame to draw the coins can stall a software GPU for a second, with the page frozen.
    let heapSeen = false;
    const watchHeap = (): void => {
      if (heapSeen) {
        marks.heapAt = performance.now();
        return;
      }
      heapSeen = (window.__coinposh?.sim?.coins ?? 0) >= heapTarget;
      requestAnimationFrame(watchHeap);
    };
    requestAnimationFrame(watchHeap);
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
      // Read before the copy: drawing the WebGL canvas waits on the GPU, which is not the poster.
      const at = performance.now();
      const stage = document.getElementById('stage');
      if (exits.length === 0 && stage instanceof HTMLCanvasElement) {
        const frame = new OffscreenCanvas(innerWidth, innerHeight);
        frame.getContext('2d')?.drawImage(stage, 0, 0, innerWidth, innerHeight);
        window.__posterFrame = frame;
      }
      exits.push({
        kind,
        coins: window.__coinposh?.sim?.coins ?? 0,
        transition,
        at,
      });
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
  }, HEAP_TARGET);
}

/** Checks the poster's exit came right after the heap, and so not long after playable. */
async function expectPromptExit(page: Page, exit: PosterExit | undefined): Promise<void> {
  const marks = await page.evaluate(() => window.__bootMarks ?? {});
  const { heapAt, playableAt } = marks;
  expect(exit, 'the poster left').toBeDefined();
  expect(heapAt, 'a frame drew 90 % of the opening heap').toBeDefined();
  expect(playableAt, 'the table became playable').toBeDefined();
  if (!exit || heapAt === undefined || playableAt === undefined) return;
  test.info().annotations.push({
    type: 'timing',
    description: `heap +${Math.round(exit.at - heapAt)} ms, playable +${Math.round(exit.at - playableAt)} ms to the poster's exit`,
  });
  expect(exit.at - heapAt, 'the poster leaves soon after the heap is in').toBeLessThanOrEqual(
    MAX_HEAP_TO_FADE_MS,
  );
  expect(
    exit.at - playableAt,
    'the poster does not hide a playable table for long',
  ).toBeLessThanOrEqual(MAX_PLAYABLE_TO_FADE_MS);
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
  for (const boot of BOOTS) {
    test.describe(boot.name, () => {
      test.use({ deviceScaleFactor: boot.deviceScaleFactor });

      test('stays up until the opening heap is drawn, then fades onto a table that matches it', async ({
        page,
      }) => {
        await watchPoster(page);
        await page.goto(gameUrl(boot.query));
        const exits = await untilPosterGone(page);
        await reviewShot(page, `poster-live-table-dpr${boot.deviceScaleFactor}`);

        const [first] = exits;
        expect(first?.kind, 'the poster fades before it is removed').toBe('fade');
        expect(first?.transition, 'the fade is a CSS transition').not.toBe('0s');
        expect(
          first?.coins,
          'the live table holds the opening heap when the fade starts',
        ).toBeGreaterThanOrEqual(HEAP_TARGET);
        await expectPromptExit(page, first);

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
        // P-213 compares the poster with the table at playable. This build turns playable before
        // the heap drops in, so the table the poster uncovers is the one copied as its fade
        // starts; expectPromptExit keeps that moment close to playable.
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
    });
  }

  test('cuts instead of fading under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await watchPoster(page);
    await page.goto(gameUrl());
    const exits = await untilPosterGone(page);
    expect(exits.map((e) => e.kind)).toEqual(['removed']);
    expect(exits[0]?.transition).toBe('0s');
    expect(exits[0]?.coins).toBeGreaterThanOrEqual(HEAP_TARGET);
    await expectPromptExit(page, exits[0]);
  });

  test(`weighs at most ${POSTER_MAX_BYTES / 1000} kB`, async () => {
    const { size } = await stat(POSTER_FILE);
    expect(size).toBeLessThanOrEqual(POSTER_MAX_BYTES);
  });
});
