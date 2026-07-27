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
- new High/Critical Trivy misconfiguration findings;
- new High/Critical Trivy secret findings, without publishing the matched
  secret material;
- scanner failure, missing evidence, or failed required import.

Trivy licenses, unfixed vulnerability backlog, historical findings, and AI
findings stay report-only during the PoC. The runner keeps raw Trivy output only
in a reserved temporary evidence location, removes secret match/code fields,
normalizes all four classes independently, and deletes the raw report before
artifact publication.

Suppressions require fingerprint, owner, reason, ticket, and expiry. The
workflow verifies the baseline document's SHA-256 value, rejects duplicate
fingerprints, and evaluates expired suppressions as absent. Risk acceptance
never alters source scanner evidence.

`guardianctl enforce` now refuses to create a required-check ruleset until
`scanners.mode` is already `enforce`, `guardianctl doctor` is clean, and the
baseline document is present and non-empty. The current reusable workflow still
omits full historical baseline reconciliation, but pull requests read their
configuration and baseline from the base commit so they cannot weaken their own
gate.

Trusted workflow evidence is independently checked by the control plane against
the repository, event, exact commit, run attempt, GitHub-hosted runner, caller
workflow, reusable-workflow SHA, artifact digest, and attestation. Evidence for
different default-branch runs may be combined only when it describes the same
exact head commit. Missing or mismatched evidence cannot be converted into a
passing result by AI output.
