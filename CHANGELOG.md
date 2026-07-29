# Changelog

All notable changes follow Keep a Changelog. GuardianBot uses semantic versioning;
reusable workflow commits remain immutable.

## [Unreleased]

### Changed

- `guardianctl upgrade` now applies the same validated image and DAST override
  contract as onboarding, so existing repositories can enable DAST through one
  generated configuration-and-caller PR.

### Documentation

- Recorded the signed `v0.2.14` DigitalOcean control-plane deployment, the
  13/13 active and indexed repository inventory, all 13 onboarding issues, and
  the successful RouteLens and AstraNull exact-image validation, SBOM,
  keyless-signing, immutable GHCR promotion, exact-digest staging, protected
  route, positive authentication, OIDC role/tenant/MFA, and cross-repository
  isolation evidence, plus pinned authenticated ZAP passive-smoke results.

## [0.2.14] - 2026-07-29

### Fixed

- Dockerfile auto-detection now matches exact repository-relative paths instead
  of treating a basename such as `Dockerfile` as a reference inside
  `ops/digitalocean/Dockerfile`.
- Generated image ports are now scoped to the selected Dockerfile, including a
  `guardianctl onboard --dockerfile` override, so unrelated container
  definitions cannot replace the runtime port.

### Documentation

- Recorded the live signed-digest `v0.2.13` DigitalOcean deployment and the
  successful all-repository GitHub App replay: 13 repository records, 13
  immutable indexes, 13 onboarding issues, live monitoring snapshots, and the
  measured 4 GB memory requirement for Swift Tree-sitter indexing.

## [0.2.13] - 2026-07-29

### Fixed

- Repository indexing now deduplicates identical content-derived symbols
  emitted by overlapping parser queries. Generated and minified JavaScript can
  no longer produce duplicate PostgreSQL vector conflict keys during
  all-repository GitHub App discovery.

## [0.2.12] - 2026-07-29

### Fixed

- GitHub App installation discovery now hydrates compact repository objects
  through the installation-scoped repository endpoint before reading the
  default branch. Fresh all-repository installations no longer attempt to
  resolve an `undefined` Git tree.

### Documentation

- Recorded the live signed-digest `v0.2.11` DigitalOcean App Platform
  deployment, authenticated annotated-tag/default-branch verification, exact
  workflow trust pins, protected endpoint checks, and the explicit absence of
  returned runtime log lines without publishing secrets.

## [0.2.11] - 2026-07-28

### Added

- DigitalOcean deployment profiles can atomically promote an allowlisted mix of
  App Platform services, workers, and jobs to one exact signed GHCR digest.
- DAST sessions now require accepted DigitalOcean deployment evidence for the
  same default-branch SHA, environment, origin, and immutable digest. The
  deployed digest is carried through the target credential exchange, ZAP
  evidence, monitoring, and DefectDojo tags.
- The DefectDojo droplet definition now binds every operational stack file to a
  SHA-256 manifest and exact GuardianBot source commit, with cloud-init SSH/UFW
  hardening and runtime drift verification.
- A guarded live DefectDojo import/reimport conformance command uses a
  non-secret empty Semgrep fixture.

### Fixed

- Empty Trivy filesystem results now normalize to a valid schema-v2 report
  while malformed reports and scanner failures remain fail-closed.
- Generated image runtime environments now ignore blank and comment-only lines
  without accepting malformed entries.
- DAST no longer runs on a default-branch push before deployment. Scheduled and
  manual runs retain only `GET`, `HEAD`, and `OPTIONS` operations, remove
  webhooks, and constrain all OpenAPI/Swagger servers to the exact staging
  origin.
- DefectDojo engagement creation supplies validated target dates and first
  imports no longer create incomplete Test records manually.

### Documentation

- Recorded the live signed-digest `v0.2.10` DigitalOcean App Platform
  deployment, authenticated annotated-tag/default-branch verification, exact
  workflow trust pins, protected endpoint checks, and clean startup-log
  evidence without publishing secrets.

## [0.2.10] - 2026-07-27

### Fixed

- Upgrade pull requests now bind scanner policy, suppressions, and baselines to
  the immutable base commit while validating the proposed workflow identity
  from the head configuration. The head pin must still equal GitHub's exact
  called-workflow SHA before any scanner runs.

## [0.2.9] - 2026-07-27

### Fixed

- Suppression validation now uses `yq`'s condition-aware `all_c` operator.
  The prior jq-style `all(condition)` expression was rejected by the pinned
  `yq` release before Semgrep or Trivy could start.

### Documentation

- Recorded the live signed-digest `v0.2.8` DigitalOcean App Platform
  deployment, exact workflow trust pins, database-backed readiness, protected
  endpoint checks, and clean startup-log evidence without publishing secrets.

## [0.2.8] - 2026-07-27

### Fixed

- Reusable scanner configuration parsing now runs the pinned read-only `yq`
  container as the GitHub-hosted runner's UID and GID, preserving the
  owner-only evidence directory while allowing base-commit policy files to be
  validated on upgrade pull requests.
- Scanner provenance attestation now starts only after configuration validation
  and immutable rule-pack verification succeed, avoiding a misleading missing
  checkout error when an earlier setup step fails.

### Documentation

- Recorded the live signed-digest `v0.2.7` DigitalOcean App Platform
  deployment, database-backed readiness, protected endpoint checks, and
  rollback evidence without publishing credentials or database connection
  details.

## [0.2.7] - 2026-07-27

### Fixed

- Release evidence now accepts Cosign's current single DSSE-envelope
  verification output and validates that its in-toto subject, image digest, and
  CycloneDX predicate exactly match the release image and generated SBOM.

## [0.2.6] - 2026-07-27

### Fixed

- GitHub provenance verification now uses its exact certificate identity without
  the mutually exclusive signer-workflow selector while retaining repository,
  issuer, source commit, source ref, and hosted-runner enforcement.
- DigitalOcean deployment verification now compares the canonical lowercase
  GitHub repository identity emitted into signed release manifests.

## [0.2.5] - 2026-07-27

### Fixed

- Model-backend request deadlines now use a referenced abort timer covering both
  response headers and body consumption, so a completely hung compatible
  endpoint cannot outlive its fail-closed startup probe in a short-lived
  process.

## [0.2.4] - 2026-07-27

### Fixed

- Tag-triggered release checks now supply the immutable release commit's first
  parent as the documentation policy diff base, preserving fail-closed release
  notes without depending on pull-request-only event fields.

## [0.2.3] - 2026-07-27

### Fixed

- Clean-checkout type checking now builds declaration output for the DefectDojo
  and monitoring packages before checking the control plane, eliminating a
  hidden dependency on locally cached `dist` directories.

## [0.2.2] - 2026-07-27

### Fixed

- Release verification now resolves the remote annotated tag object and default
  branch commit through authenticated GitHub APIs, so detached tag checkouts do
  not depend on locally materialized tag or remote-tracking references.

## [0.2.1] - 2026-07-27

### Fixed

- Release source ancestry is now proven with GitHub's authenticated compare API
  instead of assuming that a tag checkout creates a local
  `refs/remotes/origin/main` reference.

## [0.2.0] - 2026-07-27

### Added

- A one-time DAST session broker that binds an exact repository, workflow SHA,
  GitHub-hosted runner, protected environment, target origin, run attempt, and
  default-branch commit before exchanging an ephemeral staging credential.
- Separate authenticated ZAP smoke and nightly evidence/import identities so a
  frequent smoke run cannot satisfy the nightly full-scan requirement.
- Full Trivy vulnerability, misconfiguration, secret, and license
  normalization with class-specific policy decisions and secret-detail
  redaction.
- A central, repository-neutral DigitalOcean App Platform promotion reconciler
  that updates only allowlisted GHCR services to the signed image digest and
  records health-verified deployment evidence.
- Signed-release deployment entry points for DigitalOcean droplets and App
  Platform, with canonical asset, signature, attestation, provenance, source,
  workflow-identity, and exact-running-digest verification.
- Durable DAST issuance and deployment-promotion leases, exact signed/deployed
  image reconciliation, and weekly image-protection coverage.
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

- DAST credentials no longer come from consumer-repository secrets. The
  reusable workflow obtains a one-time credential from the control plane using
  GitHub OIDC; target-side exchange is the normal mode and static credentials
  require an explicit PoC-only control-plane switch.
- Scanner and image workflows reject repository-controlled evidence paths,
  symlinks, incomplete reports, invalid baseline hashes, and mismatched reusable
  workflow identities. Temporary raw Trivy secret matches are scrubbed before
  artifact publication.
- Scanner fingerprints now use one canonical implementation in the workflow and
  control plane; ingestion independently rejects incomplete Semgrep/Trivy
  documents or gate fingerprints that do not exist in normalized evidence.
  Existing PoC baselines and suppressions using the earlier workflow
  fingerprint remain accepted during migration.
- Reusable workflows bound GitHub OIDC and evidence-attestation JSON responses
  before parsing instead of trusting an unbounded response body.
- Monitoring now separates evidence identity from artifact digest, combines
  trusted evidence for the same exact default-branch commit, and requires a
  registry digest whose signing and deployment evidence agree.
- DigitalOcean promotion is restricted to a hard-coded API origin, exact
  centrally configured app/repository/service/image identities, bounded API
  responses, immutable digests, and post-deployment health/readiness probes.
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
