import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { bootGame, expect, probe, reviewShot, tapDrop, test } from './fixtures.ts';

const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
/** Card fly (520 ms in revealCard.ts) plus the cinematic's wrap-up and a frame or two of slack. */
const COLLECT_SETTLES_MS = 3_000;
/** A thumb's pace: fast enough to push the crate to the lip, slow enough to keep the queue short. */
const TAP_EVERY_MS = 400;

declare global {
  interface Window {
    __crateTapGuard?: boolean;
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

async function releaseTaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__crateTapGuard = false;
  });
}

async function unbox(page: Page, motion: 'full' | 'reduced'): Promise<Unboxed> {
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  await bootGame(page);
  await dropUntilCrate(page);
  await playUntilRevealMounts(page);

  const reveal = page.getByTestId('crate-reveal');
  await releaseTaps(page);
  if (motion === 'full') {
    const veil = await reveal.evaluate((root) => ({
      revealed: root.classList.contains('is-revealed'),
      skip: root.querySelector('.cp-crate-skip')?.checkVisibility() ?? false,
    }));
    await page.mouse.click(20, 400);
    expect(veil, 'the full-motion card opens behind a veil with a skip hint').toEqual({
      revealed: false,
      skip: true,
    });
  }
  expect((await crateCounts(page)).opened).toBe(1);
  await expect(reveal).toBeVisible();
  await expect(reveal).toHaveAttribute('data-motion', motion);
  await expect(reveal).toHaveAttribute('role', 'dialog');
  // The reduced veil reveals by itself 820 ms in (plan.ts), sooner than a SwiftShader runner can
  // reliably land a skip, so a key pressed then would already collect the card.
  await expect(reveal).toHaveClass(/is-revealed/);
  await expect(reveal.locator('.cp-crate-skip')).toBeHidden();
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible();
  if (motion === 'reduced') {
    await expect(collect, 'the revealed card hands focus to Collect').toBeFocused();
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
  await expect(reveal).toHaveCount(0, { timeout: COLLECT_SETTLES_MS });
  expect((await probe(page)).counts.cratesCollected).toBe(1);
  return unboxed;
}

/** The unbox on the shipped Demo Mode game: real taps, sim, pusher, crate controller and card. */
test.describe('crate unbox (P-183)', () => {
  test('a falling crate opens, the veil skips to the card, Collect flies it to the inventory', async ({
    page,
  }) => {
    await unbox(page, 'full');
  });

  test('reduced motion keeps the flow without the fly, and the seeded server repeats the roll', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const reduced = await unbox(page, 'reduced');
    const full = await unbox(page, 'full');
    expect(full, 'same Demo seed, same crate roll and fairness commitment').toEqual(reduced);
  });
});
