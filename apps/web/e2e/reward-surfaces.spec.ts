import type { Locator, Page } from '@playwright/test';
import { bootGame, expect, probe, reviewShot, tapDrop, test } from './fixtures.ts';

/** A thumb's pace: fast enough to push the crate to the lip, slow enough to keep the queue short. */
const TAP_EVERY_MS = 400;
/** The longest the pusher may take to shove the scripted crate over the lip. */
const CRATE_OPENS_WITHIN_MS = 90_000;
/** Card fly (520 ms in revealCard.ts) plus the cinematic's wrap-up and a frame or two of slack. */
const COLLECT_SETTLES_MS = 3_000;

/** The chunk each reward surface ships in, as bundle-size.ts names them. */
const SURFACE_CHUNKS = {
  inventory: /\/assets\/inventory-[\w-]+\.js$/,
  album: /\/assets\/album-[\w-]+\.js$/,
  fair: /\/assets\/fair-[\w-]+\.js$/,
  scratch: /\/assets\/scratch(?:Sheet)?-[\w-]+\.js$/,
} as const;

type Surface = keyof typeof SURFACE_CHUNKS;

interface RevealedItem {
  readonly kind: 'charm' | 'collectible';
  readonly name: string;
}

/** Records every reward surface chunk the page requests, from before the first script runs. */
function watchSurfaceChunks(page: Page): Set<Surface> {
  const requested = new Set<Surface>();
  page.on('request', (request) => {
    const url = request.url();
    for (const [surface, chunk] of Object.entries(SURFACE_CHUNKS) as [Surface, RegExp][]) {
      if (chunk.test(url)) requested.add(surface);
    }
  });
  return requested;
}

/** Taps until the pusher shoves a crate over the lip and its reveal mounts. */
async function playUntilReveal(page: Page, reveal: Locator): Promise<void> {
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

/** The charms and collectibles the open reveal card lists, by name. */
async function revealedItems(reveal: Locator): Promise<RevealedItem[]> {
  return reveal.locator('.cp-crate-line--item').evaluateAll((lines) =>
    lines.map((line) => ({
      kind: line.classList.contains('cp-crate-line--charm')
        ? ('charm' as const)
        : ('collectible' as const),
      name: line.querySelector('.cp-crate-line-name')?.textContent.trim() ?? '',
    })),
  );
}

test.describe('reward surfaces in Demo Mode at 390x844 (P-641)', () => {
  test('a crate fills the Collection and the Album, and Settings opens the Certified Fair, each loaded on its first tap', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const requested = watchSurfaceChunks(page);
    const reveal = page.getByTestId('crate-reveal');
    let items: RevealedItem[] = [];

    await test.step('boot with no reward surface loaded', async () => {
      await bootGame(page);
      await expect(page.getByTestId('inventory-trigger')).toBeVisible();
      expect([...requested], 'no reward sheet chunk loads with the table').toEqual([]);
    });

    await test.step('one crate unboxes and its card is collected', async () => {
      await playUntilReveal(page, reveal);
      await page.keyboard.press('Escape');
      await expect(reveal).toHaveClass(/is-revealed/, { timeout: 30_000 });
      const collect = page.getByTestId('crate-collect');
      await expect(collect).toBeVisible();
      items = await revealedItems(reveal);
      expect(
        items.some((item) => item.kind === 'charm' && item.name !== ''),
        'the first crate grants a named charm',
      ).toBe(true);
      const collected = await reveal.elementHandle();
      await collect.click();
      await expect
        .poll(() => collected.evaluate((el) => el.isConnected), {
          message: 'the collected crate reveal leaves the page',
          timeout: COLLECT_SETTLES_MS,
        })
        .toBe(false);
      await collected.dispose();
      expect((await probe(page)).counts.cratesCollected).toBeGreaterThanOrEqual(1);
      await expect(page.getByTestId('inventory-trigger-badge')).toBeVisible();
      expect([...requested], 'collecting a crate loads no reward sheet').toEqual([]);
    });

    await test.step('the Collection lists the charm by name', async () => {
      await page.getByTestId('inventory-trigger').click();
      const inventory = page.getByTestId('inventory');
      await expect(inventory).toBeVisible();
      expect(requested.has('inventory'), 'the Collection chunk loads on its first tap').toBe(true);
      for (const charm of items.filter((item) => item.kind === 'charm')) {
        await expect(
          inventory.getByTestId('inventory-card').filter({ hasText: charm.name }),
          `the Collection shows ${charm.name}`,
        ).not.toHaveCount(0);
      }
      await expect(page.getByTestId('inventory-trigger-badge')).toBeHidden();
      await reviewShot(page, 'reward-surfaces-01-collection');
      expect(requested.has('album')).toBe(false);
    });

    await test.step('the Album shows each item from the crate in its set', async () => {
      await page.getByTestId('album-trigger').click();
      const album = page.getByTestId('album');
      await expect(album).toBeVisible();
      expect(requested.has('album'), 'the Album chunk loads on its first tap').toBe(true);
      for (const item of items) {
        await expect(
          album
            .getByTestId('album-set')
            .locator('[data-testid="album-slot"][data-owned="true"]')
            .filter({ hasText: item.name }),
          `the Album holds ${item.name}`,
        ).not.toHaveCount(0);
      }
      await reviewShot(page, 'reward-surfaces-02-album');
      await page.keyboard.press('Escape');
      await expect(album).toBeHidden();
    });

    await test.step('Settings opens the Certified Fair desk', async () => {
      expect(requested.has('fair')).toBe(false);
      await page.getByTestId('dock-settings').click();
      await expect(page.getByTestId('sheet-settings')).toBeVisible();
      await page.getByTestId('fair-trigger').click();
      const fair = page.getByTestId('fair');
      await expect(fair).toBeVisible();
      expect(requested.has('fair'), 'the Certified Fair chunk loads on its first tap').toBe(true);
      await expect(fair.getByTestId('fair-odds')).toBeVisible();
      await expect(page.getByTestId('sheet-settings'), 'the desk replaces Settings').toBeHidden();
      await reviewShot(page, 'reward-surfaces-03-fair');
      await page.keyboard.press('Escape');
      await expect(fair).toBeHidden();
    });
  });
});
