import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, probe, reviewShot, tapDrop, test } from './fixtures.ts';

const DEMO_STORAGE_KEY = 'coinposh.demo.world';
const FRESH_MARKER = 'e2e.gacha.fresh-session';
const PLANT_MARKER = 'e2e.gacha.plant';
const PLANTED_TICKETS = 2;
/** SwiftShader renders the game and the machine at a few fps, and the machine's ticker caps dt. */
const SOFTWARE_GPU_REVEAL_MS = 45_000;
/**
 * The capsule after a played session turns with the whole table still rendering behind the sheet,
 * the slowest case for SwiftShader; a loaded runner overran the 45 s budget there.
 */
const FULL_TABLE_CAPSULE_MS = 120_000;
const FIRST_TICKET = economyConfig.crateSpawn.firstTicket;
const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
/**
 * The next crate spawns on drop `dropsPerCrate`. Staying under it keeps crate 1 the only crate a
 * slow runner can win, so no second reveal mounts over the Capsules sheet.
 */
const TAPS_BEFORE_NEXT_CRATE = economyConfig.crateSpawn.dropsPerCrate - 1;
/** A thumb's pace, as crates.spec.ts plays: fast enough to push a crate to the lip. */
const TAP_EVERY_MS = 400;
/** The longest the pusher may take to shove one crate over the lip on a software GPU. */
const CRATE_OPENS_WITHIN_MS = 90_000;

declare global {
  interface Window {
    __gachaTapGuard?: boolean;
  }
}

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

/**
 * Plays real drops, `taps` at most, until the first crate's reveal mounts, then lets the pusher
 * work alone. A drop tap still in flight when the reveal mounts would land on it as a skip or a
 * Collect, so the page drops pointer input that reaches an open reveal until `releaseRevealTaps`.
 */
async function playUntilFirstCrateReveal(page: Page, taps: number): Promise<void> {
  await page.evaluate(() => {
    window.__gachaTapGuard = true;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      addEventListener(
        type,
        (event) => {
          if (!window.__gachaTapGuard) return;
          if (!document.querySelector('[data-testid="crate-reveal"]')) return;
          event.stopImmediatePropagation();
          event.preventDefault();
        },
        { capture: true },
      );
    }
  });
  const reveal = page.getByTestId('crate-reveal');
  const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
  for (let tapped = 0; ;) {
    if ((await probe(page)).counts.cratesOpened > 0 && (await reveal.count()) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `No crate reveal within ${String(CRATE_OPENS_WITHIN_MS)} ms and ${String(tapped)} taps: ${JSON.stringify((await probe(page)).counts)}`,
      );
    }
    if (tapped < taps) {
      await tapDrop(page);
      tapped += 1;
    }
    await page.waitForTimeout(TAP_EVERY_MS);
  }
}

async function releaseRevealTaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__gachaTapGuard = false;
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

  test('a fresh seeded session goes from a locked machine to its first pull on the first-Ticket crate (P-737)', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    expect(FIRST_TICKET.byCrate, 'this flow earns the Ticket on crate 1').toBe(1);
    await startFreshDemoSession(page);
    await bootGame(page);
    expect(await serverTickets(page)).toBe(0);

    const door = page.getByTestId('dock-gacha');
    const badge = page.getByTestId('dock-gacha-badge');
    await expect(door).toBeVisible();
    await expect(badge, 'no Tickets, no badge').toBeHidden();
    await door.click();
    const panel = page.getByTestId('gacha-panel');
    await expect(panel).toBeVisible();
    const tickets = panel.getByTestId('gacha-tickets');
    const pull = panel.getByTestId('gacha-pull');
    await expect(tickets).toHaveAttribute('data-value', '0');
    await expect(pull).toHaveAttribute('aria-disabled', 'true');
    await expect(pull).toHaveClass(/\bis-locked\b/);
    await expect(panel.getByTestId('gacha-hint')).toContainText('Vault Crate');
    await expect(panel.getByTestId('gacha-sources')).toContainText('Vault Crates');
    await reviewShot(page, 'gacha-first-ticket-locked');
    await panel.getByTestId('gacha-close').click();
    await expect(panel).toBeHidden();

    expect(FTUE_DROP).toBeLessThan(TAPS_BEFORE_NEXT_CRATE);
    await playUntilFirstCrateReveal(page, TAPS_BEFORE_NEXT_CRATE);
    await releaseRevealTaps(page);
    const reveal = page.getByTestId('crate-reveal');
    const collect = page.getByTestId('crate-collect');
    await expect(collect, 'the unbox plays through to the card').toBeVisible({
      timeout: SOFTWARE_GPU_REVEAL_MS,
    });
    const ticketLine = reveal.locator('.cp-crate-line--currency', { hasText: 'Ticket' });
    await expect(ticketLine, 'the crate card shows the Ticket it pays').toHaveCount(1);
    await expect(ticketLine).toContainText(String(FIRST_TICKET.amount));
    expect(await serverTickets(page)).toBe(FIRST_TICKET.amount);
    await reviewShot(page, 'gacha-first-ticket-crate');
    await collect.click();
    await expect(reveal).toHaveCount(0, { timeout: 10_000 });
    expect((await probe(page)).counts.cratesSpawned, 'crate 1 was the only crate won').toBe(1);

    await expect(badge, 'the dock counts the Ticket the crate paid').toBeVisible();
    await expect(badge).toHaveText(String(FIRST_TICKET.amount));
    await door.click();
    await expect(panel).toBeVisible();
    await expect(tickets).toHaveAttribute('data-value', String(FIRST_TICKET.amount));
    await expect(pull).toHaveAttribute('aria-disabled', 'false');
    await expect(pull).not.toHaveClass(/\bis-locked\b/);
    await expect(panel.getByTestId('gacha-hint')).toBeEmpty();

    await pull.click();
    await expect.poll(async () => (await probe(page)).counts.gachaPulls).toBe(1);
    await expect.poll(() => ticketsSpentOnGacha(page)).toBe(1);
    const capsule = panel.getByTestId('gacha-reveal');
    await expect(capsule).toBeVisible({ timeout: FULL_TABLE_CAPSULE_MS });
    await expect(capsule).toHaveAttribute(
      'data-rarity',
      /^(common|fine|rare|exquisite|legendary|heirloom)$/,
    );
    await reviewShot(page, 'gacha-first-ticket-pull');
    await panel.getByTestId('gacha-collect').click();
    await expect.poll(async () => (await probe(page)).counts.gachaCollected).toBe(1);
    await expect(capsule).toBeHidden();

    const left = FIRST_TICKET.amount - 1;
    expect(await serverTickets(page)).toBe(left);
    await expect(tickets).toHaveAttribute('data-value', String(left));
    if (left === 0) {
      await expect(pull, 'the spent Ticket locks the machine again').toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
  });
});
