# Troubleshooting

- Missing review: verify App repository access and webhook delivery, then check
  `/healthz`. Draft PRs are skipped unless configured for automatic review.
- AI review unavailable: check bridge health and capabilities. Invalid JSON,
  schema violations, stale head SHA, unchanged-line findings, and duplicates are
  discarded by design.
- Failed scan: download the immutable evidence artifact. A missing or malformed
  scanner report fails the gate.
- Stale index: compare the stored index SHA/time with the default branch. Reinstall
  or redeliver a repository event for the PoC.
- Invalid configuration: run `guardianctl doctor OWNER/REPOSITORY`; immutable pins
  must be exactly 40 lowercase hexadecimal characters.
- Import failure: preserve artifacts, repair DefectDojo reachability/token on the
  control plane, and reimport the same test to retain deduplication.
- No image coverage: this is `not applicable` unless `image` is configured.
- DAST stops before scanning: confirm the `guardianbot-dast` environment permits
  the run, provides the ephemeral session cookie, returns 401/403 for the
  unauthenticated assertion and 2xx after authentication, and uses a duration
  between 5 and 45 minutes.

See the focused [runbooks](runbooks/README.md).
