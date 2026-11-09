import { describe, expect, it } from 'vitest';
import { runInBrowser } from './browser.ts';
import { parityRun, type ParityRun } from './scenario.ts';

/**
 * Design 92-table-persistence 1.4: the snapshot round trip hashes the same in Node and
 * in the browser. The browser loads the same .ts modules from src, with Rapier's
 * inlined-WASM build, so any difference is the engine's.
 */
describe('snapshot parity between Node and the browser', () => {
  it('snapshots, restores and replays the table to the same hashes in headless Chromium as in Node', async () => {
    const node = await parityRun();
    const { value, userAgent } = await runInBrowser('snapshot/parity/scenario.ts', 'parityRun');
    expect(userAgent).toMatch(/HeadlessChrome|Chrome/);
    const browser = value as ParityRun;
    expect(browser.snapshot).toBe(node.snapshot);
    expect(browser.roundTrip).toEqual(node.roundTrip);
    expect(browser.fixture).toEqual(node.fixture);
    expect(node.roundTrip).toHaveLength(11);
    expect(new Set(node.roundTrip).size).toBe(node.roundTrip.length);
    expect(node.fixture[0]).toBe('3b0c71dac53f6038');
  });

  it('reports a module that throws in the page with its error', async () => {
    await expect(runInBrowser('snapshot/parity/scenario.ts', 'noSuchExport')).rejects.toThrow(
      /scenario.ts threw in the browser: TypeError/,
    );
  });
});
