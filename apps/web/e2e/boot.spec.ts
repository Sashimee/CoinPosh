import { bootGame, coinLedger, expect, probe, reviewShot, tapDrop, test } from './fixtures.ts';

test.describe('boot', () => {
  test('Demo Mode boots to a playable table and the first tap drops a coin', async ({ page }) => {
    await bootGame(page, { query: '?quality=low' });
    await expect(page.locator('#stage')).toBeVisible();
    await expect(page.getByTestId('hud-balance')).toBeVisible();
    await expect(page.getByTestId('dock-upgrades')).toBeVisible();
    const webgl2 = await page.evaluate(
      () => document.querySelector<HTMLCanvasElement>('#stage')?.getContext('webgl2') !== null,
    );
    expect(webgl2, 'CI chromium renders through the WebGL2 backend').toBe(true);
    await reviewShot(page, 'boot-playable');

    const before = coinLedger(await probe(page));
    await tapDrop(page);
    await expect
      .poll(async () => coinLedger(await probe(page)), { timeout: 5_000 })
      .toBe(before + 1);
    await reviewShot(page, 'boot-first-drop');
  });
});
