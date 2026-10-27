# 0014: Loci re-ask exclude list via `gen_params["prompt_args"]`; `find_loci` progress semantics

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-27-s2-loci.md` S2.3b; [0013](0013-derived-request-key.md) (`RequestKey`);
`tests/test_backend_request.py::test_has_exactly_plan_fields_and_no_photo_sha_field`, `tests/test_loci_pipeline.py`.

## Context

S2.3b's re-ask renders `_reask_prompt(kept phrases)`, so the exclude list shapes the answer and must be in the
`RequestKey`, or two re-asks with different exclude lists replay the same fixture. `ModelRequest` carries only a
`prompt_template_id`, and the MEM-014 test pins it to exactly its 8 plan fields. `MetaClient.chat_json` is strict
about its arguments.

## Options considered

- Exclude list in `gen_params["prompt_args"]`; `MetaBackend.call` pops it before `chat_json` and renders the prompt
  via `_prompt_for(template_id, args)`.
  Pros: pinned field-set test holds as written; enters the key through `gen_params_digest` with no key change;
  `chat_json` never sees it.
  Cons: overloads `gen_params` (generation settings plus prompt inputs); the `PROMPT_ARGS` pop is a convention
  every backend that renders prompts must follow.
- New `ModelRequest.prompt_args` field, folded into `RequestKey`.
  Pros: explicit, typed; `gen_params` stays generation-only.
  Cons: breaks the MEM-014 exact-field test, so it needs a test-engineer change to a pinned contract first.
- One template id per rendered prompt (exclude list encoded in `prompt_template_id`).
  Pros: no new field, no `gen_params` overload.
  Cons: unbounded template ids; `_prompt_for` must parse ids back into phrases.

## Decision

`gen_params["prompt_args"] = {"exclude": [kept phrases in select_loci order]}`. Template ids: `phrase`,
`phrase-reask`, `sam-phrase`; `_prompt_for("phrase-reask", args)` returns `_reask_prompt(args["exclude"])`. The
exclude list holds kept (selected) phrases, not every phrase sent to SAM.

`find_loci(..., clock=time.monotonic)` returns `LociResult`:
- `on_progress(phrase)` fires once per finished phrase (including failed SAM calls), on the calling thread, phrase
  only; never for phrases still pending at the deadline.
- The pool is not a `with` block; `finally` runs `shutdown(wait=False, cancel_futures=True)`, so the deadline returns
  while a SAM call may still run. Re-ask only if `deadline - clock() >= 15.0`.
- Re-ask raising `BackendCallFailed` -> keep first-round loci, `reask_used=True` (same as the nothing-new case); a
  malformed re-ask answer = no phrases. Other errors (e.g. `FixtureMissing`) propagate so S2.4 can return 404.
- At most 30 phrases to SAM across both asks; SAM answer cap 256 KB in UTF-8 bytes; control char = Unicode
  category Cc; results collected in phrase order, not completion order, so replay is deterministic.

## Why this over the others

Only option that keys the exclude list without touching a pinned MEM-014 contract or growing template ids, and it
stays local to `backend.py`.

## Consequences

- Any backend rendering prompts must pop `PROMPT_ARGS` before the provider call.
- OPEN: add a real `prompt_args` field to `ModelRequest` (option 2) once a test-engineer updates the pinned
  field-set test; that changes re-ask key digests, so re-record re-ask fixtures then.
- Fixtures were not regenerated in S2.3b; S2.6 records them through `ModelRequest`.
