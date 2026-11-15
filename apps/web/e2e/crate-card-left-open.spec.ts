import type { ConsoleMessage, Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, probe, reviewShot, tapDrop, test, vaultBalance } from './fixtures.ts';

const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
const TAP_EVERY_MS = 400;
const CRATE_OPENS_WITHIN_MS = 90_000;
/** The full unbox cinematic plus a loaded runner's slow frames. */
const CARD_UP_WITHIN_MS = 30_000;
/**
 * P-722: twice the HUD's 30 s hold cap, which used to pay the card out behind the player's back.
 * It is waited for in real time: page.clock would also freeze the animation frames the table and
 * the plaque run on, so nothing behind the card would move while it stood open.
 */
const LEFT_OPEN_MS = 60_000;
/** How long the table is shoved behind the card, so falls are held behind it too. */
const NUDGE_FOR_MS = 12_000;
const NUDGE_EVERY_MS = 500;
/** The coin line's flight plus the held falls' gap and pops, with slack for slow frames. */
const PAYOUT_SETTLES_MS = 6_000;
const GL_DRIVER_NOTE = /^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message/;

interface VaultChange {
  readonly at: number;
  readonly by: number;
}

interface LeftOpenTracer {
  readonly changes: VaultChange[];
  vault: number;
  stop(): void;
}

declare global {
  interface Window {
    __leftOpenGuard?: boolean;
    __leftOpenTrace?: LeftOpenTracer;
  }
}

/** Drops pointer input that would reach an open reveal, where a stray tap is a veil skip. */
async function guardRevealTaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__leftOpenGuard = true;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      addEventListener(
        type,
        (event) => {
          if (!window.__leftOpenGuard) return;
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

/** Shoves the table from the keyboard behind the dialog, which keeps focus, as a player's does. */
async function nudgeTableBehindReveal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    if (!stage) throw new Error('The #stage canvas is missing, so the table cannot be nudged');
    stage.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  });
}

/**
 * Records every painted change of the Vault plaque from now on, stamped from the moment the
 * tracer starts. It samples frames, not mutations, because what is under test is what the
 * player would see on coming back to the phone.
 */
async function traceVault(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spoken = document.querySelector('[data-testid=hud-balance] .cp-sr-only');
    if (!spoken) throw new Error('The Vault plaque has no screen-reader balance to trace');
    const read = (): number => Number(spoken.textContent.replace(/\D/g, ''));
    const started = performance.now();
    let tracing = true;
    const frame = (): void => {
      if (!tracing) return;
      const now = read();
      if (now !== tracer.vault) {
        tracer.changes.push({ at: performance.now() - started, by: now - tracer.vault });
      }
      tracer.vault = now;
      requestAnimationFrame(frame);
    };
    const tracer: LeftOpenTracer = {
      changes: [],
      vault: read(),
      stop() {
        tracing = false;
      },
    };
    requestAnimationFrame(frame);
    window.__leftOpenTrace = tracer;
  });
}

async function tracedChanges(page: Page): Promise<VaultChange[]> {
  return page.evaluate(() => {
    const tracer = window.__leftOpenTrace;
    if (!tracer) throw new Error('The Vault tracer was never installed');
    tracer.stop();
    return tracer.changes;
  });
}

test.describe('a crate card left open (P-722)', () => {
  test('pays nothing behind the player for a minute, then COLLECT rolls exactly its coin line', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await bootGame(page);
    await guardRevealTaps(page);
    for (let i = 0; i < FTUE_DROP; i += 1) {
      await tapDrop(page);
      await page.waitForTimeout(TAP_EVERY_MS);
    }
    await playUntilRevealMounts(page);

    const reveal = page.getByTestId('crate-reveal');
    const collect = page.getByTestId('crate-collect');
    await expect(collect).toBeVisible({ timeout: CARD_UP_WITHIN_MS });
    const warnings: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      // SwiftShader's own GL driver notes reach the console as warnings, but no script logs them.
      if (message.type() === 'warning' && !GL_DRIVER_NOTE.test(message.text())) {
        warnings.push(message.text());
      }
    });
    const coins = reveal.locator('.cp-crate-line--currency', { hasText: /Coins/ });
    await expect(coins, 'the seeded card pays a coin line').toHaveCount(1);
    const line = Number(((await coins.textContent()) ?? '').replace(/\D/g, ''));
    expect(line).toBeGreaterThan(0);

    const vault = await vaultBalance(page);
    const fallsAtCard = (await probe(page)).counts.frontFalls;
    await traceVault(page);
    const leftAt = Date.now();
    while (Date.now() - leftAt < NUDGE_FOR_MS) {
      if ((await probe(page)).counts.frontFalls > fallsAtCard) break;
      await nudgeTableBehindReveal(page);
      await page.waitForTimeout(NUDGE_EVERY_MS);
    }
    await page.waitForTimeout(Math.max(0, LEFT_OPEN_MS - (Date.now() - leftAt)));

    await expect(reveal, 'the card is still up, waiting for the player').toBeVisible();
    await expect(collect).toBeVisible();
    const whileOpen = await tracedChanges(page);
    const fallsWhileOpen = (await probe(page)).counts.frontFalls - fallsAtCard;
    expect(
      whileOpen,
      `the Vault moved while the card stood open for ${String(LEFT_OPEN_MS)} ms (${String(fallsWhileOpen)} falls behind it)`,
    ).toEqual([]);
    expect(await vaultBalance(page)).toBe(vault);
    await reviewShot(page, 'crate-card-left-open-60s');

    await traceVault(page);
    await page.evaluate(() => {
      window.__leftOpenGuard = false;
    });
    await collect.click();
    await expect(reveal).toHaveCount(0, { timeout: PAYOUT_SETTLES_MS });
    await page.waitForTimeout(PAYOUT_SETTLES_MS);
    const afterCollect = await tracedChanges(page);
    const [first] = afterCollect;
    expect(first, 'the Vault rolled after COLLECT').toBeDefined();
    expect(
      first?.by,
      `COLLECT rolls the Vault by exactly the card's coin line first: ${JSON.stringify(afterCollect)}`,
    ).toBe(line);
    expect(warnings, 'no console.warn fired from the card going up to its payout').toEqual([]);
  });
});
