# Scanning and policy

Semgrep scans code and Trivy scans dependencies, configuration, licenses, and
secrets. PRs use changed context; nightly runs establish full coverage.

Semgrep uses the local `guardianbot-engine/rules/semgrep.yml` checked out from the
called reusable workflow's repository at `job.workflow_sha`. The job verifies
that the caller's full immutable revision, the resolved checkout, and
`job.workflow_sha` are identical before scanning, then records that revision with
the evidence. It never selects a moving remote rule pack.

Organization Semgrep severity is versioned in the same rule pack: each rule in
`rules/semgrep.yml` carries `metadata.guardianbot-severity` (`critical`, `high`,
`medium`, `low`, or `info`), so the mapping is read from the verified checkout at
`job.workflow_sha` and cannot be changed by the scanned repository. A mapped
severity replaces Semgrep's native severity. A finding from a rule with no valid
mapping falls back to its native severity (`ERROR` maps to high, `WARNING` to
medium, `INFO` to info). Such findings record `severitySource: "native"` in
`gate.json` policy findings, and the job summary flags the rule as having no
policy severity mapping. Only policy-mapped Critical/High Semgrep findings can
fail the gate in enforce mode: an unmapped native `ERROR` is reported as a High
warning but never blocks. A test requires every rule in the shipped pack to
carry a mapping and keeps the workflow and `@guardianbot/core` severity tables
and blocking rule in agreement. Severity and its source are not fingerprint inputs, so mapping
changes never invalidate baselines or suppressions.

By default the generated caller runs on pull requests (any base branch) and on
pushes to the default branch. Setting `scanners.releaseBranches` limits
`pull_request` to the default branch plus those release branches and adds them to
`push`. Release-branch runs use the same report-only/enforce policy, but image
promotion stays bound to `refs/heads/<default>` and DAST stays on schedule and
manual dispatch. Release-branch push runs are not default-branch evidence:
`guardianctl doctor`, report-only observation, and control-plane monitoring
ignore them, and DefectDojo imports for them never close old findings.

Initial onboarding is report-only. Qualifying findings are emitted as warnings in
this mode; they fail the check only after the configuration changes to `enforce`
and the repository contains a reviewed `.guardianbot/baseline.json` fingerprint
document. Scanner execution, invalid baseline documents, or missing evidence remain
visible failures in every mode.

Enforce authorization requires a strict `guardianbot.baseline.v1` document:

- `schemaVersion`: `guardianbot.baseline.v1`
- `fingerprints`: unique lowercase SHA-256 digests (may be empty only for this
  versioned shape)
- `generatedAt`: canonical RFC3339 UTC generation timestamp
- `source`: the successful report-only deterministic gate that supplied the
  current fingerprints (`gateSha256`, `mode: "report-only"`, `repository`,
  `headSha`, `runId`, `runAttempt`)
- `observation`: the first qualified report-only `push` / `workflow_dispatch`
  gate that started the minimum seven-day clock (`repository`, `headSha`,
  `runId`, `runAttempt`, `startedAt`)

`source.repository` and `observation.repository` must match. Legacy arrays and
versionless objects are not authorized for enforce mode.

The same mode is passed explicitly to image validation. Image builds, runtime
smoke, Trivy, SBOM generation, and evidence attestation must succeed in every
mode. Existing Critical image findings are retained in the signed policy
evidence and emitted as warnings during `advisory` and `report-only`; they become
blocking when the repository is promoted to `enforce`.

Enforcement may block:

- new policy-mapped High/Critical Semgrep findings (unmapped rules are
  reported at native severity but never block, as above);
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

`guardianctl baseline` opens a draft PR containing only
`.guardianbot/baseline.json` from a strict report-only `gate.json` artifact that
includes repository, head SHA, run ID, and run attempt provenance. It also
persists the independently verified first observation-run proof that started the
seven-day clock, and rejects an observation repository different from the
source repository. Use it after the observation period so clean repositories can
record an empty versioned baseline instead of hand-authoring JSON.
`generatedAt` records generation only; human review evidence is the baseline
PR's review and merge. Fingerprint acceptance remains a privileged
admin/human-review trust boundary: the workflow attests provenance and age, it
does not auto-reconcile or invent backlog from control-plane history.
`guardianctl enforce` refuses promotion until `guardianctl doctor` is clean for
enforcement, the observation period is complete, and a baseline is present.
Empty legacy baselines remain rejected; only a versioned baseline with canonical
`generatedAt` and full source plus observation provenance may be empty. Older
gate artifacts without provenance fail closed and must be regenerated by
re-running the security gate.

On non-PR enforce-mode runs, the reusable security workflow executes a
fail-closed runtime readiness verifier before Semgrep. Using only the job's
scoped GitHub token (`actions: read`; no consumer secret or control-plane
dependency), it revalidates both provenance runs through GitHub API run-attempt
metadata, the exact successful deterministic scanner job, report-only config at
each head SHA, and exact `referenced_workflows` reusable-security identity
pinned to the immutable `workflowVersion`. The observation run must be at least
seven days old. An active default-branch GuardianBot ruleset must strictly
require `guardianbot/security-gate / deterministic scanners`. The source and
observation runs must be default-branch runs; release-branch runs are never
enforcement evidence. Release-branch rulesets are reported by `guardianctl
doctor` but not verified here. Missing, invalid,
or unauthorized API evidence fails closed. Pull requests still read their
configuration and baseline from the base commit so they cannot weaken their own
gate; PR checks remain report-only because they bind base-branch configuration.

Trusted workflow evidence is independently checked by the control plane against
the repository, event, exact commit, run attempt, GitHub-hosted runner, caller
workflow, reusable-workflow SHA, artifact digest, and attestation. Evidence for
different default-branch runs may be combined only when it describes the same
exact head commit. Missing or mismatched evidence cannot be converted into a
passing result by AI output.
