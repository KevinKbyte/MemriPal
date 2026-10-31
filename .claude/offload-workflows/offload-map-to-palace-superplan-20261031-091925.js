export const meta = {
  name: 'offload-map-to-palace-superplan-20261031-091925',
  description: '/super-plan for MemriPal (repo C:/Users/Kev/projects/hackath',
  phases: [{ title: 'Plan v0' }, { title: 'Adversaries' }, { title: 'Offload' }],
}
const PROMPT = `/super-plan for MemriPal (repo C:/Users/Kev/projects/hackathons/meta-global-2026/memripal, main a082c18, 0.20.1): the map-to-palace pivot.

Kev's ask (verbatim, 2026-10-31): "we are pivoting to the map to memory palace and augmented with pictures at landmarks from user, and have baseline picture from meta's mapillary" + "where we're letting users map out important routes and use important routes as memory palaces. so they can have a good reason to memorize these routes as well as have memory palace augmenting their other learnings/systems in parallel" + "superplan be composed of the design as well as the implementation portion - so we can send the design to design claude and then you can work on the implementation" + "you may have to consolidate and then deprecate some parts so that we can have just one plan".

PRODUCT FRAMING (Kev, verbatim, 2026-10-31; drives Part A screens, S1 Routes home, and pitch copy): "this would make it less much forgetable considering there are many important routes in people's day to day plus even routes where they dont use day to day can be mapped there considering that it is important to know the different routes to get to their local grocery store, or to some good tasting restaurant that they may want to bring friends to. Rather than having to rely on google maps all the time (which I do), I bet this app will help me and others be more attentive to their surroundings and rely on google maps less at least when we are going to destinations that we want to be able to confidently be able to walk the route without having to pull out google maps. And have memory benefit out of it since there are infinite things to remember, and so we need to have some good way of storing the important ones". Implications: many routes per user (daily + occasional destinations); route-learning goal = walk it confidently without a nav app; palace goal = store the important things among infinite ones. Do not claim the app replaces navigation or makes users safer; no interaction while moving still holds.

INPUTS (read all before plan v0):
- Handoff note with the accepted Synthesis of 4 requirement adversaries (binding unless it says Kev may override): C:/Users/Kev/projects/agent-workflow/plan-notes/plans/memripal-2026-10-31-s2t-handoff.md (sections Facts, Synthesis, OPEN ITEMS).
- Requirements + adversary reports: C:/Users/Kev/AppData/Local/Temp/claude/C--Users-Kev-projects-hackathons/c98c9a83-087a-4694-bbdd-233369b8333b/scratchpad/ pivot-reqs.md, adv-feasibility.md, adv-rights.md, adv-science.md, adv-ux.md.
- Prior plan to consolidate: C:/Users/Kev/projects/agent-workflow/plan-notes/plans/done/memripal-2026-10-30-s2s-handoff.md (all OPEN ITEMS).
- Second plan to consolidate: C:/Users/Kev/projects/agent-workflow/plan-notes/plans/meta-global-2026-2026-10-30-train-r63i-handoff.md. Pre-read result: its open items 6, 8, 9, 11, 12 are all agent-workflow tooling (docgate, worktree_note_attach, prune claims), none memripal-specific -> mark KEEP, stays in its own chain, not merged into the memripal plan.
- Repo code: src/memripal/ (associate.py, scenes.py, security_headers.py, app.py), static/index.html, static/style.css, static/theme-painterly.css, docs/adr/, docs/submission/, hackathon.md.

OUTPUT: ONE plan with three parts.
- Part A: a self-contained prompt for Claude Design (pasteable as-is) honoring every "Design prompt constraints" bullet in the Synthesis (CSS additions file using only existing tokens, static HTML fragment per screen S1-S9, state table, old->new id map, no JS/mock data/inline style/external assets, all live ids kept, [hidden] visibility, 360px first, light+dark, model chip per AI step, arm->confirm->Undo deletes). Must show both the route-learning view and the list-on-route view.
- Part B: implementation slices (TDD, vertical) whose screen ids are fixed by Part A so implementation can run while Claude Design works. Include: Mapillary baseline image per station via backend proxy vs img-src widening (ADR decision inside the slice), station model + capture-order from client-side EXIF/GPS, SAM 3.1 one box per station, Spark station name/profile, sensory quick-taps, KAVE COGS grounded in profile, face/plate blur before Muse Image/storage/fixtures, privacy zone on backup export, scenes.py:68-81 provenance pass-through + "AI-generated" chip (item 111), neutral demo route replacing Little Round Top (item 112), reuse rule (one active list per route, intrusion counting), recall map dots. Each slice carries FLOW-016 CRITERIA (countable pass/fail) + SIGNALS (or "none") as terse clauses. Respect the deadline Wed Nov 4 9 PM ET: order by demo value; mark cut-line.
- Part C: consolidation ledger: every open item of s2s + train-r63i marked KEEP / DEPRECATED-by-pivot (reason) / DONE. Deprecate ONLY items specific to the old photo-to-segmented-room design; brand art (109, 97), deploy, submission, retro items stay KEEP.

Write the final plan text into the body. Do not write to the memripal repo; the joiner emits it via markdown-engineer to docs/plans/2026-10-31-map-to-palace.md. Do not implement any code.

REPORT: C:/Users/Kev/AppData/Local/Temp/claude/offload/map-to-palace-superplan-20261031-091925/report.md

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

TARGET REPO for every --repo argument in this prompt: C:/Users/Kev/projects/hackathons/meta-global-2026/memripal

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
const MAX_ROUNDS = 3
const MAX_WIDTH = 8
const MAX_AGENTS = 24
const WORKTREE_CHECK = 'PRECONDITION: run `git rev-parse --git-dir` in this worktree first. If it fails or resolves to the primary checkout AND round is 2 or later (the branch was already registered by round 1 isolation worktree), check whether the branch still exists with `git rev-parse --verify <branch>`. If it exists, RE-PROVISION with `git worktree add <path> <branch>` (no -b, branch already exists) and continue -- do not stop BLOCKED. If the branch is ALSO gone, RE-CREATE with `git worktree add <path> -b <branch> <default-branch>`, then re-apply any `*.patch` files the previous round left in the run scratchpad / offload dir with `git apply`, and continue. Round 1 has no prior branch to reattach to, so a round-1 failure still reports BLOCKED with `worktree unregistered`. See rules.global/worktree-registration-check.md.\n\n'
const KEEP_WORKTREE = 'ROUND-1 PRECONDITION: before any other work, run this ONE chained command at the root of your isolation worktree, verbatim apart from the three placeholders: `echo map-to-palace-superplan-20261031-091925 > .offload-keep && git add .offload-keep && python scripts/worktree_note_attach.py attach --worktree <absolute path of this worktree> --branch <its branch> --unattached-reason "offload run map-to-palace-superplan-20261031-091925 (round 1); no owning note" --attached-by offload --repo <primary checkout root>`. The first half creates and stages (never commits) the untracked .offload-keep marker so the harness does not auto-delete the worktree as unchanged when you leave patches in the scratchpad instead of writing gated paths; the second half records the worktree/note attachment (rules.global/worktrees-attach-to-notes.md) -- skipping one skips both, and `worktree_note_attach.py check` later reports the tree as untracked_worktree. Never commit .offload-keep.\n\n'
const NAMED_WORKTREE = 'C:/Users/Kev/.claude/worktrees/memripal/offload-map-to-palace-superplan-20261031-091925'
const PROVISION = 'ROUND-1 PROVISION: your isolation worktree is the persistent named worktree C:/Users/Kev/.claude/worktrees/memripal/offload-map-to-palace-superplan-20261031-091925 in repo C:/Users/Kev/projects/hackathons/meta-global-2026/memripal, not your cwd. Before anything else run `test -e C:/Users/Kev/.claude/worktrees/memripal/offload-map-to-palace-superplan-20261031-091925/.git || git -C C:/Users/Kev/projects/hackathons/meta-global-2026/memripal worktree add -q C:/Users/Kev/.claude/worktrees/memripal/offload-map-to-palace-superplan-20261031-091925 -b offload/map-to-palace-superplan-20261031-091925 "$(git -C C:/Users/Kev/projects/hackathons/meta-global-2026/memripal symbolic-ref --short HEAD)"`, then do every read, write and command there by absolute path. Wherever the text below says your isolation worktree, it means C:/Users/Kev/.claude/worktrees/memripal/offload-map-to-palace-superplan-20261031-091925.\n\n'
const OFFLOAD_DIR = 'C:/Users/Kev/AppData/Local/Temp/claude/offload/map-to-palace-superplan-20261031-091925'
const LENSES = ['correctness', 'failure-modes', 'security-data', 'simplicity-cost']
const PLAN_V0_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    planPath: { type: 'string' },
    reconPath: { type: 'string' },
    worktree: { type: 'string' },
  },
  required: ['summary', 'planPath', 'reconPath', 'worktree'],
}
const ADV_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    reportPath: { type: 'string' },
  },
  required: ['summary', 'reportPath'],
}
const PLAN_V0_ASK = `SUPER-PLAN PHASE 1 ONLY: run /super-plan steps 1-3 (scope, recon, plan v0) for the ask below. Write plan v0 to \`${OFFLOAD_DIR}/plan-v0.md\` and the recon facts (path:line, primary-checkout content) to \`${OFFLOAD_DIR}/recon.md\`. Do NOT run the adversary round or arbitration -- independent adversaries run as separate workflow agents next. Before anything else, run this ONE chained command at the root of your isolation worktree (it creates the untracked \`.offload-keep\` file so the harness does not auto-delete the worktree as unchanged, AND records the worktree/note attachment per rules.global/worktrees-attach-to-notes.md): \`echo map-to-palace-superplan-20261031-091925 > .offload-keep && git add .offload-keep && python scripts/worktree_note_attach.py attach --worktree <absolute path of this worktree> --branch <its branch> --unattached-reason "offload run map-to-palace-superplan-20261031-091925 (plan v0); no owning note" --attached-by offload --repo <primary checkout root>\`. Return {summary (<= 10 lines), planPath, reconPath, worktree (absolute path of your isolation worktree)}.\n\n` + PROMPT
const planV0 = await agent(PROVISION + WORKTREE_CHECK + PLAN_V0_ASK, { label: 'offload:map-to-palace-superplan-20261031-091925:plan-v0', phase: 'Plan v0', agentType: 'general-purpose', schema: PLAN_V0_SCHEMA })
const ARB_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    planPath: { type: 'string' },
    acceptedCritical: { type: 'boolean' },
  },
  required: ['summary', 'planPath', 'acceptedCritical'],
}
const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    planPath: { type: 'string' },
  },
  required: ['summary', 'planPath'],
}
const ADV_ASK = (lens, planPath, tag) => `You are ONE adversary with the single lens ${lens}. Read \`${planPath}\` and \`${planV0.reconPath}\` and the sources they cite in the PRIMARY checkout (not a worktree). Stay in your lens -- coverage comes from the panel, not from you being comprehensive. "No findings" is not acceptable: if nothing is broken, return the weakest link in the plan and why. Per finding: SEVERITY (critical|major|minor), CLAIM, FAILURE, FIX, CONFIDENCE. Max 5 findings, each <= 120 words. End with mandatory CORRECTNESS: and SIMPLICITY: lines. Write the full report to \`${OFFLOAD_DIR}/adv-${lens}${tag}.md\`. Return {summary (<= 15 lines), reportPath}. Work independently, do not hedge toward a balanced verdict -- you cannot see the other adversaries.`
const runAdversaries = (planPath, tag) => parallel(LENSES.map(lens => () => agent(ADV_ASK(lens, planPath, tag), { label: `offload:map-to-palace-superplan-20261031-091925:adv${tag}-${lens}`, phase: 'Adversaries', agentType: 'plan-adversary', model: 'opus', schema: ADV_SCHEMA })))
const advSummary = res => res.map((a, i) => a && `### ${LENSES[i]}\n${a.summary}\n(report: ${a.reportPath})`).filter(Boolean).join('\n\n')
// F-1: an agent() worker has no Agent tool, so round 2 and the step-7 critic
// run as script-level agents, never inside the arbitration agent's own head.
const ARB_ASK = (round, planPath, summaries) => `SUPER-PLAN ARBITRATION (adversary round ${round} of at most 2): arbitrate the ${LENSES.length} independent adversary reports below against the plan at ${planPath} (accept / reject / overrule / defer each finding with a reason, in a Ledger table), then write the revised plan to \`${OFFLOAD_DIR}/plan-v1${round === 1 ? '' : '-r2'}.md\` ending with an '## Adversarial cheat sheet' section of exactly 3 bullets (1. the primary technical risk the adversaries identified, 2. how the plan was changed to fix it, 3. the one lingering architectural doubt still held). The user's verbatim asks are must-keep and non-deferrable: never defer, cut, or descope one without the user's explicit ask -- a scope constraint is not a scope cut; list them as must-keep in the plan. Do NOT run another adversary round or the critic pass -- the script dispatches those as separate agents. Return {summary (<= 10 lines), planPath, acceptedCritical (true iff the Ledger accepts at least one critical finding)}.\n\nADVERSARY SUMMARIES:\n${summaries}`
let arb = await agent(ARB_ASK(1, planV0.planPath, advSummary(await runAdversaries(planV0.planPath, ''))), { label: 'offload:map-to-palace-superplan-20261031-091925:arbitrate-r1', phase: 'Adversaries', agentType: 'general-purpose', schema: ARB_SCHEMA })
if (arb.acceptedCritical) {
  // Hard cap: exactly one extra round; the round-2 flag is not re-checked.
  arb = await agent(ARB_ASK(2, arb.planPath, advSummary(await runAdversaries(arb.planPath, '-r2'))), { label: 'offload:map-to-palace-superplan-20261031-091925:arbitrate-r2', phase: 'Adversaries', agentType: 'general-purpose', schema: ARB_SCHEMA })
}
const CRITIC_ASK = `SUPER-PLAN STEP 7 FINISHER+CRITIC: read the arbitrated plan at \`${arb.planPath}\` starting from its '## Adversarial cheat sheet' section, critique it (gaps, contradictions, unverifiable CRITERIA, missing SIGNALS), and write the finished plan v2 to \`${OFFLOAD_DIR}/plan-v2.md\`, keeping the cheat sheet as its last section. The user's verbatim asks are must-keep and non-deferrable: never defer, cut, or descope one without the user's explicit ask -- a scope constraint is not a scope cut; keep them listed as must-keep in plan v2. Read sources in the PRIMARY checkout; do not edit repo files. Return {summary (<= 10 lines), planPath}.`
const critic = await agent(CRITIC_ASK, { label: 'offload:map-to-palace-superplan-20261031-091925:critic', phase: 'Adversaries', agentType: 'general-purpose', schema: CRITIC_SCHEMA })
const ARBITRATE_ASK = `SUPER-PLAN DONE: the script already ran arbitration (Ledger, plan ending with an '## Adversarial cheat sheet' section of exactly 3 bullets: 1. the primary technical risk the adversaries identified, 2. how the plan was changed to fix it, 3. the one lingering architectural doubt still held), an adversary round 2 if a critical finding was accepted, and a separate finisher+critic agent. The hardened plan v2 is at ${critic.planPath}; critic summary:\n${critic.summary}\n\nContinue with the original ask below exactly as written.\n\n---\n\n` + PROMPT
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
enqueue([{ ask: ARBITRATE_ASK, agentType: 'general-purpose', worktree: planV0.worktree }])
let round = 0
let spawned = 0
let results = []
let mainThread = []
while (queue.length && round++ < MAX_ROUNDS && spawned < MAX_AGENTS) {
  const batch = queue.splice(0, Math.min(MAX_WIDTH, MAX_AGENTS - spawned))
  spawned += batch.length
  log(`round ${round}: ${batch.length} agent(s), ${spawned}/${MAX_AGENTS} spawned`)
  results = await parallel(batch.map((f, i) => () => agent(
    (round === 1 ? PROVISION : '') + WORKTREE_CHECK + `WORKTREE: ${f.worktree} -- do all reads/writes there by absolute path.\n\n${f.ask}`,
    {
      label: `offload:map-to-palace-superplan-20261031-091925:r${round}-${i}:${f.agentType}`,
      phase: 'Offload',
      agentType: round === 1 ? 'general-purpose' : f.agentType,
      isolation: undefined,
      schema: FOLLOWUP_SCHEMA,
    },
  )))
  const next = results.filter(Boolean).flatMap(r => r.followups)
  mainThread.push(...next.filter(f => f.ask.startsWith('MAIN THREAD:')))
  enqueue(next.filter(f => !f.ask.startsWith('MAIN THREAD:')))
}
if (queue.length) log(`STOPPED: ${queue.length} undone after ${spawned} agents / ${round} rounds`)
const omitBody = ({ body, ...rest }) => rest
return { results: results.map(r => r && omitBody(r)), mainThread }