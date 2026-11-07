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
| Accounts / i18n | Instant guest account (server-side), optional Google/Apple link later; EN / FR / DE |
| Rating | Teen+ (12+): no real-money gambling look, odds always visible |
| Orientation | Portrait, one thumb |
| First milestone | **Vertical slice: 1 fully polished venue** |
| Execution | Max parallelism: workflow fan-out with worktrees and a reviewer gate |

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
