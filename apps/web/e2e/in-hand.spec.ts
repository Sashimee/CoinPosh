import type { Page } from '@playwright/test';
import { bootGame, expect, reviewShot, tapDrop, test } from './fixtures.ts';

/** P-749: the in-hand chip answers every drop, and the Vault's refill flies into it. */
const TAPS = 10;
const TAP_EVERY_MS = 420;
const ANSWER_WITHIN_MS = 150;
/** A refill glyph takes off once the table reports the refill, well inside this. */
const GLYPH_WITHIN_MS = 400;
/** The chip's landing spring and the plaque's pulse can shift either coin by a few pixels. */
const FLIGHT_END_SLACK_PX = 8;
/** Far enough into the 300 ms refill flight that the glyph has faded in and the count has rolled. */
const SHOT_MID_FLIGHT_MS = 180;

interface ChipChange {
  readonly at: number;
  /** The count the chip shows. */
  readonly digits: string;
  /** What the chip tells screen readers: the hand as the table reported it, at once. */
  readonly reported: string;
  readonly classes: string;
}

interface Flight {
  readonly at: number;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly vault: { readonly x: number; readonly y: number };
  readonly chip: { readonly x: number; readonly y: number };
}

interface ChipLog {
  readonly taps: number[];
  readonly changes: ChipChange[];
  readonly flights: Flight[];
}

/** Logs each table tap, each visible change to the chip and each coin glyph that takes off. */
async function watchChip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('[data-testid=hud-in-hand]');
    const digits = chip?.querySelector('.cp-in-hand-value');
    const vaultCoin = document.querySelector(
      '[data-testid=hud-balance] .cp-plaque-amount .cp-icon',
    );
    const chipCoin = chip?.querySelector('.cp-icon');
    const spoken = chip?.querySelector('.cp-sr-only');
    if (!chip || !digits || !spoken || !vaultCoin || !chipCoin) {
      throw new Error(
        'The in-hand chip, its digits, its words or the Vault plaque coin is missing',
      );
    }
    const log: ChipLog = { taps: [], changes: [], flights: [] };
    (window as unknown as { __chip: ChipLog }).__chip = log;
    const middle = (el: Element): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const point = (frame: Keyframe | undefined): { x: number; y: number } => {
      const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(String(frame?.transform ?? ''));
      if (!match) throw new Error(`A glyph keyframe has no translate: ${String(frame?.transform)}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    };
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.target instanceof Element && event.target.closest('.cp-ui-host')) return;
        log.taps.push(performance.now());
      },
      { capture: true },
    );
    const read = (): ChipChange => ({
      at: performance.now(),
      digits: digits.textContent,
      reported: spoken.textContent,
      classes: chip.className,
    });
    new MutationObserver(() => {
      const change = read();
      const last = log.changes.at(-1);
      if (
        last?.digits === change.digits &&
        last.reported === change.reported &&
        last.classes === change.classes
      ) {
        return;
      }
      log.changes.push(change);
    }).observe(chip, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || node.dataset.testid !== 'hud-in-hand-glyph') {
            continue;
          }
          const effect = node.getAnimations()[0]?.effect;
          const frames = effect instanceof KeyframeEffect ? effect.getKeyframes() : [];
          log.flights.push({
            at: performance.now(),
            from: point(frames[0]),
            to: point(frames.at(-1)),
            vault: middle(vaultCoin),
            chip: middle(chipCoin),
          });
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
    log.changes.push(read());
  });
}

function readLog(page: Page): Promise<ChipLog> {
  return page.evaluate(() => (window as unknown as { __chip: ChipLog }).__chip);
}

async function tapTen(page: Page, shotAt?: { tap: number; name: string }): Promise<void> {
  const next = { at: Date.now() };
  for (let tap = 1; tap <= TAPS; tap += 1) {
    await expect(page.getByTestId('crate-reveal'), 'no crate card owns the screen').toHaveCount(0);
    await tapDrop(page);
    if (shotAt?.tap === tap) {
      await page.waitForFunction(
        () => document.querySelector('[data-testid=hud-in-hand-glyph]') !== null,
        null,
        { timeout: GLYPH_WITHIN_MS, polling: 16 },
      );
      // A SwiftShader frame can outlast the flight, so wait on the glyph's own clock.
      const midFlight = await page
        .waitForFunction(
          (ms) => {
            const flight = document
              .querySelector('[data-testid=hud-in-hand-glyph]')
              ?.getAnimations()[0];
            return Number(flight?.currentTime ?? 0) >= ms;
          },
          SHOT_MID_FLIGHT_MS,
          { timeout: 5_000, polling: 'raf' },
        )
        .then(() => true)
        .catch(() => false);
      if (!midFlight) {
        test.info().annotations.push({
          type: 'review shot',
          description: `${shotAt.name}: the glyph landed between two frames, so the shot shows the chip after it`,
        });
      }
      await reviewShot(page, shotAt.name);
      // A screenshot can take longer than the tap gap; catching up with back-to-back taps
      // would only meet the drop cooldown.
      next.at = Date.now();
    }
    next.at += TAP_EVERY_MS;
    await page.waitForTimeout(Math.max(0, next.at - Date.now()));
  }
}

/** For each tap, how long until the chip's digits or state changed, or null if it never did. */
function answers(log: ChipLog): (number | null)[] {
  return log.taps.map((at) => {
    const before = log.changes.filter((change) => change.at < at).at(-1);
    const after = log.changes.find(
      (change) =>
        change.at >= at && (change.digits !== before?.digits || change.classes !== before.classes),
    );
    return after ? Math.round(after.at - at) : null;
  });
}

/** How many times a count stepped down: one per coin a drop took from the hand. */
function drains(log: ChipLog, field: 'digits' | 'reported'): number {
  const counts = log.changes.map((change) => Number(change[field].replace(/\D/g, '')));
  return counts.filter((count, i) => i > 0 && count < (counts[i - 1] ?? 0)).length;
}

/** Counts the chip showed before the table had reported them: there must be none. */
function invented(log: ChipLog): string[] {
  const reported = new Set<string>();
  return log.changes.flatMap((change) => {
    reported.add(change.reported.replace(/\D/g, ''));
    return reported.has(change.digits) ? [] : [change.digits];
  });
}

/** A table under load can hand a drop and its refill to the UI in one frame, so not every
 * coin out shows as its own step. */
const MIN_DRAINS = TAPS / 2;

function timeline(log: ChipLog): string {
  const start = log.taps[0] ?? 0;
  const at = (ms: number): number => Math.round(ms - start);
  return JSON.stringify({
    taps: log.taps.map(at),
    changes: log.changes.map((c) => [at(c.at), c.reported.replace(/\D/g, ''), c.digits]),
  });
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

test.describe('in-hand chip (P-749)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('moves within 150 ms of each of the first 10 taps and the refill flies in from the Vault', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await bootGame(page);
    const chip = page.getByTestId('hud-in-hand');
    await expect(chip).toBeVisible();
    const full = await chip.locator('.cp-in-hand-value').textContent();
    await watchChip(page);

    await tapTen(page, { tap: 3, name: 'in-hand-refill-390x844' });

    const log = await readLog(page);
    expect(log.taps, 'every tap landed on the table').toHaveLength(TAPS);
    const delays = answers(log);
    expect(
      delays.every((ms) => ms !== null && ms <= ANSWER_WITHIN_MS),
      `the chip answers each tap within ${String(ANSWER_WITHIN_MS)} ms: ${JSON.stringify(delays)}`,
    ).toBe(true);
    expect(
      invented(log),
      `the chip shows only counts the table reported: ${timeline(log)}`,
    ).toEqual([]);
    expect(
      drains(log, 'reported'),
      `the table reported coins leaving the hand: ${timeline(log)}`,
    ).toBeGreaterThanOrEqual(MIN_DRAINS);
    expect(
      drains(log, 'digits'),
      `the shown count rolls down off ${String(full)} and the refill lands it back up: ${timeline(log)}`,
    ).toBeGreaterThanOrEqual(MIN_DRAINS);

    expect(log.flights.length, 'refills fly coin glyphs into the hand').toBeGreaterThanOrEqual(
      TAPS / 2,
    );
    for (const flight of log.flights) {
      expect(
        distance(flight.from, flight.vault),
        `the glyph takes off at the Vault coin: ${JSON.stringify(flight)}`,
      ).toBeLessThan(FLIGHT_END_SLACK_PX);
      expect(
        distance(flight.to, flight.chip),
        `the glyph lands on the chip coin: ${JSON.stringify(flight)}`,
      ).toBeLessThan(FLIGHT_END_SLACK_PX);
    }
    const firstTap = log.taps[0] ?? 0;
    expect(
      (log.flights[0]?.at ?? Infinity) - firstTap,
      'the first refill takes off soon after the first tap',
    ).toBeLessThan(GLYPH_WITHIN_MS);

    await expect(chip.locator('.cp-in-hand-value'), 'the hand ends refilled').toHaveText(
      full ?? '',
      { timeout: 3_000 },
    );
  });

  test('reduced motion answers each tap with a still gold rim and flies no glyph', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootGame(page);
    const chip = page.getByTestId('hud-in-hand');
    await expect(chip).toBeVisible();
    await watchChip(page);

    await tapTen(page);

    const log = await readLog(page);
    expect(log.taps).toHaveLength(TAPS);
    const delays = answers(log);
    expect(
      delays.every((ms) => ms !== null && ms <= ANSWER_WITHIN_MS),
      `the chip answers each tap within ${String(ANSWER_WITHIN_MS)} ms: ${JSON.stringify(delays)}`,
    ).toBe(true);
    expect(
      log.changes.filter((change) => change.reported.replace(/\D/g, '') !== change.digits),
      'with no flight to wait for, the shown count is the reported one at every change',
    ).toEqual([]);
    expect(
      drains(log, 'digits'),
      `the shown count steps down with the hand: ${timeline(log)}`,
    ).toBeGreaterThanOrEqual(MIN_DRAINS);
    expect(log.flights, 'reduced motion flies no glyph').toEqual([]);
    expect(
      log.changes.filter((change) => change.classes.includes('is-received-still')).length,
      'each refill lights the rim in place',
    ).toBeGreaterThanOrEqual(TAPS / 2);
  });
});

test.describe('in-hand chip review shots (P-749)', () => {
  for (const viewport of [
    { width: 360, height: 640 },
    { width: 1280, height: 800 },
  ]) {
    test(`a refill in flight at ${String(viewport.width)}x${String(viewport.height)}`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await bootGame(page);
      await expect(page.getByTestId('hud-in-hand')).toBeVisible();
      await tapTen(page, {
        tap: 2,
        name: `in-hand-refill-${String(viewport.width)}x${String(viewport.height)}`,
      });
    });
  }
});
