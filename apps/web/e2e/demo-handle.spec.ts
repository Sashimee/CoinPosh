import type { Page } from '@playwright/test';
import { bootGame, expect, tapDrop, test } from './fixtures.ts';

/** What apps/web/src/main.ts adds to `window.__coinposh` beyond the read-only Probe. */
interface DemoProbe {
  readonly superseded: boolean;
  readonly restored: { readonly boots: number } | null;
  readonly demo?: {
    reboot(): Promise<void>;
    bootElsewhere(): Promise<void>;
  };
}

async function demoState(page: Page): Promise<{ boots: number; superseded: boolean }> {
  return page.evaluate(() => {
    const p = window.__coinposh as DemoProbe | undefined;
    if (!p) throw new Error('window.__coinposh is missing: the page is not the CoinPosh game');
    return { boots: p.restored?.boots ?? 0, superseded: p.superseded };
  });
}

test('the Demo test handle re-boots this page and supersedes it from a second tab', async ({
  page,
}) => {
  await bootGame(page);
  const booted = await demoState(page);
  expect(booted.superseded).toBe(false);

  await page.evaluate(async () => {
    const demo = (window.__coinposh as DemoProbe | undefined)?.demo;
    if (!demo) throw new Error('window.__coinposh.demo is missing in Demo Mode');
    await demo.reboot();
  });
  const rebooted = await demoState(page);
  expect(rebooted.boots, 'reboot() lays the table again in this page').toBe(booted.boots + 1);
  expect(rebooted.superseded).toBe(false);

  await page.evaluate(async () => {
    const demo = (window.__coinposh as DemoProbe | undefined)?.demo;
    if (!demo) throw new Error('window.__coinposh.demo is missing in Demo Mode');
    await demo.bootElsewhere();
  });
  await tapDrop(page);
  await page.waitForFunction(
    () => (window.__coinposh as DemoProbe | undefined)?.superseded === true,
  );
  await expect(page.getByTestId('table-elsewhere')).toBeVisible();
});
