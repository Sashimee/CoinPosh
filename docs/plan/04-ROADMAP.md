# CoinPosh: Execution Roadmap (the backlog agents execute)

**How to read this file.** Each task has a stable ID `T-<milestone>.<nn>`, an
**agent** (a `.claude/agents/*.md` subagent type), **deps** (task IDs that must be
`done` in `STATUS.md` first), **owns** (paths it may write; overlapping tasks
never run in the same wave), and **accept** (acceptance criteria the reviewer
checks). Status lives in `docs/plan/STATUS.md`, not here.

A **wave** is every task whose deps are done and whose `owns` paths don't overlap,
capped at 8. Waves run via `.claude/workflows/execute-wave.js`.

Human-only steps are marked **H-** and never picked by agents. Agents work around
them using Demo Mode / mocks until the human completes them.

---

## M0: Foundation (must finish before anything else; mostly sequential)

### T-0.01 · Monorepo scaffold
- **agent:** lead-architect
- **deps:** none
- **owns:** `/package.json`, `/pnpm-workspace.yaml`, `/pnpm-lock.yaml`, `/turbo.json`, `/tsconfig*.json`, `/.eslintrc*`, `/eslint.config.*`, `/.prettierrc*`, `/.gitignore`, `/.nvmrc`, `apps/web/` (skeleton only), `apps/server/` (skeleton only), `packages/*/package.json`, `docs/plan/STACK.lock.md`
- **accept:** `pnpm i && pnpm check` (typecheck + lint + test, all green) works from clean; Vite app renders a black canvas with three WebGPURenderer (WebGL2 fallback logged); Worker `wrangler dev` answers `GET /health`; exact versions recorded in STACK.lock.md; root scripts `dev`, `build`, `check`, `test`, `e2e`.

### T-0.02 · Shared contracts v1
- **agent:** lead-architect
- **deps:** T-0.01
- **owns:** `packages/shared/**`
- **accept:** zod schemas + inferred types for every endpoint in 01-ARCHITECTURE.md, entity IDs (branded types), error envelope, idempotency key header, `FeatureFlags` type (monetization=false), unit tests for round-trip parsing.

### T-0.03 · CI + GitHub Pages deploy
- **agent:** lead-architect
- **deps:** T-0.01
- **owns:** `.github/workflows/**`, `apps/web/vite.config.ts`, `apps/web/public/404.html`
- **accept:** PR workflow runs `pnpm check` + build; `deploy-web.yml` deploys `apps/web/dist` to Pages on push to `main` with base `/CoinPosh/`; `deploy-server.yml` runs only if `CLOUDFLARE_API_TOKEN` secret exists (skips cleanly otherwise) and prints the deployed `workers.dev` URL; the web build reads the repo variable `VITE_API_URL` (`${{ vars.VITE_API_URL }}`), and an unset or empty value builds Demo Mode.

### T-0.04 · Deterministic sim core skeleton
- **agent:** physics-engineer
- **deps:** T-0.01
- **owns:** `packages/sim/**`
- **accept:** Rapier initialised with fixed 60 Hz step; seeded xoshiro128** PRNG; `Sim.step(inputs)` and `Sim.hash()`; a test that runs 3,600 ticks twice with the same seed + inputs and gets identical hashes (in Node); lint rule bans `Math.random`/`Date` in `packages/sim`.

### T-0.05 · Economy package skeleton + config schema
- **agent:** economy-designer
- **deps:** T-0.01
- **owns:** `packages/economy/**`
- **accept:** typed config for currencies, coin tiers, upgrade lines, drop tables, pity; validator ensures odds sum to 100 %; `pnpm --filter economy sim --days 7` prints a pacing summary.

### H-0.01 · Human: enable GitHub Pages (Settings → Pages → Source: GitHub Actions)
### H-0.02 · Human: create Cloudflare account, D1 database, API token → repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## M1: Vertical Slice: Riviera Yacht (max parallel)

### T-1.01 · Pusher table physics
- **agent:** physics-engineer
- **deps:** T-0.04
- **owns:** `packages/sim/src/table/**`
- **accept:** two-tier table, sweeping pusher (configurable speed/stroke), side gutters, front edge with fall detection events `{coinId, edge}`; coin bodies with tuned friction/restitution feel "heavy"; 250 coins at 60 Hz under 4 ms/step on desktop; sleeping enabled.

### T-1.02 · Contact Fusion + Champagne Tower sim
- **agent:** physics-engineer
- **deps:** T-1.01
- **owns:** `packages/sim/src/mechanics/**`
- **accept:** 3 same-tier coins in contact ≥ 0.4 s emit `fusion {ids, tick}` and the sim replaces them; tower pedestal stacks coins, tracks wobble and topples deterministically; determinism test still passes.

### T-1.03 · Physics worker bridge + interpolation
- **agent:** physics-engineer
- **deps:** T-1.01
- **owns:** `apps/web/src/game/simWorker/**`
- **accept:** sim runs in a Web Worker; transforms delivered via SharedArrayBuffer (when isolated) or transferable ring; render interpolation smooth at 120 Hz display; main thread < 2 ms/frame for 250 coins.

### T-1.04 · Riviera Yacht venue scene
- **agent:** render-artist
- **deps:** T-0.01
- **owns:** `apps/web/src/scene/venues/riviera/**`, `apps/web/src/scene/env/**`
- **accept:** procedural table (navy lacquer, teak, gold trims), CC0 sunset HDRI, ocean backdrop shader with gentle waves, deck sway animation hook, palette.ts with tokens from 03-ART bible; looks "expensive" in screenshot review; 60 fps on mid GPU.

### T-1.05 · Coin rendering (instanced, procedural PBR)
- **agent:** render-artist
- **deps:** T-0.01
- **owns:** `apps/web/src/scene/coins/**`
- **accept:** lathe coin geometry with reeded edge; TSL embossed face (monogram + laurel) per tier; anisotropic brushed metal; one InstancedMesh per tier; Heirloom prismatic material; LOD for far coins.

### T-1.06 · Post-processing + adaptive quality
- **agent:** render-artist
- **deps:** T-0.01
- **owns:** `apps/web/src/scene/post/**`, `apps/web/src/scene/quality/**`
- **accept:** AgX tonemap, bloom, vignette, grain; 3 quality tiers chosen by first-boot benchmark; dynamic resolution keeps ≥ 55 fps.

### T-1.07 · Server: auth, PlayerDO, conservation ledger
- **agent:** backend-engineer
- **deps:** T-0.02
- **owns:** `apps/server/**`
- **accept:** guest auth with device-key-signed requests; PlayerDO handles drop (debit + mint IDs), claims (fall/fusion/crate) with conservation checks, idempotency; D1 migrations; append-only ledger; Vitest with miniflare covers: double-claim rejected, unknown ID rejected, forged value ignored, fusion tier mismatch rejected; CORS allows only `https://sashimee.github.io` and localhost dev origins.

### T-1.08 · Server: provably fair RNG + rate envelopes
- **agent:** backend-engineer
- **deps:** T-1.07
- **owns:** `apps/server/src/rng/**`, `apps/server/src/envelope/**`
- **accept:** HMAC commit-reveal seeds with rotate endpoint; sliding-window envelope from economy config; over-envelope claims rejected + flagged; tests.

### T-1.09 · Client net layer + Demo Mode mock
- **agent:** backend-engineer
- **deps:** T-0.02
- **owns:** `apps/web/src/net/**`
- **accept:** typed API client from shared contracts; pre-minted coin buffer; offline claim queue with reconciliation; in-browser mock server implementing the same contracts (Demo Mode banner when `VITE_API_URL` unset).

### T-1.10 · Gameplay glue: aim, drop, pour, nudge, combo
- **agent:** gameplay-engineer
- **deps:** T-1.03, T-1.09
- **owns:** `apps/web/src/game/systems/**`, `apps/web/src/game/input/**`
- **accept:** one-thumb aim + tap drop; hold-to-pour with Perfect Pour window; nudge (two-finger swipe / DeviceMotion) with Decorum meter + Concierge freeze; Cascade combo tiers Chic→OBSCENE; all events dispatched on a typed event bus consumed by vfx/audio/ui.

### T-1.11 · HUD + core UI shell
- **agent:** ui-engineer
- **deps:** T-0.02
- **owns:** `apps/web/src/ui/**`, `apps/web/src/app/**`, `apps/web/src/i18n/**`
- **accept:** portrait layout (safe-areas), odometer balance, combo ladder, Decorum meter, upgrades drawer, settings (audio sliders, quality, language EN/FR/DE), venue-tinted theme from palette tokens; spring transitions; works at 360×640 → desktop centered.

### T-1.12 · VFX: drop, fusion, cascade, number pops
- **agent:** vfx-juice
- **deps:** T-1.05
- **owns:** `apps/web/src/vfx/**`
- **accept:** GPU particle system (TSL compute where WebGPU, fallback CPU); effects for drop trail, contact sparks, fusion implosion + shockwave, OBSCENE confetti; floating value text arcs into HUD; hit-stop & camera kick utilities.

### T-1.13 · Procedural audio engine + Riviera music
- **agent:** audio-engineer
- **deps:** T-0.01
- **owns:** `apps/web/src/audio/**`, `apps/web/public/audio/**`
- **accept:** modal-synth coin impacts (coin/wood/metal) driven by collision velocity; voice pooling; pentatonic combo ladder; music director with CC0 lounge loop + intensity layers; mixer; unlock-on-first-gesture; credits file for CC0 sources.

### T-1.14 · Vault Crates end-to-end + unbox cinematic
- **agent:** gameplay-engineer
- **deps:** T-1.07, T-1.10, T-1.12
- **owns:** `apps/web/src/game/crates/**`, `apps/web/src/vfx/cinematics/unbox/**`
- **accept:** server spawns crate entity into table; pushing off edge claims it; server rolls contents (fair RNG, pity); cinematic per 03-ART spec with rarity god-rays; scripted FTUE crate at drop 12.

### T-1.15 · Upgrades v1 + Velvet Vault offline earnings
- **agent:** gameplay-engineer
- **deps:** T-1.07, T-1.11
- **owns:** `apps/web/src/game/upgrades/**`, `apps/web/src/game/vault/**`, `apps/server/src/routes/upgrades.ts`, `apps/server/src/routes/offline.ts`
- **accept:** 6 upgrade lines from economy config, server-validated purchases; offline earnings computed server-side; return screen with vault avalanche + odometer.

### T-1.16 · Balancing pass for the slice
- **agent:** economy-designer
- **deps:** T-0.05, T-1.02
- **owns:** `packages/economy/src/config/**`, `packages/economy/sim/**`, `docs/plan/balance-reports/**`
- **accept:** sim-driven numbers hit FTUE targets in 00-VISION; rate-envelope table generated for server; property tests for conservation & odds; report committed.

### T-1.17 · E2E + perf gates
- **agent:** qa-perf
- **deps:** T-1.10, T-1.11
- **owns:** `apps/web/e2e/**`, `.github/workflows/perf.yml`
- **accept:** Playwright: boot → first drop < 3 s, crate unbox flow, settings persist; perf script records fps & frame time on CI chromium (WebGL2) with thresholds; screenshot set for reviewer.

### T-1.18 · Slice integration + polish sweep
- **agent:** lead-architect
- **deps:** T-1.01 … T-1.17 (all of M1)
- **owns:** any (runs alone in its wave)
- **accept:** full loop playable on GitHub Pages in Demo Mode (and live if H-0.02 done); juice checklist ≥ 4 per interaction audited; no console errors; Lighthouse perf ≥ 80 mobile; tag `v0.1.0-slice`.

---

## M2: Lootbox family & reveals

### T-2.01 · Key-locked Safes (server + client + cinematic) — **agent:** gameplay-engineer — **deps:** T-1.18 — **owns:** `apps/web/src/game/safes/**`, `apps/web/src/vfx/cinematics/safe/**`, `apps/server/src/routes/safes.ts` — **accept:** server timers, key spend, dial/door cinematic, pity.
### T-2.02 · Scratch Cards (GPU scratch mask) — **agent:** vfx-juice — **deps:** T-1.18 — **owns:** `apps/web/src/game/scratch/**`, `apps/web/src/vfx/scratch/**`, `apps/server/src/routes/scratch.ts` — **accept:** render-target brush, foil flakes, 3-match reveal from server roll.
### T-2.03 · Gacha Capsule Machine — **agent:** render-artist — **deps:** T-1.18 — **owns:** `apps/web/src/scene/gacha/**`, `apps/web/src/game/gacha/**`, `apps/server/src/routes/gacha.ts` — **accept:** procedural 3D machine, crank physics, chute, capsule pop; ticket spend; odds screen link.
### T-2.04 · Odds & "Certified Fair" UI — **agent:** ui-engineer — **deps:** T-1.18 — **owns:** `apps/web/src/ui/fair/**` — **accept:** odds tables from economy config, pity counters, seed verify page (recompute HMAC client-side).
### T-2.05 · Inventory & item cards — **agent:** ui-engineer — **deps:** T-1.18 — **owns:** `apps/web/src/ui/inventory/**` — **accept:** rarity-framed 3D item cards (offscreen render), sort/filter, duplicate → level-up.

## M3: Meta-progression

### T-3.01 · Charm Board (sockets, 6 charms, synergy tags) — **agent:** physics-engineer — **deps:** T-2.05 — **owns:** `packages/sim/src/charms/**`, `apps/web/src/game/charms/**` — **accept:** charms alter sim deterministically; equip validated server-side; set bonuses.
### T-3.02 · Charm models & effects — **agent:** render-artist — **deps:** T-2.05 — **owns:** `apps/web/src/scene/charms/**` — **accept:** procedural models for each charm, idle animations, activation FX.
### T-3.03 · Collection Album + Heirloom coins — **agent:** ui-engineer — **deps:** T-2.05 — **owns:** `apps/web/src/ui/album/**`, `apps/server/src/routes/album.ts` — **accept:** sets, completion bonuses, Heirloom lore cards, fanfare.
### T-3.04 · Venue Ascension (prestige) + Family Office — **agent:** gameplay-engineer — **deps:** T-2.05 — **owns:** `apps/web/src/game/ascension/**`, `apps/server/src/routes/ascend.ts`, `apps/web/src/vfx/cinematics/ascend/**` — **accept:** server-validated reset, Gold Bars, permanent upgrades, 3 s cinematic.
### T-3.05 · Quests, streaks, Season Pass (free track; premium behind flag) — **agent:** backend-engineer — **deps:** T-2.05 — **owns:** `apps/server/src/routes/quests.ts`, `apps/server/src/routes/season.ts`, `apps/server/src/cron/**`, `apps/web/src/ui/season/**` — **accept:** daily/weekly rotation via cron, streak freeze, season track UI.
### T-3.06 · Soirée Nights run mode — **agent:** gameplay-engineer — **deps:** T-3.01 — **owns:** `apps/web/src/game/soiree/**`, `apps/server/src/routes/soiree.ts` — **accept:** seeded 8-min run, Guest requests, Favor drafts, server-validated rewards.
### T-3.07 · Meta balancing — **agent:** economy-designer — **deps:** T-3.04, T-3.05 — **owns:** `packages/economy/**` — **accept:** ascension 3–5 h, season ≈ 30 h, sim report.

## M4: Social & live ops

### T-4.01 · Leaderboards (weekly, friends via share code) — **agent:** backend-engineer — **deps:** T-3.07 — **owns:** `apps/server/src/do/EventDO.ts`, `apps/server/src/routes/leaderboard.ts`, `apps/web/src/ui/leaderboard/**` — **accept:** sharded DO boards, shadow-pool for flagged, top-N always audited.
### T-4.02 · Golden Hour + weekly Heist event — **agent:** backend-engineer — **deps:** T-4.01 — **owns:** `apps/server/src/events/**`, `apps/web/src/game/events/**` — **accept:** cron-scheduled windows, global progress bar, rewards.
### T-4.03 · Replay audit verifier — **agent:** physics-engineer — **deps:** T-3.01 — **owns:** `apps/server/src/audit/**`, `tools/verifier/**` — **accept:** queue consumer / container replays sampled input logs, hash compare, flags.

## M5: Venues 2–5 (one task per venue, fully parallel)

### T-5.01 · Salon de Paris — **agent:** render-artist — **deps:** T-1.18 — **owns:** `apps/web/src/scene/venues/paris/**`, `packages/sim/src/venues/paris/**` — **accept:** palette, props, perfume-burst twist, music loop.
### T-5.02 · Tokyo Penthouse — **agent:** render-artist — **deps:** T-1.18 — **owns:** `apps/web/src/scene/venues/tokyo/**`, `packages/sim/src/venues/tokyo/**` — **accept:** coin elevator twist.
### T-5.03 · Alpine Chalet — **agent:** render-artist — **deps:** T-1.18 — **owns:** `apps/web/src/scene/venues/alpine/**`, `packages/sim/src/venues/alpine/**` — **accept:** snow friction + avalanche.
### T-5.04 · Orbital Casino — **agent:** render-artist — **deps:** T-1.18 — **owns:** `apps/web/src/scene/venues/orbital/**`, `packages/sim/src/venues/orbital/**` — **accept:** low-gravity zones.
### T-5.05 · Venue music & ambience pack — **agent:** audio-engineer — **deps:** T-1.18 — **owns:** `apps/web/src/audio/venues/**`, `apps/web/public/audio/**` — **accept:** one loop set per venue, ambience beds.

## M6: Polish, accessibility, i18n, performance

### T-6.01 · FTUE / onboarding script — **agent:** ui-engineer — **deps:** T-3.07 — **owns:** `apps/web/src/ui/onboarding/**`
### T-6.02 · Accessibility (reduced motion, colorblind rarity glyphs, haptics off, text scale) — **agent:** ui-engineer — **deps:** T-6.01 — **owns:** `apps/web/src/ui/a11y/**`
### T-6.03 · FR/DE translation pass + number formatting — **agent:** ui-engineer — **deps:** T-6.01 — **owns:** `apps/web/src/i18n/**`
### T-6.04 · Perf hardening on low-end Android profile — **agent:** qa-perf — **deps:** T-5.04 — **owns:** `apps/web/src/scene/quality/**`, `apps/web/e2e/perf/**`
### T-6.05 · Full juice audit (every interaction ≥ 4 checklist items) — **agent:** vfx-juice — **deps:** T-5.04 — **owns:** `apps/web/src/vfx/**`
### T-6.06 · Security review of server + client trust boundaries — **agent:** reviewer — **deps:** T-4.03 — **owns:** `docs/security/**`

## M7: Mobile (Capacitor)

### T-7.01 · Capacitor shell iOS/Android — **agent:** mobile-engineer — **deps:** T-6.04 — **owns:** `apps/mobile/**`
### T-7.02 · Haptics, accelerometer nudge, push (Golden Hour) — **agent:** mobile-engineer — **deps:** T-7.01 — **owns:** `apps/mobile/src/plugins/**`, `apps/web/src/platform/**`
### T-7.03 · App Attest / Play Integrity → server verification — **agent:** backend-engineer — **deps:** T-7.01 — **owns:** `apps/server/src/attest/**`
### T-7.04 · Store assets & compliance (privacy labels, odds disclosure, age rating) — **agent:** mobile-engineer — **deps:** T-7.02 — **owns:** `docs/store/**`
### H-7.01 · Human: Apple Developer + Google Play accounts, signing keys

## M8: Monetization readiness (flags OFF)

### T-8.01 · Store catalog + IAP abstraction (RevenueCat-ready, Noop default) — **agent:** backend-engineer — **deps:** T-7.03 — **owns:** `apps/server/src/store/**`, `apps/web/src/store/**`
### T-8.02 · Rewarded ads interface + placements (Noop) — **agent:** gameplay-engineer — **deps:** T-7.02 — **owns:** `apps/web/src/ads/**`
### T-8.03 · Region policy + spend caps + premium pass gate — **agent:** economy-designer — **deps:** T-8.01 — **owns:** `packages/economy/src/policy/**`

## M9: Table persistence (#92)

Design: `docs/plan/design/92-table-persistence.md` (decisions D1..D7). A reload restores every coin and crate from server-stored poses; only non-heap coins without a valid pose are refunded. T-92.01, T-92.02 and T-92.03 run in parallel.

### T-92.01 · Shared contracts for table persistence
- **agent:** lead-architect
- **deps:** none
- **owns:** `packages/shared/src/api/table.ts`, `packages/shared/src/api/table.test.ts`, `packages/shared/src/api/endpoints.ts`, `packages/shared/src/api/endpoints.test.ts`, `packages/shared/src/ids.ts`, `packages/shared/src/ids.test.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/errors.test.ts`
- **accept:** design section 2. `PoseTupleSchema`, `CratePoseTupleSchema`, `MAX_SNAPSHOT_COINS = 320`, `MAX_SNAPSHOT_CRATES = 16`, `TableSnapshotRequest`/`Response`; `POST /v1/table/snapshot` in the endpoints map (signed, Idempotency-Key); `TableSessionId` (prefix `session`) and a `session` field on drop, claims, nudge and snapshot requests; `TableSnapshot` gains `session` and a nullable `layout` (`pusher`, coin placements `pose | heapSlot`, crate placements `pose | chute`) with a refinement that pose ids match `coins[i]`/`crates[i]`; error codes `session_superseded` (409) and `stale_snapshot` (409). Tests cover 320/321 and 16/17 limits, extra keys, int ranges, placement alignment. No value, tier or wallet field on any upload. `pnpm check` green.

### T-92.02 · Sim snapshot, restore and pose validation
- **agent:** physics-engineer
- **deps:** none
- **owns:** `packages/sim/src/snapshot/**`, `packages/sim/src/sim.ts`, `packages/sim/src/sim.test.ts`, `packages/sim/src/table/**`, `packages/sim/src/constants.ts`, `packages/sim/package.json`
- **accept:** design section 1. `sim.snapshot()` (quantized: 10 µm positions, int16 quaternions with w >= 0, awake/asleep, pusher tickInCycle); `Sim.create({ restore })` with `pose` and `heapSlot` entries, zero velocities, one separation pass, support probe, lifted heap slots restore awake, tower refuses restore; Rapier-free `@coinposh/sim/snapshot` subpath exporting `checkPose`, `validateSnapshot`, `CRATE_RIDE` and `checkCratePose` (a test proves it does not import Rapier). Tests from 1.4 pass: round trip then 3600 ticks equal, pinned hash with a SIM_VERSION bump, quantization fixed point, restore stability at 4 pusher phases (asleep coins move < 1 mm in 120 ticks, no spurious falls), all-heap-slot restore hashes equal to `openingHeap`, Node/browser parity, boundary tests for every rejection reason. `pnpm --filter @coinposh/sim check` green.

### T-92.03 · Crate spawns cannot be re-earned through refunds (#84)
- **agent:** backend-engineer
- **deps:** none
- **owns:** `apps/server/src/do/PlayerDO.ts`, `apps/server/src/do/schema.ts`, `apps/server/src/do/schema.test.ts`, `apps/server/src/do/reload.test.ts`
- **accept:** crate spawns are driven by a high-water mark over net non-refunded drops, so a boot refund cannot let the same spend spawn a second crate; a test drops to the spawn threshold, boot-refunds, drops again and gets no extra crate; ledger conservation holds. Closes #84. `pnpm --filter @coinposh/server check` green.

### T-92.04 · Server: pose storage, snapshot endpoint, boot placement
- **agent:** backend-engineer
- **deps:** T-92.01, T-92.02, T-92.03
- **owns:** `apps/server/src/do/schema.ts`, `apps/server/src/do/schema.test.ts`, `apps/server/src/do/PlayerDO.ts`, `apps/server/src/do/entities.ts`, `apps/server/src/do/snapshot.ts`, `apps/server/src/do/snapshot.test.ts`, `apps/server/src/do/reload.test.ts`, `apps/server/src/do/openingHeap.test.ts`, `apps/server/src/routes/table.ts`, `apps/server/src/routes/table.test.ts`, `apps/server/package.json`
- **accept:** design sections 3 and 4.1. Migration 5 (`table_snapshot` single row with coin and crate poses, `coins.heap_slot` with backfill) applies on an existing v4 DO; `seedOpeningHeap` writes heap slots; the snapshot pipeline (session, seq/tick ordering, 1 per 2 s burst 3, structure, ownership, `checkPose`/`validateSnapshot`, teleport bound, crate rules, omitted entries keep their pose) has one test per step and per row of the 3.3 table; boot places posed coins, lays unposed heap coins at their `heapSlot` (no refund), refunds only unposed non-heap coins (wallet gets at most what it paid), places crates as `pose` or `chute`, rebases `dropped_tick`/`spawned_tick` to 0; a claim at new-session tick 0 is accepted for a restored coin and crate; an idempotent replay writes nothing; no snapshot path writes to the ledger (test). `pnpm --filter @coinposh/server check` green.

### T-92.05 · Net layer: snapshot op, cadence, keepalive, drain before boot, mock
- **agent:** backend-engineer
- **deps:** T-92.01, T-92.02
- **owns:** `apps/web/src/net/**`
- **accept:** design sections 2.2, 2.3, 4.2 and 4.3. A coalescing snapshot outbox op ordered after drops and claims; the outbox key partitioned by session; triggers (settle 1 s, >= 3 s apart, heartbeat 10 s only on change, skip unchanged, immediate on hidden) tested with a fake clock; one pre-signed keepalive request kept for `pagehide` and rebuilt on token refresh (no `sendBeacon`); the persisted outbox drains before `hydrate=boot`; `session` on every table op and `session_superseded` surfaced as an event; `openingLayout` replaces `openingTableCoins`; the mock implements the endpoint, session rotation, validation and `layout` in memory (Demo Mode stays fresh on reload) with contract tests shared with the server. `pnpm --filter @coinposh/web check` green.

### T-92.06 · Worker bridge: restore init and snapshot
- **agent:** physics-engineer
- **deps:** T-92.02
- **owns:** `apps/web/src/game/simWorker/**`
- **accept:** the init message takes `restore` (mutually exclusive with `openingHeap`) and validates it; the bridge exposes `snapshot()` to the main thread; a bridge test restores, steps and hashes the same as `Sim` directly. `pnpm --filter @coinposh/web check` green.

### T-92.10 · Crate ride snapshot and restore
- **agent:** gameplay-engineer
- **deps:** T-92.02
- **owns:** `apps/web/src/game/crates/**`
- **accept:** design section 1.5. `CrateRide.snapshot()` returns a `CratePose`; `CrateRide.restore(crate, pose, stroke)` resumes the ride; `ride.ts` takes its bounds from `CRATE_RIDE` in `@coinposh/sim/snapshot`; a test shows a ride snapshotted and restored mid-way reaches teeter and fell on the same steps as an uninterrupted one, and every snapshot it emits passes `checkCratePose`. `pnpm --filter @coinposh/web check` green.

### T-92.07 · Boot glue, binding, snapshot triggers and "Play here"
- **agent:** gameplay-engineer
- **deps:** T-92.05, T-92.06, T-92.10
- **owns:** `apps/web/src/main.ts`, `apps/web/src/game/systems/**`, `apps/web/src/game/session/**`
- **accept:** boot restores from `layout` through the bridge and binds sim id `i` to `coins[i]`; crates start from `pose` or `chute`; snapshot triggers wired to the sim's settle and fall events and to `visibilitychange`/`pagehide`; on `session_superseded` input stops and a "This table is open elsewhere" overlay with "Play here" re-boots and takes the table back (EN/FR/DE strings, reduced-motion variant); Demo Mode boots fresh; no console errors. `pnpm check` green.

### T-92.08 · Session lease on every table op (#85)
- **agent:** backend-engineer
- **deps:** T-92.04
- **owns:** `apps/server/src/do/PlayerDO.ts`, `apps/server/src/do/reload.test.ts`, `apps/server/src/routes/table.ts`, `apps/server/src/routes/table.test.ts`
- **accept:** drop, claims, nudge and snapshot from a non-current session return `session_superseded` and write nothing; a second boot fences the first session; a boot restores the other tab's coins from its poses instead of refunding them. Closes #85. `pnpm --filter @coinposh/server check` green.

### T-92.09 · E2E: the table survives a re-boot
- **agent:** qa-perf
- **deps:** T-92.07, T-92.08, T-1.17
- **owns:** `apps/web/e2e/table-persistence.spec.ts`
- **accept:** in Demo Mode, drop 20 coins and wait for a crate, wait for the settle upload, then re-boot in-page against the same mock instance: every coin is within 1 mm of its pose, the crate resumes its ride, the wallet is unchanged and nothing was refunded; two pages on one mock: the first shows the overlay and "Play here" takes the table back; boot frame time stays within the T-1.17 budget.

---

# Expansion: M10+ (founder Q&A, 2026-11-09, rounds 1 and 2)

Design in `00-VISION.md` (Expansion systems), numbers in `02-ECONOMY.md` (Expansion
economy), looks in `03-ART-AUDIO-JUICE.md`. M9 and the core (M1–M3) stay first.

**Order.** M10 (account link) is the one item moved forward: it depends only on
done work and runs beside M9, because once M9 makes the table persist on the server,
a lost guest token is the only way left to lose progress, and every social,
competitive and platform feature later needs a stable cross-device identity.
M11+ start after M3 (each numbers task depends on T-3.07) and are ordered by impact:
collecting (prizes), standing (ranks), live events (login calendar), world
(Concierge), retention, table mechanics, game feel, comfort, accessibility,
social, competitive, economy depth, side games, player creation, cosmetics,
big-picture meta, platforms, content. Where deps allow, M11+ tasks run alongside
M4–M8; tasks that need M4 (EventDO, leaderboards, verifier) or M7 (Capacitor) say so.

**Shape of a milestone.** `.01` contracts (lead-architect) → `.02` numbers
(economy-designer) → sim, server, client and art tasks in parallel → wiring
(lead-architect) → e2e (qa-perf). Feature code lives in feature folders so tasks
in one wave don't collide; T-11.01 and T-11.02 create the seams:

| Kind | Path | Owner |
|---|---|---|
| Contracts | `packages/shared/src/api/<theme>/**` | lead-architect |
| Numbers | `packages/economy/src/config/<theme>/**`, `packages/economy/sim/<theme>/**`, `docs/plan/balance-reports/<theme>/**` | economy-designer |
| Sim mechanic | `packages/sim/src/props/<feature>/**` | physics-engineer |
| Server feature (routes, PlayerDO handlers, DO tables) | `apps/server/src/features/<feature>/**` | backend-engineer |
| Client API + Demo mock | `apps/web/src/net/features/<feature>/**` | backend-engineer |
| Game glue | `apps/web/src/game/<feature>/**` | gameplay-engineer |
| UI and strings | `apps/web/src/ui/<feature>/**`, `apps/web/src/i18n/locales/*/<feature>.json` | ui-engineer |
| Scene, VFX, audio | `apps/web/src/scene/<feature>/**`, `apps/web/src/vfx/<feature>/**`, `apps/web/src/audio/<feature>/**` | render-artist, vfx-juice, audio-engineer |
| Registries (wiring tasks only) | `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `packages/sim/src/props/index.ts`, `apps/web/src/main.ts`, `apps/server/wrangler.jsonc` | lead-architect |

Every feature task, unless it says otherwise, also accepts: EN/FR/DE strings,
reduced-motion variant, no console errors, Demo Mode works (the mock implements
the feature), every random reward shows odds and has pity, no client-sent value,
tier, reward or timestamp is trusted (a test sends a forged one), and the
package's `pnpm --filter <pkg> check` (or `pnpm check`) is green. Every sim
mechanic has a determinism hash test (3,600 ticks twice, same hash) and stays
inside the `table.bench` budget under the P-253 rule.

## M10: Account link and cloud save (moved forward; runs beside M9)

### T-10.01 · Account link contracts — **agent:** lead-architect — **deps:** none — **owns:** `packages/shared/src/api/account.ts`, `packages/shared/src/api/account.test.ts`, `packages/shared/src/api/endpoints.ts`, `packages/shared/src/api/endpoints.test.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/errors.test.ts` — **accept:** `POST /v1/account/nonce`, `POST /v1/account/link {provider: google|apple, idToken, nonce}`, `POST /v1/auth/signin {provider, idToken, nonce, devicePublicKey}`, `POST /v1/account/unlink`, `GET /v1/account`; errors `identity_in_use` (409), `invalid_id_token` (401), `provider_unavailable` (503); the sign-in response carries a `choice` when this device holds a different guest with progress; no wallet or value field on any request; round-trip and extra-key tests.
### T-10.02 · Server: verify ID tokens, link, sign in on a new device — **agent:** backend-engineer — **deps:** T-10.01 — **owns:** `apps/server/src/auth/link/**`, `apps/server/src/routes/account.ts`, `apps/server/src/routes/account.test.ts`, `apps/server/migrations/0002_identities.sql`, `apps/server/src/index.ts`, `apps/server/src/env.ts` — **accept:** Google and Apple ID tokens verified against cached JWKS (`iss`, `aud`, `exp`, server-issued single-use `nonce`); `identities(provider, subject)` unique per player; link idempotent; sign-in registers the new device key and issues tokens, the old device keeps working until unlinked; sign-in onto a device holding an unlinked guest with progress returns `choice` and never merges wallets; missing secrets → `provider_unavailable` with guest play unaffected; tests with a local JWKS key pair cover forged signature, wrong `aud`, expired, replayed nonce, subject linked to another player.
### T-10.03 · Net layer + Demo mock for account link — **agent:** backend-engineer — **deps:** T-10.01, T-92.05 — **owns:** `apps/web/src/net/account.ts`, `apps/web/src/net/account.test.ts`, `apps/web/src/net/mock/account.ts`, `apps/web/src/net/mock/server.ts`, `apps/web/src/net/index.ts` — **accept:** typed client for the account endpoints; Google Identity Services and Sign in with Apple JS load only on tap (not in the initial bundle); a sign-in swaps the session and re-boots the table through `hydrate=boot`; the Demo mock offers a clearly labelled fake provider; tests.
### T-10.04 · Account UI: link, sign in, progress choice — **agent:** ui-engineer — **deps:** T-10.03 — **owns:** `apps/web/src/ui/account/**`, `apps/web/src/ui/panels/settingsPanel.ts`, `apps/web/src/i18n/locales/*/account.json` — **accept:** Settings → "Keep my progress" with Google and Apple buttons per provider guidelines; a gentle prompt after the first ascension or 2 h of play, never a wall; a progress-choice sheet comparing both saves (venue, Gold Bars, coins) with explicit confirm; unlink; EN/FR/DE; reduced motion.
### H-10.01 · Human: Google Cloud OAuth web client (origins `https://sashimee.github.io`, `https://devcoinposh.bas.lu`, localhost) → Worker secret `GOOGLE_CLIENT_ID`, repo variable `VITE_GOOGLE_CLIENT_ID`
### H-10.02 · Human: Apple Developer membership (same account as H-7.01, pulled forward), Services ID and Sign in with Apple key → Worker secrets `APPLE_SERVICES_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, repo variable `VITE_APPLE_SERVICES_ID`

## M11: Collecting (prizes first)

### T-11.01 · Feature-module seams — **agent:** lead-architect — **deps:** T-92.07, T-92.08, T-10.02, T-10.03 — **owns:** `packages/shared/src/api/endpoints.ts`, `packages/shared/src/api/endpoints.test.ts`, `packages/shared/src/api/index.ts`, `apps/server/src/index.ts`, `apps/server/src/features/registry.ts`, `apps/server/src/features/harness.ts`, `apps/server/src/do/PlayerDO.ts`, `apps/server/src/do/features.ts`, `apps/server/src/do/ledger.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/net/mock/server.ts`, `apps/web/src/game/features.ts`, `apps/web/src/i18n/index.ts`, `apps/web/src/i18n/core.ts` — **accept:** the endpoints map spreads per-theme maps from `packages/shared/src/api/<theme>/endpoints.ts`; a server feature module `{ routes, doHandlers, tables }` with per-feature versioned DO tables, so features never edit PlayerDO.ts or schema.ts; ledger entry kinds registered per feature with the conservation check; `createFeatureHarness([feature])` runs a feature against a real PlayerDO in miniflare; a mock-server and a game feature hook; i18n loads `locales/<lang>/<ns>.json` namespaces; a sample feature proves each seam; existing tests unchanged; `pnpm check` green.
### T-11.02 · Sim prop seam — **agent:** physics-engineer — **deps:** T-92.02 — **owns:** `packages/sim/src/props/**`, `packages/sim/src/sim.ts`, `packages/sim/src/sim.test.ts`, `packages/sim/src/index.ts` — **accept:** props (id, kind, shape, mass, parameters) passed in sim config and stepped in a fixed order; events `prop.fall {propId, tick, edge}`, `prop.enter {coinId, propId, tick}`; snapshot and restore cover props; with no props the pinned hash is unchanged; a two-prop run of 3,600 ticks twice gives one hash; Rapier-free kind registry in `packages/sim/src/props/index.ts`.
### T-11.03 · Collecting contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/collecting/**`, `packages/shared/src/api/table.ts`, `packages/shared/src/api/table.test.ts` — **accept:** prize ids and catalog types; prize entities on the table snapshot (like crates) and claim kind `prize`; `variant` (`none|foil|proof|firstStrike|misprint`) on minted coins; lounge layout; cellar bottle (server `laidAt`), sell and keep; no value field on any upload; tests.
### T-11.04 · Collecting numbers — **agent:** economy-designer — **deps:** T-11.03, T-3.07 — **owns:** `packages/economy/src/config/collecting/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/collecting/**`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/collecting/**`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** prize catalog (≥ 24 prizes, 4 families × rarities), spawn rate, variant odds and multipliers, prize and variant pity, Collection Value and its capped multiplier, cellar classes and curve, rack upgrades; 02-ECONOMY targets met in the sim; fast-check: variant and fusion conservation, cellar daily growth ≤ 20 % of a casual day, odds sum 100 %; rate envelope regenerated with variants and collection multiplier.
### T-11.05 · Sim: prize bodies — **agent:** physics-engineer — **deps:** T-11.02, T-11.03 — **owns:** `packages/sim/src/props/prizes/**` — **accept:** watch, perfume, cufflinks, car keys as compound colliders, heavier than coins, can teeter and fall; deterministic; 4 prizes + 250 coins inside the bench budget.
### T-11.06 · Server: prizes and coin variants — **agent:** backend-engineer — **deps:** T-11.04 — **owns:** `apps/server/src/features/prizes/**`, `apps/server/src/features/variants/**`, `apps/web/src/net/features/prizes/**`, `apps/web/src/net/features/variants/**` — **accept:** prizes spawn by the economy rate with fair RNG and pity; a claim adds the prize once (double, unknown and off-table claims rejected); a gutter fall returns it to the spawn queue; variants rolled at mint and stored with the coin; value multiplier from config; a forged client variant is ignored; Demo mock does the same.
### T-11.07 · Prize and variant looks — **agent:** render-artist — **deps:** T-11.03 — **owns:** `apps/web/src/scene/prizes/**`, `apps/web/src/scene/coins/variants/**` — **accept:** procedural PBR prizes and variant materials per 03-ART; variants readable at table distance with colorblind glyphs; 60 fps on the mid profile.
### T-11.08 · Prize flow and juice — **agent:** gameplay-engineer — **deps:** T-11.05, T-11.06, T-11.07 — **owns:** `apps/web/src/game/prizes/**`, `apps/web/src/vfx/prizes/**` — **accept:** prizes ride the table, fall → server claim → reveal; variant glint on mint and label on bank; juice ≥ 4 per 03-ART; FTUE prize inside 10 min.
### T-11.09 · Collection book UI — **agent:** ui-engineer — **deps:** T-11.06, T-3.03 — **owns:** `apps/web/src/ui/collection/**`, `apps/web/src/i18n/locales/*/collecting.json` — **accept:** prize families, polish levels, variant grid per tier, Collection Value and multiplier, odds link; opens as an Album tab.
### T-11.10 · Trophy lounge scene — **agent:** render-artist — **deps:** T-11.07, T-3.03 — **owns:** `apps/web/src/scene/lounge/**` — **accept:** lazy-loaded 3D room showing owned prizes, Heirlooms and trophies; drag to rotate an item; offscreen render of a share picture; 60 fps on the mid profile; initial bundle unchanged.
### T-11.11 · Lounge UI and share — **agent:** ui-engineer — **deps:** T-11.10 — **owns:** `apps/web/src/ui/lounge/**`, `apps/web/src/i18n/locales/*/lounge.json` — **accept:** enter and leave the lounge, item inspect card, share via Web Share API with download fallback.
### T-11.12 · Server: wine cellar — **agent:** backend-engineer — **deps:** T-11.04 — **owns:** `apps/server/src/features/cellar/**`, `apps/web/src/net/features/cellar/**` — **accept:** bottles from crates (crate tables updated through config), racks and slot upgrades; value from server `laidAt` and server now; sell credits the curve value; tests with a fake server clock and a forged client time.
### T-11.13 · Wine cellar UI — **agent:** ui-engineer — **deps:** T-11.12 — **owns:** `apps/web/src/ui/cellar/**`, `apps/web/src/i18n/locales/*/cellar.json` — **accept:** racks, per-bottle age and value curve with the next peak, sell and keep, dust by age.
### T-11.14 · Collecting audio — **agent:** audio-engineer — **deps:** T-11.03 — **owns:** `apps/web/src/audio/collecting/**` — **accept:** prize family impacts, variant shimmer, cellar ambience, per 03-ART.
### T-11.15 · Collecting wiring — **agent:** lead-architect — **deps:** T-11.08, T-11.09, T-11.11, T-11.13, T-11.14 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `packages/sim/src/props/index.ts`, `apps/web/src/main.ts` — **accept:** features registered; full loop playable in Demo Mode and live; juice audit ≥ 4 per new interaction; `pnpm check` green.
### T-11.16 · E2E: collecting — **agent:** qa-perf — **deps:** T-11.15, T-1.17 — **owns:** `apps/web/e2e/collecting.spec.ts` — **accept:** Demo Mode: scripted prize falls and appears in the book and lounge; a seeded variant mint shows its label; a cellar bottle's value rises with the mock clock; frame time inside the T-1.17 budget.

## M12: Standing (ranks first)

### T-12.01 · Standing contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/standing/**` — **accept:** Repute, rank and title, perks, achievements (ids, progress, showcase), mastery tracks, staff (hire, level, wage, leave); tests.
### T-12.02 · Standing numbers — **agent:** economy-designer — **deps:** T-12.01, T-3.07 — **owns:** `packages/economy/src/config/standing/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/standing/**`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/standing/**`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** Repute sources, rank curve, perks, ≥ 200 achievement definitions, mastery curves, staff costs, wages and boosts per 02-ECONOMY; sim hits Baron I ≈ 1.5 h, Duke I ≈ 13 h, Monarch ≈ 100 h; fast-check: global boost cap holds, offline + staff stays below active rate; envelope regenerated.
### T-12.03 · Server: Repute, ranks, titles, perks — **agent:** backend-engineer — **deps:** T-12.02 — **owns:** `apps/server/src/features/ranks/**`, `apps/web/src/net/features/ranks/**` — **accept:** Repute only from server-accepted claims, fusions, crate opens, quests and achievements; rank-ups apply perks server-side; perks visible to the envelope; tests for forged events.
### T-12.04 · Server: achievements — **agent:** backend-engineer — **deps:** T-12.02 — **owns:** `apps/server/src/features/achievements/**`, `apps/web/src/net/features/achievements/**` — **accept:** counters from server events, unlock once, claim rewards, showcase of up to 6; retroactive unlock from existing ledger on first run.
### T-12.05 · Server: mastery — **agent:** backend-engineer — **deps:** T-12.02, T-3.01 — **owns:** `apps/server/src/features/mastery/**`, `apps/web/src/net/features/mastery/**` — **accept:** per-tier and per-charm counters from accepted claims and charm activations; level bonuses applied server-side within caps.
### T-12.06 · Server: staff — **agent:** backend-engineer — **deps:** T-12.02, T-11.12 — **owns:** `apps/server/src/features/staff/**`, `apps/web/src/net/features/staff/**` — **accept:** hire, train, daily wage, leave when unpaid; Butler opens due safes and banks the vault, Sommelier speeds cellar ageing, Valet's free nudge allowance; idle boost capped; offline settlement test shows offline < active.
### T-12.07 · Staff on the table — **agent:** gameplay-engineer — **deps:** T-12.06 — **owns:** `apps/web/src/game/staff/**` — **accept:** Valet sends a free nudge when coins stall at the lip (server-capped, no Decorum); Sommelier widens the Perfect Pour window by config; staff barks on the event bus.
### T-12.08 · Staff figures — **agent:** render-artist — **deps:** T-12.01 — **owns:** `apps/web/src/scene/staff/**` — **accept:** Butler, Valet, Sommelier as small procedural figures with idle and action loops; 60 fps.
### T-12.09 · Ranks and achievements UI — **agent:** ui-engineer — **deps:** T-12.03, T-12.04 — **owns:** `apps/web/src/ui/ranks/**`, `apps/web/src/ui/achievements/**`, `apps/web/src/i18n/locales/*/standing.json` — **accept:** crest and title in the HUD, rank-up ceremony, rank road with perks, achievement list with filters and a showcase.
### T-12.10 · Mastery and staff UI — **agent:** ui-engineer — **deps:** T-12.05, T-12.06 — **owns:** `apps/web/src/ui/mastery/**`, `apps/web/src/ui/staff/**`, `apps/web/src/i18n/locales/*/staff.json` — **accept:** mastery tracks per tier and charm; staff hire, train and wage sheet with the idle boost shown.
### T-12.11 · Standing juice and audio — **agent:** vfx-juice — **deps:** T-12.01 — **owns:** `apps/web/src/vfx/standing/**` — **accept:** wax-seal rank-up, achievement toast flourish, per 03-ART.
### T-12.12 · Standing sounds — **agent:** audio-engineer — **deps:** T-12.01 — **owns:** `apps/web/src/audio/standing/**` — **accept:** rank-up fanfare in the venue key, achievement chime, staff footsteps.
### T-12.13 · Standing wiring — **agent:** lead-architect — **deps:** T-12.07, T-12.08, T-12.09, T-12.10, T-12.11, T-12.12, T-11.15 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts` — **accept:** registered; playable in Demo Mode and live; `pnpm check` green.
### T-12.14 · E2E: standing — **agent:** qa-perf — **deps:** T-12.13 — **owns:** `apps/web/e2e/standing.spec.ts` — **accept:** Demo Mode: earn Repute to Commoner II, unlock an achievement, hire the Butler and see it open a due safe.

## M13: Daily habit and live events (login calendar first)

### T-13.01 · Live events contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/liveEvents/**` — **accept:** calendars, daily puzzle (seed, goal, result), boss (health, contribution), holiday and tie-in themes, player time zone; tests.
### T-13.02 · Live events numbers — **agent:** economy-designer — **deps:** T-13.01, T-3.07 — **owns:** `packages/economy/src/config/liveEvents/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/liveEvents/**`, `docs/plan/balance-reports/liveEvents/**` — **accept:** calendar tables, puzzle rewards, boss HP model and reward tiers, holiday collections with pity; 7-day loop ≤ 1 casual day of earnings.
### T-13.03 · Server: login calendars — **agent:** backend-engineer — **deps:** T-13.02 — **owns:** `apps/server/src/features/calendar/**`, `apps/web/src/net/features/calendar/**` — **accept:** 7- and 28-day calendars advance one step per claimed server day and never reset; the day boundary uses the player's time zone, changeable once per 30 days; one claim per day (test with a forged client clock); random slots use fair RNG with pity.
### T-13.04 · Calendar UI — **agent:** ui-engineer — **deps:** T-13.03 — **owns:** `apps/web/src/ui/calendar/**`, `apps/web/src/i18n/locales/*/calendar.json` — **accept:** opens once a day after the offline return screen; ribbon-untie reveal; both tracks visible.
### T-13.05 · Sim: daily puzzle goals — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/puzzle/**` — **accept:** seeded opening layouts and goal evaluators (for example "3 Platinum over the edge in 40 drops") computed inside the sim; the same inputs give the same result and hash.
### T-13.06 · Server: daily puzzle and board — **agent:** backend-engineer — **deps:** T-13.02, T-13.05, T-4.01, T-4.03 — **owns:** `apps/server/src/features/puzzle/**`, `apps/web/src/net/features/puzzle/**` — **accept:** one seed and goal per UTC day for everyone; results submitted as input logs; ranked results replayed by the verifier before they post; fixed rewards.
### T-13.07 · Daily puzzle UI — **agent:** ui-engineer — **deps:** T-13.06 — **owns:** `apps/web/src/ui/puzzle/**`, `apps/web/src/i18n/locales/*/puzzle.json` — **accept:** goal card, attempt counter, board with friends filter.
### T-13.08 · Server: boss events — **agent:** backend-engineer — **deps:** T-13.02, T-4.02 — **owns:** `apps/server/src/features/boss/**`, `apps/web/src/net/features/boss/**` — **accept:** a BossDO per week with a shared health bar; damage = server-credited banked value; contribution tiers and defeat bonus; the boss never debits a wallet (test).
### T-13.09 · Boss presence — **agent:** render-artist — **deps:** T-13.01 — **owns:** `apps/web/src/scene/boss/**` — **accept:** the Tax Inspector and a rival tycoon as figures behind the back wall, reacting to big cascades.
### T-13.10 · Server: holiday events and seasonal tie-ins — **agent:** backend-engineer — **deps:** T-13.02, T-4.02 — **owns:** `apps/server/src/features/holidays/**`, `apps/web/src/net/features/holidays/**` — **accept:** a remote-config calendar of themed windows (holidays and luxury-calendar moments such as grand prix week, fashion week, regatta season) with limited collections and themed coins; switched without a deploy; a content check rejects brand names and trademarks from a deny list.
### T-13.11 · Holiday themes: first two — **agent:** render-artist — **deps:** T-13.10 — **owns:** `apps/web/src/scene/holidays/**` — **accept:** a winter gala and a grand prix week theme: palette overrides, props and themed coin faces.
### T-13.12 · Live events UI — **agent:** ui-engineer — **deps:** T-13.08, T-13.10 — **owns:** `apps/web/src/ui/liveEvents/**`, `apps/web/src/i18n/locales/*/liveEvents.json` — **accept:** boss health bar and contribution, holiday collection page, event banners.
### T-13.13 · Live events juice and sound — **agent:** vfx-juice — **deps:** T-13.01 — **owns:** `apps/web/src/vfx/liveEvents/**` — **accept:** boss hit sparks, defeat celebration, calendar reveal.
### T-13.14 · Live events audio — **agent:** audio-engineer — **deps:** T-13.01 — **owns:** `apps/web/src/audio/liveEvents/**` — **accept:** boss sting and hit sounds, holiday music variations.
### T-13.15 · Live events wiring — **agent:** lead-architect — **deps:** T-13.04, T-13.07, T-13.09, T-13.11, T-13.12, T-13.13, T-13.14, T-12.13 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/server/wrangler.jsonc` — **accept:** registered, BossDO bound; Demo Mode and live; `pnpm check` green.
### T-13.16 · E2E: live events — **agent:** qa-perf — **deps:** T-13.15 — **owns:** `apps/web/e2e/liveEvents.spec.ts` — **accept:** Demo Mode: claim day 1 then the mock clock's next day, play the daily puzzle to its goal, see boss damage rise.

## M14: World (Concierge first)

### T-14.01 · World contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/world/**` — **accept:** guest letters and arcs, pets and breeds, venue conditions (local time, weather); tests.
### T-14.02 · Concierge brain — **agent:** gameplay-engineer — **deps:** T-11.01 — **owns:** `apps/web/src/game/concierge/**` — **accept:** a rule table maps bus events and player state to lines and tips (for example "feed the tower", the empty-Vault hint) with priorities and cooldowns; never blocks input; mute toggle; unit tests for rules.
### T-14.03 · Concierge character and lines — **agent:** ui-engineer — **deps:** T-14.02 — **owns:** `apps/web/src/ui/concierge/**`, `apps/web/src/i18n/locales/*/concierge.json` — **accept:** portrait with expressions, speech card, a personality guide in the folder, ≥ 120 lines in EN/FR/DE.
### T-14.04 · Concierge voice — **agent:** audio-engineer — **deps:** T-14.02 — **owns:** `apps/web/src/audio/concierge/**` — **accept:** wordless barks per expression, ducked under stingers.
### T-14.05 · World numbers — **agent:** economy-designer — **deps:** T-14.01, T-3.07 — **owns:** `packages/economy/src/config/world/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** letter rewards, pet fetch rate per level, breed odds and pity; envelope includes fetch.
### T-14.06 · Server: guest stories and pets — **agent:** backend-engineer — **deps:** T-14.05 — **owns:** `apps/server/src/features/guests/**`, `apps/server/src/features/pets/**`, `apps/web/src/net/features/guests/**`, `apps/web/src/net/features/pets/**` — **accept:** letters unlock on server conditions; breeds from crates with fair RNG and pity; pet level server-side.
### T-14.07 · Guest letters UI — **agent:** ui-engineer — **deps:** T-14.06 — **owns:** `apps/web/src/ui/letters/**`, `apps/web/src/i18n/locales/*/letters.json` — **accept:** ≥ 3 guest arcs of 5 letters each; wax-sealed letter reveal.
### T-14.08 · Sim: pet fetch — **agent:** physics-engineer — **deps:** T-11.02, T-14.01 — **owns:** `packages/sim/src/props/pet/**` — **accept:** on a seeded schedule the pet returns one gutter coin to the table by its own ID (no minting); deterministic.
### T-14.09 · Pets — **agent:** render-artist — **deps:** T-14.01 — **owns:** `apps/web/src/scene/pets/**` — **accept:** poodle, cat and parrot with breed variations, idle, react and fetch animations.
### T-14.10 · Server: venue conditions — **agent:** backend-engineer — **deps:** T-14.01 — **owns:** `apps/server/src/features/conditions/**`, `apps/web/src/net/features/conditions/**` — **accept:** per-venue local time and weather from a server-side feed cached by cron (no player location sent); clear-sky fallback; no economy effect.
### T-14.11 · Day/night and weather rendering — **agent:** render-artist — **deps:** T-14.10 — **owns:** `apps/web/src/scene/env/sky/**`, `apps/web/src/scene/env/weather/**` — **accept:** sky and key light follow local time; rain, mist and snow layers; quality-tier aware.
### T-14.12 · World wiring — **agent:** lead-architect — **deps:** T-14.03, T-14.04, T-14.07, T-14.08, T-14.09, T-14.11, T-13.15 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `packages/sim/src/props/index.ts`, `apps/web/src/main.ts` — **accept:** registered; Demo Mode and live; `pnpm check` green.
### T-14.13 · E2E: world — **agent:** qa-perf — **deps:** T-14.12 — **owns:** `apps/web/e2e/world.spec.ts` — **accept:** the Concierge reacts to an OBSCENE and to an empty Vault; a letter unlocks; the pet fetches a coin on its seeded tick.

## M15: Retention

### T-15.01 · Retention contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/retention/**` — **accept:** goals board, comeback gift, catch-up and rested boosts, weekly chest; tests.
### T-15.02 · Retention numbers — **agent:** economy-designer — **deps:** T-15.01, T-12.02 — **owns:** `packages/economy/src/config/retention/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/retention/**`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** values per 02-ECONOMY; fast-check: returning after N days never beats playing those days; envelope includes rested.
### T-15.03 · Server: comeback, catch-up, rested — **agent:** backend-engineer — **deps:** T-15.02 — **owns:** `apps/server/src/features/comeback/**`, `apps/web/src/net/features/comeback/**` — **accept:** absence measured on the server clock; gift once per absence; boosts timed on active play; tests with a forged client clock.
### T-15.04 · Server: weekly chest and goals — **agent:** backend-engineer — **deps:** T-15.02, T-12.04 — **owns:** `apps/server/src/features/weeklyChest/**`, `apps/server/src/features/goals/**`, `apps/web/src/net/features/weeklyChest/**`, `apps/web/src/net/features/goals/**` — **accept:** chest fills from Repute and opens Sunday in the player's time zone with odds and pity; goals board picks short, medium and long goals from quests, achievements, ranks and mastery.
### T-15.05 · Retention UI — **agent:** ui-engineer — **deps:** T-15.03, T-15.04 — **owns:** `apps/web/src/ui/retention/**`, `apps/web/src/i18n/locales/*/retention.json` — **accept:** an always-visible goals board that fits the portrait layout without covering the coin floor; welcome-back sheet; rested timer; weekly chest card.
### T-15.06 · Retention wiring and e2e — **agent:** lead-architect — **deps:** T-15.05, T-14.12 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/web/e2e/retention.spec.ts` — **accept:** registered; Demo Mode: advance the mock clock 4 days, get the comeback gift and the rested boost; `pnpm check` green.

## M16: Table mechanics

### T-16.01 · Table mechanics contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/props/**` — **accept:** venue layout ids, claim kinds `target` and `jackpotBall`, reward kinds (shower, crate, multiplier window); tests.
### T-16.02 · Table mechanics numbers — **agent:** economy-designer — **deps:** T-16.01, T-3.07 — **owns:** `packages/economy/src/config/props/**`, `packages/economy/src/config/index.ts`, `docs/plan/balance-reports/props/**` — **accept:** target reward odds and pity, shower size, multiplier window, jackpot ball spawn and value.
### T-16.03 · Sim: bonus targets — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/props/targets/**` — **accept:** holes and chutes in the back wall emit `prop.enter`; the coin leaves the table; deterministic.
### T-16.04 · Sim: peg field — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/props/pegs/**` — **accept:** a parametric brass peg field above the table; coins bounce through; deterministic.
### T-16.05 · Sim: moving parts and venue layouts — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/props/moving/**`, `packages/sim/src/props/layouts/**` — **accept:** turntable, conveyor and sliding gate as kinematic bodies on the tick clock; one layout per venue; deterministic.
### T-16.06 · Sim: jackpot ball — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/props/jackpot/**` — **accept:** a heavy ball that shoves coins and falls like a prize; deterministic.
### T-16.07 · Server: targets and jackpot ball — **agent:** backend-engineer — **deps:** T-16.02 — **owns:** `apps/server/src/features/targets/**`, `apps/server/src/features/jackpot/**`, `apps/web/src/net/features/targets/**`, `apps/web/src/net/features/jackpot/**` — **accept:** a target claim names a known on-table coin and a target in the venue layout, is rate-limited, credits the coin, and rolls the reward with fair RNG; showers are minted through the drop buffer; multiplier windows timed on the server; jackpot ball spawned and valued on the server; forged reward ignored.
### T-16.08 · Mechanics models — **agent:** render-artist — **deps:** T-16.01 — **owns:** `apps/web/src/scene/props/**` — **accept:** pegs, targets, turntable, conveyor, gates, jackpot ball per 03-ART; 60 fps.
### T-16.09 · Mechanics juice — **agent:** vfx-juice — **deps:** T-16.01 — **owns:** `apps/web/src/vfx/props/**` — **accept:** target flash, shower, multiplier ring, jackpot slow-mo and confetti.
### T-16.10 · Mechanics audio — **agent:** audio-engineer — **deps:** T-16.01 — **owns:** `apps/web/src/audio/props/**` — **accept:** peg pings on the pentatonic ladder, target chimes, conveyor hum, jackpot rumble.
### T-16.11 · Rate envelope for mechanics — **agent:** economy-designer — **deps:** T-16.02, T-16.03, T-16.04, T-16.05, T-16.06 — **owns:** `packages/economy/sim/props/**`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** envelope regenerated per venue layout at the 99.9th percentile with every mechanic on.
### T-16.12 · Verifier replays mechanics — **agent:** physics-engineer — **deps:** T-4.03, T-16.03, T-16.04, T-16.05, T-16.06 — **owns:** `apps/server/src/audit/**`, `tools/verifier/**` — **accept:** input-log header carries the layout; the verifier replays props and matches hashes.
### T-16.13 · Table mechanics wiring — **agent:** lead-architect — **deps:** T-16.07, T-16.08, T-16.09, T-16.10, T-16.11, T-15.06 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `packages/sim/src/props/index.ts`, `apps/web/src/main.ts` — **accept:** Riviera gets its layout; Demo Mode and live; `pnpm check` green.
### T-16.14 · E2E: table mechanics — **agent:** qa-perf — **deps:** T-16.13 — **owns:** `apps/web/e2e/props.spec.ts` — **accept:** a seeded drop enters a target and a reward appears; a jackpot ball falls and pays; frame time inside budget.

## M17: Game feel

### T-17.01 · Director camera — **agent:** render-artist — **deps:** T-16.06, T-1.02 — **owns:** `apps/web/src/scene/director/**` — **accept:** cuts to the jackpot ball, a tower topple and OBSCENE with a cooldown, returns smoothly; reduced motion: no cuts, a highlight ring instead; no "edge suspense" slow-mo; setting to turn it off.
### T-17.02 · Adaptive music — **agent:** audio-engineer — **deps:** T-1.13 — **owns:** `apps/web/src/audio/music/adaptive/**` — **accept:** tempo follows the drop rate within ±8 BPM without artefacts, stems by Cascade tier, jackpot sting with ducking; tests on the scheduler.
### T-17.03 · Haptic pattern library — **agent:** vfx-juice — **deps:** T-7.02 — **owns:** `apps/web/src/vfx/haptics/**` — **accept:** a pattern per coin tier, prize family and event, on Capacitor Haptics and web vibrate; haptics-off honoured; rate-limited.
### T-17.04 · Game feel wiring — **agent:** lead-architect — **deps:** T-17.01, T-17.02, T-17.03 — **owns:** `apps/web/src/main.ts`, `apps/web/src/game/features.ts` — **accept:** wired to the bus; juice audit; `pnpm check` green.

## M18: Comfort and quality of life

### T-18.01 · Comfort contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/comfort/**` — **accept:** stats (lifetime totals, biggest cascade, best day, 30-day series), auto-drop unlock; tests.
### T-18.02 · Server: stats — **agent:** backend-engineer — **deps:** T-18.01 — **owns:** `apps/server/src/features/stats/**`, `apps/web/src/net/features/stats/**` — **accept:** aggregates from the ledger and accepted claims only; best day by server day.
### T-18.03 · Stats UI — **agent:** ui-engineer — **deps:** T-18.02 — **owns:** `apps/web/src/ui/stats/**`, `apps/web/src/i18n/locales/*/stats.json` — **accept:** totals, records and an earnings chart with compact numbers.
### T-18.04 · Auto-drop — **agent:** gameplay-engineer — **deps:** T-18.01, T-12.03 — **owns:** `apps/web/src/game/autodrop/**` — **accept:** unlocked by the server (Baron I perk); drops at most at the server drop cap and cost coins like taps; stops after 5 min without a touch and in puzzle, tournament or Soirée runs.
### T-18.05 · Sim: replay recorder — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/replay/**` — **accept:** a ring of inputs plus a snapshot every 300 ticks; rebuilding the last 10 s reproduces the live hash.
### T-18.06 · Big-win replays — **agent:** gameplay-engineer — **deps:** T-18.05 — **owns:** `apps/web/src/game/replay/**` — **accept:** OBSCENE and jackpot offer a replay played in a second worker sim at 0.25×; skippable.
### T-18.07 · Cinematic replay camera — **agent:** render-artist — **deps:** T-18.06 — **owns:** `apps/web/src/scene/replay/**` — **accept:** orbit and dolly shots, DoF; reduced motion: a single static angle.
### T-18.08 · Comfort wiring and e2e — **agent:** lead-architect — **deps:** T-18.03, T-18.04, T-18.07, T-16.13 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/web/e2e/comfort.spec.ts` — **accept:** registered; Demo Mode: stats update, auto-drop stops idle, a replay plays; `pnpm check` green.

## M19: Accessibility and ways to play

### T-19.01 · Parental settings — **agent:** ui-engineer — **deps:** T-6.02, T-10.04 — **owns:** `apps/web/src/ui/parental/**`, `apps/web/src/i18n/locales/*/parental.json` — **accept:** PIN-gated sheet: crates and reveals off, daily session limit with a break reminder, social hidden; recovery via the linked account.
### T-19.02 · Server: parental policy — **agent:** backend-engineer — **deps:** T-19.01 — **owns:** `apps/server/src/features/parental/**`, `apps/web/src/net/features/parental/**` — **accept:** settings stored server-side with a hashed PIN; reveals off replaces random rolls with fixed bundles of the same expected value (property test); session limit enforced on the server clock; social endpoints refuse while hidden.
### T-19.03 · Left-hand and Zen modes — **agent:** ui-engineer — **deps:** T-6.02 — **owns:** `apps/web/src/ui/modes/**`, `apps/web/src/i18n/locales/*/modes.json` — **accept:** a mirrored HUD with every anchor flipped; Zen hides timers, meters and countdowns and turns the Decorum freeze into a quiet nudge cap; both persist per account.
### T-19.04 · Landscape tablet layout — **agent:** ui-engineer — **deps:** T-19.03 — **owns:** `apps/web/src/ui/layout/**` — **accept:** at ≥ 768 px landscape, meters and drawers sit beside the table; camera framing per the P-170 targets; screenshot set.
### T-19.05 · Keyboard and mouse controls — **agent:** gameplay-engineer — **deps:** T-1.10 — **owns:** `apps/web/src/game/input/keyboard/**` — **accept:** mouse aim and click drop, hold Space to pour, N to nudge, number keys for drawers; remappable; focus-safe with sheets.
### T-19.06 · Accessibility wiring and e2e — **agent:** lead-architect — **deps:** T-19.02, T-19.04, T-19.05, T-18.08 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/main.ts`, `apps/web/e2e/accessibility.spec.ts` — **accept:** Demo Mode: reveals off gives a fixed bundle, left-hand HUD mirrors, keyboard plays a round; `pnpm check` green.

## M20: Social

### T-20.01 · Community contracts — **agent:** lead-architect — **deps:** T-11.01, T-4.01 — **owns:** `packages/shared/src/api/community/**` — **accept:** gifts, clubs (generated names, emote ids, weekly goal), visits (read-only table and lounge, tip, like), share metadata; no free-text field anywhere; tests.
### T-20.02 · Community numbers — **agent:** economy-designer — **deps:** T-20.01, T-3.07 — **owns:** `packages/economy/src/config/community/**`, `packages/economy/src/config/index.ts` — **accept:** gift, tip and like values and caps, club goals and crates per 02-ECONOMY.
### T-20.03 · Server: gifts — **agent:** backend-engineer — **deps:** T-20.02, T-10.02 — **owns:** `apps/server/src/features/gifts/**`, `apps/web/src/net/features/gifts/**` — **accept:** house-minted gifts to share-code friends, daily send and receive caps; nothing debits the sender (test).
### T-20.04 · Server: clubs — **agent:** backend-engineer — **deps:** T-20.02, T-10.02 — **owns:** `apps/server/src/features/clubs/**`, `apps/web/src/net/features/clubs/**` — **accept:** a ClubDO per club, up to 30 members, generated names, a fixed emote set, weekly goal and crate; no free text.
### T-20.05 · Server: visits — **agent:** backend-engineer — **deps:** T-20.02, T-92.04 — **owns:** `apps/server/src/features/visits/**`, `apps/web/src/net/features/visits/**` — **accept:** a friend's table poses and lounge served read-only; tips house-minted and capped; likes capped.
### T-20.06 · Visit view — **agent:** gameplay-engineer — **deps:** T-20.05, T-92.07 — **owns:** `apps/web/src/game/visit/**` — **accept:** restores a friend's table through the bridge with input off; leave a tip or like; back to your table without a reload.
### T-20.07 · Photo mode and auto-clips — **agent:** gameplay-engineer — **deps:** T-18.06 — **owns:** `apps/web/src/game/capture/**` — **accept:** photo mode (free camera, HUD hidden, three filters); auto-clip of OBSCENE and jackpots from the replay via MediaRecorder; shared through Web Share API or downloaded, never uploaded to our server.
### T-20.08 · Social UI — **agent:** ui-engineer — **deps:** T-20.03, T-20.04, T-20.06 — **owns:** `apps/web/src/ui/community/**`, `apps/web/src/i18n/locales/*/community.json` — **accept:** gift inbox, club page with goal and emotes, friend list with visit; hidden when parental settings say so.
### T-20.09 · Social wiring and e2e — **agent:** lead-architect — **deps:** T-20.07, T-20.08, T-19.06 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/server/wrangler.jsonc`, `apps/web/e2e/community.spec.ts` — **accept:** ClubDO bound; Demo Mode: two mock players gift, visit and join a club; `pnpm check` green.

## M21: Competitive

### T-21.01 · Competitive contracts — **agent:** lead-architect — **deps:** T-11.01, T-4.01 — **owns:** `packages/shared/src/api/competitive/**` — **accept:** leagues (tier, group, standings), tournaments (seed, drop count, attempts), ghost runs, spectate stream frames; tests.
### T-21.02 · Competitive numbers — **agent:** economy-designer — **deps:** T-21.01, T-3.07 — **owns:** `packages/economy/src/config/competitive/**`, `packages/economy/src/config/index.ts` — **accept:** league brackets, promotion and relegation, fixed rewards; tournament rewards by percentile.
### T-21.03 · Server: weekly leagues — **agent:** backend-engineer — **deps:** T-21.02 — **owns:** `apps/server/src/features/leagues/**`, `apps/web/src/net/features/leagues/**` — **accept:** groups of 30 by venue and Gold Bars bracket; score = server-credited Bullion; weekly cron promotes top 5 and relegates bottom 5; shadow-pool players grouped apart.
### T-21.04 · Server: weekend tournaments — **agent:** backend-engineer — **deps:** T-21.02, T-4.03 — **owns:** `apps/server/src/features/tournaments/**`, `apps/web/src/net/features/tournaments/**` — **accept:** fixed seed and 300 drops; 3 attempts; results are input logs replayed by the verifier before they rank (a forged log is rejected).
### T-21.05 · Ghost races — **agent:** gameplay-engineer — **deps:** T-21.04, T-18.05 — **owns:** `apps/web/src/game/ghost/**` — **accept:** a friend's verified run replays in a second worker sim as translucent coins beside your score line; same seed; deterministic.
### T-21.06 · Server: spectate — **agent:** backend-engineer — **deps:** T-21.04 — **owns:** `apps/server/src/features/spectate/**`, `apps/web/src/net/features/spectate/**` — **accept:** a SpectateDO relays a top table's input log and periodic snapshots over WebSocket; viewers rebuild by replay; replays of verified runs on demand; opt-out for players.
### T-21.07 · Competitive UI — **agent:** ui-engineer — **deps:** T-21.03, T-21.04, T-21.06 — **owns:** `apps/web/src/ui/competitive/**`, `apps/web/src/i18n/locales/*/competitive.json` — **accept:** league standings with promotion lines, tournament lobby, ghost picker, spectate list.
### T-21.08 · Competitive wiring and e2e — **agent:** lead-architect — **deps:** T-21.05, T-21.07, T-20.09 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/server/wrangler.jsonc`, `apps/web/e2e/competitive.spec.ts` — **accept:** Demo Mode: a tournament attempt ranks, a ghost race runs; `pnpm check` green.

## M22: Economy depth

### T-22.01 · Economy depth contracts — **agent:** lead-architect — **deps:** T-11.03 — **owns:** `packages/shared/src/api/workshop/**` — **accept:** recipes, smelting, gala donations and tiers, trade offers and escrow; tests.
### T-22.02 · Economy depth numbers — **agent:** economy-designer — **deps:** T-22.01, T-11.04 — **owns:** `packages/economy/src/config/workshop/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/workshop/**`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** recipes, smelting rate and cap, gala tiers and buffs, trade value band per 02-ECONOMY; fast-check: no recipe or smelt creates value beyond its defined output; late-game coin supply curve flattens in the sim.
### T-22.03 · Server: workshop and smelting — **agent:** backend-engineer — **deps:** T-22.02 — **owns:** `apps/server/src/features/workshop/**`, `apps/web/src/net/features/workshop/**` — **accept:** recipes consume inputs atomically; random outputs use fair RNG with odds; smelting rate and weekly cap enforced.
### T-22.04 · Server: charity gala — **agent:** backend-engineer — **deps:** T-22.02 — **owns:** `apps/server/src/features/gala/**`, `apps/web/src/net/features/gala/**` — **accept:** weekly donations, cumulative tiers, ribbons and buffs inside the global cap.
### T-22.05 · Server: player trading — **agent:** backend-engineer — **deps:** T-22.02, T-20.03 — **owns:** `apps/server/src/features/trading/**`, `apps/web/src/net/features/trading/**` — **accept:** every anti-abuse rule in 02-ECONOMY enforced with one test each (friend age, linked accounts, account age, rank, daily and weekly caps, value band, trade lock, untradeable items, escrow, graph flag); no currency can move.
### T-22.06 · Workshop, gala and trading UI — **agent:** ui-engineer — **deps:** T-22.03, T-22.04, T-22.05 — **owns:** `apps/web/src/ui/workshop/**`, `apps/web/src/i18n/locales/*/workshop.json` — **accept:** recipe bench with previews, smelter, gala page, trade offer and confirm sheets showing both items.
### T-22.07 · Economy depth wiring and e2e — **agent:** lead-architect — **deps:** T-22.06, T-21.08 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/main.ts`, `apps/web/e2e/workshop.spec.ts` — **accept:** Demo Mode: craft, smelt, donate, trade between two mock players; `pnpm check` green.

## M23: Side games (no slot reels, roulette or cards)

### T-23.01 · Side games contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/sideGames/**` — **accept:** claw (target, roll, outcome), auction (lots, bids, commitment, reveal), treasure map and vault table, stocks (companies, closes, holdings); tests.
### T-23.02 · Side games numbers — **agent:** economy-designer — **deps:** T-23.01, T-3.07 — **owns:** `packages/economy/src/config/sideGames/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/sideGames/**` — **accept:** claw odds and pity, auction distributions, map piece rates, stock parameters per 02-ECONOMY; sim: 30-day stock return ≤ 0 after fees.
### T-23.03 · Sim: claw machine — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/claw/**` — **accept:** a small deterministic claw scene; given aim and the server's grip result, the run ends in that result in 100 % of seeded cases; hash test.
### T-23.04 · Server: claw, auction, treasure, stocks — **agent:** backend-engineer — **deps:** T-23.02 — **owns:** `apps/server/src/features/claw/**`, `apps/server/src/features/auction/**`, `apps/server/src/features/treasure/**`, `apps/server/src/features/stocks/**`, `apps/web/src/net/features/sideGames/**` — **accept:** claw grip rolled with fair RNG and pity; NPC ceilings committed at lot open and revealed at close, second-price; map pieces in crate tables with duplicate conversion; vault table session seeded; daily stock close by cron from a seed committed a day ahead; coins only, fees and caps enforced.
### T-23.05 · Claw cabinet and vault table — **agent:** render-artist — **deps:** T-23.01 — **owns:** `apps/web/src/scene/claw/**`, `apps/web/src/scene/venues/vault/**` — **accept:** chrome and glass claw cabinet; a hidden vault table scene.
### T-23.06 · Claw play — **agent:** gameplay-engineer — **deps:** T-23.03, T-23.04, T-23.05 — **owns:** `apps/web/src/game/claw/**` — **accept:** aim, drop, grip played from the server roll; odds visible before each try.
### T-23.07 · Side games UI — **agent:** ui-engineer — **deps:** T-23.04 — **owns:** `apps/web/src/ui/sideGames/**`, `apps/web/src/i18n/locales/*/sideGames.json` — **accept:** auction hall with commitment hash and reveal, treasure map, portfolio with price charts and the published seed hash.
### T-23.08 · Side games wiring and e2e — **agent:** lead-architect — **deps:** T-23.06, T-23.07, T-22.07 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/web/e2e/sideGames.spec.ts` — **accept:** Demo Mode: a claw try, a won auction, a stock buy and sell across a mock day; `pnpm check` green.

## M24: Player creation

### T-24.01 · Creation contracts — **agent:** lead-architect — **deps:** T-16.01 — **owns:** `packages/shared/src/api/creation/**` — **accept:** layout codes (pieces on a grid), loadout codes, puzzle definitions, polls; generated names only; tests.
### T-24.02 · Creation numbers — **agent:** economy-designer — **deps:** T-24.01, T-16.11 — **owns:** `packages/economy/src/config/creation/**`, `packages/economy/src/config/index.ts` — **accept:** piece budgets, custom-table payout factor and daily cap per 02-ECONOMY.
### T-24.03 · Sim: layout validation — **agent:** physics-engineer — **deps:** T-16.05 — **owns:** `packages/sim/src/props/editor/**` — **accept:** a Rapier-free validator for piece budgets and placements, plus a seeded sim probe that rejects traps that pin coins or spike throughput; deterministic.
### T-24.04 · Server: layouts, loadouts, puzzles, votes — **agent:** backend-engineer — **deps:** T-24.02, T-24.03 — **owns:** `apps/server/src/features/creation/**`, `apps/web/src/net/features/creation/**` — **accept:** layouts validated server-side before a code is issued; custom tables pay the capped factor with no crates, prizes or rolls and no Bullion or board credit; loadout usage stats; a puzzle is shared only after its maker's solving run passes the verifier; one vote per linked account on curated options; report and takedown by code.
### T-24.05 · Table editor — **agent:** gameplay-engineer — **deps:** T-24.04 — **owns:** `apps/web/src/game/editor/**` — **accept:** place, move and rotate pegs, targets and gates on a grid with live validation; test-play; share code.
### T-24.06 · Creation UI — **agent:** ui-engineer — **deps:** T-24.04 — **owns:** `apps/web/src/ui/creation/**`, `apps/web/src/i18n/locales/*/creation.json` — **accept:** editor tools, loadout code import and browser, puzzle maker flow, voting page.
### T-24.07 · Creation wiring and e2e — **agent:** lead-architect — **deps:** T-24.05, T-24.06, T-23.08 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/web/e2e/creation.spec.ts` — **accept:** Demo Mode: build, validate, share and load a table; an invalid trap layout is refused; `pnpm check` green.

## M25: Cosmetics (earned in play; paid versions behind the flag)

### T-25.01 · Cosmetics contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/cosmetics/**` — **accept:** cosmetic ids and slots (table skin, pusher skin, monogram, trail, sound pack, decor), equip; a `paid` field typed but refused while `flags.monetization = false`; tests.
### T-25.02 · Cosmetics numbers — **agent:** economy-designer — **deps:** T-25.01, T-12.02 — **owns:** `packages/economy/src/config/cosmetics/**`, `packages/economy/src/config/index.ts` — **accept:** every cosmetic has an in-play source (rank, achievement, calendar, event, mastery or Pearl shop).
### T-25.03 · Server: cosmetics — **agent:** backend-engineer — **deps:** T-25.02 — **owns:** `apps/server/src/features/cosmetics/**`, `apps/web/src/net/features/cosmetics/**` — **accept:** ownership and equip validated; paid SKUs refused while the flag is off (test).
### T-25.04 · Table and pusher skins, lounge decor — **agent:** render-artist — **deps:** T-25.01, T-11.10 — **owns:** `apps/web/src/scene/skins/**`, `apps/web/src/scene/decor/**` — **accept:** ≥ 4 table skins, ≥ 4 pusher skins, ≥ 12 decor items; 60 fps.
### T-25.05 · Monograms and crests — **agent:** render-artist — **deps:** T-25.01 — **owns:** `apps/web/src/scene/coins/monograms/**` — **accept:** ≥ 8 TSL coin faces replacing "CP"; one InstancedMesh per tier kept.
### T-25.06 · Drop trails — **agent:** vfx-juice — **deps:** T-25.01 — **owns:** `apps/web/src/vfx/trails/**` — **accept:** ≥ 6 trails within the particle budget.
### T-25.07 · Sound packs — **agent:** audio-engineer — **deps:** T-25.01 — **owns:** `apps/web/src/audio/packs/**` — **accept:** ≥ 3 modal sets swapping coin impacts.
### T-25.08 · Wardrobe UI — **agent:** ui-engineer — **deps:** T-25.03 — **owns:** `apps/web/src/ui/wardrobe/**`, `apps/web/src/i18n/locales/*/wardrobe.json` — **accept:** slots, previews, how-to-earn per locked item; no price shown while the flag is off.
### T-25.09 · Cosmetics wiring and e2e — **agent:** lead-architect — **deps:** T-25.04, T-25.05, T-25.06, T-25.07, T-25.08, T-24.07 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/main.ts`, `apps/web/e2e/cosmetics.spec.ts` — **accept:** Demo Mode: earn and equip one of each slot; `pnpm check` green.

## M26: Big-picture meta

### T-26.01 · Meta contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/dynasty/**` — **accept:** empire map and per-venue income, heirs and traits, Society Pages issues (template ids plus parameters, no free text); tests.
### T-26.02 · Meta numbers — **agent:** economy-designer — **deps:** T-26.01, T-3.07 — **owns:** `packages/economy/src/config/dynasty/**`, `packages/economy/src/config/index.ts`, `packages/economy/sim/dynasty/**`, `packages/economy/sim/envelopeTable.ts`, `docs/plan/balance-reports/rate-envelope.json` — **accept:** empire income and cap, heir odds and traits per 02-ECONOMY; fast-check: idle total stays below active rate; ascension pacing unchanged within 10 %.
### T-26.03 · Server: empire, dynasty, Society Pages — **agent:** backend-engineer — **deps:** T-26.02, T-3.04 — **owns:** `apps/server/src/features/empire/**`, `apps/server/src/features/dynasty/**`, `apps/server/src/features/society/**`, `apps/web/src/net/features/dynasty/**` — **accept:** per-venue idle income settled with offline earnings; heirs rolled at ascension with fair RNG and odds; a daily issue built by cron from records, events and friends' feats (opt-in), templated.
### T-26.04 · Empire map — **agent:** render-artist — **deps:** T-26.01 — **owns:** `apps/web/src/scene/empire/**` — **accept:** illustrated globe, venue pins, private-jet arc between venues; lazy chunk.
### T-26.05 · Dynasty and Society Pages UI — **agent:** ui-engineer — **deps:** T-26.03 — **owns:** `apps/web/src/ui/dynasty/**`, `apps/web/src/i18n/locales/*/dynasty.json` — **accept:** heir choice at ascension, family tree, the newspaper with templated stories in EN/FR/DE.
### T-26.06 · Meta wiring and e2e — **agent:** lead-architect — **deps:** T-26.04, T-26.05, T-25.09 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/main.ts`, `apps/web/e2e/dynasty.spec.ts` — **accept:** Demo Mode: ascend, pick an heir, fly to the next venue, read today's issue; `pnpm check` green.

## M27: Platforms

Desktop shell: **Electron**, because it ships its own Chromium, so WebGPU and
rendering match the web build and our Chromium CI on Windows, macOS and Steam Deck
(Linux). Tauri relies on the system WebView, and WebKitGTK on Linux has no
dependable WebGPU. Electron also has a maintained Steamworks binding (steamworks.js).
The cost is a larger download, which is acceptable on Steam.

### T-27.01 · Installable PWA with offline Demo play — **agent:** lead-architect — **deps:** T-1.18 — **owns:** `apps/web/public/manifest.webmanifest`, `apps/web/src/pwa/**`, `apps/web/vite.config.ts`, `docs/plan/STACK.lock.md` — **accept:** manifest and icons; a service worker precaches the shell and 3D chunk; installable (Lighthouse PWA checks pass); offline boot plays Demo Mode; live mode offline shows the provisional state; updates prompt instead of swapping mid-session.
### T-27.02 · QR session move — **agent:** backend-engineer — **deps:** T-10.02, T-10.03 — **owns:** `apps/server/src/features/transfer/**`, `apps/web/src/net/features/transfer/**`, `apps/web/src/ui/transfer/**`, `apps/web/src/i18n/locales/*/transfer.json` — **accept:** desktop shows a QR with a server-issued one-time code (2 min, single use, bound to the issuing session); the phone redeems it and registers its device key for the same player; replayed or expired codes rejected; the desktop session is told and keeps working.
### T-27.03 · Home-screen widgets — **agent:** mobile-engineer — **deps:** T-7.02 — **owns:** `apps/mobile/ios/App/Widgets/**`, `apps/mobile/android/app/src/main/java/lu/bas/coinposh/widgets/**`, `apps/mobile/src/plugins/widgets/**`, `apps/server/src/features/widget/**` — **accept:** iOS WidgetKit and Android App Widget showing Vault, offline earnings so far and the next Golden Hour; data from a read-only, scoped widget token (no write scope, revocable); refresh within OS budgets.
### T-27.04 · Desktop shell (Electron) — **agent:** mobile-engineer — **deps:** T-27.01, T-6.04 — **owns:** `apps/desktop/**`, `docs/plan/STACK.lock.md` — **accept:** Electron app loads the built web app from disk with a strict CSP and no Node in the renderer; WebGPU on Windows/macOS/Steam Deck with the WebGL2 fallback; keyboard and mouse from T-19.05; signed builds in CI (artifacts only).
### T-27.05 · Steam integration — **agent:** mobile-engineer — **deps:** T-27.04, T-12.04 — **owns:** `apps/desktop/src/steam/**`, `apps/server/src/features/steam/**` — **accept:** Steam achievements unlock only after the server confirms the in-game one; optional Steam auth ticket as a sign-in provider verified server-side; runs without Steam (no crash) when not launched from it.
### H-27.01 · Human: Steamworks partner account, app fee, App ID and depot → repo secrets `STEAM_APP_ID`, `STEAM_WEB_API_KEY`
### H-27.02 · Human: Apple and Windows code-signing certificates for the desktop builds

## M28: Content

### T-28.01 · Content contracts — **agent:** lead-architect — **deps:** T-11.01 — **owns:** `packages/shared/src/api/content/**` — **accept:** venues 6–9 ids, challenge modifiers, jukebox tracks, codex entries; tests.
### T-28.02 · Venues 6–9 and challenge numbers — **agent:** economy-designer — **deps:** T-28.01, T-3.07 — **owns:** `packages/economy/src/config/progression.ts`, `packages/economy/src/config/content/**`, `packages/economy/src/config/index.ts` — **accept:** venue thresholds and multipliers extend the curve; challenge rewards fixed per completion; pacing report.
### T-28.03 · Monaco Grand Prix — **agent:** render-artist — **deps:** T-28.01, T-16.05 — **owns:** `apps/web/src/scene/venues/monaco/**`, `packages/sim/src/venues/monaco/**` — **accept:** palette, props, pit-lane conveyor twist (deterministic, hash test), music loop.
### T-28.04 · Venetian Palazzo — **agent:** render-artist — **deps:** T-28.01, T-16.05 — **owns:** `apps/web/src/scene/venues/venice/**`, `packages/sim/src/venues/venice/**` — **accept:** canal drift twist (deterministic, hash test).
### T-28.05 · Dubai Sky Villa — **agent:** render-artist — **deps:** T-28.01, T-16.05 — **owns:** `apps/web/src/scene/venues/dubai/**`, `packages/sim/src/venues/dubai/**` — **accept:** seeded gust twist (deterministic, hash test).
### T-28.06 · Desert Oasis Train — **agent:** render-artist — **deps:** T-28.01, T-16.05 — **owns:** `apps/web/src/scene/venues/oasis/**`, `packages/sim/src/venues/oasis/**` — **accept:** rail-jolt twist (deterministic, hash test).
### T-28.07 · Sim: challenge modifiers — **agent:** physics-engineer — **deps:** T-11.02 — **owns:** `packages/sim/src/modifiers/**` — **accept:** heavy coins, low gravity, no fusion, frozen pusher, double crates as sim config; each with a hash test.
### T-28.08 · Server: challenges, jukebox, codex — **agent:** backend-engineer — **deps:** T-28.02, T-28.07 — **owns:** `apps/server/src/features/challenges/**`, `apps/server/src/features/codex/**`, `apps/web/src/net/features/content/**` — **accept:** weekly challenge rotation with fixed rewards; track and codex unlocks from server events (ranks, Heirlooms, prizes, letters).
### T-28.09 · Jukebox — **agent:** audio-engineer — **deps:** T-28.01 — **owns:** `apps/web/src/audio/jukebox/**`, `apps/web/public/audio/jukebox/**` — **accept:** ≥ 8 CC0 tracks with credits; playlist across venues.
### T-28.10 · Challenge, jukebox and codex UI — **agent:** ui-engineer — **deps:** T-28.08 — **owns:** `apps/web/src/ui/content/**`, `apps/web/src/i18n/locales/*/content.json` — **accept:** challenge picker with modifiers, jukebox player, codex with lore entries.
### T-28.11 · Content wiring and e2e — **agent:** lead-architect — **deps:** T-28.03, T-28.04, T-28.05, T-28.06, T-28.09, T-28.10, T-26.06 — **owns:** `apps/server/src/features/registry.ts`, `apps/web/src/net/features/registry.ts`, `apps/web/src/game/features.ts`, `apps/web/src/main.ts`, `apps/web/e2e/content.spec.ts` — **accept:** Demo Mode: a challenge table completes, a track unlocks, a codex entry opens; `pnpm check` green.

## Open questions for the founder (expansion)

- **Moderation.** Clubs, trading and UGC (layout, puzzle and club names) ship with
  no free text: generated names, fixed emotes, report and takedown by code. Do we
  want moderated chat or free-text names later, and who moderates (vendor or staff)?
- **Concierge name and voice.** The character needs a name and a personality brief.
- **Weather source.** Each venue's real city weather (server feed, no player
  location) is assumed. Confirm, or should it follow the player's own local weather?
- **Smelting output.** Planned as Bullion at a poor rate. Did "bars" mean Gold Bars?
- **Steam.** A Steamworks partner account and app fee (H-27.01) and code-signing
  certificates (H-27.02) are needed. Who holds the account?
- **Widgets.** They need native Swift (WidgetKit extension) and Kotlin code inside
  `apps/mobile`, outside the "same web build" Capacitor plan, plus an App Group and
  a read-only widget token. Accept the native code?
- **Account merge.** Sign-in onto a device with a different guest save offers a
  choice, never a merge. Confirm.
- **Spectate and Society Pages privacy.** Opt-out (spectate) and opt-in (friends'
  feats in the paper) are assumed.
