# RESUME

Working state for the CoinPosh build loop. Committed with the work so a new machine or a fresh clone gets it.
Treat it as a claim: reconcile with `git log --oneline -10`, `git status`, `gh pr list` and `docs/plan/STATUS.md` before trusting it.

## Goal
Ship the CoinPosh roadmap (`docs/plan/04-ROADMAP.md`) wave by wave with the saved workflow
`.claude/workflows/execute-wave.js` (3 parallel slots since 2026-11-15, review-gated, integrated, playtested, shipped to `dev`).

## Status
- Build loop **resumed** by the founder on 2026-11-15 on `alex-dev`: wave 45 running from `feat/build-loop` with **3 parallel slots** (`maxTasks: 3`, founder's new default), playtest on.
- 2026-11-15: new machine `alex-dev` set up: Node 24.20.0 in `/usr/local`, pnpm 12.4.2 via corepack, deps installed, Playwright 1.65.1 Chromium installed; `pnpm check` green (15/15 tasks, 232 sim tests) and `pnpm --filter web build` passes.
- Next: let wave 45 finish, ship each approved task to `dev`, then launch the next wave with
  `Workflow({scriptPath: ".claude/workflows/execute-wave.js", args: {maxTasks: 3, playtest: true}})` from the repo root.
  After a usage limit resume with `resumeFromRunId`, never relaunch. Full procedure: `docs/plan/HANDOFF.md`.

## State
- Working branch for the loop: `feat/build-loop` (from `dev`). Flow: `task/<id>` → `feat/build-loop` → `ship/<name>` PR into `dev` (merge it) → `main` only for a release candidate the founder validated.
- `dev` head: dbfeb2a (merge of PR #224, `ship/wave-44`). `feat/build-loop` is at 26916b6, 15 commits behind `dev`, nothing unmerged.
- Open PRs: none. Last shipped wave: 44 (stopped early). Wave 45 workflow run id: `wf_a5ccfffc-cf5` (started 2026-11-15, resume with `resumeFromRunId`).
- Dev deploy: https://devcoinposh.bas.lu (API https://api.devcoinposh.bas.lu), Dokploy auto-deploys `dev` on push. `main` is not deployed.
- Dashboard: https://claude.ai/artifact/13mygXtRWZsppKUrsHx5BA. Refresh with `python3 tools/dashboard/gen.py <repo> <out_dir> <phase> "<detail>"`, then upload the 6 JSON files as assets and repoint `datasets/<name>` (steps in `docs/plan/HANDOFF.md`).

## Blockers
- Wave 44 leftovers awaiting their review gate: `wip/T-13.09` (rejected: boss stand spot ignores aspect), `wip/P-764`, `wip/P-769`, `wip/T-12.12`, `wip/P-766`, `wip/T-11.07-review`. Not started: P-745, P-756. Lost builds: P-767, P-755.
- Known CI reds, not regressions: #186, #195, #201, #208, #209, #211, #212, #213, #216.
- Open founder questions: P-498, P-499, P-500, P-435, P-436/P-438, P-477, P-520, P-551, #184, P-620/P-557, P-642, P-647/P-676. Human-only: H-10.01, H-10.02, H-7.01.
- Rotate the Turnstile secret in Dokploy (it was pasted in a chat once).

## Files
- `docs/plan/STATUS.md`: task states and the per-wave log (integrator edits only).
- `docs/plan/HANDOFF.md`: pause handoff, resume procedure, dashboard refresh steps.
- `docs/plan/POLISH.md`: P-<n> backlog.
- `.claude/workflows/execute-wave.js`: the wave workflow.
- `tools/dashboard/gen.py`, `tools/dashboard/state.json`: dashboard datasets.

## Done log
- 2026-11-15 · machine `alex-dev` provisioned, `pnpm check` green, RESUME.md un-ignored and committed.
- 2026-11-15 · wave 44 stopped early, handoff written (26916b6), PR #224 merged into `dev`.
- 2026-11-15 · wave 43 shipped (13 merged).
- 2026-11-15 · wave 42 shipped (17 merged).
