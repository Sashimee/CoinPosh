import { coinTiers, ftueFirstCredit } from '@coinposh/economy';
import { beforeAll, describe, expect, it } from 'vitest';
import { TICK_RATE_HZ } from '../constants.ts';
import { MAX_DROP_OFFSET_MM } from '../inputs.ts';
import {
  FTUE_SEEDS,
  type Opening,
  type OpeningPlan,
  PHONE_WIDTH_PX,
  playOpening,
  playOpenings,
  railMmAt,
  TAP_BANDS_PX,
  type TapBand,
} from './ftue.harness.ts';

/**
 * The P-436 harness on the first three FTUE tables; ftue.report.ts runs all 20 for 02-ECONOMY.
 * The P-436 bound itself (ftueFirstCredit) is asserted with the change that meets it.
 */
const SEEDS = FTUE_SEEDS.slice(0, 3);
const intervalTicks = TICK_RATE_HZ / ftueFirstCredit.tapsPerSecond;

describe('the FTUE tap map (apps/web aimMap.ts and drops.ts aimToMm)', () => {
  it('sends P-436 centre taps, 160..220 px of 390, to -34..24 mm of the rail', () => {
    expect(TAP_BANDS_PX.centre).toEqual([160, 220]);
    expect(TAP_BANDS_PX.centre.map((px) => railMmAt(px))).toEqual([-34, 24]);
    expect(railMmAt(PHONE_WIDTH_PX / 2)).toBe(0);
  });

  it('reaches either rail end inside the screen and clamps past it', () => {
    expect(railMmAt(0.1 * PHONE_WIDTH_PX)).toBe(-MAX_DROP_OFFSET_MM);
    expect(railMmAt(0.9 * PHONE_WIDTH_PX)).toBe(MAX_DROP_OFFSET_MM);
    expect(railMmAt(0)).toBe(-MAX_DROP_OFFSET_MM);
    expect(railMmAt(PHONE_WIDTH_PX)).toBe(MAX_DROP_OFFSET_MM);
  });
});

describe.each(Object.keys(TAP_BANDS_PX) as TapBand[])(
  'a new player tapping %s at 3 taps/s (P-436 harness)',
  (band) => {
    const plans: OpeningPlan[] = SEEDS.map((seed) => ({ seed, intervalTicks, band }));
    let runs: Opening[] = [];
    beforeAll(async () => {
      runs = await playOpenings(plans);
    });

    it('gets a first credit on every table', () => {
      for (const run of runs) {
        expect(run.ticksAfterFirstTap).not.toBeNull();
        expect(run.credited).toBeGreaterThan(0);
      }
    });

    it('keeps the Vault: trust fund, less a copper a drop, plus allowance and the credit', () => {
      for (const run of runs) {
        expect(run.vaultAtCredit).toBe(
          run.startingCoins - run.drops * coinTiers[0].value + run.allowance + run.credited,
        );
        expect(run.minVault).toBeGreaterThanOrEqual(0);
        expect(run.minVault).toBeLessThanOrEqual(run.startingCoins - run.drops + run.allowance);
      }
    });

    it('refuses a tap only once the Vault is empty', () => {
      for (const run of runs) {
        if (run.refusedTaps > 0) expect(run.minVault).toBeLessThan(coinTiers[0].value);
      }
    });

    it('replays a table exactly', async () => {
      const [first] = plans;
      if (first === undefined) throw new Error('No FTUE plan to replay.');
      expect(await playOpening(first)).toEqual(runs[0]);
    });
  },
);
