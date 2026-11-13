import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, probe, reviewShot, tapDrop, test } from './fixtures.ts';

const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
/** Card fly (520 ms in revealCard.ts) plus the cinematic's wrap-up and a frame or two of slack. */
const COLLECT_SETTLES_MS = 3_000;
/** A thumb's pace: fast enough to push the crate to the lip, slow enough to keep the queue short. */
const TAP_EVERY_MS = 400;

/**
 * How far into the unbox the veil shot freezes the page's frames: for full motion past the
 * crate's landing and the first shudder, for reduced motion after the first pulses. Both stay
 * short of the burst (2,000 and 720 ms in plan.ts), so the card cannot have come up yet.
 */
const VEIL_HOLD_AFTER_MS = { full: 1_200, reduced: 400 } as const;

type Motion = keyof typeof VEIL_HOLD_AFTER_MS;

/** A player who taps through the veil and one who presses Escape. */
type Skip = 'pointer' | 'escape';

declare global {
  interface Window {
    __crateTapGuard?: boolean;
    __veilHold?: { readonly held: boolean; release(): void };
  }
}

interface Unboxed {
  readonly rarity: string;
  readonly fairness: string;
}

async function crateCounts(page: Page): Promise<{ spawned: number; opened: number }> {
  const { counts } = await probe(page);
  return { spawned: counts.cratesSpawned, opened: counts.cratesOpened };
}

/** Taps until the server's scripted first-session crate lands on the table. */
async function dropUntilCrate(page: Page): Promise<void> {
  for (let i = 0; i < FTUE_DROP; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }
  await expect
    .poll(async () => (await crateCounts(page)).spawned, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
}

/** The longest the pusher may take to shove the scripted crate over the lip. */
const CRATE_OPENS_WITHIN_MS = 90_000;

/**
 * Keeps playing until the pusher shoves the crate over the lip and the reveal mounts. Any tap
 * on the open veil is a skip, and a drop tap already on its way when the reveal mounts would
 * land as one, so until `releaseTaps` the page drops pointer input that reaches an open reveal.
 */
async function playUntilRevealMounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__crateTapGuard = true;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      addEventListener(
        type,
        (event) => {
          if (!window.__crateTapGuard) return;
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
  for (;;) {
    try {
      await reveal.waitFor({ state: 'attached', timeout: TAP_EVERY_MS });
      return;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No crate reveal within ${String(CRATE_OPENS_WITHIN_MS)} ms of play: ${JSON.stringify(await crateCounts(page))}`,
      );
    }
    await tapDrop(page);
  }
}

const pagesHoldingVeil = new WeakSet<Page>();

/**
 * The cinematic runs on real frame time, and on SwiftShader one frame can last most of a
 * second, so the reduced veil (820 ms) is often gone before a screenshot or a key can land.
 * This parks the page's animation-frame callbacks once the open reveal has run
 * VEIL_HOLD_AFTER_MS of frames, until `__veilHold.release()`. Only frames that started before
 * that mark run, so the timeline stops short of the burst on any frame rate; input, timers and
 * the compositor carry on, so the skip under test is the real one.
 */
async function holdFramesAtVeil(page: Page): Promise<void> {
  if (pagesHoldingVeil.has(page)) return;
  pagesHoldingVeil.add(page);
  await page.addInitScript((holdAfterMs: Readonly<Record<string, number>>) => {
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const parked = new Map<number, FrameRequestCallback>();
    /** A released callback keeps the id the page holds, so cancelling it still works. */
    const rerouted = new Map<number, number>();
    const seen = new WeakSet<Element>();
    let lastFrameMs = 0;
    let holding = false;
    let veil: { readonly startMs: number; readonly holdAfterMs: number } | null = null;

    window.__veilHold = {
      get held() {
        return holding;
      },
      release() {
        holding = false;
        veil = null;
        for (const [id, callback] of parked) {
          rerouted.set(
            id,
            nativeRequest((now) => {
              rerouted.delete(id);
              lastFrameMs = now;
              callback(now);
            }),
          );
        }
        parked.clear();
      },
    };
    window.requestAnimationFrame = (callback) => {
      const id = nativeRequest((now) => {
        if (!holding && veil && now !== lastFrameMs && now - veil.startMs >= veil.holdAfterMs) {
          holding = true;
        }
        if (holding) {
          parked.set(id, callback);
          return;
        }
        lastFrameMs = now;
        callback(now);
      });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      parked.delete(id);
      nativeCancel(rerouted.get(id) ?? id);
      rerouted.delete(id);
    };
    new MutationObserver(() => {
      const root = document.querySelector('[data-testid="crate-reveal"]');
      if (!root || seen.has(root)) return;
      seen.add(root);
      const motion = root.getAttribute('data-motion') ?? '';
      const after = holdAfterMs[motion];
      if (after === undefined)
        throw new Error(`crate-reveal has an unknown data-motion "${motion}"`);
      veil = { startMs: lastFrameMs, holdAfterMs: after };
    }).observe(document, { childList: true, subtree: true });
  }, VEIL_HOLD_AFTER_MS);
}

async function releaseFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hold = window.__veilHold;
    if (!hold) throw new Error('The veil frame hold was never installed on this page');
    hold.release();
  });
}

async function releaseTaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__crateTapGuard = false;
  });
}

async function unbox(page: Page, motion: Motion, skip: Skip): Promise<Unboxed> {
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  await holdFramesAtVeil(page);
  await bootGame(page);
  await dropUntilCrate(page);
  await playUntilRevealMounts(page);

  const reveal = page.getByTestId('crate-reveal');
  await releaseTaps(page);
  await page.waitForFunction(() => window.__veilHold?.held === true, null, {
    timeout: 15_000,
    polling: 16,
  });
  await expect(reveal).toBeVisible();
  await expect(reveal).toHaveAttribute('data-motion', motion);
  await expect(reveal).toHaveAttribute('role', 'dialog');
  await expect(reveal, 'the card waits behind the veil').not.toHaveClass(/is-revealed/);
  await expect(reveal.locator('.cp-crate-skip')).toBeVisible();
  await expect(reveal.locator('.cp-crate-card')).toBeHidden();
  expect((await crateCounts(page)).opened).toBe(1);
  await reviewShot(page, `crate-veil-${motion}`);

  if (skip === 'pointer') {
    await page.mouse.click(20, 400);
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(reveal, `a ${skip} skip brings the card up at once`).toHaveClass(/is-revealed/);
  expect((await probe(page)).counts.cratesCollected, 'a skip only reveals, never collects').toBe(0);
  await releaseFrames(page);
  await expect(reveal.locator('.cp-crate-skip')).toBeHidden();
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible();
  if (skip === 'escape') {
    await expect(collect, 'a keyboard skip hands focus to Collect').toBeFocused();
  } else {
    // A pointer skip lands focus on the dialog root, not Collect: the mousedown that follows
    // the pointerdown refocuses the tabindex=-1 root.
    expect(await reveal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await expect(reveal.locator('.cp-crate-line').first()).toBeVisible();
  await reveal.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) =>
          // A cancelled animation rejects `finished` with AbortError; it has settled all the same.
          a.finished.then(
            () => undefined,
            (error: unknown) => {
              if (error instanceof DOMException && error.name === 'AbortError') return;
              throw error;
            },
          ),
        ),
    ),
  );
  await reviewShot(page, `crate-card-${motion}`);

  const fair = reveal.getByTestId('crate-fair');
  const commitment = (await fair.getAttribute('title')) ?? '';
  expect(commitment, 'the seal shows the committed server seed hash').toMatch(/^[0-9a-f]{64}$/);
  const nonce =
    (await fair.locator('.cp-crate-fair-nonce').textContent())?.replace(/\D/g, '') ?? '';
  expect(nonce, 'the seal shows the roll nonce').toMatch(/^\d+$/);
  const unboxed: Unboxed = {
    rarity: (await reveal.getAttribute('data-rarity')) ?? '',
    fairness: `${commitment} · ${nonce}`,
  };
  expect(unboxed.rarity).not.toBe('');

  // A slow runner taps long enough to reach the next scheduled crate, whose reveal mounts as soon
  // as this one leaves, so the check follows this crate's reveal rather than any reveal.
  const collected = await reveal.elementHandle();
  // The reduced-motion collect fade lasts 160 ms, shorter than a loaded runner's poll can
  // reliably catch, so the collecting state is recorded the moment the class lands.
  const [fly] = await Promise.all([
    reveal.evaluate(
      (root) =>
        new Promise<{ x: string; y: string }>((resolve, reject) => {
          const card = root.querySelector<HTMLElement>('.cp-crate-card');
          if (!card) {
            reject(new Error('The crate reveal has no .cp-crate-card to collect'));
            return;
          }
          const observer = new MutationObserver(() => {
            if (!root.classList.contains('is-collecting')) return;
            observer.disconnect();
            resolve({
              x: card.style.getPropertyValue('--cp-crate-fly-x'),
              y: card.style.getPropertyValue('--cp-crate-fly-y'),
            });
          });
          observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        }),
    ),
    collect.click(),
  ]);
  if (motion === 'full') {
    expect(fly.x).toMatch(/^-?\d+px$/);
    expect(fly.y).toMatch(/^-?\d+px$/);
    expect(Number.parseInt(fly.y, 10), 'the card flies up to the inventory').toBeLessThan(0);
  } else {
    expect(fly, 'reduced motion fades the card in place').toEqual({ x: '', y: '' });
  }
  await expect
    .poll(() => collected.evaluate((el) => el.isConnected), {
      message: 'the collected crate reveal leaves the page',
      timeout: COLLECT_SETTLES_MS,
    })
    .toBe(false);
  await collected.dispose();
  expect((await probe(page)).counts.cratesCollected).toBe(1);
  return unboxed;
}

/** The unbox on the shipped Demo Mode game: real taps, sim, pusher, crate controller and card. */
test.describe('crate unbox (P-183)', () => {
  test('a falling crate opens, a tap skips the veil to the card, Collect flies it to the inventory', async ({
    page,
  }) => {
    await unbox(page, 'full', 'pointer');
  });

  test('reduced motion keeps the flow without the fly, Escape skips the veil, and the seeded server repeats the roll', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const reduced = await unbox(page, 'reduced', 'escape');
    const full = await unbox(page, 'full', 'escape');
    expect(full, 'same Demo seed, same crate roll and fairness commitment').toEqual(reduced);
  });
});
