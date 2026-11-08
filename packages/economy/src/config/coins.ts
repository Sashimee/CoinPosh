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

// Silver, not copper: at the front-edge return measured on the physics table (0.82 to 0.93
// coins per drop) a copper heap pays no more than the pile it stands in for, and first
// upgrade lands at 2 min 55 s p90; silver lands it at 20 s. Under about 75 coins the heap
// eats the 20-coin trust fund before anything falls. Evidence: `sim --heap-tier copper --return-ratio 0.9` (P-193).
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
