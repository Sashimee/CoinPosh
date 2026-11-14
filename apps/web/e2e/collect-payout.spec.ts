import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, probe, refusedTotal, tapDrop, test } from './fixtures.ts';

const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
const TAP_EVERY_MS = 400;
const CRATE_OPENS_WITHIN_MS = 90_000;
/** How long the table is nudged behind an open card while waiting for a coin to fall. */
const REVEAL_DWELL_MS = 12_000;
const NUDGE_EVERY_MS = 500;
/** The coin line's flight plus the held falls' gap and their pops, with slack for slow frames. */
const PAYOUT_SETTLES_MS = 6_000;
/** P-450: the held falls follow the coin line by at least this much. */
const FALLS_GAP_MS = 400;
const CRATES_TRIED = 3;

type Motion = 'full' | 'reduced';

interface VaultChange {
  readonly at: number;
  readonly by: number;
}

interface Trace {
  readonly line: number;
  readonly fallsDuringReveal: number;
  readonly changes: readonly VaultChange[];
}

interface PayoutTracer {
  readonly changes: VaultChange[];
  vault: number;
  collectedAt: number | null;
  stop(): void;
}

declare global {
  interface Window {
    __payoutTapGuard?: boolean;
    __payoutTrace?: PayoutTracer;
    __fallsAtOpen?: number;
  }
}

/**
 * Drops pointer input that would reach an open reveal, where any tap is a veil skip, and notes
 * the front-fall count each time a crate opens, which is when the Vault starts holding falls.
 */
async function guardRevealTaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    let opened = 0;
    setInterval(() => {
      const counts = window.__coinposh?.counts;
      if (!counts || counts.cratesOpened === opened) return;
      opened = counts.cratesOpened;
      window.__fallsAtOpen = counts.frontFalls;
    }, 16);
    window.__payoutTapGuard = true;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      addEventListener(
        type,
        (event) => {
          if (!window.__payoutTapGuard) return;
          if (!document.querySelector('[data-testid="crate-reveal"]')) return;
          event.stopImmediatePropagation();
          event.preventDefault();
        },
        { capture: true },
      );
    }
  });
}

async function playUntilRevealMounts(page: Page): Promise<void> {
  const reveal = page.getByTestId('crate-reveal');
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

/**
 * The table keeps running under the card, but a coin rarely goes over the lip in the few seconds
 * a player reads it, so the test shoves the table from the keyboard behind the dialog. The key
 * goes to the canvas directly: focus belongs to the reveal, as it does for a player.
 */
async function nudgeTableBehindReveal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    if (!stage) throw new Error('The #stage canvas is missing, so the table cannot be nudged');
    stage.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  });
}

/**
 * Records the Vault the plaque shows on every painted frame after the Collect press, which the
 * tracer stamps in the capture phase so no change can slip in between. It samples frames, not
 * mutations, because the order under test is the one the player sees. The coins in hand are
 * counted with the plaque, so a drop-buffer refill, which moves coins from the Vault into the
 * hand, is not mistaken for a payout move.
 */
async function traceVault(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spoken = document.querySelector('[data-testid=hud-balance] .cp-sr-only');
    if (!spoken) throw new Error('The Vault plaque has no screen-reader balance to trace');
    const digits = (element: Element | null): number =>
      Number((element?.textContent ?? '').replace(/\D/g, ''));
    const read = (): number =>
      digits(spoken) + digits(document.querySelector('[data-testid=hud-in-hand] .cp-sr-only'));
    let tracing = true;
    const onPress = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[data-testid="crate-collect"]')) return;
      tracer.collectedAt ??= performance.now();
    };
    const frame = (): void => {
      if (!tracing) return;
      const now = read();
      if (now !== tracer.vault && tracer.collectedAt !== null) {
        tracer.changes.push({ at: performance.now() - tracer.collectedAt, by: now - tracer.vault });
      }
      tracer.vault = now;
      requestAnimationFrame(frame);
    };
    const tracer: PayoutTracer = {
      changes: [],
      vault: read(),
      collectedAt: null,
      stop() {
        tracing = false;
        removeEventListener('click', onPress, { capture: true });
      },
    };
    addEventListener('click', onPress, { capture: true });
    requestAnimationFrame(frame);
    window.__payoutTrace = tracer;
  });
}

/** Plays to the next crate, lets the table run behind its card, collects and traces the Vault. */
async function collectNextCrate(page: Page): Promise<Trace> {
  await page.evaluate(() => {
    window.__payoutTapGuard = true;
  });
  await playUntilRevealMounts(page);
  const reveal = page.getByTestId('crate-reveal');
  await page.keyboard.press('Escape');
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible({ timeout: 15_000 });
  const coins = reveal.locator('.cp-crate-line--currency', { hasText: /Coins/ });
  await expect(coins, 'the card pays a coin line').toHaveCount(1);
  const line = Number(((await coins.textContent()) ?? '').replace(/\D/g, ''));
  expect(line).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.__fallsAtOpen ?? 0);
  const fallsSinceOpen = async (): Promise<number> =>
    (await probe(page)).counts.frontFalls - before;
  const dwellEnds = Date.now() + REVEAL_DWELL_MS;
  while ((await fallsSinceOpen()) === 0 && Date.now() < dwellEnds) {
    await nudgeTableBehindReveal(page);
    await page.waitForTimeout(NUDGE_EVERY_MS);
  }
  const fallsDuringReveal = await fallsSinceOpen();

  await traceVault(page);
  await page.evaluate(() => {
    window.__payoutTapGuard = false;
  });
  await collect.click();
  await expect(reveal).toHaveCount(0, { timeout: PAYOUT_SETTLES_MS });
  await page.waitForTimeout(PAYOUT_SETTLES_MS);
  const changes = await page.evaluate(() => {
    const tracer = window.__payoutTrace;
    if (!tracer) throw new Error('The Vault tracer was never installed');
    tracer.stop();
    return tracer.changes;
  });
  return { line, fallsDuringReveal, changes };
}

async function expectCoinLineFirst(page: Page, motion: Motion): Promise<void> {
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  await bootGame(page);
  await guardRevealTaps(page);
  for (let i = 0; i < FTUE_DROP; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }

  const traces: Trace[] = [];
  for (let n = 0; n < CRATES_TRIED; n += 1) {
    const trace = await collectNextCrate(page);
    traces.push(trace);
    const [first] = trace.changes;
    expect(first, `crate ${String(n + 1)}: the Vault changed after COLLECT`).toBeDefined();
    expect(
      first?.by,
      `crate ${String(n + 1)}: the Vault's first move is the card's coin line (${JSON.stringify(trace)})`,
    ).toBe(trace.line);
    if (trace.fallsDuringReveal > 0) break;
  }

  const shown = traces.at(-1);
  if (!shown) throw new Error('No crate was collected');
  expect(
    shown.fallsDuringReveal,
    `table falls went over the lip during a reveal: ${JSON.stringify(traces)}`,
  ).toBeGreaterThan(0);
  const [first, ...later] = shown.changes;
  const gained = later.reduce((sum, change) => sum + change.by, 0);
  expect(
    gained,
    `the held falls reach the Vault after the coin line: ${JSON.stringify(shown)}`,
  ).toBeGreaterThan(0);
  for (const change of later) {
    expect(
      change.at - (first?.at ?? 0),
      `the held falls follow the coin line by ${String(FALLS_GAP_MS)} ms or more: ${JSON.stringify(shown)}`,
    ).toBeGreaterThanOrEqual(FALLS_GAP_MS);
  }
}

test.describe('collect payout order (P-450)', () => {
  test('COLLECT rolls the Vault by the coin line first, then the falls held behind the reveal', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await expectCoinLineFirst(page, 'full');
  });

  test('reduced motion keeps the coin line ahead of the held falls', async ({ page }) => {
    test.setTimeout(300_000);
    await expectCoinLineFirst(page, 'reduced');
  });
});

/** Rapid taps, as a player emptying the Vault does. */
const RAPID_TAP_MS = 140;
/** Long enough for the coin line, the held falls, the dwell and the handover to have played. */
const HANDOVER_SETTLES_MS = 7_000;
/** P-614: the plaque shows the payout this long, at least, before the refill moves any digit. */
const PLAQUE_HOLDS_MS = 1_000;

interface HandoverFrame {
  readonly at: number;
  readonly plaque: number;
  readonly inHand: number;
  readonly reveal: boolean;
  readonly collect: boolean;
  readonly emptyNotice: boolean;
  readonly glyphs: number;
}

interface HandoverSampler {
  readonly frames: HandoverFrame[];
  collectedAt: number | null;
  /** Fall credits counted when the crate opened, which is when the Vault starts holding falls. */
  creditedAtOpen: number | null;
  stop(): void;
}

declare global {
  interface Window {
    __handover?: HandoverSampler;
  }
}

/** Samples the plaque, the hand and the reveal on every painted frame and readout change. */
async function sampleHandover(page: Page): Promise<void> {
  await page.evaluate(() => {
    const digits = (selector: string): number =>
      Number((document.querySelector(selector)?.textContent ?? '').replace(/\D/g, ''));
    const visible = (selector: string): boolean => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || element.hidden) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    let tracing = true;
    let opened = window.__coinposh?.counts.cratesOpened ?? 0;
    const onPress = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[data-testid="crate-collect"]')) return;
      sampler.collectedAt ??= performance.now();
    };
    const sample = (): void => {
      const counts = window.__coinposh?.counts;
      if (counts && counts.cratesOpened !== opened) {
        opened = counts.cratesOpened;
        sampler.creditedAtOpen ??= counts.creditedCoins;
      }
      sampler.frames.push({
        at: performance.now(),
        plaque: digits('[data-testid=hud-balance] .cp-sr-only'),
        inHand: digits('[data-testid=hud-in-hand] .cp-sr-only'),
        reveal: document.querySelector('[data-testid="crate-reveal"]') !== null,
        collect: visible('[data-testid="crate-collect"]'),
        emptyNotice: visible('[data-testid="hud-vault-empty"]'),
        glyphs: document.querySelectorAll('[data-testid="hud-in-hand-glyph"]').length,
      });
    };
    const frame = (): void => {
      if (!tracing) return;
      sample();
      requestAnimationFrame(frame);
    };
    // A loaded machine paints a frame only every few hundred ms, fewer than the handover's
    // steps, so every readout change is sampled as well.
    const readouts = new MutationObserver(sample);
    for (const id of ['hud-balance', 'hud-in-hand']) {
      const spoken = document.querySelector(`[data-testid=${id}] .cp-sr-only`);
      if (!spoken) throw new Error(`The ${id} readout has no screen-reader text to sample`);
      readouts.observe(spoken, { characterData: true, childList: true, subtree: true });
    }
    const sampler: HandoverSampler = {
      frames: [],
      collectedAt: null,
      creditedAtOpen: null,
      stop() {
        tracing = false;
        readouts.disconnect();
        removeEventListener('click', onPress, { capture: true });
      },
    };
    addEventListener('click', onPress, { capture: true });
    requestAnimationFrame(frame);
    window.__handover?.stop();
    window.__handover = sampler;
  });
}

/**
 * Taps fast until the Vault and the hand have both run dry, then keeps tapping, as a player
 * does, until a crate opens. Returns whether both read 0 at some point before it opened.
 */
async function emptyVaultUntilReveal(page: Page): Promise<boolean> {
  const reveal = page.getByTestId('crate-reveal');
  const deadline = Date.now() + CRATE_OPENS_WITHIN_MS;
  let emptied = false;
  while ((await reveal.count()) === 0) {
    if (Date.now() > deadline) {
      const { counts } = await probe(page);
      throw new Error(
        `No crate reveal within ${String(CRATE_OPENS_WITHIN_MS)} ms of emptying the Vault: ${JSON.stringify(counts)}`,
      );
    }
    const plaque = await readDigits(page, 'hud-balance');
    const inHand = await readDigits(page, 'hud-in-hand');
    if (plaque === 0 && inHand === 0) emptied = true;
    await tapDrop(page);
    await page.waitForTimeout(RAPID_TAP_MS);
  }
  return emptied;
}

interface HandoverRound {
  readonly line: number;
  readonly frames: HandoverFrame[];
  readonly collectedAt: number | null;
  readonly creditedAtOpen: number | null;
  /** Whether the Vault and the hand both read 0 at some point before the crate opened. */
  readonly emptied: boolean;
  /** Whether the hand had room for a refill when COLLECT was pressed. */
  readonly roomInHand: boolean;
  /**
   * Whether another crate opened while this card was up: the director queues it and mounts its
   * card the moment this one leaves, so the Vault stays held and no handover plays behind it.
   */
  readonly queued: boolean;
}

/** Empties the Vault until a crate opens, checks its card, collects it and returns the samples. */
async function collectAfterEmptying(page: Page, handCapacity: number): Promise<HandoverRound> {
  await page.evaluate(() => {
    window.__payoutTapGuard = true;
  });
  await sampleHandover(page);
  const tapped = await emptyVaultUntilReveal(page);
  const reveal = page.getByTestId('crate-reveal');
  await page.keyboard.press('Escape');
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId('hud-vault-empty'),
    'P-615: no bankrupt notice over a crate card that pays',
  ).toBeHidden();
  const coins = reveal.locator('.cp-crate-line--currency', { hasText: /Coins/ });
  await expect(coins, 'the card pays a coin line').toHaveCount(1);
  const line = Number(((await coins.textContent()) ?? '').replace(/\D/g, ''));
  expect(line).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const { counts } = await probe(page);
      return counts.frontFalls - counts.credits - refusedTotal(counts);
    }, 'every fall claim is answered before COLLECT')
    .toBe(0);
  const roomInHand = (await readDigits(page, 'hud-in-hand')) < handCapacity;

  const card = await reveal.elementHandle();
  await page.evaluate(() => {
    window.__payoutTapGuard = false;
  });
  await collect.click();
  await expect
    .poll(() => card.evaluate((el) => el.isConnected), {
      message: 'the collected card flies off and leaves',
      timeout: PAYOUT_SETTLES_MS,
    })
    .toBe(false);
  const { counts: left } = await probe(page);
  const queued = left.cratesOpened > left.cratesCollected;
  if (!queued) await expect(reveal).toHaveCount(0);
  await page.waitForTimeout(HANDOVER_SETTLES_MS);
  const sampled = await page.evaluate(() => {
    const sampler = window.__handover;
    if (!sampler) throw new Error('The handover sampler was never installed');
    sampler.stop();
    return {
      frames: sampler.frames,
      collectedAt: sampler.collectedAt,
      creditedAtOpen: sampler.creditedAtOpen,
    };
  });
  const opened = sampled.frames.findIndex((row) => row.reveal);
  const emptied =
    tapped || sampled.frames.slice(0, opened).some((row) => row.plaque === 0 && row.inHand === 0);
  return { line, emptied, roomInHand, queued, ...sampled };
}

async function readDigits(page: Page, testId: string): Promise<number> {
  return page.evaluate(
    (id) =>
      Number(
        (document.querySelector(`[data-testid=${id}] .cp-sr-only`)?.textContent ?? '').replace(
          /\D/g,
          '',
        ),
      ),
    testId,
  );
}

async function expectPayoutHandover(page: Page, motion: Motion): Promise<void> {
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  await bootGame(page);
  await guardRevealTaps(page);
  const handCapacity = await readDigits(page, 'hud-in-hand');
  expect(handCapacity, 'the drop buffer starts full').toBeGreaterThan(0);

  // A crate can open right after a burst of falls has refilled the Vault and the hand; that
  // card has nothing to show on an empty Vault, so the test plays on to the next crate.
  const rounds: HandoverRound[] = [];
  // A crate that opened behind another's card is played as the next round but is not a try.
  const ready = (row: HandoverRound | undefined): boolean =>
    row !== undefined && row.emptied && row.roomInHand && !row.queued;
  const tried = (): number => rounds.filter((_, i) => rounds[i - 1]?.queued !== true).length;
  while (tried() < CRATES_TRIED && !ready(rounds.at(-1))) {
    rounds.push(await collectAfterEmptying(page, handCapacity));
  }
  const round = rounds.at(-1);
  if (!round || !ready(round)) {
    throw new Error(
      `None of ${String(CRATES_TRIED)} crates opened on an emptied Vault with room in the hand: ${JSON.stringify(rounds.map(({ emptied, roomInHand, queued }) => ({ emptied, roomInHand, queued })))}`,
    );
  }
  const { line, frames, collectedAt, creditedAtOpen } = round;
  if (collectedAt === null) throw new Error('The COLLECT press was never seen');
  if (creditedAtOpen === null) throw new Error('The crate open was never seen');
  const { counts } = await probe(page);
  const report = (rows: readonly HandoverFrame[]): string =>
    JSON.stringify(
      rows.map((row) => [Math.round(row.at - collectedAt), row.plaque, row.inHand, row.glyphs]),
    );

  const firstReveal = frames.findIndex((row) => row.reveal);
  const beforeHold = frames[firstReveal - 1];
  const during = frames.filter((row) => row.reveal);
  if (beforeHold && beforeHold.inHand > 0) {
    expect(
      during.every((row) => row.inHand > 0),
      `P-615: the hand read ${String(beforeHold.inHand)} before the hold and never 0 behind the card`,
    ).toBe(true);
  }
  expect(
    during.filter((row) => row.collect).every((row) => !row.emptyNotice),
    'P-615: the bankrupt notice stays down while COLLECT is up',
  ).toBe(true);

  const pressed = frames.filter((row) => row.at < collectedAt).at(-1);
  const after = frames.filter((row) => row.at >= collectedAt);
  if (!pressed) throw new Error('No frame was sampled before the COLLECT press');
  const reachedAt = after.findIndex((row) => row.plaque >= line);
  const reached = after[reachedAt];
  if (!reached) {
    throw new Error(
      `The plaque never counted up to the coin line ${String(line)}: ${report(after)}`,
    );
  }
  const shown = after.slice(reachedAt);
  const movedAt = shown.findIndex(
    (row, i) => row.inHand > pressed.inHand || (i > 0 && row.plaque < (shown[i - 1]?.plaque ?? 0)),
  );
  const moved = shown[movedAt];
  if (!moved) throw new Error(`The refill never reached the hand: ${report(after)}`);
  expect(
    moved.at - reached.at,
    `P-614: the plaque keeps the payout ${String(PLAQUE_HOLDS_MS)} ms before the refill moves: ${report(after)}`,
  ).toBeGreaterThanOrEqual(PLAQUE_HOLDS_MS);
  expect(
    shown.slice(0, movedAt).every((row) => row.plaque >= line),
    `the plaque stays at or above ${String(line)} until the refill: ${report(after)}`,
  ).toBe(true);

  const handover = shown.slice(movedAt);
  const plaques = new Set(handover.map((row) => row.plaque));
  const hands = new Set(handover.map((row) => row.inHand));
  const glyphs = handover.reduce((most, row) => Math.max(most, row.glyphs), 0);
  if (motion === 'full') {
    expect(
      glyphs,
      `coin glyphs fly from the plaque into the hand: ${report(handover)}`,
    ).toBeGreaterThan(0);
    expect(plaques.size, `the plaque counts down: ${report(handover)}`).toBeGreaterThan(2);
    expect(hands.size, `the hand counts up: ${report(handover)}`).toBeGreaterThan(2);
  } else {
    expect(
      frames.every((row) => row.glyphs === 0),
      'reduced motion flies no glyph',
    ).toBe(true);
  }

  const last = frames.at(-1);
  if (!last) throw new Error('No frame was sampled');
  const falls = counts.creditedCoins - creditedAtOpen;
  expect(
    last.plaque + last.inHand,
    `plaque + hand after the handover is the total before COLLECT plus the coin line and the falls credited since the crate opened (${String(falls)})`,
  ).toBe(pressed.plaque + pressed.inHand + line + falls);
}

test.describe('crate payout handover (P-614, P-615)', () => {
  test('an emptied Vault shows the crate payout, then hands the refill into the hand', async ({
    page,
  }) => {
    test.setTimeout(360_000);
    await expectPayoutHandover(page, 'full');
  });

  test('reduced motion cross-fades the refill with no glyph flight', async ({ page }) => {
    test.setTimeout(360_000);
    await expectPayoutHandover(page, 'reduced');
  });
});
