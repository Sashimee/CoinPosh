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
| **Keys** | utility | Legendary+ crates, safes, quests, season | Open safes instantly (1 per Gold Safe) |
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

## Quests, streaks and the Season Pass (T-3.05)

Numbers and rules: `packages/economy/src/config/quests.ts` (`questConfig`, `drawQuestSet`,
`questPeriod`, `advanceStreak`) and `packages/economy/src/config/season.ts` (`seasonTrack`,
`seasonPremiumUnlocked`). The season's length and price stay in `season`
(`src/config/progression.ts`), which the balancing sim reads, so the track the UI shows and the
Stars the sim counts are one number. The server rotates, tracks and pays; the client only shows
what it reports.

### Quests

- **Periods:** daily quests reset at 00:00 UTC, weekly ones at Monday 00:00 UTC. A quest's
  `expiresAt` is its period's end.
- **Slots:** 3 daily and 3 weekly, always one easy, one medium and one hard.
- **Rotation:** each period's set is drawn uniformly, with the server's seeded PRNG, among the
  sets that give every slot a template of its difficulty, ask for three different metrics and
  reuse no template from the previous period's set. The validator proves a set always exists.
- **Metrics** (counted by the server from its own ledger): coins dropped, coins banked off the
  ledge, Contact Fusions, Vault Crates opened, and (weekly) UTC days played.
- **Rewards** are fixed per cadence and difficulty, so every draw is worth the same:

| Quest | Daily reward | Weekly reward |
|---|---|---|
| Easy | 10 Pearls · 5 Stars | 40 Pearls · 1 Ticket · 10 Stars |
| Medium | 15 Pearls · 1 Ticket · 5 Stars | 60 Pearls · 2 Tickets · 15 Stars |
| Hard | 20 Pearls · 1 Key · 10 Stars | 100 Pearls · 2 Keys · 2 Tickets · 25 Stars |

| Template pool | Easy | Medium | Hard |
|---|---|---|---|
| Daily | drop 500 · open 12 crates · bank 1,000 | drop 1,200 · open 25 crates · 40 fusions · bank 2,500 | drop 2,000 · open 70 crates · 75 fusions · bank 7,500 |
| Weekly | drop 7,500 · open 300 crates | 350 fusions · bank 50,000 · play on 4 days | drop 16,000 · open 650 crates · 600 fusions · bank 75,000 |

Targets are sized on the sim's slowest session: a new player's first 43 minutes (30 h ÷ 42
days), slowest of five seeds, with the least-fusing physics style (0.0375 fusions per drop).
`quests.test.ts` holds a daily easy quest to ≤ 10 min, medium to ≤ 20 min, hard to the session,
and a weekly quest to 2–5 sessions (hard ones ≥ 3). Measured at the slowest seed, day one:

| Minutes in | 10 | 20 | 27 | 35 | 43 |
|---|---|---|---|---|---|
| Drops | 587 | 1,286 | 1,865 | 2,537 | 3,209 |
| Crates | 14 | 28 | 56 | 88 | 113 |
| Coins banked | 1,160 | 2,991 | 5,017 | 7,805 | 10,832 |
| Fusions | 22 | 48 | 70 | 95 | 120 |

Tuning from that run: daily easy crates 15 → 12 and banked 1,500 → 1,000 (11 and 13 min on the
slowest seed), daily medium crates 40 → 25 and banked 4,000 → 2,500 (24 min), weekly hard
banked 80,000 → 75,000 (79,798 after five sessions, so a sixth was needed).

### Daily streak

- A UTC day with at least **1** daily quest claimed extends the streak by one day.
- **Freezes:** start with **1**, hold at most **2**. Each missed day spends one automatically and
  the streak survives (the missed day adds nothing). With too few freezes the streak restarts at
  1 and the freezes are kept. Buy one for **50 Pearls** while below the cap.
- **Milestones** (Pearls, Keys and Tickets only, never Stars, so the season counts play, not
  calendar days):

| Streak day | Reward | Freezes granted |
|---|---|---|
| 3 | 15 Pearls · 1 Ticket | 0 |
| 7 | 40 Pearls · 1 Key · 2 Tickets | 1 |
| 14 | 60 Pearls · 2 Keys · 2 Tickets | 1 |
| 21 | 80 Pearls · 2 Keys · 3 Tickets | 1 |
| 30 | 120 Pearls · 3 Keys · 5 Tickets | 1 |
| every 7 days after 30 | 80 Pearls · 2 Keys · 3 Tickets | 1 |

### Season Pass

- **6 weeks, 50 free tiers, 350 Stars a tier** (17,500 Stars). Tier n unlocks at n × 350.
- **Stars sources:** 1 per 25 drops, 2 per Vault Crate, 50 per album set (all in the sim), and
  quests: 20 a day plus 50 a week, 1,140 a season (6.5 % of the track) for a player who claims
  them all.
- **Free rewards** repeat a ten-tier rhythm whose Pearls climb each decade: Pearls on odd steps
  (15 / 20 / 25 + 5 a decade), Tickets at 2, 6 and 9, Keys at 4 and 8, 40 + 10 a decade Pearls
  and a scratch card at 5, and a showpiece at 10 (80 + 20 a decade Pearls, 2 Keys, 2 Tickets).
  Tier 50 is the crown: 300 Pearls, 5 Keys, 5 Tickets, 3 scratch cards. The whole free track
  pays 1,490 Pearls, 23 Keys, 33 Tickets and 8 scratch cards.
- **Premium rewards** double every free reward on the same tier. They are always defined so the
  locked track renders, and pay only while `flags.monetization` and `flags.premiumSeasonTrack`
  are both on (`seasonPremiumUnlocked`); `premiumUnlocked` is false otherwise.

**Pacing proof** (`season.test.ts`, five seeds, the economy sim's player playing one 43-minute
session a day with the offline vault claimed in between, held to the 25–35 h band of the
`seasonFreeTrack` pacing row and to the 42-day season):

| Reference player | Free track done at | Season day |
|---|---|---|
| Claims every quest | 25.9 – 26.4 h | 37 |
| Never claims a quest | 27.4 – 27.8 h | 39 |

Both finish inside the band with days to spare, so a few missed days do not cost the crown.
Considered and rejected: 400 Stars a tier puts the quest player at 29.4–29.9 h, but only on the
season's last day, and a player who skips quests (19,000 of 20,000 Stars) never finishes.
T-3.07 owns the rebalance; the quest player sits 0.9 h above the band's floor, so a raise in the
passive Stars rate (632 an active hour today) needs a matching raise in Stars per tier.

## Safes (T-2.01)

Numbers and rules: `packages/economy/src/config/safes.ts` (`safes`, `safeTypeDef`,
`safeUnlocksAt`, `safeTimerReady`) and the `safeChance` column of `crateRewards`
(`src/config/drops.ts`).

| Safe | Contents roll on | Keys to open now | Timer |
|---|---|---|---|
| Gold | `goldSafe` table above, with pity | 1 | 4 h |

**Where safes come from.** A Vault Crate open rolls its rarity, then rolls `safeChance` for a
Gold Safe on top of that rarity's normal reward. The rarer the crate, the likelier the safe:

| Crate rarity | Common | Fine | Rare | Exquisite | Legendary | Heirloom |
|---|---|---|---|---|---|---|
| Safe chance | 0 % | 2 % | 10 % | 25 % | 50 % | 100 % |
| Keys in the crate | 0 | 0 | 0 | 0 (was 1) | 1 | 2 |

With pity that is 3.64 % a crate, about one safe every 27.5 crates. Quests can grant safes too
(`Reward` kind `safe`), but no quest pays one yet.

**Rules.**
- The server grants the safe and stamps `unlocksAt = grantedAt + 4 h` from its own clock
  (`safeUnlocksAt`). The client never sends a time the server trusts.
- `method: 'key'` spends `keysPerSafe` Keys and opens at once. `method: 'timer'` succeeds once
  the server clock reaches `unlocksAt`, never before (`safeTimerReady`). The Butler (staff) opens
  it the moment the timer ends.
- Contents roll on `goldSafe` with its own pity counters and pay that rarity's `crateRewards` row
  (coins, Pearls, Keys, Tickets, Charm chance, album card). That roll never rolls `safeChance`,
  so a safe never holds a safe. Safes pay no Stars, so the season track is unchanged.

**Why these numbers.**
- *4 h timer:* longer than a day's casual play (2 × 25 min), so inside a session only a Key
  opens a safe now. Shorter than the shortest casual gap (11.6 h), so the next session always
  finds yesterday's safes open (0 still locked at any session start, 5 seeds × 42 days).
- *1 Key:* readable at a glance, and the Demo mock already uses it.
- *Exquisite Key → 25 % safe:* with the old Exquisite Key, crates alone paid 1.6 Keys per safe.
  The casual player opened 100 % of safes by Key and still sat on 242–263 unspent Keys at day 42
  (307–327 with quests), so the timer never mattered and the Key stopped feeling like a choice.
  The fix moves value out of a Key and into a safe, which is worth more: a safe's expected payout
  is 27.8 s of income, 2.16 Pearls, 0.028 Keys and 0.134 Tickets against a crate's 18.9 s, 1.31,
  0.018 and 0.079.

**Flow proof** (`safes.test.ts`: the sim's casual player, sessions at 8:00 and 20:00, 42 days,
seeds 1–5. Each crate rolls rarity and `safeChance` on a side stream. A held Key is spent at
once, otherwise the safe waits for its timer. Keys come from crates, safe contents, season tiers
and, in the quest row, daily and weekly quests and streak milestones):

| Player | Safes a day | Opened by Key | Keys left at day 42 | Most locked at once |
|---|---|---|---|---|
| Never claims a quest | 6.12 – 6.55 | 59.5 – 67.8 % | 0 | 5 – 7 |
| Claims quests | 5.95 – 6.38 | 85.6 – 91.4 % | 1 – 9 | 5 – 6 |

Quests pay for the Keys, so a quest player opens nearly every safe at once and a player who
skips them waits on the timer for a third of them. Keys never pile up. The first safe came at
4.6–35.3 active minutes (median 17.6), inside the first two sessions on every seed. Over 400
seeds it is p50 12.3 min, p90 27.0 min.

**Pacing proof.** Safes add 5.35 % to crate coin income when every safe is paid at once (the
fastest case). The shipped sim with that income folded in (`runSimulation`, 24 players, 3 days)
still passes every pacing target, so no target moves:

| Seed | Ascend V1 active p50 (without safes) | V2 / V1 | Free season | First album set |
|---|---|---|---|---|
| 1 | 3 h 12 (3 h 17) | 1.61 × | 28.2 h | 14.7 min |
| 2 | 3 h 12 (3 h 16) | 1.61 × | 28.3 h | 12.0 min |
| 3 | 3 h 16 (3 h 18) | 1.64 × | 28.3 h | 15.1 min |

Casual Ascend V1 stays at 1.5 days. The margin: crate income could rise 20 % before Ascend V1
nears the 3 h floor (3 h 01 at × 1.2). Dropping the Exquisite Key leaves the casual player 2, 5,
9, 12, 15, 18, 21 crate Keys by days 1–7 (was 8 … 71), all of which the safes now use.

## Charms (T-3.01)

Numbers and rules: `packages/economy/src/config/charms.ts` (`charms`, `charmKindOf`,
`charmLevelForCopies`, `charmMasteryLevel`, `charmSetBonuses`, `charmEffect`,
`charmLoadoutValueCapBp`). Kinds and tags are `CHARM_KINDS` / `SYNERGY_TAGS` in
`packages/shared`; `validateEconomyConfig` rejects any catalog that breaks a rule below.

Every parameter is an integer: `mm`, `mmPerS` (a velocity change), `ticks` (60 Hz sim ticks),
`bp` (basis points) or `count`. The sim reads them as is, so replays stay bit-exact.

### Kinds and tags

Primary tag first. Every tag sits on exactly three kinds, so every 3-piece set fits venue 1's
three sockets and no set needs a later venue.

| Kind | Tags | What it does (level 1 → 10) | Boosted parameter |
|---|---|---|---|
| Golden Peg | gilded, kinetic | 2 pegs; every 20th → 12th coin that brushes one is gilded for +50 % → +100 % value | `gildBp` |
| Velvet Ropes | service, magnetic | a 24 → 42 mm rope that turns edge-bound coins inward by 60 → 120 mm/s | `deflectMmPerS` |
| Magnet Cufflinks | magnetic, gilded, fragrant | every 36 → 28 ticks, pulls 2 → 5 same-tier pairs within 30 → 48 mm together at 40 → 84 mm/s | `pullMmPerS` |
| Brass Bumper | kinetic, gilded | kicks a coin it touches forward 150 → 260 mm/s, rearms in 45 → 28 ticks | `kickMmPerS` |
| Butler | service, magnetic, fragrant | every 900 → 450 ticks sweeps 1 → 3 side-gutter coins back onto the bed | `periodTicks` |
| Perfume Atomizer | fragrant, kinetic, service | every 720 → 450 ticks, a 60 → 104 mm wedge of coins pushed 100 → 180 mm/s | `pushMmPerS` |

Why these tags: the cufflinks are gold and worn with cologne at the cuff; the Butler's dustpan
is magnetic and he leaves a trail of scent; the atomizer's puff is a push. The tags follow the
object, and the counts make every set reachable.

### Levels, mastery and sets

- **Levels** come from copies of one catalog id: level l at `copiesToLevel[l − 1]` =
  1, 2, 4, 7, 12, 20, 32, 50, 76, 116 copies. An edition levels apart from its base kind.
- **Mastery** level l (1–10) at `50 × 2^(l − 1)` server-accepted activations, +2 % (200 bp)
  each, so +20 % at level 10.
- **Sets** count distinct kinds per tag and take the highest tier reached. A kind slotted with
  its edition counts once.

| Tier | Effect boost | Value |
|---|---|---|
| 2 of a tag | +10 % | none |
| 3 of a tag | +25 % | none, except Gilded 3: +2 % payout |

- One charm takes at most +50 % from sets (`setBoostCapBp` 5,000; a Butler in a loadout with
  Magnetic 3, Service 3 and Fragrant 3 would otherwise take +75 %). Mastery adds on top.
- Boosts apply only to the kind's boosted parameter. `more` parameters scale up and round down,
  `less` parameters divide the wait and round up, so rounding never pays more than the boost.

**Why this curve** (`node sim/cli.ts --days 42 --players 40 --seed 1`, casual player, 50 active
min a day): the casual player owns 14 charms at day 1, 123 at day 7, 250 at day 14, 510 at day 28
and 776 at day 42, about 18.5 charm drops a day. At a 15 % share per base kind that is 2.8 copies
a day, so level 5 lands at day 4, level 7 at day 11, level 8 at day 18, level 9 at day 27 and
level 10 at day 42, the season's end. A level arrives every few days for the whole season and
the last one is the season's capstone, not a week-one formality.

### Value: charms move coins, only gilding mints

The rate envelope budgets 6 % fall value per slotted charm (`rateEnvelope.fallValue.value
.perCharm`). Physical charms (ropes, cufflinks, bumper, Butler, atomizer) have `valueCapBp` 0:
they move coins that already exist and never add value. Only the Golden Peg (`valueCapBp` 600)
and the Gilded 3 set (+200 bp) mint, and the server clamps the gilded extra to that cap per
envelope window.

- Expected Golden Peg uplift, assuming 40 % of falling coins brush a peg: level 1 1.0 %, level 10
  3.3 %, with mastery 10 4.0 %, with the full +50 % set boost 5.7 %. All under its 6 % cap.
- `validateEconomyConfig` checks every set of distinct kinds (2⁶ loadouts) and fast-check
  checks random loadouts up to the largest venue's 7 sockets: no loadout may mint more than
  6 % × charms slotted. The worst case, a Golden Peg plus two Gilded charms, may mint 8 % of a
  budgeted 18 %.
- No existing number changed, so every pacing target above still holds (first Charm p90 14 s).
  T-3.01-p2 measures the real brush share in the sim against the 6 % budget.

### Charm drops

When a crate or safe rolls its `charmChance`, the server picks a charm id from `charms.drops`.
The odds sum to exactly 100 % and are the ones the game shows.

| Id | Plays as | Odds |
|---|---|---|
| `golden-peg` | Golden Peg | 15 % |
| `velvet-ropes` | Velvet Ropes | 15 % |
| `magnet-cufflinks` | Magnet Cufflinks | 15 % |
| `brass-bumper` | Brass Bumper | 15 % |
| `butler` | Butler | 15 % |
| `perfume-atomizer` | Perfume Atomizer | 15 % |
| `captainsBellCharm` | Butler (the bell that calls him) | 4 % |
| `champagneBucketCharm` | Brass Bumper (the cork pop is a kick) | 4 % |
| `pearlNecklaceCharm` | Magnet Cufflinks (a matched strand pulls like to like) | 2 % |

Per kind: Golden Peg, Velvet Ropes and Perfume Atomizer 15 %, Magnet Cufflinks 17 %, Brass
Bumper and Butler 19 %. The three editions keep their album ids, which saved inventories already
hold, and `charmKindOf` maps each to the kind its theme names. The pearl necklace is the rare
one (2 %) so the album's last charm stays a chase. Any id no table maps throws, and a test walks
every season tier, quest, crate, safe, album entry and drop to prove each charm id resolves.

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
