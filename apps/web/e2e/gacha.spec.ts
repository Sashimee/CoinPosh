import type { Page } from '@playwright/test';
import { bootGame, expect, probe, test } from './fixtures.ts';

const DEMO_STORAGE_KEY = 'coinposh.demo.world';
const FRESH_MARKER = 'e2e.gacha.fresh-session';
const PLANT_MARKER = 'e2e.gacha.plant';
const PLANTED_TICKETS = 2;
/** SwiftShader renders the game and the machine at a few fps, and the machine's ticker caps dt. */
const SOFTWARE_GPU_REVEAL_MS = 45_000;

declare module './fixtures.ts' {
  interface ProbeCounts {
    readonly gachaPulls: number;
    readonly gachaCollected: number;
  }
}

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
 * A fresh Demo player holds no Tickets, so the next document's world gets some. The mock checks
 * that every wallet equals its checkpoint plus its ledger, so the checkpoint moves with it.
 */
async function plantTicketsOnNextLoad(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, marker, tickets }: { key: string; marker: string; tickets: number }) => {
      if (sessionStorage.getItem(marker) === null) return;
      sessionStorage.removeItem(marker);
      const raw = sessionStorage.getItem(key);
      if (raw === null) throw new Error('e2e: no Demo world was saved to plant Tickets in');
      type Wallet = Record<string, number>;
      const blob = JSON.parse(raw) as {
        world: { players: { id: string; wallet: Wallet }[]; checkpoints: [string, Wallet][] };
      };
      const [player] = blob.world.players;
      if (!player) throw new Error('e2e: the saved Demo world has no player to give Tickets');
      player.wallet.tickets = (player.wallet.tickets ?? 0) + tickets;
      const checkpoint = blob.world.checkpoints.find(([id]) => id === player.id);
      if (checkpoint) checkpoint[1].tickets = (checkpoint[1].tickets ?? 0) + tickets;
      else {
        const zero = Object.fromEntries(Object.keys(player.wallet).map((name) => [name, 0]));
        blob.world.checkpoints.push([player.id, { ...zero, tickets }]);
      }
      sessionStorage.setItem(key, JSON.stringify(blob));
    },
    { key: DEMO_STORAGE_KEY, marker: PLANT_MARKER, tickets: PLANTED_TICKETS },
  );
}

function ticketsSpentOnGacha(page: Page): Promise<number> {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return 0;
    const blob = JSON.parse(raw) as {
      world: { ledger: { reason: string; delta: Record<string, number> }[] };
    };
    return blob.world.ledger
      .filter((entry) => entry.reason === 'gacha.tickets')
      .reduce((sum, entry) => sum - (entry.delta.tickets ?? 0), 0);
  }, DEMO_STORAGE_KEY);
}

function serverTickets(page: Page): Promise<number> {
  return page.evaluate(() => {
    const demo = window.__coinposh?.demo;
    if (!demo) throw new Error('window.__coinposh.demo is missing: the page is not in Demo Mode');
    return demo.wallet().tickets;
  });
}

test.describe('Capsule machine (issue #218)', () => {
  test('the dock opens the machine in Demo, a pull spends one Ticket and reveals the server roll', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await startFreshDemoSession(page);
    await plantTicketsOnNextLoad(page);
    await bootGame(page);
    await expect(page.getByTestId('dock-gacha')).toBeVisible();

    await page.evaluate((marker) => {
      sessionStorage.setItem(marker, '1');
    }, PLANT_MARKER);
    await page.reload();
    await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
      timeout: 60_000,
      polling: 16,
    });
    expect(await serverTickets(page)).toBe(PLANTED_TICKETS);

    await page.getByTestId('dock-gacha').click();
    const panel = page.getByTestId('gacha-panel');
    await expect(panel).toBeVisible();
    const tickets = panel.getByTestId('gacha-tickets');
    await expect(tickets).toHaveAttribute('data-value', String(PLANTED_TICKETS));
    const pull = panel.getByTestId('gacha-pull');
    await expect(pull).toHaveAttribute('aria-disabled', 'false');

    await pull.click();
    await expect.poll(async () => (await probe(page)).counts.gachaPulls).toBe(1);
    await expect.poll(() => ticketsSpentOnGacha(page)).toBe(1);
    const afterPull = await serverTickets(page);
    await expect(tickets).toHaveAttribute('data-value', String(afterPull));

    const reveal = panel.getByTestId('gacha-reveal');
    await expect(reveal).toBeVisible({ timeout: SOFTWARE_GPU_REVEAL_MS });
    await expect(reveal).toHaveAttribute(
      'data-rarity',
      /^(common|fine|rare|exquisite|legendary|heirloom)$/,
    );
    await expect(panel.getByTestId('gacha-status')).not.toBeEmpty();

    await panel.getByTestId('gacha-collect').click();
    await expect.poll(async () => (await probe(page)).counts.gachaCollected).toBe(1);
    await expect(reveal).toBeHidden();
    await expect(pull).toBeVisible();
  });

  test('with no Tickets, Pull is refused and says how to earn one', async ({ page }) => {
    await startFreshDemoSession(page);
    await bootGame(page);
    await page.getByTestId('dock-gacha').click();
    const panel = page.getByTestId('gacha-panel');
    await expect(panel.getByTestId('gacha-tickets')).toHaveAttribute('data-value', '0');
    await expect(panel.getByTestId('gacha-pull')).toHaveAttribute('aria-disabled', 'true');
    await expect(panel.locator('#cp-gacha-hint')).toContainText('Ticket');
    await panel.getByTestId('gacha-pull').click({ force: true });
    await expect(panel.getByTestId('gacha-reveal')).toBeHidden();
    expect((await probe(page)).counts.gachaPulls).toBe(0);
    expect(await ticketsSpentOnGacha(page)).toBe(0);
  });
});
