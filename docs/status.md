# Capability status

Release: `0.2.41`
Last verified: 2026-08-02

**Release control:** signed published and deployed `v0.2.41` (source/tag commit
`a168632f754ad526275b85b905256f77e2feade4`). Release workflow run
[`30743019216`](https://github.com/geekyshubham/guardianbot/actions/runs/30743019216)
passed all three jobs and published
[GitHub release `v0.2.41`](https://github.com/geekyshubham/guardianbot/releases/tag/v0.2.41).
Canonical linux/amd64 image
`ghcr.io/geekyshubham/guardianbot@sha256:27c6488c4557595df825493577f4aca106942f56aa4ed53246b8b9cb3b43eefc`.
Independent operator verification passed release asset checksums, signed
release manifest exact identity, Cosign image signature, CycloneDX SBOM
attestation, GitHub OCI provenance bound to source commit/ref and
GitHub-hosted runner, and zero qualifying Critical Trivy findings. Existing
GuardianBot App Platform app only; final ACTIVE deployment
`abf21a1a-25c2-4bfc-8622-0b735956700f`. `control-plane` and `model-bridge` both
pin that exact immutable digest with no mutable tag. Public `/healthz` and
`/readyz` passed on
https://guardianbot-prod-sfdme.ondigitalocean.app. `model-bridge` is
internal-only on port 3001 with no public ingress; bearer-authenticated; routes
only `benchmark-review` through explicit `fixture-bridge` using packaged
`/app/apps/model-bridge/fixtures/live-conformance.json` (public/private solely
for conformance; backend/model `fixture-conformance`; not production AI;
routine and high-risk profiles remain unmapped). Live plumbing path: private
acceptance repo `guardianbot-poc-docs` PR
[#10](https://github.com/geekyshubham/guardianbot-poc-docs/pull/10) merged
`benchmark-review` config at base commit
`9ea4a27dd57ed096b40a6736a9caca000182e844`; PR
[#11](https://github.com/geekyshubham/guardianbot-poc-docs/pull/11) head
`91868973f50546beea905e9a5ae8d8ac2595cc9d` received GuardianBot comment
[#issuecomment-5157162417](https://github.com/geekyshubham/guardianbot-poc-docs/pull/11#issuecomment-5157162417)
reporting `Deterministic fixture-provider conformance review`, AI route
`fixture-bridge` advisory only, risk 0/100, 0 findings, and strict walkthrough
output—proves production control-plane → private authenticated bridge →
`guardian.review.v1` validation/comment plumbing, not production AI. Scanner
workflow run
[`30743688573`](https://github.com/geekyshubham/guardianbot-poc-docs/actions/runs/30743688573)
passed configuration validation, Semgrep, Trivy, policy, provenance
attestation, and immutable upload. Negative control PR
[#47](https://github.com/geekyshubham/guardianbot/pull/47) selected benchmark
only in its PR head while its base lacked that setting and correctly remained
AI unavailable (review config loads from exact base SHA; a PR cannot redirect
its own review). Prior signed `v0.2.40` monitoring/DAST/DefectDojo evidence
remains accurate and historical for that deployment: release source
`d6b5a41a468e515b398db4c530a5936cb8ac7c95`; release run
[`30719671783`](https://github.com/geekyshubham/guardianbot/actions/runs/30719671783);
image `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13`;
ACTIVE deployment `dee798d7-42d9-4c2b-8b44-acfbce7b5944`; multi-cycle operator
ledger through `2026-08-02T08:10:30.142Z` (42/42 successes; AstraNull
`index-freshness` only after full DAST reconciliation; RouteLens still failing
`scanner-zap-nightly` / `scanner-zap-nightly-import`); AstraNull full
DefectDojo reimport TestImport 862; least-privilege DefectDojo user ID 5
`guardianbot-importer-prod` (env-only cutover deployment
`b4f8fda3-c103-4771-91af-2bc0efd24b73`); old token retirement remains open.
**Still not claimed:** production OpenAI Responses credential or live real-model
AI review, routine/high-risk live model review, RouteLens current-binding
scheduled authenticated-full DAST, RouteLens current-binding full DefectDojo
import, seven-day enforcement, GitHub App `pull_request_review_comment`
permission, cross-week monitoring cadence, old DefectDojo automation token
revocation and old superuser deactivation, restore/HA, or full PoC acceptance.
Evidence:
[v0.2.41 live release and fixture bridge](evidence/v0.2.41-live-release-and-bridge.md),
[v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md),
and
[v0.2.40 DefectDojo least-privilege cutover](evidence/v0.2.40-defectdojo-least-privilege.md).
Prior signed `v0.2.39` (release commit
`7524547700e4c3994353f5c61d1625b2bd5e5428`, image
`sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1`)
remains historical for index recovery and fleet pin upgrade: release run
[`30714565807`](https://github.com/geekyshubham/guardianbot/actions/runs/30714565807),
recovery deployment `d69ed8bf-1ed8-4669-8cea-4175513a7527`, guarded replay of
delivery `76eb6aa6-8dd9-11f1-9979-156df2276e83` to `succeeded`, snapshot
17,256 document calls / distinct call IDs / durable edges, and fleet-trust
deployment `2a394a68-9c23-4fd0-8978-8d2018664f81`. See
[live v0.2.39 index recovery](evidence/v0.2.39-live-index-recovery.md) and
[live v0.2.39 fleet upgrade](evidence/v0.2.39-live-fleet-upgrade.md). Prior
v0.2.38 control-plane deployment evidence remains historical:
[v0.2.38 evidence](evidence/v0.2.38-live-control-plane-deployment.md).
Hardening already reflected in this matrix includes lifecycle provenance and
closed-form advisories, descriptor-first durable repository-index candidate
sourcing on the review path, migration and webhook hardening, base-commit
onboarding path binding, the live call-edge duplicate publication fix, the
live private monitoring operations ledger, and related automated fixes.

**Fleet pin upgrade (verified, merged):** generic `guardianctl upgrade --all`
opened 18 draft PRs; all 18 are merged and pin immutable published release
`v0.2.39` exact commit `7524547700e4c3994353f5c61d1625b2bd5e5428` (from
`v0.2.37` `f2a7f5410bd5d8b140378a7c722b74ba0b455727`), including GuardianBot
self-consumer PR [#37](https://github.com/geekyshubham/guardianbot/pull/37).
Fleet consumers pin that immutable SHA for security, image, and DAST evidence.
Control plane is now live on signed `v0.2.41` (ACTIVE deployment
`abf21a1a-25c2-4bfc-8622-0b735956700f`; prior `v0.2.40` deployment
`dee798d7-42d9-4c2b-8b44-acfbce7b5944` and pin-era deployment
`2a394a68-9c23-4fd0-8978-8d2018664f81` are historical). Final target-SHA
inventory at pin time: 19 visible / 16 report-only / 2 advisory-only
(`geekyshubham`, `guardianbot-poc-docs`) / 1 not-applicable fork
(`NotebookLM-Resource-Deleter`) / zero misconfigured / zero
missing-expected-runs. RouteLens is current at head
`5f8990484101feb56733308b3f0b3b01706bdaf8` after remediation PR
[#77](https://github.com/geekyshubham/RouteLens/pull/77) merge
(`2026-08-02T08:11:19Z`); push run
[`30739285447`](https://github.com/geekyshubham/RouteLens/actions/runs/30739285447)
passed deterministic security, exact linux/amd64 build, disposable
dependencies, tests, migrations, runtime smoke, Trivy, CycloneDX SBOM,
Critical policy, immutable push, keyless Cosign signing, attestation, and
provenance; staging App `8cbf8b10-0d55-408f-87fc-2b501a06fada` digest
`sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`,
ACTIVE deployment `56c22a8c-0258-41ab-b839-8a50613810d6` (service and migrate
job use that digest; `/api/v1/health/` 200, `/api/schema/` 200, anonymous
`/api/targets/` 401). Prior RouteLens head
`55eeead5b7306972abfff1b30a32b5cae95e96eb` / digest
`sha256:7ac78ef0d9ab23c14f7e3665a834f21fd73a9be3ceed040b4c76b7a06532dceb` is
historical for the failed full schedule. AstraNull is current at head
`3cb15183e3bf7ccb7326efd461878ce655b66bcb`; push run
[`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728)
(event `push`, success); staging App `2a76914e-d04e-4a6c-8b9c-929a1e8976e2`
digest
`sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`,
ACTIVE deployment `baab86b3-747d-4765-b4eb-39ab31d857cc` (service and migrate
job use that digest; `/health` and `/ready` healthy per ACTIVE
promotion/runtime contract). Intermediate AstraNull head
`6ee73a48e14d3181738c430cd9662acc20ecac3b` / digest
`sha256:ad09cc35894a3299a02fa3198c7f0cbb282d1a982bbacec71f36279cf7b78fc0` /
deployment `df13260c-4f0f-42f7-822d-80b7c1c5e6ee` and prior v0.2.39 head
`3664cff061398c1bf3efc0c937a2470746d60e3d` remain historical/superseded.
Evidence:
[v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md)
and prior
[live v0.2.39 fleet upgrade](evidence/v0.2.39-live-fleet-upgrade.md).
Prior v0.2.37 fleet/promotion evidence remains historical:
[v0.2.37 live control-plane, fleet, and promotion](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md).

AstraNull current-binding genuine scheduled `authenticated-full` is **closed**:
run [`30734622751`](https://github.com/geekyshubham/AstraNull/actions/runs/30734622751)
(event exactly `schedule`, head exactly
`3cb15183e3bf7ccb7326efd461878ce655b66bcb`, success); only executed DAST job
`guardianbot/dast-nightly / authenticated staging DAST`; security-gate, image,
and dast-smoke skipped; full chain passed (staging contract, one-time session,
bounded repository OpenAPI, authenticated assertion and active ZAP API scan,
session destruction, provenance attestation, artifact upload); artifact
`8829127168` digest
`sha256:9116d4c7ccd97e6c0fcd148f48529d30e7b14dbc777de7ad52992b9015f93fbe`;
scan-status schema 1.0.0, profile `authenticated-full`, staging, exact digest
`sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`,
minutes 45, ZAP exit 2; provenance binds `geekyshubham/astranull`,
repositoryId `1287322655`, run/attempt `30734622751/1`, current head,
workflow `.github/workflows/reusable-dast.yml`, workflow SHA
`7524547700e4c3994353f5c61d1625b2bd5e5428`; all 3 manifest hashes/sizes
independently matched. DefectDojo reimport for this full run is independently
verified: TestImport ID 862 (type `reimport`, Test ID 6, created
`2026-08-02T05:44:58.992083Z`, build `30734622751/1`, findings affected 10:
2 reactivated / 8 updated) under Product Type 2 / Product 3 / Engagement 5 /
ZAP Test 6. Later baseline `30737896566/1` reimported as TestImport 867 onto
the same Test ID 6; immutable TestImport 862 remains full-run evidence. See
[v0.2.40 evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md).
Intermediate OIDC role-map repair and manual `workflow_dispatch` baseline
[`30720398948`](https://github.com/geekyshubham/AstraNull/actions/runs/30720398948)
on head `6ee73a48…` remain historical repair evidence only.

RouteLens genuine scheduled `authenticated-full` failure with
`wall_clock_timeout`: run
[`30734627567`](https://github.com/geekyshubham/RouteLens/actions/runs/30734627567)
(event exactly `schedule`, then-current head
`55eeead5b7306972abfff1b30a32b5cae95e96eb` / digest
`sha256:7ac78ef0d9ab23c14f7e3665a834f21fd73a9be3ceed040b4c76b7a06532dceb`);
active ZAP scanned 175 retained GET/HEAD/OPTIONS operations and exceeded the
45-minute wall bound; scan-status `zapExitCode` 3, `failureKind`
`wall_clock_timeout`; artifact `8829613107` digest
`sha256:e40de909d7a8e1963a875d4def733e8b1ccb83d6fc39e48c18d78cf8835d942f`;
valid provenance-bound failure evidence, not a successful full scan.
DefectDojo `test_imports` for build `30734627567/1` returned count 0
(expected after `wall_clock_timeout`). Remediation PR #77 replaced the live
schema with `docs/api/guardianbot-dast-openapi.json` (exactly 3 non-destructive
GETs) and is promoted at current head/digest above; PR checks and push
promotion do **not** prove full DAST. RouteLens scheduled authenticated-full
and its DefectDojo import remain **open** until the next genuine `47 2 * * *`
schedule passes with provenance on the new exact binding. Prior baseline
schedule
[`30718271723`](https://github.com/geekyshubham/RouteLens/actions/runs/30718271723)
is baseline-only history. Historical pre-v0.2.37 baseline and full runs remain
historical only (see outstanding item 5). This does **not** claim production
AI review, seven-day enforcement completion, cross-week monitoring cadence,
old DefectDojo token retirement, or GitHub App review-comment permission.

Independent source review of production-hardening shutdown/cancellation is
recorded under outstanding item 1. The review found nine defects rather than
confirming clean behaviour; seven were fixed with mutation-proven tests and one
was triaged as not a defect, and the suite passes 484 checks across all gate
stages on 2026-08-01 (control-plane 257). That closes the cancellation sub-item
as source/test evidence only, not live cancel-under-load or other
production-readiness work. Those fixes (shutdown/lease hardening and descriptor-first durable review
retrieval already described in this matrix) shipped in signed `v0.2.38`
(PR #31 `b915051274edbbac8175f619c742b4a80a3c1745`, release commit
`d1967eded422b7d3a216ec9aff3ea9e2ce44da33`). Signed `v0.2.39` now carries the
call-edge duplicate publication fix, exact-digest deployment/health, and live
durable edge recovery (see
[v0.2.39 evidence](evidence/v0.2.39-live-index-recovery.md)). Live
descriptor-first PR review consumption and live ANN performance remain open.

This does not claim production model-backed review, seven-day enforcement
completion, reviewed baselines, ruleset readiness, authenticated-full DAST
success on the current RouteLens digest (AstraNull current-binding full and
its DefectDojo reimport TestImport 862 are closed), RouteLens current-binding
full DefectDojo import, old DefectDojo automation token retirement (live active
identity is least-privilege user ID 5; old token not yet revoked), weekly cadence
acceptance across multiple UTC weeks, live GitHub App
`pull_request_review_comment` event application, live PostgreSQL/pgvector/ANN
performance, recovery drills, or full PoC acceptance.

This matrix is the authoritative distinction between implemented behavior and
roadmap intent. A local automated test is evidence that a contract works in the
test environment; it is not evidence that the corresponding GitHub or
DigitalOcean integration is live.

## Outstanding acceptance work

The reusable platform is substantially implemented, but the PoC is not yet
fully accepted. The following items remain open as of **2026-08-02**. An item
must not be marked complete merely because its code or automated test exists;
the stated live evidence must also be captured where required.

### 1. Stabilize and publish the current production-hardening work

- Reconcile the in-progress control-plane, durable retrieval, privacy,
  retention, rate-limit, shutdown, and webhook-hardening changes into one
  stable worktree. **Done:** the stable branch, full repository
  build/test/lint/documentation/schema/workflow gates, PR merge, signed
  `v0.2.37` release, immutable reusable-workflow commit
  `f2a7f5410bd5d8b140378a7c722b74ba0b455727`, exact image digest
  `sha256:5951abf80d82c74c932a0e8f9e3a126203df75e149c08615b34e8051b81ad370`,
  ACTIVE DigitalOcean control-plane deployment, and `/healthz`/`/readyz`
  verification are complete. GuardianBot's own consumer caller/config pin is
  updated to that immutable release commit.
- **Done (source/test only, 2026-08-01):** Independently reviewed the
  production-hardening shutdown/cancellation implementation in source through
  three separate lenses (detached model requests, webhook lease validity, and
  background-loop sequencing). The review was **not** clean: it produced nine
  findings, seven of which were confirmed and fixed, each with a
  mutation-proven test. Pre-existing behaviour that held up: backend model
  calls receive `AbortSignal`, the owned webhook/review handler is **awaited**
  rather than detached, cancellation checkpoints prevent post-review lifecycle
  and GitHub writes after abort, and the delivery lease is requeued without
  consuming attempt budget. Fixed as a result: signal handlers survive a
  repeated `SIGTERM` (`process.on`, not `process.once`); an exhausted drain
  budget now terminates the process inside the container grace period rather
  than running unbounded; in-flight requests are drained before connections are
  destroyed, so an accepted webhook writes its `202` instead of being answered
  with an empty reply and redelivered; the abort signal reaches index rebuilds
  on every dispatch arm and the inline-comment closing loop; monitoring
  cancellation is a distinct outcome so a partial sweep is never published as
  authoritative; and a review write is fenced on the webhook lease that
  authorised it, because the head-SHA compare-and-set cannot separate two
  workers replaying the same delivery. Suite after the fixes: **438 tests, 0
  failures** (control-plane 257). One finding was triaged as **not a defect**
  and deliberately left unchanged. **Not closed:** the `PostgresStore` lease
  fence is asserted only against the statement's source text, since this
  environment has no live PostgreSQL, so its parameter numbering and
  `ON CONFLICT` interaction are unverified at runtime; a request in flight when
  the drain budget expires is still terminated unanswered and redelivered;
  `review_stale_total` no longer distinguishes a moved head SHA from a lost
  lease; and the per-file cancellation checkpoint inside a rebuild has no test.
  This does **not** claim live production cancel-under-load evidence and does
  not close other production-hardening or recovery items.
- Confirm the final repository-index implementation and update the capability
  matrix: automated/local evidence covers descriptor-first durable retrieval on
  the review orchestration path (descriptor load without `getRepositoryIndex` /
  `index_document`, exact-path durable records, durable call-edge
  reconstruction, vector/content hydration, fail-closed isolation,
  truncation/partial outcomes, and metrics). History retrieval remains
  incomplete. **Live failure (pre-v0.2.39):** the first post-v0.2.38
  default-branch index refresh dead-lettered delivery
  `76eb6aa6-8dd9-11f1-9979-156df2276e83` after 5 attempts with PostgreSQL
  `ON CONFLICT DO UPDATE command cannot affect row a second time`. The failed
  materialized index had 17,266 calls but 17,169 distinct call IDs (97
  duplicates); durable publication rolled back. **Done for durable publication
  recovery (signed `v0.2.39`, 2026-08-02):** hotfix PR #34
  `704c9041c78b6e0dfee1d481f9de6cc33b2040f6` and release-prep PR #35
  `7524547700e4c3994353f5c61d1625b2bd5e5428` published as signed `v0.2.39`
  (release run
  [`30714565807`](https://github.com/geekyshubham/guardianbot/actions/runs/30714565807);
  image
  `sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1`;
  ACTIVE deployment `d69ed8bf-1ed8-4669-8cea-4175513a7527`). After ACTIVE, a
  guarded replay matched exactly that dead-lettered delivery (event `push`,
  attempts 5, exact error), reset it to pending with a fresh retry budget (no
  other row matched), and the worker claimed it once to `succeeded` (attempts
  1). Repository `1313112475` advanced `index_sha` to
  `7524547700e4c3994353f5c61d1625b2bd5e5428`. Exact current snapshot: 17,256
  document calls, 17,256 distinct call IDs, 17,256 `repository_index_edges`
  rows, 1,809 vector rows, 1,809 record rows under the same canonical storage
  key. This proves the duplicate durable edge publication defect is fixed live
  and non-empty durable rows publish atomically for the current snapshot. See
  [v0.2.39 evidence](evidence/v0.2.39-live-index-recovery.md). **Still open /
  capability remains Partial:** live PR review consumption of descriptor-first
  rows, live PostgreSQL/pgvector/ANN performance and readiness, and history
  retrieval. Remaining repo-wide support or test semantics that are bounded or
  linear are not fully unbounded durable coverage.
- **Done for fleet pin upgrade to `v0.2.39`:** generic
  `guardianctl upgrade --all` opened 18 draft PRs; all 18 merged and pin
  immutable `7524547700e4c3994353f5c61d1625b2bd5e5428`, including GuardianBot
  PR [#37](https://github.com/geekyshubham/guardianbot/pull/37). Final inventory
  at pin time was healthy (19 visible / 16 report-only / 2 advisory-only
  (`geekyshubham`, `guardianbot-poc-docs`) / 1 not-applicable fork
  (`NotebookLM-Resource-Deleter`) / zero misconfigured / zero
  missing-expected-runs). RouteLens later advanced beyond the pin-era head
  `55eeead5b7306972abfff1b30a32b5cae95e96eb` to current head
  `5f8990484101feb56733308b3f0b3b01706bdaf8` / digest
  `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`.
  AstraNull later advanced beyond the pin-era head
  `3664cff061398c1bf3efc0c937a2470746d60e3d` through intermediate
  `6ee73a48e14d3181738c430cd9662acc20ecac3b` to current head
  `3cb15183e3bf7ccb7326efd461878ce655b66bcb` / digest
  `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`
  (see [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md)).
  Control plane is now signed `v0.2.41` ACTIVE deployment
  `abf21a1a-25c2-4bfc-8622-0b735956700f` (prior `v0.2.40` deployment
  `dee798d7-42d9-4c2b-8b44-acfbce7b5944` and pin-era deployment
  `2a394a68-9c23-4fd0-8978-8d2018664f81` are historical). See
  [v0.2.41 live release and fixture bridge](evidence/v0.2.41-live-release-and-bridge.md)
  and [v0.2.39 live fleet upgrade](evidence/v0.2.39-live-fleet-upgrade.md). Do
  not claim special-case onboarding logic.

**Completion evidence:** clean full CI on the release commit, signed release
artifacts, exact deployed image digest, ACTIVE DigitalOcean control-plane
deployment, `/healthz`/`/readyz`, guarded dead-letter index recovery, and
atomic non-empty durable edge publication are done for signed `v0.2.39` (see
[v0.2.39 index recovery](evidence/v0.2.39-live-index-recovery.md)). Fleet pin
upgrade with versioned evidence and RouteLens/AstraNull exact-digest
promotions are done for `v0.2.39` (see
[v0.2.39 fleet upgrade](evidence/v0.2.39-live-fleet-upgrade.md)). Independent
shutdown/cancellation source review plus control-plane **240/240** on
2026-08-01 closes only that sub-item as source/test evidence. Production AI
review, seven-day enforcement, scheduled authenticated-full DAST on the
current RouteLens digest (AstraNull current-binding full is closed), RouteLens
current-binding full DefectDojo import (AstraNull full reimport TestImport 862
is verified), old DefectDojo automation token retirement (live active identity
is least-privilege user ID 5; see outstanding item 6), live GitHub App feedback
events, live descriptor-first PR review consumption / live pgvector/ANN, weekly
cadence acceptance across multiple UTC weeks, recovery drills, and related
blockers remain open.

### 2. Apply and verify the GitHub App permission/event update

- Apply the manifest change that subscribes the live GitHub App to
  `pull_request_review_comment`; changing the manifest file alone does not
  update an existing installation.
- Reconfirm that the App remains installed only for the intended
  `geekyshubham` repositories and that its permissions remain least-privilege.
- Exercise reviewer feedback ingestion with a test GuardianBot inline comment,
  reply, resolution, and reappearance without reading or modifying unrelated
  reviewer comments.
- Verify feedback retention and privacy behavior in the deployed control
  plane.

**Completion evidence:** sanitized App configuration evidence, one live event
delivery processed successfully, lifecycle/feedback database evidence that
contains no unnecessary comment body or credential data, and passing related
tests.

### 3. Configure and prove a production model bridge

- **Done for live fixture-bridge plumbing (not production AI):** signed
  deployed `v0.2.41` runs internal-only bearer-authenticated `model-bridge` on
  port 3001 with no public ingress; only `benchmark-review` maps to explicit
  `fixture-bridge` using packaged
  `/app/apps/model-bridge/fixtures/live-conformance.json` (backend/model
  `fixture-conformance`; public/private solely for conformance; routine and
  high-risk remain unmapped). Live path on private acceptance repo
  `guardianbot-poc-docs`: PR
  [#10](https://github.com/geekyshubham/guardianbot-poc-docs/pull/10) merged
  `benchmark-review` at base
  `9ea4a27dd57ed096b40a6736a9caca000182e844`; PR
  [#11](https://github.com/geekyshubham/guardianbot-poc-docs/pull/11) head
  `91868973f50546beea905e9a5ae8d8ac2595cc9d` received comment
  [#issuecomment-5157162417](https://github.com/geekyshubham/guardianbot-poc-docs/pull/11#issuecomment-5157162417)
  with `Deterministic fixture-provider conformance review`, AI route
  `fixture-bridge` advisory only, risk 0/100, 0 findings, and strict
  walkthrough—proves control-plane → private bridge → `guardian.review.v1`
  validation/comment plumbing only. Negative control PR
  [#47](https://github.com/geekyshubham/guardianbot/pull/47) selected benchmark
  only on PR head while base lacked it and correctly remained AI unavailable
  (review config loads from exact base SHA). Optional repository
  `review.profile` (`automatic` / `routine-review` / `high-risk-review` /
  `benchmark-review`) with deterministic risk as a floor remains
  automated/local-proven for routing rules; repository config cannot set
  backend URL/alias/model/credential/fallback. See
  [v0.2.41 live release and fixture bridge](evidence/v0.2.41-live-release-and-bridge.md).
- Configure one production OpenAI Responses credential outside repository
  configuration; no model credential may be added to a consumer repository.
- Map `routine-review` to the approved routine backend and reserve the
  high-risk profile for explicitly classified reviews. Fixture deployments
  used for plumbing must keep `profileModels` on `fixture-conformance` for
  benchmark only, use an explicit partial registry (never legacy single-backend
  env), and must not route routine/high-risk production reviews to the fixture.
- Demonstrate one real model-backed pull-request review using the
  provider-neutral `guardian.review.v1` contract and strict `ReviewResult`
  validation (fixture-bridge advisory comment does **not** close this).
- Verify that repository text remains untrusted bounded context, the model has
  no tools, GitHub access, or credentials, malformed output is discarded, and
  backend failure renders `AI review unavailable` without weakening the
  deterministic security gate.
- Capture latency, token/cost, duplicate suppression, grounding, inline-line
  validation, and sanitized error evidence for a real model route.

**Completion evidence:** live fixture-bridge plumbing is proven on `v0.2.41`
(see above). Production OpenAI Responses credential, routine/high-risk model
mapping, and live real-model AI PR review remain open.

### 4. Complete the seven-day scanner observation and enforcement proof

- Allow RouteLens and AstraNull to complete the minimum seven-day report-only
  observation from a qualifying successful default-branch security-gate run.
  As of 2026-08-01 both are ready but not enforcement-ready: RouteLens latest
  gate run
  [`30687346958`](https://github.com/geekyshubham/RouteLens/actions/runs/30687346958)
  with `reportOnlySince` `2026-07-29T05:02:38Z` (~3.05 days); AstraNull latest
  gate run
  [`30687377164`](https://github.com/geekyshubham/AstraNull/actions/runs/30687377164)
  with `reportOnlySince` `2026-07-29T04:58:05Z` (~3.06 days). Both lack
  `.guardianbot/baseline.json`; `rulesetReady=false`; `enforcementReady=false`.
  Scheduled DAST-only runs do not start or advance this clock.
- Confirm every expected Semgrep, Trivy, image, SBOM, signature, import, and
  aggregate-gate artifact is present and provenance-bound during the window.
- Investigate any missing expected run, scanner failure, import failure, stale
  index, expired suppression, or Critical/High finding rather than resetting or
  bypassing the evidence.
- Generate reviewed baselines with `guardianctl baseline`, then run
  `guardianctl doctor` and require `rulesetReady=true` and
  `enforcementReady=true` before proposing enforcement.
- Exercise `guardianctl enforce` through its draft-PR/human-review flow and
  verify the first enforcing gate on the post-merge default-branch commit.
- Confirm the required `guardianbot/security-gate` ruleset blocks a deliberately
  introduced qualifying test finding while AI findings remain advisory.

**Completion evidence:** provenance-bound seven-day observation, reviewed
baseline PR, successful doctor output, reviewed ruleset/enforcement change,
one live passing enforcing gate, and one safe negative blocking test.

### 5. Obtain genuine scheduled authenticated-full DAST evidence

- On 2026-08-01, **before** the v0.2.37 fleet merge and promotions, genuine
  GitHub `schedule` runs completed the authenticated baseline smoke chain for
  both repositories against each then-current v0.2.36 default-branch SHA and
  then-current DigitalOcean deployed digest: AstraNull
  [`30684302779`](https://github.com/geekyshubham/AstraNull/actions/runs/30684302779)
  and RouteLens
  [`30684781163`](https://github.com/geekyshubham/RouteLens/actions/runs/30684781163).
  Each completed staging-contract, one-time session assertion, bounded ZAP,
  and evidence attestation/artifact steps, and each skipped
  `authenticated-full` / `dast-nightly`. Preserve those successes as historical
  baseline-only evidence for the v0.2.36 binding. They are **not** evidence
  against the later-promoted v0.2.37 heads or digests. Baseline success must not
  be reported as full DAST acceptance.
- Independently found delayed genuine GitHub `schedule` **authenticated-full**
  DAST runs from the same pre-v0.2.37 binding (historical only; do **not**
  close required acceptance on current v0.2.37 heads/digests):
  - AstraNull
    [`30686350591`](https://github.com/geekyshubham/AstraNull/actions/runs/30686350591)
    succeeded end-to-end with provenance artifact on old head
    `9f21cabdcbe38b5e8697935914bba165c206229d` and deployed digest
    `sha256:6760bb3a8e1fadba14ae766aa74eb76b5b5f28f782c1354c612a9b488103a3bf`.
  - RouteLens
    [`30686352313`](https://github.com/geekyshubham/RouteLens/actions/runs/30686352313)
    used old head `9722f0ee6abf192508e3fdbc866f662f31fe5d43` and old deployed
    digest
    `sha256:26d56ce97607b1550d7f14396692edff01bac95dcc45199f42ceb414c56e979e`;
    completed the staging contract, one-time session, authenticated assertion,
    and bounded 45-minute ZAP chain but failed provenance attestation with
    HTTP 401 because its old trusted reusable workflow SHA
    `152649be5a86862f619a86d60598fc25bafb0429` was superseded by the v0.2.37
    trust cutover before the long scan finished.
- **Prior RouteLens authenticated-baseline (historical, 2026-08-01 UTC):**
  genuine GitHub `schedule` run
  [`30718271723`](https://github.com/geekyshubham/RouteLens/actions/runs/30718271723)
  on then-current head `55eeead5b7306972abfff1b30a32b5cae95e96eb` / digest
  `sha256:7ac78ef0d9ab23c14f7e3665a834f21fd73a9be3ceed040b4c76b7a06532dceb`.
  Staging contract, one-time session, bounded ZAP, provenance attestation, and
  artifact upload all passed; `guardianbot/dast-nightly` was skipped. Artifact
  `8824056295` digest
  `sha256:19afaae9c663dc3a8f8261a50870672023d3c95967efd50ae561d00c85a689af`.
  Provenance binds repository `geekyshubham/routelens`, run/attempt
  `30718271723/1`, workflow SHA `7524547700e4c3994353f5c61d1625b2bd5e5428`.
  Authenticated-baseline only; does **not** close full DAST acceptance. No
  DefectDojo import/reimport is claimed for this run.
- **Historical/superseded AstraNull scheduled authenticated-baseline:** genuine
  GitHub `schedule` run
  [`30717179796`](https://github.com/geekyshubham/AstraNull/actions/runs/30717179796)
  on superseded head `3664cff061398c1bf3efc0c937a2470746d60e3d` / digest
  `sha256:6c4f2e9cb3a497fe0871cb73cfd7b2aa0f072c2f7e54626d19a6b81a67ce087a`
  (artifact `8823702700` digest
  `sha256:0d7592fe5c23c37838733f63ebf7f716d30e6307822e29b08f1c3e570a82d45b`;
  `dast-nightly` skipped). Baseline-only history; **not** current-binding.
- **AstraNull intermediate repair binding (historical only):** head
  `6ee73a48e14d3181738c430cd9662acc20ecac3b`, push
  [`30720018838`](https://github.com/geekyshubham/AstraNull/actions/runs/30720018838),
  digest
  `sha256:ad09cc35894a3299a02fa3198c7f0cbb282d1a982bbacec71f36279cf7b78fc0`,
  deployment `df13260c-4f0f-42f7-822d-80b7c1c5e6ee`. Superseded schedule
  [`30719475111`](https://github.com/geekyshubham/AstraNull/actions/runs/30719475111)
  on head `6ad95406bf9b45a44763f98852e8a647e0c8a85b` failed twice after session
  exchange because authenticated `/v1/checks` rejected the broker-minted viewer
  token; root cause was missing live `ASTRANULL_OIDC_ROLE_MAP` (DigitalOcean
  spec drift), not a stale exchange credential. Repair added only
  `ASTRANULL_OIDC_ROLE_MAP=owner:owner,admin:admin,engineer:engineer,soc:soc,auditor:auditor,viewer:viewer`
  while keeping `ASTRANULL_OIDC_STAFF_ROLE_MAP` absent (staff elevation
  fail-closed; existing secrets preserved). Post-deploy preflight: `/health`
  200, `/ready` 200, unauthenticated `/v1/checks` 401, bundled staging customer
  viewer login, authenticated `/v1/checks` 200. Manual `workflow_dispatch`
  diagnostic
  [`30720398948`](https://github.com/geekyshubham/AstraNull/actions/runs/30720398948)
  on that intermediate head/digest passed baseline-only chain (artifact
  `8824677012`); **not** genuine schedule evidence and **not** current binding.
- **AstraNull current binding (2026-08-02):** head
  `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, push
  [`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728)
  (event `push`, success), exact digest
  `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`
  ACTIVE on app `2a76914e-d04e-4a6c-8b9c-929a1e8976e2` deployment
  `baab86b3-747d-4765-b4eb-39ab31d857cc` (service and migrate job use that
  digest; `/health` and `/ready` healthy per ACTIVE promotion/runtime contract).
- **AstraNull genuine scheduled authenticated-full (current binding closed):**
  run
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
  independently recomputed and all 3 matched. Closes AstraNull
  current-binding scheduled authenticated-full. DefectDojo reimport
  independently verified as immutable TestImport 862 for build
  `30734622751/1` (see outstanding item 6 and
  [v0.2.40 evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md)).
- **RouteLens genuine scheduled authenticated-full failure
  (`wall_clock_timeout`):** run
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
  independently matched. Valid provenance-bound failure evidence, **not** a
  successful full scan. DefectDojo `test_imports` for build `30734627567/1`
  returned count 0 (expected after `wall_clock_timeout`).
- **RouteLens remediation merged/promoted; next genuine schedule still
  required:** PR [#77](https://github.com/geekyshubham/RouteLens/pull/77)
  merged at current default head
  `5f8990484101feb56733308b3f0b3b01706bdaf8` on `2026-08-02T08:11:19Z` after
  Backend, Frontend, Production artifact, GuardianBot deterministic security,
  and exact-image checks passed. Replaced the 175-operation live schema with
  `docs/api/guardianbot-dast-openapi.json` (exactly 3 non-destructive GET
  operations) through the existing generic repository-file mechanism; keeps
  immutable workflow SHA, one-time auth profile, active-full profile, genuine
  `47 2 * * *` schedule, and 45-minute bound. Current push run
  [`30739285447`](https://github.com/geekyshubham/RouteLens/actions/runs/30739285447)
  passed security/image/sign/attest gates; current signed digest
  `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`;
  App `8cbf8b10-0d55-408f-87fc-2b501a06fada` ACTIVE deployment
  `56c22a8c-0258-41ab-b839-8a50613810d6`; `/api/v1/health/` 200,
  `/api/schema/` 200, anonymous `/api/targets/` 401. Because head/digest
  changed after the failed schedule, RouteLens scheduled authenticated-full
  remains **open** until the next genuine schedule passes with provenance on
  this new exact binding. PR checks and push promotion do **not** prove full
  DAST.
- GitHub environment `guardianbot-dast` now has a custom `main` branch-only
  deployment policy in both RouteLens and AstraNull (re-read from GitHub after
  the AstraNull policy was added). Does not imply required reviewers or prove a
  full scan.
- **Still open for RouteLens only:** on a genuine GitHub `schedule` event,
  verify RouteLens uses its current post-remediation default-branch SHA
  `5f8990484101feb56733308b3f0b3b01706bdaf8` and exact image digest
  `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`
  already deployed to its isolated DigitalOcean staging environment; complete
  the authenticated-full chain (immutable deployment manifest, exact-origin
  staging contract, one-time authenticated session assertion, protected access,
  bounded 30-to-45-minute ZAP profile, safe-route exclusions, evidence
  attestation, and artifact upload); confirm the run is not
  `workflow_dispatch`, not only `authenticated-baseline`, and not a skipped
  `dast-nightly` job. Preserve explicit failure evidence and retry only on the
  next eligible schedule if the contract, session, ZAP, artifact, or provenance
  check fails. AstraNull current-binding full is already closed by run
  `30734622751`.

**Completion evidence:** successful scheduled run URLs for both repositories
on their current SHA/digest bindings with non-skipped authenticated-full jobs
and provenance-bound ZAP reports and attestations. AstraNull current-binding
portion is done (`30734622751`); RouteLens current-binding portion remains
open.

### 6. Verify current DefectDojo import/reimport behavior

- Import successful authenticated-full DAST reports only after provenance has
  independently passed validation. AstraNull run `30734622751` has
  provenance-bound full evidence **and** independently verified DefectDojo
  reimport (below). RouteLens current-binding full is still open.
- **Done for AstraNull current-binding full reimport (2026-08-02 UTC):**
  read-only DefectDojo API via control-plane console (token never printed or
  persisted). `GET /api/v2/test_imports/?build_id=30734622751/1` → HTTP 200,
  count 1; TestImport ID 862, type `reimport`, Test ID 6, created
  `2026-08-02T05:44:58.992083Z`, build `30734622751/1`, commit
  `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, branch `main`, findings affected
  10 (2 reactivated `R`, 8 updated `U`); tags bind attempt 1, branch main,
  exact commit, env staging, image
  `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`,
  profile dast, repo ID 1287322655, repo `geekyshubham/astranull`, run
  30734622751, scan zap-scan, visibility public. Hierarchy: Product Type 2
  `GitHub Repositories`, Product 3 `geekyshubham/AstraNull`, Engagement 5
  `main/dast` (active), ZAP Test 6 `main/dast` / `ZAP Scan`. Later genuine
  scheduled authenticated-baseline `30737896566/1` reimported as TestImport 867
  at `2026-08-02T07:30:23.448587Z` onto the same Test ID 6 (mutable Test now
  shows that later baseline; **immutable TestImport 862** remains full-run
  evidence). Evidence:
  [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md).
- **Done for live least-privilege automation identity cutover (2026-08-02 UTC);
  token retirement still open:** pre-cutover deployed token was user ID 2
  `guardianbot-automation` (staff true, superuser true; Product Type 2
  `authorized_users: []`), proving staff/superuser bypass of OSS Authorized
  Users. Replacement user ID 5 `guardianbot-importer-prod` (active true, staff
  false, superuser false, `configuration_permissions: []`) authorized only on
  Product Type ID 2 via OSS `authorized_users` (not a DefectDojo Pro API
  Importer role). Live mutation conformance under that token: Product 20,
  Engagement 28, Semgrep empty fixture TestImport 878 (`import`) and 879
  (`reimport`) both on stable Test ID 46. Control plane rotated only
  `GUARDIANBOT_DEFECTDOJO_API_TOKEN` on app
  `346b3b81-b8cf-4136-b706-0a7195bc9f00`; ACTIVE deployment
  `b4f8fda3-c103-4771-91af-2bc0efd24b73` (created `2026-08-02T09:10:33Z`,
  updated `2026-08-02T09:11:25Z`, 7/7 steps; same signed v0.2.40 image).
  Injected token resolves to user ID 5; first process-local cycle last
  `2026-08-02T09:11:05.298Z` (1 run / 1 success / 0 failures, 19 repositories,
  6 failing, 13 warning, 33 active alerts). **Production-hardening limitation:**
  the old overprivileged token is no longer deployed but has **not** been
  revoked, and the old superuser account has **not** been deactivated.
  Credential rotation is not fully closed until both complete through an
  approved DefectDojo admin path. Evidence:
  [v0.2.40 DefectDojo least-privilege cutover](evidence/v0.2.40-defectdojo-least-privilege.md).
- **Still open for RouteLens:** current-binding full DAST and its DefectDojo
  import. Failed full build `30734627567/1` has zero TestImports (expected
  after `wall_clock_timeout`; not an import-failure claim). Push-run scanner
  Tests 2/3/4 on build `30739285447/1` are not full DAST evidence.
- Confirm that a failed or missing import is visible to reconciliation and does
  not silently count as scan coverage.

**Completion evidence:** AstraNull full-run portion done (TestImport 862 for
`30734622751/1`). Live active automation identity is least-privilege and
conformance-proven (user ID 5; TestImports 878/879 on Test 46); old token
revocation and old account deactivation remain a production-hardening
limitation. Still required: independently verified Test ID and reimport
timestamp for RouteLens current-binding full-DAST run ID, a tested
failed-import alert, and old-token/account retirement. Older baseline reimports
are retained as historical evidence only. Overall DefectDojo acceptance remains
partial.

### 7. Prove continuous monitoring over live scheduled operation

- **Done for authenticated metrics transport (pre-`v0.2.40` image, 2026-08-01
  UTC):** on DigitalOcean app `346b3b81-b8cf-4136-b706-0a7195bc9f00`, exact
  signed image
  `sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1`,
  ACTIVE deployment `3f0b58cd-52b7-481b-b4d6-7f29d9dad283`, public `/healthz`
  and `/readyz` returned 200; unauthenticated `/metrics` returned 404; exact
  `GUARDIANBOT_METRICS_BEARER_TOKEN` (DigitalOcean secret / local operator
  credential only—value never documented) succeeded. After that deployment,
  process-local scheduler gauges showed enabled=1, started=1, one successful
  cycle, zero failures, zero consecutive failures, zero lock skips, 19
  repositories evaluated, **7 failing repositories**, 0 warning repositories,
  and **28 active alerts**. That 7/28 aggregate was a real unresolved
  production signal from `/metrics` on the prior image.
- **Done for live operator ledger on signed `v0.2.40` (2026-08-01/02 UTC):**
  release source `d6b5a41a468e515b398db4c530a5936cb8ac7c95`, release run
  [`30719671783`](https://github.com/geekyshubham/guardianbot/actions/runs/30719671783),
  exact signed image
  `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13`,
  ACTIVE deployment `dee798d7-42d9-4c2b-8b44-acfbce7b5944`; `/healthz` and
  `/readyz` HTTP 200; unauthenticated `GET /operations/monitoring` HTTP 404;
  exact private bearer returns schema `guardianbot.monitoring.status.v1`
  (bearer never documented). First live snapshot at
  `2026-08-01T21:47:39.197Z` remains the post-deploy baseline (1 successful
  run, 7 failing, 20 active alerts). Current multi-cycle snapshot at
  `2026-08-02T08:10:30.142Z` (last completed cycle
  `2026-08-02T08:02:09.438Z`): enabled/started, running false, 42 runs / 42
  successes, 0 failures, 0 consecutive failures, 0 lock skips, 19 repositories
  evaluated, 6 failing, 13 warnings, 35 active alerts. Weekly report: scanner
  expected 18 / successful 18 / evidence complete 11 / missing-evidence alerts
  7; fresh indexes 18 / stale 1; protected digests 2 / complete-evidence
  digests 2 / missing-evidence digests 4; review source unavailable and zero
  AI review metrics; inventory report-only 16 / advisory-only 2 /
  misconfigured 1. AstraNull active alerts contain only `index-freshness`
  warning; prior active `scanner-zap-nightly` and
  `scanner-zap-nightly-import` alerts for AstraNull are absent after the
  successful full run/reconciliation. RouteLens still has failing
  `scanner-zap-nightly` and `scanner-zap-nightly-import` alerts plus freshness
  warnings. Proves multi-cycle process-local scheduler success and observed
  AstraNull active-alert recovery. Operator ledger does **not** replace the
  independent DefectDojo API proof (AstraNull full reimport is TestImport 862;
  RouteLens current-binding full import remains open). Does **not** prove
  weekly cadence across multiple UTC weeks. Evidence:
  [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md).
- Still open: observe nightly full Semgrep/Trivy and deployed-digest rescans
  across the applicable fleet; verify repository-index freshness,
  expected-workflow reconciliation, RouteLens DefectDojo reconciliation,
  suppression/risk-acceptance expiry, and remaining missing
  SBOM/signature/deployment evidence alerts; demonstrate install/removal
  discovery without cross-repository leakage; resolve or triage remaining
  failing/active-alert and missing-evidence signals (including RouteLens
  scanner-zap-nightly failures); prove weekly cadence acceptance across
  multiple UTC weeks.

**Completion evidence:** multi-cycle post-`v0.2.40` process-local scheduler
success (42/42) and observed AstraNull active-alert recovery are proven;
RouteLens DefectDojo current-binding full import, weekly cadence across
multiple UTC weeks, and inventory with no unexplained missing expected runs
remain open. Direct database/SSH firewall broadening is not required for
metrics or the operator ledger.

### 8. Finish production-readiness and recovery evidence

- Run a restore drill for control-plane PostgreSQL and retained audit evidence;
  destructive restore testing must use an isolated DigitalOcean test target.
- Document and verify backup retention, credential rotation, compromised-bridge
  response, emergency disablement, scanner/import failure, and DAST
  authentication failure runbooks.
- Verify deployment reconciliation for the exact staging topology in use and
  explicitly retain any non-reconciled Droplet behavior as a limitation.
- Record scaling/HA as unverified until exercised; a healthy single PoC
  deployment is not HA evidence.

**Completion evidence:** dated restore/rotation drill records, passing runbook
checks, and updated operations/security documentation with remaining risks.

### 9. Close documentation and final PoC acceptance

- Update this page and `CHANGELOG.md` for the final release using only facts
  supported by automated or live evidence.
- Add versioned evidence for the production AI review, seven-day observation,
  enforcement, both authenticated-full DAST runs, current DefectDojo reimports,
  weekly monitoring, and recovery drills.
- Re-run Markdown/link/schema/OpenAPI/Mermaid/CLI-help/config-reference quality
  gates and verify that public commands and fields match their implementations.
- Re-run the documented five-minute deployment/onboarding path as a new
  engineer and record any undocumented prerequisite.
- Publish a final acceptance report that separates verified PoC behavior from
  later production roadmap work.

**Completion evidence:** passing documentation CI, traceable evidence links for
every accepted capability, no unsupported `Working` claim, and a final blocker
list containing only explicitly deferred production roadmap items.

| Capability | Status | Supported scope | Last verified evidence | Required configuration | Known limitation / failure behavior |
| --- | --- | --- | --- | --- | --- |
| `guardian.review.v1` protocol and strict result validation | Working | Any conforming bridge | [protocol tests](../packages/protocol/test/protocol.test.ts) and [HTTP loopback conformance](../apps/model-bridge/test/conformance-http.test.ts) | Approved administrative backend profile | Invalid, ungrounded, stale, oversized, or malformed output is discarded. Schema-invalid review requests fail closed with non-retryable `400` `bad_request`; automated loopback wire conformance is covered. Internal GitHub repositories route model reviews as `restricted` (test-verified; live real-model AI review still pending). Live fixture-bridge plumbing is proven on `v0.2.41` ([evidence](evidence/v0.2.41-live-release-and-bridge.md)). Optional repository `review.profile` (`automatic` default, `routine-review`, `high-risk-review`, `benchmark-review`) is test-verified: deterministic risk is a floor (explicit routine cannot downgrade high-risk; explicit high-risk escalates; benchmark selects benchmark); repository config chooses only the profile name, never backend URL/alias/model/credential/fallback; missing admin route yields `AI review unavailable` while deterministic checks continue. No production OpenAI Responses credential or real-model AI PR review is configured yet; live fixture-provider conformance advisory is not production AI |
| Provider-neutral backend registry | Working | Administratively approved bridges | [control-plane bridge tests](../apps/control-plane/test/backend-registry-private-network.test.ts) and [control-plane service profile routing tests](../apps/control-plane/test/service.test.ts) | Backend URL/token only on the control plane; optional repository `review.profile` selects an approved profile name only | Cross-backend fallback is off unless explicitly approved. Registry and bridge config stay separated; provider credentials exist only on the bridge. Repository-selected profile routing is automated/local for full matrix; live `benchmark-review` → `fixture-bridge` plumbing is verified on `v0.2.41` ([evidence](evidence/v0.2.41-live-release-and-bridge.md)). Production OpenAI Responses credential and live real-model AI PR review remain open; routine/high-risk routes unmapped |
| Responses API strict adapter | Working | `gpt-5.6-terra` routine and `gpt-5.6-sol` high-risk/benchmark profiles | [bridge adapter tests](../apps/model-bridge/test/adapters.test.ts) | OpenAI credential only in the isolated bridge | Automated evidence only; no production bridge credential is configured yet |
| OpenAI-compatible and fixture adapters | Working | Capability-checked compatible gateways and tests | [bridge service tests](../apps/model-bridge/test/service.test.ts), [HTTP loopback conformance](../apps/model-bridge/test/conformance-http.test.ts), and [packaged live-conformance fixture tests](../apps/model-bridge/test/packaged-fixture.test.ts) | Administrative adapter configuration | Unsupported strict-schema capabilities fail closed. Request/output validation is fail-closed on the bridge; provider and internal failures stay sanitized and do not leak prompts, credentials, endpoints, or provider bodies. A prompt exceeding a route's `maxInputCharacters` raises a typed non-retryable error instead of being reclassified as a retryable backend outage, and an oversized upstream response cancels its stream reader before raising so the connection is not leaked. Packaged `apps/model-bridge/fixtures/live-conformance.json` (runtime path `/app/apps/model-bridge/fixtures/live-conformance.json` once released) returns a strict zero-finding deterministic conformance result for bridge/plumbing verification only—never production AI. Fixture deployments must explicitly map `profileModels` to `fixture-conformance`, use an explicit partial registry (never legacy single-backend env), and must not route routine/high-risk production reviews to the fixture. **Live plumbing verified on signed `v0.2.41`:** internal-only bearer-authenticated `model-bridge` (port 3001, no public ingress) routes only `benchmark-review` through `fixture-bridge` with packaged `/app/apps/model-bridge/fixtures/live-conformance.json` (backend/model `fixture-conformance`; public/private solely for conformance); live PR comment on `guardianbot-poc-docs` [#11](https://github.com/geekyshubham/guardianbot-poc-docs/pull/11#issuecomment-5157162417) proved control-plane → private bridge → `guardian.review.v1` validation/comment plumbing (fixture advisory only: risk 0/100, 0 findings); negative control PR [#47](https://github.com/geekyshubham/guardianbot/pull/47) correctly remained AI unavailable when base lacked `benchmark-review`. See [v0.2.41 live release and fixture bridge](evidence/v0.2.41-live-release-and-bridge.md). Production OpenAI Responses credential and real model-backed review remain absent; routine/high-risk profiles remain unmapped |
| Documentation quality gates | Working | Tracked repository documentation | [documentation gate tests](../scripts/check-docs.test.mjs) | None | Normal CI validates external URL structure; live external reachability is opt-in |
| Repository detection and configuration generation | Working | Python, Node, Swift, Ruby, Docker, OpenAPI, and documentation repositories | [detection tests](../packages/core/test/detection-contract.test.ts), [CLI contract tests](../packages/guardianctl/test/config-contract.test.ts), and [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md) | Repository read access | All six repository classes are verified through the same live onboarding flow. Detection is bounded and heuristic; runtime environment values still require reviewed repository-specific configuration |
| `guardianctl onboard`, `doctor`, `baseline`, `enforce`, `upgrade`, `inventory`, and `offboard` | Working | Authenticated GitHub repositories | [CLI tests](../packages/guardianctl/test/cli.test.ts), [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 fleet inventory evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 fleet evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Operator GitHub authorization; immutable workflow SHA for mutate commands (`onboard`, `doctor`, `baseline`, `enforce`, `upgrade`) | Automated tests cover `baseline` from a provenance-bound successful report-only `gate.json` after the minimum seven-day observation period, including the independently verified first observation-run proof (`repository`, `headSha`, `runId`, `runAttempt`, `startedAt`) and rejection when observation repository differs from source; the command opens a draft PR for human review and never switches scanner mode, rulesets, or merges. `doctor`/`inventory` select security-gate evidence from the most recent fresh run that emitted the gate (Actions job or run-bound check URL), ignore later DAST-only omitted/skipped scheduled gates on the same SHA, fail closed on a later push/`workflow_dispatch` with a missing or skipped gate and on any non-skipped failed gate (including schedule). Seven-day observation starts only from a successful push/`workflow_dispatch` whose exact run has a present, non-skipped, successful security gate (scheduled runs never start the clock; merge push is the normal start). `enforce` opens a draft PR; PR checks stay report-only due base-branch config binding, so the first enforce-mode proof is the post-merge default-branch gate (test-verified wording; no live enforcement claimed). `inventory` may run without `GUARDIANBOT_WORKFLOW_SHA` and classifies pins from each repository's validated config/caller data (still rejects mutable, zero, or mismatched pins); an explicit target SHA may additionally flag repositories behind that pin. Live generic `upgrade --all` opened 18 draft PRs; all 18 merged and pin immutable v0.2.39 `7524547700e4c3994353f5c61d1625b2bd5e5428` (including GuardianBot PR #37; no special-case onboarding logic claimed). Final live target-SHA inventory reports 19 visible / 16 report-only / 2 advisory-only (`geekyshubham`, `guardianbot-poc-docs`) / 1 not-applicable fork (`NotebookLM-Resource-Deleter`) with zero misconfigured and zero missing-expected-runs. Doctors are status ready but `enforcementReady=false` for AstraNull and RouteLens (~3.05–3.06 days observed as of the prior observation window; no `.guardianbot/baseline.json`; `rulesetReady=false`). Seven-day live enforcement promotion remains pending |
| GitHub App discovery and onboarding issue | Working | Selected or all-repository App installations | [control-plane service tests](../apps/control-plane/test/service.test.ts), [indexer tests](../packages/core/test/indexer.test.ts), [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md), and [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md) | App permissions and subscribed events | The live concurrency race is fixed in v0.2.31 with a database-wide per-repository lock; all six fresh fixtures retain one canonical inventory issue. Linux Swift Tree-sitter indexing requires the documented 4 GB worker memory floor |
| Advisory PR placeholder and grouped review | Beta | Ready pull requests | [control-plane service tests](../apps/control-plane/test/service.test.ts) and [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md) | Active repository record, approved administrative bridge route, and optional repository `review.profile` | Live ready-PR placeholder updates and explicit unavailable-backend degradation are verified on six repository types. Repository-selected profile routing (automatic floor, routine non-downgrade, high-risk escalate, benchmark explicit, missing-route `AI review unavailable`) is automated/local test-verified; live fixture-bridge advisory comment is proven on `guardianbot-poc-docs` PR #11 ([evidence](evidence/v0.2.41-live-release-and-bridge.md)). A production real-model AI-backed PR review remains unverified; production OpenAI Responses credential remains open |
| Incremental stable-fingerprint lifecycle | Partial | Persisted PR review records | [store tests](../apps/control-plane/test/store.test.ts) and [service lifecycle tests](../apps/control-plane/test/service.test.ts) | Active repository | Lifecycle records persist provenance (first/last-seen head SHA and timestamps, transition and reappearance counts, and finding identity), so a finding that returns after a terminal state is detectable and is surfaced while it is still open through the advisory lifecycle line, a returned-finding entry, and `finding_reappeared_total`. Resolved, superseded, and returned findings render per finding, bounded so a churn-heavy pull request cannot outgrow the GitHub comment limit. GuardianBot rewrites only its own top-level inline advisories to a closed form, never deleting them and never touching a reviewer comment or a reply: the fingerprint marker is anchored to the start of the body so a quoted advisory cannot be matched. Lifecycle state derives from every reported finding rather than the inline selection, so a finding below the inline cap is not announced as resolved while the model still reports it. Retained findings are bounded by a configurable TTL and cap in which only terminal states are evictable. Feedback analytics remains planned: capturing reviewer signal requires the `pull_request_review_comment` event, which is deliberately not subscribed on the installation. Automated/local evidence only |
| Semgrep and full-class Trivy gate | Beta | Code, dependency, configuration, secret, and license evidence | [scanner tests](../packages/core/test/core.test.ts), [zero-result sanitizer tests](../packages/core/test/trivy-sanitizer.test.ts), [workflow security tests](../packages/core/test/workflow-security.test.ts), [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 fleet inventory evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 fleet evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Generated caller; reviewed `guardianbot.baseline.v1` for enforce mode | License findings stay report-only; RouteLens and AstraNull report-only PR and default-branch gates pass live (RouteLens post-merge gate run [`30687346958`](https://github.com/geekyshubham/RouteLens/actions/runs/30687346958); AstraNull post-merge gate run [`30687377164`](https://github.com/geekyshubham/AstraNull/actions/runs/30687377164)). Verified v0.2.39 target-SHA inventory shows fleet expected-run/gate coverage is healthy (19 visible / 16 report-only / 2 advisory-only / 1 fork not applicable / zero misconfigured / zero missing expected runs); see [v0.2.39 fleet upgrade](evidence/v0.2.39-live-fleet-upgrade.md). Enforce-mode non-PR runtime readiness attestation (strict `source` + seven-day `observation` provenance, ruleset required check, fail-closed GitHub API evidence) is automated-test verified only; reviewed baselines, live seven-day observation completion (~3.05–3.06 days so far; both lack `.guardianbot/baseline.json`; `rulesetReady=false`; `enforcementReady=false`), and live enforcement remain pending. Pull request runs resolve onboarding state from the canonical `.guardianbot/config.yml` path in the base commit rather than the head-supplied `config-path` input, so a pull request cannot repoint that input at a path absent from base to present itself as first onboarding and weaken its own gate; onboarded repositories must pass the canonical path, and an unresolvable or unreachable base commit fails closed instead of falling back to head configuration. Generated callers already pass the canonical path, so onboarded repositories are unaffected and genuine first onboarding still resolves head configuration in non-enforcing mode |
| Trusted scanner evidence ingestion | Beta | Pinned reusable workflows on GitHub-hosted runners | [evidence tests](../apps/control-plane/test/scanner-evidence.test.ts) and [Trivy normalization tests](../packages/core/test/core.test.ts) | Exact workflow SHA, App Actions read, and evidence attestation | PostgreSQL parent-before-evidence ordering, real GitHub workflow-run paths without an `@ref` suffix, skipped caller jobs without child-job records, and Trivy misconfigurations with empty `AVDID` fields are covered; promotion identity is derived only from the verified default-branch push; independent control-plane rejection of Critical-bearing promotion artifacts is covered by the evidence tests; missing, mismatched, oversized, or untrusted evidence fails reconciliation |
| Image build, runtime smoke, Trivy, and CycloneDX SBOM | Working | Dockerized repositories | [workflow security tests](../packages/core/test/workflow-security.test.ts), [control-plane smoke tests](../apps/control-plane/test/image-smoke.test.ts), [live RouteLens/AstraNull evidence](evidence/v0.2.14-live-poc.md), [fresh Docker evidence](evidence/v0.2.31-fresh-repository-acceptance.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 promotion evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Declarative image profile | Fresh generic Docker onboarding is verified live. GuardianBot's self-caller/config and fleet managed callers use the v0.2.39 immutable SHA (`7524547700e4c3994353f5c61d1625b2bd5e5428`); report-only image publication remains disabled by default (`promotionMode` enforce-only). Explicit `verified-default-branch` may publish only Critical-clean default-branch images; advisory callers and Critical-bearing report-only builds still retain evidence without publication; enforce mode blocks Critical findings. Live RouteLens current: push [`30739285447`](https://github.com/geekyshubham/RouteLens/actions/runs/30739285447) at head `5f8990484101feb56733308b3f0b3b01706bdaf8` (digest `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`). AstraNull current: push [`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728) at head `3cb15183e3bf7ccb7326efd461878ce655b66bcb` (digest `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`). Intermediate AstraNull head `6ee73a48…` / digest `ad09cc…` and prior RouteLens head `55eeead5…` are historical/superseded. Scanner mode stays report-only; RouteLens scheduled authenticated-full remains open; AstraNull current-binding full is closed by genuine schedule [`30734622751`](https://github.com/geekyshubham/AstraNull/actions/runs/30734622751). See [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md) |
| Cosign and provenance-bound image promotion | Working | Critical-clean default-branch images | [release evidence tests](../scripts/release-evidence.test.mjs), [workflow security tests](../packages/core/test/workflow-security.test.ts), [control-plane evidence tests](../apps/control-plane/test/scanner-evidence.test.ts), [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 promotion evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | GitHub OIDC, immutable release identity, and permitted `promotionMode` | Automated tests cover reusable-workflow mode authorization, promote-job Critical-clean evidence recheck, and independent control-plane rejection before DigitalOcean. Defaults stay enforce-only/backward-compatible. GuardianBot's self-caller/config and fleet managed callers use the v0.2.39 immutable SHA (`7524547700e4c3994353f5c61d1625b2bd5e5428`). Live RouteLens current promoted digest `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119` (head `5f8990484101feb56733308b3f0b3b01706bdaf8`, push [`30739285447`](https://github.com/geekyshubham/RouteLens/actions/runs/30739285447), ACTIVE deployment `56c22a8c-0258-41ab-b839-8a50613810d6`). AstraNull current promoted digest `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473` (head `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, push [`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728), ACTIVE deployment `baab86b3-747d-4765-b4eb-39ab31d857cc`) was signed, attested, and published under generic promotion with scanner mode still report-only; intermediate AstraNull digest `sha256:ad09cc…` / head `6ee73a48…` and prior RouteLens digest `sha256:7ac78ef0…` are historical/superseded. See [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md) |
| Deployment-bound one-time DAST session broker | Beta | Exact-origin DigitalOcean staging with an approved authentication profile | [session broker tests](../apps/control-plane/test/dast-session.test.ts), [live RouteLens broker evidence](evidence/v0.2.25-routelens-dast.md), [live AstraNull broker evidence](evidence/v0.2.26-astranull-dast.md), [live v0.2.40 monitoring and current DAST evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 promotion evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | `GUARDIANBOT_DAST_PROFILES_JSON`, matching accepted deployment evidence, and protected `guardianbot-dast` environment | Current staging digests: RouteLens `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119` (head `5f899048…`); AstraNull `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473` (head `3cb15183…`). **AstraNull genuine scheduled authenticated-full (current binding closed):** [`30734622751`](https://github.com/geekyshubham/AstraNull/actions/runs/30734622751) (artifact `8829127168`; ZAP exit 2). **RouteLens genuine scheduled authenticated-full failure:** [`30734627567`](https://github.com/geekyshubham/RouteLens/actions/runs/30734627567) on prior head `55eeead5…` / digest `7ac78ef0…` (`wall_clock_timeout`; artifact `8829613107`); remediation PR #77 promoted at current binding; next genuine schedule still required. Intermediate AstraNull OIDC repair and dispatch [`30720398948`](https://github.com/geekyshubham/AstraNull/actions/runs/30720398948) on head `6ee73a48…` are historical only. AstraNull full DefectDojo reimport verified (TestImport 862); RouteLens current-binding full import open. Hardening covered by tests: `authenticated-full` sessions require a genuine `schedule` event; `scanProfile` is request- and lease-bound; baseline/full minute constraints fail early. Other profiles fail closed unless SHA, environment, origin, and digest all match; static credentials require an explicit PoC-only switch |
| Exact-origin safe-operation ZAP smoke and nightly workflows | Beta | `GET`, `HEAD`, and `OPTIONS` OpenAPI routes on isolated staging | [workflow security tests](../packages/core/test/workflow-security.test.ts), [live RouteLens XML/DefectDojo evidence](evidence/v0.2.28-routelens-defectdojo.md), [live AstraNull XML/DefectDojo evidence](evidence/v0.2.28-astranull-defectdojo.md), [live v0.2.40 monitoring and current DAST evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.34 scheduled RouteLens baseline evidence](evidence/v0.2.34-live-fleet-and-scheduled-dast.md), [live v0.2.33 authenticated-baseline evidence](evidence/v0.2.33-live-promotion-and-dast.md), [earlier passive-smoke evidence](evidence/v0.2.14-zap-summary.json), [live v0.2.37 fleet/promotion evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 fleet/promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Onboarding DAST configuration, deployment-bound broker profile, and scheduled/manual run | **AstraNull genuine scheduled authenticated-full (current binding closed):** [`30734622751`](https://github.com/geekyshubham/AstraNull/actions/runs/30734622751) on head `3cb15183e3bf7ccb7326efd461878ce655b66bcb` / digest `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473` (artifact `8829127168` digest `sha256:9116d4c7ccd97e6c0fcd148f48529d30e7b14dbc777de7ad52992b9015f93fbe`; profile `authenticated-full`, 45 minutes, ZAP exit 2; workflow SHA `7524547700e4c3994353f5c61d1625b2bd5e5428`). **RouteLens genuine scheduled authenticated-full failure:** [`30734627567`](https://github.com/geekyshubham/RouteLens/actions/runs/30734627567) on prior head `55eeead5…` / digest `7ac78ef0…` (`wall_clock_timeout`, zapExitCode 3, artifact `8829613107`); remediation PR #77 promoted at current head `5f899048…` / digest `f99d875c…`; next genuine schedule still required (PR/push do not prove full DAST). Intermediate AstraNull head `6ee73a48…` / dispatch [`30720398948`](https://github.com/geekyshubham/AstraNull/actions/runs/30720398948) and prior baselines remain historical. Pre-v0.2.37 scheduled baselines (`30684302779`, `30684781163`) and delayed full runs (`30686350591`, `30686352313`) remain historical only. AstraNull full DefectDojo reimport verified (TestImport 862 for `30734622751/1`); RouteLens current-binding full import open (`30734627567/1` TestImports count 0 after `wall_clock_timeout`). Deploy smoke is passive safe mode. `authenticated-full` is schedule-only at the generated caller and session broker; manual `workflow_dispatch` remains baseline-only. Baseline is capped at 15 minutes; full requires at least 30 and at most 45, failing early on invalid minutes |
| DefectDojo import/reimport client | Working | Dedicated DigitalOcean DefectDojo OSS v2 API | [client tests](../packages/defectdojo/test/client.test.ts), [control-plane evidence tests](../apps/control-plane/test/scanner-evidence.test.ts), [immutable stack tests](../tests/infra-defectdojo.test.mjs), [live platform evidence](evidence/v0.2.27-defectdojo.md), [live RouteLens workflow evidence](evidence/v0.2.28-routelens-defectdojo.md), [live AstraNull workflow evidence](evidence/v0.2.28-astranull-defectdojo.md), [live v0.2.34 RouteLens scheduled reimport evidence](evidence/v0.2.34-live-fleet-and-scheduled-dast.md), [live v0.2.40 AstraNull full reimport evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.40 least-privilege cutover](evidence/v0.2.40-defectdojo-least-privilege.md), and [v0.2.37 live evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md) | Central HTTPS URL/token and dedicated OSS automation identity (Product Type Authorized Users; not Pro API Importer) | Live isolated conformance plus RouteLens and AstraNull workflow reimports preserve their scanner Test IDs and provenance. **AstraNull current-binding full reimport independently verified (2026-08-02):** TestImport 862 for build `30734622751/1` (type `reimport`, Test ID 6, created `2026-08-02T05:44:58.992083Z`, findings affected 10: 2R/8U) under Product Type 2 / Product 3 / Engagement 5 / ZAP Test 6; later baseline `30737896566/1` reimported as TestImport 867 onto the same Test ID 6 (mutable Test shows later baseline; immutable TestImport 862 is full-run evidence). RouteLens failed full `30734627567/1` has zero TestImports (expected after `wall_clock_timeout`). RouteLens Test ID 5 remains historical v0.2.34 baseline evidence. **Live active automation identity (2026-08-02):** user ID 5 `guardianbot-importer-prod` (staff false, superuser false, Product Type 2 OSS Authorized Users only); conformance Product 20 / Engagement 28 / TestImports 878+879 on Test 46; env-only cutover deployment `b4f8fda3-c103-4771-91af-2bc0efd24b73`. **Production-hardening limitation:** old overprivileged token not revoked and old superuser account not deactivated. **Still open / overall acceptance partial:** RouteLens current-binding full DAST and its DefectDojo import, tested failed-import alert, and old-token/account retirement. Older v0.2.36/pre-v0.2.37 runs remain historical only |
| Repository-isolated index | Partial | Python, JavaScript/TypeScript, Swift, Ruby, and text fallback | [indexer tests](../packages/core/test/indexer.test.ts), [store vector tests](../apps/control-plane/test/store.test.ts), [repository-index service tests](../apps/control-plane/test/repository-index-service.test.ts), [review-path wiring tests](../apps/control-plane/test/service.test.ts), [retrieval tests](../packages/core/test/index-retrieval.test.ts), [index coverage tests](../packages/monitoring/test/monitoring.test.ts), and [live v0.2.39 index recovery](evidence/v0.2.39-live-index-recovery.md) | Active repository and commit snapshot; pgvector for durable ranking | Review orchestration is implemented descriptor-first: it loads a `RepositoryIndexDescriptor` from first-class `repository_indexes` columns and does not call `getRepositoryIndex` or load/parse `index_document`. Durable exact-path records are queried under repository scope with limit+1 truncation detection, and changed-path records are included outside ANN top-N. Durable call edges are stored and queryable and reconstruct caller, callee, and the call-edge-derived test relation. Vector candidates and record contents are hydrated from durable storage. Repository isolation is fail-closed: malformed, foreign, or truncated durable results yield explicit partial/isolation behaviour rather than silent complete context. Metrics cover durable retrieval and truncation/partial outcomes. Automated tests prove review still succeeds when `getRepositoryIndex` throws, and cover exact-path retrieval, durable edges, isolation, truncation, and descriptor-only review. A durable pgvector read path ranks nearest neighbours; the review path supplies `RepositoryIndexService.repositoryVectorRanker` with a matching local embedding provider; relevance is recomputed locally to avoid store score-polarity mismatch; the `vector_ann` column is written only for matching dimensions so another width degrades to an exact scan; boot builds the approximate index only while the table is effectively empty (operator step at or above the ceiling, documented in [operations](operations.md#approximate-vector-index)); incremental refresh reuses vectors by content digest across a `compare` range and falls back to a full rebuild when the range is not a plain forward advance or the changed-file list may be truncated; indexing caps are configuration; superseded generations are pruned outside the migration path. **Live failure (pre-v0.2.39):** the first default-branch index refresh after signed v0.2.38 dead-lettered delivery `76eb6aa6-8dd9-11f1-9979-156df2276e83` after 5 attempts with PostgreSQL `ON CONFLICT DO UPDATE command cannot affect row a second time`. The failed materialized index had 17,266 calls but 17,169 distinct call IDs (97 duplicates); durable publication rolled back. **Done for durable publication recovery (signed `v0.2.39`):** release commit `7524547700e4c3994353f5c61d1625b2bd5e5428`, image `sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1`, ACTIVE deployment `d69ed8bf-1ed8-4669-8cea-4175513a7527`. Guarded replay matched exactly that dead-lettered delivery, reset it to pending with a fresh retry budget (no other row matched), and the worker claimed it once to `succeeded` (attempts 1). Repository `1313112475` advanced `index_sha` to the release commit. Exact current snapshot under the same canonical storage key: 17,256 document calls, 17,256 distinct call IDs, 17,256 `repository_index_edges` rows, 1,809 vector rows, 1,809 record rows. Proves the duplicate durable edge publication defect is fixed live and non-empty durable rows publish atomically for the current snapshot (see [v0.2.39 evidence](evidence/v0.2.39-live-index-recovery.md)). **Still Partial / incomplete:** live PR review consumption of descriptor-first rows, live ANN performance/readiness, and history remain open; remaining repo-wide support or test semantics that are bounded or linear are not fully unbounded durable coverage. Does not claim production model-backed review, seven-day enforcement, RouteLens current-binding authenticated-full DAST, or RouteLens current-binding full DefectDojo import (AstraNull full reimport TestImport 862 is separately verified). Fleet pins at `v0.2.39` are recorded separately in [v0.2.39 fleet upgrade](evidence/v0.2.39-live-fleet-upgrade.md). |
| Continuous reconciliation and weekly coverage | Beta | Installed repositories with expected workflows | [monitoring tests](../packages/monitoring/test/monitoring.test.ts), [service tests](../apps/control-plane/test/monitoring-service.test.ts), [operations HTTP tests](../apps/control-plane/test/monitoring-operations.test.ts), [operations docs](operations.md#private-metrics-and-operator-monitoring-status), [live v0.2.40 monitoring evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.13 evidence](evidence/v0.2.13-digitalocean-app-platform.md), [19-repository inventory evidence](evidence/v0.2.31-fresh-repository-acceptance.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 fleet inventory evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 fleet inventory evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Scheduler, App Actions read, durable store, and private metrics policy | Control plane is now signed `v0.2.41` ACTIVE deployment `abf21a1a-25c2-4bfc-8622-0b735956700f` (image `sha256:27c6488c4557595df825493577f4aca106942f56aa4ed53246b8b9cb3b43eefc`; [v0.2.41 evidence](evidence/v0.2.41-live-release-and-bridge.md)). Prior signed `v0.2.40` operator ledger on ACTIVE deployment `dee798d7-42d9-4c2b-8b44-acfbce7b5944` (image `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13`): unauthenticated `/operations/monitoring` 404; exact private bearer returns `guardianbot.monitoring.status.v1` (bearer never documented). First live snapshot `2026-08-01T21:47:39.197Z` remains post-deploy baseline. Current multi-cycle snapshot `2026-08-02T08:10:30.142Z` (last cycle `2026-08-02T08:02:09.438Z`): 42 runs / 42 successes, 0 failures, 0 lock skips, 19 evaluated, **6 failing / 13 warning / 35 active alerts**; weekly scanner expected 18 / successful 18 / evidence complete 11 / missing-evidence alerts 7; fresh indexes 18 / stale 1; protected digests 2 / complete-evidence digests 2 / missing-evidence digests 4; review source unavailable; zero AI review metrics. AstraNull active alerts contain only `index-freshness` after full DAST reconciliation; RouteLens still has failing `scanner-zap-nightly` and `scanner-zap-nightly-import` alerts. Proves multi-cycle process-local success and observed AstraNull alert recovery. Operator ledger is not the DefectDojo API proof (AstraNull full reimport is TestImport 862; RouteLens current-binding full import open). Does **not** prove weekly cadence across multiple UTC weeks. Prior `/metrics` 7/28 aggregate on image `sha256:49e8e477…` remains historical |
| Exact signed/deployed image evidence matching | Beta | Repositories with image promotion and deployment configuration | [monitoring tests](../packages/monitoring/test/monitoring.test.ts) | Matching signed digest and deployment environment | A local Docker image ID is never accepted as a registry digest |
| DigitalOcean App Platform digest reconciler | Beta | Centrally allowlisted GHCR services, workers, and jobs | [deployment tests](../apps/control-plane/test/digitalocean-deployment.test.ts), [live RouteLens evidence](evidence/v0.2.25-routelens-dast.md), [live AstraNull evidence](evidence/v0.2.26-astranull-dast.md), [live v0.2.40 monitoring and current DAST evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [live v0.2.39 control-plane evidence](evidence/v0.2.39-live-index-recovery.md), [historical v0.2.38 control-plane evidence](evidence/v0.2.38-live-control-plane-deployment.md), [historical v0.2.37 promotion evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` and central token reference | GuardianBot control plane is live on signed `v0.2.41` image `sha256:27c6488c4557595df825493577f4aca106942f56aa4ed53246b8b9cb3b43eefc` (existing App Platform app; ACTIVE deployment `abf21a1a-25c2-4bfc-8622-0b735956700f`; `/healthz` and `/readyz` passed on https://guardianbot-prod-sfdme.ondigitalocean.app; `model-bridge` co-deployed on the same immutable digest, internal-only). Prior `v0.2.40` deployment `dee798d7-42d9-4c2b-8b44-acfbce7b5944` / image `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13` is historical. RouteLens is current: app `8cbf8b10-0d55-408f-87fc-2b501a06fada` on `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119` (head `5f8990484101feb56733308b3f0b3b01706bdaf8`, ACTIVE deployment `56c22a8c-0258-41ab-b839-8a50613810d6`; `/api/v1/health/` 200, `/api/schema/` 200, anonymous `/api/targets/` 401). AstraNull is current on `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473` (head `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, push [`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728), ACTIVE deployment `baab86b3-747d-4765-b4eb-39ab31d857cc`; `/health` and `/ready` healthy per ACTIVE promotion/runtime contract). Intermediate AstraNull digest `sha256:ad09cc…` / head `6ee73a48…` and prior RouteLens digest `sha256:7ac78ef0…` / head `55eeead5…` are historical/superseded. See [v0.2.41 live release and fixture bridge](evidence/v0.2.41-live-release-and-bridge.md) and [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md). Additional repositories remain unverified |
| DigitalOcean Droplet isolated application staging | Working | RouteLens and AstraNull exact promoted digests | [immutable staging tests](../tests/infra-staging.test.mjs) and [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md) | One hardened DigitalOcean Droplet, central GHCR read authentication, and root-only generated environment | Exact images, HTTPS, negative and positive authentication, and network isolation are verified; control-plane deployment reconciliation is not yet wired to the Droplet |
| Signed GuardianBot DigitalOcean deployment scripts | Beta | Dedicated droplet or existing `guardianbot-prod` App Platform app | [deployment script tests](../scripts/deployment-security.test.mjs), [live v0.2.14 App Platform evidence](evidence/v0.2.14-live-poc.md), [live v0.2.27 DefectDojo Droplet evidence](evidence/v0.2.27-defectdojo.md), [live v0.2.40 monitoring and current DAST evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [live v0.2.39 control-plane deployment and index recovery evidence](evidence/v0.2.39-live-index-recovery.md), [historical v0.2.38 control-plane deployment evidence](evidence/v0.2.38-live-control-plane-deployment.md), [historical v0.2.37 control-plane rotation evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), and [historical v0.2.36 control-plane rotation evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Canonical signed release asset directory | App Platform and the dedicated DefectDojo Droplet path are live. GuardianBot control plane is live on signed `v0.2.41` image `sha256:27c6488c4557595df825493577f4aca106942f56aa4ed53246b8b9cb3b43eefc` (ACTIVE deployment `abf21a1a-25c2-4bfc-8622-0b735956700f`; `/healthz` and `/readyz` passed; release run [`30743019216`](https://github.com/geekyshubham/guardianbot/actions/runs/30743019216); see [v0.2.41 live release and fixture bridge](evidence/v0.2.41-live-release-and-bridge.md)). Prior `v0.2.40` ACTIVE deployment `dee798d7-42d9-4c2b-8b44-acfbce7b5944` / image `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13` / release run [`30719671783`](https://github.com/geekyshubham/guardianbot/actions/runs/30719671783) remains historical monitoring evidence ([v0.2.40](evidence/v0.2.40-live-monitoring-and-current-dast.md)). Index-recovery deployment `d69ed8bf-1ed8-4669-8cea-4175513a7527` on image `sha256:49e8e47741337e20b0fe6cf05acb8eef8121e065d0c1293efb9745f1de3625a1` remains the v0.2.39 recovery record (release run [`30714565807`](https://github.com/geekyshubham/guardianbot/actions/runs/30714565807)). Prior v0.2.39 fleet-trust deployment `2a394a68-9c23-4fd0-8978-8d2018664f81`, and earlier v0.2.38/v0.2.37/v0.2.36 control-plane digest/deployment IDs, remain historical only. Destructive restore drills, HA, and off-host backup proof remain unverified |
| Control-plane PostgreSQL and private metrics transport | Working | DigitalOcean managed PostgreSQL or private Compose PostgreSQL | [database tests](../apps/control-plane/test/store.test.ts), [HTTP security tests](../apps/control-plane/test/http-security.test.ts), [operations HTTP tests](../apps/control-plane/test/monitoring-operations.test.ts), [operations docs](operations.md#private-metrics-and-operator-monitoring-status), [metrics transport docs](metrics.md#monitoring-model), and [live v0.2.40 monitoring evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md) | CA pin for managed PostgreSQL; `GUARDIANBOT_METRICS_BEARER_TOKEN` or private Compose `GUARDIANBOT_TRUST_PRIVATE_METRICS=1` | Public Caddy returns `404` for `/metrics` and `/operations/monitoring`; App Platform requires the exact bearer. **Live signed `v0.2.41`:** ACTIVE deployment `abf21a1a-25c2-4bfc-8622-0b735956700f` (image `sha256:27c6488c4557595df825493577f4aca106942f56aa4ed53246b8b9cb3b43eefc`; `/healthz`/`/readyz` passed on https://guardianbot-prod-sfdme.ondigitalocean.app). **Prior signed `v0.2.40` operator-ledger proof (2026-08-01 UTC):** ACTIVE deployment `dee798d7-42d9-4c2b-8b44-acfbce7b5944` (image `sha256:a86d9adc209037c99bc489d0c7efed92a2f09ab2e2b657dd007d762437040f13`; `/healthz`/`/readyz` 200); unauthenticated `/operations/monitoring` 404; exact private bearer returns `guardianbot.monitoring.status.v1` (bearer never documented). Prior `/metrics` proof on deployment `3f0b58cd-52b7-481b-b4d6-7f29d9dad283` (image `sha256:49e8e477…`) remains historical. Operators do not need direct database or SSH firewall broadening. Readiness is process/store oriented, not a substitute for external health monitoring. Migrations serialize behind a PostgreSQL session advisory lock on a dedicated connection, so concurrent instance boots wait instead of racing on `IF NOT EXISTS` DDL. The container health check probes `/readyz` so a failed store dependency marks the container unhealthy, with `/healthz` remaining a pure liveness probe |
| Authoritative webhook queue metrics and terminal retention | Working | Shared in-memory or PostgreSQL webhook job store | [store tests](../apps/control-plane/test/store.test.ts), [metrics implementation](../apps/control-plane/src/metrics.ts), [operations retention docs](operations.md#webhook-queue-retention), and [v0.2.37 evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md) | Optional `GUARDIANBOT_WEBHOOK_*` retention/cleanup bounds | `/metrics` exposes pending, leased, dead-letter, and runnable gauges from the shared store and returns `503` if that refresh fails. Bounded cleanup deletes only terminal `succeeded`/`dead-letter` rows; pending and leased jobs are never purged. The `/webhooks/github` body read is guarded, so a pre-authentication client abort cannot terminate the process, and process-level unhandled-rejection/uncaught-exception handlers drain through the existing shutdown path. Webhook responses carry fixed strings only: signature/delivery failures answer `401`/`400` from a typed error and enqueue failures answer a static `503` that GitHub redelivers, so no internal error text reaches an unauthenticated caller. Shutdown/cancellation was independently reviewed in source on 2026-08-01 with control-plane tests **240/240**: backend calls receive `AbortSignal`, the owned handler is awaited (not detached), cancellation checkpoints block post-review lifecycle/GitHub writes, and the delivery lease is requeued without consuming attempt budget. GitHub throttling likewise requeues at the reported reset instant without consuming the attempt budget, so a burst cannot dead-letter jobs, while a `403` carrying no budget signal stays a permanent failure. `/metrics` adds `github_rate_limited_total` and a `guardianbot_github_ratelimit_remaining` gauge that stays absent until GitHub reports a budget, and the webhook latency histogram is valid Prometheus output with `+Inf` as its maximum. Automated/local and independent source-review evidence only; no live cancel-under-load claim |
| RouteLens and AstraNull full digest promotion and DAST | Partial | Those two repositories through the generic onboarding flow | [live image promotion and staging evidence](evidence/v0.2.14-live-poc.md), [RouteLens DefectDojo evidence](evidence/v0.2.28-routelens-defectdojo.md), [AstraNull DefectDojo evidence](evidence/v0.2.28-astranull-defectdojo.md), [live v0.2.40 monitoring and current DAST evidence](evidence/v0.2.40-live-monitoring-and-current-dast.md), [live v0.2.39 fleet upgrade evidence](evidence/v0.2.39-live-fleet-upgrade.md), [historical v0.2.37 fleet/promotion evidence](evidence/v0.2.37-live-control-plane-fleet-and-promotion.md), [historical AstraNull v0.2.37 promotion repair](evidence/v0.2.37-astranull-current-promotion-repair.md), [historical v0.2.36 fleet/promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md), [live v0.2.34 scheduled DAST evidence](evidence/v0.2.34-live-fleet-and-scheduled-dast.md), and [live v0.2.33 promotion and DAST evidence](evidence/v0.2.33-live-promotion-and-dast.md) | Broker profile and DefectDojo | Scanner mode remains report-only. **Current RouteLens:** head `5f8990484101feb56733308b3f0b3b01706bdaf8`, digest `sha256:f99d875c5ad4a3439186b4783db7cbc221f66ee30b84914843731b528d839119`, ACTIVE deployment `56c22a8c-0258-41ab-b839-8a50613810d6` (app `8cbf8b10-0d55-408f-87fc-2b501a06fada`); remediation PR #77 merged after prior genuine schedule authenticated-full failure [`30734627567`](https://github.com/geekyshubham/RouteLens/actions/runs/30734627567) (`wall_clock_timeout` on head `55eeead5…` / digest `7ac78ef0…`, artifact `8829613107`). RouteLens current-binding full remains **open** until the next genuine schedule. **Current AstraNull:** head `3cb15183e3bf7ccb7326efd461878ce655b66bcb`, push [`30722621728`](https://github.com/geekyshubham/AstraNull/actions/runs/30722621728), digest `sha256:061ed079c9d95ef792d92c3ab55af40d2ece8a3f234e741ec1e6afa66f587473`, ACTIVE deployment `baab86b3-747d-4765-b4eb-39ab31d857cc` (app `2a76914e-d04e-4a6c-8b9c-929a1e8976e2`); genuine schedule authenticated-full [`30734622751`](https://github.com/geekyshubham/AstraNull/actions/runs/30734622751) closed current-binding full (artifact `8829127168`; ZAP exit 2). Intermediate AstraNull head `6ee73a48…` / digest `ad09cc…` / dispatch [`30720398948`](https://github.com/geekyshubham/AstraNull/actions/runs/30720398948) is historical repair only. AstraNull full DefectDojo reimport independently verified (TestImport 862 for `30734622751/1`); RouteLens current-binding full DefectDojo import remains open. Live DefectDojo automation identity is least-privilege user ID 5 (conformance-proven); old token retirement remains a production-hardening limitation ([least-privilege cutover](evidence/v0.2.40-defectdojo-least-privilege.md)). Doctors remain `enforcementReady=false` (no `.guardianbot/baseline.json`; `rulesetReady=false`). Production model credential/live AI review, seven-day live enforcement observation, weekly cadence across multiple UTC weeks, recovery drills, live GitHub App feedback events, and live pgvector/ANN remain pending. Evidence: [v0.2.40 live monitoring and current DAST](evidence/v0.2.40-live-monitoring-and-current-dast.md) |
| Cross-provider model fallback | Not applicable | Disabled by default | [model protocol](model-protocol.md) | Explicit repository visibility/data-classification approval | Unavailable AI becomes advisory `AI review unavailable`; deterministic checks continue |

Statuses mean:

- **Working**: the described behavior has passing automated evidence.
- **Beta**: implemented with automated evidence but still needs the stated live
  environment verification.
- **Partial**: material behavior is intentionally incomplete.
- **Planned**: roadmap only; it must not be represented as implemented.
- **Not applicable**: deliberately excluded or disabled.
