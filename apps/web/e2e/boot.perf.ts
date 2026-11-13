import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { BOOT_RUNS, BOOT_TO_FIRST_DROP_MS } from './budgets.ts';
import {
  bootGame,
  coinLedger,
  expect,
  prepareGamePage,
  probe,
  reviewShot,
  tapDrop,
  test,
  unexpectedErrors,
} from './fixtures.ts';
import { median, stampRun, writePerfReport, type WithHost } from './perf-report.ts';

interface FirstDropTimes {
  /** The pointerdown event's timestamp. */
  readonly tapMs: number | null;
  /** When the render thread's sync first counted the dropped coin. */
  readonly dropMs: number | null;
  /** The longest animation frame in the AFTER_TAP_WINDOW_MS after the tap, once it is over. */
  readonly longestFrameMs: number | null;
}

/** Long enough to cover the frames that first draw the dropped coin on SwiftShader. */
const AFTER_TAP_WINDOW_MS = 1_500;

declare global {
  interface Window {
    __firstDrop?: FirstDropTimes;
  }
}

/**
 * Times the first drop inside the page. The bridge writes `stats.coins` on every sync, so an
 * accessor on that field stamps the very sync that counts the new coin. Stamping it from the
 * test after a poll instead adds the probe round trips and, on SwiftShader, a single ~1 s frame
 * that lands 100 to 300 ms after the first tap, which made the number jump between about 2.1
 * and 3.2 s. That frame is still reported as `longestFrameAfterTapMs`.
 */
function watchFirstDrop(page: Page, ledgerBefore: number): Promise<void> {
  return page.evaluate(
    ({ before, fusionInputs, windowMs }) => {
      const p = window.__coinposh;
      const stats = p?.sim;
      if (!p || !stats) throw new Error('window.__coinposh.sim is missing: the sim is not running');
      const field = Object.getOwnPropertyDescriptor(stats, 'coins');
      if (!field || !('value' in field) || field.writable !== true) {
        throw new Error('sim stats.coins is no longer a plain field, so the drop cannot be timed');
      }
      const times: {
        tapMs: number | null;
        dropMs: number | null;
        longestFrameMs: number | null;
      } = { tapMs: null, dropMs: null, longestFrameMs: null };
      window.__firstDrop = times;
      const timeFramesFrom = (tapMs: number): void => {
        let longest = 0;
        let last = performance.now();
        const frame = (now: number): void => {
          longest = Math.max(longest, now - last);
          last = now;
          if (now - tapMs < windowMs) requestAnimationFrame(frame);
          else times.longestFrameMs = longest;
        };
        requestAnimationFrame(frame);
      };
      addEventListener(
        'pointerdown',
        (event) => {
          times.tapMs = event.timeStamp;
          timeFramesFrom(event.timeStamp);
        },
        { capture: true, once: true },
      );
      let coins = field.value as number;
      Object.defineProperty(stats, 'coins', {
        configurable: true,
        enumerable: true,
        get: () => coins,
        set: (next: number) => {
          coins = next;
          if (times.tapMs === null || times.dropMs !== null) return;
          const { simFalls, simFusions } = p.counts;
          if (next + simFalls + simFusions * (fusionInputs - 1) <= before) return;
          times.dropMs = performance.now();
        },
      });
    },
    {
      before: ledgerBefore,
      fusionInputs: economyConfig.fusion.inputCount,
      windowMs: AFTER_TAP_WINDOW_MS,
    },
  );
}

interface BootRun {
  readonly playableMs: number;
  readonly tapMs: number;
  readonly firstDropMs: number;
  readonly tapToDropMs: number;
  readonly longestFrameAfterTapMs: number;
}

/** One cold boot to the first coin on `page`, timed inside the page. */
async function bootToFirstDrop(page: Page, shot: string | null): Promise<BootRun> {
  await bootGame(page, { query: '?quality=low' });
  const playableMs = await page.evaluate(() => performance.now());
  const before = coinLedger(await probe(page));
  await watchFirstDrop(page, before);
  await tapDrop(page);
  await page.waitForFunction(
    () => {
      const times = window.__firstDrop;
      if (!times) return false;
      return times.dropMs !== null && times.longestFrameMs !== null;
    },
    null,
    { timeout: 5_000 },
  );
  const times = await page.evaluate(() => window.__firstDrop ?? null);
  if (!times) throw new Error('window.__firstDrop is gone: the page navigated during the drop');
  await expect
    .poll(async () => coinLedger(await probe(page)), { message: 'one tap adds one coin' })
    .toBe(before + 1);
  if (shot) await reviewShot(page, shot);

  const { tapMs, dropMs, longestFrameMs } = times;
  if (tapMs === null || dropMs === null || longestFrameMs === null) {
    throw new Error(`The first drop was not fully timed: ${JSON.stringify(times)}`);
  }
  return {
    playableMs,
    tapMs,
    firstDropMs: dropMs,
    tapToDropMs: dropMs - tapMs,
    longestFrameAfterTapMs: longestFrameMs,
  };
}

test.describe('boot budget', () => {
  test(`the median of ${String(BOOT_RUNS)} cold boots reaches the first coin in the sim under ${String(BOOT_TO_FIRST_DROP_MS)} ms`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(BOOT_RUNS * 45_000);
    const runs: WithHost<BootRun>[] = [];
    for (let i = 0; i < BOOT_RUNS; i += 1) {
      // A fresh context per run, so every boot starts with an empty HTTP cache.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const errors = await prepareGamePage(page);
        runs.push(stampRun(await bootToFirstDrop(page, i === 0 ? 'perf-first-drop' : null)));
        expect(unexpectedErrors(errors, testInfo), `boot ${String(i + 1)} logged errors`).toEqual(
          [],
        );
      } finally {
        await context.close();
      }
    }

    const pick = (metric: keyof BootRun): number => median(runs.map((run) => run[metric]));
    const headline = {
      statistic: `median of ${String(runs.length)}`,
      playableMs: pick('playableMs'),
      firstDropMs: pick('firstDropMs'),
      tapToDropMs: pick('tapToDropMs'),
      longestFrameAfterTapMs: pick('longestFrameAfterTapMs'),
      budgetMs: BOOT_TO_FIRST_DROP_MS,
    };
    await writePerfReport('boot.json', headline, runs, testInfo);

    expect(
      headline.firstDropMs,
      `median ms from navigation start to the first coin in the sim, runs: ${runs.map((run) => run.firstDropMs.toFixed(0)).join(', ')}`,
    ).toBeLessThan(BOOT_TO_FIRST_DROP_MS);
  });
});
