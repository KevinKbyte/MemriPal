# 0027: /scenes renders only HMAC-signed association records; per-instance random key when unset

Status: Accepted
Date: 2026-10-28
Source: MEM-036 (`.claude/spec-cache/memripal/references/spec-2.md`); `src/memripal/record_sign.py`,
`associate.py`, `app.py` /scenes, `static/scenes.js`; tests `tests/test_record_sign.py`,
`static/app_record_sign.test.mjs`; GREEN commit `67e59af`. Prerequisite for plan S7 on
[0025](0025-passcode-gate-and-host-allowlist.md).

## Context

/scenes accepted any client-supplied record, so a caller could put arbitrary prompt text into the paid Meta
image-edit call (prompt injection, budget abuse) on the public S7 deploy. The backend keeps no per-user state
([0003](0003-stateless-backend-client-state.md)), so the record must round-trip through the client.

## Options considered

Chosen option first in each item.

- (a) Record integrity. /associate signs each valid record: lowercase hex HMAC-SHA256 over
  `json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`; /scenes verifies.
  Pros: stays stateless; any edited field fails.
  Cons: client must store `sig` beside the record. Alternative: server-side session store of records
  (violates 0003).
- (b) Key source. `MEMRIPAL_RECORD_KEY` (stripped, UTF-8); blank or unset -> 32 random bytes per app instance.
  Pros: local/dev runs need no setup.
  Cons: signatures do not survive a restart or span Cloud Run instances. Alternative: require the env (breaks
  local/dev ergonomics).
- (c) Forged-signature status. 403 `bad_signature`, checked before record caps, photo decode or any model call.
  Pros: separates authenticated-but-forged from malformed.
  Cons: one more status for the client. Alternative: 400.

## Decision

The chosen option in each of (a)-(c). /scenes body is exactly {image, box, record, sig}; any other key set
(incl. missing `sig`) -> 400 `bad_request`; a non-str or mismatched `sig` (incl. uppercase hex) -> 403. Compare
with `hmac.compare_digest` on bytes. `spatial`, `visual`, `scene_prompt_details` capped at 300 chars on both
routes, so every signed record passes /scenes caps. The client skips an unsigned stored entry as tier 3
"unsigned" without a request. Both fixture and live modes.

## Why this over the others

Signing keeps 0003's stateless backend while closing the injection path at the cheapest point: before any
decode or paid call. A random fallback key fails closed (old signatures stop verifying) rather than open.

## Consequences

- Palaces stored before 0.11.0 have no `sig`; their scenes show tier 3 until regenerated.
- Multi-instance or restart-surviving deploys must set a shared `MEMRIPAL_RECORD_KEY`.
