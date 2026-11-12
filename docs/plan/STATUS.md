# Execution Status

The single source of truth for task state. Only the **integrator** step of the
wave workflow (or lead-architect) edits this file. States: `todo` · `in_progress` ·
`review` · `done` · `blocked(<reason>)`.

| Task | State | Branch / PR | Notes |
|---|---|---|---|
| T-0.01 | done | task/T-0.01 (merge 37fcbe6) | Monorepo scaffold; pnpm check green after merge |
| T-0.02 | done | task/T-0.02 (merge b54be8a) | Shared contracts v1; pnpm check green after merge |
| T-0.03 | done | task/T-0.03 (merge ff12826) | CI + Pages deploy; folds in P-1; pnpm check green after merge |
| T-0.04 | done | task/T-0.04 (merge cac1c89) | Sim core skeleton; lockfile conflict regenerated with pnpm i; pnpm check green |
| T-0.05 | done | task/T-0.05 (merge 27dc17b) | Economy skeleton; lockfile conflict regenerated with pnpm i; pnpm check green |
| H-0.01 | done | | Pages enabled 2026-11-07, source GitHub Actions, site https://sashimee.github.io/CoinPosh/ |
| H-0.02 | done | | Secrets set 2026-11-07. Account ID `fb1ada06713865e5e52fe49c5a93cd8b`; D1 database `coinposh`, ID `d68b147d-653d-40a6-bca4-f07997f40fd3` (use in `apps/server/wrangler` config) |
| T-1.04 | done | task/T-1.04 (merge 3cacebe) | Riviera Yacht venue scene; pnpm check green after merge |
| T-1.05 | done | task/T-1.05-fix3 (merge e378fd5) | Instanced procedural PBR coins; fix round at 0c9b7ce (headless WebGL2 render check, WebGPU device-loss fallback); pnpm check green after merge |
| T-1.06 | done | task/T-1.06-r3 (merge b7c0443) | Post-processing + adaptive quality; fix round at 0e7f8d9; folds P-16 (post/quality side) and P-20; stage wiring in P-22; pnpm check green after merge |
| T-1.13 | done | task/T-1.13 (merge 4619d21) | Procedural audio engine + Riviera music; pnpm check green after merge |
| T-1.01 | done | task/T-1.01 (merge 34a5f79) | Pusher table physics, retry from task/T-1.01-fix4 (22f109c); table hash re-pinned 0f07d3e911f71f99 -> 18542c554c6831a6; pnpm check green after merge |
| T-1.07 | done | task/T-1.07 (merge 84da688) | Server: auth, PlayerDO, conservation ledger; review fixes at 08701b8; pnpm check green after merge |
| T-1.09 | done | task/T-1.09 (merge ebfad0c) | Client net layer + Demo Mode mock, review fix at 65fafcf (mock rejects crate claims ticked before spawn); pnpm check green after merge |
| T-1.11 | done | task/T-1.11 (merge 6ca56a6) | HUD + core UI shell (47ea8b3); mounting in main.ts queued as P-53; pnpm check green after merge |
| P-3 | done | task/P-3 (merge 6355ddd) | STACK.lock.md catch-up, folds P-4, P-5, P-6; pnpm check green after merge |
| P-15 | done | task/P-15 (merge 2a75cd7) | Riviera venue and audio engine wired into boot, folds P-23; pnpm check green after merge |
| T-1.08 | done | task/T-1.08 (merge 1bc8f6d) | Provably fair RNG + rate envelopes, review fix at fe5ac61; DO and index wiring queued as P-46/P-47; pnpm check green after merge |
| P-8 | done | task/P-8 (merge f2df5e8) | Fixed Claude/noreply@anthropic.com worktree identity (2b04d41); pnpm check green after merge |
| P-31 | done | task/P-31 (merge 147180a) | CI turbo cache, dedupe PR/push runs, deploy CI build, Worker secrets; folds P-29; pnpm check green after merge |
| P-9 | done | task/P-9 (merge ee90f19) | Fast deterministic economy sim tests (fixes main CI timeout), shared ID unions, key regex; pnpm check green after merge |
| P-27 | done | task/P-27 (merge a75de20) | Web i18next/shared/economy/zod deps, sim eslint devDep, STACK.lock catch-up; folds P-7, P-30; pnpm check green after merge |
| T-1.12 | done | task/T-1.12 (merge 957db3e) | VFX: drop, fusion, cascade, number pops (51e8a1a); wiring queued as P-56/P-57; pnpm check green after merge |
| P-45 | done | task/P-45 (merge 8c9e23a) | Economy rateEnvelope config and rateEnvelopeFor (33afa8a); unblocks T-1.08; pnpm check green after merge |
| P-10 | done | task/P-10 (merge af272d4) | Shared ID unions, venue list, loot sources, catalog key, fair digest (14b256f); folds P-35, P-36, P-37 (shared side), P-48; pnpm check green after merge |
| P-22 | done | task/P-22 (merge a8accf0) | Stage wiring: adaptive rendering, CoinField, render look (29b99e0); pnpm check green after merge |
| T-1.02 | done | task/T-1.02 (merge 6913afd) | Contact Fusion + Champagne Tower sim (f1fc84a); table/sim wiring queued as P-73..P-79 (sim.ts in P-75); pnpm check green after merge |
| T-1.03 | done | task/T-1.03 (merge 0bd0754) | Physics worker bridge + interpolation (bd21e9e); web sim dep P-80, main.ts bridge switch P-81 (folds P-70); pnpm check green after merge |
| T-1.15 | done | task/T-1.15 (merge 241fdcd) | Upgrades v1 + Velvet Vault offline earnings (44420ad); server/web wiring queued as P-83..P-93; pnpm check green after merge |
| P-42 | done | task/P-42 (merge cfb7596) | Sim drives the pusher table once per tick (2c6171f); folds P-43, P-50 and the web dep/import part of P-80 (turbo ^dependsOn split out to P-104); earlier attempt d6ba702 reverted in a2aaaa3; pnpm check green after merge, also with --force (no cache) |
| P-53 | done | task/P-53 (merge e52bafa) | HUD mounted at boot, audio attached to settings; folds P-28; pnpm check green after merge |
| P-60 | done | task/P-60 (merge 04edd4a) | rateEnvelope required in economy config and validated; folds P-61, P-62, P-64; pnpm check green after merge |
| P-81 | done | task/P-81 (merge 1099563) | main.ts draws coins from the worker sim bridge with sim coin dimensions, Demo Mode net + banner at boot (42d85d2); folds P-70, P-19, P-52; follow-ups P-105..P-107; pnpm check green after merge |
| T-1.10 | done | task/T-1.10 (merge be9be9f) | Gameplay glue: aim, drop, pour, nudge, combo (c8bb9c0); wiring and follow-ups queued as P-108..P-113; pnpm check green after merge |
| P-39 | done | task/P-39 (8526220, not merged) | Folded into P-115 (merge 76bf51a) |
| T-1.16 | done | task/T-1.16 (merge 47815f5) | Balancing pass for the slice (665465a): sim evidence, rate-envelope table, economy property tests; follow-ups P-125..P-130; pnpm check green after merge (uncached) |
| P-115 | done | task/P-115 (merge 76bf51a) | Riviera table derives cabinet/tray from RIVIERA_TABLE + portrait reframe (de8c672); folds P-39, P-99, P-114; follow-ups P-131..P-134; pnpm check green after merge |
| P-111 | done | task/P-111 (merge 961a4e8) | Sim: nudge input, worker contact/fusion/fall events, pusher phase, pusher sweep (b356983); folds P-105 and the sim half of P-120; follow-ups P-135..P-139; pnpm check green after merge |
| P-108 | blocked(review: Vault omits drop-buffer value (reads 8 not 20, P-122); opening heap 150@90/s stalls short of lip, P-120 fails; feedback wired after audioReady drops early juice) | task/P-108 (7372a7c, not merged) | Gameplay systems wiring in main.ts; folds P-122 and main.ts half of P-120; follow-ups P-140..P-151 |
| P-152 | done | task/P-152 (merge fc34966) | Rapier ships once: Rapier-free @coinposh/sim layout/constants entry, Rapier kept inside the worker (67c22cf); folds sim side of P-132 and P-142; follow-ups P-159..P-162; pnpm check green after merge (uncached) |
| P-153 | done | task/P-153 (merge 079d6fb) | main.ts binds the input surface to the sim bridge (drop, pour, nudge, aim reticle) and hydrates the Vault on boot (589bf7e); folds P-122; follow-ups P-163..P-169; pnpm check green after merge |
| P-154 | done | task/P-154 (merge 5de973d) | Riviera camera presets reframed to the P-170 amended targets (oblique view, sky <= 5 %, portrait 55 % / landscape and desktop 70 %), layout imported from @coinposh/sim/layout (f3b2172); follow-ups P-171..P-173, P-178; pnpm check green after merge |
| T-1.14 | done | task/T-1.14 (merge 30d9991) | Vault Crates end-to-end + unbox cinematic (f9b2839); main.ts wiring and follow-ups queued as P-180..P-184; pnpm check green after merge |
| P-176 | done | task/P-176 (merge f7a2cfd) | Pusher actually pushes: rigid raft behind the pusher broken so coins creep forward and fall over the lip (c1dffa1); SIM_VERSION 3 -> 4 with determinism hashes re-pinned (sim.test.ts, mechanics.test.ts edited outside owns, acknowledged by lead); follow-ups P-185..P-189; pnpm check green after merge |
| P-174 | done | task/P-174 (merge 9a10455) | Vault/feedback gate: sim falls, fusions and contacts wired to pops, Vault rise, audio and the Cascade flute; the Demo server mints and pays economyConfig.openingHeap (100 silver), refused falls counted on window.__coinposh.counts (dbd065b); folds P-136, P-149, P-169, P-137, P-204 and P-212; follow-ups P-190..P-198, P-221; pnpm check green after merge |
| P-201 | done | task/P-201 (merge dba5125) | Boot poster behind the canvas until the first lit frame instead of a black void; side meters hidden until playable (9d562eb); pnpm check green after merge |
| P-193 | done | task/P-193 (merge ab0178d) | Opening heap owned by @coinposh/economy as `openingHeap { coins, tier }` (silver) and modelled in the pacing sim (8ff5245); rate-envelope.json regenerated (outside owns, follow-up P-203); follow-ups P-203..P-206; pnpm check green after merge |
| P-175 | done | task/P-175 (merge 0a8a7e9) | Coins read as lathe-turned metal: reeded rims, capped highlights (peaks 1.4 to 1.9 scene-linear under bloom thresholds 0.92 to 0.95), neutral silver, table lookdev (dfb4ef5); follow-ups P-207..P-208; pnpm check green after merge |
| P-202 | blocked(review: layout.ts unchanged; lip-to-dock non-floor share 29.4 % at 390x844 vs 10 % limit, unreachable from the camera under P-154/P-170; layout.test.ts red) | task/P-202 (9a7354e, not merged) | Tray reclaim needs the table.ts cabinet front redesign or an amended acceptance; follow-ups P-209..P-211 |
| P-209 | done | task/P-209 (merge 4fc23ba) | Riviera cabinet front redesigned: reeded lacquer front under a thin brass tray lip (a8ae1ad); pnpm check green after merge |
| P-200 | done | task/P-200 (merge 5159d30) | Empty-Vault dead end: Steward's allowance rule for a broke player in packages/economy/src/config/allowance.ts and 02-ECONOMY.md, plus an empty-Vault HUD state with EN/FR/DE strings (bb14f4d); mock/server crediting queued as P-216..P-220; pnpm check green after merge |
| P-179 | done | task/P-179 (merge 6789df8) | Offline earnings capped below play: measured active rate (30 min window, 10 min minimum span, net play coins) with a documented Velvet Vault starter floor of 60/h in packages/economy/src/config/offlineRate.ts, used by the Demo mock and the server offline route (2a8b03a); follow-ups P-227..P-229; pnpm check green after merge |
| P-107 | done | task/P-107 (merge 3a8f775) | Live-mode guest sign-up obtains a Cloudflare Turnstile token (apps/web/src/net/turnstile.ts, ui/turnstile/overlay.ts) and sends it as turnstileToken; Demo Mode skips Turnstile (4fb47c9, f0ee693); follow-up P-230; pnpm check green after merge |
| T-1.17 | blocked(review: boot.perf.ts red, firstDropMs 3366 vs 3000 ms budget with playable at 3197 ms (boot path, P-231); LoAF blocking gate inert under SwiftShader; frame floors calibrated on dev box not CI) | task/T-1.17 (214fe2c, not merged) | E2E + perf gates; keep the 3 s budget; re-review once boot.perf.ts passes on the Demo build; follow-ups P-231..P-237 |
| P-226 | done | task/P-226 (merge 396836f) | Vault odometer settle/coalesce: minPlaces follows the shown value so mid-roll credits across a power of ten show no leading zero; mid-roll and seeded-fuzz tests (afe029c); pnpm check green after merge |
| P-215 | done | task/P-215 (merge 237e6ea) | Coin rest/sleep physics: settled coins stay put, no idle drain (re-run after review rejection, 02a2ed4); creep.test keeps the P-254 bound falls_during_pour <= ceil(POUR_COINS/32) with strict post-settle zeros; table.bench p99 4.39-4.54 ms vs 4.98-5.02 ms for base on the same host (P-253 rule, re-check P-261); lockfile hunk still open (P-252); pnpm check green after merge |
| P-238 | blocked(review: heap still 100 silver, both acceptance bands fail (first upgrade at 6-15 s, minute 2 x0.22-0.54 of minute 1); mixed heap needs OpeningHeapConfig change outside owns; rate-envelope.json edited outside owns) | task/P-238 (0be1e5c, not merged) | Mixed opening heap blocked on the composition type request P-242; follow-ups P-242..P-246; branch kept |
| P-248 | done | task/P-248 (merge da920d6) | Number pops never paint over open sheets: pops held while a sheet is open, then one tally pop on close (486ff04); pnpm check green after merge |
| P-247 | done | task/P-247 (merge 849be80) | Side meters collapse to slim edge rails outside the coin floor: meterRail + railLayout with box tests, Cascade expands only while a rank is live, Decorum only once it moves, reduced-motion fade (9b3f7cb); follow-up P-251; pnpm check green after merge |
| P-253 | done | task/P-253 (merge 44e5e70) | Formal table.bench re-baseline decision recorded in STACK.lock.md: same-host back-to-back rule and 1.3x host factor; pnpm check green after merge |
| P-254 | done | task/P-254 (merge b55f64f) | creep.test pour front-fall bound APPROVED as falls during the pour <= ceil(POUR_COINS/32) (5 for 160), all falls inside SETTLED_STROKES, strict post-settle zeros kept (decision in POLISH.md P-254/P-215); P-215 re-review checks against it; pnpm check green after merge |
| P-257 | done | task/P-257 (merge d5b674d) | Escape ownership and focus restore for sheets: the open sheet owns Escape wherever focus sits, and a late close restores focus to its trigger only if focus is still inside it (sheetFocus.ts, 8cf66c2); pnpm check green after merge |
| T-92.01 | done | task/T-92.01 (merge 7e2058c) | Shared contracts for table persistence: TableSnapshot/session/layout schemas in packages/shared/src/api/table.ts, tableSnapshotEndpoint, new error codes and ids (40774ee); session/layout optional until T-92.04/T-92.05/T-92.08 (P-265..P-268); pnpm check green after merge (#92) |
| P-180 | done | task/P-180 (merge a42fc7b) | mountCrates() wired into main.ts: crates mounted with net, sim port, stage, framing, UI, vfx, haptics, audio, inventory and the systems bus; crates already on the table adopted at boot (bae04e3); follow-up P-269 (cascade multiplier, #112); pnpm check green after merge |
| T-92.02 | done | task/T-92.02 (merge 61ecea6) | Sim snapshot + restore; woken-coin bound 1.5 mm recorded in design 92 sec 1.4 (PR #124); re-review APPROVE 8d43b5b; follow-ups P-271..P-276, P-282, P-283 (#92) |
| T-92.03 | done | task/T-92.03 (merge 0f3b434) | Crate spawns not re-earned through refunds (#84): PlayerDO.ts tracks spent crate spawns, schema.ts migration, reload/schema tests (71a8be0); pnpm check green after merge |
| P-264 | done | task/P-264 (merge 2f4a90c) | Cascade rank card fits its rank name and stays clear of the flute: railLayout box helpers, comboLadder/meterRail fit the longest EN/FR/DE rank names inside the card, with box tests at 390x844 and 360x780 (4326ffa); pnpm check green after merge |
| P-288 | done | task/P-288 (merge 815cfac) | Vault Crate arrival hint clears the Vault balance on phones: hint placed past the payout lip, clear of hud-balance and side rails, at most two lines in EN/FR/DE at 390x844 and 360x780, spring-in with reduced-motion fade (c601033); pnpm check green after merge |
| P-231 | done | task/P-231 (merge 7d07031) | Do not gate playable on the environment bake (rework after review): boot on an inlined HDRI fallback and crossfade the baked HDRI in later, HDRI handoff held off the boot path and aborted on dispose (5e618e7); pnpm check green after merge; follow-ups P-292, P-293 |
| P-284 | done | task/P-284 (merge f3072ec) | Boot path under the 3000 ms first-drop budget (rework after review): venue held on a hidden layer until crates mount so each venue program links once, sim worker starts early and the stage waits for sim ready (at most 1500 ms), User Timing boot marks, initial JS 167651 B gzip vs 167668 B base (c3f03a9); pnpm check green after merge; follow-ups P-315, P-316 |
| P-286 | blocked(review: alone fails pnpm check lint on apps/web/e2e/*.ts without T-1.17's apps/web/package.json devDependencies; boot.perf 4841 ms and frames.perf p95 850 ms red under load, budgets correctly unchanged) | task/P-286 (fc51ecc, not merged) | Fix: integrate together with T-1.17's apps/web/package.json (@playwright/test 1.64.1, @types/node 24.19.2, e2e/perf/bundle:check scripts, typecheck -p e2e, keep test:perf) and pnpm-lock.yaml, merging only P-286's copies of apps/web/e2e; re-gate on an idle runner after P-284 lands; follow-ups P-298..P-303 |
| P-307 | done | task/P-307 (merge 6387d4a) | Crate reward card stays off the dock and does not jump: placeCrateCard rests the card between hud-balance and hud-dock (shrinking it when there is no room), no place-items switch on reveal, card kept out of layout until placed; placement unit tests at 390x844, 360x640 and landscape (a14adf1, review fixes 98ad21f); pnpm check green after merge; follow-up P-310 (e2e rect sampling) |
| P-222 | done | task/P-222 (merge d692f54) | Contact Fusion on in the worker with a spawn grace: table-config takes fusion from economyConfig, sim fuses only coins past the spawn grace so the opening heap and fresh drops are kept, determinism hashes updated by design (234e115); pnpm check green after merge; follow-ups P-311..P-314 |
| P-239 | done | task/P-239 (merge 268d0cc) | First-affordable-upgrade nudge shown once only: upgradeNudgeTrigger fires on the first affordable upgrade, upgradeNudge component in the HUD and upgrades panel, EN/FR/DE strings, trigger unit tests (81bbcc3); pnpm check green after merge |
| P-290 | done | task/P-290 (merge fd1c81d) | Crate reward lines name the charm/card and pluralise currencies: loot.ts resolves charm and album-card names with rarity, revealCard shows them with album set progress, EN/FR/DE plural currency lines in crates/i18n.ts (a4f873d); follow-up P-321 (GET /v1/album on the server); pnpm check green after merge |
| T-92.04 | todo | | Waits on T-92.01, T-92.02, T-92.03 (#92) |
| T-92.05 | todo | | Waits on T-92.01, T-92.02 (#92) |
| T-92.06 | todo | | Waits on T-92.02 (#92) |
| T-92.07 | todo | | Waits on T-92.05, T-92.06, T-92.10 (#92) |
| T-92.08 | todo | | Waits on T-92.04 (#85) |
| T-92.09 | todo | | Waits on T-92.07, T-92.08, T-1.17 (#92) |
| T-92.10 | todo | | Waits on T-92.02 (#92, crates) |
| T-2.01 | todo | | Waits on T-1.18. Key-locked Safes (server + client + cinematic) |
| T-2.02 | todo | | Waits on T-1.18. Scratch Cards (GPU scratch mask) |
| T-2.03 | todo | | Waits on T-1.18. Gacha Capsule Machine |
| T-2.04 | todo | | Waits on T-1.18. Odds & "Certified Fair" UI |
| T-2.05 | todo | | Waits on T-1.18. Inventory & item cards; founder wants next, gated by T-1.18 (open question: relax deps) |
| T-3.01 | todo | | Waits on T-2.05. Charm Board (sockets, 6 charms, synergy tags) |
| T-3.02 | todo | | Waits on T-2.05. Charm models & effects |
| T-3.03 | todo | | Waits on T-2.05. Collection Album + Heirloom coins |
| T-3.04 | todo | | Waits on T-2.05. Venue Ascension (prestige) + Family Office; founder wants next, gated by T-1.18 (open question: relax deps) |
| T-3.05 | todo | | Waits on T-2.05. Quests, streaks, Season Pass (free track; premium behind flag) |
| T-3.06 | todo | | Waits on T-3.01. Soirée Nights run mode |
| T-3.07 | todo | | Waits on T-3.04, T-3.05. Meta balancing |
| T-10.01 | done | task/T-10.01 (merge 75e63f3) | Account link contracts: packages/shared/src/api/account.ts, accountEndpoints in endpoints.ts, new error codes (e91c834); wiring into `endpoints`, fixtures and Demo mock queued as P-281 for T-10.03; pnpm check green after merge |
| T-10.02 | done | task/T-10.02 (merge 695d63b) | Server: verify ID tokens, link, sign in on a new device (19c8550, POLISH.md hunk dropped after review); follow-ups P-304..P-306; P-292..P-294 already queued in POLISH.md; pnpm check green after merge |
| T-10.03 | todo | | Waits on T-10.01, T-92.05. Net layer + Demo mock for account link |
| T-10.04 | todo | | Waits on T-10.03. Account UI: link, sign in, progress choice |
| H-10.01 | todo | | Human step: Google Cloud OAuth web client (origins `https://sashimee.github.io`, `https://devcoinposh.bas.lu`, localhost) → Worker secret `GOOGLE_CLIENT_ID`, repo variable `VITE_GOOGLE_CLIENT_ID` |
| H-10.02 | todo | | Human step: Apple Developer membership (same account as H-7.01, pulled forward), Services ID and Sign in with Apple key → Worker secrets `APPLE_SERVICES_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, repo variable `VITE_APPLE_SERVICES_ID` |
| T-11.01 | todo | | Waits on T-92.07, T-92.08, T-10.02, T-10.03. Feature-module seams |
| T-11.02 | todo | | Waits on T-92.02. Sim prop seam |
| T-11.03 | todo | | Waits on T-11.01. Collecting contracts |
| T-11.04 | todo | | Waits on T-11.03, T-3.07. Collecting numbers |
| T-11.05 | todo | | Waits on T-11.02, T-11.03. Sim: prize bodies |
| T-11.06 | todo | | Waits on T-11.04. Server: prizes and coin variants |
| T-11.07 | todo | | Waits on T-11.03. Prize and variant looks |
| T-11.08 | todo | | Waits on T-11.05, T-11.06, T-11.07. Prize flow and juice |
| T-11.09 | todo | | Waits on T-11.06, T-3.03. Collection book UI |
| T-11.10 | todo | | Waits on T-11.07, T-3.03. Trophy lounge scene |
| T-11.11 | todo | | Waits on T-11.10. Lounge UI and share |
| T-11.12 | todo | | Waits on T-11.04. Server: wine cellar |
| T-11.13 | todo | | Waits on T-11.12. Wine cellar UI |
| T-11.14 | todo | | Waits on T-11.03. Collecting audio |
| T-11.15 | todo | | Waits on T-11.08, T-11.09, T-11.11, T-11.13, T-11.14. Collecting wiring |
| T-11.16 | todo | | Waits on T-11.15, T-1.17. E2E: collecting |
| T-12.01 | todo | | Waits on T-11.01. Standing contracts |
| T-12.02 | todo | | Waits on T-12.01, T-3.07. Standing numbers |
| T-12.03 | todo | | Waits on T-12.02. Server: Repute, ranks, titles, perks |
| T-12.04 | todo | | Waits on T-12.02. Server: achievements |
| T-12.05 | todo | | Waits on T-12.02, T-3.01. Server: mastery |
| T-12.06 | todo | | Waits on T-12.02, T-11.12. Server: staff |
| T-12.07 | todo | | Waits on T-12.06. Staff on the table |
| T-12.08 | todo | | Waits on T-12.01. Staff figures |
| T-12.09 | todo | | Waits on T-12.03, T-12.04. Ranks and achievements UI |
| T-12.10 | todo | | Waits on T-12.05, T-12.06. Mastery and staff UI |
| T-12.11 | todo | | Waits on T-12.01. Standing juice and audio |
| T-12.12 | todo | | Waits on T-12.01. Standing sounds |
| T-12.13 | todo | | Waits on T-12.07, T-12.08, T-12.09, T-12.10, T-12.11, T-12.12, T-11.15. Standing wiring |
| T-12.14 | todo | | Waits on T-12.13. E2E: standing |
| T-13.01 | todo | | Waits on T-11.01. Live events contracts |
| T-13.02 | todo | | Waits on T-13.01, T-3.07. Live events numbers |
| T-13.03 | todo | | Waits on T-13.02. Server: login calendars |
| T-13.04 | todo | | Waits on T-13.03. Calendar UI |
| T-13.05 | todo | | Waits on T-11.02. Sim: daily puzzle goals |
| T-13.06 | todo | | Waits on T-13.02, T-13.05, T-4.01, T-4.03. Server: daily puzzle and board |
| T-13.07 | todo | | Waits on T-13.06. Daily puzzle UI |
| T-13.08 | todo | | Waits on T-13.02, T-4.02. Server: boss events |
| T-13.09 | todo | | Waits on T-13.01. Boss presence |
| T-13.10 | todo | | Waits on T-13.02, T-4.02. Server: holiday events and seasonal tie-ins |
| T-13.11 | todo | | Waits on T-13.10. Holiday themes: first two |
| T-13.12 | todo | | Waits on T-13.08, T-13.10. Live events UI |
| T-13.13 | todo | | Waits on T-13.01. Live events juice and sound |
| T-13.14 | todo | | Waits on T-13.01. Live events audio |
| T-13.15 | todo | | Waits on T-13.04, T-13.07, T-13.09, T-13.11, T-13.12, T-13.13, T-13.14, T-12.13. Live events wiring |
| T-13.16 | todo | | Waits on T-13.15. E2E: live events |
| T-14.01 | todo | | Waits on T-11.01. World contracts |
| T-14.02 | todo | | Waits on T-11.01. Concierge brain |
| T-14.03 | todo | | Waits on T-14.02. Concierge character and lines |
| T-14.04 | todo | | Waits on T-14.02. Concierge voice |
| T-14.05 | todo | | Waits on T-14.01, T-3.07. World numbers |
| T-14.06 | todo | | Waits on T-14.05. Server: guest stories and pets |
| T-14.07 | todo | | Waits on T-14.06. Guest letters UI |
| T-14.08 | todo | | Waits on T-11.02, T-14.01. Sim: pet fetch |
| T-14.09 | todo | | Waits on T-14.01. Pets |
| T-14.10 | todo | | Waits on T-14.01. Server: venue conditions |
| T-14.11 | todo | | Waits on T-14.10. Day/night and weather rendering |
| T-14.12 | todo | | Waits on T-14.03, T-14.04, T-14.07, T-14.08, T-14.09, T-14.11, T-13.15. World wiring |
| T-14.13 | todo | | Waits on T-14.12. E2E: world |
| T-15.01 | todo | | Waits on T-11.01. Retention contracts |
| T-15.02 | todo | | Waits on T-15.01, T-12.02. Retention numbers |
| T-15.03 | todo | | Waits on T-15.02. Server: comeback, catch-up, rested |
| T-15.04 | todo | | Waits on T-15.02, T-12.04. Server: weekly chest and goals |
| T-15.05 | todo | | Waits on T-15.03, T-15.04. Retention UI |
| T-15.06 | todo | | Waits on T-15.05, T-14.12. Retention wiring and e2e |
| T-16.01 | todo | | Waits on T-11.01. Table mechanics contracts |
| T-16.02 | todo | | Waits on T-16.01, T-3.07. Table mechanics numbers |
| T-16.03 | todo | | Waits on T-11.02. Sim: bonus targets |
| T-16.04 | todo | | Waits on T-11.02. Sim: peg field |
| T-16.05 | todo | | Waits on T-11.02. Sim: moving parts and venue layouts |
| T-16.06 | todo | | Waits on T-11.02. Sim: jackpot ball |
| T-16.07 | todo | | Waits on T-16.02. Server: targets and jackpot ball |
| T-16.08 | todo | | Waits on T-16.01. Mechanics models |
| T-16.09 | todo | | Waits on T-16.01. Mechanics juice |
| T-16.10 | todo | | Waits on T-16.01. Mechanics audio |
| T-16.11 | todo | | Waits on T-16.02, T-16.03, T-16.04, T-16.05, T-16.06. Rate envelope for mechanics |
| T-16.12 | todo | | Waits on T-4.03, T-16.03, T-16.04, T-16.05, T-16.06. Verifier replays mechanics |
| T-16.13 | todo | | Waits on T-16.07, T-16.08, T-16.09, T-16.10, T-16.11, T-15.06. Table mechanics wiring |
| T-16.14 | todo | | Waits on T-16.13. E2E: table mechanics |
| T-17.01 | todo | | Waits on T-16.06. Director camera |
| T-17.02 | todo | | Ready: deps done. Adaptive music |
| T-17.03 | todo | | Waits on T-7.02. Haptic pattern library |
| T-17.04 | todo | | Waits on T-17.01, T-17.02, T-17.03. Game feel wiring |
| T-18.01 | todo | | Waits on T-11.01. Comfort contracts |
| T-18.02 | todo | | Waits on T-18.01. Server: stats |
| T-18.03 | todo | | Waits on T-18.02. Stats UI |
| T-18.04 | todo | | Waits on T-18.01, T-12.03. Auto-drop |
| T-18.05 | todo | | Waits on T-11.02. Sim: replay recorder |
| T-18.06 | todo | | Waits on T-18.05. Big-win replays |
| T-18.07 | todo | | Waits on T-18.06. Cinematic replay camera |
| T-18.08 | todo | | Waits on T-18.03, T-18.04, T-18.07, T-16.13. Comfort wiring and e2e |
| T-19.01 | todo | | Waits on T-6.02, T-10.04. Parental settings |
| T-19.02 | todo | | Waits on T-19.01. Server: parental policy |
| T-19.03 | todo | | Waits on T-6.02. Left-hand and Zen modes |
| T-19.04 | todo | | Waits on T-19.03. Landscape tablet layout |
| T-19.05 | todo | | Ready: deps done. Keyboard and mouse controls |
| T-19.06 | todo | | Waits on T-19.02, T-19.04, T-19.05, T-18.08. Accessibility wiring and e2e |
| T-20.01 | todo | | Waits on T-11.01, T-4.01. Community contracts |
| T-20.02 | todo | | Waits on T-20.01, T-3.07. Community numbers |
| T-20.03 | todo | | Waits on T-20.02, T-10.02. Server: gifts |
| T-20.04 | todo | | Waits on T-20.02, T-10.02. Server: clubs |
| T-20.05 | todo | | Waits on T-20.02, T-92.04. Server: visits |
| T-20.06 | todo | | Waits on T-20.05, T-92.07. Visit view |
| T-20.07 | todo | | Waits on T-18.06. Photo mode and auto-clips |
| T-20.08 | todo | | Waits on T-20.03, T-20.04, T-20.06. Social UI |
| T-20.09 | todo | | Waits on T-20.07, T-20.08, T-19.06. Social wiring and e2e |
| T-21.01 | todo | | Waits on T-11.01, T-4.01. Competitive contracts |
| T-21.02 | todo | | Waits on T-21.01, T-3.07. Competitive numbers |
| T-21.03 | todo | | Waits on T-21.02. Server: weekly leagues |
| T-21.04 | todo | | Waits on T-21.02, T-4.03. Server: weekend tournaments |
| T-21.05 | todo | | Waits on T-21.04, T-18.05. Ghost races |
| T-21.06 | todo | | Waits on T-21.04. Server: spectate |
| T-21.07 | todo | | Waits on T-21.03, T-21.04, T-21.06. Competitive UI |
| T-21.08 | todo | | Waits on T-21.05, T-21.07, T-20.09. Competitive wiring and e2e |
| T-22.01 | todo | | Waits on T-11.03. Economy depth contracts |
| T-22.02 | todo | | Waits on T-22.01, T-11.04. Economy depth numbers |
| T-22.03 | todo | | Waits on T-22.02. Server: workshop and smelting |
| T-22.04 | todo | | Waits on T-22.02. Server: charity gala |
| T-22.05 | todo | | Waits on T-22.02, T-20.03. Server: player trading |
| T-22.06 | todo | | Waits on T-22.03, T-22.04, T-22.05. Workshop, gala and trading UI |
| T-22.07 | todo | | Waits on T-22.06, T-21.08. Economy depth wiring and e2e |
| T-23.01 | todo | | Waits on T-11.01. Side games contracts |
| T-23.02 | todo | | Waits on T-23.01, T-3.07. Side games numbers |
| T-23.03 | todo | | Waits on T-11.02. Sim: claw machine |
| T-23.04 | todo | | Waits on T-23.02. Server: claw, auction, treasure, stocks |
| T-23.05 | todo | | Waits on T-23.01. Claw cabinet and vault table |
| T-23.06 | todo | | Waits on T-23.03, T-23.04, T-23.05. Claw play |
| T-23.07 | todo | | Waits on T-23.04. Side games UI |
| T-23.08 | todo | | Waits on T-23.06, T-23.07, T-22.07. Side games wiring and e2e |
| T-24.01 | todo | | Waits on T-16.01. Creation contracts |
| T-24.02 | todo | | Waits on T-24.01, T-16.11. Creation numbers |
| T-24.03 | todo | | Waits on T-16.05. Sim: layout validation |
| T-24.04 | todo | | Waits on T-24.02, T-24.03. Server: layouts, loadouts, puzzles, votes |
| T-24.05 | todo | | Waits on T-24.04. Table editor |
| T-24.06 | todo | | Waits on T-24.04. Creation UI |
| T-24.07 | todo | | Waits on T-24.05, T-24.06, T-23.08. Creation wiring and e2e |
| T-25.01 | todo | | Waits on T-11.01. Cosmetics contracts |
| T-25.02 | todo | | Waits on T-25.01, T-12.02. Cosmetics numbers |
| T-25.03 | todo | | Waits on T-25.02. Server: cosmetics |
| T-25.04 | todo | | Waits on T-25.01, T-11.10. Table and pusher skins, lounge decor |
| T-25.05 | todo | | Waits on T-25.01. Monograms and crests |
| T-25.06 | todo | | Waits on T-25.01. Drop trails |
| T-25.07 | todo | | Waits on T-25.01. Sound packs |
| T-25.08 | todo | | Waits on T-25.03. Wardrobe UI |
| T-25.09 | todo | | Waits on T-25.04, T-25.05, T-25.06, T-25.07, T-25.08, T-24.07. Cosmetics wiring and e2e |
| T-26.01 | todo | | Waits on T-11.01. Meta contracts |
| T-26.02 | todo | | Waits on T-26.01, T-3.07. Meta numbers |
| T-26.03 | todo | | Waits on T-26.02, T-3.04. Server: empire, dynasty, Society Pages |
| T-26.04 | todo | | Waits on T-26.01. Empire map |
| T-26.05 | todo | | Waits on T-26.03. Dynasty and Society Pages UI |
| T-26.06 | todo | | Waits on T-26.04, T-26.05, T-25.09. Meta wiring and e2e |
| T-27.01 | todo | | Waits on T-1.18. Installable PWA with offline Demo play |
| T-27.02 | todo | | Waits on T-10.02, T-10.03. QR session move |
| T-27.03 | todo | | Waits on T-7.02. Home-screen widgets |
| T-27.04 | todo | | Waits on T-27.01, T-6.04. Desktop shell (Electron) |
| T-27.05 | todo | | Waits on T-27.04, T-12.04. Steam integration |
| H-27.01 | todo | | Human step: Steamworks partner account, app fee, App ID and depot → repo secrets `STEAM_APP_ID`, `STEAM_WEB_API_KEY` |
| H-27.02 | todo | | Human step: Apple and Windows code-signing certificates for the desktop builds |
| T-28.01 | todo | | Waits on T-11.01. Content contracts |
| T-28.02 | todo | | Waits on T-28.01, T-3.07. Venues 6–9 and challenge numbers |
| T-28.03 | todo | | Waits on T-28.01, T-16.05. Monaco Grand Prix |
| T-28.04 | todo | | Waits on T-28.01, T-16.05. Venetian Palazzo |
| T-28.05 | todo | | Waits on T-28.01, T-16.05. Dubai Sky Villa |
| T-28.06 | todo | | Waits on T-28.01, T-16.05. Desert Oasis Train |
| T-28.07 | todo | | Waits on T-11.02. Sim: challenge modifiers |
| T-28.08 | todo | | Waits on T-28.02, T-28.07. Server: challenges, jukebox, codex |
| T-28.09 | todo | | Waits on T-28.01. Jukebox |
| T-28.10 | todo | | Waits on T-28.08. Challenge, jukebox and codex UI |
| T-28.11 | todo | | Waits on T-28.03, T-28.04, T-28.05, T-28.06, T-28.09, T-28.10, T-26.06. Content wiring and e2e |

Tasks not listed yet are `todo`. The integrator appends rows as tasks start.

## Wave log
<!-- integrator appends: wave N · date · tasks · result -->
- wave 1 · 2026-11-07 · T-0.01 · merged T-0.01 (37fcbe6); 0 rejected
- wave 2 · 2026-11-07 · T-0.02, T-0.03, T-0.04, T-0.05, T-1.04, T-1.13, T-1.05, T-1.06 · merged T-0.02 (b54be8a), T-0.03 (ff12826), T-0.04 (cac1c89), T-0.05 (27dc17b), T-1.04 (3cacebe), T-1.13 (4619d21); 2 rejected (T-1.05, T-1.06)
- wave 3 · 2026-11-07 · T-1.07 P-15 P-3 · merged T-1.07 (84da688), P-15 (2a75cd7), P-3 (6355ddd); 5 rejected (T-1.01, T-1.05, T-1.06, T-1.09, T-1.11)
- wave 4 · 2026-11-07 · P-31 P-9 P-27 T-1.05 T-1.06 T-1.01 T-1.08 P-8 · merged P-31 (147180a), P-9 (ee90f19), P-27 (a75de20), T-1.05 (e378fd5), T-1.06 (b7c0443); 3 rejected (T-1.01, T-1.08, P-8)
- wave 5 · 2026-11-07 · T-1.01 T-1.11 T-1.12 P-45 P-10 P-22 P-8 T-1.09 · merged T-1.01 (34a5f79), T-1.11 (6ca56a6), T-1.12 (957db3e), P-45 (8c9e23a), P-10 (af272d4), P-22 (a8accf0), P-8 (f2df5e8); 1 rejected (T-1.09)
- wave 6 · 2026-11-07 · T-1.09 T-1.08 T-1.02 T-1.03 T-1.15 P-42 P-53 P-60 · merged T-1.09 (ebfad0c), T-1.08 (1bc8f6d), T-1.02 (6913afd), T-1.03 (0bd0754), T-1.15 (241fdcd), P-53 (e52bafa), P-60 (04edd4a); 0 rejected; P-42 merged (d6ba702) then reverted (a2aaaa3) after uncached check failed in apps/web
- wave 7 · 2026-11-08 · P-42 P-81 T-1.10 P-39 · merged P-42 (cfb7596), P-81 (1099563), T-1.10 (be9be9f); 1 rejected (P-39)
- wave 8 · 2026-11-08 · T-1.16 P-115 P-111 P-108 · merged T-1.16 (47815f5), P-115 (76bf51a), P-111 (961a4e8); 1 rejected (P-108)
- wave 9 · 2026-11-08 · P-153 P-154 P-152 · merged P-152 (fc34966), P-153 (079d6fb); 1 rejected (P-154)
- wave 10 · 2026-11-08 · P-176 P-174 P-154 T-1.14 · merged P-154 (5de973d), T-1.14 (30d9991), P-176 (f7a2cfd); 1 rejected (P-174)
- wave 11 · 2026-11-08 · P-193 P-201 P-202 P-175 · merged P-201 (dba5125), P-193 (ab0178d), P-175 (0a8a7e9); 1 rejected (P-202)
- wave 12 · 2026-11-08 · P-209 P-200 P-174 · merged P-209 (4fc23ba), P-200 (5159d30), P-174 (9a10455); 0 rejected
- wave 13 · 2026-11-08 · P-179 P-107 T-1.17 P-226 · merged P-179 (6789df8), P-107 (3a8f775); 2 rejected (T-1.17, P-226)
- wave 14 · 2026-11-08 · P-215 P-238 P-226 · merged P-226 (396836f); 2 rejected (P-215, P-238)
- wave 15 · 2026-11-09 · P-215 P-247 P-248 · merged P-248 (da920d6), P-247 (849be80); 1 rejected (P-215)
- wave 16 · 2026-11-09 · P-215 P-253 P-254 P-257 · merged P-253 (44e5e70), P-254 (b55f64f), P-257 (d5b674d), P-215 (237e6ea); 0 rejected
- wave 17 · 2026-11-09 · T-92.01 T-92.02 P-180 · merged T-92.01 (7e2058c), P-180 (a42fc7b); 1 rejected (T-92.02)
- wave 18 · 2026-11-09 · T-92.02 T-92.03 T-10.01 P-231 P-264 · merged T-10.01 (75e63f3), T-92.03 (0f3b434), P-264 (2f4a90c); 2 rejected (T-92.02, P-231)
- wave 19 · 2026-11-09 · P-284 P-231 P-286 T-10.02 P-288 · merged P-288 (815cfac), P-231 (7d07031); 3 rejected (P-284, P-286, T-10.02)
- wave 20 · 2026-11-09 · P-222 P-284 T-10.02 P-307 P-239 · merged T-10.02 (695d63b), P-307 (6387d4a), P-222 (d692f54), P-239 (268d0cc), P-284 (f3072ec); 0 rejected
