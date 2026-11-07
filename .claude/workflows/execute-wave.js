export const meta = {
  name: 'execute-wave',
  description: 'CoinPosh: run the next wave of unblocked roadmap tasks in parallel worktrees, review-gate each, integrate, playtest',
  whenToUse: 'Each iteration of the CoinPosh build loop. Args (optional): {maxTasks, onlyTasks, playtest}',
  phases: [
    { title: 'Plan', detail: 'pick unblocked, non-overlapping tasks from ROADMAP + STATUS' },
    { title: 'Build', detail: 'one owning agent per task, isolated git worktree, task/<id> branch' },
    { title: 'Review', detail: 'reviewer gate, up to 2 fix rounds per task' },
    { title: 'Integrate', detail: 'merge approved branches, run checks, update STATUS, push' },
    { title: 'Playtest', detail: 'screenshot + feel critique, files polish tasks' },
  ],
}

const A = args || {}
const MAX = A.maxTasks || 8
const FIX_ROUNDS = 2

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
        },
        required: ['id', 'title', 'agent', 'owns', 'brief'],
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
const only = A.onlyTasks ? `Restrict the wave to these IDs if unblocked: ${A.onlyTasks.join(', ')}.` : ''
const plan = await agent(
  `You are planning the next execution wave for CoinPosh.
Read docs/plan/04-ROADMAP.md, docs/plan/STATUS.md, docs/plan/POLISH.md (if present) and \`git log --oneline -30\`.
Determine the current branch with \`git rev-parse --abbrev-ref HEAD\` and return it as "base".
Select up to ${MAX} tasks (never H-* human tasks) whose deps are all "done" in STATUS.md, whose state is todo
(or blocked with a reason that is now resolved), and whose "owns" paths do NOT overlap each other.
A task whose owns is "any" must be alone in its wave. Prefer tasks on the critical path to the current milestone.
POLISH.md items marked "ready" can be scheduled as tasks with id "P-<n>" using the agent named in the item.
For each task put the COMPLETE task block (and relevant notes) into "brief".
List human tasks that currently block progress in humanBlocked. Set allDone=true only if every T-* task is done.
Do not modify any files.`,
  { label: 'planner', phase: 'Plan', schema: PLAN_SCHEMA, agentType: 'lead-architect', effort: 'medium' },
)

if (!plan || plan.allDone) return { status: 'ALL_DONE', humanBlocked: plan ? plan.humanBlocked : [] }
if (!plan.wave.length) return { status: 'NOTHING_UNBLOCKED', humanBlocked: plan.humanBlocked }

// cheap guard against overlapping ownership the planner missed
const seen = []
const wave = plan.wave.filter(t => {
  const clash = t.owns.some(p => seen.some(q => p.startsWith(q.replace(/\*+$/, '')) || q.startsWith(p.replace(/\*+$/, ''))))
  if (clash) { log(`Deferred ${t.id}: owns-path overlap`); return false }
  seen.push(...t.owns)
  return true
})
log(`Wave on ${plan.base}: ${wave.map(t => t.id).join(', ')}`)

const implPrompt = t => `Implement roadmap task ${t.id} · ${t.title} for CoinPosh.

${t.brief}

You are in an isolated git worktree. First run: git switch -c task/${t.id} ${plan.base}
(if the branch exists, git switch task/${t.id}). Install deps if needed (pnpm i).
Write ONLY within the owns paths: ${t.owns.join(', ')}.
Meet every acceptance criterion at the highest polish level — this game must feel premium and addictive.
Run pnpm check (or filtered equivalents) until green. Commit on task/${t.id} with message "${t.id}: <summary>".
Then run git switch --detach so task/${t.id} is free for the review and fix worktrees.
Do NOT push and do NOT merge. Return branch, commit sha, whether checks passed, and a summary.`

const reviewPrompt = (t, impl) => `Review task branch task/${t.id} (base ${plan.base}) for roadmap task ${t.id} · ${t.title}.

${t.brief}

Implementer summary: ${impl.summary}
You are in an isolated worktree: run git switch --detach task/${t.id}, pnpm i, pnpm check. Review the tip of task/${t.id}, not an older commit. Diff with git diff ${plan.base}...task/${t.id}.
Verify each acceptance criterion with evidence. Reject on any ownership violation, client-trusted value,
sim nondeterminism, disabled/skipped tests, missing i18n, perf budget risk, or anything that feels cheap.
Do not edit code. Return approved + concrete issues (file:line — problem — fix).`

const fixPrompt = (t, issues) => `Fix review findings on task branch task/${t.id} (${t.title}).
In your isolated worktree: git switch task/${t.id}. Stay within owns paths: ${t.owns.join(', ')}.
Findings:
- ${issues.join('\n- ')}
Fix all of them, run pnpm check until green, commit "${t.id}: address review" on task/${t.id} (never on a new branch),
then run git switch --detach so the branch is free. Do not push.`

// ---------- Build → Review (→ Fix)* pipelined per task ----------
const results = await pipeline(
  wave,
  t => agent(implPrompt(t), { label: `build:${t.id}`, phase: 'Build', agentType: t.agent, isolation: 'worktree', schema: IMPL_SCHEMA }),
  async (impl, t) => {
    if (!impl) return { id: t.id, approved: false, issues: ['implementation agent failed'] }
    let verdict = await agent(reviewPrompt(t, impl), { label: `review:${t.id}`, phase: 'Review', agentType: 'reviewer', isolation: 'worktree', schema: VERDICT_SCHEMA })
    for (let round = 1; verdict && !verdict.approved && round <= FIX_ROUNDS; round++) {
      log(`${t.id}: fix round ${round} (${verdict.issues.length} issues)`)
      await agent(fixPrompt(t, verdict.issues), { label: `fix${round}:${t.id}`, phase: 'Review', agentType: t.agent, isolation: 'worktree' })
      verdict = await agent(reviewPrompt(t, impl), { label: `re-review${round}:${t.id}`, phase: 'Review', agentType: 'reviewer', isolation: 'worktree', schema: VERDICT_SCHEMA })
    }
    return { id: t.id, title: t.title, branch: `task/${t.id}`, approved: !!(verdict && verdict.approved), issues: verdict ? verdict.issues : ['review failed'], requests: impl.outOfScopeRequests || [] }
  },
)

// ---------- Integrate (barrier: needs every result) ----------
phase('Integrate')
const done = results.filter(Boolean)
const approved = done.filter(r => r.approved)
const rejected = done.filter(r => !r.approved)
const integration = await agent(
  `Integrate this CoinPosh wave into ${plan.base} in the main checkout.
Approved branches (merge one at a time with --no-ff, run pnpm check after each; if a merge breaks checks, revert that merge and mark it blocked):
${approved.map(r => `- ${r.branch} (${r.title})`).join('\n') || '- none'}
Rejected (do NOT merge; mark "blocked(review: <short reason>)" in STATUS.md, keep the branch):
${rejected.map(r => `- ${r.id}: ${r.issues.slice(0, 3).join(' | ')}`).join('\n') || '- none'}
Out-of-scope requests raised by implementers (append to docs/plan/POLISH.md as "ready" items naming the owning agent):
${done.flatMap(r => r.requests.map(q => `- [${r.id}] ${q}`)).join('\n') || '- none'}
Then update docs/plan/STATUS.md (merged → done with merge sha), append a line to its Wave log (use \`date -u +%F\`),
commit "wave: <ids>", and git push -u origin ${plan.base} (retry up to 4 times with backoff on network errors).
Delete merged task/* branches locally. Return a short markdown summary.`,
  { label: 'integrator', phase: 'Integrate', agentType: 'lead-architect' },
)

// ---------- Playtest critique ----------
let critique = null
if (A.playtest !== false && approved.length) {
  phase('Playtest')
  critique = await agent(
    `Playtest CoinPosh on ${plan.base} as a picky player who wants a premium, addictive coin pusher.
If apps/web exists and builds: pnpm --filter web build && serve the dist, drive it with Playwright (chromium preinstalled; --trace off),
portrait 390x844, take screenshots at key moments (boot, first drop, cascade, crate unbox, menus), and judge against
docs/plan/00-VISION.md and 03-ART-AUDIO-JUICE.md: beauty, juice, readability, FTUE timings, fps.
Append up to 8 concrete, high-impact polish items to docs/plan/POLISH.md (status "ready", owning agent, owns paths, acceptance),
commit "playtest: polish items" and push to ${plan.base}. If nothing playable exists yet, say so and change nothing.
Return the top 3 findings.`,
    { label: 'playtester', phase: 'Playtest', agentType: 'qa-perf' },
  )
}

return {
  status: 'WAVE_COMPLETE',
  base: plan.base,
  merged: approved.map(r => r.id),
  rejected: rejected.map(r => ({ id: r.id, issues: r.issues })),
  humanBlocked: plan.humanBlocked,
  integration,
  critique,
}
