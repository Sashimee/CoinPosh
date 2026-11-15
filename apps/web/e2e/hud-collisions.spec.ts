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
  railRect: Rect;
}

interface Sample {
  t: number;
  credits: number;
  stamp: string | null;
  rails: RailSample[];
  plaque: Rect | null;
  pearl: Rect | null;
  chips: { id: string; rect: Rect }[];
}

const LANES = [0.5, 0.3, 0.7, 0.4, 0.6, 0.35, 0.65];
const BANNERS = 2;
const CREDITS = 3;
const MAX_TAPS = 160;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.use({ viewport: { width: 390, height: 844 } });

test('the cascade rail never widens empty and the Vault pulse never reaches the purse', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await bootGame(page);

  await page.evaluate(() => {
    const w = window as unknown as { __hudSamples: unknown[] };
    w.__hudSamples = [];
    const rectOf = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return null;
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    };
    const visible = (el: Element | null): el is HTMLElement =>
      el instanceof HTMLElement && !el.hidden && el.closest('[hidden]') === null;
    const started = performance.now();
    setInterval(() => {
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
      const stamp = document.querySelector('[data-testid=hud-tier-stamp]');
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
        .filter((chip) => chip.rect !== null);
      w.__hudSamples.push({
        t: Math.round(performance.now() - started),
        credits: window.__coinposh?.counts.credits ?? 0,
        stamp: stamp?.classList.contains('is-visible') ? stamp.textContent : null,
        rails,
        plaque: rectOf(document.querySelector('[data-testid=hud-balance]')),
        pearl: visible(pearl) ? rectOf(pearl) : null,
        chips,
      });
    }, 100);
  });

  const read = (): Promise<Sample[]> =>
    page.evaluate(() => (window as unknown as { __hudSamples: Sample[] }).__hudSamples);
  const bannersSeen = (samples: readonly Sample[]): number =>
    samples.filter((s, i) => s.stamp !== null && (samples[i - 1]?.stamp ?? null) === null).length;

  const stage = await page.locator('#stage').boundingBox();
  if (!stage) throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
  const startCredits = (await read())[0]?.credits ?? 0;
  for (let tap = 0; tap < MAX_TAPS; tap += 1) {
    const lane = LANES[tap % LANES.length] ?? 0.5;
    await page.mouse.click(stage.x + stage.width * lane, stage.y + stage.height / 2);
    await page.waitForTimeout(450);
    const sofar = await read();
    const credits = (sofar.at(-1)?.credits ?? 0) - startCredits;
    if (bannersSeen(sofar) >= BANNERS && credits >= CREDITS) break;
  }
  await page.waitForTimeout(1500);
  const samples = await read();

  expect(bannersSeen(samples), 'Cascade banners seen while tapping').toBeGreaterThanOrEqual(
    BANNERS,
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
      if (rail.textRect) {
        expect(overlaps(rail.textRect, rail.railRect), `${at} shows text inside the box`).toBe(
          true,
        );
      }
    }
  }
  expect(widened, 'samples with a widened rail').toBeGreaterThan(0);

  for (const sample of samples) {
    if (!sample.plaque) continue;
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
});
