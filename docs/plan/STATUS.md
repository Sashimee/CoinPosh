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
| P-174 | blocked(review: POLISH.md hunk outside owns with follow-up IDs P-178..P-180 colliding with feat/build-loop; openingHeapCoins = 100 is an economy number outside packages/economy) | task/P-174 (802d971, not merged) | Vault/feedback gate across P-136, P-149/P-169, P-137; follow-ups filed as P-190..P-198 |
| P-201 | done | task/P-201 (merge dba5125) | Boot poster behind the canvas until the first lit frame instead of a black void; side meters hidden until playable (9d562eb); pnpm check green after merge |
| P-193 | done | task/P-193 (merge ab0178d) | Opening heap owned by @coinposh/economy as `openingHeap { coins, tier }` (silver) and modelled in the pacing sim (8ff5245); rate-envelope.json regenerated (outside owns, follow-up P-203); follow-ups P-203..P-206; pnpm check green after merge |

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
