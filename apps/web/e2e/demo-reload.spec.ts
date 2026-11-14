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
  readonly wallet: { readonly coins: number };
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

/** Where each new document copies the world the previous page left, before the app reads it. */
const LEFT_BEHIND_KEY = 'e2e.demo-reload.left-behind';

async function storedWorld(page: Page, key = DEMO_STORAGE_KEY): Promise<StoredWorld | null> {
  const raw = await page.evaluate((k) => sessionStorage.getItem(k), key);
  if (raw === null) return null;
  return (JSON.parse(raw) as { world: StoredWorld }).world;
}

/**
 * The old page keeps playing until its pagehide writes the world, so what the reload restores
 * is only known in the new document: this copies it aside before any app script runs.
 */
async function keepWorldLeftBehind(page: Page): Promise<void> {
  await page.addInitScript(
    ([from, to]) => {
      const left = sessionStorage.getItem(from);
      if (left === null) sessionStorage.removeItem(to);
      else sessionStorage.setItem(to, left);
    },
    [DEMO_STORAGE_KEY, LEFT_BEHIND_KEY] as const,
  );
}

async function storedPlayer(page: Page): Promise<StoredPlayer | undefined> {
  return (await storedWorld(page))?.players[0];
}

/**
 * What the plaque shows for a stored player: the spendable wallet. The prepaid drop buffer is
 * the separate in-hand readout.
 */
function storedVault(player: StoredPlayer): number {
  return player.wallet.coins;
}

/** What the Vault moved by since `fromSeq`; a refill prepay debits the wallet, so it counts. */
function vaultMoves(world: StoredWorld | null, fromSeq: number): StoredEntry[] {
  return (world?.ledger ?? []).filter((entry) => entry.seq >= fromSeq);
}

/** A fall the server credited, once it has reached the tab's storage. */
function fallCredit(world: StoredWorld | null): StoredEntry | undefined {
  return world?.ledger.find(
    (entry) => entry.reason === 'claim.fall' && (entry.delta.coins ?? 0) > 0,
  );
}

/**
 * Waits for the taps to earn a fall credit, so the reload always carries a session that earned
 * something. The plaque cannot tell: it moves on the first refill prepay into the drop buffer
 * whether or not anything was earned.
 */
async function earnFromTaps(page: Page): Promise<void> {
  let world: StoredWorld | null = null;
  try {
    await expect
      .poll(
        async () => {
          world = await storedWorld(page);
          return fallCredit(world) !== undefined;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
  } catch (error) {
    const ledger = (world as StoredWorld | null)?.ledger ?? [];
    const tail = ledger.slice(-8).map((entry) => `${entry.reason} ${JSON.stringify(entry.delta)}`);
    throw new Error(
      `The ${String(TAPS)} taps never earned a fall credit, so there is no earned session to carry across the reload. Last ledger entries: ${tail.join('; ') || 'none stored'}`,
      { cause: error },
    );
  }
}

/**
 * Coins the restored sim was laid with at boot: every pose and heap slot the server handed back.
 * Unlike the live count it does not move as the pusher drops and fuses coins after the boot.
 */
async function restoredCoins(page: Page): Promise<number> {
  const restored = await page.evaluate(() => {
    const counts = (window.__coinposh as { restored?: unknown } | undefined)?.restored;
    return counts as { poses: number; heapSlots: number } | null | undefined;
  });
  if (!restored) throw new Error('The reloaded page reported no restored table to count');
  return restored.poses + restored.heapSlots;
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
  let reveals = 0;
  const seen = async (): Promise<string> =>
    JSON.stringify({
      fromSeq,
      snapshotSeq: player?.tableSnapshot?.seq ?? null,
      crates: player?.crates.map((record) => record.state) ?? null,
      reveals,
      counts: (await probe(page)).counts,
    });
  try {
    await expect
      .poll(
        async () => {
          if ((await reveal.count()) > 0) {
            reveals += 1;
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
  } catch (error) {
    throw new Error(`The Demo table never settled into storage: ${await seen()}`, {
      cause: error,
    });
  }
  if (player === undefined) throw new Error('The Demo world never reached the tab storage.');
  return player;
}

test('a reload in the same tab keeps the Vault and the table; a new tab starts fresh', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await keepWorldLeftBehind(page);
  await bootGame(page);
  const freshVault = await vaultBalance(page);
  const freshCoins = await tableCoins(page);

  for (let i = 0; i < TAPS; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }
  await earnFromTaps(page);
  await settle(page);
  const coins = await tableCoins(page);

  await page.reload();
  await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
    timeout: 60_000,
    polling: 16,
  });
  await expect(page.locator('#coinposh-demo-banner')).toBeVisible();
  // The plaque counts credits up as they land, so the Vault, the ledger position and the table
  // all come from the one world the old page left behind.
  const world = await storedWorld(page, LEFT_BEHIND_KEY);
  const left = world?.players[0];
  if (world === null || left === undefined) {
    throw new Error('The reload found no Demo world left behind by the page before it.');
  }
  const fromSeq = world.nextSeq;
  const vault = storedVault(left);
  const unposedCoins = unposed(left);
  const refundCap = new Map(
    unposedCoins.map((record) => [record.coin.id, Math.min(record.paid, record.coin.value)]),
  );
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
  const prepays = moves.filter((entry) => entry.reason === 'drop.prepay');
  expect(moves.length).toBe(refunds.length + falls.length + prepays.length);
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
  const restored = await restoredCoins(page);
  expect(restored, 'the server lays every table coin it kept, less the refunded unposed ones').toBe(
    left.coins.filter((record) => record.place === 'table').length - refunds.length,
  );
  expect(
    Math.abs(restored - (coins - refunds.length)),
    'the reloaded table holds the coins the player last saw, within the snapshot tolerance',
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
