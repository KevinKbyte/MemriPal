# Architecture decisions

One file per architectural decision: `NNNN-slug.md` with Context, Options considered (Pros/Cons), Decision, Why this
over the others, Consequences. Rule: `CLAUDE.md`. Full history: `docs/plans/2026-10-26-memripal.md`.

Why this log exists, Kev (2026-10-26): "can we make sure we record all architectural decisions, pros/cons of the
choices and why we chose one over the other in the hackathon documentation" ... "such as why we chose cloud run over
the others that you asked about".

## ADRs

- [0001](0001-python-fastapi-stack.md) Python 3.13 + FastAPI, vanilla ES-module frontend (over full TS).
- [0002](0002-backend-modes-and-replay-cache.md) `meta|fixture` modes, logical-key write-through replay cache.
- [0003](0003-stateless-backend-client-state.md) Stateless backend; palace state in IndexedDB (over server DB + accounts).
- [0004](0004-public-deploy-spend-guard.md) Fixture default + passcode + per-instance budget (over a persisted counter).
- [0005](0005-api-key-custody.md) Key custody: DPAPI locally, Secret Manager on GCP. No recorded alternatives.
- [0006](0006-provider-toggles.md) Meta default; other providers behind env flags (over self-hosted SAM).
- [0007](0007-scene-render-tiers.md) Scene tiers: whole-photo edit, crop card, canvas (over a mask composite).
- [0008](0008-spoken-recall-deterministic-matcher.md) Spoken recall via Muse Voice Transcribe; deterministic matcher.
- [0009](0009-image-intake-and-photo-privacy.md) Client re-encode + server re-validation. No recorded alternatives.
- [0010](0010-cloud-run-hosting.md) GCP Cloud Run hosting (retrospective comparison vs App Engine, VM, GKE, Functions).
- [0011](0011-s2-loci-request-shape.md) S2: one sync `POST /loci` over a `ModelRequest`-keyed backend (A-prime).
- [0012](0012-vr-imagery-mapillary.md) VR imagery from Mapillary (over Google Earth / Street View).
- [0013](0013-derived-request-key.md) Derived `RequestKey` from `ModelRequest` beside the unchanged MEM-003 `CacheKey`.
- [0014](0014-loci-prompt-args-and-progress.md) Re-ask exclude list in `gen_params["prompt_args"]` (over a new
  field); `find_loci` progress, deadline and re-ask failure semantics.

## Minor decisions (no ADR)

Plan IDs refer to `docs/plans/2026-10-26-memripal.md`.

- Spark structured output: `json_schema` with `strict:true`, schema restated in the prompt, 1 retry on parse failure (A3).
- Route order: row-aware left-to-right by bbox centroid; arrow-button reorder over drag (D6, Ledger).
- Each of S2-S4 ships a minimal UI panel so every day is demoable (D7).
- Secret scan is a regex pre-commit hook, not gitleaks (D8).
- Round-2 plan adversaries skipped: round 1 converged (D9).
- Cut line: only S9 is cuttable; Q1 cut order S9, D16, D18 history view, D4 live lighting (D10).
- Phone capture via `capture=environment`; no service worker (stale-deploy risk); native Android deferred (D13).
- Loci spacing (< ~5% of diagonal collapse) and same-type duplicates disambiguated by position (D14).
- Notes mode: <= 12 key points, each an exact substring of the notes (D15).
- Higher-order why/apply question written at encode time, self-assessed, never live-graded (D16).
- Full-auto flag skips route review (D19).
- Per-scene requests with the photo re-sent, over streaming scene generation in one request (Rejected alternatives).
