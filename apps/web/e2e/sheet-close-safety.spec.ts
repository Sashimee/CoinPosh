import type { Locator, Page } from '@playwright/test';
import { upgradeCost, upgradeLines } from '@coinposh/economy';
import { bootGame, DEMO_SEED, expect, probe, refusedTotal, test } from './fixtures.ts';

/** The sessionStorage key apps/web/src/net/mock/persist.ts keeps the Demo world under. */
const DEMO_STORAGE_KEY = 'coinposh.demo.world';
/** Set before a reload so the next document funds the restored Demo wallet once. */
const GRANT_KEY = 'e2e.sheet-close-safety.grant';
/** P-535: the window in which a key or tap must not reach a closing sheet. */
const WITHIN_MS = 100;
/** Longer than the slowest close seen under load (1.5 s), so a late purchase would have landed. */
const CLOSE_SETTLES_MS = 2_500;

const LINE = upgradeLines
  .filter((line) => line.currency === 'coins')
  .reduce((best, line) => (upgradeCost(line, 0) < upgradeCost(best, 0) ? line : best));
const FIRST_COST = upgradeCost(LINE, 0);
const SECOND_COST = upgradeCost(LINE, 1);
/** Enough for Lv 1 and then Lv 2 twice over, so every stray press below could buy a level. */
const GRANT = FIRST_COST + SECOND_COST * 3;

interface Snapshot {
  readonly vault: number;
  readonly credited: number;
  readonly settled: boolean;
}

declare global {
  interface Window {
    __sheetCloseLog?: { type: string; at: number; focus: string; target: string }[];
  }
}

/**
 * Demo Mode starts every tab on 20 coins. Rather than grinding the table for two upgrades, the
 * next document adds GRANT to the stored wallet with a matching ledger entry, so the world still
 * adds up when the mock server restores it.
 */
async function fundNextDocument(page: Page): Promise<void> {
  await page.addInitScript(
    ([storageKey, grantKey, grant]) => {
      if (sessionStorage.getItem(grantKey) === null) return;
      sessionStorage.removeItem(grantKey);
      const raw = sessionStorage.getItem(storageKey);
      if (raw === null) throw new Error('No Demo world was saved before the funding reload');
      const blob = JSON.parse(raw) as {
        world: {
          nextSeq: number;
          ledger: {
            seq: number;
            at: number;
            playerId: string;
            reason: string;
            delta: { coins: number };
            ref: string | null;
          }[];
          players: { id: string; wallet: { coins: number } }[];
        };
      };
      const { world } = blob;
      const [player] = world.players;
      if (!player || world.players.length !== 1) throw new Error('Expected one Demo player');
      player.wallet.coins += grant;
      world.ledger.push({
        seq: world.nextSeq,
        at: Date.now(),
        playerId: player.id,
        reason: 'e2e.grant',
        delta: { coins: grant },
        ref: null,
      });
      world.nextSeq += 1;
      sessionStorage.setItem(storageKey, JSON.stringify(blob));
    },
    [DEMO_STORAGE_KEY, GRANT_KEY, GRANT] as const,
  );
}

/** Records when Escape, Enter and taps reach the page, and what held focus or took the tap. */
async function logInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__sheetCloseLog) {
      window.__sheetCloseLog.length = 0;
      return;
    }
    window.__sheetCloseLog = [];
    const label = (node: EventTarget | Element | null): string => {
      if (!(node instanceof Element)) return 'none';
      return node.closest('[data-testid]')?.getAttribute('data-testid') ?? node.tagName;
    };
    const record = (type: string, event: Event): void => {
      window.__sheetCloseLog?.push({
        type,
        at: event.timeStamp,
        focus: label(document.activeElement),
        target: label(event.target),
      });
    };
    addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' || event.key === 'Enter') record(event.key, event);
      },
      { capture: true },
    );
    addEventListener(
      'pointerdown',
      (event) => {
        record('pointerdown', event);
      },
      { capture: true },
    );
  });
}

async function takeLog(page: Page): Promise<NonNullable<Window['__sheetCloseLog']>> {
  return page.evaluate(() => window.__sheetCloseLog?.splice(0) ?? []);
}

/** The Vault, the coins credited so far and whether every fall claim is answered. */
async function snapshot(page: Page): Promise<Snapshot> {
  const text = await page.locator('[data-testid=hud-balance] .cp-sr-only').textContent();
  const p = await probe(page);
  return {
    vault: Number(text?.replace(/\D/g, '') ?? 'NaN'),
    credited: p.counts.creditedCoins,
    settled: p.counts.frontFalls === p.counts.credits + refusedTotal(p.counts),
  };
}

/** The Vault moved only by what the ledge paid since `start`: nothing was spent. */
async function expectNothingSpent(page: Page, start: Snapshot, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await snapshot(page);
        return now.settled && now.vault === start.vault + (now.credited - start.credited);
      },
      { message, timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
}

async function level(row: Locator): Promise<string | null> {
  return row.locator('.cp-upgrade-level').textContent();
}

test.describe(`a closing sheet takes no input, seeded Demo ${String(DEMO_SEED)} at 390x844 (P-535)`, () => {
  test('Escape then Enter, or a tap on the shrinking sheet, within 100 ms buys nothing', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const sheet = page.getByTestId('sheet-upgrades');
    const row = sheet.locator(`.cp-upgrade[data-line="${LINE.id}"]`);
    const buy = row.getByTestId(`upgrade-buy-${LINE.id}`);
    const trigger = page.getByTestId('dock-upgrades');

    await test.step('boot Demo Mode and fund the wallet for two levels', async () => {
      await fundNextDocument(page);
      await bootGame(page);
      await expect
        .poll(() => page.evaluate((key) => sessionStorage.getItem(key) !== null, DEMO_STORAGE_KEY))
        .toBe(true);
      await page.evaluate((key) => {
        sessionStorage.setItem(key, '1');
      }, GRANT_KEY);
      await page.reload();
      await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
        timeout: 60_000,
        polling: 16,
      });
      await expect
        .poll(async () => (await snapshot(page)).vault, { message: 'the grant reaches the Vault' })
        .toBeGreaterThanOrEqual(GRANT);
    });

    await test.step(`buy ${LINE.id} Lv 1, leaving Lv 2 affordable`, async () => {
      await trigger.click();
      await expect(sheet).toBeVisible();
      await expect(row).toHaveClass(/is-affordable/);
      await buy.click();
      await expect(row.locator('.cp-upgrade-level')).toHaveText('Lv 1');
      await expect(row).not.toHaveClass(/is-pending/);
      await expect(row, 'Lv 2 is in reach, so a stray press would buy it').toHaveClass(
        /is-affordable/,
      );
      await expect(buy).toBeFocused();
    });

    await test.step('Escape then Enter within 100 ms changes no level and no Vault', async () => {
      await logInput(page);
      const start = await snapshot(page);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      const [escape, enter] = await takeLog(page);
      expect(escape?.type).toBe('Escape');
      expect(enter?.type).toBe('Enter');
      expect((enter?.at ?? Infinity) - (escape?.at ?? 0), 'Enter follows Escape fast').toBeLessThan(
        WITHIN_MS,
      );
      expect
        .soft(enter?.focus, 'focus is back on the dock button before Enter lands')
        .toBe('dock-upgrades');

      await page.waitForTimeout(CLOSE_SETTLES_MS);
      expect(await level(row)).toBe('Lv 1');
      await expectNothingSpent(page, start, 'Escape + Enter spent nothing from the Vault');
    });

    await test.step('Enter on the returned focus reopened the sheet mid-close, and it stays open (P-257)', async () => {
      await expect(sheet).toBeVisible();
      await expect(page.locator('.cp-sheet-layer.is-open')).toHaveCount(1);
      await expect(buy).toBeVisible();
    });

    await test.step('a tap on the shrinking sheet within 100 ms buys nothing', async () => {
      const box = await buy.boundingBox();
      if (!box) throw new Error(`upgrade-buy-${LINE.id} has no layout box to tap`);
      await logInput(page);
      const start = await snapshot(page);
      await page.keyboard.press('Escape');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const [escape, tap] = await takeLog(page);
      expect(escape?.type).toBe('Escape');
      expect(tap?.type).toBe('pointerdown');
      expect((tap?.at ?? Infinity) - (escape?.at ?? 0), 'the tap follows Escape fast').toBeLessThan(
        WITHIN_MS,
      );
      expect
        .soft(tap?.target, 'the tap lands on the shrinking sheet, not the table')
        .toBe('sheet-upgrades');

      await expect(sheet, 'the sheet finishes closing').toBeHidden({ timeout: 30_000 });
      await expect(trigger).toBeFocused();
      expect(await level(row)).toBe('Lv 1');
      await expectNothingSpent(page, start, 'a tap on the closing sheet spent nothing');
    });
  });
});
