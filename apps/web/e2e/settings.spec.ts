import type { Locator, Page } from '@playwright/test';
import { bootGame, expect, reviewShot, test, unexpectedErrors } from './fixtures.ts';

const STORAGE_KEY = 'coinposh.settings.v1';

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTestId('dock-settings').click();
  const sheet = page.getByTestId('sheet-settings');
  await expect(sheet).toBeVisible();
  return sheet;
}

function option(sheet: Locator, group: string, value: string): Locator {
  return sheet.getByTestId(group).locator(`[role=radio][data-value="${value}"]`);
}

async function savedSettings(page: Page): Promise<unknown> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

test.describe('settings (P-54)', () => {
  test('every setting survives a reload, and the language reaches the whole UI', async ({
    page,
  }) => {
    await bootGame(page, { query: '?quality=low' });
    let sheet = await openSettings(page);

    await sheet.getByTestId('settings-volume-music').fill('35');
    await sheet.getByTestId('settings-volume-sfx').fill('60');
    await sheet.getByTestId('settings-mono').click();
    await sheet.getByTestId('settings-haptics').click();
    await option(sheet, 'settings-motion', 'reduced').click();
    await option(sheet, 'settings-quality', 'low').click();
    await option(sheet, 'settings-language', 'fr').click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByTestId('dock-settings')).toHaveAttribute('aria-label', 'Réglages');
    await expect
      .poll(() => savedSettings(page), { message: 'the debounced save lands' })
      .toMatchObject({
        volumes: { music: 0.35, sfx: 0.6 },
        mono: true,
        haptics: false,
        motion: 'reduced',
        quality: 'low',
        language: 'fr',
      });

    await page.reload();
    await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
      timeout: 60_000,
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('#coinposh-demo-banner')).toBeVisible();
    await expect(page.locator('.cp-ui-host')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('.cp-ui-host')).toHaveAttribute('data-quality', 'low');

    sheet = await openSettings(page);
    await expect(sheet.getByTestId('settings-volume-music')).toHaveValue('35');
    await expect(sheet.getByTestId('settings-volume-sfx')).toHaveValue('60');
    await expect(sheet.getByTestId('settings-mono')).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.getByTestId('settings-haptics')).toHaveAttribute('aria-checked', 'false');
    for (const [group, value] of [
      ['settings-motion', 'reduced'],
      ['settings-quality', 'low'],
      ['settings-language', 'fr'],
    ] as const) {
      await expect(option(sheet, group, value)).toHaveAttribute('aria-checked', 'true');
    }
    await reviewShot(page, 'settings-fr-after-reload');
  });

  test('a corrupt saved blob falls back to defaults without breaking boot', async ({
    page,
    pageErrors,
  }, testInfo) => {
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('seeded') === null) {
        localStorage.setItem(key, '{not json');
        sessionStorage.setItem('seeded', '1');
      }
    }, STORAGE_KEY);
    await bootGame(page, { query: '?quality=low' });
    const sheet = await openSettings(page);
    await expect(option(sheet, 'settings-motion', 'system')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(sheet.getByTestId('settings-mono')).toHaveAttribute('aria-checked', 'false');
    expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
  });
});

test.describe('account (T-10.04)', () => {
  for (const { width, height } of [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    test(`a fake Demo sign-in links Google, then unlinks it, at ${width}x${height}`, async ({
      page,
      pageErrors,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await bootGame(page, { query: '?quality=low' });
      const sheet = await openSettings(page);
      const section = sheet.getByTestId('account-section');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('account-demo-note')).toContainText('fake');

      const google = section.getByTestId('account-provider-google');
      await expect(google).toHaveAttribute('data-state', 'demo');
      await expect(google).toContainText('Fake Google');
      await google.scrollIntoViewIfNeeded();
      await reviewShot(page, `account-guest-${width}x${height}`);

      await google.click();
      const status = section.getByTestId('account-status');
      await expect(status).toContainText('Google linked');
      await expect(status).toHaveAttribute('data-tone', 'ok');
      await expect(section.getByTestId('account-linked-google')).toBeVisible();
      await expect(section.getByTestId('account-provider-google')).toHaveCount(0);
      await reviewShot(page, `account-linked-${width}x${height}`);

      await section.getByTestId('account-unlink-google').click();
      await expect(section.getByTestId('account-unlink-confirm')).toBeVisible();
      await section.getByTestId('account-unlink-confirm').click();
      await expect(status).toContainText('Google unlinked');
      await expect(section.getByTestId('account-linked-google')).toHaveCount(0);
      await expect(section.getByTestId('account-provider-google')).toBeVisible();
      expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
    });
  }
});
