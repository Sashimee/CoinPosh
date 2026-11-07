# CoinPosh: instructions for Claude agents

CoinPosh is a luxe, server-authoritative 3D coin pusher (web on GitHub Pages first,
then iOS/Android via Capacitor). The plan lives in `docs/plan/`:

- `00-VISION.md`: game design and locked founder decisions (don't re-litigate them)
- `01-ARCHITECTURE.md`: stack, repo layout, file ownership, anti-cheat layers
- `02-ECONOMY.md`: currencies, formulas, odds, pacing targets
- `03-ART-AUDIO-JUICE.md`: palettes, materials, animations, juice checklist, audio
- `04-ROADMAP.md`: task backlog (IDs, agents, deps, owns, acceptance)
- `05-MOBILE-MONETIZATION.md`: store path, monetization (flags off)
- `STATUS.md`: task state (only the integrator / lead-architect edits it)
- `POLISH.md`: playtest and out-of-scope items queued for future waves

## Non-negotiables
1. **The server owns value.** The client never sends coin values, rewards, balances or
   timestamps the server trusts. All randomness for rewards is server-side, provably fair.
2. **`packages/sim` is deterministic**: fixed step, seeded PRNG, no `Math.random`, `Date`
   or `performance.now`. Every mechanic ships with a determinism hash test.
3. **Ownership.** Only write inside your task's `owns` paths. Shared types go in
   `packages/shared`, numbers in `packages/economy`.
4. **Quality bar.** 60 fps on mid phones, juice checklist ≥ 4 per interaction, all strings
   through i18next (EN/FR/DE), reduced-motion variants, and no console errors.
5. Never skip, disable or weaken tests to get green. Never commit secrets.
6. Monetization code stays behind `flags.monetization = false`.
7. Demo Mode (no `VITE_API_URL`) must always work so the game is playable on Pages.

## Execution protocol
Work proceeds in **waves** via the saved workflow `.claude/workflows/execute-wave.js`:
plan → build each task in its own worktree on branch `task/<id>` → reviewer gate
(≤ 2 fix rounds) → integrate into the session branch → playtest → push. Human-only
steps (`H-*`) are reported, never attempted.

## Commands (after T-0.01)
`pnpm i` · `pnpm dev` · `pnpm check` (typecheck + lint + unit) · `pnpm e2e` · `pnpm build`
