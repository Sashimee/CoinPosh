# Runbook: how to execute the plan

## One-time setup (human)
1. **Base branch:** make this branch the default `main` on GitHub (rename `claude/brave-planck-yumo49`
   to `main` in Settings → Branches, or create `main` from it). New sessions start from the default branch.
2. **H-0.01:** enable GitHub Pages: Settings → Pages → Source: **GitHub Actions**.
3. **H-0.02 (optional, can come later):** add the repo secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Until then the game runs in Demo Mode.

## Start a NEW session on this repo
The agents (`.claude/agents/`), the saved workflow (`.claude/workflows/execute-wave.js`),
`CLAUDE.md` and `.claude/settings.json` (auto-compact at 200k) load at session start.

## The loop command (paste it into the new session)
```
/loop Use a workflow: run the saved workflow execute-wave. When it returns: if status is ALL_DONE, stop the loop. If NOTHING_UNBLOCKED, list the humanBlocked steps for me and stop. Otherwise give me a 3-line summary (merged, rejected with reason, top playtest finding), open or update the PR for the branch, and start the next wave right away.
```

### Variants
- Cheaper / slower: `... run the saved workflow execute-wave with args {"maxTasks":4} ...`
- Specific tasks only: `... with args {"onlyTasks":["T-1.04","T-1.05"]} ...`
- Skip the playtest step: `... with args {"playtest":false} ...`

## Cost expectations
One wave of 8 tasks is about 20–30 agents (build + review + fixes + integrate + playtest).
M0 takes about 1–2 waves; the M1 vertical slice takes about 4–5 waves.

## Where to look
- Progress: `docs/plan/STATUS.md` (task states + wave log)
- Polish queue: `docs/plan/POLISH.md`
- Backlog: `docs/plan/04-ROADMAP.md`
