/**
 * Re-renders public/poster-riviera.webp, the boot poster index.html paints until the live table
 * holds its opening heap. It builds the Demo Mode bundle, boots it seeded in Chromium at the
 * reference portrait viewport and copies the table canvas in the frame src/ui/hud.ts starts the
 * poster's fade, so the poster is the table its fade uncovers. The copy is encoded as WebP with
 * the browser's own encoder, so no image dependency is needed.
 *
 * It boots the high tier, the table a phone that holds the frame rate shows: a software GPU
 * would otherwise boot the low tier, whose coins lose their reeding. e2e/poster.spec.ts boots the
 * same tier.
 *
 *   pnpm --filter @coinposh/web poster:capture [--port 4419] [--quality high]
 */
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { prepareGamePage } from '../e2e/fixtures.ts';
import { APP_DIR, VIEWPORT } from '../e2e/env.ts';

/** index.html declares the poster at 585x1266: the 390x844 reference phone at 1.5x. */
const SCALE = 1.5;
/** P-213's budget is 40 kB; the encoder aims under it so a re-capture never lands on the edge. */
const TARGET_BYTES = 36_000;
const QUALITIES = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4];
const POSTER_PATH = join(APP_DIR, 'public', 'poster-riviera.webp');
const COPY_TIMEOUT_MS = 120_000;

declare global {
  interface Window {
    /** The table as the poster's fade starts, at the poster's size. */
    __posterCopy?: OffscreenCanvas;
  }
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4419' },
    quality: { type: 'string', default: 'high' },
  },
});
const port = Number(values.port);
if (!['low', 'medium', 'high'].includes(values.quality)) {
  throw new Error(`--quality must be low, medium or high, got "${values.quality}"`);
}
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`--port must be a port between 1024 and 65535, got "${values.port}"`);
}

process.env.VITE_API_URL = '';
await build({ root: APP_DIR, logLevel: 'warn' });
const server = await preview({
  root: APP_DIR,
  logLevel: 'warn',
  preview: { host: '127.0.0.1', port, strictPort: true },
});
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const errors = await prepareGamePage(page);
  await page.addInitScript(
    ({ width, height }) => {
      // The HUD starts the fade in its own frame callback, after the renderer's buffer may have
      // been presented and cleared, so the copy needs that buffer kept.
      const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
        ?.value as HTMLCanvasElement['getContext'];
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        kind: string,
        options?: Record<string, unknown>,
      ) {
        const keep = kind.startsWith('webgl')
          ? { ...options, preserveDrawingBuffer: true }
          : options;
        return getContext.call(this, kind, keep);
      } as typeof getContext;
      const observer = new MutationObserver(() => {
        const poster = document.getElementById('cp-poster');
        const stage = document.getElementById('stage');
        if (!poster?.classList.contains('is-lit') || !(stage instanceof HTMLCanvasElement)) return;
        observer.disconnect();
        const copy = new OffscreenCanvas(width, height);
        copy.getContext('2d')?.drawImage(stage, 0, 0, width, height);
        window.__posterCopy = copy;
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true });
    },
    { width: Math.round(VIEWPORT.width * SCALE), height: Math.round(VIEWPORT.height * SCALE) },
  );
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set('quality', values.quality);
  await page.goto(url.href);
  await page.waitForFunction(() => window.__posterCopy !== undefined, null, {
    timeout: COPY_TIMEOUT_MS,
    polling: 100,
  });

  const encoded = await page.evaluate(
    async ({ qualities, target }) => {
      const copy = window.__posterCopy;
      if (!copy) throw new Error('The poster faded without the table being copied');
      for (const quality of qualities) {
        const blob = await copy.convertToBlob({ type: 'image/webp', quality });
        if (blob.type !== 'image/webp') throw new Error('This Chromium cannot encode WebP');
        if (blob.size > target) continue;
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of buffer) binary += String.fromCharCode(byte);
        return { quality, width: copy.width, height: copy.height, data: btoa(binary) };
      }
      return null;
    },
    { qualities: QUALITIES, target: TARGET_BYTES },
  );
  if (errors.length > 0) {
    throw new Error(
      `The game logged errors while booting, so the frame may be wrong:\n${errors.join('\n')}`,
    );
  }
  if (!encoded) {
    throw new Error(
      `No WebP quality down to ${QUALITIES.at(-1) ?? 0} fits the poster under ${TARGET_BYTES} bytes; lower QUALITIES or simplify the frame.`,
    );
  }
  await writeFile(POSTER_PATH, Buffer.from(encoded.data, 'base64'));
  const { size } = await stat(POSTER_PATH);
  console.info(
    `Wrote ${POSTER_PATH}: ${encoded.width}x${encoded.height}, quality ${encoded.quality}, ${size} bytes.`,
  );
} finally {
  await browser.close();
  await server.close();
}
