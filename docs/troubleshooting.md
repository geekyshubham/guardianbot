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
- Caller drift with a current pin: `upgrade` compares the complete generated caller,
  not only the `uses` SHA. This commonly occurs when `image` was added to
  `.guardianbot/config.yml` but the caller lacks `guardianbot-image`. Run
  `guardianctl upgrade OWNER/REPOSITORY` to open a regeneration PR.
- App access is `unobservable`: the active operator token cannot enumerate GitHub
  App installations. This is not proof that access is missing. Use a GitHub App
  user token that can call the installation/repository endpoints, or verify access
  in the App installation settings. An observable `missing` or `suspended` result
  must be repaired before enforcement.
- Missing expected run: `doctor` considers default-branch push, scheduled, and
  manually dispatched caller runs. The latest completed successful run must be
  within 36 hours by default, occur after the latest managed caller/configuration
  change, and have a successful `guardianbot/security-gate` check. Inspect Actions
  permissions, the default branch, schedule, generated caller, and the
  missing-scheduled-run runbook.
- Required-check mismatch: reusable jobs may appear as
  `guardianbot/security-gate / deterministic scanners`. `enforce` uses the exact
  check name observed on the latest successful commit. Remove or repair a legacy
  ruleset that requires a different context.
- Baseline not ready: commit `.guardianbot/baseline.json` with a non-empty, unique
  set of reviewed lowercase SHA-256 fingerprints. Empty or malformed baselines
  fail closed. The reusable workflow also validates the baseline on the
  enforcement PR.
- Report-only period incomplete: the seven-day clock begins with the first
  successful default-branch run after report-only configuration was committed.
  Opening the onboarding PR, a failed run, or an advisory-only period does not
  start the clock.
- Inventory says `misconfigured` instead of `missing-expected-runs`: configuration,
  pin, caller, App-access, optional image/DAST, baseline-in-enforce-mode, and
  required-rule failures take precedence over missing run evidence. Fix those
  deterministic errors first.
- Offboarding is blocked: `offboard` refuses to remove user-owned or malformed
  content at managed paths. Review the files and remove them manually in an
  auditable PR. The command retains onboarding/baseline files and never deletes
  installation events, Actions artifacts, or central App audit evidence. Remove
  the GuardianBot required rule immediately before merge, then remove App
  repository access after merge.
- Import failure: preserve artifacts, repair DefectDojo reachability/token on the
  control plane, and reimport the same test to retain deduplication.
- No image coverage: this is `not applicable` unless `image` is configured.
- DAST stops before scanning: confirm the `guardianbot-dast` environment permits
  the run, provides the ephemeral session cookie, returns 401/403 for the
  unauthenticated assertion and 2xx after authentication, and uses a duration
  between 5 and 45 minutes.

See the focused [runbooks](runbooks/README.md).
