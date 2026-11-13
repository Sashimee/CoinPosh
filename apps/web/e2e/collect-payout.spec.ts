import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, probe, tapDrop, test } from './fixtures.ts';

const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
const TAP_EVERY_MS = 400;
const CRATE_OPENS_WITHIN_MS = 90_000;
/** How long the table is nudged behind an open card while waiting for a coin to fall. */
const REVEAL_DWELL_MS = 12_000;
const NUDGE_EVERY_MS = 500;
/** The coin line's flight plus the held falls' gap and their pops, with slack for slow frames. */
const PAYOUT_SETTLES_MS = 6_000;
/** P-450: the held falls follow the coin line by at least this much. */
const FALLS_GAP_MS = 400;
const CRATES_TRIED = 3;

type Motion = 'full' | 'reduced';

interface VaultChange {
  readonly at: number;
  readonly by: number;
}

interface Trace {
  readonly line: number;
  readonly fallsDuringReveal: number;
  readonly changes: readonly VaultChange[];
}

interface PayoutTracer {
  readonly changes: VaultChange[];
  vault: number;
  collectedAt: number | null;
  stop(): void;
}

declare global {
  interface Window {
    __payoutTapGuard?: boolean;
    __payoutTrace?: PayoutTracer;
    __fallsAtOpen?: number;
  }
}

/**
 * Drops pointer input that would reach an open reveal, where any tap is a veil skip, and notes
 * the front-fall count each time a crate opens, which is when the Vault starts holding falls.
 */
async function guardRevealTaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    let opened = 0;
    setInterval(() => {
      const counts = window.__coinposh?.counts;
      if (!counts || counts.cratesOpened === opened) return;
      opened = counts.cratesOpened;
      window.__fallsAtOpen = counts.frontFalls;
    }, 16);
    window.__payoutTapGuard = true;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      addEventListener(
        type,
        (event) => {
          if (!window.__payoutTapGuard) return;
          if (!document.querySelector('[data-testid="crate-reveal"]')) return;
          event.stopImmediatePropagation();
          event.preventDefault();
        },
        { capture: true },
      );
    }
  });
}

async function playUntilRevealMounts(page: Page): Promise<void> {
  const reveal = page.getByTestId('crate-reveal');
  const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
  for (;;) {
    try {
      await reveal.waitFor({ state: 'attached', timeout: TAP_EVERY_MS });
      return;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
    }
    if (Date.now() > deadline) {
      const { counts } = await probe(page);
      throw new Error(
        `No crate reveal within ${String(CRATE_OPENS_WITHIN_MS)} ms of play: ${JSON.stringify(counts)}`,
      );
    }
    await tapDrop(page);
  }
}

/**
 * The table keeps running under the card, but a coin rarely goes over the lip in the few seconds
 * a player reads it, so the test shoves the table from the keyboard behind the dialog. The key
 * goes to the canvas directly: focus belongs to the reveal, as it does for a player.
 */
async function nudgeTableBehindReveal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    if (!stage) throw new Error('The #stage canvas is missing, so the table cannot be nudged');
    stage.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  });
}

/**
 * Records the Vault the plaque shows on every painted frame after the Collect press, which the
 * tracer stamps in the capture phase so no change can slip in between. It samples frames, not
 * mutations, because the order under test is the one the player sees.
 */
async function traceVault(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spoken = document.querySelector('[data-testid=hud-balance] .cp-sr-only');
    if (!spoken) throw new Error('The Vault plaque has no screen-reader balance to trace');
    const read = (): number => Number(spoken.textContent.replace(/\D/g, ''));
    let tracing = true;
    const onPress = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[data-testid="crate-collect"]')) return;
      tracer.collectedAt ??= performance.now();
    };
    const frame = (): void => {
      if (!tracing) return;
      const now = read();
      if (now !== tracer.vault && tracer.collectedAt !== null) {
        tracer.changes.push({ at: performance.now() - tracer.collectedAt, by: now - tracer.vault });
      }
      tracer.vault = now;
      requestAnimationFrame(frame);
    };
    const tracer: PayoutTracer = {
      changes: [],
      vault: read(),
      collectedAt: null,
      stop() {
        tracing = false;
        removeEventListener('click', onPress, { capture: true });
      },
    };
    addEventListener('click', onPress, { capture: true });
    requestAnimationFrame(frame);
    window.__payoutTrace = tracer;
  });
}

/** Plays to the next crate, lets the table run behind its card, collects and traces the Vault. */
async function collectNextCrate(page: Page): Promise<Trace> {
  await page.evaluate(() => {
    window.__payoutTapGuard = true;
  });
  await playUntilRevealMounts(page);
  const reveal = page.getByTestId('crate-reveal');
  await page.keyboard.press('Escape');
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible({ timeout: 15_000 });
  const coins = reveal.locator('.cp-crate-line--currency', { hasText: /Coins/ });
  await expect(coins, 'the card pays a coin line').toHaveCount(1);
  const line = Number(((await coins.textContent()) ?? '').replace(/\D/g, ''));
  expect(line).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.__fallsAtOpen ?? 0);
  const fallsSinceOpen = async (): Promise<number> =>
    (await probe(page)).counts.frontFalls - before;
  const dwellEnds = Date.now() + REVEAL_DWELL_MS;
  while ((await fallsSinceOpen()) === 0 && Date.now() < dwellEnds) {
    await nudgeTableBehindReveal(page);
    await page.waitForTimeout(NUDGE_EVERY_MS);
  }
  const fallsDuringReveal = await fallsSinceOpen();

  await traceVault(page);
  await page.evaluate(() => {
    window.__payoutTapGuard = false;
  });
  await collect.click();
  await expect(reveal).toHaveCount(0, { timeout: PAYOUT_SETTLES_MS });
  await page.waitForTimeout(PAYOUT_SETTLES_MS);
  const changes = await page.evaluate(() => {
    const tracer = window.__payoutTrace;
    if (!tracer) throw new Error('The Vault tracer was never installed');
    tracer.stop();
    return tracer.changes;
  });
  return { line, fallsDuringReveal, changes };
}

async function expectCoinLineFirst(page: Page, motion: Motion): Promise<void> {
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  await bootGame(page);
  await guardRevealTaps(page);
  for (let i = 0; i < FTUE_DROP; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }

  const traces: Trace[] = [];
  for (let n = 0; n < CRATES_TRIED; n += 1) {
    const trace = await collectNextCrate(page);
    traces.push(trace);
    const [first] = trace.changes;
    expect(first, `crate ${String(n + 1)}: the Vault changed after COLLECT`).toBeDefined();
    expect(
      first?.by,
      `crate ${String(n + 1)}: the Vault's first move is the card's coin line (${JSON.stringify(trace)})`,
    ).toBe(trace.line);
    if (trace.fallsDuringReveal > 0) break;
  }

  const shown = traces.at(-1);
  if (!shown) throw new Error('No crate was collected');
  expect(
    shown.fallsDuringReveal,
    `table falls went over the lip during a reveal: ${JSON.stringify(traces)}`,
  ).toBeGreaterThan(0);
  const [first, ...later] = shown.changes;
  const gained = later.reduce((sum, change) => sum + change.by, 0);
  expect(
    gained,
    `the held falls reach the Vault after the coin line: ${JSON.stringify(shown)}`,
  ).toBeGreaterThan(0);
  for (const change of later) {
    expect(
      change.at - (first?.at ?? 0),
      `the held falls follow the coin line by ${String(FALLS_GAP_MS)} ms or more: ${JSON.stringify(shown)}`,
    ).toBeGreaterThanOrEqual(FALLS_GAP_MS);
  }
}

test.describe('collect payout order (P-450)', () => {
  test('COLLECT rolls the Vault by the coin line first, then the falls held behind the reveal', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await expectCoinLineFirst(page, 'full');
  });

  test('reduced motion keeps the coin line ahead of the held falls', async ({ page }) => {
    test.setTimeout(300_000);
    await expectCoinLineFirst(page, 'reduced');
  });
});
