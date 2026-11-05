# 0081: The Meta spend counter lives in one Firestore document, updated by a transaction; failure refuses Meta

Status: Accepted
Amends: [0069](0069-container-spend-state-dir.md) (Consequences: "A durable store is out of scope"). Relates:
[0059](0059-meta-spend-guard.md) (the guard and its $135 cap), [0061](0061-spend-cap-degrade-and-byok.md) (degrade
past the cap; BYOK guards), MEM-094, MEM-121, MEM-136.
Date: 2026-11-04
Source: Kev, 2026-11-04: "can the recording of how many credits are used (145$) be in a central database in gcp like
redis, so that if the instance goes down we dont have it reset the limit and then have it go over budget" / "and if it
cannot reach the database it'll count as it reaching the limit".

## Context

- The guard's `spent.json` sits under `MEMRIPAL_META_SPEND_DIR`, which 0069 put in `/tmp` on Cloud Run: in-memory,
  per instance.
- A restart or a new instance starts the estimate at 0, so the cap can be crossed again and spend can exceed the $150
  Meta credit (Meta's own limit only notifies).
- `--max-instances=1` limits concurrency but not restarts; a redeploy also starts a fresh instance.

## Options considered

- (A) Firestore (Native mode), one document (`memripal/meta-spend`, field `spent_usd`), each charge a transaction that
  reads, checks `spent + cost <= cap`, and writes (chosen).
  Pros: serverless, no VPC; the free tier covers one small read and write per Meta call; the transaction is an atomic
  check-and-increment with optimistic retry on contention, so concurrent instances never jointly pass the cap; IAM via
  the existing runtime service account (`roles/datastore.user`).
  Cons: one network round-trip per Meta call; a new API, database and seed step to set up once.
- (B) Memorystore for Redis, `INCRBYFLOAT` or a Lua check-and-increment.
  Pros: atomic; very low latency.
  Cons: Cloud Run needs a Serverless VPC Access connector or Direct VPC egress; about $35/month minimum; an instance to
  provision; too much setup for today's deadline.
- (C) A GCS object written with `ifGenerationMatch` preconditions.
  Pros: works; cheap; no new service.
  Cons: a hand-rolled compare-and-swap retry loop; higher latency; more code to get right.
- (D) Keep the `/tmp` file (0069, status quo).
  Pros: no change.
  Cons: resets on every restart, the overspend this ADR exists to stop.

## Decision

(A). `MetaSpendGuard` takes a pluggable store:

- `FileSpendStore`: the unchanged `spent.json`; dev and fixture mode; BYOK per-key guards (0061) stay on it, since
  BYOK spends the user's own key, not our credit.
- `FirestoreSpendStore`: the transaction above; doc `MEMRIPAL_META_SPEND_FIRESTORE_DOC` (default
  `memripal/meta-spend`); project `GOOGLE_CLOUD_PROJECT` (optional); the client is built lazily, so building the guard
  never touches the network.
- Selected by `MEMRIPAL_META_SPEND_STORE=file|firestore` (default `file`; any other value fails startup).
- Fail closed: any store error, a 5 s timeout, an auth failure, a missing doc or invalid data raises
  `MetaSpendCapReached` and sends nothing; chat then uses the Baseten/Fireworks backup and other calls degrade per
  MEM-121, unchanged.
- A missing doc is refused, never treated as 0: `scripts/seed_meta_spend.py --usd N [--doc PATH] [--project P]` sets
  `spent_usd = max(existing, N)` (never lowers; refuses to overwrite invalid data).
- `scripts/deploy_cloud_run.sh` in meta mode sets `MEMRIPAL_META_SPEND_STORE=firestore` and grants the runtime service
  account `roles/datastore.user` (project level, idempotent). The cap stays `MEMRIPAL_META_SPEND_CAP_USD` (default
  135).

## Why this over the others

(A) is the only durable option that is atomic out of the box and needs no network plumbing. (B) is atomic but needs a
VPC path and a paid instance; (C) is cheap but makes us write and test our own CAS loop; (D) is the bug.

## Consequences

- One Firestore round-trip (tens of ms) per Meta call.
- The first deploy refuses every Meta call until the counter is seeded (`docs/runbooks/deploy-gcp.md`).
- Firestore unreachable = Meta off, by design (Kev's ask); judges keep the backup chat and saved results.
- BYOK spend stays per instance on the file store (the user's own key).
