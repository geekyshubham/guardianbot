# Changelog

All notable changes follow Keep a Changelog. GuardianBot uses semantic versioning;
reusable workflow commits remain immutable.

## [Unreleased]

## [0.2.41] - 2026-08-02

### Added

- Optional repository `review.profile` (`automatic` default when omitted,
  `routine-review`, `high-risk-review`, `benchmark-review`). Deterministic risk
  is a floor: explicit routine cannot downgrade a high-risk change; explicit
  high-risk escalates; benchmark selects benchmark. Repository config chooses
  only an approved profile name—never backend URL, alias, model, credential, or
  fallback. Missing administrative route yields advisory `AI review unavailable`
  while deterministic checks continue. Automated/local evidence only; no
  production OpenAI Responses credential or live AI PR review is claimed.
- Packaged fixture-provider conformance path
  `apps/model-bridge/fixtures/live-conformance.json` (runtime image path
  `/app/apps/model-bridge/fixtures/live-conformance.json` once released): strict
  zero-finding deterministic result for bridge/plumbing verification only, never
  production AI. Fixture deployments must explicitly map `profileModels` to
  `fixture-conformance`, use an explicit partial control-plane registry (never
  legacy single-backend env), and must not route routine/high-risk production
  reviews to the fixture.

### Changed

- Documentation for repository configuration, model-bridge adapters, model-bridge
  README, and capability status now describe repository-selected review profiles
  and the packaged fixture-provider conformance path, and keep production AI,
  RouteLens current-binding full schedule, seven-day enforcement, GitHub App
  `pull_request_review_comment`, weekly monitoring cadence, DefectDojo old-token
  retirement, and recovery/HA blockers explicit.

### Evidence

- Live DefectDojo least-privilege automation cutover (2026-08-02 UTC): pre-cutover
  deployed token resolved to user ID 2 `guardianbot-automation` (active true,
  staff true, superuser true; Product Type 2 `authorized_users: []`), proving
  staff/superuser bypass of OSS Authorized Users. Replacement user ID 5
  `guardianbot-importer-prod` (active true, staff false, superuser false,
  `configuration_permissions: []`) authorized only on Product Type ID 2 via OSS
  `authorized_users` (not a DefectDojo Pro API Importer role). Live mutation
  conformance before cutover: Product 20, Engagement 28, Semgrep empty fixture
  import TestImport 878 and reimport 879 both on stable Test ID 46. Control plane
  rotated only `GUARDIANBOT_DEFECTDOJO_API_TOKEN` on app
  `346b3b81-b8cf-4136-b706-0a7195bc9f00`; ACTIVE deployment
  `b4f8fda3-c103-4771-91af-2bc0efd24b73` (created `2026-08-02T09:10:33Z`, updated
  `2026-08-02T09:11:25Z`, 7/7 steps; same signed v0.2.40 image). Injected token
  resolves to user ID 5; first process-local cycle last
  `2026-08-02T09:11:05.298Z` (1/1 success, 19 repos, 6 failing, 13 warning, 33
  active alerts). Old token no longer deployed but **not** revoked; old superuser
  account **not** deactivated. RouteLens current-binding full DAST/import and
  unrelated acceptance blockers remain open. Evidence:
  [v0.2.40 DefectDojo least-privilege cutover](docs/evidence/v0.2.40-defectdojo-least-privilege.md).
- Live GuardianBot `v0.2.40` signed control-plane deployment (2026-08-01 UTC):
  release source `d6b5a41a468e515b398db4c530a5936cb8ac7c95`, release run
  [`30719671783`](https://github.com/geekyshubham/guardianbot/actions/runs/30719671783)
  passed, exact signed image
  `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13`,
  DigitalOcean app `346b3b81-b8cf-4136-b706-0a7195bc9f00` ACTIVE deployment
  `dee798d7-42d9-4c2b-8b44-acfbce7b5944`. `/healthz` and `/readyz` HTTP 200;
  unauthenticated `GET /operations/monitoring` HTTP 404; exact private bearer
  returns schema `guardianbot.monitoring.status.v1` (bearer never documented).
  First live ledger snapshot at `2026-08-01T21:47:39.197Z` remains the
  post-deploy baseline (1 successful run, 7 failing, 20 active alerts). Current
  multi-cycle snapshot at `2026-08-02T08:10:30.142Z` (last cycle
  `2026-08-02T08:02:09.438Z`): scheduler enabled/started, running false, 42
  runs / 42 successes, 0 failures, 0 consecutive failures, 0 lock skips, 19
  repositories evaluated, 6 failing, 13 warnings, 35 active alerts. Weekly
  report: scanner expected 18 / successful 18 / evidence complete 11 /
  missing-evidence alerts 7; fresh indexes 18 / stale 1; protected digests 2 /
  complete-evidence digests 2 / missing-evidence digests 4; review source
  unavailable and zero AI review metrics; inventory report-only 16 /
  advisory-only 2 / misconfigured 1. AstraNull active alerts contain only
  `index-freshness` warning after successful full DAST reconciliation; prior
  active `scanner-zap-nightly` and `scanner-zap-nightly-import` alerts for
  AstraNull are absent. RouteLens still has failing `scanner-zap-nightly` and
  `scanner-zap-nightly-import` alerts plus freshness warnings. Proves
  multi-cycle process-local scheduler success and observed AstraNull
  active-alert recovery—not weekly cadence across multiple UTC weeks.
  Operator-ledger recovery is not the DefectDojo API proof (AstraNull full
  reimport is separately verified as TestImport 862). Evidence:
  [v0.2.40 live monitoring and current DAST](docs/evidence/v0.2.40-live-monitoring-and-current-dast.md).
- AstraNull current binding advanced to head
  `3cb15183e3bf7ccb7326efd461878ce655b66bcb`; push run
  [`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728)
  (event `push`, success); exact DigitalOcean digest
  `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`
  ACTIVE on app `2a76914e-d04e-4a6c-8b9c-929a1e8976e2` deployment
  `baab86b3-747d-4765-b4eb-39ab31d857cc` (service and migrate job use that
  digest; `/health` and `/ready` healthy per ACTIVE promotion/runtime
  contract). Intermediate head `6ee73a48e14d3181738c430cd9662acc20ecac3b` /
  digest
  `sha256:ad09cc35894a3299a02fa3198c7f0cbb282d1a982bbacec71f36279cf7b78fc0` /
  deployment `df13260c-4f0f-42f7-822d-80b7c1c5e6ee` / manual diagnostic
  [`30720398948`](https://github.com/geekyshubham/AstraNull/actions/runs/30720398948)
  remain historical repair evidence only (OIDC role-map repair and baseline
  dispatch on the intermediate binding).
- AstraNull genuine scheduled `authenticated-full` DAST acceptance on the
  current binding: run
  [`30734622751`](https://github.com/geekyshubham/AstraNull/actions/runs/30734622751)
  (event exactly `schedule`, head exactly
  `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, success). Only executed DAST job
  was `guardianbot/dast-nightly / authenticated staging DAST`; security-gate,
  image, and dast-smoke skipped by schedule conditions. Full job passed exact
  staging contract, one-time session, bounded repository OpenAPI, authenticated
  assertion and active ZAP API scan, session destruction, provenance
  attestation, and artifact upload. DAST artifact `8829127168` digest
  `sha256:9116d4c7ccd97e6c0fcd148f48529d30e7b14dbc777de7ad52992b9015f93fbe`.
  scan-status: schema 1.0.0, profile `authenticated-full`,
  `deploymentEnvironment` staging, exact digest
  `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`,
  minutes 45, ZAP exit 2 (report-only findings, no operational failure).
  Provenance: repository `geekyshubham/astranull`, repositoryId `1287322655`,
  run/attempt `30734622751/1`, current head, workflow
  `.github/workflows/reusable-dast.yml`, workflow SHA
  `7524547700e4c3994353f5c61d1625b2bd5e5428`. Manifest file hashes/sizes
  independently recomputed and all 3 matched (scan-status, zap.json, zap.xml).
  Closes AstraNull current-binding scheduled authenticated-full only.
- Independently verified DefectDojo reimport for AstraNull genuine scheduled
  authenticated-full run `30734622751/1` (read-only DefectDojo API via control
  plane; token never printed or persisted): TestImport ID 862, type `reimport`,
  Test ID 6, created `2026-08-02T05:44:58.992083Z`, build `30734622751/1`,
  commit `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, branch `main`, findings
  affected 10 (2 reactivated `R`, 8 updated `U`); tags bind attempt 1, branch
  main, exact commit, env staging, image
  `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`,
  profile dast, repo ID 1287322655, repo `geekyshubham/astranull`, run
  30734622751, scan zap-scan, visibility public. Stable hierarchy: Product Type
  2 `GitHub Repositories`, Product 3 `geekyshubham/AstraNull`, Engagement 5
  `main/dast` (active), ZAP Test 6 `main/dast` / `ZAP Scan`. Later genuine
  scheduled authenticated-baseline `30737896566/1` reimported as TestImport 867
  at `2026-08-02T07:30:23.448587Z` onto the same Test ID 6 (mutable Test now
  shows that later baseline; immutable TestImport 862 remains full-run
  evidence). RouteLens failed full `30734627567/1` has zero TestImports
  (expected after `wall_clock_timeout`). RouteLens current-binding full DAST
  and DefectDojo import remain open; least-privilege automation identity
  hardening remains open. Evidence:
  [v0.2.40 live monitoring and current DAST](docs/evidence/v0.2.40-live-monitoring-and-current-dast.md).
- RouteLens genuine scheduled `authenticated-full` failure with
  `wall_clock_timeout`: run
  [`30734627567`](https://github.com/geekyshubham/RouteLens/actions/runs/30734627567)
  (event exactly `schedule`, then-current head
  `55eeead5b7306972abfff1b30a32b5cae95e96eb`, then-current exact DigitalOcean
  digest
  `sha256:7ac78ef0d9ab23c14f7e3665a834f21fd73a9be3ceed040b4c76b7a06532dceb`).
  `guardianbot/dast-nightly / authenticated staging DAST` executed; other
  top-level jobs skipped. Exact staging contract, one-time session, bounded
  safe-method OpenAPI preparation, authenticated assertion, cleanup, provenance
  attestation, and artifact upload passed. Active ZAP scanned the live schema's
  175 retained GET/HEAD/OPTIONS operations and exceeded the 45-minute wall
  bound. scan-status: profile `authenticated-full`, staging, exact digest
  above, minutes 45, `zapExitCode` 3, `failureKind` `wall_clock_timeout`. DAST
  artifact `8829613107` digest
  `sha256:e40de909d7a8e1963a875d4def733e8b1ccb83d6fc39e48c18d78cf8835d942f`.
  Provenance binds `geekyshubham/routelens`, repositoryId `1146692767`,
  run/attempt `30734627567/1`, head `55eeead5…`, reusable workflow SHA
  `7524547700e4c3994353f5c61d1625b2bd5e5428`; all 3 manifest file hashes/sizes
  independently matched. Valid provenance-bound failure evidence, not a
  successful full scan. Prior baseline schedule
  [`30718271723`](https://github.com/geekyshubham/RouteLens/actions/runs/30718271723)
  on the same then-current binding remains baseline-only history.
- RouteLens remediation merged/promoted but next genuine schedule still
  required: PR [#77](https://github.com/geekyshubham/RouteLens/pull/77) merged
  at current default head `5f8990484101feb56733308b3f0b3b01706bdaf8` on
  `2026-08-02T08:11:19Z` after Backend, Frontend, Production artifact,
  GuardianBot deterministic security, and exact-image checks passed. Replaced
  the 175-operation live schema input with
  `docs/api/guardianbot-dast-openapi.json` (exactly 3 non-destructive GET
  operations: public health, public schema, authenticated target list/session
  assertion) through the existing generic repository-file mechanism; keeps
  immutable workflow SHA, one-time auth profile, active-full profile, genuine
  `47 2 * * *` schedule, and 45-minute bound. Current push run
  [`30739285447`](https://github.com/geekyshubham/RouteLens/actions/runs/30739285447)
  passed deterministic security, exact linux/amd64 build, disposable
  dependencies, tests, migrations, runtime smoke, Trivy, CycloneDX SBOM,
  Critical policy, immutable push, keyless Cosign signing, attestation, and
  provenance. Current signed digest
  `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`.
  DigitalOcean App `8cbf8b10-0d55-408f-87fc-2b501a06fada` ACTIVE deployment
  `56c22a8c-0258-41ab-b839-8a50613810d6`; routelens service and migrate job use
  exact current digest; `/api/v1/health/` 200, `/api/schema/` 200, anonymous
  `/api/targets/` 401. Because head/digest changed after the failed schedule,
  RouteLens scheduled authenticated-full remains **open** until the next
  genuine schedule passes with provenance on this new exact binding. PR checks
  and push promotion do **not** prove full DAST. Still open overall: RouteLens
  current-binding full DAST and its DefectDojo import, least-privilege
  DefectDojo automation identity hardening, production model credential/live AI
  review, seven-day enforcement/ruleset readiness, GitHub App review-comment
  permission, and full PoC acceptance. Evidence:
  [v0.2.40 live monitoring and current DAST](docs/evidence/v0.2.40-live-monitoring-and-current-dast.md).

## [0.2.40] - 2026-08-02

### Added

- Authenticated read-only operator ledger `GET /operations/monitoring`
  (`guardianbot.monitoring.status.v1`): same
  `GUARDIANBOT_METRICS_BEARER_TOKEN` / private-metrics trust policy as
  `/metrics`; empty `404` for non-`GET`, query strings, trailing slash, and
  unauthorized callers; `cache-control: no-store` on `200` and the fixed `503`
  body; process-local scheduler state (not fleet-authoritative); at most 512
  sanitized active alerts from a stable bounded PostgreSQL JOIN; page-scoped
  repository names/count with `complete`; current UTC-week aggregate report or
  `null`; no config, evidence payloads, index contents, credentials, digests,
  webhook payloads, resolved rows, or raw provider text; explicit length caps
  on alert full name/key/summary. Public Caddy returns `404` for `/metrics`
  and `/operations/monitoring`; private Compose access stays internal. Source
  and automated tests ship in this release; **live operator endpoint
  deployment and weekly-report acceptance are not claimed**. Do not claim live
  ledger output or alert identities. Direct database/SSH firewall broadening
  is not required. See
  [operations](docs/operations.md#private-metrics-and-operator-monitoring-status)
  and [metrics](docs/metrics.md#monitoring-model).

### Changed

- Fleet consumer pins and GuardianBot self-consumer config/workflow references
  are upgraded via generic `guardianctl upgrade --all` to immutable published
  release `v0.2.39` exact commit `7524547700e4c3994353f5c61d1625b2bd5e5428`
  (from `v0.2.37` `f2a7f5410bd5d8b140378a7c722b74ba0b455727`). All 18 draft
  upgrade PRs merged, including GuardianBot PR #37.

### Evidence

- Live authenticated metrics transport on DigitalOcean app
  `346b3b81-b8cf-4136-b706-0a7195bc9f00`, exact signed image
  `sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1`,
  ACTIVE deployment `3f0b58cd-52b7-481b-b4d6-7f29d9dad283` (2026-08-01 UTC):
  `/healthz` and `/readyz` HTTP 200; unauthenticated `/metrics` HTTP 404;
  exact bearer succeeds. Scheduler gauges after deployment: enabled=1,
  started=1, one successful cycle, zero failures/consecutive failures/lock
  skips, 19 repositories evaluated, 7 failing repositories, 0 warning
  repositories, 28 active alerts. The 7/28 aggregate is an unresolved
  production signal from `/metrics` only. Bearer value remains a DigitalOcean
  secret / local operator credential and is never documented. Does **not**
  claim live `GET /operations/monitoring` output, weekly-report acceptance,
  production AI review, seven-day enforcement, authenticated-full DAST,
  DefectDojo current-run import, or GitHub App review-comment permission.

- Current-binding RouteLens scheduled `authenticated-baseline` on head
  `55eeead5b7306972abfff1b30a32b5cae95e96eb` / deployed digest
  `sha256:7ac78ef0d9ab23c14f7e3665a834f21fd73a9be3ceed040b4c76b7a06532dceb`:
  genuine GitHub `schedule` run
  [`30718271723`](https://github.com/geekyshubham/RouteLens/actions/runs/30718271723)
  (staging contract, one-time session, bounded ZAP, provenance attestation,
  and artifact upload all passed; `guardianbot/dast-nightly` skipped; artifact
  `8824056295` digest
  `sha256:19afaae9c663dc3a8f8261a50870672023d3c95967efd50ae561d00c85a689af`;
  provenance binds repository `geekyshubham/routelens`, run/attempt
  `30718271723/1`, workflow SHA `7524547700e4c3994353f5c61d1625b2bd5e5428`).
  Authenticated-baseline only; does not close full DAST acceptance, DefectDojo
  current-run proof, production AI review, seven-day enforcement, or GitHub
  App review-comment permission. Evidence:
  [v0.2.39 live fleet upgrade](docs/evidence/v0.2.39-live-fleet-upgrade.md).
- Current-binding AstraNull scheduled `authenticated-baseline` on head
  `3664cff061398c1bf3efc0c937a2470746d60e3d` / deployed digest
  `sha256:6c4f2e9cb3a497fe0871cb73cfd7b2aa0f072c2f7e54626d19a6b81a67ce087a`:
  genuine GitHub `schedule` run
  [`30717179796`](https://github.com/geekyshubham/AstraNull/actions/runs/30717179796)
  (`guardianbot/dast-smoke / authenticated staging DAST` passed; `dast-nightly`
  skipped; artifact `8823702700` digest
  `sha256:0d7592fe5c23c37838733f63ebf7f716d30e6307822e29b08f1c3e570a82d45b`;
  provenance binds `geekyshubham/astranull`, run/attempt `30717179796/1`,
  workflow SHA `7524547700e4c3994353f5c61d1625b2bd5e5428`, profile
  `authenticated-baseline`, 15 minutes, ZAP exit 2). GitHub environment
  `guardianbot-dast` has custom `main` branch-only deployment policy in
  RouteLens and AstraNull (re-read after AstraNull policy add). Baseline-only;
  does not close full DAST acceptance, DefectDojo current-run proof, production
  AI review, seven-day enforcement, or GitHub App review-comment permission.
  Evidence:
  [v0.2.39 live fleet upgrade](docs/evidence/v0.2.39-live-fleet-upgrade.md).
- Live GuardianBot v0.2.39 fleet pin upgrade, control-plane trust of release
  commit `7524547700e4c3994353f5c61d1625b2bd5e5428` for security/image/DAST
  evidence (ACTIVE deployment `2a394a68-9c23-4fd0-8978-8d2018664f81`;
  `/healthz` and `/readyz` HTTP 200), final inventory 19 visible / 16
  report-only / 2 advisory-only / 1 not-applicable fork / zero misconfigured /
  zero missing-expected-runs, and RouteLens/AstraNull post-merge promotions
  (RouteLens head `55eeead5b7306972abfff1b30a32b5cae95e96eb`, run
  [`30716095055`](https://github.com/geekyshubham/RouteLens/actions/runs/30716095055),
  digest
  `sha256:7ac78ef0d9ab23c14f7e3665a834f21fd73a9be3ceed040b4c76b7a06532dceb`;
  AstraNull head `3664cff061398c1bf3efc0c937a2470746d60e3d`, run
  [`30716664659`](https://github.com/geekyshubham/AstraNull/actions/runs/30716664659),
  digest
  `sha256:6c4f2e9cb3a497fe0871cb73cfd7b2aa0f072c2f7e54626d19a6b81a67ce087a`).
  Does not claim scheduled authenticated-full DAST on current digests,
  DefectDojo current-run proof, production AI review, seven-day enforcement,
  or GitHub App review-comment permission. Evidence:
  [v0.2.39 live fleet upgrade](docs/evidence/v0.2.39-live-fleet-upgrade.md).
- Live GuardianBot v0.2.39 signed release, exact-digest control-plane
  deployment, and guarded index recovery (hotfix PR #34
  `704c9041c78b6e0dfee1d481f9de6cc33b2040f6`, release commit
  `7524547700e4c3994353f5c61d1625b2bd5e5428`, image
  `sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1`,
  ACTIVE deployment `d69ed8bf-1ed8-4669-8cea-4175513a7527`, delivery
  `76eb6aa6-8dd9-11f1-9979-156df2276e83` replayed to `succeeded`, snapshot
  17,256 document calls / 17,256 distinct call IDs / 17,256 durable edges).
  Proves live fix of the duplicate durable edge publication defect and atomic
  non-empty durable publication for the current snapshot. Does not claim live
  PR descriptor-first consumption, ANN, production AI review, seven-day
  enforcement, authenticated-full DAST, or DefectDojo reimport. Evidence:
  [v0.2.39 live index recovery](docs/evidence/v0.2.39-live-index-recovery.md).

## [0.2.39] - 2026-08-02

### Fixed

- Repository-index call-edge publication no longer produces duplicate call IDs
  that make PostgreSQL `ON CONFLICT DO UPDATE` fail with "cannot affect row a
  second time". The first post-v0.2.38 default-branch index refresh failed in
  production on that error; the live materialized index had 17,266 calls but
  only 17,169 distinct call IDs (97 duplicates), so durable call-edge
  publication did not complete. The fix deterministically deduplicates computed
  call IDs in full and incremental index builds; `toPersistedCallEdges`
  collapses exact duplicates and fails closed when the same edge ID disagrees
  in persisted semantics; and the PostgreSQL edge batch statement fails closed
  if any duplicate `(storage_key, edge_id)` ON CONFLICT target reaches it.
  Regression tests cover parser duplicates, incremental sanitation of a prior
  duplicate snapshot, exact duplicate normalization, conflicting duplicate
  rejection, unique generated batch keys, and final SQL-boundary duplicate
  rejection. Source/test evidence only; no signed release publication,
  deployment, or live re-proof is claimed yet.

### Evidence

- Live GuardianBot v0.2.38 signed release and exact-digest control-plane
  deployment (commit `d1967eded422b7d3a216ec9aff3ea9e2ce44da33`, image
  `sha256:1b0344fd41304d49659967b55d0b2c9b4b0ae79da496fd556eb03b5211941bdd`,
  ACTIVE deployment `c774c3fa-2b53-4ebe-97d5-e9343a3fd60d`, `/healthz` and
  `/readyz` HTTP 200) plus post-boot managed PostgreSQL repository-index
  table observation. Zero-row `repository_index_edges` is schema-only, not
  live call-edge retrieval. Evidence:
  [v0.2.38 live control-plane deployment](docs/evidence/v0.2.38-live-control-plane-deployment.md).
- AstraNull current-head promotion repair on immutable v0.2.37 pin
  `f2a7f5410bd5d8b140378a7c722b74ba0b455727`: head
  `5f600f4a866da24006bcde8838e1499e532d7276`, push run
  [`30696798791`](https://github.com/geekyshubham/AstraNull/actions/runs/30696798791)
  attempt 2 success, promoted signed digest
  `sha256:90f052c61997c50e8f5724b7260b5314c95b2473afe023967977120cd8c37202`,
  ACTIVE DigitalOcean deployment `742ad233-8c8a-4345-a440-42cd09a77787`
  (app `2a76914e-d04e-4a6c-8b9c-929a1e8976e2`), `/health` and `/ready` HTTP
  200. Push correctly skipped DAST; scheduled authenticated-full on this
  head/digest remains open. Evidence:
  [v0.2.37 AstraNull current promotion repair](docs/evidence/v0.2.37-astranull-current-promotion-repair.md).

## [0.2.38] - 2026-08-01

### Added

- Review orchestration is implemented descriptor-first. The control plane loads
  a `RepositoryIndexDescriptor` from first-class `repository_indexes` columns
  (`Store.getRepositoryIndexDescriptor`; the statement never names
  `index_document`) and does not call `getRepositoryIndex` or load/parse the
  materialised index document for review context. Descriptor identity is
  compared against the request under the existing repository-scope and
  storage-key canonicality checks; a cross-repository row still raises
  `RepositoryIsolationError`. Automated tests prove review still succeeds when
  `getRepositoryIndex` throws.
- Durable exact-path record retrieval is repository-scoped with limit+1
  truncation detection. Changed-path records are included outside ANN top-N.
  Vector candidates and record contents are hydrated from durable storage.
  Malformed, foreign, or truncated durable results fail closed into explicit
  partial/isolation behaviour rather than silent complete context. Metrics cover
  durable retrieval and truncation/partial outcomes.
- Durable call edges are stored and queryable. Retrieval reconstructs caller,
  callee, and the call-edge-derived test relation from those rows without the
  materialised document. Automated coverage includes exact-path retrieval,
  durable edges, isolation, truncation, and descriptor-only review. No live
  PostgreSQL/pgvector/ANN proof and no production deployment of this path are
  claimed; history retrieval remains incomplete.

### Changed

- GuardianBot self-consumer config/workflow is pinned to immutable v0.2.37
  commit `f2a7f5410bd5d8b140378a7c722b74ba0b455727`.
- Fleet pin upgrade to immutable v0.2.37
  (`f2a7f5410bd5d8b140378a7c722b74ba0b455727`) completed via generic
  `guardianctl upgrade --all`: 18 reviewed green PRs merged; direct
  default-branch reads confirm config and every managed caller reference use
  that SHA; 20 superseded July draft upgrade PRs closed. RouteLens and
  AstraNull exact-digest generic promotions and ACTIVE DigitalOcean staging
  deployments are live on the post-merge push runs (signed digests
  `sha256:35519bf4f6db309604108916c1c331b8860b8b9a9757c298a8ff8f350cf6aadd`
  and
  `sha256:425d4761b3ee644180fa2734fd35350edad5aac5aad30a4c8d5c7794de65dbb0`).
  Evidence:
  [v0.2.37 live control-plane, fleet, and promotion](docs/evidence/v0.2.37-live-control-plane-fleet-and-promotion.md).
  Does not claim production AI review, seven-day enforcement, scheduled
  authenticated-full DAST on the v0.2.37 digests, or a new DefectDojo reimport.

### Fixed

- Shutdown no longer deregisters its own signal handlers. `SIGINT`/`SIGTERM`
  register with `process.on` rather than `process.once`, so a second signal
  arriving mid-drain is absorbed by the existing `shuttingDown` guard instead of
  reaching Node's default terminate action while a webhook lease is held.
- A shutdown that exhausts the 120 second drain budget now ends the process
  through an unref'd 5 second force-exit timer instead of continuing unbounded.
  The 125 second total stays inside the orchestrator's 130 second
  `stop_grace_period`, asserted against `infra/docker-compose.yml`, so the
  process chooses its own exit rather than being `SIGKILL`ed. `store.close()`
  remains deliberately skipped on that branch so a still-live handler keeps its
  connection; in exchange, a request still in flight at the 120 second mark is
  terminated unanswered and redelivered.
- In-flight HTTP requests are part of the drain. `closeAllConnections()` runs
  after the drain rather than before, so an accepted webhook `POST` writes its
  `202` before its socket is destroyed; previously the socket could be destroyed
  first, producing an empty reply and a GitHub redelivery. Shutdown bounds that
  wait itself at 15 seconds, because `server.close()` clears Node's
  connections-checking interval and `requestTimeout`/`headersTimeout` stop being
  enforced for the remainder of the drain. The server-level timeouts are
  retained as pre-shutdown defence only.
- The shutdown `AbortSignal` reaches the long-running webhook work: the
  default-branch index rebuild on the `push` arm and, through discovery, on the
  `installation`, `installation_repositories`, and `repository` arms; and the
  inline-comment closing loop, which stops at a comment boundary and resumes on
  retry rather than continuing to `PATCH` GitHub past the budget. A cancelled
  rebuild publishes no index. Cancellation is normalised to the queue's own
  aborted class at each site, so an interrupted delivery credits its attempt back
  and requeues instead of spending an attempt and eventually dead-lettering. The
  per-file read loop inside a rebuild has a checkpoint that no test covers.
- Monitoring reconciliation can be cancelled between repositories, and
  cancellation is a distinct outcome rather than being folded into success or
  failure: a cancelled sweep publishes no weekly report, does not set
  `lastSuccessAt` or increment the success counter, and leaves the aggregate
  gauges on the last complete sweep, so a partial sweep cannot be read as
  authoritative. The checkpoint is evaluated only before an item and never
  mid-write, so the repository being persisted when the signal arrives is always
  finished. `consecutiveFailures` is left untouched so shutdown does not read as
  an outage; the attempt still counts in `runsTotal`, which widens the
  runs-versus-successes gap by one for each interrupted shutdown.
- Review writes are bound to the webhook lease that authorised them, in addition
  to the existing head-SHA compare-and-set. The head-SHA predicate cannot
  separate two workers replaying the same delivery, because both derive the same
  expected SHA, and since `findings_evicted_total` and `feedback_total`
  accumulate server-side, a duplicated commit inflated lifetime counters rather
  than merely repeating itself. A handler whose lease lapsed and was reclaimed
  now writes nothing, while a legitimate retry re-claims the delivery with a
  fresh lease and is unaffected. The `MemoryStore` fence is verified
  behaviourally; the `PostgresStore` form is verified only by asserting on the
  statement's source text, because this environment has no live PostgreSQL.
  `review_stale_total` now covers both a moved head SHA and a lost lease, which
  mean different things operationally and are no longer distinguishable from
  metrics alone.

### Evidence

- On 2026-08-01, the production-hardening shutdown/cancellation implementation
  was independently reviewed in source; the control-plane test suite passed
  **240/240**. Backend calls receive `AbortSignal`, the owned handler is
  awaited rather than detached, cancellation checkpoints prevent post-review
  lifecycle/GitHub writes, and the delivery lease is requeued without consuming
  attempt budget. Marks only that outstanding sub-item done as source/test
  evidence (not live cancel-under-load or recovery drills). Recorded in
  [docs/status.md](docs/status.md) and
  [v0.2.37 evidence](docs/evidence/v0.2.37-live-control-plane-fleet-and-promotion.md).
- Independently found delayed genuine GitHub `schedule` authenticated-full
  DAST runs from the pre-v0.2.37 binding: AstraNull
  [`30686350591`](https://github.com/geekyshubham/AstraNull/actions/runs/30686350591)
  succeeded end-to-end with provenance on old head
  `9f21cabdcbe38b5e8697935914bba165c206229d` / digest
  `sha256:6760bb3a8e1fadba14ae766aa74eb76b5b5f28f782c1354c612a9b488103a3bf`;
  RouteLens
  [`30686352313`](https://github.com/geekyshubham/RouteLens/actions/runs/30686352313)
  completed staging contract, one-time session, authenticated assertion, and
  bounded 45-minute ZAP on old head
  `9722f0ee6abf192508e3fdbc866f662f31fe5d43` / digest
  `sha256:26d56ce97607b1550d7f14396692edff01bac95dcc45199f42ceb414c56e979e` but
  failed provenance HTTP 401 after the v0.2.37 trust cutover superseded old
  trusted reusable workflow SHA `152649be5a86862f619a86d60598fc25bafb0429`.
  Historical only; does **not** close required scheduled authenticated-full
  evidence on current v0.2.37 heads/digests. DefectDojo, model, enforcement,
  GitHub App feedback events, current DAST on v0.2.37 digests, live
  pgvector/ANN, weekly monitoring, and recovery blockers remain open.

## [0.2.37] - 2026-08-01

### Added

- Stable-fingerprint lifecycle records persist provenance: first and last-seen
  head SHA and timestamps, transition and reappearance counts, and enough
  finding identity to render a human-meaningful line without re-running the
  model. A finding that returns after a terminal state is therefore detectable
  for the first time, and is surfaced while it is still open through the
  advisory lifecycle line, a returned-finding entry, and a new
  `finding_reappeared_total` counter. The additive migration runs inside the
  advisory-locked path; pre-existing rows remain readable and an older instance
  can still write them during a rolling deploy.
- Resolved, superseded, and returned findings render per finding instead of only
  as counts, and GuardianBot rewrites its own published inline advisories to a
  clearly-closed form so stale advisories no longer accumulate on long-lived
  pull requests. Rewrites are restricted to GuardianBot's own top-level
  comments, the original advisory is retained rather than deleted so reviewer
  conversation survives, and the fingerprint marker is anchored to the start of
  the body so a reviewer quoting an advisory is never matched or overwritten.
  The advisory body is bounded, shedding lifecycle detail before the complete
  tally so a churn-heavy pull request cannot exceed the GitHub comment limit.
- The repository index gained a durable pgvector read path and durable candidate
  sourcing on the production review path. Nearest-neighbour ranking runs in the
  database against a dimensioned `vector_ann` column (the vector table was
  previously write-only). Rows whose own `dimensions` do not match the indexed
  width are left unwritten so another embedding width degrades to an exact scan
  instead of failing, and queries stay correct whether or not the approximate
  index exists. Boot builds that index only while the table is effectively empty,
  because `CREATE INDEX` holds `ACCESS EXCLUSIVE` and migrations run before the
  port opens; above the inline ceiling the build is a documented
  `CREATE INDEX CONCURRENTLY` operator step. Storage mode, approximate-index
  readiness, and the uncovered-row count are exposed as gauges, and the
  uncovered count is omitted rather than rendered as zero so an unmeasured
  backlog is not scraped as an empty one. The control-plane review path now
  supplies `RepositoryIndexService.repositoryVectorRanker` together with a
  matching local embedding provider, queries durable storage, batch-hydrates
  recalled records absent from the loaded document in one round trip, recomputes
  relevance locally to avoid store score-polarity mismatch, and rechecks
  repository scope on request and returned rows. Automated tests cover
  durable-only retrieval, one-round-trip hydration, production wiring/isolation,
  and pgvector/store behaviour, so a durably-stored record absent from the
  loaded document is now reachable on the production review path. This widens
  recall and closes the prior dormant-recall / missing-record gap; it does not
  remove the whole-snapshot materialisation requirement.
  `retrieveRepositoryContext` still takes the index document as a required
  input and the review path still loads it in full before ranking, so the
  production-scale materialised-document barrier remains open. Graph edges
  still rely on the loaded index document; history retrieval remains
  incomplete. All pgvector behaviour is automated/local stub evidence only: no
  live PostgreSQL/pgvector verification, live ANN performance, or production
  deployment of this path is claimed.
- Repository index refresh is incremental. Vectors are reused by content digest
  across a `compare` range, so unchanged files are neither refetched nor
  re-embedded, and files are read by immutable git blob id. The plan falls back
  to a full rebuild whenever the range is not a plain forward advance or the
  changed-file list may be truncated at the API page cap, because an omitted
  path is indistinguishable from an unchanged one and would otherwise carry a
  stale embedding forward under the new head. Indexing caps are constructor
  options rather than module constants, and the truncation ratio reaches the
  monitoring snapshot so an under-indexed repository is visible instead of
  silently partial. Superseded index generations are pruned by a bounded sweep
  outside the migration path.
- Retained findings per review are bounded by a configurable TTL and cap
  (`GUARDIANBOT_REVIEW_FINDING_RETENTION_MS`,
  `GUARDIANBOT_REVIEW_FINDING_LIMIT`, documented in operations) in which only
  terminal states are evictable, so an active finding is never dropped to
  satisfy the cap.

### Fixed

- Lifecycle state derives from every reported finding rather than the truncated
  inline selection. A finding ranking below `maxInlineComments` was previously
  transitioned to a terminal state while the model still reported it, which the
  new presentation would have surfaced as a false "resolved" line and a closed
  inline comment.
- Migrations no longer block indefinitely on a peer's advisory lock. The
  migration connection sets `lock_timeout`/`statement_timeout` and retries a
  bounded number of times before failing with a named error, so a wedged peer
  produces a loud boot failure instead of a process that never opens a port and
  never reports readiness.
- `migrate()` serializes its DDL behind a PostgreSQL session advisory lock on a
  dedicated connection, matching the existing monitoring-lock pattern.
  Concurrent instance boots now wait rather than racing on
  `CREATE TABLE`/`CREATE INDEX IF NOT EXISTS`.
- `/metrics` emits a valid webhook latency histogram. Bucket counts are already
  accumulated when observed, so re-accumulating them at render time double
  counted and produced output where `+Inf` was smaller than `le="60000"`.
  Counts are now emitted verbatim and `+Inf` equals the observation total.
- Graceful shutdown waits for an in-flight webhook to settle before closing the
  store, and cancels the in-flight backend call through an abort signal so the
  worker eagerly releases its lease instead of stranding the delivery for the
  full lease duration. The drain budget now exceeds the backend timeout, and
  idle connections are closed explicitly.
- GitHub throttling is distinguished from failure. A `403`/`429` carrying
  `retry-after` or an exhausted `x-ratelimit-remaining` raises a typed
  rate-limit error carrying the reset instant; the delivery requeues at that
  instant and does not consume its attempt budget, so a throttling burst no
  longer dead-letters webhook jobs. The wait is clamped so a malformed or
  hostile header cannot park a job, and a `403` with no budget signal remains a
  permanent failure so authorization errors are not treated as throttling.
  `/metrics` gains a `github_rate_limited_total` counter and a
  `guardianbot_github_ratelimit_remaining` gauge that stays absent until GitHub
  reports a budget.
- The container health check probes `/readyz` instead of the static `/healthz`,
  so a failed store dependency marks the container unhealthy. `/healthz`
  remains the pure liveness probe.
- A prompt that exceeds a route's `maxInputCharacters` raises a typed
  non-retryable bridge error instead of a plain error reclassified as a
  retryable backend outage, so a request that can never succeed is not retried
  as though the provider were unavailable.
- An oversized upstream bridge response cancels its stream reader before
  raising, matching the protocol client, so the connection is not leaked.

### Security

- The `/webhooks/github` request body read is guarded, so a client that aborts
  mid-body can no longer terminate the control plane. The read previously sat
  outside the handler's `try`, and because the `createServer` callback is
  `async` and no process-level handler was registered, the resulting
  `ECONNRESET` escaped as an unhandled rejection and Node's default
  `--unhandled-rejections=throw` exited the process. The read precedes
  signature verification, so no valid HMAC was required to trigger it. The two
  sibling routes already guarded their identical loops. Process-level
  `unhandledRejection`/`uncaughtException` handlers now log a bounded error
  kind and drain through the existing shutdown path as defence in depth.
- Pull request scanner runs resolve onboarding state from the canonical
  `.guardianbot/config.yml` path in the base commit instead of the
  head-supplied `config-path` input. A pull request previously could repoint
  that input at a path absent from base, present itself as the
  first-onboarding case, and weaken its own gate. Onboarded repositories must
  now pass the canonical path, and an unresolvable or unreachable base commit
  fails closed rather than falling back to head configuration. Generated
  callers already pass the canonical path, so onboarded repositories are
  unaffected; genuine first onboarding still resolves head configuration in
  non-enforcing mode.
- Webhook responses no longer place internal error text in the response body.
  Signature and delivery failures answer `401`/`400` with fixed strings via a
  typed authentication error, replacing a substring match on the error text.
  Enqueue failures answer a static `503` so GitHub treats them as
  server-side and redelivers, instead of reporting a store outage as a client
  error.

### Changed

- GuardianBot self-managed config/caller is upgraded to the immutable v0.2.36
  commit `152649be5a86862f619a86d60598fc25bafb0429`.

### Evidence

- Live GuardianBot v0.2.36 signed release and control-plane rotation (exact
  digest `sha256:622fd2b0b0c30c64d57112317304025ed102c911ba0e3c329d0cbed5c5496b9a`,
  ACTIVE deployment, `/healthz`/`/readyz`), generic fleet upgrade (18 merged
  immutable-pin PRs), healthy final live target-SHA inventory (19 visible /
  16 report-only / 2 advisory-only / 1 not-applicable fork / zero
  misconfigured / zero missing-expected-runs), and RouteLens plus AstraNull
  exact-digest generic promotions with ACTIVE DigitalOcean deployments and
  health checks. See
  [v0.2.36 live control-plane and fleet upgrade evidence](docs/evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md).
- On 2026-08-01, genuine scheduled authenticated-baseline smoke completed for
  the then-current (pre-v0.2.37 promotion) default-branch SHAs and DigitalOcean
  deployed digests: AstraNull run
  [`30684302779`](https://github.com/geekyshubham/AstraNull/actions/runs/30684302779)
  and RouteLens run
  [`30684781163`](https://github.com/geekyshubham/RouteLens/actions/runs/30684781163).
  Each completed the staging-contract → one-time session assertion → bounded
  ZAP → evidence attestation/artifact chain and skipped `authenticated-full` /
  `dast-nightly`. Separately, delayed genuine GitHub `schedule`
  authenticated-full DAST runs from the same pre-v0.2.37 binding were found
  (historical only; do **not** close required acceptance on current v0.2.37
  heads/digests): AstraNull
  [`30686350591`](https://github.com/geekyshubham/AstraNull/actions/runs/30686350591)
  succeeded end-to-end with provenance on old head
  `9f21cabdcbe38b5e8697935914bba165c206229d` / digest
  `sha256:6760bb3a8e1fadba14ae766aa74eb76b5b5f28f782c1354c612a9b488103a3bf`;
  RouteLens
  [`30686352313`](https://github.com/geekyshubham/RouteLens/actions/runs/30686352313)
  completed staging contract, one-time session, authenticated assertion, and
  bounded 45-minute ZAP on old head
  `9722f0ee6abf192508e3fdbc866f662f31fe5d43` / digest
  `sha256:26d56ce97607b1550d7f14396692edff01bac95dcc45199f42ceb414c56e979e` but
  provenance attestation returned HTTP 401 after the v0.2.37 trust cutover
  superseded old reusable workflow SHA
  `152649be5a86862f619a86d60598fc25bafb0429`. No new DefectDojo
  import/reimport was independently verified for those runs. Scheduled
  authenticated-full acceptance on the current v0.2.37 heads/digests remains
  open.
- Durable repository-index candidate sourcing and production review-path wiring
  are source/test evidence only (see Added). No live PostgreSQL/pgvector proof,
  live ANN performance, production deployment of that path, or `v0.2.37`
  release is claimed.
- No production model credential or live AI-backed review, seven-day
  observation completion, reviewed baseline, ruleset readiness, scanner
  enforcement, scheduled authenticated-full DAST success on the current
  v0.2.37 heads/digests, or new DefectDojo import/reimport is claimed.
  career-ops retained 31 Critical image findings report-only (not
  Critical-clean). Older RouteLens v0.2.34 scheduled baseline/DefectDojo and
  v0.2.35 schedule baseline-only evidence remain prior-release /
  baseline-only distinctions.

## [0.2.36] - 2026-07-30

### Security

- Enforce-mode non-PR scanner runs fail closed on a runtime readiness verifier
  before Semgrep. Authorization requires a strict `guardianbot.baseline.v1`
  document with `source` (successful report-only gate that supplied current
  fingerprints) and `observation` (first qualified report-only
  `push`/`workflow_dispatch` gate that started the minimum seven-day clock,
  including repository, headSha, runId, runAttempt, startedAt). Both
  provenance runs are revalidated through GitHub API run-attempt metadata, the
  exact successful deterministic scanner job, report-only config at each head
  SHA, and exact `referenced_workflows` reusable-security identity pinned to
  the immutable `workflowVersion`. Observation must be at least seven days old;
  an active default-branch GuardianBot ruleset must strictly require
  `guardianbot/security-gate / deterministic scanners`. Missing, invalid, or
  unauthorized API evidence fails closed. The workflow uses only its scoped
  GitHub token with `actions: read` (no consumer secret or control-plane
  dependency). `guardianctl baseline` persists the independently verified first
  observation-run proof and rejects an observation repository different from
  the source repository. Automated focused tests pass; live seven-day
  observation and reviewed enforce promotion remain pending (no production or
  live enforcement claimed).

### Changed

- GuardianBot self-managed config/caller is pinned to the immutable v0.2.35
  release commit `9a898934fa62ad9fcaab290a83c0d287e2d35967`.

### Evidence

- Live GuardianBot v0.2.35 release/control-plane rotation, generic fleet
  upgrade (18 merged immutable-pin PRs), RouteLens and AstraNull
  Critical-clean `verified-default-branch` promotion with exact-digest ACTIVE
  DigitalOcean deployments and health checks, post-upgrade inventory
  (19 visible / 16 report-only / 2 advisory-only / 1 not-applicable fork /
  zero misconfigured / zero missing-expected-runs), and doctor state
  (healthy; ~1.35 days observed; baseline missing; `enforcementReady=false`).
  See
  [v0.2.35 live fleet and image promotion evidence](docs/evidence/v0.2.35-live-fleet-and-image-promotion.md).
  No v0.2.35 scheduled DAST, authenticated-full DAST, new DefectDojo
  import/reimport, production model credential, seven-day observation
  completion, baseline, or scanner enforcement is claimed. Older v0.2.34
  RouteLens scheduled baseline/DefectDojo evidence remains prior-release only.

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
