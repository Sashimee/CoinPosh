import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOOT_TO_FIRST_DROP_MS } from './budgets.ts';
import { PERF_DIR } from './env.ts';
import { bootGame, coinLedger, expect, probe, reviewShot, tapDrop, test } from './fixtures.ts';

test.describe('boot budget', () => {
  test(`navigation to the first coin in the sim takes under ${BOOT_TO_FIRST_DROP_MS} ms`, async ({
    page,
  }) => {
    await bootGame(page, { query: '?quality=low' });
    const playableAt = await page.evaluate(() => performance.now());
    const before = coinLedger(await probe(page));
    await tapDrop(page);
    await expect
      .poll(async () => coinLedger(await probe(page)), { timeout: 5_000, intervals: [16] })
      .toBe(before + 1);
    const firstDropAt = await page.evaluate(() => performance.now());
    await reviewShot(page, 'perf-first-drop');

    const report = {
      playableMs: playableAt,
      firstDropMs: firstDropAt,
      budgetMs: BOOT_TO_FIRST_DROP_MS,
    };
    await mkdir(PERF_DIR, { recursive: true });
    await writeFile(join(PERF_DIR, 'boot.json'), `${JSON.stringify(report, null, 2)}\n`);
    test.info().annotations.push({ type: 'boot', description: JSON.stringify(report) });

    expect(firstDropAt, 'ms from navigation start to the first coin in the sim').toBeLessThan(
      BOOT_TO_FIRST_DROP_MS,
    );
  });
});
