import type { Page } from '@playwright/test';
import { bootGame, expect, probe, tapDrop, test, vaultBalance } from './fixtures.ts';

/** The sessionStorage key apps/web/src/net/mock/persist.ts keeps the Demo world under. */
const DEMO_STORAGE_KEY = 'coinposh.demo.world';
const DEMO_BLOB_SCHEMA = 3;
/** The acceptance bound: the reload lands this soon after the server answered the open. */
const RELOAD_WITHIN_MS = 300;
/** How often the page is polled for the open; it bounds the lag before the reload is sent. */
const OPENED_POLL_MS = 16;
/** A thumb's pace, slower than the drop spacing so the buffer never runs dry. */
const TAP_EVERY_MS = 260;
/** The longest the pusher may take to shove the scripted crate over the lip. */
const CRATE_OPENS_WITHIN_MS = 90_000;
/** The full unbox cinematic plus a loaded runner's slow frames. */
const CARD_UP_WITHIN_MS = 30_000;
/** Long enough after boot for a replay to have mounted, were one still owed. */
const NO_REPLAY_DWELL_MS = 4_000;

type Motion = 'full' | 'reduced';

interface StoredReward {
  readonly kind: string;
  readonly currency?: string;
  readonly amount?: number;
}

interface StoredRoll {
  readonly rarity: string;
  readonly rewards: readonly StoredReward[];
}

interface StoredWorld {
  readonly ledger: readonly { readonly reason: string; readonly ref: string | null }[];
  readonly players: readonly {
    readonly openedRolls: readonly { readonly crateId: string; readonly roll: StoredRoll }[];
  }[];
}

async function storedWorld(page: Page): Promise<StoredWorld> {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), DEMO_STORAGE_KEY);
  if (raw === null) throw new Error('The Demo world is not in sessionStorage.');
  const blob = JSON.parse(raw) as { schema: number; world: StoredWorld };
  expect(blob.schema, 'the Demo blob carries the opened rolls').toBe(DEMO_BLOB_SCHEMA);
  return blob.world;
}

function currencyRewards(roll: StoredRoll): readonly StoredReward[] {
  return roll.rewards.filter((reward) => reward.kind === 'currency');
}

function lootFor(world: StoredWorld, crateId: string) {
  return world.ledger.filter((entry) => entry.ref === `vaultCrate:${crateId}`);
}

/**
 * Plays until the server answers the scripted crate's open, then reloads at once. Each pause
 * between taps polls the page every OPENED_POLL_MS, and the reload is sent the moment the open
 * shows, so it lands well inside RELOAD_WITHIN_MS of `crate:opened`, mid-cinematic.
 */
async function reloadAsTheCrateOpens(page: Page): Promise<void> {
  const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `No crate opened within ${String(CRATE_OPENS_WITHIN_MS)} ms: ${JSON.stringify((await probe(page)).counts)}`,
      );
    }
    await tapDrop(page);
    const seen = await page
      .waitForFunction(
        () => {
          const opened = (window.__coinposh?.counts.cratesOpened ?? 0) >= 1;
          if (opened) window.__crateOpenedSeenAt = performance.now();
          return opened;
        },
        null,
        { polling: OPENED_POLL_MS, timeout: TAP_EVERY_MS },
      )
      .then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && error.name === 'TimeoutError') return false;
          throw error;
        },
      );
    if (!seen) continue;
    const lag = await page.evaluate(() => performance.now() - (window.__crateOpenedSeenAt ?? 0));
    await page.reload({ waitUntil: 'commit' });
    expect(lag + OPENED_POLL_MS, 'the reload follows the open').toBeLessThan(RELOAD_WITHIN_MS);
    return;
  }
}

async function waitPlayable(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
    timeout: 60_000,
    polling: OPENED_POLL_MS,
  });
}

async function reloadMidUnboxAndCollect(page: Page, motion: Motion): Promise<void> {
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  await bootGame(page);
  await reloadAsTheCrateOpens(page);
  await waitPlayable(page);

  const world = await storedWorld(page);
  const [kept] = world.players[0]?.openedRolls ?? [];
  if (!kept) throw new Error('The Demo world kept no roll for the crate the reload cut off.');
  const paid = lootFor(world, kept.crateId);
  expect(paid, 'exactly one loot entry per reward').toHaveLength(currencyRewards(kept.roll).length);

  const reveal = page.getByTestId('crate-reveal');
  await expect(reveal, 'the same crate comes back after boot').toBeAttached({
    timeout: CARD_UP_WITHIN_MS,
  });
  await expect(reveal).toHaveAttribute('data-motion', motion);
  await expect(reveal, 'the stored roll, not a new one').toHaveAttribute(
    'data-rarity',
    kept.roll.rarity,
  );
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible({ timeout: CARD_UP_WITHIN_MS });
  const coins = currencyRewards(kept.roll).find((reward) => reward.currency === 'coins');
  if (coins?.amount !== undefined) {
    const line = reveal.locator('.cp-crate-line--currency', { hasText: /Coins/ });
    await expect(line).toHaveCount(1);
    expect(Number(((await line.textContent()) ?? '').replace(/\D/g, ''))).toBe(coins.amount);
  }
  expect(lootFor(await storedWorld(page), kept.crateId), 'a replay books nothing').toEqual(paid);

  const vaultBefore = await vaultBalance(page);
  const collecting = reveal.evaluate(
    (root) =>
      new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!root.classList.contains('is-collecting')) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
      }),
  );
  await collect.click();
  await collecting;
  await expect(reveal, 'Collect plays the payout and the card leaves').toHaveCount(0);
  const after = await probe(page);
  expect(after.counts.cratesOpened).toBe(1);
  expect(after.counts.cratesCollected).toBe(1);
  expect(await vaultBalance(page)).toBeGreaterThanOrEqual(vaultBefore);
  expect(lootFor(await storedWorld(page), kept.crateId), 'Collect books nothing').toEqual(paid);

  await page.reload();
  await waitPlayable(page);
  await page.waitForTimeout(NO_REPLAY_DWELL_MS);
  await expect(reveal, 'a collected crate never shows again').toHaveCount(0);
  expect((await probe(page)).counts.cratesOpened).toBe(0);
  expect(lootFor(await storedWorld(page), kept.crateId)).toEqual(paid);
}

declare global {
  interface Window {
    __crateOpenedSeenAt?: number;
  }
}

/** P-703: a reload mid-unbox pays once and still shows the card, on the shipped Demo build. */
test.describe('a reload during an unbox (P-703)', () => {
  test('replays the same roll after boot, Collect pays it out, and it never shows again', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await reloadMidUnboxAndCollect(page, 'full');
  });

  test('reduced motion replays the card without the cinematic', async ({ page }) => {
    test.setTimeout(240_000);
    await reloadMidUnboxAndCollect(page, 'reduced');
  });
});
