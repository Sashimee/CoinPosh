# Handoff: build loop paused (2026-11-15)

The founder paused the build loop on 2026-11-15 before moving to a new machine.
Do not launch a new wave until the founder says to resume.

## State
- Working branch: `feat/build-loop` (from `dev`). Branch flow: `task/<id>` → `feat/build-loop` → PR into `dev` → `main` only for a release candidate the founder validated.
- Dev: https://devcoinposh.bas.lu, API https://api.devcoinposh.bas.lu (Dokploy, project Bas.lu/production, auto-deploys `dev` on push). Prod (`main`) is not deployed.
- Secrets live only in Dokploy env (names: STACK, WEB_HOST, API_HOST, VITE_TURNSTILE_SITE_KEY, AUTH_SECRET, TURNSTILE_SECRET_KEY). Rotate the Turnstile secret: it was pasted in a chat once.
- Last waves: see the `- wave 42/43/44` lines at the bottom of `STATUS.md`.

## Unfinished work (wave 44, stopped early)
Pushed as `wip/*` branches, committed without hooks. Each still needs its review gate before it merges:
- `wip/T-13.09`: boss presence. Review rejected it because the boss always stands on one fixed spot, whatever the screen shape (`scene/boss/layout.ts:12-27`).
- `wip/P-764`: Cascade caption fit for the rank-up swell.
- `wip/P-769`: portrait camera pulls the table down to the dock (riviera layout).
- `wip/T-12.12`: standing sounds (`audio/standing/**`).
- `wip/P-766`: crate unbox opens on the in-tray crate (unbox test edits).
- `wip/T-11.07-review`: follow-up on the merged T-11.07 (badges.ts review note).

Not started: P-745, P-756. Builds lost when the wave stopped: P-767, P-755.

## Resume the loop
1. Read `STATUS.md` and `POLISH.md`, then reconcile with `git log --oneline -10` and `gh pr list`.
2. Launch the saved workflow from the repo root on `feat/build-loop`:
   `Workflow({scriptPath: ".claude/workflows/execute-wave.js", args: {maxTasks: 5, playtest: true}})`.
   Pass `refills: 1` (or 0) for a shorter wave.
3. Ship: push the HEAD to `ship/<name>`, open a PR into `dev`, merge it with `--admin` once "Check and build" passes, and comment the known reds on the PR. Verify the deploy: the `assets/index-*.js` name changes and `/health` returns 200.
4. After a usage limit, resume with `resumeFromRunId` and never relaunch. A usage limit is a pause: schedule a heartbeat so the loop restarts on its own after the reset.

Known CI reds (not regressions): #186 boot/frames perf, #195 Lighthouse, #201/#209 demo-reload, #208 settings 1280x800, #213 collect-payout, #216 safes:127 + honest-falls, #211 persist.test timing, #212 Safe cinematic wall-clock.

## Founder preferences
- Feature velocity first: features and founder reports before polish. Relax roadmap dependencies when they are not technically required. Checks still gate every merge.
- Merge your own PRs into `dev`. Promote to `main` only for a validated release candidate.
- Waves run 5 tasks (`maxTasks: 5`).
- Camera: the table fills the screen on every viewport, with sky at most 5 %.
- Be brief and act. Reply in French. Code, commits and issues stay in English.
- Keep the progress dashboard current at every step.

## Progress dashboard
- https://claude.ai/artifact/13mygXtRWZsppKUrsHx5BA (Dashboard type; its datasets are JSON assets in the artifact store).
- Generator: `python3 tools/dashboard/gen.py <repo> <out_dir> <phase> "<detail>"`. It writes 6 JSON files: loop, prs, tasks, timeline, waves, polish. `tools/dashboard/state.json` holds the wave start times.
- Refresh it in three steps:
  1. Upload each JSON file as an asset (`Artifact` publish with `asset: true`).
  2. Point `datasets/<name>` at the new `/_blob/<id>`: an `ArtifactData` batch update pinned with `if_version`.
  3. Delete the old blobs.

## Open founder questions (unanswered)
P-498, P-499, P-500 (season and quests), P-435 (scene-scale floor), P-436/P-438 (FTUE first credit), P-477 (trust fund size), P-520 (Ascension dock entry), P-551 (dry taps after each crate), #184 (which device and browser lose sound), P-620/P-557 (album cards in Inventory or only Album), P-642 (economy retune), P-647/P-676 (album card on crate open; shared crate Reward kind for Soirée crates). Human-only steps: H-10.01, H-10.02, H-7.01.

## Gacha follow-ups (#218)
- Ticket price into `packages/economy` (#15).
- Charm grant (P-665).
- Pause the main scene while the sheet is open.
- Unit tests for `gacha/panel.ts` and `gacha/mount.ts`.
- Correct the sheet-size comment at `budgets.ts:127`: the sheet is 13.6 kB.
