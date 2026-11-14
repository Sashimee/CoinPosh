import type { Page } from '@playwright/test';
import { bootGame, expect, probe, test, vaultBalance } from './fixtures.ts';

const DEMO_STORAGE_KEY = 'coinposh.demo.world';
const FRESH_MARKER = 'e2e.safes.fresh-session';
const PLANT_MARKER = 'e2e.safes.plant';
const PLANTED_SAFE = 'safe_e2eready0001';
type Chip = 'pearls' | 'keys' | 'tickets';

interface ServerWallet {
  readonly coins: number;
  readonly goldBars: number;
  readonly pearls: number;
  readonly keys: number;
  readonly tickets: number;
}

declare module './fixtures.ts' {
  interface ProbeCounts {
    readonly safesOpened: number;
    readonly safesCollected: number;
  }
  interface Probe {
    readonly demo?: { wallet(): ServerWallet };
  }
}

/** Each test starts on an empty Demo world, cleared once so the reload keeps what it planted. */
async function startFreshDemoSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, marker }: { key: string; marker: string }) => {
      if (sessionStorage.getItem(marker) !== null) return;
      sessionStorage.setItem(marker, '1');
      sessionStorage.removeItem(key);
    },
    { key: DEMO_STORAGE_KEY, marker: FRESH_MARKER },
  );
}

/**
 * The Demo mock grants no safe from a crate yet (POLISH P-525), so the next document's world
 * gets one whose timer already ran out. The old page saves the world on pagehide, before this
 * script runs, so the safe lands in what the mock server loads.
 */
async function plantReadySafeOnNextLoad(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, marker, safeId }: { key: string; marker: string; safeId: string }) => {
      if (sessionStorage.getItem(marker) === null) return;
      sessionStorage.removeItem(marker);
      const raw = sessionStorage.getItem(key);
      if (raw === null) throw new Error('e2e: no Demo world was saved to plant a safe in');
      const blob = JSON.parse(raw) as {
        world: { players: { safes: { id: string; type: string; unlocksAt: number }[] }[] };
      };
      const [player] = blob.world.players;
      if (!player) throw new Error('e2e: the saved Demo world has no player to give a safe');
      player.safes.push({ id: safeId, type: 'gold', unlocksAt: Date.now() - 60_000 });
      sessionStorage.setItem(key, JSON.stringify(blob));
    },
    { key: DEMO_STORAGE_KEY, marker: PLANT_MARKER, safeId: PLANTED_SAFE },
  );
}

function serverWallet(page: Page): Promise<ServerWallet> {
  return page.evaluate(() => {
    const demo = window.__coinposh?.demo;
    if (!demo) throw new Error('window.__coinposh.demo is missing: the page is not in Demo Mode');
    const { coins, goldBars, pearls, keys, tickets } = demo.wallet();
    return { coins, goldBars, pearls, keys, tickets };
  });
}

async function hudGoldBars(page: Page): Promise<number> {
  const bars = page.locator('.cp-chip-bars');
  if (await bars.isHidden()) return 0;
  const label = (await bars.getAttribute('aria-label')) ?? '';
  return Number(label.replace(/\D/g, ''));
}

async function hudChip(page: Page, currency: Chip): Promise<number> {
  const chip = page.getByTestId(`hud-wallet-${currency}`);
  if (await chip.isHidden()) return 0;
  return Number(await chip.getAttribute('data-value'));
}

interface DockFit {
  readonly gutter: number;
  readonly innerWidth: number;
  readonly doors: readonly {
    readonly testId: string;
    readonly left: number;
    readonly right: number;
  }[];
  readonly labelCollapsed: boolean;
}

function dockFit(page: Page): Promise<DockFit> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.cp-hud');
    const dock = document.querySelector<HTMLElement>('[data-testid="hud-dock"]');
    const label = dock?.querySelector('.cp-dock-label');
    if (!hud || !dock || !label)
      throw new Error('e2e: the HUD dock or its Upgrades label is missing');
    return {
      gutter: parseFloat(getComputedStyle(hud).paddingRight),
      innerWidth,
      doors: [...dock.children].map((door) => {
        const box = door.getBoundingClientRect();
        return {
          testId: door.getAttribute('data-testid') ?? '?',
          left: box.left,
          right: box.right,
        };
      }),
      labelCollapsed: label.classList.contains('cp-sr-only'),
    };
  });
}

test.describe('Safes sheet (P-544)', () => {
  for (const { width, height, collapsed } of [
    { width: 360, height: 740, collapsed: true },
    { width: 390, height: 844, collapsed: true },
    { width: 768, height: 1024, collapsed: false },
  ]) {
    test(`every dock door stays inside the gutter at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await bootGame(page);
      await expect(page.getByTestId('dock-safes')).toBeVisible();
      await expect(page.getByTestId('hud-ascension')).toBeVisible();

      const fit = await dockFit(page);
      expect(fit.doors.map((door) => door.testId)).toEqual([
        'dock-settings',
        'dock-upgrades',
        'dock-safes',
        'hud-ascension',
      ]);
      expect(fit.gutter, 'the HUD keeps a side gutter').toBeGreaterThanOrEqual(
        width < 375 ? 12 : 16,
      );
      for (const door of fit.doors) {
        expect(door.left, `${door.testId} starts inside the left gutter`).toBeGreaterThanOrEqual(
          fit.gutter,
        );
        expect(door.right, `${door.testId} ends inside the right gutter`).toBeLessThanOrEqual(
          fit.innerWidth - fit.gutter,
        );
      }
      expect(fit.labelCollapsed).toBe(collapsed);
      await expect(page.getByTestId('dock-upgrades')).toHaveAccessibleName(/^Upgrades/);
    });
  }

  test('a ready safe badges the dock, opens from the keyboard, and its payout lands on the server wallet', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await startFreshDemoSession(page);
    await plantReadySafeOnNextLoad(page);
    await bootGame(page);

    const trigger = page.getByTestId('dock-safes');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('dock-safes-badge')).toBeHidden();

    await page.evaluate((marker) => {
      sessionStorage.setItem(marker, '1');
    }, PLANT_MARKER);
    await page.reload();
    await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
      timeout: 60_000,
      polling: 16,
    });

    const badge = page.getByTestId('dock-safes-badge');
    await expect(trigger).toHaveAttribute('data-state', 'ready');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('1');
    await expect(trigger).toHaveAttribute('aria-label', /1 safe ready to open$/);

    await trigger.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('safes-panel');
    await expect(panel).toBeVisible();
    const rows = panel.getByTestId('safe-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-safe', PLANTED_SAFE);

    const before = { vault: await vaultBalance(page), server: await serverWallet(page) };
    await rows.first().getByTestId('safe-open-timer').click();
    const collect = page.getByTestId('safe-collect');
    await expect(collect).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await probe(page)).counts.safesOpened).toBe(1);
    await collect.click();
    await expect.poll(async () => (await probe(page)).counts.safesCollected).toBe(1);

    const after = await serverWallet(page);
    await expect
      .poll(async () => ({
        pearls: await hudChip(page, 'pearls'),
        keys: await hudChip(page, 'keys'),
        tickets: await hudChip(page, 'tickets'),
        goldBars: await hudGoldBars(page),
      }))
      .toEqual({
        pearls: after.pearls,
        keys: after.keys,
        tickets: after.tickets,
        goldBars: after.goldBars,
      });
    await expect
      .poll(async () => (await vaultBalance(page)) - before.vault, {
        message: 'the plaque gains what the server credited, beside the drops in flight',
      })
      .toBeGreaterThanOrEqual(after.coins - before.server.coins);

    await expect(badge).toBeHidden();
    await expect(trigger).toHaveAttribute('data-state', 'empty');
  });
});
