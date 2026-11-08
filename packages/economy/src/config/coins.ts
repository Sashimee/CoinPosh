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
// upgrade lands at 2 min 55 s p90; silver lands it at 20 s. Evidence: `sim --heap-tier copper
// --return-ratio 0.9` (P-193). Kept at 100 although it front-loads minute 1 on the physics
// table: a 40 to 75 coin silver heap runs dry inside minute 1 (minute 2 earns ×0.3 to ×0.6
// of it in the sim) and on seeded physics can starve the Vault for 30 to 75 s. Flattening
// the curve needs a copper heap with a few silver tension coins, which this config cannot
// yet express (P-238).
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
