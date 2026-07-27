# Scanning and policy

Semgrep scans code and Trivy scans dependencies, configuration, licenses, and
secrets. PRs use changed context; nightly runs establish full coverage.

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
suppressions are invalid; risk acceptance never alters source scanner evidence.

`guardianctl enforce` now refuses to create a required-check ruleset until
`scanners.mode` is already `enforce`, `guardianctl doctor` is clean, and the
baseline document is present and non-empty. The current reusable workflow still
uses a checked-in baseline snapshot rather than full base/head historical
reconciliation.
