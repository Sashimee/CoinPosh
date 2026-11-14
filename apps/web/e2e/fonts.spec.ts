import type { CDPSession, Page } from '@playwright/test';
import { bootGame, expect, reviewShot, test } from './fixtures.ts';

/**
 * P-425 / P-102: the display serif and the UI sans are self-hosted woff2 subsets from
 * public/fonts, loaded on boot in Demo Mode, and the Vault plaque is drawn in them from its first
 * frame, so the swap never moves it.
 */

const DISPLAY = 'Cormorant Garamond';
const UI = 'Manrope';

/** Every face the boot needs; the italic loads when a title first asks for it. */
const BOOT_FACES = [
  `600 40px "${DISPLAY}"`,
  `700 16px "${DISPLAY}"`,
  `500 15px "${UI}"`,
  `700 10px "${UI}"`,
] as const;

const FONT_FILE = /\/fonts\/[\w-]+\.woff2$/;

interface PlaqueFrame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly labelWidth: number;
  readonly amount: string;
  readonly faces: readonly boolean[];
}

declare global {
  interface Window {
    __firstPlaque?: PlaqueFrame;
  }
}

/** The plaque's layout box (offsets ignore its entrance transform) and the face status. */
async function watchFirstPlaque(page: Page): Promise<void> {
  await page.addInitScript((faces: readonly string[]) => {
    const look = (): void => {
      const plaque = document.querySelector<HTMLElement>('[data-testid=hud-balance]');
      const label = plaque?.querySelector<HTMLElement>('.cp-plaque-label');
      const amount = plaque?.querySelector<HTMLElement>('.cp-odo');
      if (!plaque?.isConnected || !label || !amount || plaque.offsetWidth === 0) {
        requestAnimationFrame(look);
        return;
      }
      window.__firstPlaque = {
        width: plaque.offsetWidth,
        height: plaque.offsetHeight,
        left: plaque.offsetLeft,
        top: plaque.offsetTop,
        labelWidth: label.offsetWidth,
        amount: amount.getAttribute('aria-label') ?? amount.textContent,
        faces: faces.map((face) => document.fonts.check(face)),
      };
    };
    requestAnimationFrame(look);
  }, BOOT_FACES);
}

async function platformFonts(cdp: CDPSession, selector: string): Promise<string[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (nodeId === 0) throw new Error(`No element matches ${selector}`);
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map((font) => `${font.familyName}${font.isCustomFont ? ' (web)' : ''}`);
}

test.describe('webfonts', () => {
  test('the display serif and UI sans load from public/fonts by the time the table is playable', async ({
    page,
  }) => {
    const served: { url: string; type: string; bytes: number }[] = [];
    page.on('response', (response) => {
      if (!FONT_FILE.test(new URL(response.url()).pathname)) return;
      void response.body().then((body) => {
        served.push({
          url: new URL(response.url()).pathname,
          type: response.headers()['content-type'] ?? '',
          bytes: body.length,
        });
      });
    });
    await watchFirstPlaque(page);

    await bootGame(page, { query: '?quality=low' });
    const loaded = await page.evaluate(
      (faces) => faces.map((face) => document.fonts.check(face)),
      BOOT_FACES,
    );
    expect(loaded, `loaded: ${BOOT_FACES.join(', ')}`).toEqual(BOOT_FACES.map(() => true));
    expect(await page.evaluate(() => document.fonts.check('700 16px "Cormorant Garamond"'))).toBe(
      true,
    );

    const faces = await page.evaluate(() =>
      [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => `${face.family.replace(/"/g, '')} ${face.weight} ${face.style}`)
        .sort(),
    );
    expect(faces).toEqual(
      expect.arrayContaining([
        `${DISPLAY} 600 normal`,
        `${DISPLAY} 700 normal`,
        `${UI} 500 normal`,
        `${UI} 700 normal`,
      ]),
    );

    await expect.poll(() => served.length).toBeGreaterThanOrEqual(4);
    for (const file of served) {
      expect(file.type, `${file.url} content type`).toMatch(/font\/woff2|application\/font-woff2/);
      expect(file.bytes, `${file.url} is a subset`).toBeLessThan(32 * 1024);
    }
    expect(
      new Set(served.map((file) => file.url)).size,
      'each preloaded face is fetched once, not again by @font-face',
    ).toBe(served.length);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const digits = await platformFonts(cdp, '[data-testid=hud-balance] .cp-odo-strip > span');
    expect(digits, 'the Vault digits draw in the self-hosted serif alone').toEqual([
      expect.stringMatching(new RegExp(`^${DISPLAY}( SemiBold)? \\(web\\)$`)),
    ]);
    const label = await platformFonts(cdp, '[data-testid=hud-balance] .cp-plaque-label');
    expect(label, 'the plaque label draws in the self-hosted sans alone').toEqual([
      expect.stringMatching(new RegExp(`^${UI}( Bold)? \\(web\\)$`)),
    ]);
    await reviewShot(page, 'fonts-plaque');
  });

  test('the Vault plaque keeps its box once the webfonts are in', async ({ page }) => {
    await watchFirstPlaque(page);
    await bootGame(page, { query: '?quality=low' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => window.__firstPlaque !== undefined, null, { polling: 16 });
    const before = await page.evaluate(() => {
      if (!window.__firstPlaque) throw new Error('The Vault plaque never reached a frame');
      return window.__firstPlaque;
    });
    const after = await page.evaluate(() => {
      const plaque = document.querySelector<HTMLElement>('[data-testid=hud-balance]');
      const label = plaque?.querySelector<HTMLElement>('.cp-plaque-label');
      const amount = plaque?.querySelector<HTMLElement>('.cp-odo');
      if (!plaque || !label || !amount) throw new Error('The Vault plaque left the HUD');
      return {
        width: plaque.offsetWidth,
        height: plaque.offsetHeight,
        left: plaque.offsetLeft,
        top: plaque.offsetTop,
        labelWidth: label.offsetWidth,
        amount: amount.getAttribute('aria-label') ?? amount.textContent,
      };
    });

    expect(before.faces, 'the plaque first paints in the webfonts, not a fallback').toEqual(
      BOOT_FACES.map(() => true),
    );
    expect(after.labelWidth).toBe(before.labelWidth);
    expect(after.height).toBe(before.height);
    expect(after.top).toBe(before.top);
    if (after.amount === before.amount) {
      expect({ width: after.width, left: after.left }).toEqual({
        width: before.width,
        left: before.left,
      });
    }
  });
});
