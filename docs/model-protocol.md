# `guardian.review.v1` model protocol

A bridge implements:

- `GET /healthz`: success when it can accept traffic.
- `GET /v1/capabilities`: `BackendCapabilities`.
- `POST /v1/reviews`: accepts `ReviewRequest`, returns `ReviewResult`.

Canonical executable definitions are in `packages/protocol/src/schemas.ts` and the
published JSON contracts are in `schemas`. Requests include repository identity,
classification, PR head/base, a named administrative profile, exact valid changed
line ranges, hashed context chunks, scanner evidence, rules, and limits.

Results echo the request and head SHA; include a bounded summary, findings,
requirements, test gaps, reviewers, and backend usage metadata. Findings must:

- reference only an allowed changed-line range;
- have a unique stable fingerprint;
- include evidence, impact, and remediation;
- satisfy the canonical schema and count limit.

Unknown fields are rejected. Timeouts, unavailable bridges, malformed JSON, and
semantic validation failures become `AI review unavailable`. No result controls
the deterministic security gate.
