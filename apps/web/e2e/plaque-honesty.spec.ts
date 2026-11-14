import type { Page } from '@playwright/test';
import { upgradeCost, upgradeLines } from '@coinposh/economy';
import { isUpgradeLineV1 } from '../src/game/upgrades/lines.ts';
import { bootGame, expect, type Probe, refusedTotal, test } from './fixtures.ts';

/** P-536: the plaque figure the player saves up to before stopping to shop. */
const SAVE_UP_TO = 80;
const IDLE_MS = 30_000;
const TAP_EVERY_MS = 400;
const TAP_RESERVE_COINS = 4;
const REST_MS = 1_500;
const SAVE_UP_WITHIN_MS = 540_000;
const SETTLE_WITHIN_MS = 60_000;
const COLLECT_WITHIN_MS = 30_000;
const TAP_LANES = [0.5, 0.3, 0.7, 0.4, 0.6, 0.35, 0.65] as const;
const COIN_LINES = upgradeLines.filter((line) => line.scope === 'venue');

interface RowView {
  readonly id: string;
  readonly level: number;
  readonly lit: boolean;
  readonly disabled: boolean;
  readonly pending: boolean;
}

interface Shelf {
  readonly probe: Probe;
  readonly plaque: number;
  readonly inHand: number;
  readonly rows: readonly RowView[];
}

/** The plaque, every upgrade row and the counters, read in one page task so nothing lands between. */
async function readShelf(page: Page): Promise<Shelf> {
  const raw = await page.evaluate(() => {
    const live = window.__coinposh;
    if (!live) throw new Error('window.__coinposh is missing: the page is not the CoinPosh game');
    const spoken = document.querySelector('[data-testid=hud-balance] .cp-sr-only');
    const rows = [...document.querySelectorAll<HTMLElement>('.cp-upgrade[data-line]')].map(
      (row) => {
        const buy = row.querySelector('.cp-buy');
        return {
          id: row.dataset.line ?? '',
          levelText: row.querySelector('.cp-upgrade-level')?.textContent ?? '',
          lit: row.classList.contains('is-affordable'),
          disabled: buy?.getAttribute('aria-disabled') === 'true',
          pending: row.classList.contains('is-pending'),
        };
      },
    );
    return {
      probe: { sim: live.sim, playable: live.playable, counts: live.counts },
      plaqueText: spoken?.textContent ?? '',
      inHandText:
        document.querySelector('[data-testid=hud-in-hand] .cp-sr-only')?.textContent ?? '',
      rows,
    };
  });
  const digits = raw.plaqueText.replace(/\D/g, '');
  if (digits === '') throw new Error(`The Vault plaque announced no balance: "${raw.plaqueText}"`);
  return {
    probe: raw.probe,
    plaque: Number(digits),
    inHand: Number(raw.inHandText.replace(/\D/g, '')),
    rows: raw.rows.map((row) => {
      const level = /\d+/.exec(row.levelText)?.[0];
      if (level === undefined) throw new Error(`Row ${row.id} shows no level: "${row.levelText}"`);
      return {
        id: row.id,
        level: Number(level),
        lit: row.lit,
        disabled: row.disabled,
        pending: row.pending,
      };
    }),
  };
}

/** Every fall claim is answered, so no winnings are still awaiting the house. */
function settled(p: Probe): boolean {
  return p.counts.frontFalls === p.counts.credits + refusedTotal(p.counts);
}

function noCrateOut(p: Probe): boolean {
  return p.counts.cratesSpawned === p.counts.cratesCollected;
}

/** The coin rows whose next level costs no more than the plaque shows. */
function coveredRows(shelf: Shelf): { row: RowView; cost: number }[] {
  return COIN_LINES.flatMap((line) => {
    const row = shelf.rows.find((candidate) => candidate.id === line.id);
    if (!row) throw new Error(`The upgrades sheet has no row for ${line.id}`);
    if (row.level >= line.maxLevel) return [];
    const cost = upgradeCost(line, row.level);
    return cost <= shelf.plaque ? [{ row, cost }] : [];
  });
}

/**
 * Skips to the card and collects it, again for each crate that lands behind it. A press can meet
 * a card that is being swapped for the next one, so it is retried rather than awaited forever.
 */
async function collectAnyReveal(page: Page): Promise<void> {
  const reveal = page.getByTestId('crate-reveal');
  const collect = page.getByTestId('crate-collect');
  const deadline = Date.now() + COLLECT_WITHIN_MS;
  while ((await reveal.count()) > 0) {
    if (Date.now() > deadline) {
      throw new Error(`A crate card stayed up for ${String(COLLECT_WITHIN_MS)} ms of collecting`);
    }
    if (!(await collect.isVisible())) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      continue;
    }
    try {
      await collect.click({ timeout: 2_000 });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
    }
    await page.waitForTimeout(250);
  }
}

async function tapLane(page: Page, n: number): Promise<void> {
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
  const lane = TAP_LANES[n % TAP_LANES.length] ?? 0.5;
  await page.mouse.click(box.x + box.width * lane, box.y + box.height / 2);
}

/**
 * Taps across the rail until the plaque first reads `target`, collecting any crate. Once the
 * Vault and the hand run low it rests while resting pays, as full-loop.spec.ts does.
 */
async function saveUpTo(page: Page, target: number): Promise<void> {
  const deadline = Date.now() + SAVE_UP_WITHIN_MS;
  let taps = 0;
  let restPaid = true;
  for (;;) {
    await collectAnyReveal(page);
    const shelf = await readShelf(page);
    if (shelf.plaque >= target) return;
    if (Date.now() > deadline) {
      throw new Error(
        `The plaque never reached ${String(target)} within ${String(SAVE_UP_WITHIN_MS)} ms: ${String(shelf.plaque)}, ${JSON.stringify(shelf.probe.counts)}`,
      );
    }
    if (restPaid && shelf.plaque + shelf.inHand < TAP_RESERVE_COINS) {
      await page.waitForTimeout(REST_MS);
      restPaid = (await readShelf(page)).probe.counts.credits > shelf.probe.counts.credits;
      continue;
    }
    restPaid = true;
    await tapLane(page, taps);
    taps += 1;
    await page.waitForTimeout(TAP_EVERY_MS);
  }
}

/** Opens the upgrades sheet unless it is up, as after a crate card that covered it. */
async function openUpgrades(page: Page): Promise<void> {
  const sheet = page.getByTestId('sheet-upgrades');
  if (await sheet.isVisible()) return;
  await page.getByTestId('dock-upgrades').click();
  await expect(sheet).toBeVisible();
}

/** Waits, collecting any crate, for a shelf with every claim answered and no crate in play. */
async function settledShelf(page: Page): Promise<Shelf> {
  const deadline = Date.now() + SETTLE_WITHIN_MS;
  for (;;) {
    await collectAnyReveal(page);
    const shelf = await readShelf(page);
    if (settled(shelf.probe) && noCrateOut(shelf.probe) && shelf.rows.every((r) => !r.pending)) {
      return shelf;
    }
    if (Date.now() > deadline) {
      throw new Error(`The table never settled: ${JSON.stringify(shelf.probe.counts)}`);
    }
    await page.waitForTimeout(250);
  }
}

function expectCoveredRowsLit(shelf: Shelf, when: string): { row: RowView; cost: number }[] {
  const covered = coveredRows(shelf);
  for (const { row, cost } of covered) {
    const where = `${when}: ${row.id} Lv ${String(row.level)} costs ${String(cost)} and the plaque shows ${String(shelf.plaque)}`;
    expect(row.lit, `${where}, so the row is lit`).toBe(true);
    expect(row.disabled, `${where}, so its buy button is not locked`).toBe(false);
  }
  return covered;
}

test.describe('plaque honesty (P-536)', () => {
  test('every coin upgrade the plaque covers is lit and buys', async ({ page }) => {
    test.setTimeout(SAVE_UP_WITHIN_MS + 240_000);
    await bootGame(page);
    await test.step(`save up until the plaque first reads ${String(SAVE_UP_TO)}`, async () => {
      await saveUpTo(page, SAVE_UP_TO);
    });
    await page.waitForTimeout(IDLE_MS);
    await settledShelf(page);

    const sheet = page.getByTestId('sheet-upgrades');
    await openUpgrades(page);
    await expect(
      page.getByTestId('hud-in-hand'),
      'the drop buffer shows apart from the plaque',
    ).toBeVisible();

    let shelf = await settledShelf(page);
    let covered = expectCoveredRowsLit(shelf, 'after saving up and idling');
    expect(
      covered.length,
      `the plaque at ${String(shelf.plaque)} covers a coin upgrade`,
    ).toBeGreaterThan(0);

    // TODO(upgrades owner): the sheet lights lines the client refuses as not offered yet
    // (fusionWindow, decorumCapacity); only the v1 lines it can buy are bought here.
    const offered = (rows: typeof covered): typeof covered =>
      rows.filter((entry) => isUpgradeLineV1(entry.row.id));
    const bought = new Set<string>();
    while (offered(covered).length > 0) {
      const target = offered(covered).reduce((best, entry) =>
        entry.cost > best.cost ? entry : best,
      );
      const before = shelf;
      await openUpgrades(page);
      await sheet.getByTestId(`upgrade-buy-${target.row.id}`).click();
      await expect(
        sheet.locator(`.cp-upgrade[data-line="${target.row.id}"] .cp-upgrade-level`),
        `${target.row.id} buys at ${String(target.cost)} with the plaque at ${String(before.plaque)}`,
      ).toHaveText(new RegExp(`\\b${String(target.row.level + 1)}\\b`), { timeout: 15_000 });
      shelf = await settledShelf(page);
      if (shelf.probe.counts.cratesCollected === before.probe.counts.cratesCollected) {
        const credited = shelf.probe.counts.creditedCoins - before.probe.counts.creditedCoins;
        expect(
          shelf.plaque + shelf.inHand,
          `the plaque pays ${String(target.cost)} for ${target.row.id}, refills into the hand aside`,
        ).toBe(before.plaque + before.inHand - target.cost + credited);
      }
      bought.add(target.row.id);
      covered = expectCoveredRowsLit(shelf, `after buying ${target.row.id}`);
    }
    expect(bought.size).toBeGreaterThan(0);
  });
});
