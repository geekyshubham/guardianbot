# Security model

GuardianBot protects GitHub installation credentials, repository contents,
review evidence, model-backend credentials, scanner artifacts, signing
identity, DigitalOcean deployment authority, DAST sessions, DefectDojo
evidence, and PostgreSQL state.

## Trust boundaries

### GitHub App and webhooks

GitHub App tokens are installation-scoped and short-lived. Incoming webhooks
require HMAC SHA-256 verification, a bounded body, a unique delivery ID, and
durable replay protection. The App has read-only Actions/Contents access and
read/write Issues/Pull requests access; repository Administration remains an
operator action in `guardianctl`.

Scanner evidence is accepted only after the control plane verifies the GitHub
workflow run, repository, commit, event, run attempt, GitHub-hosted runner,
caller workflow, exact reusable-workflow SHA, artifact digest, and signed
attestation. Consumer repositories cannot substitute their own evidence
directory or symlink.

### Repository content and isolation

Repository files, diffs, issues, commit messages, generated files, scanner
output, OpenAPI documents, and documentation are untrusted data. They cannot
select a backend URL, credential, provider, model ID, tool, DigitalOcean app, or
DAST origin.

Every index and review is labeled by numeric repository ID, visibility, and
commit. Related-repository retrieval requires a bilateral administrative
allowlist. Private or internal context never flows into a public review. Review
context is size bounded and the model sees only the selected commit-scoped
bundle.

### Model bridge

The control plane speaks only `guardian.review.v1`; provider details live
behind the isolated bridge. Models receive no tools, GitHub access, control
plane token, backend credential, or arbitrary network capability from
GuardianBot. Repository context is explicitly delimited as untrusted data.

The Responses adapter requests native strict Structured Outputs with
`tools: []` and `store: false`. `store: false` is not represented as zero
retention: the bridge advertises `retention: none` only after an administrator
asserts that Zero Data Retention is actually approved and configured.

Every result must match the canonical schema and pass independent request ID,
head SHA, file, changed-line, evidence, severity, count, fingerprint, and
duplicate validation. Refusals, malformed or oversized bodies, stale results,
timeouts, and unavailable backends become advisory `AI review unavailable`.
They never weaken deterministic checks.

### Image deployment and DAST

Image promotion is bound to a registry digest, GitHub OIDC workflow identity,
CycloneDX SBOM, signature, and provenance. DigitalOcean deployment authority
exists only in central allowlist profiles. The reconciler can update only the
configured App Platform app, named services, and GHCR image source, then must
observe the same active digest and successful health/readiness probes.

DAST requires an exact public HTTPS origin, a safe repository or same-origin
OpenAPI document, a protected environment, and a one-time OIDC-bound session.
The normal broker mode exchanges a central secret at a same-origin target
endpoint for a short-lived credential. Static credentials require an explicit
PoC-only switch. The workflow proves protected access fails without the
credential before testing authenticated routes.

Production, localhost, link-local, private-address, cross-origin, redirected,
destructive, and explicitly excluded routes are prohibited.

### Data stores and networks

PostgreSQL, DefectDojo, and optional staging dependencies remain on
DigitalOcean. Managed PostgreSQL uses its CA through
`GUARDIANBOT_DATABASE_CA_CERT`; private Compose PostgreSQL is not exposed
publicly. Public `/metrics` access is closed by default.

Consumer repositories contain no model, DefectDojo, database, DigitalOcean,
DAST, evidence-signing, or GitHub App secret. Repository configuration contains
only opaque profile references.

## Threats and failure isolation

Primary threats include prompt injection in code, malicious pull-request
workflows, webhook forgery or replay, cross-repository leakage, compromised
bridge output, evidence substitution/deletion, artifact path attacks, mutable
image tags, DigitalOcean target confusion, session replay, staging-to-production
confusion, and supply-chain identity movement.

The principal failure-isolation rules are:

- AI output is always advisory.
- Scanner crashes, invalid baselines, missing artifacts, missing imports, or
  identity mismatches fail deterministic evidence.
- A model-backend outage does not block deterministic security jobs.
- A DAST or deployment profile authorizes exactly one repository/target
  relationship.
- Scheduled findings may freeze future promotion but do not interrupt a running
  workload.
- Removing App access stops new control-plane actions without deleting retained
  audit evidence.

Residual PoC limitations and live-verification gaps are tracked in
[capability status](status.md). Production operation additionally requires
tested secret rotation, backups/restores, rate limits, audit export, dependency
patching, alert delivery, and incident drills.
