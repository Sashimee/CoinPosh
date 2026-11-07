# CoinPosh: Economy and Balancing

All numbers live in `packages/economy/src/config/*.ts` as typed data, never
hard-coded in the client or server. The server imports them directly; the
client imports them only for display. `packages/economy/sim` is a headless
balancing CLI that simulates player-days and outputs curves (CSV + an HTML
chart) for review.

## Currencies

| Currency | Type | Source | Sink |
|---|---|---|---|
| **Coins** | soft, physical | Pushing coins off the ledge, offline vault | Drops (each drop costs 1 coin of its tier), upgrades |
| **Bullion** | venue progress | Converted from coin winnings (1 per 1,000 value) | Ascension threshold |
| **Gold Bars** | prestige, permanent | Venue Ascension | Permanent global upgrades ("The Family Office") |
| **Pearls** | premium (earnable) | Quests, album sets, season track, Heirloom pushes, rare crates | Keys, safe skips, gacha tickets, cosmetics. IAP later behind a flag |
| **Keys** | utility | Crates, quests, season | Open safes instantly |
| **Tickets** | utility | Quests, Golden Hour, season | Gacha pulls |
| **Stars** | season XP | Everything you do | Season pass tiers |

## Starting formulas (tuned by the balancing sim)

- Upgrade cost: `cost(level) = base × growth^level`, with `growth ∈ [1.12, 1.18]`
  per upgrade line.
- Coin value per tier: Copper 1, Silver 5, Gold 25, Platinum 125, Diamond 625,
  Heirloom 5,000 (×venue multiplier ×global multipliers).
- Fusion bonus: the fused coin is worth `3 × lower tier × 1.25` (a 25 % reward for merging).
- Cascade multiplier: Chic ×1.1, Lavish ×1.25, Opulent ×1.5, Decadent ×2, OBSCENE ×3.
- Vault Crate spawn: base 1 per 40 drops, guaranteed scripted crate at drop 12 in the FTUE.
- Offline earnings: `min(hoursAway, offlineCap) × 0.35 × measuredActiveRate`,
  with offlineCap starting at 2 h and upgradeable to 12 h. The server computes it.
- Ascension Gold Bars: `floor( sqrt(lifetimeBullionThisVenue / threshold) × 10 )`.
- Pity counters: Rare guaranteed within 10 opens, Exquisite within 40, Legendary within 120.

## Drop tables (initial; displayed in-game)

| Rarity | Vault Crate | Safe (Gold) | Gacha | Scratch |
|---|---|---|---|---|
| Common | 62 % | 35 % | 55 % | 70 % |
| Fine | 25 % | 35 % | 27 % | 20 % |
| Rare | 9 % | 20 % | 12 % | 7.5 % |
| Exquisite | 3 % | 7.5 % | 4.5 % | 2 % |
| Legendary | 0.95 % | 2.4 % | 1.4 % | 0.5 % |
| Heirloom | 0.05 % | 0.1 % | 0.1 % | 0 % |

## Pacing targets (verified by the balancing sim in CI)

| Milestone | Target time (active play) |
|---|---|
| First upgrade | ≤ 2 min |
| First Charm | ≤ 5 min |
| First album set | ≤ 45 min |
| Ascend Venue 1 | 3–5 h active (≈ 2 days casual) |
| Ascend Venue 2 | ≈ 1.6× venue 1 |
| Full season pass (free) | ≈ 30 h over 6 weeks |

Property tests (fast-check) must prove:
1. Value is conserved across drop → fusion → claim, with no free-value path except defined bonuses.
2. No upgrade path makes coins/sec grow faster than the rate-envelope model.
3. Every odds table sums to 100 % and matches what the UI displays.

## Monetization readiness (built now, **disabled** by `flags.monetization = false`)

- Store catalog schema (SKU, price tier, region availability, contents).
- Premium season track rendered locked with a "Coming soon" ribbon (or hidden by flag).
- Rewarded ad placement points (2× offline earnings, free crate, Golden Hour extension)
  as interface `AdProvider` with a `NoopAdProvider`.
- Region policy table: BE/NL → no paid random items; all regions → odds visible, pity on.
