export const meta = {
  name: 'execute-wave',
  description: 'CoinPosh: run the next wave of unblocked roadmap tasks in parallel worktrees, review-gate each, integrate and ship each one as soon as it is approved, playtest',
  whenToUse: 'Each iteration of the CoinPosh build loop. Args (optional): {maxTasks, onlyTasks, playtest}',
  phases: [
    { title: 'Plan', detail: 'pick unblocked, non-overlapping tasks from ROADMAP + STATUS' },
    { title: 'Build', detail: 'one owning agent per task, isolated git worktree, task/<id> branch' },
    { title: 'Review', detail: 'reviewer gate, 1 fix round per task; a task that still fails retries next wave' },
    { title: 'Integrate', detail: 'merge each approved task as soon as it passes review, run checks, update STATUS, push' },
    { title: 'Ship', detail: 'PR base into dev and dev into main after each merge, so Pages redeploys' },
    { title: 'Playtest', detail: 'screenshot + feel critique, files polish tasks' },
  ],
}

const A = args || {}
const MAX = A.maxTasks || 4
const FIX_ROUNDS = 1
const GIT_NAME = 'Claude'
const GIT_EMAIL = 'noreply@anthropic.com'
const GIT_IDENTITY = `Before any git merge, commit or other git step that writes history, give this worktree the fixed workflow identity.
Run these as plain commands (never git -c flags, GIT_AUTHOR_*/GIT_COMMITTER_* env vars, or --global config):
git config extensions.worktreeConfig true
git config --worktree user.name "${GIT_NAME}"
git config --worktree user.email "${GIT_EMAIL}"
Then verify both: git config user.name must print ${GIT_NAME} and git config user.email must print ${GIT_EMAIL}. If either differs, stop and report it.`

const SERVERS = `Any dev, preview or static server you start (vite, pnpm dev, pnpm preview, serve, http-server) must be stopped before you return:
start it in the background, record its PID, and kill that PID when done. Never leave a server running; leftovers from earlier waves exhausted the machine's memory.`

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'current git branch all task branches start from' },
    allDone: { type: 'boolean' },
    humanBlocked: { type: 'array', items: { type: 'string' } },
    wave: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          agent: { type: 'string' },
          owns: { type: 'array', items: { type: 'string' } },
          brief: { type: 'string', description: 'full task block from the roadmap plus any notes from STATUS/POLISH' },
          simple: { type: 'boolean', description: 'true for mechanical work (deps, docs, CI/config tweaks, small fixes); false for gameplay, physics, rendering, server logic or anything with design judgement' },
        },
        required: ['id', 'title', 'agent', 'owns', 'brief', 'simple'],
      },
    },
  },
  required: ['base', 'allDone', 'wave', 'humanBlocked'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commit: { type: 'string' },
    checksPassed: { type: 'boolean' },
    summary: { type: 'string' },
    outOfScopeRequests: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'commit', 'checksPassed', 'summary'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    commit: { type: 'string', description: 'full sha of HEAD after the fix commit' },
    checksPassed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['commit', 'checksPassed', 'summary'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    sha: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['merged', 'summary'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' }, description: 'file:line — problem — required fix' },
    criteriaMet: { type: 'array', items: { type: 'string' } },
  },
  required: ['approved', 'issues'],
}

// ---------- Plan ----------
phase('Plan')
const only = A.onlyTasks
  ? `The lead has chosen this wave: schedule ONLY these IDs, in this priority order: ${A.onlyTasks.join(', ')}. A blocked task whose blocker is a review rejection is schedulable (its brief must include the review issues to fix). Do not substitute other tasks; if one cannot run, leave it out and say why in humanBlocked.`
  : ''
const plan = await agent(
  `You are planning the next execution wave for CoinPosh.
Read docs/plan/04-ROADMAP.md, docs/plan/STATUS.md, docs/plan/POLISH.md (if present) and \`git log --oneline -30\`.
Determine the current branch with \`git rev-parse --abbrev-ref HEAD\` and return it as "base".
Select up to ${MAX} tasks (never H-* human tasks) whose deps are all "done" in STATUS.md, whose state is todo
(or blocked with a reason that is now resolved), and whose "owns" paths do NOT overlap each other.
A task whose owns is "any" must be alone in its wave.
Priority order: first, tasks that make the game playable on Pages (coins dropping on the table and pushed off by the pusher,
the coin physics T-1.01, wiring coins into the scene P-19, the HUD P-28, and whatever directly unblocks those);
then tasks on the critical path to the current milestone; then everything else.
POLISH.md items marked "ready" can be scheduled as tasks with id "P-<n>" using the agent named in the item.
For each task put the COMPLETE task block (and relevant notes) into "brief", and set "simple" honestly.
List human tasks that currently block progress in humanBlocked. Set allDone=true only if every T-* task is done.
Do not modify any files.
${only}`,
  { label: 'planner', phase: 'Plan', schema: PLAN_SCHEMA, agentType: 'lead-architect', effort: 'medium' },
)

if (!plan || plan.allDone) return { status: 'ALL_DONE', humanBlocked: plan ? plan.humanBlocked : [] }
if (!plan.wave.length) return { status: 'NOTHING_UNBLOCKED', humanBlocked: plan.humanBlocked }

// cheap guard against overlapping ownership the planner missed
const seen = []
const wave = plan.wave.filter(t => {
  if (A.onlyTasks && !A.onlyTasks.includes(t.id)) { log(`Dropped ${t.id}: not in onlyTasks`); return false }
  const clash = t.owns.some(p => seen.some(q => p.startsWith(q.replace(/\*+$/, '')) || q.startsWith(p.replace(/\*+$/, ''))))
  if (clash) { log(`Deferred ${t.id}: owns-path overlap`); return false }
  seen.push(...t.owns)
  return true
})
log(`Wave on ${plan.base}: ${wave.map(t => t.id + (t.simple ? ' (simple)' : '')).join(', ')}`)

// Mechanical tasks run at lower effort; gameplay, physics, rendering and server work keep the agents' usual effort.
const effortFor = t => (t.simple ? { effort: 'low' } : {})

const implPrompt = t => `Implement roadmap task ${t.id} · ${t.title} for CoinPosh.

${t.brief}

You are in an isolated git worktree.
${GIT_IDENTITY}
${SERVERS}
Work on a detached HEAD: if a branch task/${t.id} exists from an earlier attempt,
run git switch --detach task/${t.id} && git merge --no-edit ${plan.base}; otherwise git switch --detach ${plan.base}.
Never switch to or create a task/* branch: other worktrees may hold it. Install deps if needed (pnpm i).
Write ONLY within the owns paths: ${t.owns.join(', ')}.
Meet every acceptance criterion at the highest polish level — this game must feel premium and addictive.
Run pnpm check (or filtered equivalents) until green. Commit with message "${t.id}: <summary>".
Do NOT push and do NOT merge. Return branch "task/${t.id}", the full sha from git rev-parse HEAD as commit, whether checks passed, and a summary.`

const reviewPrompt = (t, impl, tip) => `Review commit ${tip} (task ${t.id}, base ${plan.base}) for roadmap task ${t.id} · ${t.title}.

${t.brief}

Implementer summary: ${impl.summary}
You are in an isolated worktree: run git switch --detach ${tip}, pnpm i, pnpm check. Review exactly ${tip}; ignore any task/${t.id}* branch refs. Diff with git diff ${plan.base}...${tip}.
Verify each acceptance criterion with evidence. Reject on any ownership violation, client-trusted value,
sim nondeterminism, disabled/skipped tests, missing i18n, perf budget risk, or anything that feels cheap.
${SERVERS}
Do not edit code. Return approved + concrete issues (file:line — problem — fix).`

const fixPrompt = (t, issues, tip) => `Fix review findings for task ${t.id} (${t.title}) on top of commit ${tip}.
${GIT_IDENTITY}
${SERVERS}
In your isolated worktree: git switch --detach ${tip}. Never switch to or create a task/* branch. Stay within owns paths: ${t.owns.join(', ')}.
Findings:
- ${issues.join('\n- ')}
Fix all of them, run pnpm check until green, commit "${t.id}: address review" on the detached HEAD. Do not push.
Return the full sha from git rev-parse HEAD as commit, whether checks passed, and a summary.`

// Approved tasks merge one at a time as soon as they pass review, so the slowest task no longer holds the others back.
let mergeQueue = Promise.resolve()
const integrated = []
const integrate = r => {
  const run = mergeQueue.then(() => agent(
    `Integrate one approved CoinPosh task into ${plan.base} in the main checkout (other tasks may merge before or after you; never touch task worktrees).
${GIT_IDENTITY}
git switch ${plan.base}, then git update-ref refs/heads/${r.branch} ${r.tip}
git merge --no-ff ${r.tip} -m "Merge ${r.branch}: ${r.title}" and run pnpm check. If the merge conflicts or breaks checks, abort or revert it and mark ${r.id} "blocked(integration: <reason>)" in docs/plan/STATUS.md instead.
Otherwise mark ${r.id} done with the merge sha in docs/plan/STATUS.md.
Out-of-scope requests from the implementer (append to docs/plan/POLISH.md as "ready" items naming the owning agent):
${r.requests.map(q => `- [${r.id}] ${q}`).join('\n') || '- none'}
Commit "status: ${r.id}" and git push -u origin ${plan.base} (retry up to 4 times with backoff on network errors). Delete the local ${r.branch} branch if merged.
Return merged (boolean), the merge sha, and a one-line summary.`,
    { label: `integrate:${r.id}`, phase: 'Integrate', agentType: 'lead-architect', schema: MERGE_SCHEMA },
  ))
  mergeQueue = run.catch(() => null)
  return run.then(m => { if (m && m.merged) { integrated.push(r.id); ship() } return m })
}

// A ship run already in flight picks up later merges on its next pass, so CI waits are not stacked per task.
let shipping = null
let shipAgain = false
const shipPrompt = () => `Ship the current ${plan.base} to GitHub Pages for CoinPosh. Use gh; never push to main or dev directly.
1. If ${plan.base} has commits not on origin/dev: reuse the open PR from ${plan.base} into dev or open one (title "build: <task ids merged since the last ship>"), wait for its checks (gh pr checks --watch), and merge it with gh pr merge --merge. If checks fail, stop and report the failing check and log excerpt.
2. If origin/dev has commits not on origin/main: reuse or open the PR from dev into main (title "release: <task ids>"). CI does not run on that PR; wait for the CI run on the dev push for the same head sha (gh run list --branch dev --event push --workflow CI), and once it passes merge the PR with a merge commit.
3. Wait for the Deploy web run (workflow_run after CI on main) and report its conclusion, plus Deploy server if it ran.
PR bodies end with the attribution lines from the session. Do not modify files or the working tree.
Return a one-line summary with the PR numbers and deploy results.`
const ship = () => {
  if (shipping) { shipAgain = true; return shipping }
  shipping = (async () => {
    const reports = []
    do {
      shipAgain = false
      reports.push(await agent(shipPrompt(), { label: `ship:${reports.length + 1}`, phase: 'Ship', agentType: 'lead-architect', effort: 'low' }))
    } while (shipAgain)
    shipping = null
    shipReports.push(...reports)
  })()
  return shipping
}
const shipReports = []

// ---------- Build → Review (→ Fix)* → Integrate pipelined per task ----------
const results = await pipeline(
  wave,
  t => agent(implPrompt(t), { label: `build:${t.id}`, phase: 'Build', agentType: t.agent, isolation: 'worktree', schema: IMPL_SCHEMA, ...effortFor(t) }),
  async (impl, t) => {
    if (!impl) return { id: t.id, approved: false, issues: ['implementation agent failed'], requests: [] }
    let tip = impl.commit
    let verdict = await agent(reviewPrompt(t, impl, tip), { label: `review:${t.id}`, phase: 'Review', agentType: 'reviewer', isolation: 'worktree', schema: VERDICT_SCHEMA, ...effortFor(t) })
    for (let round = 1; verdict && !verdict.approved && round <= FIX_ROUNDS; round++) {
      log(`${t.id}: fix round ${round} (${verdict.issues.length} issues)`)
      const fix = await agent(fixPrompt(t, verdict.issues, tip), { label: `fix${round}:${t.id}`, phase: 'Review', agentType: t.agent, isolation: 'worktree', schema: FIX_SCHEMA, ...effortFor(t) })
      if (!fix || !fix.commit) { log(`${t.id}: fix round ${round} returned no commit`); break }
      tip = fix.commit
      verdict = await agent(reviewPrompt(t, impl, tip), { label: `re-review${round}:${t.id}`, phase: 'Review', agentType: 'reviewer', isolation: 'worktree', schema: VERDICT_SCHEMA, ...effortFor(t) })
    }
    const r = { id: t.id, title: t.title, branch: `task/${t.id}`, tip, approved: !!(verdict && verdict.approved), issues: verdict ? verdict.issues : ['review failed'], requests: impl.outOfScopeRequests || [] }
    if (r.approved) {
      const m = await integrate(r)
      if (!m || !m.merged) return { ...r, approved: false, issues: [`integration failed: ${m ? m.summary : 'integrator returned nothing'}`] }
      log(`${t.id}: merged ${m.sha}`)
    }
    return r
  },
)

// ---------- Wrap up rejected tasks and the wave log ----------
phase('Integrate')
const done = results.filter(Boolean)
const approved = done.filter(r => r.approved)
const rejected = done.filter(r => !r.approved)
await mergeQueue
const integration = await agent(
  `Close out this CoinPosh wave on ${plan.base} in the main checkout (git switch ${plan.base}). Approved tasks are already merged: ${integrated.join(', ') || 'none'}.
${GIT_IDENTITY}
Record the reviewed tips of rejected tasks, since task/* refs may be stale or checked out in old worktrees:
${rejected.filter(r => r.tip).map(r => `git update-ref refs/heads/${r.branch} ${r.tip}`).join('\n') || '(none)'}
Rejected (do NOT merge; mark "blocked(review: <short reason>)" in docs/plan/STATUS.md unless already blocked, keep the branch):
${rejected.map(r => `- ${r.id}: ${r.issues.slice(0, 3).join(' | ')}`).join('\n') || '- none'}
Out-of-scope requests from rejected tasks (append to docs/plan/POLISH.md as "ready" items naming the owning agent):
${rejected.flatMap(r => r.requests.map(q => `- [${r.id}] ${q}`)).join('\n') || '- none'}
Append a line to the STATUS.md Wave log (use \`date -u +%F\`), commit "wave: ${done.map(r => r.id).join(' ')}",
and git push -u origin ${plan.base} (retry up to 4 times with backoff on network errors). Return a short markdown summary.`,
  { label: 'integrator', phase: 'Integrate', agentType: 'lead-architect' },
)

// ---------- Playtest critique ----------
let critique = null
if (A.playtest !== false && approved.length) {
  phase('Playtest')
  critique = await agent(
    `Playtest CoinPosh on ${plan.base} as a picky player who wants a premium, addictive coin pusher.
${GIT_IDENTITY}
${SERVERS}
If apps/web exists and builds: pnpm --filter web build && serve the dist, drive it with Playwright (chromium preinstalled; --trace off),
portrait 390x844, take screenshots at key moments (boot, first drop, cascade, crate unbox, menus), and judge against
docs/plan/00-VISION.md and 03-ART-AUDIO-JUICE.md: beauty, juice, readability, FTUE timings, fps.
Append up to 8 concrete, high-impact polish items to docs/plan/POLISH.md (status "ready", owning agent, owns paths, acceptance),
commit "playtest: polish items" and push to ${plan.base}. If nothing playable exists yet, say so and change nothing.
Return the top 3 findings.`,
    { label: 'playtester', phase: 'Playtest', agentType: 'qa-perf' },
  )
}

ship()
while (shipping) await shipping

return {
  status: 'WAVE_COMPLETE',
  base: plan.base,
  merged: approved.map(r => r.id),
  rejected: rejected.map(r => ({ id: r.id, issues: r.issues })),
  humanBlocked: plan.humanBlocked,
  integration,
  critique,
  shipped: shipReports,
}
