# CoinPosh: Economy and Balancing

All numbers live in `packages/economy/src/config/*.ts` as typed data, never
hard-coded in the client or server. The server imports them directly; the
client imports them only for display. `packages/economy/sim` is a headless
balancing CLI that simulates player-days and outputs curves (CSV + an HTML
chart) for review.

## Currencies

| Currency | Type | Source | Sink |
|---|---|---|---|
| **Coins** | soft, physical | Pushing coins off the ledge, offline vault, Vault Crates, the Steward's allowance | Drops (each drop costs 1 coin of its tier), upgrades |
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

## Broke player: the Steward's allowance

A new player can pour the whole Vault onto the table before the ledge pays anything back
(playtest 2026-11-08: 20 coins gone by 43 s, then 29 s at 0 with 35 coins still sliding).
Nothing else in the economy refills an empty Vault during play, so the house does:

- The Vault is **empty** when wallet plus pre-paid drop buffer is below 1 coin (one copper drop),
  as the server holds it. Coins sliding on the table do not count until they fall.
- Once it has sat empty for **6 s** (the ledge gets first say), the Steward credits **10 coins**.
  Any credit before then (a fall, a crate) cancels the wait.
- At most one allowance per **120 s** (from the previous one) and **20 per UTC day**.
- It is a granted source (ledger `stewardAllowance`), like starting coins: it does not count as
  winnings toward Bullion, nor toward the measured active rate behind offline earnings.
- The server owns it. The client shows the empty state from the balance the server reports and
  never mints: the plaque dims to "Vault empty", and a tap at 0 brings up the Concierge's hint
  pointing at the coins on the ledge. The next credit clears both.

Numbers and rule: `packages/economy/src/config/allowance.ts` (`stewardAllowance`,
`claimStewardAllowance`). Sim evidence (`src/config/allowance.test.ts`, the economy sim's player
on a ledge that never pays, fast-check over pour rates that empty the 20-coin Vault inside 30 s):

| Pour rate | Broke at | Without allowance | With allowance |
|---|---|---|---|
| 0.7 drops/s | 29 s | no drop for > 90 s | drops again at 36 s (7 s wait) |
| 0.8 drops/s (sim default) | 25 s | no drop for > 95 s | drops again at 32 s (7 s wait) |
| 4 drops/s | 5 s | no drop for > 115 s | drops again at 12 s (7 s wait) |

Ceiling: `10 / 120 s` = 0.083 coins/s, under a quarter of the sim's base active net rate
(0.43 coins/s), so going broke never pays better than playing. At 90 s the ceiling (0.111) broke
that bound, which is why the cooldown is 120 s. fast-check proves the allowance only pays an
empty Vault, keeps grants a cooldown apart, honours the daily cap and never beats its ceiling.
The pacing targets are untouched: the mean-rate sim player never goes broke.

## Monetization readiness (built now, **disabled** by `flags.monetization = false`)

- Store catalog schema (SKU, price tier, region availability, contents).
- Premium season track rendered locked with a "Coming soon" ribbon (or hidden by flag).
- Rewarded ad placement points (2× offline earnings, free crate, Golden Hour extension)
  as interface `AdProvider` with a `NoopAdProvider`.
- Region policy table: BE/NL → no paid random items; all regions → odds visible, pity on.
