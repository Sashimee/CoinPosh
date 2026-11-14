import type { Page } from '@playwright/test';
import {
  SIM_SNAPSHOT_VERSION,
  validateSnapshot,
  type SimTableSnapshot,
} from '@coinposh/sim/snapshot';
import type { DemoPose, DemoStoredSnapshot } from '../src/game/session/demoHandle.ts';
import { SNAPSHOT_CADENCE } from '../src/net/snapshotCadence.ts';
import { BOOT_TO_FIRST_DROP_MS, SWIFTSHADER_FRAMES } from './budgets.ts';
import {
  bootGame,
  coinLedger,
  expect,
  probe,
  reviewShot,
  tableProbe,
  tapDrop,
  test,
} from './fixtures.ts';

/** Taps that bring the scripted crate out: the FTUE script drops it at the 12th. */
const DROPS = 20;
/** Quick enough that the scripted crate is still riding when the drops end. */
const TAP_EVERY_MS = 100;
/** The one ledger reason a restored table books as it plays on: a coin it pushed over the lip. */
const PLAY_ON_REASON = 'claim.fall';
/** How often a wait reads the table: two reads this far apart tell a claim in flight. */
const READ_EVERY_MS = 500;
/** For the running sim to land its last drops and upload a table that poses all of them. */
const RUNNING_WHOLE_MS = 60_000;
/**
 * For a held table to upload once more: nothing moves in a held sim, so only a claim landing
 * changes what it would upload, and the cadence's heartbeat sends that change.
 */
const HELD_WHOLE_MS = 2 * SNAPSHOT_CADENCE.heartbeatMs;
/** Holds of the table before the test gives up on one a boot would lay whole. */
const MAX_HOLDS = 3;
/** Re-boot calls whose last check found the held table moved on since its whole read. */
const MAX_REBOOT_TRIES = 5;
/** 92-table-persistence 1.4: a restored coin sits where its pose put it, to within 1 mm. */
const POSE_TOLERANCE_M = 0.001;
/** The sessionStorage key apps/web/src/net/mock/persist.ts keeps the Demo world under. */
const DEMO_STORAGE_KEY = 'coinposh.demo.world';

declare global {
  interface Window {
    /** Every restored sim's table as it stood before its first step, in boot order. */
    __e2eLaidTables?: SimTableSnapshot[];
    /** Every sim worker the page started, in start order; the environment's workers are not. */
    __e2eWorkers?: Worker[];
  }
}

/**
 * Reads each restored sim before it steps. The worker answers a snapshot request that reaches it
 * while it is still starting before its first tick, so one sent right behind `init` reads the
 * table exactly as the restore laid it. Its answer is taken here and never reaches the bridge.
 */
async function watchLaidTables(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probeId = Number.MAX_SAFE_INTEGER;
    const laid: SimTableSnapshot[] = [];
    const workers: Worker[] = [];
    window.__e2eLaidTables = laid;
    window.__e2eWorkers = workers;
    window.Worker = new Proxy(window.Worker, {
      construct(target, args: ConstructorParameters<typeof Worker>, newTarget: () => unknown) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        worker.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { type?: unknown; requestId?: unknown; table?: unknown };
          if (data.type !== 'snapshot' || data.requestId !== probeId) return;
          event.stopImmediatePropagation();
          laid.push(data.table as SimTableSnapshot);
        });
        const post = worker.postMessage.bind(worker) as (
          message: unknown,
          transfer?: Transferable[],
        ) => void;
        worker.postMessage = (
          message: unknown,
          transfer?: Transferable[] | StructuredSerializeOptions,
        ) => {
          post(message, transfer as Transferable[] | undefined);
          const sent = message as { type?: unknown; restore?: unknown } | null;
          if (sent?.type === 'init') workers.push(worker);
          if (sent?.type === 'init' && sent.restore !== undefined) {
            post({ type: 'snapshot', requestId: probeId });
          }
        };
        return worker;
      },
    });
  });
}

async function laidTables(page: Page): Promise<SimTableSnapshot[]> {
  return page.evaluate(() => window.__e2eLaidTables ?? []);
}

/** One read of the Demo server and the sim, taken together in the page. */
interface TableRead {
  readonly accepted: number;
  readonly snapshot: DemoStoredSnapshot | null;
  readonly poses: readonly DemoPose[];
  /** Coins the sim holds, fused coins whose claim is still in flight among them. */
  readonly simCoins: number;
  /** Every currency the Demo server holds for the player. */
  readonly wallet: Readonly<Record<string, number>>;
  readonly refunds: number;
  /** The coins the Demo server keeps on the table, which a boot lays or refunds. */
  readonly serverTable: readonly string[];
  /** The crates the Demo server keeps on the table, which a boot lays from their poses. */
  readonly serverCrates: readonly string[];
  /** Every Demo ledger entry so far. */
  readonly ledger: readonly LedgerEntry[];
}

interface LedgerEntry {
  readonly reason: string;
  readonly ref: string | null;
  readonly delta: Readonly<Record<string, number>>;
}

async function readTable(page: Page): Promise<TableRead> {
  return page.evaluate(async (key) => {
    const p = window.__coinposh;
    const demo = p?.demo;
    if (!p?.sim || !demo) throw new Error('The page exposes no Demo handle: is it in Demo Mode?');
    const poses = await demo.poses();
    const { accepted, last } = demo.snapshots();
    const stored = sessionStorage.getItem(key);
    if (stored === null) throw new Error(`The Demo world is not in sessionStorage under ${key}.`);
    const { world } = JSON.parse(stored) as {
      world: {
        ledger: { reason: string; ref: string | null; delta: Record<string, number> }[];
        players: {
          coins: { coin: { id: string }; place: string }[];
          crates: { crate: { id: string }; state: string }[];
        }[];
      };
    };
    const ledger = world.ledger.map(({ reason, ref, delta }) => ({ reason, ref, delta }));
    const serverTable = (world.players[0]?.coins ?? [])
      .filter((record) => record.place === 'table')
      .map((record) => record.coin.id);
    const serverCrates = (world.players[0]?.crates ?? [])
      .filter((record) => record.state === 'table')
      .map((record) => record.crate.id);
    return {
      accepted,
      snapshot: last,
      poses,
      simCoins: p.sim.coins,
      wallet: { ...demo.wallet() },
      refunds: demo.refunds(),
      serverTable,
      serverCrates,
      ledger,
    };
  }, DEMO_STORAGE_KEY);
}

/**
 * Why a boot from `read` could not lay the table whole, or null once it can: a settle upload
 * landed since the last drop, it poses every coin the sim names, and no fusion claim is in
 * flight (P-594). A held sim makes no new fusions, so a claim is in flight while the coins the
 * sim names still change between two reads. Counting sim bodies against named coins cannot
 * tell: a fused body whose claim the server refused stays in the sim with no coin to name.
 */
function notWhole(
  read: TableRead,
  previous: TableRead | null,
  fromAccepted: number,
  needCrate: boolean,
): string | null {
  if (read.accepted <= fromAccepted) return 'no settle upload since the last drop';
  if (read.snapshot === null) return 'no stored snapshot';
  const named = read.poses.map((pose) => pose.id).join();
  if (previous?.poses.map((pose) => pose.id).join() !== named) {
    return `the coins the sim names are still changing (${String(read.poses.length)} named of ${String(read.simCoins)} sim coins): a fusion claim is in flight`;
  }
  const stored = new Set<string>(read.snapshot.coins.map((pose) => pose[0]));
  const missing = read.poses.filter((pose) => !stored.has(pose.id)).map((pose) => pose.id);
  if (missing.length > 0) return `the last upload leaves out ${missing.join(', ')}`;
  const live = new Set(read.poses.map((pose) => pose.id));
  const unnamed = read.serverTable.filter((id) => !live.has(id));
  if (unnamed.length > 0) {
    return `the server keeps ${unnamed.join(', ')} on the table, which the sim no longer names: a claim is in flight`;
  }
  if (needCrate) {
    const riding = new Set(read.serverCrates);
    if (!read.snapshot.crates.some((tuple) => riding.has(tuple[0]))) {
      return `no crate the server keeps on the table rides in the last upload (server: ${read.serverCrates.join(', ') || 'none'})`;
    }
  }
  return null;
}

type Whole = { readonly whole: TableRead } | { readonly why: string; readonly last: string };

/**
 * Reads the table every READ_EVERY_MS until a boot from it would lay it whole, for at most
 * `timeoutMs`, and returns that read or why the last one was not whole.
 */
async function pollWhole(
  page: Page,
  fromAccepted: number,
  needCrate: boolean,
  timeoutMs: number,
): Promise<Whole> {
  const deadline = Date.now() + timeoutMs;
  let previous: TableRead | null = null;
  let why = 'not read yet';
  while (Date.now() < deadline) {
    const read = await readTable(page);
    const reason = notWhole(read, previous, fromAccepted, needCrate);
    if (reason === null) return { whole: read };
    why = reason;
    previous = read;
    await page.waitForTimeout(READ_EVERY_MS);
  }
  const { counts, sim } = await probe(page);
  const last = JSON.stringify({
    accepted: previous?.accepted,
    fromAccepted,
    seq: previous?.snapshot?.seq,
    crates: previous?.snapshot?.crates,
    tick: sim?.tick,
    counts,
  });
  return { why, last };
}

/**
 * Drops up to `count` coins at a thumb's pace, stopping early once `enough` says so, and returns
 * the settle uploads counted after the last.
 */
async function dropCoins(
  page: Page,
  count: number,
  enough: () => Promise<boolean> = () => Promise.resolve(false),
): Promise<number> {
  for (let i = 0; i < count; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
    if (await enough()) break;
  }
  return (await readTable(page)).accepted;
}

interface Reboot {
  readonly before: TableRead;
  /** Read once the table takes drops again, before anything else happens on it. */
  readonly after: TableRead;
  /** From the reboot call to the table taking drops again. */
  readonly rebootMs: number;
  /** The longest animation frame while the table re-booted. */
  readonly longestFrameMs: number;
}

/**
 * Posts `type` to the sim worker the page plays on. That message is the whole of
 * SimBridge.pause() and resume(), which keep no state of their own: the worker alone holds the
 * pause (src/game/simWorker/runtime.ts). The page exposes no bridge, so it goes to the worker.
 */
async function postToSim(page: Page, type: 'pause' | 'resume'): Promise<void> {
  await page.evaluate((message) => {
    const worker = window.__e2eWorkers?.at(-1);
    if (!worker) throw new Error('No sim worker was started in the page.');
    worker.postMessage({ type: message });
  }, type);
}

/**
 * Holds the page's sim still. "Play here" is only reachable from the overlay, and the overlay
 * holds the old sim still (main.ts wireTableSession), so a re-boot from the Demo handle is held
 * the same way: a fall or fusion in the old sim while the re-boot drains would leave the server
 * a coin no upload posed. The page keeps sampling and uploading a held table.
 */
async function holdTable(page: Page): Promise<void> {
  await postToSim(page, 'pause');
  let tick = -1;
  await expect
    .poll(
      async () => {
        const now = (await probe(page)).sim?.tick ?? -1;
        const still = now === tick;
        tick = now;
        return still;
      },
      { timeout: 10_000, intervals: [150], message: 'the held sim stops ticking' },
    )
    .toBe(true);
}

/**
 * Waits until an upload from the running sim poses every coin it names, holds the sim, and
 * waits until a boot from the held table would lay it whole, returning that read. A fusion
 * between the two waits can mint a coin the held table never uploads: its claim lands after the
 * last upload, and once its frozen pose fails validateSnapshot (a coin fused in the air is out
 * of bounds) every later capture equals that upload, so the cadence sends none. The sim then
 * runs on until it uploads whole again and is held again.
 */
async function holdWhole(page: Page, fromAccepted: number, needCrate: boolean): Promise<TableRead> {
  const misses: string[] = [];
  for (let hold = 1; hold <= MAX_HOLDS; hold += 1) {
    const running = await pollWhole(page, fromAccepted, needCrate, RUNNING_WHOLE_MS);
    if ('why' in running) {
      throw new Error(
        `No settle upload from the running sim posed the whole table in ${String(RUNNING_WHOLE_MS)} ms: ${running.why}; ${running.last}`,
      );
    }
    await holdTable(page);
    const held = await pollWhole(page, fromAccepted, needCrate, HELD_WHOLE_MS);
    if ('whole' in held) return held.whole;
    misses.push(`hold ${String(hold)}: ${held.why}; ${held.last}`);
    await postToSim(page, 'resume');
  }
  throw new Error(
    `The held table never read whole in ${String(MAX_HOLDS)} holds: ${misses.join(' | ')}`,
  );
}

/**
 * Holds the table whole and re-boots it in the page as "Play here" does. The last check runs in
 * the same task as the reboot call; a held table that moved on since its whole read (a claim
 * landed, an upload was taken) is read again.
 */
async function rebootWhenWhole(
  page: Page,
  fromAccepted: number,
  needCrate: boolean,
): Promise<Reboot> {
  if (needCrate) {
    // A crate rides on frame time while the server bounds its ride by sim ticks (mock
    // snapshot.ts withinCrateRide), so once the sim is held the server refuses the crate's new
    // poses as teleports and keeps the last one it took: that one must come from the running sim.
    try {
      await expect
        .poll(async () => (await readTable(page)).snapshot?.crates.length ?? 0, {
          timeout: 30_000,
          intervals: [250],
        })
        .toBeGreaterThan(0);
    } catch (error) {
      const flags = await page.evaluate((key) => {
        const stored = sessionStorage.getItem(key);
        if (stored === null) return 'no stored world';
        const world = (JSON.parse(stored) as { world: { players: { snapshotFlags: unknown }[] } })
          .world;
        return JSON.stringify(world.players.map((player) => player.snapshotFlags));
      }, DEMO_STORAGE_KEY);
      const { counts } = await probe(page);
      throw new Error(
        `No upload from the running sim carried the crate riding the table: snapshot flags ${flags}, counts ${JSON.stringify(counts)}`,
        { cause: error },
      );
    }
  }
  let before = await holdWhole(page, fromAccepted, needCrate);
  const moved: string[] = [];
  for (let tries = 1; tries <= MAX_REBOOT_TRIES; tries += 1) {
    const run = await page.evaluate(
      async ({ simCoins, accepted }) => {
        const p = window.__coinposh;
        const demo = p?.demo;
        if (!p?.sim || !demo) throw new Error('The page exposes no Demo handle.');
        const now = { simCoins: p.sim.coins, accepted: demo.snapshots().accepted };
        if (now.simCoins !== simCoins || now.accepted !== accepted) return { moved: now };
        // The frame that spans the re-boot's end counts too: a re-boot that blocked the main
        // thread throughout draws no frame inside it, so it shows only in that one.
        let longestFrameMs = 0;
        let rebooting = true;
        let last = performance.now();
        let framesDone = (): void => undefined;
        const lastFrame = new Promise<void>((resolve) => {
          framesDone = resolve;
        });
        const frame = (at: number): void => {
          longestFrameMs = Math.max(longestFrameMs, at - last);
          last = at;
          if (rebooting) requestAnimationFrame(frame);
          else framesDone();
        };
        requestAnimationFrame(frame);
        const startedAt = performance.now();
        await demo.reboot();
        const rebootMs = performance.now() - startedAt;
        rebooting = false;
        await lastFrame;
        return { rebootMs, longestFrameMs };
      },
      { simCoins: before.simCoins, accepted: before.accepted },
    );
    if (!('moved' in run)) return { before, after: await readTable(page), ...run };
    moved.push(
      `sim coins ${String(before.simCoins)} to ${String(run.moved.simCoins)}, accepted uploads ${String(before.accepted)} to ${String(run.moved.accepted)}`,
    );
    const again = await pollWhole(page, fromAccepted, needCrate, HELD_WHOLE_MS);
    if ('why' in again) {
      throw new Error(`The held table stopped reading whole: ${again.why}; ${again.last}`);
    }
    before = again.whole;
  }
  throw new Error(
    `The held table moved on between its whole read and the re-boot call in all ${String(MAX_REBOOT_TRIES)} tries: ${moved.join('; ')}`,
  );
}

/**
 * Pairs each pose the boot laid with the restored sim body nearest it, before the sim stepped.
 * Poses are unique to well under 1 mm, since validateSnapshot refuses coins that interpenetrate
 * deeper than that, so a pose with no body within 1 mm was laid somewhere else.
 */
function misplaced(laid: DemoStoredSnapshot, table: SimTableSnapshot, unit: number) {
  const bodies = table.coins.map((coin) => coin.p);
  const taken = new Set<number>();
  const off: { id: string; mm: number }[] = [];
  for (const [id, x, y, z] of laid.coins) {
    let best = -1;
    let bestM = Infinity;
    bodies.forEach(([bx, by, bz], i) => {
      if (taken.has(i)) return;
      const metres = Math.hypot(bx - x, by - y, bz - z) * unit;
      if (metres < bestM) {
        best = i;
        bestM = metres;
      }
    });
    if (best >= 0) taken.add(best);
    if (bestM > POSE_TOLERANCE_M) off.push({ id, mm: Number((bestM * 1000).toFixed(2)) });
  }
  return off;
}

async function positionUnit(page: Page): Promise<number> {
  return page.evaluate(() => {
    const demo = window.__coinposh?.demo;
    if (!demo) throw new Error('The page exposes no Demo handle.');
    return demo.positionUnit;
  });
}

/**
 * Ms from a tap to the sync that first counts its coin in the sim. A crate that goes over the
 * lip opens its reveal over the table and the tap under it is lost, so like a player this closes
 * the reveal and taps again, timing the tap that reached the table.
 */
async function timeFirstDrop(page: Page): Promise<number> {
  const reveal = page.getByTestId('crate-reveal');
  const before = coinLedger(await probe(page));
  for (let taps = 0; taps < 3; taps += 1) {
    // Escape skips the opening; once the card is shown only Collect closes it.
    await expect(async () => {
      const collect = page.getByTestId('crate-collect');
      if (await collect.isVisible()) await collect.click();
      else if ((await reveal.count()) > 0) await page.keyboard.press('Escape');
      await expect(reveal).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    const tappedAt = Date.now();
    await tapDrop(page);
    while (Date.now() - tappedAt < 10_000) {
      if (coinLedger(await probe(page)) > before) return Date.now() - tappedAt;
      if ((await reveal.count()) > 0) break;
      await page.waitForTimeout(16);
    }
  }
  const { playable, counts } = await probe(page);
  const reveals = await reveal.count();
  throw new Error(
    `No tap after the boot put a coin in the sim: ${JSON.stringify({ playable, reveals, counts })}`,
  );
}

/**
 * The layout the newest boot stored, read right after it, checked against the restored sim
 * before its first step.
 */
async function expectLaidInPlace(
  page: Page,
  laid: DemoStoredSnapshot | null,
  boots: number,
): Promise<DemoStoredSnapshot> {
  if (laid === null) throw new Error('The boot stored no layout for the table it laid.');
  expect(laid.seq, 'a boot stores the layout it laid as seq 0').toBe(0);
  const restored = (await tableProbe(page)).restored;
  expect(restored?.boots, 'boots of the table in this page').toBe(boots);
  expect(restored?.poses, 'coins laid from their poses').toBe(laid.coins.length);
  const tables = await laidTables(page);
  expect(tables, 'one restored sim per boot').toHaveLength(boots);
  const table = tables[boots - 1];
  if (table === undefined) throw new Error('The re-booted sim was never read before it stepped.');
  expect(table.coins).toHaveLength((restored?.poses ?? 0) + (restored?.heapSlots ?? 0));
  expect(
    misplaced(laid, table, await positionUnit(page)),
    'laid coins further than 1 mm from their pose',
  ).toEqual([]);
  return laid;
}

interface StoredWorld {
  readonly ledger: readonly { readonly reason: string; readonly ref: string | null }[];
  readonly players: readonly { readonly tableSnapshot: { readonly pusherTick: number } | null }[];
}

/**
 * Names every coin a boot refunded, with the pose the upload gave it and why the boot's
 * validation (the same validateSnapshot the mock's judgePoses runs, at the stored pusher tick)
 * turned that pose down, so a red run says which coins to look at instead of only how many.
 */
async function refundReport(page: Page, before: TableRead, count: number): Promise<string> {
  let world: StoredWorld | null = null;
  await expect
    .poll(async () => {
      const raw = await page.evaluate((key) => sessionStorage.getItem(key), DEMO_STORAGE_KEY);
      world = raw === null ? null : (JSON.parse(raw) as { world: StoredWorld }).world;
      return world?.ledger.filter((entry) => entry.reason === 'refund.table').length ?? 0;
    })
    .toBeGreaterThanOrEqual(count);
  const stored = world as StoredWorld | null;
  const refs = (stored?.ledger ?? [])
    .filter((entry) => entry.reason === 'refund.table')
    .map((entry) => entry.ref);
  const live = new Set(before.poses.map((pose) => pose.id));
  const uploaded = (before.snapshot?.coins ?? []).filter((pose) => live.has(pose[0]));
  const pusherTick = stored?.players[0]?.tableSnapshot?.pusherTick ?? 0;
  const verdict = validateSnapshot({
    version: SIM_SNAPSHOT_VERSION,
    pusherTickInCycle: pusherTick,
    coins: uploaded.map(([, x, y, z, qx, qy, qz, qw, rest], id) => ({
      id,
      p: [x, y, z] as const,
      q: [qx, qy, qz, qw] as const,
      rest,
    })),
  });
  const coins = refs.map((ref) => {
    const at = uploaded.findIndex((pose) => pose[0] === ref);
    const pose = uploaded[at];
    const why = verdict.dropped.find((entry) => entry.id === at)?.reason ?? 'kept';
    return pose === undefined
      ? `${String(ref)}: not in the upload the boot laid from (live: ${String(live.has(ref ?? ''))})`
      : `${String(ref)}: uploaded at ${JSON.stringify(pose.slice(1))}, validation says ${why}`;
  });
  return `pusher tick ${String(pusherTick)}; ${coins.join('; ')}`;
}

/**
 * Checks that the boot after `before` moved no value: the ledger since holds only falls the
 * restored table paid as it played on, pushing lip coins over, and the wallet moved by exactly
 * those. The ledger is read from the tab's storage, which trails the wallet by a write, so the
 * two are read until they agree.
 */
async function expectBootBookedNothing(page: Page, before: TableRead): Promise<void> {
  let booked = 'not read yet';
  try {
    await expect
      .poll(async () => {
        const now = await readTable(page);
        const since = now.ledger.slice(before.ledger.length);
        booked =
          since
            .map((entry) => `${entry.reason} ${String(entry.ref)} ${JSON.stringify(entry.delta)}`)
            .join('; ') || 'nothing';
        const wallet: Record<string, number> = { ...before.wallet };
        for (const entry of since.filter((e) => e.reason === PLAY_ON_REASON)) {
          for (const [currency, amount] of Object.entries(entry.delta)) {
            wallet[currency] = (wallet[currency] ?? 0) + amount;
          }
        }
        const currencies = new Set([...Object.keys(wallet), ...Object.keys(now.wallet)]);
        return {
          booked: since.filter((e) => e.reason !== PLAY_ON_REASON).map((e) => e.reason),
          walletOff: [...currencies].filter(
            (currency) => (wallet[currency] ?? 0) !== (now.wallet[currency] ?? 0),
          ),
        };
      })
      .toEqual({ booked: [], walletOff: [] });
  } catch (error) {
    throw new Error(`The boot moved the Demo wallet or ledger: booked ${booked}`, {
      cause: error,
    });
  }
}

test.describe('the table survives a re-boot', () => {
  test('a re-boot in the page lays every coin and the crate where they were, refunding nothing', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await watchLaidTables(page);
    await bootGame(page);
    // The crate rides on toward the lip and can go over it before the table is held, so the
    // drops stop once it is out.
    const fromAccepted = await dropCoins(
      page,
      DROPS,
      async () => (await probe(page)).counts.cratesSpawned > 0,
    );
    expect((await probe(page)).counts.cratesSpawned, 'the scripted crate is out').toBe(1);

    const { before, after, rebootMs, longestFrameMs } = await rebootWhenWhole(
      page,
      fromAccepted,
      true,
    );
    const refunds = after.refunds - before.refunds;
    testInfo.annotations.push({
      type: 're-boot',
      description: `${String(before.poses.length)} named coins of ${String(before.simCoins)} sim coins, ${String(refunds)} refunds; re-boot ${rebootMs.toFixed(0)} ms, longest frame ${longestFrameMs.toFixed(0)} ms`,
    });
    const refunded = refunds > 0 ? await refundReport(page, before, after.refunds) : 'none';
    expect(refunds, `refund.table entries the re-boot booked (${refunded})`).toBe(0);
    expect(after.refunds, 'refund.table entries in the Demo ledger').toBe(0);
    await expectBootBookedNothing(page, before);
    const firstDropMs = await timeFirstDrop(page);
    testInfo.annotations.push({ type: 'first drop', description: `${String(firstDropMs)} ms` });
    const laid = await expectLaidInPlace(page, after.snapshot, 2);

    const riding = new Set(before.serverCrates);
    const [crateId, , crateZ, crateMs] =
      before.snapshot?.crates.find((tuple) => riding.has(tuple[0])) ?? [];
    if (crateId === undefined || crateZ === undefined || crateMs === undefined) {
      throw new Error('The upload the re-boot laid from had no crate riding.');
    }
    const laidCrate = laid.crates.find((tuple) => tuple[0] === crateId);
    expect(laidCrate, `crate ${crateId} is laid from its pose, not the chute`).toBeDefined();
    expect((await tableProbe(page)).restored?.chutes, 'crates restarted at the chute').toBe(0);

    // One tap's latency on SwiftShader swings by seconds (budgets.ts BOOT_RUNS), which is why
    // boot.perf gates the tap path on a median of cold boots. The re-boot adds only its own time
    // before that path, so that is what a single run here can hold to the T-1.17 budget.
    expect(rebootMs, 're-boot until the table takes drops (T-1.17)').toBeLessThan(
      BOOT_TO_FIRST_DROP_MS,
    );
    expect(
      longestFrameMs,
      'longest frame while the table re-booted (SwiftShader p95)',
    ).toBeLessThan(SWIFTSHADER_FRAMES.maxP95FrameMs);

    let ride = 'not read yet';
    await expect
      .poll(
        async () => {
          const pose = (await readTable(page)).snapshot?.crates.find((t) => t[0] === crateId);
          if (pose === undefined) {
            ride = 'off the table';
            return (await probe(page)).counts.cratesOpened >= 1;
          }
          ride = JSON.stringify(pose);
          return pose[3] > crateMs && pose[2] >= crateZ;
        },
        { timeout: 60_000, intervals: [500], message: `crate ${crateId} resumes its ride` },
      )
      .toBe(true);
    testInfo.annotations.push({
      type: 'crate',
      description: `${crateId} from ${String(crateMs)} ms at z ${String(crateZ)} to ${ride}`,
    });
  });

  test('a second boot on the same Demo server covers this page, and "Play here" takes the table back', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await watchLaidTables(page);
    await bootGame(page);
    const fromAccepted = await dropCoins(page, 8);
    const before = await holdWhole(page, fromAccepted, false);

    await page.evaluate(async () => {
      const demo = window.__coinposh?.demo;
      if (!demo) throw new Error('The page exposes no Demo handle.');
      await demo.bootElsewhere();
    });
    const overlay = page.getByTestId('table-elsewhere');
    await expect(overlay).toBeHidden();
    await tapDrop(page);
    await expect(overlay).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'This table is open elsewhere' })).toBeVisible();
    const playHere = page.getByRole('button', { name: 'Play here' });
    await expect(playHere).toHaveAttribute('data-testid', 'table-elsewhere-play-here');
    await expect(playHere).toBeFocused();
    expect(await tableProbe(page)).toMatchObject({ superseded: true });
    expect((await probe(page)).playable).toBe(false);
    await reviewShot(page, 'table-elsewhere');

    await playHere.click();
    await expect(overlay).toBeHidden();
    await expect.poll(async () => (await probe(page)).playable).toBe(true);
    expect(await tableProbe(page)).toMatchObject({ superseded: false });
    const after = await readTable(page);
    expect(after.refunds, 'refund.table entries in the Demo ledger').toBe(0);
    await expectBootBookedNothing(page, before);
    await expectLaidInPlace(page, after.snapshot, 2);

    const firstDropMs = await timeFirstDrop(page);
    await expect(overlay).toBeHidden();
    testInfo.annotations.push({
      type: 'play here',
      description: `${String(after.poses.length)} coins back on the table, first drop ${String(firstDropMs)} ms`,
    });
  });
});
