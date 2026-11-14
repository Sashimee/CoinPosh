import type { Browser, Page, Request, TestInfo } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import {
  BOOT_RUNS,
  BOOT_TO_FIRST_DROP_MS,
  THROTTLED_BOOT,
  VENUE_TO_PLAYABLE_MS,
} from './budgets.ts';
import {
  coinLedger,
  expect,
  expectDemoMode,
  gameUrl,
  prepareGamePage,
  probe,
  reviewShot,
  test,
  unexpectedErrors,
  type Probe,
  type ProbeSim,
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
 * Waits inside the page for the table to take drops, arms the first-drop timer and resolves with
 * the coin ledger as soon as a sync has counted the opening heap, which at the playable mark it
 * may not have yet. Waiting from the test instead costs a probe round trip per step, each queued
 * behind the first venue frames after playable, which on SwiftShader last up to a second or two.
 *
 * The bridge writes `stats.coins` on every sync, so an accessor on that field stamps the very
 * sync that counts the new coin. The pointerdown's own timestamp marks the tap, so a tap that
 * queues behind a long frame still counts that wait against the boot, as a player's would.
 */
function armFirstDrop(page: Page): Promise<number> {
  return page.evaluate(
    ({ fusionInputs, windowMs, timeoutMs }) =>
      new Promise<number>((resolve, reject) => {
        const startedAt = performance.now();
        const arm = (p: Probe, stats: ProbeSim): void => {
          const field = Object.getOwnPropertyDescriptor(stats, 'coins');
          if (!field || !('value' in field) || field.writable !== true) {
            throw new Error(
              'sim stats.coins is no longer a plain field, so the drop cannot be timed',
            );
          }
          const ledger = (coins: number): number =>
            coins + p.counts.simFalls + p.counts.simFusions * (fusionInputs - 1);
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
          let before: number | null = null;
          const synced = (): void => {
            before = ledger(coins);
            resolve(before);
          };
          Object.defineProperty(stats, 'coins', {
            configurable: true,
            enumerable: true,
            get: () => coins,
            set: (next: number) => {
              coins = next;
              if (before === null) {
                synced();
                return;
              }
              if (times.tapMs === null || times.dropMs !== null) return;
              if (ledger(next) > before) times.dropMs = performance.now();
            },
          });
          // The Demo heap is never empty, so coins on the table mean a sync has already run.
          if (coins > 0) synced();
        };
        const poll = (): void => {
          const p = window.__coinposh;
          if (p?.playable === true && p.sim) {
            try {
              arm(p, p.sim);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          if (performance.now() - startedAt > timeoutMs) {
            reject(new Error(`The table was not playable ${String(timeoutMs)} ms after load`));
            return;
          }
          setTimeout(poll, 4);
        };
        poll();
      }),
    {
      fusionInputs: economyConfig.fusion.inputCount,
      windowMs: AFTER_TAP_WINDOW_MS,
      timeoutMs: 60_000,
    },
  );
}

interface BootRun {
  /** The app's own `coinposh:boot:playable` mark. */
  readonly playableMs: number;
  /** The app's `coinposh:boot:stage` mark: the renderer is up and its first frame compiled. */
  readonly stageMs: number;
  /** From the `coinposh:boot:venue` mark, the venue built, to the playable mark. */
  readonly venueToPlayableMs: number;
  /**
   * From the playable mark to the test's tap. The tap waits for the first sync after playable,
   * so this is mostly the first venue frame, during which a player's tap would queue as well.
   */
  readonly tapLagMs: number;
  readonly tapMs: number;
  readonly firstDropMs: number;
  readonly tapToDropMs: number;
  readonly longestFrameAfterTapMs: number;
}

/** When main.ts or stage.ts marked boot `step`, in ms from navigation start. */
async function bootMark(page: Page, step: string): Promise<number> {
  const name = `coinposh:boot:${step}`;
  const at = await page.evaluate(
    (mark) => performance.getEntriesByName(mark, 'mark')[0]?.startTime ?? null,
    name,
  );
  if (at === null) throw new Error(`The page never marked ${name}; update boot.perf.ts`);
  return at;
}

/** One cold boot to the first coin on `page`, timed inside the page. */
async function bootToFirstDrop(page: Page, shot: string | null): Promise<BootRun> {
  await page.goto(gameUrl('?quality=low'), { waitUntil: 'domcontentloaded' });
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
  const before = await armFirstDrop(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    () => {
      const times = window.__firstDrop;
      if (!times) return false;
      return times.dropMs !== null && times.longestFrameMs !== null;
    },
    null,
    { timeout: 5_000, polling: 16 },
  );
  const times = await page.evaluate(() => window.__firstDrop ?? null);
  if (!times) throw new Error('window.__firstDrop is gone: the page navigated during the drop');
  await expect
    .poll(async () => coinLedger(await probe(page)), { message: 'one tap adds one coin' })
    .toBe(before + 1);
  await expectDemoMode(page);
  if (shot) await reviewShot(page, shot);

  const { tapMs, dropMs, longestFrameMs } = times;
  if (tapMs === null || dropMs === null || longestFrameMs === null) {
    throw new Error(`The first drop was not fully timed: ${JSON.stringify(times)}`);
  }
  const playableMs = await bootMark(page, 'playable');
  return {
    playableMs,
    stageMs: await bootMark(page, 'stage'),
    venueToPlayableMs: playableMs - (await bootMark(page, 'venue')),
    tapLagMs: tapMs - playableMs,
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
      stageMs: pick('stageMs'),
      venueToPlayableMs: pick('venueToPlayableMs'),
      tapLagMs: pick('tapLagMs'),
      firstDropMs: pick('firstDropMs'),
      tapToDropMs: pick('tapToDropMs'),
      longestFrameAfterTapMs: pick('longestFrameAfterTapMs'),
      budgetMs: BOOT_TO_FIRST_DROP_MS,
      venueToPlayableBudgetMs: VENUE_TO_PLAYABLE_MS,
    };
    await writePerfReport('boot.json', headline, runs, testInfo);

    expect(
      headline.firstDropMs,
      `median ms from navigation start to the first coin in the sim, runs: ${runs.map((run) => run.firstDropMs.toFixed(0)).join(', ')}`,
    ).toBeLessThan(BOOT_TO_FIRST_DROP_MS);
    expect(
      headline.venueToPlayableMs,
      `median ms from the venue mark to playable, runs: ${runs.map((run) => run.venueToPlayableMs.toFixed(0)).join(', ')}`,
    ).toBeLessThan(VENUE_TO_PLAYABLE_MS);
  });

  test(`over throttled 4G, Rapier's wasm is requested at navigation and downloaded once, and the median of ${String(THROTTLED_BOOT.runs)} cold boots is playable under ${String(THROTTLED_BOOT.playableMs)} ms`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(THROTTLED_BOOT.runs * 60_000);
    const runs: WithHost<ThrottledRun>[] = [];
    for (let i = 0; i < THROTTLED_BOOT.runs; i += 1) {
      runs.push(stampRun(await throttledBoot(browser, testInfo, i + 1)));
    }

    const pick = (metric: 'playableMs' | 'venueMs' | 'wasmRequestStartMs'): number =>
      median(runs.map((run) => run[metric]));
    const headline = {
      statistic: `median of ${String(runs.length)}`,
      playableMs: pick('playableMs'),
      venueMs: pick('venueMs'),
      wasmRequestStartMs: pick('wasmRequestStartMs'),
      budgetMs: THROTTLED_BOOT.playableMs,
      network: {
        downloadBitsPerSecond: THROTTLED_BOOT.downloadBitsPerSecond,
        uploadBitsPerSecond: THROTTLED_BOOT.uploadBitsPerSecond,
        latencyMs: THROTTLED_BOOT.latencyMs,
      },
    };
    await writePerfReport('boot-throttled.json', headline, runs, testInfo);

    for (const [i, run] of runs.entries()) {
      const boot = `throttled boot ${String(i + 1)}`;
      expect(
        run.wasmRequestStartMs,
        `${boot}: ms from navigation start to the wasm request`,
      ).toBeLessThan(THROTTLED_BOOT.wasmRequestStartMs);
      expect(
        run.wasmRequests.map((request) => request.url),
        `${boot}: every wasm request is for the URL index.html preloads, so the worker reads the preload from the HTTP cache`,
      ).toEqual(run.wasmRequests.map(() => run.preloadUrl));
      expect(
        run.wasmRequests.filter((request) => request.bodyBytes > 0),
        `${boot}: the wasm body came over the wire once, requests: ${JSON.stringify(run.wasmRequests)}`,
      ).toHaveLength(1);
    }
    expect(
      headline.playableMs,
      `median ms from navigation start to playable over throttled 4G, runs: ${runs.map((run) => run.playableMs.toFixed(0)).join(', ')}`,
    ).toBeLessThan(THROTTLED_BOOT.playableMs);
  });
});

interface WasmRequest {
  readonly url: string;
  readonly status: number | null;
  /** The encoded body bytes received: 0 for a 304 or a response read from the HTTP cache. */
  readonly bodyBytes: number;
}

interface ThrottledRun {
  readonly playableMs: number;
  readonly venueMs: number;
  /** When index.html's wasm preload started, from its resource timing entry. */
  readonly wasmRequestStartMs: number;
  readonly preloadUrl: string;
  /** Every wasm request the page and its sim worker made. */
  readonly wasmRequests: readonly WasmRequest[];
}

const WASM_PRELOAD = 'link[rel="preload"][type="application/wasm"]';

async function wasmRequestOf(request: Request): Promise<WasmRequest> {
  const response = await request.response();
  const sizes = await request.sizes();
  return {
    url: request.url(),
    status: response?.status() ?? null,
    bodyBytes: sizes.responseBodySize,
  };
}

/** One cold boot to playable over throttled 4G, in a fresh context so the HTTP cache is empty. */
async function throttledBoot(
  browser: Browser,
  testInfo: TestInfo,
  boot: number,
): Promise<ThrottledRun> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = await prepareGamePage(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: THROTTLED_BOOT.latencyMs,
      downloadThroughput: THROTTLED_BOOT.downloadBitsPerSecond / 8,
      uploadThroughput: THROTTLED_BOOT.uploadBitsPerSecond / 8,
    });
    const wasm: Promise<WasmRequest>[] = [];
    const settle = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('.wasm')) wasm.push(wasmRequestOf(request));
    };
    page.on('requestfinished', settle);
    page.on('requestfailed', settle);

    await page.goto(gameUrl('?quality=low'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
      timeout: 45_000,
      polling: 16,
    });
    const preload = await page.evaluate((selector) => {
      const link = document.querySelector<HTMLLinkElement>(selector);
      if (!link) return null;
      const entry = performance.getEntriesByName(link.href, 'resource')[0];
      return { url: link.href, startMs: entry?.startTime ?? null };
    }, WASM_PRELOAD);
    if (!preload) throw new Error(`index.html has no ${WASM_PRELOAD}; update boot.perf.ts`);
    if (preload.startMs === null) {
      throw new Error(`The table was playable before the wasm preload of ${preload.url} finished`);
    }
    await expectDemoMode(page);
    expect(
      unexpectedErrors(errors, testInfo),
      `throttled boot ${String(boot)} logged errors`,
    ).toEqual([]);
    return {
      playableMs: await bootMark(page, 'playable'),
      venueMs: await bootMark(page, 'venue'),
      wasmRequestStartMs: preload.startMs,
      preloadUrl: preload.url,
      wasmRequests: await Promise.all(wasm),
    };
  } finally {
    await context.close();
  }
}
