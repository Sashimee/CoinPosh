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

## Expansion economy (M10+, founder Q&A 2026-11-09)

**Every number in this section is an initial target for economy-designer to tune**
with the balancing sim. Each milestone's numbers task (T-xx.02 in `04-ROADMAP.md`)
puts them in `packages/economy/src/config/<theme>/` and proves them with property
tests. Rules that hold for all of them:

- The server credits every source below and computes every timer from its own clock.
- Every boost (titles, mastery, staff, variants, collection value, gala, heirs,
  rested, catch-up) is a server-known factor, so the rate envelope includes it.
  Stacked boosts stay under one global cap, set by economy-designer and
  property-tested, so the envelope stays bounded.
- Offline (staff, empire income) stays below play: everything idle combined pays
  less than the measured active rate (the P-179 rule).
- Every random reward has a published odds table summing to 100 % and a pity counter.
- Stocks, auctions, trading and smelting use soft currency only, never Pearls.

### New currencies and scores

| Currency / score | Type | Source | Sink |
|---|---|---|---|
| **Repute** | rank XP, permanent | Coins pushed off (1), fusions (3), crates opened (20), quests (100), achievements (50–500), ascension (1,000), daily puzzle, boss damage | none; drives rank and title |
| **Collection Value** | score | Prizes owned × rarity points × (1 + 0.25 × polish level), variants first found, cellar bottles kept | none; gives a capped global multiplier |
| **Mastery points** | per coin tier / per charm | Coins of that tier banked; charm activations | none; drives mastery levels |
| **Map pieces** | collection item | Crates (4 % per crate), claw machine | Completing a map (8 pieces) |
| **League points** | weekly score | Bullion earned that week | resets weekly |
| **Gala ribbons** | prestige flair | Weekly charity gala donations | none; permanent |

Stars (season XP) and Repute are separate: Stars reset each season, Repute never does.

### Ranks and titles

- Ranks: Commoner I–V, Baron I–V, Duke I–V, then Monarch, then Monarch stars.
- Repute to next rank: `xp(r) = 400 × 1.5^r` for r = 0..14; cumulative to rank r
  is `800 × (1.5^r − 1)`. Monarch stars every 50,000 Repute after that.
- Perks (examples): Baron I unlocks auto-drop and a crest; Duke I gives +1 h
  offline cap (inside the upgradeable cap); Monarch gives lounge throne decor.
  Perks never stack beyond the global boost cap.

### Achievements and mastery

- Achievements: 200 at launch, aiming for 300+. Rewards: Repute 50–500, Pearls
  2–25, cosmetics. Achievement Pearls stay ≤ 15 % of Pearl income in the first 30 days.
- Coin-tier mastery: level l (1–10) at `100 × 2^(l−1)` coins of that tier banked;
  +1 % value for that tier per level (max +10 %).
- Charm mastery: level l (1–10) at `50 × 2^(l−1)` activations; +2 % charm effect
  per level (max +20 %).

### Staff

| Staff | Automates | Idle boost |
|---|---|---|
| Butler | Opens safes the moment their timer ends, banks the offline vault without a return-screen tap | +5 % offline per level |
| Valet | One free, Decorum-free nudge when coins stall at the lip (at most 1 per 20 s) | +5 % offline per level |
| Sommelier | Ages the cellar faster (+5 % per level), assists the Perfect Pour window | +5 % offline per level |

- Hire cost: 1.5 h of the player's measured active rate at the current venue.
- Levels 1–10; level l needs l days employed plus a training fee of
  `hire × 0.3 × l`.
- Upkeep (sink): a daily wage of 25 % of the extra offline earnings that staff
  member produced. Unpaid staff go on leave (no boost), no other penalty.
- Total staff idle boost capped at +60 %: offline stays ≤ `0.35 × 1.6 = 0.56` of
  the active rate.

### Prizes and coin variants

| Prize rarity | Spawn share | Collection points |
|---|---|---|
| Common | 50 % | 10 |
| Fine | 28 % | 25 |
| Rare | 14 % | 60 |
| Exquisite | 6 % | 150 |
| Legendary | 2 % | 400 |

- Spawn: 1 prize per 150 drops; first prize scripted inside 10 min of play.
- Pity: a prize you don't own is guaranteed within 8 prizes. Duplicates add a
  polish level (max 5).
- Collection multiplier: +1 % coin value per 500 Collection Value, max +25 %.

| Variant | Mint odds | Value × |
|---|---|---|
| none | 97.5 % | 1 |
| Foil | 1.5 % | 2 |
| Proof | 0.6 % | 3 |
| First-strike | 0.3 % | 5 |
| Misprint | 0.1 % | 10 |

Expected coin value rises about 4.8 %. Pity: a misprint within 2,000 mints.
Fusion with variants: economy-designer picks one rule (the variant premium pays
when banked, or carries into the fused coin's stored value) and proves value
conservation with fast-check.

### Wine cellar ageing curve

`value(t) = v0 × (1 + gain × (1 − e^(−t/τ)))`, with t in server days, no decline.

| Class | v0 (× hourly active rate) | gain | τ | Peak (95 %) |
|---|---|---|---|---|
| Table wine | 0.2 | 1.5 | 1 d | ≈ 3 d |
| Grand cru | 0.5 | 4 | 7 d | ≈ 3 weeks |
| Legendary vintage | 1 | 10 | 30 d | ≈ 3 months |

12 rack slots, upgradeable to 48 (coin sink). Cap: a full cellar's daily value
growth ≤ 20 % of a casual day's earnings.

### Auction house

- 3 lots a day (prizes, bottles, cosmetics, map pieces). Bids in coins.
- Each NPC collector's ceiling is drawn from `U[0.8, 1.6] × lot reference value`
  with fair RNG, committed as a hash when the lot opens and revealed at close.
- Second-price: the winner pays the highest losing bid plus one increment (5 %).
  All payments are a sink. Selling to the auction pays the best NPC ceiling,
  capped at 2 lots a day.

### Stock portfolio

- 6 fictional companies (watches, perfume, yachts, jewels, couture, motors).
- Daily close: `p' = p × exp(θ × ln(p0/p) + σ × z)`, mean-reverting to the IPO
  price p0, σ = 2–8 % per company, z from the server's daily seed (committed a day
  ahead); price band [0.25, 4] × p0; daily move capped at ±15 %.
- 1 % fee on every buy and sell (sink). Holdings capped at 2 days of the player's
  active earnings. The sim must show expected 30-day return ≤ 0 after fees.

### Claw machine and treasure hunt

- Claw: 1 Ticket a try (3 for the premium cabinet). Grip odds by target class:
  Common 45 %, Fine 25 %, Rare 10 %, Exquisite 4 %, Legendary 1.5 %; "no prize" is
  shown as its own row. Pity: a win within 6 tries.
- Treasure map: 8 pieces, 4 % per crate; a piece you already have converts to a
  Key, and the next piece is guaranteed new after 3 duplicates. First map ≈ 14
  days casual. The vault table run (5 min) guarantees a Rare+ crate.

### Events and retention

| Source | Initial target |
|---|---|
| 7-day calendar | Coins, Keys, Tickets, Pearls; day 7 a Rare crate. Whole loop ≤ 1 casual day of earnings |
| 28-day calendar | Exquisite crate at day 14, an exclusive cosmetic at day 28 |
| Daily puzzle | Fixed rewards: 100 Repute for finishing, 10 Pearls for the top 10 % |
| Boss | Damage = value banked that week; HP = 0.6 × expected damage of active players; tiered rewards by contribution plus a defeat bonus for all |
| Holiday collections | Limited items with their own pity; never return as paid-only |
| Comeback gift | Away ≥ 3 days: a fixed gift scaling with days away (max at 14) |
| Catch-up boost | Away ≥ 3 days: +50 % Repute and Stars for the next 3 h of active play |
| Rested boost | Away ≥ 8 h: ×1.5 coin value for the first 10 min of active play, then offline earnings as normal |
| Weekly chest | Filled by Repute earned that week, 5 tiers, opens Sunday (player time zone); contents show odds and pity |
| Goals board | Draws on quests, achievements, ranks, mastery; short goals pay small fixed rewards only |

### Social, competitive and creation

- Gifts: up to 10 sent and 10 received a day; each is house-minted (50 coins ×
  venue multiplier, or 1 Ticket). Nothing leaves the sender's wallet.
- Visits: tips are house-minted (fixed, small), max 20 received a day; likes give
  +2 Repute, max 50 a day.
- Clubs: up to 30 members; a weekly goal gives a club crate to each member above
  a minimum contribution.
- Leagues: groups of 30 matched by venue and Gold Bars bracket; top 5 promote,
  bottom 5 relegate; fixed rewards per tier.
- Tournaments: fixed seed, 300 drops, 3 attempts, best counts; fixed rewards by
  percentile; top results count only after the replay verifier passes.
- Custom tables (editor): payouts × 0.5, no crates, prizes, jackpot or bonus
  rolls, a daily earnings cap of 30 min of active rate, no Bullion or leaderboard credit.

### Economy depth sinks

| Sink | Initial target |
|---|---|
| Workshop | Deterministic recipes: 3 duplicate charms → +1 charm level; 5 prizes of one rarity → 1 prize of the next (random pick shows odds); recipe fees in coins |
| Smelting | Coins → Bullion at 1 per 5,000 value (5× worse than winnings), unlocked after the first ascension, capped at 20 % of the week's Bullion |
| Charity gala | Weekly donation; cumulative tiers give ribbons and +0.5 % coin value per tier, max +5 % |
| Trading | 1 item for 1 item, value within ±25 % of reference; no currencies |

Trading anti-abuse rules (server-enforced): mutual friends for ≥ 7 days; both
accounts linked (M10), ≥ 14 days old and at least Baron I; at most 3 trades a day
and 10 a week; a received item is trade-locked for 7 days; Heirlooms and
event-limited items can't be traded; trades sit in server escrow until both
confirm; graph checks flag accounts that receive from many young accounts, and
flagged accounts lose trading and move to the shadow pool.

### Big-picture meta

- Empire income: each ascended venue pays 2 % of its last measured active rate
  per hour, all venues together capped at 20 % of the offline cap's rate.
- Dynasty: at ascension pick 1 of 3 heirs (server-rolled traits, odds shown);
  the heir inherits one owned charm level or prize and has a trait worth ≤ 5 %
  on one stat (for example Frugal: −5 % upgrade cost; Lucky: +3 % crate chance).

### Expansion pacing targets (verified by the balancing sim)

| Milestone | Target |
|---|---|
| First prize | ≤ 10 min |
| First foil coin | ≤ 15 min |
| Baron I | ≈ 1.5 h active |
| Duke I | ≈ 13 h active |
| Monarch | ≈ 100 h active |
| First staff hire | around the first Venue 1 ascension |
| First bottle peak | 3 days |
| First complete treasure map | ≈ 14 days casual |
| Achievements unlocked in week 1 | ≈ 40 |
| Diamond league | top ≈ 2 % of active players |

## Monetization readiness (built now, **disabled** by `flags.monetization = false`)

- Store catalog schema (SKU, price tier, region availability, contents).
- Premium season track rendered locked with a "Coming soon" ribbon (or hidden by flag).
- Rewarded ad placement points (2× offline earnings, free crate, Golden Hour extension)
  as interface `AdProvider` with a `NoopAdProvider`.
- Region policy table: BE/NL → no paid random items; all regions → odds visible, pity on.
