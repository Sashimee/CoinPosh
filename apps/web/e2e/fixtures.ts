import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { economyConfig } from '@coinposh/economy';
import { GAME_URL, SCREENSHOT_DIR } from './env.ts';

export { expect };

/** The shape `window.__coinposh` exposes in apps/web/src/main.ts. */
export interface ProbeCounts {
  readonly simFalls: number;
  readonly simFusions: number;
  readonly falls: number;
  readonly frontFalls: number;
  readonly fusions: number;
  readonly credits: number;
  readonly creditedCoins: number;
  readonly refusedFalls: Readonly<Record<string, number>>;
}

export interface ProbeSim {
  readonly tick: number;
  readonly renderTick: number;
  readonly coins: number;
  readonly frames: number;
}

export interface Probe {
  readonly sim: ProbeSim | null;
  readonly playable: boolean;
  readonly counts: ProbeCounts;
}

declare global {
  interface Window {
    __coinposh?: Probe;
  }
}

/** The fixed seed behind every Demo Mode server roll in these suites. */
export const DEMO_SEED = 0x5eed_c01d;

/**
 * Demo Mode draws its server seed, device key salt and ids from `crypto`. Replacing the two
 * entry points with a seeded generator before any app script runs makes every roll, crate and
 * fairness commitment the same on every run. `crypto.subtle` is untouched, so HMACs still verify.
 */
async function seedDemoMode(page: Page, seed: number): Promise<void> {
  await page.addInitScript((initial: number) => {
    let state = initial >>> 0;
    const next = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    const fill = <T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array;
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = next() & 0xff;
      return array;
    };
    const hex = (count: number): string => {
      let out = '';
      for (let i = 0; i < count; i += 1) out += (next() & 0xf).toString(16);
      return out;
    };
    const uuid = (): `${string}-${string}-${string}-${string}-${string}` => {
      const variant = ((next() & 0x3) | 0x8).toString(16);
      return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
    };
    Object.defineProperty(crypto, 'getRandomValues', { value: fill, configurable: true });
    Object.defineProperty(crypto, 'randomUUID', { value: uuid, configurable: true });
  }, seed);
}

/**
 * Known defects owned by other agents that surface as page errors under SwiftShader. Each entry
 * is one exact message, not a pattern family, and is reported as an annotation when it fires.
 * Remove an entry as soon as its POLISH item ships.
 */
const KNOWN_PAGE_ERRORS: readonly { readonly item: string; readonly message: string }[] = [
  {
    item: 'P-173',
    message: 'AdaptiveRendering.render(nowMs) needs the requestAnimationFrame timestamp',
  },
];

/** `errors` minus the KNOWN_PAGE_ERRORS, each known one noted as an annotation on `testInfo`. */
export function unexpectedErrors(errors: readonly string[], testInfo: TestInfo): string[] {
  return errors.filter((error) => {
    const known = KNOWN_PAGE_ERRORS.find((entry) => error.includes(entry.message));
    if (!known) return true;
    testInfo.annotations.push({ type: `known issue ${known.item}`, description: error });
    return false;
  });
}

interface Fixtures {
  /** Page errors and console errors, failing the test at teardown unless listed as known. */
  pageErrors: string[];
}

export const test = base.extend<Fixtures>({
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      });
      await seedDemoMode(page, DEMO_SEED);
      await use(errors);
      expect(unexpectedErrors(errors, testInfo), 'the page logged errors').toEqual([]);
    },
    { auto: true },
  ],
});

export function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const p = window.__coinposh;
    if (!p) throw new Error('window.__coinposh is missing: the page is not the CoinPosh game');
    return { sim: p.sim, playable: p.playable, counts: p.counts };
  });
}

export interface BootOptions {
  /** Appended to the game URL, for example `?quality=low`. */
  readonly query?: string;
}

/**
 * The game URL for `query`. The game lands on WebGL2 here only because headless Chromium exposes
 * no WebGPU adapter, so stage.ts falls back; boot.spec.ts asserts that fallback.
 */
export function gameUrl(query = ''): string {
  return new URL(query, GAME_URL).href;
}

/** Opens the Demo Mode build and waits until the table takes drops. */
export async function bootGame(page: Page, options: BootOptions = {}): Promise<void> {
  await page.goto(gameUrl(options.query));
  await page.waitForFunction(() => window.__coinposh?.playable === true, null, {
    timeout: 60_000,
  });
  await expect(page.locator('#coinposh-demo-banner')).toBeVisible();
}

/** The Vault balance the HUD announces to screen readers, as a number. */
export async function vaultBalance(page: Page): Promise<number> {
  const text = await page.locator('[data-testid=hud-balance] .cp-sr-only').textContent();
  const digits = text?.replace(/\D/g, '') ?? '';
  if (digits === '') throw new Error(`The Vault plaque announced no balance: "${text ?? ''}"`);
  return Number(digits);
}

/** A tap in the middle of the table, the same drop a thumb makes. */
export async function tapDrop(page: Page): Promise<void> {
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('The #stage canvas has no layout box, so there is nowhere to tap');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Adds one image to the reviewer screenshot set uploaded by perf.yml. */
export async function reviewShot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

export function refusedTotal(counts: ProbeCounts): number {
  return Object.values(counts.refusedFalls).reduce((sum, n) => sum + n, 0);
}

/**
 * Coins the sim has ever held: on the table now, plus those that fell, plus those a fusion
 * merged away (`inputCount` in, one out). It grows by exactly one per accepted drop.
 */
export function coinLedger(p: Probe): number {
  if (!p.sim) throw new Error('The sim reported no stats, so there is no coin count to read');
  return (
    p.sim.coins + p.counts.simFalls + p.counts.simFusions * (economyConfig.fusion.inputCount - 1)
  );
}
