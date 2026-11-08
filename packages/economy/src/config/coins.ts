import type { CascadeConfig, CoinTierDef, FusionConfig, OpeningHeapConfig } from '../types.ts';

export const coinTiers = [
  { id: 'copper', value: 1, fusesInto: 'silver' },
  { id: 'silver', value: 5, fusesInto: 'gold' },
  { id: 'gold', value: 25, fusesInto: 'platinum' },
  { id: 'platinum', value: 125, fusesInto: 'diamond' },
  { id: 'diamond', value: 625, fusesInto: 'heirloom' },
  { id: 'heirloom', value: 5_000, fusesInto: null },
] as const satisfies readonly CoinTierDef[];

export const fusion = {
  inputCount: 3,
  contactSeconds: 0.4,
  bonusMultiplier: 1.25,
} as const satisfies FusionConfig;

// Misses P-238's bands: `node sim/heapProbe.ts` (seeds 1-10, a tap every 0.5 s, buying
// nothing) makes the first upgrade affordable at 6.3 s and minute 2 earns ×0.22 to ×0.54 of
// minute 1; `node sim/cli.ts` reads ×0.54 and 14 s. No single-tier heap meets both bands on
// either (probe: 20 to 100 silver, 100 copper; sim: 20 to 200 of each), so the fix needs a
// copper heap with a few silver tension coins, which OpeningHeapConfig cannot describe yet.
export const openingHeap = {
  coins: 100,
  tier: 'silver',
} as const satisfies OpeningHeapConfig;

export const cascade = {
  windowMs: 600,
  tiers: [
    { id: 'chic', minCoins: 3, multiplier: 1.1 },
    { id: 'lavish', minCoins: 6, multiplier: 1.25 },
    { id: 'opulent', minCoins: 10, multiplier: 1.5 },
    { id: 'decadent', minCoins: 16, multiplier: 2 },
    { id: 'obscene', minCoins: 25, multiplier: 3 },
  ],
} as const satisfies CascadeConfig;
