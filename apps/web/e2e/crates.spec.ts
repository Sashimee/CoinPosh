import type { Page } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { CRATE_HARNESS_URL } from './env.ts';
import { expect, reviewShot, test } from './fixtures.ts';

const FTUE_DROP = economyConfig.crateSpawn.ftueScriptedDrop;
/** Card fly (520 ms in revealCard.ts) plus the cinematic's wrap-up and a frame or two of slack. */
const COLLECT_SETTLES_MS = 3_000;

interface Unboxed {
  readonly rarity: string;
  readonly fairness: string;
}

async function openHarness(page: Page, motion: 'full' | 'reduced'): Promise<void> {
  await page.goto(`${CRATE_HARNESS_URL}${motion === 'reduced' ? '?motion=reduced' : ''}`);
  await page.waitForFunction(() => window.__crates?.ready === true);
}

function crateLog(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window.__crates?.log ?? [])]);
}

/** Drops coins until the server's scripted first-session crate lands on the table. */
async function dropUntilCrate(page: Page): Promise<void> {
  for (let i = 0; i < FTUE_DROP; i += 1) {
    expect(await page.evaluate(() => window.__crates?.drop())).toBe(true);
    await page.waitForTimeout(120);
  }
  await expect.poll(() => crateLog(page), { timeout: 15_000 }).toContain('crate:spawned');
}

/** Nudges the table forward until the crate goes over the lip and the server opens it. */
async function tipCrateOver(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__crates?.nudgeForward());
        return crateLog(page);
      },
      { timeout: 45_000, intervals: [250] },
    )
    .toContain('crate:fell');
  await expect.poll(() => crateLog(page), { timeout: 15_000 }).toContain('crate:opened');
}

async function unbox(page: Page, motion: 'full' | 'reduced'): Promise<Unboxed> {
  await openHarness(page, motion);
  await dropUntilCrate(page);
  await tipCrateOver(page);

  const reveal = page.getByTestId('crate-reveal');
  await expect(reveal).toBeVisible();
  await expect(reveal).toHaveAttribute('data-motion', motion);
  await expect(reveal).toHaveAttribute('role', 'dialog');
  await expect(reveal).not.toHaveClass(/is-revealed/);
  await expect(reveal.locator('.cp-crate-skip')).toBeVisible();
  await reviewShot(page, `crate-veil-${motion}`);

  if (motion === 'full') {
    await page.mouse.click(20, 400);
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(reveal).toHaveClass(/is-revealed/);
  await expect(reveal.locator('.cp-crate-skip')).toBeHidden();
  const collect = page.getByTestId('crate-collect');
  await expect(collect).toBeVisible();
  if (motion === 'reduced') {
    await expect(collect, 'a keyboard skip hands focus to Collect').toBeFocused();
  } else {
    // A pointer skip lands focus on the dialog root, not Collect: the mousedown that follows
    // the pointerdown refocuses the tabindex=-1 root.
    expect(await reveal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await expect(reveal.locator('.cp-crate-line').first()).toBeVisible();
  expect(await crateLog(page)).toContain('crate:revealed');
  await reveal.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
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
  expect(await crateLog(page)).toContain('crate:collected');
  return unboxed;
}

test.describe('crate unbox (P-183)', () => {
  test('a falling crate opens, the veil skips to the card, Collect flies it to the inventory', async ({
    page,
  }) => {
    await unbox(page, 'full');
  });

  test('reduced motion keeps the flow without the fly, and the seeded server repeats the roll', async ({
    page,
  }) => {
    const reduced = await unbox(page, 'reduced');
    const full = await unbox(page, 'full');
    expect(full, 'same Demo seed, same crate roll and fairness commitment').toEqual(reduced);
  });
});
