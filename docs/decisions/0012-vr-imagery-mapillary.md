# 0012: Street-level VR imagery from Mapillary, not Google Earth

Status: Accepted (Kev approved 2026-10-26; S9 stretch)
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D20, S9, "Rejected alternatives" (Google Earth / Street View).

## Context

S9 stretch: full-immersion palaces from street-level imagery through the same segmentation -> loci -> scenes
pipeline. The hackathon bars "assets you do not have the rights to" (hackathon.md:96).

## Options considered

- Google Earth / Street View (Kev's proposal).
  Pros: Kev's proposal; none otherwise recorded.
  Cons: Maps Platform terms restrict ML analysis and derived content; disqualification risk.
- Mapillary (Meta-owned; terms verified at mapillary.com/terms, eff. 2024-02-15).
  Pros: permits app use via official API with a client_id; Meta-owned.
  Cons: logo + link back required (s.11); official API only, no scraping (s.5); no unblurring or re-identification;
  CC BY-SA imagery makes derived scenes share-alike; CC BY-NC-SA datasets must be filtered out.

## Decision

Mapillary, CC BY-SA datasets only, derived scenes labelled CC BY-SA with attribution.

## Why this over the others

Google's terms create a disqualification risk; Mapillary's terms allow the use with attribution.

## Consequences

- Register an app for a client_id (external signal).
- First cut on the D10 cut line; never blocks S0-S8.
