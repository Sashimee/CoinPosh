export const meta = {
  name: 'execute-wave',
  description: 'CoinPosh: keep up to maxTasks roadmap tasks building at once from a planned backlog (big tasks split into parallel parts), review-gate each, integrate and ship each as soon as it is approved, playtest alongside',
  whenToUse: 'Each iteration of the CoinPosh build loop. Args (optional): {maxTasks (parallel slots), backlog (tasks per run), onlyTasks, playtest, playtestEvery}',
  phases: [
    { title: 'Plan', detail: 'pick a priority-ordered backlog of unblocked tasks, splitting big ones into parallel parts' },
    { title: 'Build', detail: 'rolling slots: a freed slot starts the next task whose owns do not clash with running ones' },
    { title: 'Review', detail: 'reviewer gate, 1 fix round per task; a task that still fails retries next wave' },
    { title: 'Integrate', detail: 'merge each approved task as soon as it passes review, run checks, update STATUS, push' },
    { title: 'Ship', detail: 'PR base into dev after each merge, so the dev site on Dokploy redeploys' },
    { title: 'Playtest', detail: 'runs in its own worktree while building continues; polish items are queued through the integrator' },
  ],
}

const A = args || {}
const MAX = A.maxTasks || 5
const BACKLOG = A.backlog || MAX * 2
const PLAYTEST_EVERY = A.playtestEvery || 3
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

const AGENTS = ['audio-engineer', 'backend-engineer', 'economy-designer', 'gameplay-engineer', 'lead-architect', 'mobile-engineer', 'physics-engineer', 'qa-perf', 'render-artist', 'ui-engineer', 'vfx-juice']

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
          agent: { type: 'string', enum: AGENTS, description: 'Exactly one project agent; for a POLISH item naming several owners or a role, pick the agent that owns most of its paths' },
          owns: { type: 'array', items: { type: 'string' } },
          brief: { type: 'string', description: 'full task block from the roadmap plus any notes from STATUS/POLISH' },
          simple: { type: 'boolean', description: 'true for mechanical work (deps, docs, CI/config tweaks, small fixes); false for gameplay, physics, rendering, server logic or anything with design judgement' },
          parent: { type: 'string', description: 'for a part of a split task: the original task id; omit otherwise' },
          after: { type: 'array', items: { type: 'string' }, description: 'ids in this backlog that must be merged before this one starts (e.g. the part that adds the shared contract); usually empty' },
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
Return a priority-ordered backlog of up to ${BACKLOG} tasks (never H-* human tasks) whose deps are all "done" in STATUS.md, whose state is todo
(or blocked with a reason that is now resolved). Owns paths MAY overlap: the scheduler runs ${MAX} at once and holds back a task whose owns clash with a running one, so order matters more than disjointness.
A task whose owns is "any" runs alone; avoid scheduling it unless it is the top priority.
Split big tasks so they build in parallel: when a task spans several areas (e.g. server route + client flow + cinematic, or sim + client)
or would take one agent much more than ~15 minutes, replace it with parts "<id>-p1", "<id>-p2", ... (set parent to the original id), each with
disjoint owns, its own acceptance slice and a brief that states the shared contract (types, event names, API shape) every part codes against.
If a contract must land first (e.g. packages/shared types), make it its own small part and list it in the other parts' "after". Don't split small tasks.
Priority order: first, tasks that make the game playable on the dev site (coins dropping on the table and pushed off by the pusher,
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

const wave = plan.wave.filter(t => {
  if (A.onlyTasks && !A.onlyTasks.includes(t.parent || t.id)) { log(`Dropped ${t.id}: not in onlyTasks`); return false }
  return true
})
log(`Backlog on ${plan.base} (${MAX} slots): ${wave.map(t => t.id + (t.simple ? ' (simple)' : '') + (t.after && t.after.length ? ` after ${t.after.join('+')}` : '')).join(', ')}`)
const partsOf = parent => wave.filter(w => w.parent === parent).map(w => w.id)

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
Otherwise mark ${r.id} done with the merge sha in docs/plan/STATUS.md.${r.parent ? `
${r.id} is one part of ${r.parent} (parts: ${partsOf(r.parent).join(', ')}). Record the part and its sha in ${r.parent}'s STATUS.md row; mark ${r.parent} done only when every part is merged (check its row), otherwise leave it "in progress (parts merged: ...)".` : ''}
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
const shipPrompt = () => `Ship the current ${plan.base} to the CoinPosh dev environment (https://devcoinposh.bas.lu, API https://api.devcoinposh.bas.lu). Use gh; never push to main or dev directly, and never open or merge a PR into main: main is promoted only when the user validates a release candidate.
1. If ${plan.base} has commits not on origin/dev: reuse the open PR from ${plan.base} into dev or open one (title "build: <task ids merged since the last ship>"), wait for its checks (gh pr checks --watch), and merge it with gh pr merge --merge only when every check on the PR's current head sha passed. "No checks reported" means CI has not started yet: wait (up to 10 minutes, polling) for the checks to appear, never treat it as green. If checks fail or never appear, stop and report the failing check and log excerpt.
2. Dokploy auto-deploys dev on push. Wait up to 10 minutes for https://api.devcoinposh.bas.lu/health to answer 200 and for https://devcoinposh.bas.lu/ to serve an index.html whose /assets/index-*.js differs from before the merge, and report what you saw.
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

// ---------- Playtest alongside the build ----------
const PLAYTEST_SCHEMA = {
  type: 'object',
  properties: {
    testedSha: { type: 'string' },
    polishItems: { type: 'array', items: { type: 'string' }, description: 'complete POLISH.md lines without id: "[ready] P-NEW · ... · agent: ... · owns: ... · accept: ..."' },
    topFindings: { type: 'string' },
  },
  required: ['polishItems', 'topFindings'],
}
const playtestPrompt = () => `Playtest CoinPosh at the tip of origin/${plan.base} as a picky player who wants a premium, addictive coin pusher.
You are in an isolated worktree: git fetch origin && git switch --detach origin/${plan.base}, pnpm i. Report that sha as testedSha.
${SERVERS}
If apps/web exists and builds: pnpm --filter web build && serve the dist, drive it with Playwright (chromium preinstalled; --trace off),
portrait 390x844, take screenshots at key moments (boot, first drop, cascade, crate unbox, menus), and judge against
docs/plan/00-VISION.md and 03-ART-AUDIO-JUICE.md: beauty, juice, readability, FTUE timings, fps.
Do not edit or commit anything. Return up to 8 concrete, high-impact polish items as complete POLISH.md lines (status "ready", owning agent, owns paths, acceptance; the integrator assigns the ids), and the top 3 findings.`
const playtests = []
let playtesting = null
let mergedSincePlaytest = 0
const playtest = () => {
  if (A.playtest === false || playtesting) return
  mergedSincePlaytest = 0
  playtesting = agent(playtestPrompt(), { label: `playtest:${playtests.length + 1}`, phase: 'Playtest', agentType: 'qa-perf', isolation: 'worktree', schema: PLAYTEST_SCHEMA })
    .then(pt => {
      if (pt && pt.polishItems && pt.polishItems.length) {
        playtests.push(pt)
        const run = mergeQueue.then(() => agent(
          `Record playtest findings for CoinPosh on ${plan.base} in the main checkout (git switch ${plan.base}; other merges may run before or after you).
${GIT_IDENTITY}
Append these items to docs/plan/POLISH.md, giving each the next free P-<n> id in place of P-NEW:
${pt.polishItems.map(i => `- ${i}`).join('\n')}
Commit "playtest: polish items" and git push origin ${plan.base} (git pull --rebase origin ${plan.base} first if the push is rejected; retry up to 4 times). Return a one-line summary.`,
          { label: `playtest-record:${playtests.length}`, phase: 'Playtest', agentType: 'lead-architect', effort: 'low' },
        ))
        mergeQueue = run.catch(() => null)
      } else if (pt) playtests.push(pt)
    })
    .catch(() => null)
    .then(() => { playtesting = null })
}

// ---------- Rolling build: Build → Review (→ Fix)* → Integrate per task, MAX at once ----------
const runTask = async t => {
  const impl = await agent(implPrompt(t), { label: `build:${t.id}`, phase: 'Build', agentType: t.agent, isolation: 'worktree', schema: IMPL_SCHEMA, ...effortFor(t) })
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
  const r = { id: t.id, title: t.title, parent: t.parent, branch: `task/${t.id}`, tip, approved: !!(verdict && verdict.approved), issues: verdict ? verdict.issues : ['review failed'], requests: impl.outOfScopeRequests || [] }
  if (r.approved) {
    const m = await integrate(r)
    if (!m || !m.merged) return { ...r, approved: false, issues: [`integration failed: ${m ? m.summary : 'integrator returned nothing'}`] }
    log(`${t.id}: merged ${m.sha}`)
    if (++mergedSincePlaytest >= PLAYTEST_EVERY) playtest()
  }
  return r
}

const stripGlob = p => p.replace(/\*+$/, '')
const clashes = (a, b) => a.includes('any') || b.includes('any') ||
  a.some(p => b.some(q => stripGlob(p).startsWith(stripGlob(q)) || stripGlob(q).startsWith(stripGlob(p))))
const queue = [...wave]
const running = new Map()
const results = []
const mergedIds = new Set()
const failedIds = new Set()
while (queue.length || running.size) {
  for (let i = 0; i < queue.length && running.size < MAX;) {
    const t = queue[i]
    const after = t.after || []
    const blockedBy = after.find(id => failedIds.has(id))
    if (blockedBy) {
      queue.splice(i, 1)
      failedIds.add(t.id)
      results.push({ id: t.id, title: t.title, parent: t.parent, branch: `task/${t.id}`, approved: false, issues: [`not started: ${blockedBy} was not merged`], requests: [] })
      log(`${t.id}: skipped, ${blockedBy} was not merged`)
      continue
    }
    const ready = after.every(id => mergedIds.has(id) || !wave.some(w => w.id === id))
    if (!ready || [...running.values()].some(r => clashes(t.owns, r.owns))) { i++; continue }
    queue.splice(i, 1)
    log(`${t.id}: started (${running.size + 1}/${MAX} slots)`)
    running.set(t.id, { owns: t.owns, done: runTask(t).catch(e => ({ id: t.id, approved: false, issues: [`task crashed: ${e}`], requests: [] })).then(r => ({ id: t.id, r })) })
  }
  if (!running.size) {
    log(`Nothing can start: ${queue.map(t => t.id).join(', ')} wait on parts that never merged`)
    queue.forEach(t => results.push({ id: t.id, title: t.title, parent: t.parent, branch: `task/${t.id}`, approved: false, issues: ['not started: its "after" parts never merged'], requests: [] }))
    break
  }
  const { id, r } = await Promise.race([...running.values()].map(x => x.done))
  running.delete(id)
  results.push(r)
  if (r && r.approved) mergedIds.add(id)
  else failedIds.add(id)
}

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

// ---------- Final playtest only if this run has merges no playtest has seen ----------
if (A.playtest !== false && approved.length) {
  phase('Playtest')
  while (playtesting) await playtesting
  if (mergedSincePlaytest > 0 || !playtests.length) playtest()
  while (playtesting) await playtesting
  await mergeQueue
}
const critique = playtests.map(p => p.topFindings).join('\n\n') || null

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
