# Changelog

All notable changes follow Keep a Changelog. GuardianBot uses semantic versioning;
reusable workflow commits remain immutable.

## [Unreleased]

## [0.2.35] - 2026-07-30

### Fixed

- Internal GitHub repository visibility routes model reviews as `restricted`
  (automated evidence only; no live production AI review is claimed).
- `authenticated-full` DAST is schedule-only at the generated caller and the
  session broker; `scanProfile` is request- and lease-bound; baseline (≤15 min)
  and full (≥30 / ≤45 min) minute constraints fail early. Manual
  `workflow_dispatch` remains baseline-only. Live scheduled full is still
  pending.
- `guardianctl doctor` / `inventory` select `guardianbot/security-gate` evidence
  from the most recent fresh GuardianBot run that actually emitted the gate,
  using Actions job metadata (or check-run URLs that reference that run id).
  A later successful DAST-only schedule that intentionally skips the gate no
  longer shadows a valid push/security gate on the same SHA. Only `schedule`
  may omit or skip the gate; a later `push` or `workflow_dispatch` with a
  missing or skipped gate fails closed and cannot reuse an older success. A
  scheduled run with a non-skipped failed gate also fails closed; a
  non-skipped successful scheduled gate remains valid security evidence. Job
  and check-run listings are bounded to a safe page cap and fail closed if
  exhausted. Seven-day report-only observation starts only from a successful
  default-branch `push` or `workflow_dispatch` whose exact run has a present,
  non-skipped, successful security gate (scheduled runs never start the clock;
  onboarding normally starts it via the merge push).
- `guardianctl enforce` draft PR body no longer claims an enforcement-mode pull
  request check. PR checks stay report-only because they bind base-branch
  configuration; merge only after ordinary checks and human review, then verify
  the first enforce-mode default-branch gate immediately and revert or disable
  on failure.
- `guardianctl inventory` no longer treats the all-zero CLI placeholder as an
  administrative workflow target. Without `GUARDIANBOT_WORKFLOW_SHA`, inventory
  derives the expected pin from each repository's validated config or consistent
  caller pins, still rejects mutable/zero/mismatched pins, and continues to
  surface drift, schema, run, and evidence failures. An explicit published SHA
  still flags repositories behind that target. `upgrade` and `upgrade --all`
  continue to require an immutable operator-supplied SHA.

### Evidence

- Live GuardianBot v0.2.34 release/control-plane rotation, generic fleet
  upgrade (18 merged PRs), RouteLens and AstraNull Critical-clean
  `verified-default-branch` promotion with exact-digest ACTIVE DigitalOcean
  deployments, RouteLens genuine scheduled `authenticated-baseline` DAST with
  DefectDojo Test ID 5 reimport, and post-fix no-target-SHA inventory
  (19 visible / 16 report-only / 2 advisory-only / 1 not-applicable fork /
  zero misconfigured / zero missing-expected-runs). See
  [v0.2.34 live fleet and scheduled DAST evidence](docs/evidence/v0.2.34-live-fleet-and-scheduled-dast.md).
  Scheduled `authenticated-full`, current AstraNull v0.2.34 scheduled baseline,
  seven-day enforcement observation, production model credential, and
  DefectDojo HA/restore/least-privilege hardening remain out of scope for this
  evidence.
- Live RouteLens and AstraNull proof of v0.2.33
  `verified-default-branch` image promotion: Critical-clean build/smoke/Trivy/
  SBOM, promote-job recheck, GHCR immutable push, Cosign signing, exact-digest
  ACTIVE DigitalOcean deployments, and manual authenticated-baseline DAST.
  Scheduled authenticated-full nightly DAST, DefectDojo import of these two
  new runs, seven-day enforcement observation, and production model credential
  remain out of scope for this evidence.

## [0.2.34] - 2026-07-30

### Added

- `guardianctl baseline` opens a draft PR with `.guardianbot/baseline.json`
  from a provenance-bound successful report-only `gate.json` after the minimum
  seven-day observation period. It never switches scanner mode, never changes
  rulesets, and never merges; human review of the draft remains required.
- Authoritative control-plane webhook queue gauges for pending, leased,
  dead-letter, and runnable depth, refreshed from the shared store on
  `/metrics` scrape (fail closed with `503` if the store refresh fails).
- Bounded terminal webhook job retention/cleanup for `succeeded` and
  `dead-letter` rows only, with multi-instance-safe batch deletes and
  environment-bounded retention defaults.
- Real HTTP loopback model-bridge protocol-client conformance coverage, plus
  fail-closed schema-invalid request handling (`400` `bad_request`) and
  sanitized non-leaking provider/internal failures.

### Changed

- Pull-request command documentation matches the implemented command surface:
  `review`, `full-review`, `explain <id>`, `suggest-fix <id>`, `status`,
  `pause`, `resume`, and `help`.
- Documentation quality gate accepts `guardianbot-config=none` for structured
  non-configuration examples such as baseline documents.
- Generic `guardianctl upgrade --all` generated the GuardianBot self-upgrade
  PR and moved its caller/config pin to the immutable v0.2.34 commit
  `eb22366454ec6e37d38b700aeada4d8a9899635b`, with report-only image
  publication remaining `enforce-only`.

### Security

- Model-bridge request validation rejects schema-invalid and malformed review
  bodies before adapter dispatch; adapter/output validation failures stay
  backend faults and do not leak prompts, credentials, endpoints, or provider
  bodies.
- Webhook terminal cleanup never deletes pending or leased jobs; purge limits
  and retention bounds fail closed at process boot when misconfigured.

## [0.2.33] - 2026-07-30

### Added

- Optional `image.deployment.promotionMode` (`enforce-only` default, or
  `verified-default-branch`) and matching `guardianctl --image-promotion`
  override for onboard/upgrade.
- Explicit `verified-default-branch` allows Critical-clean default-branch image
  promotion while scanner mode remains `report-only`; omitted config stays
  `enforce-only` and is backward-compatible.

### Security

- Image promotion requires Critical-clean Trivy evidence and a permitted
  promotion mode; the promote job rechecks that evidence before signing or
  publishing.
- The control plane independently rejects Critical-bearing image-promotion
  artifacts before any DigitalOcean promotion.

## [0.2.32] - 2026-07-30

### Fixed

- Documentation-only onboarding reports now state their effective `advisory`
  scanner mode instead of incorrectly describing the rollout as
  `report-only`.

### Evidence

- Added live fresh-repository acceptance evidence for generic Python, Node,
  Swift, Ruby, Docker, and documentation-only onboarding, including App
  discovery, generated PRs, deterministic scans, advisory failure isolation,
  exact-image validation, first-run timing, and the 19-repository inventory.

## [0.2.31] - 2026-07-30

### Fixed

- Onboarding-issue creation is now serialized per GitHub repository with a
  database-wide advisory lock. Concurrent webhook workers recheck the
  idempotency marker after taking the lock instead of creating duplicate
  inventory issues.
- The in-memory store implements the same queued lock handoff, with regression
  coverage for concurrent service instances.

## [0.2.30] - 2026-07-30

### Fixed

- Generated image callers now pass the repository scanner mode explicitly.
  Advisory and report-only validation retains and attests Critical image
  findings as warnings without publishing the image; enforcement mode keeps
  Critical findings blocking.
- Scanner failure, runtime smoke failure, missing SBOM, and missing evidence
  remain blocking in every mode.
- GuardianBot's own generated caller is rotated to the v0.2.30 workflow
  identity with report-only image publication disabled.

## [0.2.29] - 2026-07-30

### Fixed

- Repository detection now rejects arbitrary tokens such as status constants as
  health routes, scopes dependency inference to image-related files, and
  infers subdirectory Docker build contexts from `COPY` sources.
- Image validation now polls readiness within the same bounded window as
  liveness instead of failing on the first transient readiness response.
- GuardianBot's exact control-plane image has a test-only, credential-free
  smoke mode that exposes only liveness and readiness; production mode still
  requires the complete GitHub App and database configuration.

### Evidence

- Corrected GuardianBot's generated image-smoke profile to use `/healthz` and
  `/readyz` on port 3000 without unrelated PostgreSQL or Redis dependencies.
- Added live AstraNull v0.2.28 evidence for the generic upgrade PR, exact
  signed-digest DigitalOcean deployment, provenance-attested ZAP JSON/XML
  artifact, and stable same-Test-ID DefectDojo reimport.
- Added live RouteLens v0.2.28 evidence for the generic upgrade PR, atomic
  reusable-workflow trust rotation, exact signed-digest staging deployment,
  provenance-attested ZAP JSON/XML artifact, and same-Test-ID DefectDojo XML
  reimport with scanner-native findings.

## [0.2.28] - 2026-07-29

### Fixed

- The reusable DAST workflow now generates and provenance-attests both ZAP JSON
  and ZAP XML reports. GuardianBot continues to normalize the bounded JSON
  report, while DefectDojo receives the XML format required by its `ZAP Scan`
  parser.
- DAST ingestion accepts the exact legacy two-report manifest as well as the
  new three-report manifest, so upgrading the control plane does not invalidate
  evidence from repositories still pinned to an older reusable workflow.
- A successful legacy DAST artifact explicitly records that its DefectDojo ZAP
  import needs a v0.2.28-or-newer workflow instead of retrying an incompatible
  JSON payload indefinitely.

## [0.2.27] - 2026-07-29

### Fixed

- The hardened DefectDojo Valkey service now starts directly as the
  digest-pinned image's non-root `999:1000` account with all capabilities
  dropped. Fresh-volume persistence and graceful restart no longer depend on a
  root entrypoint or filesystem-override and signal capabilities.
- The DefectDojo uWSGI health probe now sends the configured public host and
  trusted HTTPS proxy scheme while connecting only over the container loopback,
  avoiding a false `DisallowedHost` failure without allowlisting localhost.
- The internal Nginx health probe now preserves the same public host and HTTPS
  proxy scheme, preventing false redirects or host rejections before Caddy is
  started.
- Caddy active upstream checks now set the configured public host and HTTPS
  proxy scheme, so a healthy Nginx/uWSGI path is not withdrawn as unavailable.
- DefectDojo evidence tags now canonicalize spaces, commas, and quotes before
  API submission, including scanner names and custom tags, while preserving a
  stable sorted and de-duplicated identity.

### Evidence

- Added live v0.2.27 DigitalOcean DefectDojo evidence for the dedicated
  Droplet, private managed PostgreSQL TLS, public HTTPS doctor check, consistent
  backup, central runtime secret connection, and same-Test-ID API
  import/reimport.
- Added live v0.2.26 AstraNull evidence for the generic upgrade PR, canonical
  declarative runtime contract, exact signed-digest DigitalOcean deployment,
  control-plane-issued one-time viewer session, bounded three-operation
  authenticated-baseline ZAP run, and attested scanner output.
- Added live v0.2.25 RouteLens evidence for the generic upgrade PR, exact
  signed-digest DigitalOcean deployment, control-plane-issued one-time DAST
  session, bounded authenticated-baseline ZAP run, and attested scanner output.

## [0.2.26] - 2026-07-29

### Fixed

- Evidence and DAST-session workflows now retry GitHub OIDC requests on only
  transient `429` and `5xx` responses, plus network failures, with four bounded
  exponential-backoff attempts.
- Permanent GitHub OIDC `4xx` responses still fail immediately, and all
  workflows continue to fail closed when the bounded retry budget is exhausted.

## [0.2.25] - 2026-07-29

### Fixed

- Deploy-smoke DAST now invokes ZAP API scan in passive safe mode, while the
  nightly authenticated-full profile retains active scanning.
- ZAP receives its supported passive-scan timeout and verified active-scan
  duration limits, and the container is additionally bounded by a runner-side
  wall-clock timeout with forced cleanup.
- Timeouts, operational failures, missing reports, and invalid reports now
  produce canonical, attestable failure evidence instead of hanging until the
  job timeout or failing provenance because `zap.json` is absent.

## [0.2.24] - 2026-07-29

### Fixed

- The reusable DAST workflow now copies only the sanitized OpenAPI document
  into a private ZAP-owned input directory and mounts that directory read-only.
  The non-root ZAP process can read the schema without making the runner's
  original temporary file broadly readable.
- Cleanup and workflow-security coverage now include both the isolated ZAP
  runtime directory and the isolated sanitized-input directory.

## [0.2.23] - 2026-07-29

### Fixed

- The reusable DAST workflow now runs the pinned ZAP image as its built-in
  non-root `zap` user so ZAP can write its required home and startup files.
- ZAP runtime output is isolated from uploaded evidence. Only a regular,
  valid, non-empty JSON report below 50 MiB is copied into the private evidence
  directory, and the temporary work directory is removed after every run.
- Workflow-security coverage now prevents runner-UID ZAP execution, direct
  evidence-directory mounts, unsafe report copying, and missing cleanup.

## [0.2.22] - 2026-07-29

### Fixed

- The reusable DAST workflow now attaches stdin to the pinned sanitizer
  container so its heredoc Python program actually runs and produces the
  bounded same-origin OpenAPI document.
- Workflow-security coverage now requires the sanitizer's interactive stdin
  attachment, preventing a silent empty-output regression before ZAP starts.

## [0.2.21] - 2026-07-29

### Fixed

- Target-exchanged DAST credentials now validate their lifetime from the time
  the exchange response is received. A target that mints the approved full TTL
  no longer fails solely because network latency made its expiry slightly later
  than the control plane's pre-request timestamp.
- Added regression coverage for a full-TTL credential minted after exchange
  network latency while retaining the minimum remaining-lifetime and maximum
  configured-TTL checks.

## [0.2.20] - 2026-07-29

### Added

- The DAST session endpoint now emits bounded structured rejection telemetry
  containing only the failure class and HTTP status. OIDC tokens, exchange
  credentials, minted session values, and request bodies are never logged.

## [0.2.19] - 2026-07-29

### Fixed

- Workflow-run reconciliation now distinguishes a statically referenced
  reusable workflow from a reusable workflow call that actually executed.
  Skipped caller jobs no longer make an otherwise complete security, image, or
  DAST run retry for child-job metadata that GitHub does not create.
- Added regression coverage for default-branch image promotion with skipped
  DAST callers and scheduled DAST with skipped scanner and image callers.

## [0.2.18] - 2026-07-29

### Fixed

- Keyless image signing now verifies Cosign signatures and CycloneDX
  attestations against the actual immutable reusable-workflow certificate
  identity (`reusable-image.yml@SHA`), matching GitHub Actions OIDC behavior.
- The signing step enables strict shell and pipeline failure handling and
  explicitly rejects empty verification arrays. A failed Cosign identity check
  can no longer be masked by a successful downstream `jq` process.
- Control-plane promotion validation independently requires the same
  administratively trusted reusable-workflow SHA in both the certificate
  evidence and promotion manifest.

## [0.2.17] - 2026-07-29

### Fixed

- Scanner artifact ingestion now persists a non-terminal parent artifact before
  writing normalized evidence. PostgreSQL foreign-key enforcement no longer
  turns a valid first-pass promotion artifact into a retry solely because its
  evidence row was inserted before the artifact row.
- Artifact state remains `pending` during processing and becomes `accepted`
  only after the complete evidence processor succeeds.

## [0.2.16] - 2026-07-29

### Fixed

- Trivy misconfiguration normalization now falls back from an empty `AVDID` to
  the populated `ID`, matching the reusable policy engine. Live Trivy 0.70
  Dockerfile findings such as `DS-0002` can no longer cause a passing
  deterministic gate artifact to be rejected during control-plane ingestion.

## [0.2.15] - 2026-07-29

### Fixed

- Image-promotion evidence now derives the Cosign caller identity from the
  independently verified default-branch push metadata. GitHub's workflow-run
  API returns `.github/workflows/guardianbot.yml` without an `@ref` suffix, so
  valid signed promotion artifacts are no longer rejected as incomplete.
- Promotion evidence from any non-push event, non-default branch, or conflicting
  embedded workflow ref fails closed before signature evidence or a
  DigitalOcean deployment can be recorded.

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
