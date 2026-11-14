import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { upgradeLines, upgradeStat, venues, type UpgradeLineDef } from '@coinposh/economy';
import { ASCENSION_STRINGS } from '../src/game/ascension/i18n.ts';
import { APP_DIR } from './env.ts';
import { bootGame, expect, reviewShot, test } from './fixtures.ts';

const SETTINGS_KEY = 'coinposh.settings.v1';
const LANGUAGES = ['en', 'fr', 'de'] as const;
type Language = (typeof LANGUAGES)[number];

interface LineCopy {
  readonly name: string;
  readonly description: string;
}

/** The Upgrades bundle's line names and descriptions, which the Family Office rows reuse. */
function lineCopy(language: Language): Readonly<Record<string, LineCopy>> {
  const path = join(APP_DIR, 'src', 'i18n', 'locales', language, 'ui.json');
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as {
    upgrades: { line: Record<string, LineCopy> };
  };
  return bundle.upgrades.line;
}
const FAMILY_OFFICE = upgradeLines.filter((line) => line.scope === 'global');
const RIVIERA = venues[0];
const COUNT_STATS = new Set(['startingCoins']);

async function openAscension(page: Page, language: Language): Promise<Locator> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [SETTINGS_KEY, JSON.stringify({ language })] as const,
  );
  await bootGame(page, { query: '?quality=low' });
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await page.getByTestId('hud-ascension').click();
  const screen = page.getByTestId('ascension-screen');
  await expect(screen).toBeVisible();
  await expect(screen.getByTestId('ascension-hold')).toHaveAttribute('data-state', 'blocked');
  return screen;
}

/** The Upgrades sheet's stat line for a Family Office level, from economy config. */
function effectAt(line: UpgradeLineDef, level: number, language: Language): string {
  const value = upgradeStat(line, level);
  if (COUNT_STATS.has(line.effect.stat)) {
    return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
  }
  return `×${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value)}`;
}

/** Every element of the screen whose content is wider than its box, as `tag.class` labels. */
function overflowing(screen: Locator): Promise<string[]> {
  return screen.evaluate((root) =>
    [root, ...root.querySelectorAll('*')]
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent}`),
  );
}

function luminance([r, g, b]: readonly number[]): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = (channel ?? 0) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

test.describe('ascension screen readability (P-517, P-518, P-519)', () => {
  for (const language of LANGUAGES) {
    test(`Family Office rows explain each line and its next effect (${language})`, async ({
      page,
    }) => {
      const screen = await openAscension(page, language);
      const strings = ASCENSION_STRINGS[language];
      const buttons = screen.locator('[data-testid^=family-office-buy-]');
      await expect(buttons).toHaveCount(FAMILY_OFFICE.length);
      for (const line of FAMILY_OFFICE) {
        const copy = lineCopy(language)[line.id];
        if (copy === undefined)
          throw new Error(`ui.json (${language}) has no upgrades.line.${line.id}`);
        const buy = screen.getByTestId(`family-office-buy-${line.id}`);
        const row = screen.locator(`li[data-line="${line.id}"]`);
        await expect(row).toContainText(copy.name);
        await expect(row.locator('.cp-ascension-office-description')).toHaveText(copy.description);
        await expect(row.locator('.cp-ascension-office-description')).toBeVisible();
        await expect(screen.getByTestId(`family-office-effect-${line.id}`)).toHaveText(
          `${effectAt(line, 0, language)} → ${effectAt(line, 1, language)}`,
        );
        await expect(buy.locator('svg.cp-icon')).toBeVisible();
        await expect(buy.locator('.cp-ascension-office-price')).toHaveText(/^\d[\d.,\s]*$/);
        await expect(buy).toHaveAccessibleName(new RegExp(strings.goldBars, 'i'));
      }
      expect(await overflowing(screen)).toEqual([]);
      await screen.getByTestId('family-office').scrollIntoViewIfNeeded();
      await reviewShot(page, `ascension-family-office-${language}`);
    });
  }

  test('Escape and × hand focus back to the HUD entry', async ({ page }) => {
    const screen = await openAscension(page, 'en');
    const activeTestId = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    await expect.poll(activeTestId).toBe('ascension-screen');
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    await expect.poll(activeTestId).toBe('hud-ascension');

    await page.getByTestId('hud-ascension').click();
    await expect(screen).toBeVisible();
    await screen.getByTestId('ascension-close').click();
    await expect(screen).toHaveCount(0);
    await expect.poll(activeTestId).toBe('hud-ascension');
  });

  for (const language of ['en', 'de'] as const) {
    test(`the locked hold reads as a gilt button described by its reason (${language})`, async ({
      page,
    }) => {
      const screen = await openAscension(page, language);
      const hold = screen.getByTestId('ascension-hold');
      const reasonId = await hold.getAttribute('aria-describedby');
      expect(reasonId).toBeTruthy();
      const reason = page.locator(`[id="${reasonId ?? ''}"]`);
      await expect(reason).toBeVisible();
      const target = new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(
        RIVIERA.bullionThreshold,
      );
      const venue = ASCENSION_STRINGS[language].venue.rivieraYacht;
      await expect(reason).toHaveText(
        ASCENSION_STRINGS[language].notReadyHint
          .replace('{{venue}}', venue)
          .replace('{{target}}', target),
      );
      if (language === 'en') {
        await expect(reason).toHaveText(`Riviera Yacht needs ${target} Bullion.`);
      }
      await expect(hold).toHaveAccessibleDescription(await reason.innerText());

      await expect(hold.locator('.cp-ascension-hold-lock svg')).toBeVisible();
      const look = await hold.evaluate((el) => {
        const style = getComputedStyle(el);
        const label = el.querySelector('.cp-ascension-hold-label');
        return {
          tag: el.tagName,
          border: style.borderTopColor,
          shadow: style.boxShadow,
          opacity: style.opacity,
          label: label ? getComputedStyle(label).color : '',
        };
      });
      const channels = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      expect(look.tag).toBe('BUTTON');
      expect(channels(look.border)).toEqual([212, 175, 55]);
      expect(look.shadow).toContain('inset');
      expect(look.opacity).toBe('1');
      const label = channels(look.label);
      const lacquer = [0x0e, 0x1f, 0x3a];
      const gilt = [212, 175, 55];
      const fullFill = lacquer.map((c, i) => Math.round(c + ((gilt[i] ?? 0) - c) * 0.3));
      expect(contrast(label, lacquer)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(label, fullFill)).toBeGreaterThanOrEqual(4.5);
      expect(
        Number(
          await hold.evaluate((el) => el.style.getPropertyValue('--cp-ascension-hold-preview')),
        ),
      ).toBeLessThan(1);
      await hold.scrollIntoViewIfNeeded();
      await reviewShot(page, `ascension-locked-hold-${language}`);
    });
  }

  test('the ready hold animates, and stands still under reduced motion', async ({ page }) => {
    const readyAnimation = (screen: Locator) =>
      screen.getByTestId('ascension-hold').evaluate((el) => {
        el.dataset.state = 'idle';
        el.setAttribute('aria-disabled', 'false');
        return getComputedStyle(el).animationName;
      });
    let screen = await openAscension(page, 'en');
    expect(await readyAnimation(screen)).toBe('cp-ascension-hold-breathe');
    await reviewShot(page, 'ascension-ready-hold-en');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
      timeout: 60_000,
    });
    await page.getByTestId('hud-ascension').click();
    screen = page.getByTestId('ascension-screen');
    await expect(screen).toHaveAttribute('data-motion', 'reduced');
    await expect(screen.getByTestId('ascension-hold')).toHaveAttribute('data-state', 'blocked');
    expect(await readyAnimation(screen)).toBe('none');
  });
});
