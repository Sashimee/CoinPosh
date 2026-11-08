import type { Page } from '@playwright/test';
import {
  bootGame,
  coinLedger,
  expect,
  probe,
  type Probe,
  refusedTotal,
  reviewShot,
  tapDrop,
  test,
} from './fixtures.ts';

const DROPS = 10;
const DROP_SPACING_MS = 900;
/** P-192: a credited fall shows its number pop and lifts the Vault within this window. */
const FEEDBACK_WINDOW_MS = 500;
/** P-221: an honest run may lose one claim to timing at most. */
const MAX_REFUSED_FALLS = 1;
const QUIET_MS = 3_000;

interface Timeline {
  readonly frontFalls: readonly number[];
  readonly pops: readonly number[];
  readonly vault: readonly (readonly [at: number, value: number])[];
  readonly fluteFill: number;
}

declare global {
  interface Window {
    __timeline?: {
      frontFalls: number[];
      pops: number[];
      vault: [number, number][];
      fluteFill: number;
    };
  }
}

/** Records, in page time, every front-edge fall, number pop, Vault change and the flute's peak. */
async function recordTimeline(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const timeline = {
      frontFalls: [] as number[],
      pops: [] as number[],
      vault: [] as [number, number][],
      fluteFill: 0,
    };
    window.__timeline = timeline;
    let frontFalls = 0;
    let vault = Number.NaN;
    const sample = (): void => {
      const now = performance.now();
      const p = window.__coinposh;
      if (p?.playable) {
        const seen = p.counts.frontFalls;
        for (; frontFalls < seen; frontFalls += 1) timeline.frontFalls.push(now);
      }
      const text = document.querySelector('[data-testid=hud-balance] .cp-sr-only')?.textContent;
      const digits = text?.replace(/\D/g, '') ?? '';
      if (digits !== '' && Number(digits) !== vault) {
        vault = Number(digits);
        timeline.vault.push([now, vault]);
      }
      const flute = document.querySelector<HTMLElement>('[data-testid=hud-combo]');
      const fill = Number(flute?.style.getPropertyValue('--cp-fill') ?? '0');
      if (Number.isFinite(fill)) timeline.fluteFill = Math.max(timeline.fluteFill, fill);
    };
    setInterval(sample, 10);
    new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target;
        if (el instanceof HTMLElement && el.classList.contains('cp-pop') && !el.hidden) {
          timeline.pops.push(performance.now());
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

function readTimeline(page: Page): Promise<Timeline> {
  return page.evaluate(() => {
    const t = window.__timeline;
    if (!t) throw new Error('The timeline recorder did not run before the game booted');
    return {
      frontFalls: [...t.frontFalls],
      pops: [...t.pops],
      vault: [...t.vault],
      fluteFill: t.fluteFill,
    };
  });
}

function settled(p: Probe): boolean {
  return p.counts.frontFalls === p.counts.credits + refusedTotal(p.counts);
}

/** Waits until every fall claim has an answer and nothing has fallen for QUIET_MS. */
async function waitForQuietTable(page: Page): Promise<Probe> {
  let last = '';
  let quietSince = Date.now();
  await expect
    .poll(
      async () => {
        const p = await probe(page);
        const key = JSON.stringify(p.counts);
        if (key !== last) {
          last = key;
          quietSince = Date.now();
        }
        return settled(p) && Date.now() - quietSince >= QUIET_MS;
      },
      { timeout: 45_000, intervals: [250] },
    )
    .toBe(true);
  return probe(page);
}

interface Snapshot {
  readonly at: number;
  readonly probe: Probe;
  readonly vault: number;
}

/** Counters and the Vault read in one page task, so no credit can land between the two. */
async function snapshot(page: Page): Promise<Snapshot> {
  const { at, p, vaultText } = await page.evaluate(() => {
    const live = window.__coinposh;
    if (!live) throw new Error('window.__coinposh is missing: the page is not the CoinPosh game');
    return {
      at: performance.now(),
      p: { sim: live.sim, playable: live.playable, counts: live.counts },
      vaultText: document.querySelector('[data-testid=hud-balance] .cp-sr-only')?.textContent ?? '',
    };
  });
  const digits = vaultText.replace(/\D/g, '');
  if (digits === '') throw new Error(`The Vault plaque announced no balance: "${vaultText}"`);
  return { at, probe: p, vault: Number(digits) };
}

function delta(end: Probe, start: Probe, pick: (p: Probe) => number): number {
  return pick(end) - pick(start);
}

/**
 * The pusher keeps working the heap after the last drop, so the table never has to fall quiet.
 * Instead this waits for a moment where every claim is answered and the Vault shows exactly
 * what the drops spent and the ledge paid since `start`.
 */
async function waitForBalancedVault(page: Page, start: Snapshot): Promise<Snapshot> {
  let last: Snapshot = start;
  await expect
    .poll(
      async () => {
        last = await snapshot(page);
        const credited = delta(last.probe, start.probe, (p) => p.counts.creditedCoins);
        return settled(last.probe) && last.vault === start.vault - DROPS + credited;
      },
      {
        message: 'Vault = start - drops + credited coins, with every fall claim answered',
        timeout: 30_000,
        intervals: [100],
      },
    )
    .toBe(true);
  return last;
}

test.describe('core loop at 390x844 (P-192, P-221)', () => {
  test('ten drops: coins add up, every front fall is credited with its pop and Vault rise', async ({
    page,
  }) => {
    await recordTimeline(page);
    await bootGame(page, { query: '?quality=low' });
    await waitForQuietTable(page);
    const start = await snapshot(page);

    for (let i = 0; i < DROPS; i += 1) {
      await tapDrop(page);
      await page.waitForTimeout(DROP_SPACING_MS);
    }
    const end = await waitForBalancedVault(page, start);
    const recorded = await readTimeline(page);
    await reviewShot(page, 'core-loop-after-10-drops');

    // Coin counts and fall events reach the page in separate worker messages, so one read can
    // catch a coin that has left the table before its fall event arrives.
    await expect
      .poll(async () => coinLedger(await probe(page)) - coinLedger(start.probe), {
        message: 'sim coins = before + drops - falls - fused',
        timeout: 5_000,
      })
      .toBe(DROPS);

    const credits = delta(end.probe, start.probe, (p) => p.counts.credits);
    const frontFalls = delta(end.probe, start.probe, (p) => p.counts.frontFalls);
    const refused = delta(end.probe, start.probe, (p) => refusedTotal(p.counts));
    const falls = delta(end.probe, start.probe, (p) => p.counts.falls);
    const simFalls = delta(end.probe, start.probe, (p) => p.counts.simFalls);

    expect(credits, 'an honest run earns credits').toBeGreaterThan(0);
    expect(frontFalls, 'every front fall is credited or refused').toBe(credits + refused);
    expect(refused, JSON.stringify(end.probe.counts.refusedFalls)).toBeLessThanOrEqual(
      MAX_REFUSED_FALLS,
    );
    expect(falls).toBeGreaterThanOrEqual(frontFalls);
    expect(falls).toBeLessThanOrEqual(simFalls);

    const inRun = (at: number): boolean => at >= start.at && at <= end.at;
    const vault = recorded.vault.filter(([at]) => inRun(at));
    const fallsInRun = recorded.frontFalls.filter(inRun);
    const lowest = Math.min(start.vault, ...vault.map(([, value]) => value));
    expect(lowest, 'the Vault never dips below what the drops spent').toBeGreaterThanOrEqual(
      start.vault - DROPS,
    );

    expect(fallsInRun).toHaveLength(frontFalls);
    const rises = vault
      .filter(([, value], i) => value > (i === 0 ? start.vault : (vault[i - 1]?.[1] ?? value)))
      .map(([at]) => at);
    const near = (times: readonly number[], at: number): boolean =>
      times.some((t) => Math.abs(t - at) <= FEEDBACK_WINDOW_MS);
    for (const at of fallsInRun) {
      expect(
        near(recorded.pops, at),
        `a number pop within ${FEEDBACK_WINDOW_MS} ms of the fall at ${Math.round(at)} ms`,
      ).toBe(true);
      expect(
        near(rises, at),
        `a Vault rise within ${FEEDBACK_WINDOW_MS} ms of the fall at ${Math.round(at)} ms`,
      ).toBe(true);
    }
    expect(recorded.fluteFill, 'the Cascade flute filled').toBeGreaterThan(0);
  });
});
