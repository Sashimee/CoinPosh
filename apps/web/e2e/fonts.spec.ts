import type { CDPSession, Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, reviewShot, tapDrop, test } from './fixtures.ts';

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

const SETTINGS_KEY = 'coinposh.settings.v1';
const TYPOGRAPHY_LANGUAGES = ['en', 'de'] as const;
const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
const TAP_EVERY_MS = 400;
const CRATE_OPENS_WITHIN_MS = 90_000;

interface OldStyleDigits {
  readonly where: string;
  readonly text: string;
  readonly numeric: string;
}

/**
 * Every visible text node with a digit that draws in the display serif and lacks lining-nums.
 * Cormorant's default figures are old-style, so a 0 reads as an 'o' and a 1 as an 'I'.
 */
function oldStyleDigits(page: Page): Promise<OldStyleDigits[]> {
  return page.evaluate((display) => {
    const found: OldStyleDigits[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const element = node.parentElement;
      if (!element || !/\d/.test(text)) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      const style = getComputedStyle(element);
      const family = style.fontFamily.split(',')[0]?.replace(/["']/g, '').trim();
      if (family !== display) continue;
      if (style.fontVariantNumeric.split(/\s+/).includes('lining-nums')) continue;
      const classes = [...element.classList].map((name) => `.${name}`).join('');
      found.push({
        where: `${element.tagName.toLowerCase()}${classes}`,
        text,
        numeric: style.fontVariantNumeric,
      });
    }
    return found;
  }, DISPLAY);
}

async function expectLiningDigits(page: Page, surface: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const flagged = await oldStyleDigits(page);
  const named = flagged.map((node) => `${node.where} "${node.text}" (${node.numeric})`);
  expect(flagged, `${surface}: ${DISPLAY} digits without lining-nums: ${named.join('; ')}`).toEqual(
    [],
  );
}

async function scanSheet(page: Page, trigger: string, sheet: string): Promise<void> {
  await page.getByTestId(trigger).click();
  const open = page.getByTestId(sheet);
  await expect(open).toBeVisible();
  await expectLiningDigits(page, sheet);
  await page.keyboard.press('Escape');
  await expect(open).toBeHidden();
}

/** Plays the scripted first-session crate over the lip and skips straight to its card. */
async function revealCrate(page: Page): Promise<void> {
  for (let i = 0; i < FTUE_DROP; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }
  const reveal = page.getByTestId('crate-reveal');
  const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
  for (;;) {
    try {
      await reveal.waitFor({ state: 'attached', timeout: TAP_EVERY_MS });
      break;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`No crate reveal within ${String(CRATE_OPENS_WITHIN_MS)} ms of play`);
    }
    await tapDrop(page);
  }
  await page.keyboard.press('Escape');
  await expect(reveal).toHaveClass(/is-revealed/);
  await expect(page.getByTestId('crate-collect')).toBeVisible();
  await expect(reveal.locator('.cp-crate-line').first()).toBeVisible();
}

test.describe('display serif figures (P-708)', () => {
  for (const language of TYPOGRAPHY_LANGUAGES) {
    test(`every visible ${DISPLAY} digit is a lining figure (${language})`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(
        ([key, value]) => {
          localStorage.setItem(key, value);
        },
        [SETTINGS_KEY, JSON.stringify({ language })] as const,
      );
      await bootGame(page);
      await expect(page.locator('html')).toHaveAttribute('lang', language);

      await expectLiningDigits(page, 'HUD');
      await scanSheet(page, 'dock-upgrades', 'sheet-upgrades');

      await page.getByTestId('dock-safes').click();
      const safes = page.getByTestId('safes-panel');
      await expect(safes).toBeVisible();
      await expect(safes.locator('.cp-safes-keys-value')).toContainText('0');
      await expectLiningDigits(page, 'safes-panel');
      await safes.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      await reviewShot(page, `fonts-safes-keys-${language}`);
      await page.keyboard.press('Escape');
      await expect(safes).toBeHidden();

      await scanSheet(page, 'dock-settings', 'sheet-settings');
      await scanSheet(page, 'hud-ascension', 'ascension-screen');

      await revealCrate(page);
      await expectLiningDigits(page, 'crate-reveal');
    });
  }
});
