import type { Page } from '@playwright/test';
import { bootGame, expect, probe, refusedTotal, tapDrop, test } from './fixtures.ts';

/** P-639: the cadence and length of the run that saw honest front falls refused. */
const TAPS = 120;
const TAP_EVERY_MS = 260;
/** The seeded run is a handful of coins short of 0 after 120 taps, so it taps on into the stretch. */
const BANKRUPT_TAPS = 8;
const MAX_TAPS = 160;
const SETTLE_WITHIN_MS = 15_000;
/** How world.ts logs an `over_envelope` refusal of a fall claim. */
const FALL_REFUSAL_LOG = '[CoinPosh Demo] fall claim refused';

async function readDigits(page: Page, testId: string): Promise<number> {
  const text = await page.locator(`[data-testid=${testId}] .cp-sr-only`).textContent();
  const digits = text?.replace(/\D/g, '') ?? '';
  if (digits === '') throw new Error(`${testId} announced no number: "${text ?? ''}"`);
  return Number(digits);
}

/** A crate card owns the screen until it is collected, so a tap there would drop nothing. */
async function collectReveal(page: Page): Promise<boolean> {
  const collect = page.getByTestId('crate-collect');
  if ((await page.getByTestId('crate-reveal').count()) === 0) return false;
  if (await collect.isVisible()) await collect.click({ timeout: 2_000 }).catch(() => undefined);
  else await page.keyboard.press('Escape');
  return true;
}

test('P-639: 120 taps at 260 ms, bankrupt stretch included, pay every honest fall', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const refusals: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith(FALL_REFUSAL_LOG)) refusals.push(message.text());
  });
  await bootGame(page);

  let taps = 0;
  let bankruptTaps = 0;
  const next = { at: Date.now() };
  while ((taps < TAPS || bankruptTaps < BANKRUPT_TAPS) && taps < MAX_TAPS) {
    if (!(await collectReveal(page))) {
      await tapDrop(page);
      taps += 1;
      if (bankruptTaps > 0) bankruptTaps += 1;
      else if (
        (await page.getByTestId('hud-vault-empty').isVisible()) ||
        ((await readDigits(page, 'hud-balance')) === 0 &&
          (await readDigits(page, 'hud-in-hand')) === 0)
      ) {
        bankruptTaps = 1;
      }
    }
    next.at += TAP_EVERY_MS;
    await page.waitForTimeout(Math.max(0, next.at - Date.now()));
  }

  await expect
    .poll(
      async () => {
        await collectReveal(page);
        const { counts } = await probe(page);
        return counts.frontFalls - counts.credits - refusedTotal(counts);
      },
      { message: 'every front fall claim is answered', timeout: SETTLE_WITHIN_MS },
    )
    .toBeLessThanOrEqual(0);

  const { counts } = await probe(page);
  expect(counts.frontFalls, 'the run pushed coins off the front').toBeGreaterThan(0);
  expect(bankruptTaps, 'the run tapped on with the Vault and the hand at 0').toBeGreaterThanOrEqual(
    BANKRUPT_TAPS,
  );
  expect(refusals, 'the Demo server refused no fall claim as over_envelope').toEqual([]);
  expect(counts.refusedFalls, 'no fall claim was refused').toEqual({});
});
