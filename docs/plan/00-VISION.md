# CoinPosh: Game Design Vision

> A luxurious 3D coin pusher you can't put down. Every coin feels heavy, every
> drop sounds expensive, and every crate you push off the edge could be *the one*.

## Locked decisions (from the founder Q&A)

| Topic | Decision |
|---|---|
| Visual direction | **Rotating themed luxe venues**: each world is its own posh setting |
| Pacing | **Active + idle hybrid**: juicy taps while playing, server-computed offline earnings |
| Anti-cheat | **Server-authoritative economy on Cloudflare Workers + D1 + Durable Objects** |
| Stores | **Capacitor wrap** of the same web build (iOS + Android) |
| Lootboxes | Vault crates from the pusher, key-locked safes, scratch cards, gacha capsule machine |
| Meta | Prestige/venue ascension, collection album, upgrade tree + table mods, season pass + daily quests |
| Social | Leaderboards + weekly server events |
| Future monetization | Cosmetics + premium pass, rewarded ads, gem IAP, ad-free/starter packs (**all behind flags, off**) |
| 3D stack | Three.js WebGPURenderer (WebGL2 fallback) + React Three Fiber + Rapier WASM |
| Assets | Procedural geometry + PBR in code, CC0 HDRIs/textures |
| Audio | Procedural Web Audio SFX + CC0 lounge music per venue |
| Accounts / i18n | Instant guest account (server-side), optional Google/Apple link **early** (M10, cloud save across devices); EN / FR / DE |
| Rating | Teen+ (12+): no real-money gambling look, odds always visible |
| Orientation | Portrait, one thumb |
| First milestone | **Vertical slice: 1 fully polished venue** |
| Execution | Max parallelism: workflow fan-out with worktrees and a reviewer gate |
| Expansion, round 1 (2026-11-09) | Collecting, table mechanics, progression, social, events, side games, world, comfort, cosmetics, content: see **Expansion systems**. Scheduled as M10+ after M3, highest impact first (prizes, ranks, login calendar, Concierge) |
| Expansion, round 2 (2026-11-09) | Economy depth, competitive, player creation, game feel, retention, accessibility and ways to play, platforms, big-picture meta: same rules as round 1 |
| Expansion guardrails | Server owns every value; every random reward has visible odds and a pity counter; each table mechanic is deterministic in `packages/sim` with a hash test; cosmetics are earned in play, any paid version stays behind `flags.monetization = false` |
| Excluded on purpose | Slot reels, roulette and card games (12+); "edge suspense" teetering slow-mo (declined in round 2) |

## Design pillars

1. **Tactile luxury.** Coins are heavy metal with real PBR, real physics, real
   clinks. Nothing feels cheap or plastic.
2. **Constant anticipation.** At any moment something is *about* to fall: a crate
   teetering on the edge, a fusion about to fire, a champagne tower wobbling.
3. **Readable greed.** Numbers go up big and fast, and the player always knows
   why. Multipliers, combos and tiers are spelled out.
4. **Fair and certified.** Every random roll comes from the server and is
   provably fair (commit-reveal), with odds on screen. Trust becomes a feature.
5. **Always a reason to come back.** Offline vault, safes on timers, Golden
   Hour, weekly events, season track.

## Core loop (seconds → minutes → days)

```
 ┌─ 5 s ──────────────────────────────────────────────────────────┐
 │ Tap/drag to aim → drop coin → pusher sweeps → coins cascade     │
 │ off the ledge → Cascade combo → value lands in your Vault       │
 └────────────────────────────────────────────────────────────────┘
 ┌─ 1–3 min ──────────────────────────────────────────────────────┐
 │ Contact Fusion merges coins up a tier · a Vault Crate falls →   │
 │ cinematic unbox · spend on upgrades / place a new Charm         │
 └────────────────────────────────────────────────────────────────┘
 ┌─ 10–30 min ────────────────────────────────────────────────────┐
 │ Daily quests · open safes · gacha pull · album set completed ·  │
 │ Soirée Night run · push toward the Venue Ascension threshold    │
 └────────────────────────────────────────────────────────────────┘
 ┌─ Days / weeks ─────────────────────────────────────────────────┐
 │ Ascend → new venue · season pass tiers · weekly Heist event ·   │
 │ leaderboards · Heirloom coin collection                         │
 └────────────────────────────────────────────────────────────────┘
```

## Signature mechanics (what sets us apart from other roguelike pushers)

Other pushers are run-based item builders. CoinPosh is a **persistent luxury
table you design and grow**, with optional run-based nights layered on top.

### 1. Contact Fusion ("the Mint")
Three coins of the same tier that stay in contact for 0.4 s **fuse physically on
the table** into the next tier: Copper → Silver → Gold → Platinum → Diamond →
Heirloom. The fusion plays as a flash, a suction implosion, a new coin with a
little hop, and a rising chime. Drops become a spatial merge puzzle: *where* you
drop matters.

### 2. The Charm Board (table architecture)
The playfield has **sockets**. Players slot Charms, physical objects that change
the physics and the economy:
- **Golden Pegs**: a coin that brushes a peg is gilded (×value).
- **Velvet Ropes**: guide rails that funnel coins.
- **Magnet Cufflinks**: pull same-tier coins together (fusion helper).
- **Bumpers of Brass**: kick coins with a satisfying spring.
- **The Butler**: a tiny robot that sweeps the side gutters back onto the table.
- **Perfume Atomizer**: periodic puff that slides a wedge of coins forward.

Charms carry **synergy tags** (Gilded, Magnetic, Kinetic, Service, Fragrant). Two
or three charms with the same tag unlock a set bonus. Loadouts are saved per
venue. This is the deep, long-term build layer.

### 3. Cascade Combo with named tiers
Coins falling within 600 ms of each other build a combo ladder:
**Chic → Lavish → Opulent → Decadent → OBSCENE**. Each tier raises the
multiplier, the musical pitch, the bloom intensity and the haptic strength.
OBSCENE gets a gold confetti burst and a slow-mo beat.

### 4. Champagne Tower
A pedestal on the table collects stacked coins (coins that land on it stack
neatly). As the tower grows its payout multiplier grows, and so does its wobble.
The pusher eventually topples it into a **jackpot cascade**. The player decides
whether to feed it or avoid it, which gives a constant risk/reward tension.

### 5. Nudge and the Decorum meter
Shake the phone (accelerometer) or two-finger swipe to **nudge the cabinet**.
Each nudge fills the **Decorum** meter. Overdo it and the Concierge rings a bell
and freezes the table for 10 s with a disapproving cough. This is physical,
funny and skill-based, and the haptics sell it.

### 6. Sommelier Pour
Hold to pour a stream of coins and release on the beat marker for a
**Perfect Pour** bonus. It adds a skill expression for active players.

### 7. Heirloom Coins
Ultra-rare named coins with lore ("The Duchess's Sovereign, 1891"). They glow on
the table. Pushing one off adds it to the Album permanently, with a fanfare.

### 8. Golden Hour (appointment play)
Server-scheduled 15-minute global windows (twice a day, local evening) during
which coin values and crate rates spike. A push notification on mobile brings
players back.

### 9. Soirée Nights (run mode)
An 8-minute event on a fresh table seed. **Guests** arrive with requests
("The Duke wants 5 Platinum coins over the edge in 60 s"). Fulfilled requests
earn **Favors**, spent between guests on temporary perks (draft 1 of 3).
Run rewards are crates and keys. Runs are seeded and validated on the server.

### 10. The Velvet Vault (idle)
Winnings fill a glass vault under the table as a visible, growing pile of coins.
While the player is away, "the house keeps pushing". The server computes offline
earnings from the table's state (capped hours, upgradeable), and the return
screen shows an animated summary.

## Expansion systems (founder Q&A, 2026-11-09)

Two rounds of approved features, scheduled as M10+ in `04-ROADMAP.md`. Each entry
says what it is, why it is fun, and how the server keeps it honest. Numbers live
in `02-ECONOMY.md`; looks and sounds in `03-ART-AUDIO-JUICE.md`.

### Collecting
- **Physical prizes.** Luxury objects (watches, perfume, cufflinks, car keys) ride
  the table like crates; push one off and it joins your collection. *Fun:* a
  heavy, teetering object worth chasing, and a reason to aim. *Server:* prizes are
  server entities spawned by fair RNG; a claim is checked like a crate claim, and
  the prize is rolled and recorded on the server.
- **Coin variants.** Proof, misprint, foil and first-strike versions of every
  tier. *Fun:* any coin can be a find, and the Album gains a numismatist's layer.
  *Server:* the variant is rolled at mint and stored with the coin ID; the client
  never names one.
- **Trophy lounge.** A 3D room showing prizes, Heirlooms and trophies; pick any
  item up, rotate it, share a picture. *Fun:* the collection becomes a place.
  *Server:* the lounge only displays what the server says you own.
- **Wine cellar.** Bottles from crates and auctions age in real time and gain
  value; sell at the peak or keep them for the collection. *Fun:* slow,
  appointment-style anticipation. *Server:* age is computed from the server's
  laid-down time; the client clock is never read.

### Table mechanics
- **Bonus targets.** Holes and chutes in the back wall trigger a coin shower, a
  crate or a timed multiplier. *Fun:* a skill shot on every drop. *Server:* a
  target entry is a claim on a known coin; the reward is rolled on the server.
- **Peg field.** A pachinko-style field of brass pegs above the table. *Fun:* the
  drop becomes a little cascade of its own. *Server:* pure sim, bounded by the
  rate envelope.
- **Moving parts.** Turntables, conveyors and sliding gates; layouts vary per
  venue. *Fun:* each venue plays differently. *Server:* layouts are data the
  server knows, so envelopes and audits include them.
- **Jackpot ball.** A rare, heavy ball that pays big when pushed off. *Fun:* the
  whole table tilts toward one moment. *Server:* spawned and valued on the server.
- Every mechanic above is deterministic in `packages/sim` and ships with a
  determinism hash test.

### Progression
- **Ranks and titles.** Repute (XP) climbs noble titles, Commoner → Baron → Duke
  → Monarch, each unlocking perks or cosmetics. *Fun:* a visible social standing.
  *Server:* Repute comes only from server-observed events.
- **Achievements.** Hundreds of badges with rewards and a showcase. *Server:*
  unlocked by server counters, never by a client report.
- **Staff.** A butler, a valet and a sommelier, hired and levelled over time;
  each automates part of the table and boosts idle earnings. (The staff Butler is
  a person; "The Butler" charm stays a charm.) *Server:* wages, levels and the
  idle boost are server state, capped so offline still pays less than play.
- **Mastery.** Tracks per coin tier and per charm. *Server:* counted from claims
  and charm activations the server accepted.

### Social
- **Gifts.** A daily gift to friends by share code. *Server:* the house mints a
  fixed gift; nothing moves between wallets, so alts gain nothing.
- **Members' clubs.** Guilds with weekly club goals and emotes. No free-text chat
  unless it is moderated (open question in the roadmap).
- **Visit tables.** See a friend's table and lounge, leave a tip or a like.
  *Server:* read-only snapshot; tips are house-minted and capped.
- **Share big wins.** Photo mode and auto-clips of OBSCENE cascades and jackpots,
  shared from the device.

### Events
- **Login calendar.** 7- and 28-day calendars that advance on each claimed day
  and never reset. *Server:* one claim per server day.
- **Holiday events and seasonal tie-ins.** Themed tables, coins and limited
  collections, plus real luxury-calendar moments (grand prix week, fashion week,
  regatta season) with no brand names or trademarks.
- **Boss events.** A weekly cooperative boss (the Tax Inspector or a rival
  tycoon) with a shared health bar. Damage is the value you bank; the boss never
  takes coins.
- **Daily puzzle.** The same table seed and goal for everyone, with a
  leaderboard verified by replay.

### Side games (no slot reels, roulette or cards: 12+)
- **Claw machine.** Physics-based, spends Tickets, odds disclosed. *Server:* the
  grip result is rolled on the server and the sim plays it out.
- **Auction house.** Bid against NPC collectors whose ceilings are committed
  (hashed) before the lot opens.
- **Treasure hunt.** Map pieces from crates; a full map opens a hidden vault table.
- **Stock portfolio.** Fictional luxury companies whose price moves once a day,
  decided by the server from a committed seed. Coins only, never Pearls.

### World
- **The Concierge.** A named character with a personality who reacts to play
  and gives tips. *Fun:* the house has a face and a sense of humour.
- **Guest stories.** Recurring NPC guests whose arcs arrive as letters.
- **Day/night and weather.** Each venue follows its city's local time and
  weather. Cosmetic only.
- **Pet companion.** A poodle, cat or parrot that reacts and sometimes fetches a
  gutter coin back; breeds are collectible. The fetch is a seeded sim mechanic.

### Comfort and quality of life
- **Stats.** Lifetime totals, biggest cascade, best day, an earnings chart, all
  read from the server ledger.
- **Auto-drop.** An unlockable toggle; it costs coins like manual drops and stops
  when you put the phone down.
- **Big-win replays.** Slow-motion replays from a cinematic camera, rebuilt from
  the deterministic input log.

### Cosmetics (earned in play; any paid version stays behind the flag)
Table and pusher skins, coin monograms or crests, drop trails, sound packs and
lounge decor.

### Content
Venues 6+ (below), challenge modes (modifier tables), a music jukebox of
unlockable tracks, and a lore codex.

### Economy depth (round 2)
- **Workshop.** Combine prizes, variants and duplicate charms into new or
  upgraded items. Recipes are deterministic; any random output shows odds.
- **Smelting.** Melt surplus low-tier coins into Bullion bars at a poor rate: a
  late-game inflation sink.
- **Player trading.** Friends swap prizes and variants, one item for one item,
  server-validated, value-matched and rate-limited so it can't farm or move value
  to alts.
- **Charity gala.** A weekly coin donation for permanent flair and small buffs: a
  prestige sink.

### Competitive (round 2)
- **Weekly leagues.** Bronze → Silver → Gold → Platinum → Diamond groups of
  similar progress, with promotion and relegation.
- **Weekend tournaments.** A fixed seed and a fixed number of drops; results are
  verified by the replay verifier before they count.
- **Ghost races.** Race a friend's recorded run on the same seed, asynchronously.
- **Spectate.** Watch top tables live or as replays.

### Player creation (round 2)
- **Table editor.** Place pegs, targets and gates; share by code. The server
  validates every layout and caps what custom tables pay, so they can't farm.
- **Loadout codes.** Charm builds as share codes, plus a browser of popular builds.
- **Puzzle maker.** Build puzzles for friends and the community; the maker must
  solve it first.
- **Community votes.** Vote on the next venue, holiday coin or Heirloom design
  from options the team curates.

### Game feel (round 2)
- **Director camera.** Cuts to big moments (jackpot ball, tower topple); the
  reduced-motion variant highlights without cutting.
- **Adaptive music.** Tempo follows the drop rate, layers follow the Cascade tier,
  a sting plays on jackpots.
- **Haptic library.** A pattern per coin tier, prize and event.

### Retention (round 2)
- **Comeback gift and catch-up boost** for players away for days.
- **Goals board.** Always-visible short, medium and long goals.
- **Weekly chest.** Filled by all activity, opens on Sunday.
- **Rested boost.** A bonus for the first minutes back, on top of offline earnings.
- All of them are server-timed and included in the rate envelope.

### Accessibility and ways to play (round 2)
Left-hand mirrored HUD; Zen mode (no timers, meters or pressure); parental
settings (crates and reveals off, session limits, social hidden); a proper
landscape tablet layout; keyboard and mouse on desktop.

### Platforms (round 2)
An installable PWA with offline Demo play; a desktop build for Steam with Steam
achievements; home-screen widgets (Vault, offline earnings, next Golden Hour);
a QR code that moves a session from desktop to phone (needs account link).

### Big-picture meta (round 2)
- **Empire map.** Your venues on a map, travelled by private jet, each paying a
  small server-computed idle income.
- **Family dynasty.** At each ascension an heir with a trait carries an
  inheritance forward.
- **Society Pages.** A daily in-game newspaper of records, events and friends'
  feats, written from templates (no free text).

## Lootbox and reveal family

All rolls are made **on the server** with a provably-fair seed, odds are visible
in-game ("Certified Fair" badge), and every source has a **pity counter**.

| Source | How you get it | Reveal |
|---|---|---|
| **Vault Crates** | Physically fall onto the table, push them off the edge | 3D cinematic: lid shudders, light rays leak by rarity color, burst |
| **Key-locked Safes** | Dropped by crates/quests, open with Keys or wait on a timer | Dial spin + vault door swing, contents fly into the HUD |
| **Scratch Cards** | Quest rewards, Golden Hour | Finger-scratch shader (foil particles), 3-match reveal |
| **Gacha Capsule Machine** | Spend Tickets | Crank, capsule rolls down a chute, twist open |

Rarities: **Common · Fine · Rare · Exquisite · Legendary · Heirloom**
(ivory · emerald · sapphire · amethyst · gold · prismatic).

## Meta-progression

- **Upgrade tree** per venue: pusher speed, drop rate, coin value, crate chance,
  vault capacity, offline hours, fusion window, Decorum capacity.
- **Charms**: obtained from crates/gacha, levelled with duplicates.
- **Collection Album**: sets of coin skins, charms and Heirlooms. Completing a set
  gives a permanent global multiplier.
- **Venue Ascension (prestige)**: reaching the venue's Bullion threshold lets the
  player ascend, which resets the venue's coins and upgrades, grants **Gold Bars**
  (permanent multipliers), and unlocks the next venue. Previous venues remain
  playable.
- **Season Pass**: a 6-week season with a free track (live) and a premium track
  (built, but locked behind a feature flag), plus daily and weekly quests and
  login streaks with streak-freeze.

## Venues (rotating themed worlds)

| # | Venue | Palette | Twist mechanic |
|---|---|---|---|
| 1 | **Riviera Yacht** (vertical slice) | Navy lacquer, white teak, brushed gold, sunset coral | Gentle deck sway shifts coins with the waves |
| 2 | **Salon de Paris** | Blush pink, champagne gold, pistachio, pearl | Perfume bottles on the table burst into bonus mist |
| 3 | **Tokyo Penthouse** | Black lacquer, cinnabar red, neon violet skyline | A coin elevator lifts coins to a second tier |
| 4 | **Alpine Chalet** | Cognac leather, cream wool, warm oak, ice blue | Snow drift friction plus avalanche events |
| 5 | **Orbital Casino** | Iridescent chrome, deep violet, cyan | Low-gravity zones and floating coins |
| 6 | **Monaco Grand Prix** (proposal) | Racing red lacquer, carbon weave, ivory, champagne | A pit-lane conveyor laps coins around the table edge |
| 7 | **Venetian Palazzo** (proposal) | Terrazzo, Murano teal, oxblood velvet, gilt | A canal channel where coins drift with the tide |
| 8 | **Dubai Sky Villa** (proposal) | White marble, rose gold, sand, sky blue | High-altitude gusts push coins sideways |
| 9 | **Desert Oasis Train** (proposal) | Brass, teak, saffron, oasis green | Rail jolts act as free, rhythmic nudges |

## Retention and FTUE targets

- First coin drops **within 3 s** of load (no splash wall; the menu loads behind gameplay).
- First Cascade at 10 s, first Fusion within 60 s, first Vault Crate within 45 s
  (scripted), first upgrade within 2 min, first Charm within 5 min.
- KPI goals once on stores: D1 ≥ 40 %, D7 ≥ 15 %, average session ≥ 12 min.

## Ethics and store guardrails (12+)

- No real-money purchase of random items while monetization is off. When it is
  turned on: odds disclosure (Apple 3.1.1 / Google policy), pity timers, a
  region switch that disables paid random items (BE/NL), and spend caps for minors.
- No fake "near-miss" manipulation. Animation suspense is fine; lying about odds is not.
- No slot reels, roulette or card games, and no teetering "edge suspense" slow-mo.
- Every new random reward (variants, prizes, claw, heirs, weekly chest, calendar
  rolls) shows its odds and has a pity counter. Stocks, auctions and trading use
  soft currency only, never Pearls or anything bought.
- Parental settings can turn crates and reveals off: random rolls are then
  replaced by fixed bundles of the same expected value.
