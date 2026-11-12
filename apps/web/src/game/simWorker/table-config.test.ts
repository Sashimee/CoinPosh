import { economyConfig } from '@coinposh/economy';
import { FUSION_TUNING, freshTicks } from '@coinposh/sim';
import { describe, expect, it } from 'vitest';
import { SIM_MECHANICS, simMechanicsAt } from './table-config.ts';

const TOP_LEVEL = economyConfig.upgradeLines.find(({ id }) => id === 'fusionWindow')?.maxLevel;

describe('simMechanicsAt', () => {
  it('is SIM_MECHANICS with the fusionWindow stat of the levels', () => {
    expect(simMechanicsAt({})).toEqual({
      ...SIM_MECHANICS,
      fusion: { ...SIM_MECHANICS.fusion, fusionWindow: 1 },
    });
    expect(simMechanicsAt({ fusionWindow: 10, dropRate: 3 }).fusion?.fusionWindow).toBeCloseTo(
      1.5,
      12,
    );
  });

  it('keeps the contact time and stretches only how long a coin stays fresh', () => {
    expect(TOP_LEVEL).toBe(20);
    const top = simMechanicsAt({ fusionWindow: TOP_LEVEL ?? 0 }).fusion;
    expect(top?.contactSeconds).toBe(economyConfig.fusion.contactSeconds);
    expect(freshTicks(simMechanicsAt({}).fusion?.fusionWindow)).toBe(FUSION_TUNING.freshTicks);
    expect(freshTicks(top?.fusionWindow)).toBe(2 * FUSION_TUNING.freshTicks);
  });

  it('refuses a level the fusionWindow line does not have', () => {
    expect(() => simMechanicsAt({ fusionWindow: (TOP_LEVEL ?? 0) + 1 })).toThrow(RangeError);
    expect(() => simMechanicsAt({ fusionWindow: -1 })).toThrow(RangeError);
  });
});
