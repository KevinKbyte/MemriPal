export const meta = {
  name: 'offload-aw-train-r63i-sdlc-20261031-092400',
  description: '/sdlc in agent-workflow (C:/Users/Kev/projects/agent-workflo',
  phases: [{ title: 'Offload' }],
}
const PROMPT = `/sdlc in agent-workflow (C:/Users/Kev/projects/agent-workflow, default branch master) for the open items of C:/Users/Kev/projects/agent-workflow/plan-notes/plans/meta-global-2026-2026-10-30-train-r63i-handoff.md. Kev 2026-10-31: "offload the agent-workflow /sdlc for train-r63i items 6, 11 and 12."

Scope (each item's CRITERIA/SIGNALS are in that note; honor them verbatim):
- Item 6: R6 "Better docgate output" -- spec in r63f item 6 (plan-notes/plans/done/), adversary reports plan-notes/plans/r63f-adversary/adv-r6-{a,b}.md.
- Item 11: F28 -- add \`detach --note <n> --worktree <p>\` to scripts/worktree_note_attach.py (fold with carried F27; see done/meta-global-2026-2026-10-30-train-r63h-handoff.md).
- Item 12: F29 + F30 -- scripts/prune_worktree_claims.py: treat a claim whose pid is an ancestor claude.exe of the \`!\` shell like the OPS-133 prior-session case; check scripts/worktree_lock_status.py before codifying F30.
Out of scope: items 8, 9 (other session's items; owners not live).

Before planning, check overlap with live peer worktrees modified in the last hour (e.g. C:/Users/Kev/.claude/worktrees/agent-workflow/bundle-ops948, merge-wait-timeout, red-ops948) via \`git log --oneline -5\` per worktree and \`git log --oneline -20 master\`; skip any item already landed or in flight and say so.

Run Orient, Plan (FLOW-016 CRITERIA + SIGNALS per slice), then Implement per slice via typed followups: test-engineer for RED (record RED under this slug as run id), software-engineer for GREEN, markdown-engineer for docs/CHANGELOG. One commit per fix. Do not enqueue or merge; the joiner offers the enqueue.

REPORT: C:/Users/Kev/AppData/Local/Temp/claude/offload/aw-train-r63i-sdlc-20261031-092400/report.md

When finished, put the full long-form report in the \`body\` field of the required
StructuredOutput response; write no file for it -- the joiner persists \`body\` to
REPORT from the run journal. Put ONLY a STATUS block of <= 12 lines in the \`report\`
field: STATUS DONE|PARTIAL|BLOCKED, worktree path and branch @ sha (UNMERGED unless
the ask said to enqueue), files touched count, one verbatim test-output line, <= 2
open questions, and the REPORT path. Do not put the full report in \`report\` -- the
completion notification carries \`report\` verbatim into the joiner's context. Do not
enqueue or merge unless the ask says so.

You have no Agent tool -- you cannot delegate to software-engineer, test-engineer, or
markdown-engineer yourself. If any part of the ask needs a write only one of those
roles owns, or cannot be finished for any other reason, do not leave it undone
silently: list it in the \`followups\` array of the same StructuredOutput response
(alongside \`status\`, \`report\`, and \`body\`), one entry per sub-ask, each
\`{ask, agentType, worktree}\`:

- \`agentType\` is the role that owns the write: \`software-engineer\` for source,
  \`test-engineer\` for \`tests/**\`, \`markdown-engineer\` for \`*.md\`, \`context-lookup\`
  for a read-only lookup/classification sub-ask (no write), \`general-purpose\`
  for other read/audit work with no gated write, or \`general-purpose\` with the \`ask\`
  prefixed \`MAIN THREAD:\` for an ask-gated path (spec files, hooks,
  \`.claude/rules.global/**\`, \`.claude/settings.json\`) -- no user is present in a
  workflow run to answer that ask, so it must go to the main thread instead.
- \`worktree\` is this worker's own worktree path (self-contained: the follow-up runs
  as its own fresh worker with no memory of this one, so state the sub-ask plus this
  worktree path and the REPORT path above).
- Any agent that writes \`*.md\` (you included) runs
  \`python scripts/merge_queue_docgate.py --target master\` before committing (the
  merge-time doc gate, run early; substitute the default branch if not \`master\`).
  Every \`markdown-engineer\` ask carries this line verbatim
  (\`scripts/merge_queue_docgate.py::main@hb8271762\`).
- RED/GREEN pairs: the \`test-engineer\` ask records RED under the slug as explicit run
  id -- \`python scripts/sdlc_phase_gate.py record --run <slug> --phase Implement
  --gate red --repo <worktree> --evidence <test-output-path>\`; the paired
  \`software-engineer\` ask first runs \`python scripts/sdlc_phase_gate.py check --run
  <slug> --phase Implement --repo <worktree>\`, binding its session to that run.
  \`red-before-green-gate.py\` reads only the ledger -- a committed failing test does
  not satisfy it (\`hooks.global/red-before-green-gate.py::_gate_targets@h83c7f774\`).
  Detail: \`repo-root-worktree.md\` (OPS-735 section).

The dispatcher re-runs each \`followups\` entry as its own \`agent()\` call, with that
entry's \`agentType\`, in the next round, up to \`MAX_ROUNDS\`.

TARGET REPO for every --repo argument in this prompt: C:/Users/Kev/projects/agent-workflow

Before you build anything, run \`git rev-parse --show-toplevel\` and compare its
output to the TARGET REPO above. If it differs, STOP -- do not build -- and
report the mismatch instead.

LANDING (only if you land a branch): before bumping the version or enqueueing, run
\`python scripts/coverage_diff_gate.py --target <target> --run\` (<target> = the merge target branch)
and fix any uncovered lines it reports. Only after it passes, run
\`python scripts/bump_version.py <patch|minor>\` and then \`python scripts/request_merge.py\`. Pick the bump from the branch's commit types: minor if any commit is \`feat\`, else patch.
On a request_merge conflict rejection (item 106): rebase onto the target's current tip, emit a software-engineer followup to resolve the conflict, then re-enqueue.
`
const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['DONE', 'PARTIAL', 'BLOCKED'] },
    report: { type: 'string' },
    body: { type: 'string' },
    followups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ask: { type: 'string' },
          agentType: { enum: ['software-engineer', 'test-engineer', 'markdown-engineer', 'context-lookup', 'general-purpose'] },
          worktree: { type: 'string' },
        },
        required: ['ask', 'agentType', 'worktree'],
      },
    },
  },
  required: ['status', 'report', 'body', 'followups'],
}
const MAX_ROUNDS = 8
const MAX_WIDTH = 1
const MAX_AGENTS = 24
const WORKTREE_CHECK = 'PRECONDITION: run `git rev-parse --git-dir` in this worktree first. If it fails or resolves to the primary checkout AND round is 2 or later (the branch was already registered by round 1 isolation worktree), check whether the branch still exists with `git rev-parse --verify <branch>`. If it exists, RE-PROVISION with `git worktree add <path> <branch>` (no -b, branch already exists) and continue -- do not stop BLOCKED. If the branch is ALSO gone, RE-CREATE with `git worktree add <path> -b <branch> <default-branch>`, then re-apply any `*.patch` files the previous round left in the run scratchpad / offload dir with `git apply`, and continue. Round 1 has no prior branch to reattach to, so a round-1 failure still reports BLOCKED with `worktree unregistered`. See rules.global/worktree-registration-check.md.\n\n'
const KEEP_WORKTREE = 'ROUND-1 PRECONDITION: before any other work, run this ONE chained command at the root of your isolation worktree, verbatim apart from the three placeholders: `echo aw-train-r63i-sdlc-20261031-092400 > .offload-keep && git add .offload-keep && python scripts/worktree_note_attach.py attach --worktree <absolute path of this worktree> --branch <its branch> --unattached-reason "offload run aw-train-r63i-sdlc-20261031-092400 (round 1); no owning note" --attached-by offload --repo <primary checkout root>`. The first half creates and stages (never commits) the untracked .offload-keep marker so the harness does not auto-delete the worktree as unchanged when you leave patches in the scratchpad instead of writing gated paths; the second half records the worktree/note attachment (rules.global/worktrees-attach-to-notes.md) -- skipping one skips both, and `worktree_note_attach.py check` later reports the tree as untracked_worktree. Never commit .offload-keep.\n\n'
const NAMED_WORKTREE = 'C:/Users/Kev/.claude/worktrees/agent-workflow/offload-aw-train-r63i-sdlc-20261031-092400'
const PROVISION = 'ROUND-1 PROVISION: your isolation worktree is the persistent named worktree C:/Users/Kev/.claude/worktrees/agent-workflow/offload-aw-train-r63i-sdlc-20261031-092400 in repo C:/Users/Kev/projects/agent-workflow, not your cwd. Before anything else run `test -e C:/Users/Kev/.claude/worktrees/agent-workflow/offload-aw-train-r63i-sdlc-20261031-092400/.git || git -C C:/Users/Kev/projects/agent-workflow worktree add -q C:/Users/Kev/.claude/worktrees/agent-workflow/offload-aw-train-r63i-sdlc-20261031-092400 -b offload/aw-train-r63i-sdlc-20261031-092400 "$(git -C C:/Users/Kev/projects/agent-workflow symbolic-ref --short HEAD)"`, then do every read, write and command there by absolute path. Wherever the text below says your isolation worktree, it means C:/Users/Kev/.claude/worktrees/agent-workflow/offload-aw-train-r63i-sdlc-20261031-092400.\n\n'
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase()
const seen = new Set()
const queue = []
const enqueue = followups => {
  for (const f of followups) {
    const k = norm(f.ask)
    if (seen.has(k)) { log(`duplicate followup dropped: ${f.ask.slice(0, 60)}`); continue }
    seen.add(k)
    queue.push(f)
  }
}
enqueue([{ ask: PROMPT, agentType: 'general-purpose', worktree: null }])
let round = 0
let spawned = 0
let results = []
let mainThread = []
while (queue.length && round++ < MAX_ROUNDS && spawned < MAX_AGENTS) {
  queue.sort((a, b) => (b.agentType === 'test-engineer') - (a.agentType === 'test-engineer'))
  const batch = queue.splice(0, Math.min(MAX_WIDTH, MAX_AGENTS - spawned))
  spawned += batch.length
  log(`round ${round}: ${batch.length} agent(s), ${spawned}/${MAX_AGENTS} spawned`)
  results = await parallel(batch.map((f, i) => () => agent(
    (round === 1 ? PROVISION : '') + WORKTREE_CHECK + (round === 1 ? KEEP_WORKTREE + f.ask : `WORKTREE: ${f.worktree} -- do all reads/writes there by absolute path.\n\n${f.ask}`),
    {
      label: `offload:aw-train-r63i-sdlc-20261031-092400:r${round}-${i}:${f.agentType}`,
      phase: 'Offload',
      agentType: round === 1 ? 'general-purpose' : f.agentType,
      isolation: undefined,
      schema: FOLLOWUP_SCHEMA,
    },
  )))
  const next = results.filter(Boolean).flatMap(r => r.followups).map(f => ({ ...f, worktree: NAMED_WORKTREE }))
  mainThread.push(...next.filter(f => f.ask.startsWith('MAIN THREAD:')))
  enqueue(next.filter(f => !f.ask.startsWith('MAIN THREAD:')))
}
if (queue.length) log(`STOPPED: ${queue.length} undone after ${spawned} agents / ${round} rounds`)
const omitBody = ({ body, ...rest }) => rest
return { results: results.map(r => r && omitBody(r)), mainThread }