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
