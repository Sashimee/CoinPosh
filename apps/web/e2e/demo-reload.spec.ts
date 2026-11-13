import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import {
  bootGame,
  expect,
  prepareGamePage,
  probe,
  tapDrop,
  test,
  unexpectedErrors,
  vaultBalance,
} from './fixtures.ts';

/** The sessionStorage key apps/web/src/net/mock/persist.ts keeps the Demo world under. */
const DEMO_STORAGE_KEY = 'coinposh.demo.world';
const TAPS = 30;
const TAP_EVERY_MS = 400;
/** Coins still settling when the reload hits may slide off or fall either way. */
const COIN_TOLERANCE = 2;
/** The pusher keeps working the restored table, so a few coins on the lip fall while it boots. */
const FALLS_WHILE_BOOTING = 5;

interface StoredCrate {
  readonly crate: { readonly id: string };
  readonly state: string;
}

interface StoredCoin {
  readonly coin: { readonly id: string; readonly value: number };
  readonly place: string;
  readonly heapSlot: number | null;
  readonly paid: number;
}

interface StoredPlayer {
  readonly coins: readonly StoredCoin[];
  readonly crates: readonly StoredCrate[];
  readonly openedCrates: readonly string[];
  readonly tableSnapshot: {
    readonly seq: number;
    readonly poses: readonly (readonly unknown[])[];
  } | null;
}

interface StoredEntry {
  readonly seq: number;
  readonly reason: string;
  readonly delta: { readonly coins?: number };
  readonly ref: string | null;
}

interface StoredWorld {
  readonly nextSeq: number;
  readonly ledger: readonly StoredEntry[];
  readonly players: readonly StoredPlayer[];
}

async function storedWorld(page: Page): Promise<StoredWorld | null> {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), DEMO_STORAGE_KEY);
  if (raw === null) return null;
  return (JSON.parse(raw) as { world: StoredWorld }).world;
}

async function storedPlayer(page: Page): Promise<StoredPlayer | undefined> {
  return (await storedWorld(page))?.players[0];
}

/** What the Vault moved by since `fromSeq`; a prepaid drop only moves coins into the buffer. */
function vaultMoves(world: StoredWorld | null, fromSeq: number): StoredEntry[] {
  return (world?.ledger ?? []).filter(
    (entry) => entry.seq >= fromSeq && entry.reason !== 'drop.prepay',
  );
}

async function tableCoins(page: Page): Promise<number> {
  const { sim } = await probe(page);
  if (!sim) throw new Error('The sim reported no stats, so there is no coin count to read');
  return sim.coins;
}

/** Table coins the stored snapshot does not pose and the opening heap does not hold a slot for. */
function unposed(player: StoredPlayer): StoredCoin[] {
  const posed = new Set(player.tableSnapshot?.poses.map((pose) => pose[0]));
  return player.coins.filter(
    (record) => record.place === 'table' && record.heapSlot === null && !posed.has(record.coin.id),
  );
}

/**
 * Waits until any crate the taps won has been revealed and collected, and two snapshots of the
 * resting table have reached the tab's storage since the last tap.
 */
async function settle(page: Page): Promise<StoredPlayer> {
  const reveal = page.getByTestId('crate-reveal');
  const fromSeq = (await storedPlayer(page))?.tableSnapshot?.seq ?? 0;
  let player: StoredPlayer | undefined;
  await expect
    .poll(
      async () => {
        if ((await reveal.count()) > 0) {
          await page.keyboard.press('Escape');
          return false;
        }
        player = await storedPlayer(page);
        return (
          player !== undefined &&
          (player.tableSnapshot?.seq ?? 0) >= fromSeq + 2 &&
          player.crates.every((record) => record.state !== 'openable')
        );
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(true);
  if (player === undefined) throw new Error('The Demo world never reached the tab storage.');
  return player;
}

test('a reload in the same tab keeps the Vault and the table; a new tab starts fresh', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await bootGame(page);
  const freshVault = await vaultBalance(page);
  const freshCoins = await tableCoins(page);

  for (let i = 0; i < TAPS; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }
  const stored = await settle(page);
  const fromSeq = (await storedWorld(page))?.nextSeq ?? 0;
  const vault = await vaultBalance(page);
  const coins = await tableCoins(page);
  expect(vault).not.toBe(freshVault);
  const unposedCoins = unposed(stored);
  const refundCap = new Map(
    unposedCoins.map((record) => [record.coin.id, Math.min(record.paid, record.coin.value)]),
  );

  await page.reload();
  await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
    timeout: 60_000,
    polling: 16,
  });
  await expect(page.locator('#coinposh-demo-banner')).toBeVisible();
  // The Vault comes back as it was, moved only by what the boot rules and the restored table
  // do: a coin no snapshot posed (the client leaves some fused coins out of its snapshots) is
  // refunded at most what it cost, and coins on the lip fall as play resumes.
  let moves: StoredEntry[] = [];
  await expect
    .poll(async () => {
      moves = vaultMoves(await storedWorld(page), fromSeq);
      const moved = moves.reduce((sum, entry) => sum + (entry.delta.coins ?? 0), 0);
      return (await vaultBalance(page)) - moved;
    })
    .toBe(vault);
  const refunds = moves.filter((entry) => entry.reason === 'refund.table');
  const falls = moves.filter((entry) => entry.reason === 'claim.fall');
  expect(moves.length).toBe(refunds.length + falls.length);
  expect(refunds.length).toBeLessThanOrEqual(unposedCoins.length);
  expect(new Set(refunds.map((entry) => entry.ref)).size).toBe(refunds.length);
  for (const entry of refunds) {
    expect(refundCap.has(entry.ref ?? ''), `refund of ${String(entry.ref)}`).toBe(true);
    expect(entry.delta.coins).toBeLessThanOrEqual(refundCap.get(entry.ref ?? '') ?? 0);
  }
  expect(falls.length).toBeLessThanOrEqual(FALLS_WHILE_BOOTING);
  testInfo.annotations.push({
    type: 'vault moves after the reload',
    description: `${String(refunds.length)} of ${String(unposedCoins.length)} unposed coins refunded, ${String(falls.length)} falls`,
  });
  expect(
    Math.abs((await tableCoins(page)) - (coins - refunds.length - falls.length)),
  ).toBeLessThanOrEqual(COIN_TOLERANCE);

  const context = await browser.newContext({ viewport: page.viewportSize() });
  try {
    const other = await context.newPage();
    const errors = await prepareGamePage(other);
    await bootGame(other);
    expect(await vaultBalance(other)).toBe(freshVault);
    expect(await tableCoins(other)).toBe(freshCoins);
    expect(unexpectedErrors(errors, testInfo), 'the fresh tab logged errors').toEqual([]);
  } finally {
    await context.close();
  }
});

test('a crate won before the reload but never opened opens once after it', async ({ page }) => {
  // On the first load only, the signature for the open never resolves, as if the tab was
  // reloaded between the claim landing and the open going out.
  await page.addInitScript(() => {
    const marker = 'e2e.demo-reload.hung-open';
    if (sessionStorage.getItem(marker) !== null) return;
    sessionStorage.setItem(marker, '1');
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    const decoder = new TextDecoder();
    crypto.subtle.sign = (algorithm, key, data) => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      if (decoder.decode(bytes).includes('\n/v1/crates/open\n')) {
        return new Promise<ArrayBuffer>(() => undefined);
      }
      return sign(algorithm, key, data);
    };
  });
  await bootGame(page);

  const deadline = Date.now() + 90_000;
  let won: StoredCrate | undefined;
  for (let i = 0; won === undefined; i += 1) {
    if (Date.now() > deadline) throw new Error('The scripted crate was never won over the lip.');
    if (i < economyConfig.crateSpawn.ftueScriptedDrop + 40) await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
    won = (await storedPlayer(page))?.crates.find((record) => record.state === 'openable');
  }
  expect((await probe(page)).counts.cratesOpened).toBe(0);

  await page.reload();
  await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
    timeout: 60_000,
    polling: 16,
  });
  await page.getByTestId('crate-reveal').waitFor({ state: 'attached', timeout: 45_000 });
  await expect.poll(async () => (await probe(page)).counts.cratesOpened).toBe(1);

  const crateId = won.crate.id;
  await expect
    .poll(async () => (await storedPlayer(page))?.openedCrates.includes(crateId))
    .toBe(true);
  const after = await storedPlayer(page);
  expect(after?.crates.some((record) => record.crate.id === crateId)).toBe(false);
  await page.waitForTimeout(3_000);
  expect((await probe(page)).counts.cratesOpened).toBe(1);
});
