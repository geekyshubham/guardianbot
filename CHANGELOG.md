# Changelog

All notable changes follow Keep a Changelog. GuardianBot uses semantic versioning;
reusable workflow commits remain immutable.

## [Unreleased]

### Added

- Documentation quality gates for local links and anchors, schema-backed config
  examples and references, OpenAPI examples, Mermaid SVG rendering, CLI help
  smoke tests, and release-note diff policy.
- Hardened `guardianctl` lifecycle checks for App access, immutable pins and
  caller drift, evidence freshness, report-only observation windows, required
  checks, batch upgrades, and evidence-retaining offboarding.
- Standalone DefectDojo v2 client with environment-reference configuration,
  retry/idempotency controls, deterministic resource upserts, and
  import-versus-reimport selection.
- Exact generated-caller drift detection in `guardianctl doctor`.
- Runner-generated ephemeral image-smoke environment values, referenced by key
  without storing their values in consumer repositories.
- Image evidence ordering that generates and uploads the CycloneDX SBOM before
  applying the blocking Critical-finding policy.

### Security

- The release pipeline now validates annotated SemVer tags and synchronized
  workspace versions, scans a run-scoped candidate before stable publication,
  resolves both GHCR tags to one `linux/amd64` digest, and verifies exact OIDC
  identities instead of a permissive certificate regular expression.
- Interrupted releases now resume only after existing tags pass digest,
  provenance, signature, SBOM, source-ref, and source-commit verification.
  Candidate cleanup deletes only isolated failed versions; GitHub Release assets
  are replaceable only while the release is an unpublished draft.
- Release images now carry GitHub SLSA provenance, a Cosign signature, and a
  CycloneDX attestation bound to the exact registry digest. A validated,
  keylessly signed deployment manifest hashes every verification artifact; the
  downloaded and OCI provenance bundles are verified independently.
- GitHub Release publication now rejects any attachment outside its fixed,
  checksummed asset allowlist before a draft can become public.
- Release publication permissions are isolated from source verification, every
  action remains full-SHA pinned, and the pinned Trivy v0.70.0 image replaces
  the older release scanner following upstream supply-chain hardening.
- DAST now requires the protected `guardianbot-dast` environment, proves the
  assertion is unauthorized before applying an ephemeral session cookie, caps
  runtime, avoids pull requests, and scrubs session material.
- Pull-request scanning reads configuration and baselines from the base commit,
  and expired suppressions no longer weaken deterministic findings.
- Semgrep resolves its local rule pack from the immutable called-workflow
  `job.workflow_sha` and records the verified revision with scanner evidence.
- Managed PostgreSQL supports CA-pinned TLS through
  `GUARDIANBOT_DATABASE_CA_CERT`, overriding weaker URL TLS modes.
- Metrics are closed by default and require a bearer token unless the deployment
  explicitly trusts the internal private Compose network.
- Evidence reconciliation now documents the GitHub App's Actions: read permission
  and `workflow_run` event subscription as required inputs.

### Verified

- AstraNull and RouteLens canonical images build, start with disposable
  dependencies, pass their configured health probes, complete Trivy scanning,
  and produce CycloneDX SBOMs. Both promotion paths correctly remain blocked by
  Critical image findings; see `docs/status.md`.

## [0.1.1] - 2026-07-27

### Security

- Minimized the release runtime image and removed development dependencies and the
  bundled package manager after the v0.1.0 PoC image gate detected Critical
  operating-system and `tar` findings.

## [0.1.0] - 2026-07-27

### Added

- Provider-neutral `guardian.review.v1` protocol with strict validation.
- GitHub App control plane, repository discovery, advisory review, and isolation.
- Reusable onboarding/admin CLI and versioned repository configuration.
- Semgrep/Trivy, image/SBOM/Cosign, and allowlisted ZAP workflows.
- DigitalOcean Compose deployment and release-controlled documentation.
- Tagged GHCR control-plane image release with Trivy, CycloneDX, keyless signing,
  and verification evidence.

### Known limitations

- Live GitHub App, DigitalOcean, RouteLens, and AstraNull evidence is not yet
  verified; see `docs/status.md`.
