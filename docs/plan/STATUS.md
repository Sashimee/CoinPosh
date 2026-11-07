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
| T-1.09 | blocked(review: mock crate claim accepts a tick before the crate spawned; server rejects with not_on_table) | task/T-1.09 (753b550) | Add spawnTick to CrateRecord (world.ts:119), set it in tableDrop (:707), reject claim.tick < spawnTick with not_on_table in #claim (:1075), add mock/server.test.ts case; rules.ts economy numbers tracked in #15/#9 (P-51); next wave starts from task/T-1.09 |
| T-1.11 | done | task/T-1.11 (merge 6ca56a6) | HUD + core UI shell (47ea8b3); mounting in main.ts queued as P-53; pnpm check green after merge |
| P-3 | done | task/P-3 (merge 6355ddd) | STACK.lock.md catch-up, folds P-4, P-5, P-6; pnpm check green after merge |
| P-15 | done | task/P-15 (merge 2a75cd7) | Riviera venue and audio engine wired into boot, folds P-23; pnpm check green after merge |
| T-1.08 | blocked(review: envelope_flags grows unbounded; clamped clock freezes window after forward skew; rateEnvelope not in economy config) | task/T-1.08-fix2 (e564e27) | Coalesce flags per (metric, window), stamp events with real now; needs economy rateEnvelope (T-1.16 dep); next wave starts from task/T-1.08-fix2 |
| P-8 | done | task/P-8 (merge f2df5e8) | Fixed Claude/noreply@anthropic.com worktree identity (2b04d41); pnpm check green after merge |
| P-31 | done | task/P-31 (merge 147180a) | CI turbo cache, dedupe PR/push runs, deploy CI build, Worker secrets; folds P-29; pnpm check green after merge |
| P-9 | done | task/P-9 (merge ee90f19) | Fast deterministic economy sim tests (fixes main CI timeout), shared ID unions, key regex; pnpm check green after merge |
| P-27 | done | task/P-27 (merge a75de20) | Web i18next/shared/economy/zod deps, sim eslint devDep, STACK.lock catch-up; folds P-7, P-30; pnpm check green after merge |
| T-1.12 | done | task/T-1.12 (merge 957db3e) | VFX: drop, fusion, cascade, number pops (51e8a1a); wiring queued as P-56/P-57; pnpm check green after merge |
| P-45 | done | task/P-45 (merge 8c9e23a) | Economy rateEnvelope config and rateEnvelopeFor (33afa8a); unblocks T-1.08; pnpm check green after merge |
| P-10 | done | task/P-10 (merge af272d4) | Shared ID unions, venue list, loot sources, catalog key, fair digest (14b256f); folds P-35, P-36, P-37 (shared side), P-48; pnpm check green after merge |
| P-22 | done | task/P-22 (merge a8accf0) | Stage wiring: adaptive rendering, CoinField, render look (29b99e0); pnpm check green after merge |

Tasks not listed yet are `todo`. The integrator appends rows as tasks start.

## Wave log
<!-- integrator appends: wave N · date · tasks · result -->
- wave 1 · 2026-11-07 · T-0.01 · merged T-0.01 (37fcbe6); 0 rejected
- wave 2 · 2026-11-07 · T-0.02, T-0.03, T-0.04, T-0.05, T-1.04, T-1.13, T-1.05, T-1.06 · merged T-0.02 (b54be8a), T-0.03 (ff12826), T-0.04 (cac1c89), T-0.05 (27dc17b), T-1.04 (3cacebe), T-1.13 (4619d21); 2 rejected (T-1.05, T-1.06)
- wave 3 · 2026-11-07 · T-1.07 P-15 P-3 · merged T-1.07 (84da688), P-15 (2a75cd7), P-3 (6355ddd); 5 rejected (T-1.01, T-1.05, T-1.06, T-1.09, T-1.11)
- wave 4 · 2026-11-07 · P-31 P-9 P-27 T-1.05 T-1.06 T-1.01 T-1.08 P-8 · merged P-31 (147180a), P-9 (ee90f19), P-27 (a75de20), T-1.05 (e378fd5), T-1.06 (b7c0443); 3 rejected (T-1.01, T-1.08, P-8)
- wave 5 · 2026-11-07 · T-1.01 T-1.11 T-1.12 P-45 P-10 P-22 P-8 T-1.09 · merged T-1.01 (34a5f79), T-1.11 (6ca56a6), T-1.12 (957db3e), P-45 (8c9e23a), P-10 (af272d4), P-22 (a8accf0), P-8 (f2df5e8); 1 rejected (T-1.09)
