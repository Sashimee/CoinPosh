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
| T-1.17 | done | task/T-1.17 (merge 02b27de) | E2E + perf gates re-gated per P-366: Playwright e2e (boot, core-loop, crates, settings), boot/frames perf specs, bundle-size gate and perf.yml workflow, 214fe2c bundle caps kept (3d5d2e7); follow-ups in POLISH (Other lazy JS 109.6 kB over the 95 kB cap so perf.yml bundle gate is red, budgets.ts wasm comment stale, AdaptiveRendering page-error allowlist); pnpm check green after merge |
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
| P-181 | done | task/P-181 (merge be2ae13) | Real crate rigid body in the sim pushed over the lip: crate body, dropCrate input, crateFalls/crateImpacts events and Sim.crates() poses (packages/sim/src/table/table.ts, tuning.ts, crate.test.ts) (6b6b7f0); follow-ups P-388..P-393 in POLISH; pnpm check green after merge |
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
| T-92.04 | done | task/T-92.04 (merge 1a41f90) | Server pose storage, POST /v1/table/snapshot and boot placement: apps/server/src/do/snapshot.ts + tests, routes/table.ts (d7444c3); follow-ups P-266 (re-raised), P-322, P-323; pnpm check green after merge (#92) |
| P-258 | done | task/P-258 (merge 83429ae) | Opening heap rests at the brink with no front falls without input: packages/sim/src/table/brink.test.ts pins the Demo heap at rest with no input (1424d95); pnpm check green after merge |
| P-317 | done | task/P-317 (merge a1b8e8e) | Tier fusion juice: routine fusion gets a compact white-gold flash and tier-up chime with no camera kick or hit-stop; full set piece only for the first fusion of the session or a gold+ result, camera kicks rate-limited to 1 per 3 s; vfx/fusionJuice.ts + tests, emitters and index updated (dea13f6); pnpm check green after merge |
| P-308 | done | task/P-308 (merge 1a0bd3f) | Cascade announcements (tier stamp, combo ladder, meter rail) held during the crate cinematic via cinematicHold.ts/announcementHold.ts with tests; review rework bounds pre-reveal and fell-to-opened phases and hides the stamp on the hold tick (4c605fd); pnpm check green after merge; seeded e2e spec queued as P-324 |
| P-318 | done | task/P-318 (merge b2117b9) | Vault Crate reads as a prize: bevelled body, gold corner caps, rarity-coloured seam glow and an idle glint in crates/view.ts with view.test.ts, index.ts updated (3c2c118); pnpm check green after merge; follow-up P-334 (table.rolled on crate:opened) |
| P-332 | done | task/P-332 (merge 4816a52) | Fusion follow-ups from #132: fusionWindow upgrade lengthens FUSION_TUNING.freshTicks (simMechanicsAt), idle coppers below wakeFromTier skip contact grouping, #wake order-independence test, sim.ts reflow and table-config wording (afb7823); pnpm check green after merge; item 5 (fresh-coin cue) deferred to vfx-juice, worker wiring and pacing review queued in POLISH |
| P-329 | done | task/P-329 (merge 7d36d37) | Review rework: unbox shot fit precomputed per variant with one scratch camera and memoized per (aspect, variant), test:perf under 2 ms (shot.perf.test.ts); unbox material primer so the staged crate shows from the first frame; framing tests at 390x844 / 844x390 / reduced motion (2a33a4b); pnpm check green after merge; follow-ups in POLISH.md |
| P-333 | done | task/P-333 (merge 8c90ad9) | Review rework: fusionShare 0.773 calibrated on aimed play, envelope base limits derived from burst-model and honest physics peaks (drops 115 / falls 300 / fallValue 1252 / fusions 127 / crates 28), venue bullion thresholds V1 4400 / V2 28000 (V3+ x1.4), ladder pacing tests in packages/economy/sim/ladder.test.ts (eb40c75); pnpm check green after merge; follow-ups in POLISH.md |
| P-338 | done | task/P-338 (merge cf1de84) | After a hold ends, a peak whose cascade is over replays only as a compact pulse on the Cascade rail (no centre stamp); a full stamp plays only when the live rank is still at or above the peak; announcementHold unit tests cover both paths (b71c858); pnpm check green after merge; follow-ups in POLISH.md |
| P-337 | done | task/P-337 (merge b0a5f63) | Pity line names the crate ("A Rare crate or better within N opens", EN/FR/DE) and is hidden when this crate met the floor; N pinned to the economy forcedFloor rule in crates.test.ts after 0, 1 and 9 non-Rare opens (fa5fffc); pnpm check green after merge; follow-ups in POLISH.md |
| P-335 | done | task/P-335 (merge d51d679) | Confirmed upgrade purchases (on `upgrade:purchased`, not on tap) play the chime plus a medallion overshoot spring, a gold glint across the row, a number pop of the new effect and a haptic; reduced-motion fades the row without moving it; feedback binding unit test in feedback.test.ts (dc50877); pnpm check green after merge; follow-ups in POLISH.md |
| P-331 | done | task/P-331 (merge 6b27852) | First-upgrade nudge says the upgrade is ready now ("Pusher Tempo is ready", EN/FR/DE) and folds after 6 s or immediately on crate:fell; upgradeNudge.test.ts covers both fold paths (ca1a66e); pnpm check green after merge |
| P-328 | done | task/P-328 (merge ea900b2) | Crate cinematic "Tap to skip" hint sits above the dimmed HUD dock and clear of the Vault balance (crates.css, revealCard.ts); crates.test.ts covers the placement (60965ca); pnpm check green after merge (shot.perf p95 missed 2 ms once at load avg 13.7, passed on rerun) |
| P-341 | done | task/P-341 (merge bd470d7) | Review rework: unbox heroes are recognisable rarity-tinted props (new hero.ts) seated on the pedestal cap top with an open key bow; reduced-motion reveal is shielded from the burst (stage.ts); shot.test.ts covers the hero mapping and cap clearance (59b1a75); pnpm check green after merge; scratch-card vs collectible mapping queued for crates owner in POLISH.md |
| P-339 | done | task/P-339 (merge 12581c4) | Vault Crate keeps its gold caps and seam glow on the dim front floor: matte self-lit lacquer and floor-independent cap/seam emissive in crates/view.ts with view.test.ts coverage (8626645, review rework ee8546f); pnpm check green after merge; glint-constant re-export and front-lip gloss imbalance queued in POLISH.md |
| P-343 | done | task/P-343 (merge 480fe05) | Review rework: unbox timeline presents the burst frame before the card (plan.ts, cinematic.ts); crates.test.ts steps one more frame past the burst so its two reveal tests pass; unbox.test.ts covers burst-frame ordering; pnpm check green after merge |
| P-345 | done | task/P-345 (merge bb2d650) | Crate unbox waits in the queue while a sheet is open (claim and roll still go to the server) and starts on close; a sheet opened mid-cinematic holds it, never stacks; Escape collects the reward card (mount.ts, view.ts, events.ts; mount.test.ts and view.test.ts cover queue-while-open, release-on-close, no double start) (7ac4479); pnpm check green after merge; dock "Vault Crate ready" state and cinematicHold held-crate handling queued for ui-engineer in POLISH.md |
| P-346 | blocked(review: e2e acceptance 3 not delivered, apps/web/e2e/callouts.spec.ts missing; needs T-1.17/P-286 e2e infra) | task/P-346 (448e84a, not merged) | Fix: land callouts.spec.ts with T-1.17's apps/web/package.json, e2e tsconfig and fixtures, re-gate with pnpm e2e; CRATE_HINT_SLOT_MS mirrors ARRIVAL_HINT_MS (follow-up: crate:hint-shown/hidden events); branch kept |
| P-348 | done | task/P-348 (merge 577c6ea) | Certified Fair chip is a 44 px button showing the roll nonce and opens an odds + provably-fair sheet (new odds.ts, oddsSheet.ts; revealCard.ts, crates.css, EN/FR/DE i18n): per-rarity shares from @coinposh/economy, pity outlook, commitment hash, nonce, verify via packages/shared fair once the seed is revealed; odds.test.ts pins odds and per-roll nonce (f9ecd15); pnpm check green after merge; revealedSeeds wiring (mount.ts), odds-sheet event and ROADMAP owns note queued in POLISH.md |
| P-350 | done | task/P-350 (merge 36062bc) | Upgrade rows keep their height across a purchase (upgradesPanel.ts, styles.css; new upgradesPanel.test.ts); pnpm check green after merge |
| P-358 | done | task/P-358 (merge c5b505a) | A Legendary crate stars its best item: hero and first reward line chosen by rarity (crates/loot.ts; crates.test.ts, shot.test.ts); pnpm check green after merge |
| P-359 | done | task/P-359 (merge ff1e439) | COLLECT pays out visibly: crate credit held from open until collect, reward lines fly to the Vault and wallet chips (balancePlaque.ts, crates/mount.ts, styles.css, EN/FR/DE i18n; balancePlaque.test.ts, mount.test.ts; 268b4e4); pnpm check green after merge; main.ts purse seeding/exact delta, crate-payout e2e, revealCard opacity note queued in POLISH.md |
| P-362 | done | task/P-362 (merge 94f7fef) | "Awaiting the house" no longer resizes or flickers the Vault plaque: provisional state shown only after 600 ms, non-layout treatment, label in aria-label (balancePlaque.ts, styles.css; new tests in balancePlaque.test.ts; a37ccbb); pnpm check green after merge; plaque-height e2e queued in POLISH.md |
| P-365 | done | task/P-365 (merge e027599) | Demo Mode seed hook: the mock reads `window.__coinposhDemoSeed` (server and client seeds) only in Demo Mode, random seeds otherwise, ignored with a real API client (fair.ts; new tests in fair.test.ts; 58bfa1e); pnpm check green after merge; twice-boot crate #0 e2e queued in POLISH.md |
| P-352 | done | task/P-352 (merge d99e2ce) | Reward card no longer buries the 3D hero reward: unbox presentation plan holds and scales the card so the hero stays visible (revealCard.ts, cinematic.ts, plan.ts, stage.ts; new presentation.ts and presentation.test.ts; 5dde378); pnpm check green after merge; 80 % e2e and crates.css follow-ups queued in POLISH.md |
| P-155 | done | task/P-155 (merge 6751fa6) | Demo Mode banner collapses to a small "Demo" chip after 4 s (tap to expand), stays beneath open sheets, reduced motion skips the collapse animation (demoBanner.ts, EN/FR/DE i18n; demoBanner.test.ts; d0d511c); pnpm check green after merge |
| P-224 | done | task/P-224 (merge d733e52) | Number pops landing within the coalesce window and radius merge into one tally pop that counts up to the summed credit with rarity colour; arcs kept clear of the plaque label; reduced motion fades in place (coalesce.ts, numberPopLayer.ts, arc.ts, format.ts; new coalesce.test.ts, test/popDom.ts; de6855a); follow-ups in POLISH (rank card placement P-225, plaque coin-slot target, pop overlap e2e P-291); pnpm check green after merge |
| P-225 | done | task/P-225 (merge ad2ce41) | Cascade rank card rests clear of the coin field and the lip: new stampLayout.ts places it between the Vault and the field at 390x844, still lands with its chime and scale-in, reduced motion fades (stampLayout.ts, tierStamp.ts, railLayout.ts, hud.ts, styles.css; new stampLayout.test.ts; 3f09705); pnpm check green after merge |
| P-364 | done | task/P-364 (merge 827b237) | createStage boot steps instrumented and quality benchmark capped at 600 ms so boot to playable fits 3 s (stage.ts, benchmark.ts, adaptiveQuality.ts; new stage.test.ts; 31d034a); pnpm check green after merge |
| P-223 | done | task/P-223 (merge 5c9600b) | Opening heap laid as a jittered, overhanging heap from the seeded PRNG: both sheets grow from the back with seeded stopping points and spacing so the front edge is ragged and front coins overhang the lip, stacks lean forward on the lower tier and nest up to four layers on the upper tier (heap.ts, heap.test.ts; determinism hashes re-pinned in heap, brink, rest and sim tests; f1176fd); follow-ups in POLISH (SIM_VERSION bump + economy ladder, P-242 silver slot IDs); pnpm check green after merge |
| P-98 | blocked(review: venue frame not within 3 s (first venue frame 3.17 s ?webgl, 3.26 s default backend at 390x844); precompile() added to Stage/AdaptiveRendering but never called; first-boot venue stays low detail after the deferred benchmark upgrades the tier) | task/P-98 (a01023c, not merged) | Fix: request main.ts owner to start the venue compile right after createRivieraVenue (stage.precompile(venue.root) in parallel with boot) or drop precompile; raise venue detail on onTierChange or queue it as blocking; re-measure under 3 s on both backends; follow-ups in POLISH (index.html navy background, reveal at first stage frame, venue onTierChange, SwiftShader WebGPU device loss); branch kept |
| P-121 | done | task/P-121 (merge 794c096) | Rapier wasm ships as a separate hashed .wasm asset streamed by the sim worker (instantiateStreaming); sim worker JS under 80 kB gzip (e58665d); follow-ups in POLISH (compression on hosting, shared sideEffects, AdaptiveRendering rAF guard); pnpm check green after merge |
| T-92.05 | done | task/T-92.05 (merge 13cf378) | Net layer: snapshot op, SnapshotCadence (capture copied), keepalive pagehide upload, drain before boot, Demo Mode mock (fix round 57698e2); pnpm check green after merge; boot wiring left to T-92.07 (#92) |
| T-92.06 | done | task/T-92.06 (merge 4bd97bb) | Worker bridge restore init and snapshot (bridge.ts, runtime.ts, protocol.ts, restore.ts, sim-api.ts, tests; 9c5a543); pnpm check green after merge |
| T-92.07-p1 | done | task/T-92.07-p1 (merge c27f83d) | Crate controller adopts stored placements and resumes posed crates (apps/web/src/game/crates/**, 39f71f7) (#176); main.ts wiring queued as P-421 for T-92.07-p2; pnpm check green after merge |
| T-92.07-p2 | done | task/T-92.07-p2 (merge b8f0d7a) | Boot glue re-gated on crate adopt (placements passed to CrateController.adopt, P-421), session retake/capture/overlay/triggers under apps/web/src/game/session/**, retake lease waits for a ready sim (d9f7ce8); pnpm check green after merge |
| T-92.07 | done | task/T-92.07 (fc0bc94) | Parts T-92.07-p1, T-92.07-p2. Parts merged: T-92.07-p1 (merge c27f83d), T-92.07-p2 (merge b8f0d7a) (#92, #176) |
| P-376 | done | 6f34af3 | Fusion VFX toned down for #182; review fixes in task/P-376-fix 7f7c0e1 (full ring ≤ 31 % of portrait width) |
| P-377 | done | 591561a | Audio lifecycle hardened for #184; review fixes in task/P-377-fix a28c6db |
| P-401 | done | 3170dcc | Tier fusion set pieces: full only for first-of-session, first-of-tier and diamond+, mid variant for routine gold/platinum, full cap ~1 per 20 s (#182); pnpm check green after merge |
| P-396 | done | task/P-396 (merge f813ac8) | A held pour is cancelled when the crate cinematic starts: new cinematicPause.ts, gestures/surface cancel hook, core/create/events/overlay wiring (1093df7); pnpm check green after merge |
| P-398 | done | task/P-398 (merge 262005f) | First-upgrade nudge fires only with headroom and folds when unaffordable: upgradeNudge.ts, upgradeNudgeTrigger.ts and tests (7834a34); pnpm check green after merge |
| P-397 | done | task/P-397 (merge 426f29a) | Vault odometer glow unclipped so digits no longer sit in grey boxes: styles.css odometer rules plus odometer.test.ts (79ac3af); pnpm check green after merge |
| P-384 | done | task/P-384 (merge a499843) | Shared contract for ascension state: lifetimeBullion and Family Office levels on VenueState (packages/shared/src/api/state.ts, state.test.ts) (83b4149); part of T-3.04; pnpm check green after merge |
| P-380 | done | task/P-380 (merge c03c6a7) | Server wires Venue Ascension and Family Office into PlayerDO and routes, folding P-378, P-379, P-381, P-382, P-383 (084b6a6); bootCost.test.ts migration lookup edit queued for review as P-413; part of T-3.04; pnpm check green after merge |
| T-1.18-p2 | done | task/T-1.18-p2 (merge 8e55098) | Slice sweep part 2: juice checklist audit per interaction with a guarding test (apps/web/src/vfx/juice.ts, juice.test.ts) (b9b1953); drop, tap/aim and nudge follow-ups queued as P-410..P-412; pnpm check green after merge |
| T-1.18-p1 | done | task/T-1.18-p1 (merge 9a960e5) | Slice sweep part 1: Lighthouse mobile perf gate (>= 80) in apps/web/e2e/lighthouse.perf.ts, `pnpm lighthouse`, perf.yml step, lighthouse 13.6.0 devDependency (d89d0a9). The gate is in place but not yet met: median mobile score 42 to 55 (TBT 6.7 to 28.6 s, LCP 4.3 to 5.0 s); threshold not lowered; follow-ups P-414..P-420; pnpm check green after merge |
| T-1.18-p3 | done | task/T-1.18-p3 (merge 420e35e) | Slice sweep part 3: full-loop Demo e2e with zero console errors (apps/web/e2e/full-loop.spec.ts, fixtures.ts) (325f051); first-buy spendable margin, frame clock-skew cause, Demo bankruptcy and retired upgrade hint queued as P-440..P-443; pnpm check green after merge |
| T-1.18 | done | | Slice sweep, parts T-1.18-p1, T-1.18-p2, T-1.18-p3. Parts merged: T-1.18-p2 (merge 8e55098), T-1.18-p1 (merge 9a960e5), T-1.18-p3 (merge 420e35e). Lighthouse gate (>= 80) still unmet, see P-415 |
| P-373 | done | task/P-373 (merge e20ddf2) | Spark streak length clamped to 6x size and 38 css px of screen so sparks no longer draw as screen-long needles (apps/web/src/vfx/particles/material.ts, material.test.ts) (1272326); pnpm check green after merge |
| P-375 | done | task/P-375 (merge 501e792) | Slow fusion under a sustained pour (stream allowance, SIM_VERSION 9) landed with the economy ladder rerun on SIM_VERSION 9 (folds P-402): envelope fusions 119, fallValue 853, falls 295, crates 27; fusionShare 0.778; '@coinposh/economy/sim' subpath (cb10bdb); pnpm check green after merge; follow-ups P-403, P-404, P-430..P-432 |
| P-385 | done | task/P-385 (merge 205de2f) | Ascension door mounted and table re-laid from an owned relay (apps/web/src/game/ascension/entry.ts, hud.ts, relay.ts with unit tests; failed relay falls back so Demo stays playable) (1d2615c); part of T-3.04; pnpm check green after merge |
| P-450 | done | task/P-450 (merge bdfd282) | COLLECT rolls the Vault by exactly the card's coin line, held falls land after: crate-payout ordering in main.ts with apps/web/e2e/collect-payout.spec.ts; follow-ups P-460..P-462; pnpm check green after merge |
| P-444 | done | task/P-444 (merge 00b34c7) | Family Office section dropped from the upgrades sheet; upgrade nudge and HUD badge count only sheet lines, with panel, nudge and hud tests; re-gated after review; pnpm check green after merge |
| P-440 | done | task/P-440 (merge e45b987) | Upgrades and the nudge follow spendable coins, not the drop buffer (#94; folds P-469, P-470, P-471, P-472, P-473, P-506) (628bd8f); pnpm check green after merge; styles.css follow-up queued as P-524 |
| P-517 | done | task/P-517 (merge 7c2a70b) | Ascension screen readability: Family Office effect copy, focus return, locked hold control (folds P-518, P-519) (bde4395); pnpm check green after merge; icon and upgradesPanel follow-ups queued as P-530, P-531 |
| P-436 | blocked(review: target unmet, 0 of 20 runs reach first credit by drop 8 with Vault >= 8; bound never asserted in ftue.test.ts; no 4 taps/s runs) | task/P-436 (f1042a2, not merged) | Fix: lead/founder design call (shorter PUSHER.periodTicks, guided first drop, pay on contact, or retarget), then assert the bound or pin today's ceilings, and add 4 taps/s rows to ftue.report.ts, ftue.test.ts and 02-ECONOMY; follow-ups in POLISH; branch kept |
| P-438 | blocked(review: not started, P-436 was not merged) | | Gate on time (credit within 8 s of the first tap) until the P-436 design call lands |
| P-449 | done | task/P-449 (merge 071833f) | Demo progress survives a same-tab reload: mock world (balance, ledger, crates, sim snapshot) kept in sessionStorage via net/mock/persist.ts, new tab or context starts fresh; demo-reload e2e, full-loop expects Lv 1 after reload, crates repeat roll clears the persisted world; lead decision recorded: a same-tab reload keeps Demo progress, closing the tab resets it (01-ARCHITECTURE updated); closes P-478, P-479, P-480, P-481; pnpm check green after merge |
| P-435 | blocked(review: not delivered, readable coin rim needs a 0.67 scene-scale floor that worsens frames.perf median 283 -> 417 ms; lead/art decision) | | Uncommitted patch (materials emboss fade + specular AA, low-tier FXAA at scene resolution, 0.67 floor, ?scale= hook) kept outside the repo; decision queued in POLISH |
| T-92.08 | done | task/T-92.08 (merge b74b73a) | Session lease on every table op: PlayerDO/routes/table.ts check the lease, stale sessions get session_superseded (05b7edf); server tests updated to send the lease; pnpm check green after merge; land T-92.05 before deploy (#85) |
| T-92.09 | blocked(review: not delivered; validateSnapshot rejects coins resting on the front lip, so Demo re-boot refunds them) | task/T-92.09 (not merged) | P-575 landed but refunds remain: LIMIT_Z_MAX (packages/sim/src/snapshot/validate.ts:75) drops lip coins from settle uploads; waits on the physics-engineer fix (P-624), then qa-perf retry (P-626); branch kept |
| T-92.10 | done | task/T-92.10 (merge 82654b5) | Crate ride snapshot and restore on CRATE_RIDE bounds (ride.ts, view.ts, crates.test.ts; daf58bf); pnpm check green after merge |
| T-2.01-p1 | done | task/T-2.01-p1 (merge d42cf4e) | Safes numbers and catalog in packages/economy (config/safes.ts, drops.ts, validate.ts, 02-ECONOMY.md) (d1abbdd); pnpm check green after merge |
| T-2.01-p2 | done | task/T-2.01-p2 (merge f39f252) | Server: safes route, storage, timers, key spend, pity (b1d7f20); pnpm check green after merge |
| T-2.01 | done | | Waits on T-1.18. Key-locked Safes (server + client + cinematic). Parts T-2.01-p1, T-2.01-p2, T-2.01-p3. Parts merged: T-2.01-p1 (merge d42cf4e), T-2.01-p2 (merge f39f252), T-2.01-p3 (merge eaac8b0) |
| T-2.02-p1 | done | task/T-2.02-p1 (merge 6faa121) | Scratch Cards server part: reveal route (apps/server/src/routes/scratch.ts), card storage in PlayerDO schema/entities and ledger grants (841029d); follow-ups P-587, P-588; pnpm check green after merge |
| T-2.02-p2 | done | task/T-2.02-p2 (merge 8731f9c) | Scratch Cards client part: game/scratch controller, mount and session; vfx/scratch card, GPU scratch mask, foil flakes and 3-match reveal (4c0dedb); follow-ups P-595..P-601; pnpm check green after merge |
| T-2.02 | done | parts merged: T-2.02-p1 (6faa121), T-2.02-p2 (8731f9c) | Scratch Cards (GPU scratch mask); all parts merged |
| T-2.03-p1 | done | task/T-2.03-p1 (merge 5228103) | Gacha Capsule Machine scene: procedural 3D machine, crank, chute and capsule pop in apps/web/src/scene/gacha/** (0e711fe); pnpm check green after merge |
| T-2.03 | done | | Gacha Capsule Machine, parts T-2.03-p1. Parts merged: T-2.03-p1 (merge 5228103) |
| T-2.04 | done | task/T-2.04 (merge d411f01) | Odds & "Certified Fair" UI (apps/web/src/ui/fair, EN/FR/DE fair.json). Fix round (c196d1f): Web Crypto failure shows a distinct verify "unavailable" state with a throwing crypto.subtle test; odds row/total aria labels interpolated via i18next; main.ts mount and pity log stay queued in POLISH; pnpm check green after merge |
| T-2.05 | done | task/T-2.05 (merge c45f2f6) | Inventory & item cards: apps/web/src/ui/inventory/** (rarity-framed 3D cards, sort/filter, duplicate level-up view) (d41904f); shared contract, fuse route, duplicatesPerLevel and main.ts mount queued as P-455..P-458, WebGPU card art check as P-459 (H); pnpm check green after merge |
| T-3.01-p1 | done | task/T-3.01-p1 (merge 68994d5) | Charm catalog: shared CharmKind, economy charm numbers and drop-id mapping, folds P-565, P-571 (c511c44); follow-ups P-589 to P-592; pnpm check green after merge |
| T-3.01 | done (parts merged: T-3.01-p1 (68994d5)) | | Charm Board (sockets, 6 charms, synergy tags) |
| T-3.02 | done | task/T-3.02 (merge 233d0cb) | Charm models & effects: procedural models, idle loops and activation FX in apps/web/src/scene/charms with unit tests and a preview page; review round (04ae66b); CharmKind-to-shared and real-GPU shader check queued as P-565/P-566; pnpm check green after merge |
| T-3.03-p2 | done | task/T-3.03-p2 (merge 2205228) | Collection Album client: album sheet, set progress, Heirloom lore cards, completion fanfare in apps/web/src/ui/album/** (fff3d92); main.ts mount queued as P-633; pnpm check green after merge |
| T-3.03-p1 | blocked(review: not delivered; album card grant needs a server crates/open route, a ledger collectible unit and a lead decision on where the card is returned) | | Nothing committed; re-run after the crates-route (P-645), ledger (P-646) and grant-point decision (P-647) land; follow-ups P-648 |
| T-3.03 | in progress (parts merged: T-3.03-p2) | | Waits on T-2.05. Collection Album + Heirloom coins. Parts T-3.03-p1, T-3.03-p2. Parts merged: T-3.03-p2 (merge 2205228); parts pending: T-3.03-p1 |
| T-3.04 | done | task/T-3.04 (merge 33f6a67) | Venue Ascension (prestige) + Family Office: server-validated reset route and Gold Bars/Family Office logic (apps/server/src/routes/ascend.ts), ascension screen (apps/web/src/game/ascension) and 3 s ascend cinematic (apps/web/src/vfx/cinematics/ascend) (fa08c97); wiring follow-ups P-378..P-387 in POLISH; pnpm check green after merge; parts merged: P-384 (a499843), P-380 (c03c6a7), P-385 (205de2f) |
| T-3.05-p1 | done | task/T-3.05-p1 (merge 1865458) | Quest, streak and season numbers in packages/economy (config/quests.ts, config/season.ts, 02-ECONOMY.md) (b226137); pnpm check green after merge |
| T-3.05-p2 | blocked(review: not delivered, needs quest/streak/season TxKinds in ledger.ts and design calls on tier claims, scratch-card rewards and Season Stars) | | Nothing committed; server design ready once POLISH ledger and design items land |
| T-3.05-p3 | blocked(review: not delivered, Demo quest claim cannot credit the ledger without a public MockWorld grant hook; quest book persistence needs a lead call) | | Nothing committed; re-run after the world.ts grant method and persistence option land (POLISH) |
| T-3.05 | in progress (parts merged: T-3.05-p1) | | Waits on T-2.05. Quests, streaks, Season Pass (free track; premium behind flag). Parts T-3.05-p1, T-3.05-p2, T-3.05-p3. Parts merged: T-3.05-p1 (merge 1865458); parts pending: T-3.05-p2, T-3.05-p3 |
| T-3.06 | todo | | Waits on T-3.01. Soirée Nights run mode |
| T-3.07 | todo | | Waits on T-3.04, T-3.05. Meta balancing |
| T-10.01 | done | task/T-10.01 (merge 75e63f3) | Account link contracts: packages/shared/src/api/account.ts, accountEndpoints in endpoints.ts, new error codes (e91c834); wiring into `endpoints`, fixtures and Demo mock queued as P-281 for T-10.03; pnpm check green after merge |
| T-10.02 | done | task/T-10.02 (merge 695d63b) | Server: verify ID tokens, link, sign in on a new device (19c8550, POLISH.md hunk dropped after review); follow-ups P-304..P-306; P-292..P-294 already queued in POLISH.md; pnpm check green after merge |
| T-10.03 | done | task/T-10.03 (merge 0f944de) | Net layer + Demo mock for account link (d1fad06): account chunks gated on tap within the lazy JS budget, burnedKeys bounded with a test; P-281 remainder (packages/shared fixtures, endpoints spread and endpoints.test list) stays open as P-484 / P-495; pnpm check green after merge |
| T-10.04 | done | task/T-10.04 (merge 43bb4cb) | Account UI: link, sign in, progress choice; fix round adds ui/account/clock.test.ts, trimmed surface chunk, opaque choice sheet; folds P-577, P-578; pnpm check green after merge |
| H-10.01 | todo | | Human step: Google Cloud OAuth web client (origins `https://sashimee.github.io`, `https://devcoinposh.bas.lu`, localhost) → Worker secret `GOOGLE_CLIENT_ID`, repo variable `VITE_GOOGLE_CLIENT_ID` |
| H-10.02 | todo | | Human step: Apple Developer membership (same account as H-7.01, pulled forward), Services ID and Sign in with Apple key → Worker secrets `APPLE_SERVICES_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, repo variable `VITE_APPLE_SERVICES_ID` |
| T-11.01 | todo | | Waits on T-92.07, T-92.08, T-10.02, T-10.03. Feature-module seams |
| T-11.02 | done | task/T-11.02 (merge 83cde70) | Sim prop seam: packages/sim/src/props (kinds, params, shape, world), sim and snapshot wiring (462f248); follow-ups P-605..P-608; pnpm check green after merge |
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
| T-17.02 | done | task/T-17.02 (merge 0714e82) | Adaptive music: stem scheduler, tempo, jackpot sting and player under apps/web/src/audio/music/adaptive (a3b196a); pnpm check green after merge; engine.ts wiring queued as P-670 |
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
| P-213 | done | task/P-213 (merge 1240142) | Boot poster re-rendered from the live table by the committed apps/web/scripts/capture-poster.ts, held until the heap is on the table, with apps/web/e2e/poster.spec.ts and hud tests (folds P-521) (4171ea1); pnpm check green after merge; follow-ups queued as P-541..P-543 |
| T-2.01-p3 | done | task/T-2.01-p3 (merge eaac8b0) | Client safes panel, controller and dial/door cinematic; fix round keeps focus across countdown ticks (503cf23); main.ts/HUD/pity wiring queued as P-544..P-547; pnpm check green after merge |
| P-465 | done | task/P-465 (merge 09eb259) | Demo-only window.__coinposh.demo test handle, fix round (cd4131f): live-mode null test restored; unblocks T-92.09; pnpm check green after merge |
| P-510 | done | task/P-510 (merge 5acaaeb) | Crate HUD hold kept while the director holds the unbox behind a sheet; fix round (fca3729) folds P-511, P-549 with a deterministic front-fall assertion; pnpm check green after merge |
| P-535 | done | task/P-535 (merge 33ea92c) | A closing sheet goes inert and hands focus back at once so it cannot spend coins (folds P-537 case a), with apps/web/e2e/sheet-close-safety.spec.ts and sheetFocus tests (50a69b8); pnpm check green after merge |
| P-544 | done | task/P-544 (merge bf9df59) | Safes sheet mounted with a HUD trigger, ready badge and server wallet sync (folds P-545, P-546), with apps/web/e2e/safes.spec.ts and hud tests; review round (852be7a); pnpm check green after merge |
| P-536 | done | task/P-536 (merge f378559) | Vault plaque shows spendable coins only; drop buffer as a separate 'in hand' readout, with apps/web/e2e/plaque-honesty.spec.ts (folds P-573, P-574) (6afeada); pnpm check green after merge; follow-ups P-609 to P-613 |
| P-575 | done | task/P-575 (merge c8497a7) | core.ts fuse() holds fusions whose inputs are not yet bound and claims them once their mints land, pairing undrawn coins by sim id (248c132); unblocks T-92.09; follow-ups P-593, P-594; pnpm check green after merge |
| P-580 | done | task/P-580 (merge 77fdae2) | VFX pipelines warmed before playable and after tier/renderer changes, with apps/web/e2e/shader-warmup.spec.ts and stage tests; review round (30e6978); pnpm check green after merge |
| P-557 | blocked(review: not delivered; crate album cards cannot be listed in the Inventory from the owns paths, needs a design decision) | (nothing committed) | Waits on the Inventory-vs-Album decision (P-620) and either the inventory owner (P-621) or shared/server (P-622); bundle rows P-623 |
| P-624 | done | task/P-624 (merge c7a19b9) | validateSnapshot accepts coins resting on the front lip (z up to fieldFrontZ + COIN.radius), with validate.test and restore.test lip cases (e2abe2d); unblocks P-626 / T-92.09 retry; follow-up P-632; pnpm check green after merge |
| P-497 | done | task/P-497 (merge 8972529) | Server ledger TxKinds quest.claim, streak.milestone, season.tier, season.rollover in TX_KINDS, each asserted in ledger.test.ts (67355dd); typecheck + lint green, ledger.test 16/16; pnpm check red only on the snapshot.test.ts:446 step-6 case, which already fails before the merge on 1c72c70 (P-624 bound change, fix queued as P-632/P-634) |
| P-617 | done | task/P-617 (merge 02a492a) | Starting bankroll 36 (bootBankroll: 20 spendable + 16 drop buffer) so the boot plaque shows at least 20; pusherSpeed/dropRate base costs 37/38 keep the P-193 guard; config.test and allowance.test assert both, balance report P-617-starting-bankroll.txt and rate envelope refreshed (3cf8519); economy 448/448, typecheck + lint green; pnpm check red only on the pre-existing snapshot.test.ts:446 step-6 case (P-634), which also fails with P-617's economy changes reverted |
| P-614 | done | task/P-614 (merge c317eea) | Crate payout handover: balance plaque holds the win through the reveal and the bankrupt notice stays down while a reveal is paying, with hud/balancePlaque tests and apps/web/e2e/collect-payout.spec.ts cases (a040e57); web typecheck + lint + unit green; pnpm check red only on the pre-existing snapshot.test.ts:446 step-6 case (P-634), merge touches no server or package code |
| P-616 | done | b9c49e1 (lead salvage: demoHandle refund test now uploads an empty settled snapshot first) |
| P-507 | done | task/P-507 (merge ee21b91) | Public MockWorld.grant routes Demo feature rewards through the single ledger (world.ts, server.test.ts; 597b805); pnpm check green after merge |
| P-627 | blocked(review: P-628 playable <= venue + 300 ms not met, budget floored at 1,800 ms; warm frame after playable stalls the first tap) | task/P-627 (11a7c6c, not merged) | Split the vfx warmup across idle frames and budget longestFrameAfterTapMs; venue shader linking off the critical path (P-652); perf summary row (P-653); BOOT_TO_FIRST_DROP_MS must not be loosened; branch kept |
| P-626 | blocked(review: e2e not green; demo-reload still refunds unposed coins 1 of 4, table-persistence re-boot cases race the resumed sim) | task/P-626 (3602038, not merged) | Waits on the upload-after-settle/pagehide snapshot fix (P-654), reboot pause (P-656), crate ride on sim time (P-655), fused body cleanup (P-657); fix the seq-0 read and play-on ledger check in table-persistence.spec.ts on retry; first-tap profile P-658; branch kept |
| P-645 | done | task/P-645 (merge 391dd67) | Server POST /v1/crates/open with crate.open ledger kind, collectible unit for the album card and append-only crate_opens table (folds P-646, P-433, P-533; P-647 decision: card ledgered inside crate.open) (dbe4a06); pnpm check green after merge; follow-ups P-664..P-666 |
| P-639 | done | task/P-639 (merge 01bddb2) | Honest front-edge falls are no longer refused as over_envelope by the Demo mock (world.ts), with core.test, mock server.test and apps/web/e2e/honest-falls.spec.ts cases (35616ad); folds P-657 (refused fusion claim removes the fused body from the sim); pnpm check green after merge; follow-ups P-667, P-668 |
| P-655 | done | task/P-655 (merge 59974b0) | Crate ride advances on sim ticks, so a held sim holds its crates and their poses are no longer refused as teleports (controller.ts, ride.ts, crates.test.ts; 9031c25); pnpm check green after merge; follow-up P-669 |
| P-660 | done | task/P-660 (merge e3baefd) | Table crate shader pipelines warmed before the first crate spawns: hidden crate (body, band, glow, ring, spark) compiled in the post-boot warm-up (crates/warmup.ts, view.ts, mount.ts and tests; c6234a3); pnpm check green after merge; follow-up P-673 |

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
- wave 21 · 2026-11-12 · P-258 P-317 P-308 P-290 T-92.04 · merged P-290 (fd1c81d), T-92.04 (1a41f90), P-258 (83429ae), P-317 (a1b8e8e); 1 rejected (P-308)
- wave 22 · 2026-11-12 · P-308 P-318 P-329 P-332 P-333 · merged P-318 (b2117b9), P-308 (1a0bd3f), P-332 (4816a52); 2 rejected (P-329, P-333)
- wave 23 · 2026-11-12 · P-329 P-333 P-338 P-337 P-335 · merged P-337 (b0a5f63), P-335 (d51d679), P-338 (cf1de84), P-333 (8c90ad9), P-329 (7d36d37); 0 rejected
- wave 24 · 2026-11-12 · P-341 P-328 P-331 · merged P-331 (6b27852), P-328 (ea900b2); 1 rejected (P-341)
- wave 25 · 2026-11-12 · P-341 P-343 P-339 P-346 · merged P-341 (bd470d7), P-339 (12581c4); 2 rejected (P-343, P-346)
- wave 26 · 2026-11-12 · P-345 P-343 P-348 P-350 · merged P-345 (bb2d650), P-343 (480fe05), P-348 (577c6ea), P-350 (36062bc); 0 rejected
- wave 27 · 2026-11-13 · T-1.17 T-92.05 T-92.06 T-92.10 T-92.08 · merged T-92.10 (82654b5), T-92.06 (4bd97bb), T-92.08 (b74b73a); 2 rejected (T-1.17, T-92.05)
- wave 28 · 2026-11-13 · P-121 P-98 T-92.05 P-358 P-359 · merged P-121 (794c096), T-92.05 (13cf378), P-358 (c5b505a), P-359 (ff1e439); 1 rejected (P-98)
- wave 29 · 2026-11-13 · P-364 T-92.07 P-352 P-362 P-365 · merged P-364 (827b237), P-352 (d99e2ce), P-362 (94f7fef), P-365 (e027599); 1 rejected (T-92.07)
- wave 30 · 2026-11-13 · T-1.17 P-155 P-225 P-223 P-224 · merged P-155 (6751fa6), P-224 (d733e52), P-225 (ad2ce41), T-1.17 (02b27de), P-223 (5c9600b); 0 rejected
- wave 31 · 2026-11-13 · T-3.04 P-181 P-376 P-377 · merged T-3.04 (33f6a67), P-181 (be2ae13); 2 rejected (P-376, P-377)
- wave 32 · 2026-11-13 · P-375 P-396 P-401 P-397 P-398 · merged P-401 (3170dcc), P-396 (f813ac8), P-398 (262005f), P-397 (426f29a); 1 rejected (P-375)
- wave 33 · 2026-11-13 · P-384 T-1.18-p2 P-380 T-1.18-p1 P-373 T-92.07-p1 P-385 P-375 T-92.07-p2 T-1.18-p3 · merged P-384 (a499843), T-1.18-p2 (8e55098), P-380 (c03c6a7), T-1.18-p1 (9a960e5), P-373 (e20ddf2), T-92.07-p1 (c27f83d), P-375 (501e792), T-92.07-p2 (b8f0d7a), T-1.18-p3 (420e35e); 1 rejected (P-385)
- wave 34 · 2026-11-13 · P-444 P-385 T-92.09 P-440 P-436 P-438 T-2.05 P-450 P-449 T-10.03 · merged T-2.05 (c45f2f6), P-450 (bdfd282); 8 rejected (P-444, P-385, T-92.09, P-440, P-436, P-438, P-449, T-10.03)
- wave 35 · 2026-11-13 · P-444 T-3.05-p1 T-3.05-p2 T-2.04 P-435 P-449 P-440 T-3.05-p3 P-385 T-10.03 · merged P-444 (00b34c7), T-3.05-p1 (1865458), P-449 (071833f), P-385 (205de2f), T-10.03 (0f944de); 5 rejected (T-3.05-p2, T-2.04, P-435, P-440, T-3.05-p3)
- wave 36 · 2026-11-14 · T-2.04 P-440 T-2.01-p1 P-517 T-2.01-p2 T-2.01-p3 P-465 T-92.09 P-510 P-213 · merged T-2.04 (d411f01), P-440 (e45b987), T-2.01-p1 (d42cf4e), P-517 (7c2a70b), T-2.01-p2 (f39f252), P-213 (1240142); 4 rejected (T-2.01-p3, P-465, T-92.09, P-510)
- wave 37 · 2026-11-14 · P-536 P-465 T-2.01-p3 P-510 T-92.09 P-535 P-544 T-3.02 T-2.03-p1 T-10.04 · merged P-465 (09eb259), T-2.01-p3 (eaac8b0), P-510 (5acaaeb), P-535 (33ea92c), P-544 (bf9df59), T-3.02 (233d0cb), T-2.03-p1 (5228103); 3 rejected (P-536, T-92.09, T-10.04)
- wave 38 · 2026-11-14 · P-557 T-2.02-p1 T-3.01-p1 P-575 T-2.02-p2 T-11.02 P-536 T-92.09 P-580 T-10.04 · merged T-2.02-p1 (6faa121), T-3.01-p1 (68994d5), P-575 (c8497a7), T-2.02-p2 (8731f9c), T-11.02 (83cde70), P-536 (f378559), P-580 (77fdae2), T-10.04 (43bb4cb); 2 rejected (P-557, T-92.09)
- wave 39 · 2026-11-14 · T-3.03-p1 P-624 T-3.03-p2 P-497 P-617 P-616 P-507 P-614 P-627 P-626 · merged P-624 (c7a19b9), T-3.03-p2 (2205228), P-497 (8972529), P-617 (02a492a), P-614 (c317eea); 5 rejected (T-3.03-p1, P-616, P-507, P-627, P-626)
