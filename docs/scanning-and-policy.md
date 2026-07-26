# Scanning and policy

Semgrep scans code and Trivy scans dependencies, configuration, licenses, and
secrets. PRs use changed context; nightly runs establish full coverage.

Initial onboarding is report-only. Existing fingerprints form the baseline.
Enforcement may block:

- new mapped High/Critical Semgrep findings;
- High/Critical dependency vulnerabilities with a known fixed version;
- scanner failure, missing evidence, or failed required import.

Licenses, historical backlog, and AI findings stay report-only during the PoC.
Suppressions require fingerprint, owner, reason, ticket, and expiry. Expired
suppressions are invalid; risk acceptance never alters source scanner evidence.

The current reusable workflow implements severity policy but full base/head
fingerprint reconciliation is Partial. Do not enable enforcement solely on the PoC
workflow until `guardianctl doctor` and a human baseline review are clean.
