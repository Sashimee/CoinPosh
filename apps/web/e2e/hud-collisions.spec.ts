import { bootGame, expect, test } from './fixtures.ts';

/**
 * P-684: during a cascade the Cascade rail must never widen into an empty lacquer card, and the
 * Vault plaque's credit pulse must never reach the pearl chip (or any other purse readout).
 */

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface RailSample {
  side: string;
  width: number;
  spine: number;
  text: string;
  opacity: number;
  textRect: Rect | null;
  railRect: Rect | null;
}

interface Sample {
  t: number;
  credits: number;
  rails: RailSample[];
  plaque: Rect | null;
  plaqueScale: number;
  pearl: Rect | null;
  chips: { id: string; rect: Rect }[];
}

interface Progress {
  samples: Sample[];
  banners: number;
  pearlCredits: number;
}

const LANES = [0.5, 0.3, 0.7, 0.4, 0.6, 0.35, 0.65];
const BANNERS = 2;
const CREDITS = 3;
const PEARL_CREDITS = 3;
const MAX_TAPS = 160;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.use({ viewport: { width: 390, height: 844 } });

test('the cascade rail never widens empty and the Vault pulse never reaches the purse', async ({
  page,
}) => {
  test.setTimeout(360_000);
  await bootGame(page);

  await page.evaluate(() => {
    const w = window as unknown as { __hud: Progress };
    w.__hud = { samples: [], banners: 0, pearlCredits: 0 };
    const rectOf = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return null;
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    };
    const visible = (el: Element | null): el is HTMLElement =>
      el instanceof HTMLElement && !el.hidden && el.closest('[hidden]') === null;
    const started = performance.now();
    let lastCredits: number | null = null;
    const sample = (): void => {
      const rails = [...document.querySelectorAll<HTMLElement>('.cp-rail')]
        .filter((rail) => visible(rail))
        .map((rail) => {
          const card = rail.querySelector<HTMLElement>('.cp-rail-card');
          const text = rail.querySelector<HTMLElement>('.cp-rail-text');
          return {
            side: rail.dataset.side ?? '',
            width: rail.getBoundingClientRect().width,
            spine: Number.parseFloat(getComputedStyle(rail).getPropertyValue('--cp-rail-w')),
            text: (card?.innerText ?? '').trim(),
            opacity: card ? Number(getComputedStyle(card).opacity) : 0,
            textRect: rectOf(text),
            railRect: rectOf(rail),
          };
        });
      const plaque = document.querySelector<HTMLElement>('[data-testid=hud-balance]');
      const pearl = document.querySelector('[data-testid=hud-wallet-pearls]');
      const chips = [
        ...document.querySelectorAll<HTMLElement>(
          '.cp-wallet-chip, .cp-plaque-wrap > .cp-chip-bars',
        ),
      ]
        .filter((chip) => visible(chip))
        .map((chip) => ({
          id: chip.dataset.testid ?? chip.className,
          rect: rectOf(chip),
        }))
        .filter((chip): chip is { id: string; rect: Rect } => chip.rect !== null);
      const credits = window.__coinposh?.counts.credits ?? 0;
      const pearlRect = visible(pearl) ? rectOf(pearl) : null;
      if (pearlRect && lastCredits !== null && credits > lastCredits) {
        w.__hud.pearlCredits += credits - lastCredits;
      }
      lastCredits = credits;
      w.__hud.samples.push({
        t: Math.round(performance.now() - started),
        credits,
        rails,
        plaque: rectOf(plaque),
        plaqueScale: plaque?.style.scale ? Number(plaque.style.scale) : 1,
        pearl: pearlRect,
        chips,
      });
    };

    // tierStamp re-stamps a ribbon that is still showing (a chained rank-up lands inside its
    // hold), so a banner counts on every fresh stamp: the card snaps back to opacity 0 to land
    // again, or its tier changes, not only when the layer turns visible.
    const stamp = document.querySelector<HTMLElement>('[data-testid=hud-tier-stamp]');
    const card = stamp?.querySelector<HTMLElement>('.cp-stamp-card');
    if (!stamp || !card) throw new Error('The HUD has no tier stamp to count Cascade banners on');
    let wasVisible = stamp.classList.contains('is-visible');
    let tier = stamp.dataset.tier ?? '';
    new MutationObserver((records) => {
      const isVisible = stamp.classList.contains('is-visible');
      const relanded =
        card.style.opacity === '0' &&
        records.some((record) => record.target === card && record.attributeName === 'style');
      const retiered = (stamp.dataset.tier ?? '') !== tier;
      if (isVisible && (!wasVisible || relanded || retiered)) w.__hud.banners += 1;
      wasVisible = isVisible;
      tier = stamp.dataset.tier ?? '';
    }).observe(stamp, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-tier'],
    });

    // The pulse lasts a few frames, so the plaque is also sampled on every frame it restyles.
    const pulsing = document.querySelector('[data-testid=hud-balance]');
    if (!pulsing) throw new Error('The HUD has no Vault plaque to sample');
    new MutationObserver(sample).observe(pulsing, { attributes: true, attributeFilter: ['style'] });
    setInterval(sample, 100);
  });

  const read = (): Promise<Progress> =>
    page.evaluate(() => (window as unknown as { __hud: Progress }).__hud);

  const stage = await page.locator('#stage').boundingBox();
  if (!stage) throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
  const startCredits = (await read()).samples[0]?.credits ?? 0;
  const reveal = page.getByTestId('crate-reveal');
  const collect = page.getByTestId('crate-collect');
  for (let tap = 0; tap < MAX_TAPS; tap += 1) {
    const lane = LANES[tap % LANES.length] ?? 0.5;
    // A crate pays its pearl into the purse only once it is collected, and its card holds the
    // table until then.
    if (await collect.isVisible()) {
      await expect(reveal).toHaveClass(/is-revealed/, { timeout: 30_000 });
      await collect.click();
      await expect(collect, 'the collected crate card leaves').toBeHidden({ timeout: 5_000 });
    } else {
      await page.mouse.click(stage.x + stage.width * lane, stage.y + stage.height / 2);
    }
    await page.waitForTimeout(450);
    const sofar = await read();
    const credits = (sofar.samples.at(-1)?.credits ?? 0) - startCredits;
    if (sofar.banners >= BANNERS && credits >= CREDITS && sofar.pearlCredits >= PEARL_CREDITS) {
      break;
    }
  }
  await page.waitForTimeout(1500);
  const { samples, banners, pearlCredits } = await read();

  expect(banners, 'Cascade banners seen while tapping').toBeGreaterThanOrEqual(BANNERS);
  expect(pearlCredits, 'credits landed while the pearl chip shows').toBeGreaterThanOrEqual(
    PEARL_CREDITS,
  );
  expect((samples.at(-1)?.credits ?? 0) - startCredits, 'credits landed').toBeGreaterThanOrEqual(
    CREDITS,
  );

  let widened = 0;
  for (const sample of samples) {
    for (const rail of sample.rails) {
      if (!(rail.width >= rail.spine + 8)) continue;
      widened += 1;
      const at = `${rail.side} rail at ${sample.t} ms, ${rail.width.toFixed(1)} px wide`;
      expect(rail.text, `${at} has card text`).not.toBe('');
      expect(rail.opacity, `${at} shows its card`).toBeGreaterThan(0);
      expect(rail.textRect, `${at} lays out its text`).not.toBeNull();
      if (rail.textRect && rail.railRect) {
        expect(overlaps(rail.textRect, rail.railRect), `${at} shows text inside the box`).toBe(
          true,
        );
      }
    }
  }
  expect(widened, 'samples with a widened rail').toBeGreaterThan(0);

  let pearlBesidePulse = 0;
  for (const sample of samples) {
    if (!sample.plaque) continue;
    if (sample.pearl && sample.plaqueScale > 1) pearlBesidePulse += 1;
    if (sample.pearl) {
      expect(
        overlaps(sample.pearl, sample.plaque),
        `pearl chip under the plaque at ${sample.t} ms`,
      ).toBe(false);
    }
    for (const chip of sample.chips) {
      expect(
        overlaps(chip.rect, sample.plaque),
        `${chip.id} under the plaque at ${sample.t} ms`,
      ).toBe(false);
    }
  }
  expect(pearlBesidePulse, 'samples with the pearl chip beside a pulsing plaque').toBeGreaterThan(
    0,
  );
});
