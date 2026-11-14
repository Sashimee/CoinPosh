import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { bootGame, expect, reviewShot, test, unexpectedErrors, vaultBalance } from './fixtures.ts';

const STORAGE_KEY = 'coinposh.settings.v1';

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTestId('dock-settings').click();
  const sheet = page.getByTestId('sheet-settings');
  await expect(sheet).toBeVisible();
  return sheet;
}

function option(sheet: Locator, group: string, value: string): Locator {
  return sheet.getByTestId(group).locator(`[role=radio][data-value="${value}"]`);
}

async function savedSettings(page: Page): Promise<unknown> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

test.describe('settings (P-54)', () => {
  test('every setting survives a reload, and the language reaches the whole UI', async ({
    page,
  }) => {
    await bootGame(page, { query: '?quality=low' });
    let sheet = await openSettings(page);

    await sheet.getByTestId('settings-volume-music').fill('35');
    await sheet.getByTestId('settings-volume-sfx').fill('60');
    await sheet.getByTestId('settings-mono').click();
    await sheet.getByTestId('settings-haptics').click();
    await option(sheet, 'settings-motion', 'reduced').click();
    await option(sheet, 'settings-quality', 'low').click();
    await option(sheet, 'settings-language', 'fr').click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByTestId('dock-settings')).toHaveAttribute('aria-label', 'Réglages');
    await expect(
      sheet.getByTestId('account-section'),
      'the French account strings load into the open section',
    ).toContainText('Garder ma progression');
    await expect
      .poll(() => savedSettings(page), { message: 'the debounced save lands' })
      .toMatchObject({
        volumes: { music: 0.35, sfx: 0.6 },
        mono: true,
        haptics: false,
        motion: 'reduced',
        quality: 'low',
        language: 'fr',
      });

    await page.reload();
    await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
      timeout: 60_000,
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('#coinposh-demo-banner')).toBeVisible();
    await expect(page.locator('.cp-ui-host')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('.cp-ui-host')).toHaveAttribute('data-quality', 'low');

    sheet = await openSettings(page);
    await expect(sheet.getByTestId('settings-volume-music')).toHaveValue('35');
    await expect(sheet.getByTestId('settings-volume-sfx')).toHaveValue('60');
    await expect(sheet.getByTestId('settings-mono')).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.getByTestId('settings-haptics')).toHaveAttribute('aria-checked', 'false');
    for (const [group, value] of [
      ['settings-motion', 'reduced'],
      ['settings-quality', 'low'],
      ['settings-language', 'fr'],
    ] as const) {
      await expect(option(sheet, group, value)).toHaveAttribute('aria-checked', 'true');
    }
    await reviewShot(page, 'settings-fr-after-reload');
  });

  test('a corrupt saved blob falls back to defaults without breaking boot', async ({
    page,
    pageErrors,
  }, testInfo) => {
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('seeded') === null) {
        localStorage.setItem(key, '{not json');
        sessionStorage.setItem('seeded', '1');
      }
    }, STORAGE_KEY);
    await bootGame(page, { query: '?quality=low' });
    const sheet = await openSettings(page);
    await expect(option(sheet, 'settings-motion', 'system')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(sheet.getByTestId('settings-mono')).toHaveAttribute('aria-checked', 'false');
    expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
  });
});

test.describe('account (T-10.04)', () => {
  for (const { width, height } of [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    test(`a fake Demo sign-in links Google, then unlinks it, at ${width}x${height}`, async ({
      page,
      pageErrors,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await bootGame(page, { query: '?quality=low' });
      const sheet = await openSettings(page);
      const section = sheet.getByTestId('account-section');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('account-demo-note')).toContainText('fake');

      const google = section.getByTestId('account-provider-google');
      await expect(google).toHaveAttribute('data-state', 'demo');
      await expect(google).toContainText('Fake Google');
      await google.scrollIntoViewIfNeeded();
      await reviewShot(page, `account-guest-${width}x${height}`);

      await google.click();
      const status = section.getByTestId('account-status');
      await expect(status).toContainText('Google linked');
      await expect(status).toHaveAttribute('data-tone', 'ok');
      await expect(section.getByTestId('account-linked-google')).toBeVisible();
      await expect(section.getByTestId('account-provider-google')).toHaveCount(0);
      await reviewShot(page, `account-linked-${width}x${height}`);

      await section.getByTestId('account-unlink-google').click();
      await expect(section.getByTestId('account-unlink-confirm')).toBeVisible();
      await section.getByTestId('account-unlink-confirm').click();
      await expect(status).toContainText('Google unlinked');
      await expect(section.getByTestId('account-linked-google')).toHaveCount(0);
      await expect(section.getByTestId('account-provider-google')).toBeVisible();
      expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
    });
  }
});

const DEMO_WORLD_KEY = 'coinposh.demo.world';
const DEMO_ACCOUNT_KEY = 'coinposh.demo.account';
const ACCOUNT_VENUE = { id: 'salonDeParis', name: 'Salon de Paris' } as const;
const ACCOUNT_EXTRA = { coins: 500, goldBars: 3 } as const;

type Wallet = Record<string, number>;

interface StoredPlayer {
  id: string;
  deviceThumbprint: string;
  wallet: Wallet;
  venueId: string;
  unlocked: string[];
  drops: number;
  lastActiveAt: number;
}

interface StoredBlob {
  world: { checkpoints: [string, Wallet][]; players: StoredPlayer[] };
}

function walletPlus(base: Wallet, extra: Readonly<Wallet>): Wallet {
  const out: Wallet = { ...base };
  for (const [currency, amount] of Object.entries(extra)) {
    out[currency] = (out[currency] ?? 0) + amount;
  }
  return out;
}

/**
 * Demo Mode keeps one guest per tab: a reloaded tab hands its new device key the most recently
 * played save no device holds. To stand for a second device, the linked save is copied into a
 * guest that played since, and the linked save moves to Salon de Paris with more in its wallet,
 * so a swap shows on the plaque and in the venue. Every wallet still adds up to its checkpoint
 * plus its ledger, which the Demo world checks on restore.
 */
function plantSecondDevice(raw: string): string {
  const blob = JSON.parse(raw) as StoredBlob;
  const [linked, ...others] = blob.world.players;
  if (!linked || others.length > 0) {
    throw new Error(`expected one Demo player, found ${String(blob.world.players.length)}`);
  }
  const guest: StoredPlayer = {
    ...structuredClone(linked),
    id: randomUUID(),
    deviceThumbprint: 'e2e-second-device',
    drops: linked.drops + 3,
    lastActiveAt: linked.lastActiveAt + 1,
  };
  const zero = Object.fromEntries(Object.keys(linked.wallet).map((currency) => [currency, 0]));
  const linkedCheckpoint = {
    ...zero,
    ...blob.world.checkpoints.find(([id]) => id === linked.id)?.[1],
  };
  blob.world.checkpoints = [
    ...blob.world.checkpoints.filter(([id]) => id !== linked.id),
    [linked.id, walletPlus(linkedCheckpoint, ACCOUNT_EXTRA)],
    [guest.id, walletPlus(guest.wallet, {})],
  ];
  linked.wallet = walletPlus(linked.wallet, ACCOUNT_EXTRA);
  linked.venueId = ACCOUNT_VENUE.id;
  linked.unlocked = [...new Set([...linked.unlocked, ACCOUNT_VENUE.id])];
  blob.world.players = [linked, guest];
  return JSON.stringify(blob);
}

/** True while the sheet's spring morph still moves the element between two frames. */
function cardMoves(card: Locator): Promise<boolean> {
  return card.evaluate(
    (el) =>
      new Promise<boolean>((resolve) => {
        const before = el.getBoundingClientRect();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const after = el.getBoundingClientRect();
            resolve(
              before.top !== after.top ||
                before.left !== after.left ||
                before.width !== after.width ||
                before.height !== after.height,
            );
          });
        });
      }),
  );
}

function bootMarks(page: Page, step: string): Promise<number> {
  return page.evaluate(
    (name) => performance.getEntriesByName(`coinposh:boot:${name}`).length,
    step,
  );
}

/**
 * Links fake Google on this tab's save, then reloads the tab as a second device whose guest save
 * has progress of its own, and signs in with fake Google there. Resolves on the choice sheet.
 */
/**
 * Every coin the save holds as the HUD shows it: the Vault plaque plus the drop buffer's separate
 * in-hand readout (P-536), which is what a save summary counts.
 */
async function heldCoins(page: Page): Promise<number> {
  const inHand = await page.locator('[data-testid=hud-in-hand] .cp-sr-only').textContent();
  return (await vaultBalance(page)) + Number((inHand ?? '').replace(/\D/g, ''));
}

async function signInFromSecondDevice(page: Page): Promise<Locator> {
  await bootGame(page, { query: '?quality=low' });
  let sheet = await openSettings(page);
  let section = sheet.getByTestId('account-section');
  await section.getByTestId('account-provider-google').click();
  await expect(section.getByTestId('account-status')).toContainText('Google linked');
  const stored = () =>
    page.evaluate(
      ([world, account]) => ({
        world: sessionStorage.getItem(world),
        account: sessionStorage.getItem(account),
      }),
      [DEMO_WORLD_KEY, DEMO_ACCOUNT_KEY] as const,
    );
  await expect
    .poll(async () => (await stored()).account ?? '', { message: 'the Demo link is stored' })
    .toContain('google');
  await expect
    .poll(async () => (await stored()).world !== null, { message: 'the Demo world is stored' })
    .toBe(true);
  const { world, account } = await stored();
  if (world === null || account === null) throw new Error('the Demo world was not stored');
  await page.addInitScript(
    ([worldKey, accountKey, planted, links]) => {
      if (sessionStorage.getItem('e2e.account.planted') !== null) return;
      sessionStorage.setItem(worldKey, planted);
      sessionStorage.setItem(accountKey, links);
      sessionStorage.setItem('e2e.account.planted', '1');
    },
    [DEMO_WORLD_KEY, DEMO_ACCOUNT_KEY, plantSecondDevice(world), account] as const,
  );
  await page.reload();
  await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
    timeout: 60_000,
  });

  sheet = await openSettings(page);
  section = sheet.getByTestId('account-section');
  await expect(section.getByTestId('account-provider-google')).toContainText('Fake Google');
  await section.getByTestId('account-mode').click();
  await section.getByTestId('account-provider-google').click();
  const choice = page.getByTestId('sheet-account-choice');
  await expect(choice).toBeVisible();
  return choice;
}

test.describe('account progress choice (T-10.04, folds P-487)', () => {
  test('nothing is preselected, and playing the account save re-lays the table', async ({
    page,
    pageErrors,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const choice = await signInFromSecondDevice(page);
    const guestCard = choice.getByTestId('account-choice-guest');
    const accountCard = choice.getByTestId('account-choice-account');
    const confirm = choice.getByTestId('account-choice-confirm');

    await expect(guestCard).toHaveAttribute('aria-checked', 'false');
    await expect(accountCard).toHaveAttribute('aria-checked', 'false');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(guestCard).toContainText('Riviera');
    await expect(accountCard).toContainText(ACCOUNT_VENUE.name);
    await expect(accountCard).toContainText('With your Google account');
    const guestCoins = await heldCoins(page);
    const accountCoins = guestCoins + ACCOUNT_EXTRA.coins;
    await expect(guestCard).toHaveAttribute(
      'aria-label',
      new RegExp(`Coins: ${guestCoins.toLocaleString('en')}\\.`),
    );
    await expect(accountCard).toHaveAttribute(
      'aria-label',
      new RegExp(`Coins: ${accountCoins.toLocaleString('en')}\\.`),
    );
    await expect
      .poll(() => cardMoves(accountCard), { message: 'the choice sheet has settled' })
      .toBe(false);
    await reviewShot(page, 'account-choice-390x844');

    await confirm.click({ force: true });
    await expect(choice).toBeVisible();
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');

    await accountCard.click();
    await expect(accountCard).toHaveAttribute('aria-checked', 'true');
    await expect(confirm).toHaveAttribute('aria-disabled', 'false');
    await expect(confirm).toHaveText('Play the account save');
    expect(await bootMarks(page, 'account-swapped')).toBe(0);
    await confirm.click();

    await expect(choice).toBeHidden();
    await expect.poll(() => bootMarks(page, 'account-swapped')).toBe(1);
    await page.waitForFunction(() => window.__coinposh?.playable === true);
    const settings = page.getByTestId('sheet-settings');
    await expect(settings.getByTestId('account-status')).toContainText(
      `Your ${ACCOUNT_VENUE.name} save is on the table`,
    );
    await expect(settings.getByTestId('account-linked-google')).toBeVisible();
    await expect.poll(() => heldCoins(page)).toBe(accountCoins);
    await reviewShot(page, 'account-swapped-390x844');
    expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
  });

  test('closing the choice keeps this device’s save on the table', async ({
    page,
    pageErrors,
  }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const choice = await signInFromSecondDevice(page);
    const guestCoins = await heldCoins(page);
    await choice.getByTestId('account-choice-account').click();
    await expect
      .poll(() => cardMoves(choice.getByTestId('account-choice-account')), {
        message: 'the picked card has landed',
      })
      .toBe(false);
    await reviewShot(page, 'account-choice-360x640');
    await choice.locator('.cp-sheet-close').click();

    await expect(choice).toBeHidden();
    await expect(page.getByTestId('sheet-settings').getByTestId('account-status')).toContainText(
      "You are playing this device's save",
    );
    expect(await bootMarks(page, 'account-swapped')).toBe(0);
    expect(await heldCoins(page)).toBe(guestCoins);
    expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
  });

  test('a sign-in with nothing linked says so calmly', async ({ page, pageErrors }, testInfo) => {
    await bootGame(page, { query: '?quality=low' });
    const sheet = await openSettings(page);
    const section = sheet.getByTestId('account-section');
    await section.getByTestId('account-mode').click();
    await section.getByTestId('account-provider-google').click();
    const status = section.getByTestId('account-status');
    await expect(status).toContainText('Google doesn’t keep a CoinPosh save yet');
    await expect(status).toHaveAttribute('data-tone', 'calm');
    expect(unexpectedErrors(pageErrors, testInfo)).toEqual([]);
  });
});
