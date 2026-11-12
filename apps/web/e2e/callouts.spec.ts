import type { Page } from '@playwright/test';
import { bootGame, expect, reviewShot, tapDrop, test } from './fixtures.ts';

/** The HUD callouts that share the one announcement slot (apps/web/src/ui/components/announcementSlot.ts). */
const CALLOUTS = {
  'upgrade-notice': '[data-testid="hud-upgrade-hint"]',
  'hud-tier-stamp': '[data-testid="hud-tier-stamp"]',
  'crate-hint': '[data-testid="crate-hint"]',
} as const;

type CalloutName = keyof typeof CALLOUTS;

/** The playtest's thumb: a drop every 0.45 s. */
const TAP_EVERY_MS = 450;
/** The FTUE crate opens about 17 s and 36 taps in; SwiftShader on a loaded runner is slower. */
const FIRST_OPEN_WITHIN_MS = 90_000;

interface CalloutWatch {
  frames: number;
  worst: number;
  worstAt: string[];
  seen: Record<string, number>;
  done: boolean;
}

declare global {
  interface Window {
    __callouts?: CalloutWatch;
    __coinposh?: { readonly counts: { readonly cratesOpened: number } };
  }
}

/**
 * Samples, from now until the first crate:opened, every rendered frame and every DOM change in
 * between: which callouts are on screen, the most at once, and how often each showed up.
 * SwiftShader renders only a few frames a second, so the DOM changes are what make sure no
 * state a real phone would paint goes unseen.
 */
function watchCallouts(page: Page): Promise<void> {
  return page.evaluate((selectors) => {
    const watch: CalloutWatch = { frames: 0, worst: 0, worstAt: [], seen: {}, done: false };
    window.__callouts = watch;
    const shown = (el: Element | null): boolean => {
      if (!(el instanceof HTMLElement) || el.hidden) return false;
      const box = el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    };
    const was = new Set<string>();
    const sample = (): void => {
      if (watch.done) return;
      watch.frames += 1;
      const up = Object.entries(selectors)
        .filter(([, selector]) => shown(document.querySelector(selector)))
        .map(([name]) => name);
      for (const name of up) {
        if (!was.has(name)) watch.seen[name] = (watch.seen[name] ?? 0) + 1;
      }
      was.clear();
      for (const name of up) was.add(name);
      if (up.length > watch.worst) {
        watch.worst = up.length;
        watch.worstAt = up;
      }
      if ((window.__coinposh?.counts.cratesOpened ?? 0) > 0) {
        watch.done = true;
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style'],
    });
    const frame = (): void => {
      sample();
      if (!watch.done) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, CALLOUTS);
}

function readWatch(page: Page): Promise<CalloutWatch> {
  return page.evaluate(() => {
    const watch = window.__callouts;
    if (!watch) throw new Error('The callout watch was never installed on this page');
    return { ...watch, seen: { ...watch.seen }, worstAt: [...watch.worstAt] };
  });
}

test('the HUD keeps one announcement slot from the first tap to the first crate', async ({
  page,
}) => {
  test.setTimeout(FIRST_OPEN_WITHIN_MS + 90_000);
  await bootGame(page);

  await tapDrop(page);
  await watchCallouts(page);
  let shot = false;
  const deadline = Date.now() + FIRST_OPEN_WITHIN_MS;
  while (!(await readWatch(page)).done) {
    if (Date.now() > deadline) {
      throw new Error(
        `No crate opened within ${FIRST_OPEN_WITHIN_MS} ms of the first tap, so the run never reached the moment this spec guards`,
      );
    }
    if (!shot && (await page.locator(CALLOUTS['crate-hint']).isVisible())) {
      shot = true;
      await reviewShot(page, 'callouts-crate-hint');
    }
    await tapDrop(page);
    await page.waitForTimeout(TAP_EVERY_MS);
  }

  const watch = await readWatch(page);
  const seen = (name: CalloutName) => watch.seen[name] ?? 0;
  expect(watch.frames, 'frames sampled between the first tap and the first open').toBeGreaterThan(
    30,
  );
  expect(seen('crate-hint'), 'the first crate announced itself').toBeGreaterThan(0);
  expect(
    watch.worst,
    `at most two callouts share a frame; the worst frame showed ${watch.worstAt.join(' + ')}`,
  ).toBeLessThanOrEqual(2);
  test.info().annotations.push({
    type: 'callout frames',
    description: JSON.stringify({ frames: watch.frames, worst: watch.worstAt, seen: watch.seen }),
  });
});
