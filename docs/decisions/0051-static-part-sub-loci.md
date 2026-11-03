# 0051: Static-part sub-loci: opt-in "Find parts" per station, SAM over a STATIC_PARTS phrase list, nested Station.sub_loci

Status: Accepted (stretch)
Relates: [0040](0040-retire-room-photo-flow.md) (note 2026-11-02, MEM-079: one fixed-structure box per station),
[0018](0018-modal-segment-cache-key-and-failures.md), [0017](0017-live-cache-in-refs-private.md),
[0033](0033-backup-v2-routes-no-coordinates.md).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), finding Dh (item 22). Kev,
2026-11-03: stretch 2.

## Context

A station photo could hold several memory slots, one per fixed part (handrail, post, shutter), shown as a SAM overlay.
The 0040 note (MEM-079) chose one fixed-structure box per station and rejected several SAM phrases per station on cost
and on largest-box bias. This ADR adds sub-loci as an explicit opt-in beside that default, not a replacement.
Constraints found:

- `src/memripal/station.py::MOVABLE_NOUNS` and `src/memripal/station.py::movable_phrase` already gate movable
  objects, but not all (executed: `movable_phrase()` is False for "tv screen" and "planter"), so it can only be a
  second gate behind an allow-list.
- `select_loci` defaults (`spacing=0.05`, `src/memripal/loci.py::select_loci`) drop close parts such as handrails,
  post and shutter; it also keeps only the largest box per phrase.
- The CSP forbids inline style.
- Fixture mode on the public URL replays recorded SAM calls; the modal provider stores keys as `"modal/" + model`
  (`src/memripal/backend.py::MetaBackend.call`) while the default is `sam-3.1`
  (`src/memripal/loci.py::SAM_MODEL`), so modal-recorded fixtures do not match a meta-mode replay.

## Options considered

- (a) Opt-in "Find parts" per station: a `STATIC_PARTS` allow-list used as the SAM phrase list, `MOVABLE_NOUNS` as a
  second gate, `select_loci(min_loci=12, max_loci=12, spacing=0.0)` with IoU > 0.5 dedupe, full-phrase labels when last
  words clash, ordered by `route_order` (`src/memripal/loci.py::route_order`); stored nested as `Station.sub_loci [{id:
  "<station.id>.<n>", n, label, box}]`; overlay drawn with `createElementNS` SVG (chosen).
  Pros: keeps 0040's one-box default and its rate budget unless the user asks; reuses loci selection and ordering;
  only permanent parts can be phrased; CSP-safe overlay.
  Cons: N SAM calls per opted-in station; a nested Station key the backup must learn.
- (b) Always segment every station into parts.
  Pros: no extra control.
  Cons: the per-station SAM cost and largest-box bias 0040 rejected, on every station.
- (c) Free SAM phrases from Spark per photo.
  Pros: adapts to any scene.
  Cons: movable objects slip through (the MEM-079 gap); nondeterministic phrase list.
- (d) Sub-loci as flat extra stations.
  Pros: no new field.
  Cons: burns `MAX_STATIONS` (8) on one place; breaks the one-station-per-stop walk.

## Decision

(a). Deploy is replay: the demo posts the committed photo's exact bytes; fixtures are recorded with
`MEMRIPAL_MODE=meta MEMRIPAL_SEG_PROVIDER=meta`, not modal, because of the `modal/` key prefix.
`scripts/promote_live_cache.py` takes only `--room` today and needs a `--photo` option to promote a station photo's
entries. Pin Pillow for the record and replay runs.

## Why this over the others

(a) is the only option that adds parts without undoing 0040's default: (b) re-adopts the rejected cost on every
station, (c) reopens the movable-object gap MEM-079 closed, and (d) spends the station cap. An allow-list phrase set
plus the existing movable gate keeps every label a fixed part.

## Consequences

- Backup export must scale `sub_loci` boxes with the 640 px thumbnail, as it does `box`
  (`static/backup_routes.js:118-127`), and `STATION_KEYS` gains `sub_loci`, accepted absent on import as `photo` is
  ([0043](0043-station-photo-optional-in-backups.md)).
- New fixtures recorded in meta mode before deploy.
- Stretch: lands only after the must-haves and 0049.
