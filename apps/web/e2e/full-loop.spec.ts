import type { Locator, Page } from '@playwright/test';
import { dropBufferTarget, economyConfig, upgradeCost, upgradeLines } from '@coinposh/economy';
import { MOCK_RULES } from '../src/net/mock/rules.ts';
import { bootGame, expect, probe, type Probe, refusedTotal, reviewShot, test } from './fixtures.ts';

const SETTINGS_KEY = 'coinposh.settings.v1';
const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
/** The most drops the opening credit check may take: the 20-coin starting Vault covers them. */
const MAX_OPENING_DROPS = 15;
/** A thumb's pace: fast enough to push the heap to the lip, slow enough to keep the queue short. */
const TAP_EVERY_MS = 400;
/**
 * Below this the player stops dropping and lets the pusher work the heap, as a thumb would
 * rather than tapping a dry Vault, for as long as the pause keeps paying. Demo Mode pays no
 * Steward's allowance yet (P-216).
 */
const TAP_RESERVE_COINS = 4;
/** How long the pusher gets to pay out before a player with a low Vault looks again. */
const REST_MS = 1_500;
/**
 * The longest a run may take to afford the first upgrade. The 2-minute firstUpgrade pacing
 * target is a 90th percentile the balancing sim checks over many sessions; one real-time run
 * on a loaded SwiftShader runner is a single draw, so it gets twice that.
 */
const AFFORD_WITHIN_MS = 240_000;
/** The longest the pusher may take to shove the scripted crate over the lip. */
const CRATE_OPENS_WITHIN_MS = 90_000;
/** The unskipped cinematic runs on frame time, which SwiftShader stretches several-fold. */
const CINEMATIC_WITHIN_MS = 30_000;
/** Card fly (520 ms in revealCard.ts) plus the cinematic's wrap-up and a frame or two of slack. */
const COLLECT_SETTLES_MS = 3_000;

const CHEAPEST_COIN_LINE = upgradeLines
  .filter((line) => line.currency === 'coins')
  .reduce((best, line) => (upgradeCost(line, 0) < upgradeCost(best, 0) ? line : best));

/**
 * The Vault plaque and the upgrade rows count the pre-minted drop buffer, which the server
 * cannot spend (#94), so a BUY lit at the bare price can be refused as insufficient funds.
 * Until #94 ships, the run buys once the Vault covers the price with a full copper buffer
 * on top, so the wallet alone pays it. Drop this margin when #94 is fixed.
 */
const SPENDABLE_FIRST_BUY =
  upgradeCost(CHEAPEST_COIN_LINE, 0) +
  dropBufferTarget(MOCK_RULES.bufferSize, {}) * economyConfig.coinTiers[0].value;

/**
 * Where successive taps lift, as fractions of the stage width. A player sweeps the rail rather
 * than stacking every coin on one spot, where contact fusion folds the heap into a few coins
 * too light to push anything over the lip.
 */
const TAP_LANES = [0.5, 0.3, 0.7, 0.4, 0.6, 0.35, 0.65] as const;
let tapCount = 0;

async function tapAcross(page: Page): Promise<void> {
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
  const lane = TAP_LANES[tapCount % TAP_LANES.length] ?? 0.5;
  tapCount += 1;
  await page.mouse.click(box.x + box.width * lane, box.y + box.height / 2);
}

declare global {
  interface Window {
    __fullLoopTapGuard?: boolean;
  }
}

interface Snapshot {
  readonly probe: Probe;
  readonly vault: number;
}

/** Counters and the Vault read in one page task, so no credit can land between the two. */
async function snapshot(page: Page): Promise<Snapshot> {
  const { p, vaultText } = await page.evaluate(() => {
    const live = window.__coinposh;
    if (!live) throw new Error('window.__coinposh is missing: the page is not the CoinPosh game');
    return {
      p: { sim: live.sim, playable: live.playable, counts: live.counts },
      vaultText: document.querySelector('[data-testid=hud-balance] .cp-sr-only')?.textContent ?? '',
    };
  });
  const digits = vaultText.replace(/\D/g, '');
  if (digits === '') throw new Error(`The Vault plaque announced no balance: "${vaultText}"`);
  return { probe: p, vault: Number(digits) };
}

function settled(p: Probe): boolean {
  return p.counts.frontFalls === p.counts.credits + refusedTotal(p.counts);
}

/**
 * Waits for a moment where every fall claim is answered and the Vault shows exactly `start`
 * less `spent` plus what the ledge paid since: nothing lost, doubled or credited twice.
 */
async function expectVaultBalanced(
  page: Page,
  start: Snapshot,
  spent: number,
  message: string,
): Promise<Snapshot> {
  let last = start;
  await expect
    .poll(
      async () => {
        last = await snapshot(page);
        const credited = last.probe.counts.creditedCoins - start.probe.counts.creditedCoins;
        return settled(last.probe) && last.vault === start.vault - spent + credited;
      },
      { message, timeout: 30_000, intervals: [100] },
    )
    .toBe(true);
  return last;
}

/**
 * Any tap on an open crate veil is a skip, and this run watches every cinematic through, so
 * while the guard is up a capture listener swallows pointer input that reaches an open reveal,
 * including a drop tap already on its way when the reveal mounts.
 */
async function setRevealGuard(page: Page, up: boolean): Promise<void> {
  await page.evaluate((on) => {
    if (window.__fullLoopTapGuard === undefined) {
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
        addEventListener(
          type,
          (event) => {
            if (!window.__fullLoopTapGuard) return;
            if (!document.querySelector('[data-testid="crate-reveal"]')) return;
            event.stopImmediatePropagation();
            event.preventDefault();
          },
          { capture: true },
        );
      }
    }
    window.__fullLoopTapGuard = on;
  }, up);
}

/**
 * Watches an open reveal play out unskipped, checks its card and seal, then taps COLLECT and
 * waits for the card to leave. Returns the card's rarity.
 */
async function watchAndCollect(page: Page, reveal: Locator, shot: string | null): Promise<string> {
  const before = (await probe(page)).counts.cratesCollected;
  await expect(reveal).toHaveAttribute('role', 'dialog');
  await expect(reveal).toHaveAttribute('data-motion', 'full');
  await expect(reveal, 'the cinematic plays through to the card unskipped').toHaveClass(
    /is-revealed/,
    { timeout: CINEMATIC_WITHIN_MS },
  );
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible();
  await expect(reveal.locator('.cp-crate-line').first()).toBeVisible();
  await expect(reveal.getByTestId('crate-fair')).toHaveAttribute('title', /^[0-9a-f]{64}$/);
  const rarity = (await reveal.getAttribute('data-rarity')) ?? '';
  expect(rarity, 'the card names its rarity').not.toBe('');
  if (shot !== null) await reviewShot(page, shot);

  const collected = await reveal.elementHandle();
  await setRevealGuard(page, false);
  await collect.click();
  await expect
    .poll(() => collected.evaluate((el) => el.isConnected), {
      message: 'the collected crate reveal leaves the page',
      timeout: COLLECT_SETTLES_MS,
    })
    .toBe(false);
  await collected.dispose();
  await setRevealGuard(page, true);
  expect((await probe(page)).counts.cratesCollected).toBe(before + 1);
  return rarity;
}

function vaultLow(s: Snapshot): boolean {
  return s.vault < TAP_RESERVE_COINS;
}

/**
 * Taps at a thumb's pace until `done` holds, resting whenever `rest` says so (by default while
 * the Vault runs low) and collecting any crate the heap pushes over the lip on the way, as a
 * player would. Throws `failure()` once `deadline` (epoch ms) passes.
 */
async function playUntil(
  page: Page,
  reveal: Locator,
  done: () => Promise<boolean>,
  deadline: number,
  failure: () => Promise<string>,
  rest: (s: Snapshot) => boolean = vaultLow,
): Promise<void> {
  let restPaid = true;
  for (;;) {
    if (await done()) return;
    if ((await reveal.count()) > 0) {
      await watchAndCollect(page, reveal, null);
      continue;
    }
    if (Date.now() > deadline) throw new Error(await failure());
    const now = await snapshot(page);
    if (restPaid && rest(now)) {
      await page.waitForTimeout(REST_MS);
      restPaid = (await snapshot(page)).probe.counts.credits > now.probe.counts.credits;
      continue;
    }
    restPaid = true;
    await tapAcross(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }
}

async function openSheet(page: Page, id: 'upgrades' | 'settings'): Promise<Locator> {
  await page.getByTestId(`dock-${id}`).click();
  const sheet = page.getByTestId(`sheet-${id}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeSheet(page: Page, sheet: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

async function savedSettings(page: Page): Promise<unknown> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

test.describe('full loop in Demo Mode at 390x844 (T-1.18)', () => {
  test('boot, drop, credit, fuse, unbox a crate, buy an upgrade, and keep a setting across a reload', async ({
    page,
  }) => {
    test.setTimeout(480_000);
    const reveal = page.getByTestId('crate-reveal');

    await test.step('boot into Demo Mode', async () => {
      await bootGame(page);
      await expect(page.getByTestId('hud-balance')).toBeVisible();
      await expect(page.getByTestId('hud-dock')).toBeVisible();
      await setRevealGuard(page, true);
      await reviewShot(page, 'full-loop-01-boot');
    });

    await test.step('taps drop coins, and a coin over the lip credits the Vault', async () => {
      const start = await snapshot(page);
      expect(start.vault).toBeGreaterThanOrEqual(MAX_OPENING_DROPS);
      let drops = 0;
      const credited = async (): Promise<boolean> =>
        (await probe(page)).counts.credits > start.probe.counts.credits;
      while (drops < MAX_OPENING_DROPS && !(await credited())) {
        await tapAcross(page);
        drops += 1;
        await page.waitForTimeout(TAP_EVERY_MS);
      }
      await expect
        .poll(credited, {
          message: `a coin falls off the front lip within ${String(drops)} drops and is credited`,
          timeout: 45_000,
        })
        .toBe(true);
      const end = await expectVaultBalanced(
        page,
        start,
        drops,
        `Vault = start - ${String(drops)} drops + credited coins, every claim answered`,
      );
      expect(end.probe.counts.creditedCoins).toBeGreaterThan(start.probe.counts.creditedCoins);
      await reviewShot(page, 'full-loop-02-credited');
    });

    await test.step('play on until coins fuse and the scripted crate spawns', async () => {
      const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
      for (;;) {
        const { counts } = await probe(page);
        if ((counts.fusions >= 1 && counts.cratesSpawned >= 1) || (await reveal.count()) > 0) break;
        if (Date.now() > deadline) {
          throw new Error(
            `No fusion and crate within ${String(CRATE_OPENS_WITHIN_MS)} ms: ${JSON.stringify(counts)}`,
          );
        }
        await tapAcross(page);
        await page.waitForTimeout(TAP_EVERY_MS);
      }
      const { counts } = await probe(page);
      expect(counts.fusions, 'a fusion merged coins on the table').toBeGreaterThanOrEqual(1);
      expect(counts.cratesSpawned, `the FTUE crate spawns by drop ${String(FTUE_DROP)}`).toBe(1);
    });

    await test.step('the crate falls, its unbox cinematic plays out, and COLLECT banks it', async () => {
      const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
      while ((await reveal.count()) === 0) {
        if (Date.now() > deadline) {
          const { counts } = await probe(page);
          throw new Error(
            `No crate reveal within ${String(CRATE_OPENS_WITHIN_MS)} ms of play: ${JSON.stringify(counts)}`,
          );
        }
        await tapAcross(page);
        await page.waitForTimeout(TAP_EVERY_MS);
      }
      expect((await probe(page)).counts.cratesOpened).toBe(1);
      await watchAndCollect(page, reveal, 'full-loop-03-unbox-card');
    });

    await test.step('play on until the Vault affords an upgrade, then buy it', async () => {
      const badge = page.getByTestId('dock-upgrades-badge');
      // Drops alone spawn crates, so once the table holds none and the taps stop, no crate
      // reveal can cover the sheet or pay out mid-purchase and skew the Vault check. A player
      // saving up stops tapping once the price is in hand and lets the pusher clear the table.
      await playUntil(
        page,
        reveal,
        async () => {
          const { vault, probe: p } = await snapshot(page);
          return (
            vault >= SPENDABLE_FIRST_BUY && p.counts.cratesSpawned === p.counts.cratesCollected
          );
        },
        Date.now() + AFFORD_WITHIN_MS,
        async () => {
          const { vault, probe: p } = await snapshot(page);
          return `No crate-free table with ${String(SPENDABLE_FIRST_BUY)} in the Vault within ${String(AFFORD_WITHIN_MS)} ms of play: Vault ${String(vault)}, ${JSON.stringify(p.counts)}`;
        },
        (s) => vaultLow(s) || s.vault >= SPENDABLE_FIRST_BUY,
      );
      await expect(badge).toBeVisible();
      await reviewShot(page, 'full-loop-04-upgrade-ready');

      const sheet = await openSheet(page, 'upgrades');
      await expect(sheet.getByTestId('upgrades-global')).toHaveCount(0);
      const lineId = CHEAPEST_COIN_LINE.id;
      const bought = sheet.locator(`.cp-upgrade[data-line="${lineId}"]`);
      await expect(bought, 'the cheapest coin line is lit').toHaveClass(/is-affordable/);
      await expect(bought.locator('.cp-upgrade-level')).toHaveText('Lv 0');
      const cost = upgradeCost(CHEAPEST_COIN_LINE, 0);
      const before = await snapshot(page);
      expect(before.vault, `the Vault covers ${lineId} at ${String(cost)}`).toBeGreaterThanOrEqual(
        cost,
      );

      await bought.getByTestId(`upgrade-buy-${lineId}`).click();
      await expect(bought, 'the server-confirmed level celebrates its row').toHaveClass(
        /is-celebrating/,
      );
      await expect(bought.locator('.cp-upgrade-level')).toHaveText('Lv 1');
      await expectVaultBalanced(
        page,
        before,
        cost,
        `Vault = before - ${String(cost)} for ${lineId} Lv 1 + credited coins`,
      );
      await reviewShot(page, 'full-loop-05-upgrade-bought');
      await closeSheet(page, sheet);
    });

    await test.step('a settings toggle persists across a reload', async () => {
      let sheet = await openSheet(page, 'settings');
      const mono = sheet.getByTestId('settings-mono');
      await expect(mono).toHaveAttribute('aria-checked', 'false');
      await mono.click();
      await expect(mono).toHaveAttribute('aria-checked', 'true');
      await expect
        .poll(() => savedSettings(page), { message: 'the debounced save lands' })
        .toMatchObject({ mono: true });
      await closeSheet(page, sheet);

      await page.reload();
      await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
        timeout: 60_000,
        polling: 16,
      });
      await expect(page.locator('#coinposh-demo-banner')).toBeVisible();
      sheet = await openSheet(page, 'settings');
      await expect(sheet.getByTestId('settings-mono')).toHaveAttribute('aria-checked', 'true');
      await reviewShot(page, 'full-loop-06-settings-after-reload');
      await closeSheet(page, sheet);

      sheet = await openSheet(page, 'upgrades');
      await expect(
        sheet.locator(`.cp-upgrade[data-line="${CHEAPEST_COIN_LINE.id}"] .cp-upgrade-level`),
        'the bought level survives a same-tab reload of Demo Mode (P-449)',
      ).toHaveText('Lv 1');
    });
  });
});
