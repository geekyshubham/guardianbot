# Scanning and policy

Semgrep scans code and Trivy scans dependencies, configuration, licenses, and
secrets. PRs use changed context; nightly runs establish full coverage.

Semgrep uses the local `guardianbot-engine/rules/semgrep.yml` checked out from the
called reusable workflow's repository at `job.workflow_sha`. The job verifies
that the caller's full immutable revision, the resolved checkout, and
`job.workflow_sha` are identical before scanning, then records that revision with
the evidence. It never selects a moving remote rule pack.

Initial onboarding is report-only. Qualifying findings are emitted as warnings in
this mode; they fail the check only after the configuration changes to `enforce`
and the repository contains a reviewed `.guardianbot/baseline.json` fingerprint
document. Scanner execution, invalid baseline documents, or missing evidence remain
visible failures in every mode.
Enforcement may block:

- new mapped High/Critical Semgrep findings;
- High/Critical dependency vulnerabilities with a known fixed version;
- scanner failure, missing evidence, or failed required import.

Licenses, historical backlog, and AI findings stay report-only during the PoC.
Suppressions require fingerprint, owner, reason, ticket, and expiry. Expired
suppressions are ignored; risk acceptance never alters source scanner evidence.

`guardianctl enforce` now refuses to create a required-check ruleset until
`scanners.mode` is already `enforce`, `guardianctl doctor` is clean, and the
baseline document is present and non-empty. The current reusable workflow still
omits full historical baseline reconciliation, but pull requests read their
configuration and baseline from the base commit so they cannot weaken their own
gate.
