# 0048: Memorize reuses /split notes + /associate per station, mnemonics client-side, deterministic route recommendation

Status: Accepted
Amends: [0033](0033-backup-v2-routes-no-coordinates.md) (top-level `lists[]` was pinned only as an array until B7,
0033:65; this defines its items). Relates: [0019](0019-split-endpoint-contract.md),
[0020](0020-association-validate-and-regenerate.md), [0014](0014-loci-prompt-args-and-progress.md), MEM-052, MEM-072
S5 (`.claude/spec-cache/memripal/references/spec-4.md`).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), findings Dd1, Dd2; plan
`docs/plans/2026-10-31-map-to-palace.md` B7. Kev, 2026-11-03: Memorize breakdown is a must-have.

## Context

The user pastes something to memorize; the app breaks it into keywords, places one per station of a route, and
suggests which route fits. This is the Spark "Deconstruct" beat in the demo. Constraints:

- A new prompt template changes the templates digest (`src/memripal/backend.py::_templates_digest`), so every new
  prompt needs recorded fixtures before the fixture-mode public URL can serve it.
- `/split` and `/associate` require a non-empty JPEG (`src/memripal/backend.py::ModelRequest.__post_init__`;
  `/split` decodes `photo`, `src/memripal/app.py::post_split`), but `DEMO_ROUTE` stations have no photo
  ([0042](0042-kendall-demo-route-seeding.md)).
- No embeddings exist in `src/memripal/meta_client.py`; Spark ranking would be nondeterministic and break fixture
  mode.

## Options considered

Keyword breakdown:

- (a) Reuse `/split` notes mode (keywords = labels, each `source_quote` checked against the notes,
  `src/memripal/split.py::_valid_points`), then `/associate` per (keyword, station); edited keywords go through
  `src/memripal/split.py::split_list` (0 calls) (chosen).
  Pros: no new prompt for the breakdown, so recorded fixtures keep working; the quote check already rejects invented
  keywords.
  Cons: one `/associate` call per station; `/split` still needs a photo.
- (b) A new `/deconstruct` endpoint and prompt.
  Pros: a purpose-built reply shape.
  Cons: a new template and digest, new fixtures, new validation, duplicating `/split`.

Station context in the prompt:

- (a) A station block `{name, profile, taps}` in `PROMPT_ARGS`, outside the templates digest, as `ASSOCIATION_PLACE`
  does (`src/memripal/associate.py::ASSOCIATION_PLACE`) (chosen). On `fixture_missing` the client fills a template
  from taps and profile.
  Pros: existing pre-MEM-025 request keys and fixtures survive; the station still keys the cache via prompt args.
  Cons: one more out-of-digest block to keep in step.
- (b) Put the station into the template text.
  Pros: simpler request.
  Cons: changes every request key and orphans the recorded fixtures.

Mnemonics:

- (a) Client-side acronym / chain plus `reencode_hint` (chosen).
  Pros: 0 calls; deterministic.
  Cons: plainer than a model-written mnemonic.
- (b) A Spark mnemonic call.
  Pros: richer text.
  Cons: another prompt, digest change and fixture set for a nice-to-have.

Route recommendation:

- (a) Deterministic: keep routes with free stations >= keyword count (one active list per route); score by Jaccard of
  item tokens against the route's lists and name, reusing the `static/recall_match.js` tokenizer (`STOPWORDS` :12,
  `tokenize` :37, needs an export); tie-break tightest fit, then name; show the reason (chosen).
  Pros: same answer in fixture and live mode; explainable in the UI; 0 calls.
  Cons: lexical only; a new route with no lists scores on its name alone.
- (b) Spark ranks the routes.
  Pros: semantic match.
  Cons: breaks fixture mode; reason not reproducible.
- (c) Embeddings.
  Pros: semantic and deterministic once computed.
  Cons: no embedding model in `meta_client.py`.

Flow shape:

- (a) Deconstruct with three checkboxes, as Kev's spec asks ("with check boxes for keywords, mnemonics, recommended
  associations"), with the dependency encoded: checking mnemonics or recommended associations auto-checks keywords;
  keywords cannot be unchecked while a dependent box is checked; a disabled box shows why (chosen).
  Pros: matches the spec; one screen; the dependency rule prevents a step without its input.
  Cons: the dependency logic lives in the checkbox state and needs its own tests.
- (b) A stepper with skip: keywords -> placements -> mnemonics (rejected; the eval's dissent).
  Pros: follows the data dependency by construction (placements need keywords; the route pick needs the keyword
  count).
  Cons: departs from the spec Kev wrote; more screens for the same three steps.

## Decision

Breakdown (a), station block (a), mnemonics (a), recommendation (a), checkboxes (a). Stored as KV `list:<id>`
`MemorizeItem {id, title, text, keywords[{label, source_quote}], route_id, placements{station_id: {record, sig}},
remember_by?, created_at}`; `Route.lists` holds a pointer; backup `lists[]` carries these items (amends 0033).
Photo-less demo stations send a sentinel JPEG with `SEND_IMAGE` False (`src/memripal/backend.py::SEND_IMAGE`, used by
`src/memripal/split.py::split_notes`), so the model never sees it.

## Why this over the others

Every chosen option either adds no prompt template or keeps the new text outside the digest, so fixture mode keeps
working on the public URL and no recorded fixture is orphaned. (b) options each add a template, a nondeterministic
ranking, or a dependency that does not exist. The checkboxes are what the spec asks for; auto-checking keywords and
locking it while a dependent is checked gives the stepper's dependency guarantee without its extra screens.

## Consequences

- The station block is a prompt-args change: new fixtures must be recorded before deploy, plus a test that every
  template digest has a fixture.
- `static/recall_match.js` exports its tokenizer.
- `remember_by` feeds the recall schedule ([0049](0049-recall-schedule-and-push-reminders.md)).
- The sentinel JPEG must never reach the model: test with `SEND_IMAGE` False.
- The checkbox dependency rules (dependents auto-check keywords; keywords locked while a dependent is checked) need
  unit tests.

## Amendment 2026-11-03: SEND_IMAGE False whenever a station block is present

A POST `/associate` carrying a `station` block `{name, profile, taps}` is sent with gen_params `send_image` False, so
a photo-less demo station's sentinel JPEG never reaches the model. Name, profile and tap values ride in a new
`ASSOCIATION_STATION` prompt template kept outside the templates digest (like `ASSOCIATION_PLACE`); the block rides in
prompt args, so it still keys the cache. Without a station neither the arg nor the `send_image` key is set, so
pre-MEM-087 request keys stay byte-identical.
