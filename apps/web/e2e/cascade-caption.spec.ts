import { bootGame, expect, test } from './fixtures.ts';

/**
 * P-764: the Cascade card's rank name, swollen on a rank-up, never leaves the card's padding box,
 * where the card would clip its first letters.
 */

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Sample {
  t: number;
  rank: number;
  name: string;
  scale: number;
  tier: Rect;
  pad: Rect;
}

interface Progress {
  samples: Sample[];
  rankUps: number;
  peakScale: number;
}

const LANES = [0.5, 0.3, 0.7, 0.4, 0.6, 0.35, 0.65];
const RANK_UPS = 2;
const MAX_TAPS = 160;
/** Long enough for the rank-up swell, and a hold's replayed swell, to play out after the tap. */
const SETTLE_MS = 2500;
const EPSILON = 0.5;

const SCREENS = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
] as const;

for (const viewport of SCREENS) {
  test.describe(`DE ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, locale: 'de-DE' });

    test('the swollen rank name stays inside the Cascade card through two rank-ups', async ({
      page,
    }) => {
      test.setTimeout(300_000);
      await bootGame(page);

      await page.evaluate(() => {
        const w = window as unknown as { __caption: Progress };
        const progress: Progress = { samples: [], rankUps: 0, peakScale: 1 };
        w.__caption = progress;
        const rail = document.querySelector<HTMLElement>('[data-testid=hud-combo]');
        const card = rail?.querySelector<HTMLElement>('.cp-rail-card');
        const tier = rail?.querySelector<HTMLElement>('.cp-combo-tier');
        if (!rail || !card || !tier) throw new Error('The HUD has no Cascade card to sample');
        let rank = Number(rail.dataset.rank ?? '0');
        new MutationObserver(() => {
          const next = Number(rail.dataset.rank ?? '0');
          if (next > rank) progress.rankUps += 1;
          rank = next;
        }).observe(rail, { attributes: true, attributeFilter: ['data-rank'] });

        const started = performance.now();
        const sample = (): void => {
          if (rail.hidden || rail.closest('[hidden]') !== null) return;
          const railBox = rail.getBoundingClientRect();
          const spine = Number.parseFloat(getComputedStyle(rail).getPropertyValue('--cp-rail-w'));
          if (!(railBox.width >= spine + 1) || Number(getComputedStyle(card).opacity) === 0) return;
          const box = card.getBoundingClientRect();
          const name = tier.getBoundingClientRect();
          if (name.width === 0) return;
          const scale = tier.style.scale ? Number(tier.style.scale) : 1;
          progress.peakScale = Math.max(progress.peakScale, scale);
          progress.samples.push({
            t: Math.round(performance.now() - started),
            rank: Number(rail.dataset.rank ?? '0'),
            name: tier.textContent,
            scale,
            tier: { left: name.left, top: name.top, right: name.right, bottom: name.bottom },
            pad: {
              left: box.left + card.clientLeft,
              top: box.top + card.clientTop,
              right: box.left + card.clientLeft + card.clientWidth,
              bottom: box.top + card.clientTop + card.clientHeight,
            },
          });
        };
        setInterval(sample, 50);
        // A swell lasts a few frames, so the name is also sampled on every frame it restyles.
        new MutationObserver(sample).observe(tier, {
          attributes: true,
          attributeFilter: ['style'],
        });
      });

      const read = (): Promise<Progress> =>
        page.evaluate(() => (window as unknown as { __caption: Progress }).__caption);

      const stage = await page.locator('#stage').boundingBox();
      if (!stage)
        throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
      const collect = page.getByTestId('crate-collect');
      const reveal = page.getByTestId('crate-reveal');
      for (let tap = 0; tap < MAX_TAPS; tap += 1) {
        if ((await read()).rankUps >= RANK_UPS) break;
        if (await collect.isVisible()) {
          await expect(reveal).toHaveClass(/is-revealed/, { timeout: 30_000 });
          await collect.click();
          await expect(collect, 'the collected crate card leaves').toBeHidden({ timeout: 5_000 });
        } else {
          const lane = LANES[tap % LANES.length] ?? 0.5;
          await page.mouse.click(stage.x + stage.width * lane, stage.y + stage.height / 2);
        }
        await page.waitForTimeout(450);
      }
      await page.waitForTimeout(SETTLE_MS);
      const { samples, rankUps, peakScale } = await read();

      expect(rankUps, 'Cascade rank-ups seen while tapping').toBeGreaterThanOrEqual(RANK_UPS);
      expect(peakScale, 'a sample caught the rank name mid-swell').toBeGreaterThan(1.05);
      for (const s of samples) {
        const at = `"${s.name}" at ${s.t} ms (rank ${s.rank}, scale ${s.scale.toFixed(3)})`;
        expect(s.tier.left, `${at} left edge`).toBeGreaterThanOrEqual(s.pad.left - EPSILON);
        expect(s.tier.right, `${at} right edge`).toBeLessThanOrEqual(s.pad.right + EPSILON);
        expect(s.tier.top, `${at} top edge`).toBeGreaterThanOrEqual(s.pad.top - EPSILON);
        expect(s.tier.bottom, `${at} bottom edge`).toBeLessThanOrEqual(s.pad.bottom + EPSILON);
      }
    });
  });
}
