# 0069: The container image sets MEMRIPAL_META_SPEND_DIR under /tmp

Status: Accepted
Relates: [0059](0059-meta-spend-guard.md) (spend guard state dir), [0061](0061-spend-cap-degrade-and-byok.md)
(degrade and BYOK state under the same dir), MEM-034.
Date: 2026-11-04

## Context

- 2026-11-04: Cloud Run revision memripal-00003 returned 500 on POST /loci.
- The Meta spend guard (0059/0061) writes state to `MEMRIPAL_META_SPEND_DIR`, else
  `Path.home()/.memripal/meta-spend`.
- The Dockerfile creates the runtime user with `useradd --no-create-home`, so `/home/memripal` does not exist and
  the guard's `mkdir` raises `PermissionError`.
- Every Meta-routed call in the image crashed, including the Baseten->Meta fallback.

## Options considered

- (A) Dockerfile `ENV MEMRIPAL_META_SPEND_DIR=/tmp/memripal/meta-spend` (chosen).
  Pros: fixes every run of the image, local `docker run` included; explicit; statically testable; one line.
  Cons: the location is still an ephemeral filesystem (see Consequences).
- (B) `scripts/deploy_cloud_run.sh` adds it to `--set-env-vars`.
  Pros: no image change.
  Cons: fixes only the deploy-script path; the image stays broken everywhere else.
- (C) Create the home dir (`useradd --create-home`).
  Pros: works with no env var.
  Cons: the state location stays implicit and relies on HOME resolution.
- (D) Code falls back to `tempfile.gettempdir()` when home is unwritable.
  Pros: survives any image without config.
  Cons: a silent fallback hides misconfiguration; changes behavior for local dev; more code.

## Decision

(A): the Dockerfile sets `ENV MEMRIPAL_META_SPEND_DIR=/tmp/memripal/meta-spend`, writable by the non-root user
with no home dir. Locked by `tests/test_deploy_artifacts.py::test_dockerfile_sets_writable_meta_spend_dir`.

## Why this over the others

(A) is the only option that fixes the image itself, explicitly, with a static test. (B) leaves every non-script
run broken; (C) works but keeps the location implicit; (D) masks the misconfiguration and adds code.

## Consequences

- Spend state lives in the instance's in-memory filesystem (Cloud Run), so the spend estimate resets when an
  instance restarts.
- The deploy runs one instance (MEM-034, `--max-instances=1`), so the cap holds per instance lifetime; acceptable
  for the hackathon judge deploy. A durable store is out of scope.
