# Capability status

Release: `0.2.37`
Last verified: 2026-08-01

**Release control:** `v0.2.37` is the release candidate being prepared for
code and documentation automated verification (hardening already reflected in
this matrix: lifecycle provenance and closed-form advisories, durable
repository-index candidate sourcing on the review path, migration and webhook
hardening, base-commit onboarding path binding, and related automated fixes).
No signed `v0.2.37` release, tag, or container image is claimed yet.

The live DigitalOcean control plane, fleet consumer pins, RouteLens/AstraNull
exact-digest promotions, and ACTIVE deployments remain at verified signed
`v0.2.36` (2026-07-30) until post-release deployment and upgrade evidence is
captured:
https://github.com/geekyshubham/guardianbot/releases/tag/v0.2.36. See
[live v0.2.36 control-plane and fleet upgrade evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md).
On 2026-08-01, genuine scheduled authenticated-baseline smoke completed for
both current default-branch SHAs and exact DigitalOcean deployed digests
(AstraNull run `30684302779`, RouteLens run `30684781163`); each skipped
`authenticated-full` / `dast-nightly`. No new DefectDojo import/reimport was
independently verified for those runs. Scheduled authenticated-full acceptance
and a current DefectDojo reimport remain open.

This does not claim a signed `v0.2.37` release/tag/image, DigitalOcean
deployment of `v0.2.37`, fleet upgrade to `v0.2.37`, GitHub App event
application, live PostgreSQL/pgvector/ANN performance, production model-backed
review, seven-day enforcement completion, authenticated-full DAST success, or a
new DefectDojo import.

This matrix is the authoritative distinction between implemented behavior and
roadmap intent. A local automated test is evidence that a contract works in the
test environment; it is not evidence that the corresponding GitHub or
DigitalOcean integration is live.

## Outstanding acceptance work

The reusable platform is substantially implemented, but the PoC is not yet
fully accepted. The following items remain open as of **2026-08-01**. An item
must not be marked complete merely because its code or automated test exists;
the stated live evidence must also be captured where required.

### 1. Stabilize and publish the current production-hardening work

- Reconcile the in-progress control-plane, durable retrieval, privacy,
  retention, rate-limit, shutdown, and webhook-hardening changes into one
  stable worktree. **Done locally/GitHub:** the stable branch, full repository
  build/test/lint/documentation/schema/workflow gates, and PR merge for this
  hardening set are complete for the `v0.2.37` release candidate.
- Independently review cancellation behavior so shutdown cannot leave a
  detached model request or webhook handler mutating state after its lease is
  released.
- Confirm the final repository-index implementation and update the capability
  matrix: automated/local evidence now closes the materialised-candidate
  barrier (durable ANN recall, batch hydration, production review-path
  wiring), but live PostgreSQL/pgvector verification, live ANN performance,
  and production deployment of that path remain incomplete.
- **Still pending:** publish a new signed GuardianBot release, immutable
  reusable-workflow commit, container image, changelog, and release evidence.
  Deploy it only to the approved DigitalOcean control plane and verify
  `/healthz` and `/readyz`. Capture post-release deployment and fleet-upgrade
  evidence; live control plane and consumers remain on verified `v0.2.36`
  until that evidence exists.

**Completion evidence:** clean full CI on the release commit (local/GitHub
gates for the candidate are complete), signed release artifacts, immutable
workflow SHA, exact deployed image digest, ACTIVE DigitalOcean deployment, and
updated versioned evidence in this repository.

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

- Configure one production bridge credential outside repository configuration;
  no model credential may be added to a consumer repository.
- Map `routine-review` to the approved routine backend and reserve the
  high-risk/benchmark profile for explicitly classified reviews.
- Demonstrate one real pull-request review using the provider-neutral
  `guardian.review.v1` contract and strict `ReviewResult` validation.
- Verify that repository text remains untrusted bounded context, the model has
  no tools, GitHub access, or credentials, malformed output is discarded, and
  backend failure renders `AI review unavailable` without weakening the
  deterministic security gate.
- Capture latency, token/cost, duplicate suppression, grounding, inline-line
  validation, and sanitized error evidence.

**Completion evidence:** a live PR placeholder updated with a valid review,
schema-validation logs without prompt or secret disclosure, and a deliberate
invalid/unavailable-backend test proving advisory degradation.

### 4. Complete the seven-day scanner observation and enforcement proof

- Allow RouteLens and AstraNull to complete the minimum seven-day report-only
  observation from a qualifying successful default-branch security-gate run.
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

- On 2026-08-01, genuine GitHub `schedule` runs completed the authenticated
  baseline smoke chain for both repositories against each current
  default-branch SHA and exact DigitalOcean deployed digest: AstraNull
  [`30684302779`](https://github.com/geekyshubham/AstraNull/actions/runs/30684302779)
  and RouteLens
  [`30684781163`](https://github.com/geekyshubham/RouteLens/actions/runs/30684781163).
  Each completed staging-contract, one-time session assertion, bounded ZAP,
  and evidence attestation/artifact steps, and each skipped
  `authenticated-full` / `dast-nightly`. Baseline success must not be reported
  as full DAST acceptance.
- The required scheduled `authenticated-full` acceptance evidence is still
  missing for both repositories.
- On a genuine GitHub `schedule` event, verify each repository uses its current
  default-branch SHA and the exact image digest already deployed to its isolated
  DigitalOcean staging environment.
- Verify the complete authenticated-full chain: immutable deployment manifest,
  exact-origin staging contract, one-time authenticated session assertion,
  protected access, bounded 30-to-45-minute ZAP profile, safe-route exclusions,
  evidence attestation, and artifact upload.
- Confirm the run is not `workflow_dispatch`, not only
  `authenticated-baseline`, and not a skipped `dast-nightly` job.
- Preserve explicit failure evidence and retry only on the next eligible
  schedule if the contract, session, ZAP, artifact, or provenance check fails.

**Completion evidence:** successful scheduled run URLs for both repositories,
non-skipped authenticated-full jobs, current SHA/digest bindings, and
provenance-bound ZAP reports and attestations.

### 6. Verify current DefectDojo import/reimport behavior

- Import the successful authenticated-full RouteLens and AstraNull DAST reports
  only after their provenance has independently passed validation.
- Verify product/engagement/test identity, build and commit metadata, tags,
  severity counts, deduplication, and reimport behavior directly against the
  dedicated DigitalOcean-hosted DefectDojo instance.
- Confirm that a failed or missing import is visible to reconciliation and does
  not silently count as scan coverage.
- Reduce the PoC automation identity to the documented least-privilege role and
  record the remaining production-hardening limitations.

**Completion evidence:** independently verified Test IDs and reimport
timestamps tied to the two current full-DAST run IDs, plus a tested failed-import
alert. Older baseline reimports are retained as historical evidence only.

### 7. Prove continuous monitoring over live scheduled operation

- Observe nightly full Semgrep and Trivy runs and deployed-digest rescans across
  the applicable fleet.
- Verify repository-index freshness, expected-workflow reconciliation,
  DefectDojo reconciliation, suppression/risk-acceptance expiry, and missing
  SBOM/signature/deployment evidence alerts.
- Produce a post-expansion weekly coverage and review-value report for the
  current installed-repository inventory.
- Demonstrate that newly installed and removed repositories are discovered and
  classified without leaking or retaining cross-repository context.
- Validate alert delivery, deduplication, recovery, and failure visibility over
  more than a single scheduler cycle.

**Completion evidence:** versioned scheduler snapshots, at least one current
weekly report, representative alert-and-recovery evidence, and an inventory
with no unexplained missing expected runs.

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
| `guardian.review.v1` protocol and strict result validation | Working | Any conforming bridge | [protocol tests](../packages/protocol/test/protocol.test.ts) and [HTTP loopback conformance](../apps/model-bridge/test/conformance-http.test.ts) | Approved administrative backend profile | Invalid, ungrounded, stale, oversized, or malformed output is discarded. Schema-invalid review requests fail closed with non-retryable `400` `bad_request`; automated loopback wire conformance is covered. Internal GitHub repositories route model reviews as `restricted` (test-verified; live AI review still pending). No production model credential or live AI review is configured yet |
| Provider-neutral backend registry | Working | Administratively approved bridges | [control-plane bridge tests](../apps/control-plane/test/backend-registry-private-network.test.ts) | Backend URL/token only on the control plane | Cross-backend fallback is off unless explicitly approved. Registry and bridge config stay separated; provider credentials exist only on the bridge |
| Responses API strict adapter | Working | `gpt-5.6-terra` routine and `gpt-5.6-sol` high-risk/benchmark profiles | [bridge adapter tests](../apps/model-bridge/test/adapters.test.ts) | OpenAI credential only in the isolated bridge | Automated evidence only; no production bridge credential is configured yet |
| OpenAI-compatible and fixture adapters | Working | Capability-checked compatible gateways and tests | [bridge service tests](../apps/model-bridge/test/service.test.ts) and [HTTP loopback conformance](../apps/model-bridge/test/conformance-http.test.ts) | Administrative adapter configuration | Unsupported strict-schema capabilities fail closed. Request/output validation is fail-closed on the bridge; provider and internal failures stay sanitized and do not leak prompts, credentials, endpoints, or provider bodies. A prompt exceeding a route's `maxInputCharacters` raises a typed non-retryable error instead of being reclassified as a retryable backend outage, and an oversized upstream response cancels its stream reader before raising so the connection is not leaked |
| Documentation quality gates | Working | Tracked repository documentation | [documentation gate tests](../scripts/check-docs.test.mjs) | None | Normal CI validates external URL structure; live external reachability is opt-in |
| Repository detection and configuration generation | Working | Python, Node, Swift, Ruby, Docker, OpenAPI, and documentation repositories | [detection tests](../packages/core/test/detection-contract.test.ts), [CLI contract tests](../packages/guardianctl/test/config-contract.test.ts), and [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md) | Repository read access | All six repository classes are verified through the same live onboarding flow. Detection is bounded and heuristic; runtime environment values still require reviewed repository-specific configuration |
| `guardianctl onboard`, `doctor`, `baseline`, `enforce`, `upgrade`, `inventory`, and `offboard` | Working | Authenticated GitHub repositories | [CLI tests](../packages/guardianctl/test/cli.test.ts), [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md), and [live v0.2.36 fleet inventory evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Operator GitHub authorization; immutable workflow SHA for mutate commands (`onboard`, `doctor`, `baseline`, `enforce`, `upgrade`) | Automated tests cover `baseline` from a provenance-bound successful report-only `gate.json` after the minimum seven-day observation period, including the independently verified first observation-run proof (`repository`, `headSha`, `runId`, `runAttempt`, `startedAt`) and rejection when observation repository differs from source; the command opens a draft PR for human review and never switches scanner mode, rulesets, or merges. `doctor`/`inventory` select security-gate evidence from the most recent fresh run that emitted the gate (Actions job or run-bound check URL), ignore later DAST-only omitted/skipped scheduled gates on the same SHA, fail closed on a later push/`workflow_dispatch` with a missing or skipped gate and on any non-skipped failed gate (including schedule). Seven-day observation starts only from a successful push/`workflow_dispatch` whose exact run has a present, non-skipped, successful security gate (scheduled runs never start the clock; merge push is the normal start). `enforce` opens a draft PR; PR checks stay report-only due base-branch config binding, so the first enforce-mode proof is the post-merge default-branch gate (test-verified wording; no live enforcement claimed). `inventory` may run without `GUARDIANBOT_WORKFLOW_SHA` and classifies pins from each repository's validated config/caller data (still rejects mutable, zero, or mismatched pins); an explicit target SHA may additionally flag repositories behind that pin. Live `upgrade --all` merged 18 generated PRs to the immutable v0.2.36 pin; final live target-SHA inventory reports 19 visible / 16 report-only / 2 advisory-only / 1 not-applicable fork with zero misconfigured and zero missing-expected-runs. career-ops post-merge scanner gate passed in 43s (full applicable workflow 12m25s, within 15 minutes) with 31 Critical image findings retained report-only (not Critical-clean). Doctors are ready/report-only for AstraNull and RouteLens (~1.41 days observed; baseline missing; `rulesetReady=false`; `enforcementReady=false`). Seven-day live enforcement promotion remains pending |
| GitHub App discovery and onboarding issue | Working | Selected or all-repository App installations | [control-plane service tests](../apps/control-plane/test/service.test.ts), [indexer tests](../packages/core/test/indexer.test.ts), [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md), and [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md) | App permissions and subscribed events | The live concurrency race is fixed in v0.2.31 with a database-wide per-repository lock; all six fresh fixtures retain one canonical inventory issue. Linux Swift Tree-sitter indexing requires the documented 4 GB worker memory floor |
| Advisory PR placeholder and grouped review | Beta | Ready pull requests | [control-plane service tests](../apps/control-plane/test/service.test.ts) and [fresh-repository evidence](evidence/v0.2.31-fresh-repository-acceptance.md) | Active repository record and approved bridge | Live ready-PR placeholder updates and explicit unavailable-backend degradation are verified on six repository types; a production AI-backed result remains unverified |
| Incremental stable-fingerprint lifecycle | Partial | Persisted PR review records | [store tests](../apps/control-plane/test/store.test.ts) and [service lifecycle tests](../apps/control-plane/test/service.test.ts) | Active repository | Lifecycle records persist provenance (first/last-seen head SHA and timestamps, transition and reappearance counts, and finding identity), so a finding that returns after a terminal state is detectable and is surfaced while it is still open through the advisory lifecycle line, a returned-finding entry, and `finding_reappeared_total`. Resolved, superseded, and returned findings render per finding, bounded so a churn-heavy pull request cannot outgrow the GitHub comment limit. GuardianBot rewrites only its own top-level inline advisories to a closed form, never deleting them and never touching a reviewer comment or a reply: the fingerprint marker is anchored to the start of the body so a quoted advisory cannot be matched. Lifecycle state derives from every reported finding rather than the inline selection, so a finding below the inline cap is not announced as resolved while the model still reports it. Retained findings are bounded by a configurable TTL and cap in which only terminal states are evictable. Feedback analytics remains planned: capturing reviewer signal requires the `pull_request_review_comment` event, which is deliberately not subscribed on the installation. Automated/local evidence only |
| Semgrep and full-class Trivy gate | Beta | Code, dependency, configuration, secret, and license evidence | [scanner tests](../packages/core/test/core.test.ts), [zero-result sanitizer tests](../packages/core/test/trivy-sanitizer.test.ts), [workflow security tests](../packages/core/test/workflow-security.test.ts), [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md), and [live v0.2.36 fleet inventory evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Generated caller; reviewed `guardianbot.baseline.v1` for enforce mode | License findings stay report-only; RouteLens and AstraNull report-only PR and default-branch gates pass live. Verified v0.2.36 target-SHA inventory shows fleet expected-run/gate coverage is healthy (19 visible / 16 report-only / 2 advisory-only / 1 fork not applicable / zero misconfigured / zero missing expected runs). Enforce-mode non-PR runtime readiness attestation (strict `source` + seven-day `observation` provenance, ruleset required check, fail-closed GitHub API evidence) is automated-test verified only; reviewed baselines, live seven-day observation completion, ruleset readiness, and live enforcement remain pending. Pull request runs resolve onboarding state from the canonical `.guardianbot/config.yml` path in the base commit rather than the head-supplied `config-path` input, so a pull request cannot repoint that input at a path absent from base to present itself as first onboarding and weaken its own gate; onboarded repositories must pass the canonical path, and an unresolvable or unreachable base commit fails closed instead of falling back to head configuration. Generated callers already pass the canonical path, so onboarded repositories are unaffected and genuine first onboarding still resolves head configuration in non-enforcing mode (test-verified; reaches consumers only on a future pinned release) |
| Trusted scanner evidence ingestion | Beta | Pinned reusable workflows on GitHub-hosted runners | [evidence tests](../apps/control-plane/test/scanner-evidence.test.ts) and [Trivy normalization tests](../packages/core/test/core.test.ts) | Exact workflow SHA, App Actions read, and evidence attestation | PostgreSQL parent-before-evidence ordering, real GitHub workflow-run paths without an `@ref` suffix, skipped caller jobs without child-job records, and Trivy misconfigurations with empty `AVDID` fields are covered; promotion identity is derived only from the verified default-branch push; independent control-plane rejection of Critical-bearing promotion artifacts is covered by the evidence tests; missing, mismatched, oversized, or untrusted evidence fails reconciliation |
| Image build, runtime smoke, Trivy, and CycloneDX SBOM | Working | Dockerized repositories | [workflow security tests](../packages/core/test/workflow-security.test.ts), [control-plane smoke tests](../apps/control-plane/test/image-smoke.test.ts), [live RouteLens/AstraNull evidence](evidence/v0.2.14-live-poc.md), [fresh Docker evidence](evidence/v0.2.31-fresh-repository-acceptance.md), and [live v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Declarative image profile | Fresh generic Docker onboarding is verified live. GuardianBot's self-caller/config use the v0.2.36 immutable SHA (`152649be5a86862f619a86d60598fc25bafb0429`); report-only image publication remains disabled by default (`promotionMode` enforce-only). Explicit `verified-default-branch` may publish only Critical-clean default-branch images; advisory callers and Critical-bearing report-only builds still retain evidence without publication; enforce mode blocks Critical findings. Live RouteLens and AstraNull v0.2.36 runs verified deterministic scanner, image build/smoke/Trivy/SBOM, and push/sign/attest under generic promotion while scanner mode stayed report-only; career-ops retained 31 Critical image findings without blocking in report-only (not Critical-clean) |
| Cosign and provenance-bound image promotion | Working | Critical-clean default-branch images | [release evidence tests](../scripts/release-evidence.test.mjs), [workflow security tests](../packages/core/test/workflow-security.test.ts), [control-plane evidence tests](../apps/control-plane/test/scanner-evidence.test.ts), [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md), and [live v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | GitHub OIDC, immutable release identity, and permitted `promotionMode` | Automated tests cover reusable-workflow mode authorization, promote-job Critical-clean evidence recheck, and independent control-plane rejection before DigitalOcean. Defaults stay enforce-only/backward-compatible. GuardianBot's self-caller/config use the v0.2.36 immutable SHA (`152649be5a86862f619a86d60598fc25bafb0429`). Live RouteLens and AstraNull v0.2.36 generic promotions signed, attested, and published exact digests with scanner mode still report-only; exact-digest App Platform reconciliation is tracked in the deployment rows |
| Deployment-bound one-time DAST session broker | Beta | Exact-origin DigitalOcean staging with an approved authentication profile | [session broker tests](../apps/control-plane/test/dast-session.test.ts), [live RouteLens broker evidence](evidence/v0.2.25-routelens-dast.md), [live AstraNull broker evidence](evidence/v0.2.26-astranull-dast.md), and [live v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | `GUARDIANBOT_DAST_PROFILES_JSON`, matching accepted deployment evidence, and protected `guardianbot-dast` environment | Live RouteLens and AstraNull baseline sessions were verified on earlier deployment-bound SHA/digest pairs; current deployments are v0.2.36 exact digests. On 2026-08-01, genuine scheduled authenticated-baseline smoke completed for both repositories on current default-branch SHAs and exact deployed digests (AstraNull [`30684302779`](https://github.com/geekyshubham/AstraNull/actions/runs/30684302779), RouteLens [`30684781163`](https://github.com/geekyshubham/RouteLens/actions/runs/30684781163)); each skipped authenticated-full. No v0.2.36 scheduled authenticated-full success is claimed. Hardening covered by tests: `authenticated-full` sessions require a genuine `schedule` event; `scanProfile` is request- and lease-bound; baseline/full minute constraints fail early. Other profiles fail closed unless SHA, environment, origin, and digest all match; static credentials require an explicit PoC-only switch |
| Exact-origin safe-operation ZAP smoke and nightly workflows | Beta | `GET`, `HEAD`, and `OPTIONS` OpenAPI routes on isolated staging | [workflow security tests](../packages/core/test/workflow-security.test.ts), [live RouteLens XML/DefectDojo evidence](evidence/v0.2.28-routelens-defectdojo.md), [live AstraNull XML/DefectDojo evidence](evidence/v0.2.28-astranull-defectdojo.md), [live v0.2.34 scheduled RouteLens baseline evidence](evidence/v0.2.34-live-fleet-and-scheduled-dast.md), [live v0.2.33 authenticated-baseline evidence](evidence/v0.2.33-live-promotion-and-dast.md), [earlier passive-smoke evidence](evidence/v0.2.14-zap-summary.json), and [live v0.2.36 fleet/promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Onboarding DAST configuration, deployment-bound broker profile, and scheduled/manual run | On 2026-08-01, genuine scheduled `authenticated-baseline` smoke completed for both current default-branch SHAs and exact DigitalOcean deployed digests: AstraNull [`30684302779`](https://github.com/geekyshubham/AstraNull/actions/runs/30684302779) and RouteLens [`30684781163`](https://github.com/geekyshubham/RouteLens/actions/runs/30684781163). Each completed the staging-contract → one-time session assertion → bounded ZAP → evidence attestation/artifact chain and skipped `authenticated-full` / `dast-nightly`. No new DefectDojo import/reimport was independently verified for those runs. Earlier RouteLens v0.2.34 scheduled baseline with independent DefectDojo Test ID 5 reimport, RouteLens v0.2.35 schedule baseline-only run [`30550298775`](https://github.com/geekyshubham/RouteLens/actions/runs/30550298775), and v0.2.33 manual authenticated-baseline evidence remain prior-release history. Deploy smoke is passive safe mode. `authenticated-full` is schedule-only at the generated caller and session broker; manual `workflow_dispatch` remains baseline-only. Baseline is capped at 15 minutes; full requires at least 30 and at most 45, failing early on invalid minutes. No scheduled authenticated-full success is claimed for either repository |
| DefectDojo import/reimport client | Working | Dedicated DigitalOcean DefectDojo OSS v2 API | [client tests](../packages/defectdojo/test/client.test.ts), [control-plane evidence tests](../apps/control-plane/test/scanner-evidence.test.ts), [immutable stack tests](../tests/infra-defectdojo.test.mjs), [live platform evidence](evidence/v0.2.27-defectdojo.md), [live RouteLens workflow evidence](evidence/v0.2.28-routelens-defectdojo.md), [live AstraNull workflow evidence](evidence/v0.2.28-astranull-defectdojo.md), and [live v0.2.34 RouteLens scheduled reimport evidence](evidence/v0.2.34-live-fleet-and-scheduled-dast.md) | Central HTTPS URL/token and dedicated automation identity | Live isolated conformance plus RouteLens and AstraNull workflow reimports preserve their scanner Test IDs and provenance. RouteLens Test ID 5 was independently verified updated for the v0.2.34 scheduled baseline run (build `30540342779/1`, matching head SHA and severity counts). AstraNull Test ID 6 was last verified on a prior v0.2.33 scheduled run, not current v0.2.34. The PoC automation identity still requires least-privilege production hardening |
| Repository-isolated index | Partial | Python, JavaScript/TypeScript, Swift, Ruby, and text fallback | [indexer tests](../packages/core/test/indexer.test.ts), [store vector tests](../apps/control-plane/test/store.test.ts), [repository-index service tests](../apps/control-plane/test/repository-index-service.test.ts), [review-path wiring tests](../apps/control-plane/test/service.test.ts), and [index coverage tests](../packages/monitoring/test/monitoring.test.ts) | Active repository and commit snapshot; pgvector for durable ranking | A durable pgvector read path ranks nearest neighbours in the database. The production review path now wires that path: `apps/control-plane/src/service.ts` supplies `RepositoryIndexService.repositoryVectorRanker` together with a matching local embedding provider so durable recall is not dormant. Recalled records absent from the loaded document are batch-hydrated from storage in one round trip; relevance is recomputed locally to avoid store score-polarity mismatch; repository scope is rechecked on request and returned rows. The `vector_ann` column is declared at the indexed embedding width and written only for rows whose own `dimensions` match, so another width degrades to an exact scan rather than failing a write. Boot builds the approximate index only while the table is effectively empty; at or above the inline ceiling the build is an operator step documented in [operations](operations.md#approximate-vector-index), and queries stay correct whether or not the index exists. Repository isolation is enforced on both sides: every vector read/delete and hydration carries the `repository_id` and canonical storage-key predicates. Incremental refresh reuses vectors by content digest across a `compare` range and falls back to a full rebuild when the range is not a plain forward advance or the changed-file list may be truncated. Indexing caps are configuration; truncation ratio reaches monitoring; superseded generations are pruned outside the migration path. **Materialised-candidate barrier closed in automated/local implementation evidence:** durable-only retrieval, one-round-trip hydration, production wiring/isolation, and pgvector/store behaviour are test-covered. **Still incomplete:** live PostgreSQL/pgvector verification, live ANN performance, and production deployment of this path are not claimed; graph edges still rely on the loaded index document; history retrieval remains incomplete. |
| Continuous reconciliation and weekly coverage | Beta | Installed repositories with expected workflows | [monitoring tests](../packages/monitoring/test/monitoring.test.ts), [service tests](../apps/control-plane/test/monitoring-service.test.ts), [live v0.2.13 evidence](evidence/v0.2.13-digitalocean-app-platform.md), [19-repository inventory evidence](evidence/v0.2.31-fresh-repository-acceptance.md), and [live v0.2.36 fleet inventory evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Scheduler, App Actions read, and durable store | The live scheduler previously persisted snapshots, alerts, and a weekly report; final live target-SHA CLI inventory after v0.2.36 is healthy (19 visible / 16 report-only / 2 advisory-only / 1 not-applicable / zero misconfigured / zero missing-expected-runs), while a post-expansion weekly scheduler report remains pending |
| Exact signed/deployed image evidence matching | Beta | Repositories with image promotion and deployment configuration | [monitoring tests](../packages/monitoring/test/monitoring.test.ts) | Matching signed digest and deployment environment | A local Docker image ID is never accepted as a registry digest |
| DigitalOcean App Platform digest reconciler | Beta | Centrally allowlisted GHCR services, workers, and jobs | [deployment tests](../apps/control-plane/test/digitalocean-deployment.test.ts), [live RouteLens evidence](evidence/v0.2.25-routelens-dast.md), [live AstraNull evidence](evidence/v0.2.26-astranull-dast.md), and [live v0.2.36 promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` and central token reference | GuardianBot control plane, RouteLens, and AstraNull are current through v0.2.36 exact signed digests with ACTIVE App Platform deployments (application service plus migrate job on each exact promoted consumer digest; RouteLens Redis retains its separately pinned official digest). Additional repositories remain unverified |
| DigitalOcean Droplet isolated application staging | Working | RouteLens and AstraNull exact promoted digests | [immutable staging tests](../tests/infra-staging.test.mjs) and [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md) | One hardened DigitalOcean Droplet, central GHCR read authentication, and root-only generated environment | Exact images, HTTPS, negative and positive authentication, and network isolation are verified; control-plane deployment reconciliation is not yet wired to the Droplet |
| Signed GuardianBot DigitalOcean deployment scripts | Beta | Dedicated droplet or existing `guardianbot-prod` App Platform app | [deployment script tests](../scripts/deployment-security.test.mjs), [live v0.2.14 App Platform evidence](evidence/v0.2.14-live-poc.md), [live v0.2.27 DefectDojo Droplet evidence](evidence/v0.2.27-defectdojo.md), and [live v0.2.36 control-plane rotation evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md) | Canonical signed release asset directory | App Platform and the dedicated DefectDojo Droplet path are live. GuardianBot control-plane image (`sha256:622fd2b0b0c30c64d57112317304025ed102c911ba0e3c329d0cbed5c5496b9a`), three trusted reusable-workflow SHAs at `152649be5a86862f619a86d60598fc25bafb0429`, ACTIVE deployment `322d61d6-88ec-4ac6-9a83-3a853fedc6d2`, `/healthz`, and `/readyz` are current through signed v0.2.36. Destructive restore drills, HA, and off-host backup proof remain unverified |
| Control-plane PostgreSQL and private metrics transport | Working | DigitalOcean managed PostgreSQL or private Compose PostgreSQL | [database tests](../apps/control-plane/test/store.test.ts) and [HTTP security tests](../apps/control-plane/test/http-security.test.ts) | CA pin for managed PostgreSQL; private metrics policy | Readiness is process/store oriented, not a substitute for external health monitoring. Migrations serialize behind a PostgreSQL session advisory lock on a dedicated connection, so concurrent instance boots wait instead of racing on `IF NOT EXISTS` DDL. The container health check probes `/readyz` so a failed store dependency marks the container unhealthy, with `/healthz` remaining a pure liveness probe |
| Authoritative webhook queue metrics and terminal retention | Working | Shared in-memory or PostgreSQL webhook job store | [store tests](../apps/control-plane/test/store.test.ts), [metrics implementation](../apps/control-plane/src/metrics.ts), and [operations retention docs](operations.md#webhook-queue-retention) | Optional `GUARDIANBOT_WEBHOOK_*` retention/cleanup bounds | `/metrics` exposes pending, leased, dead-letter, and runnable gauges from the shared store and returns `503` if that refresh fails. Bounded cleanup deletes only terminal `succeeded`/`dead-letter` rows; pending and leased jobs are never purged. The `/webhooks/github` body read is guarded, so a pre-authentication client abort cannot terminate the process, and process-level unhandled-rejection/uncaught-exception handlers drain through the existing shutdown path. Webhook responses carry fixed strings only: signature/delivery failures answer `401`/`400` from a typed error and enqueue failures answer a static `503` that GitHub redelivers, so no internal error text reaches an unauthenticated caller. Shutdown waits for the in-flight delivery and cancels its backend call so the lease is released at once instead of stranding for the full lease. GitHub throttling requeues at the reported reset instant without consuming the attempt budget, so a burst cannot dead-letter jobs, while a `403` carrying no budget signal stays a permanent failure. `/metrics` adds `github_rate_limited_total` and a `guardianbot_github_ratelimit_remaining` gauge that stays absent until GitHub reports a budget, and the webhook latency histogram is valid Prometheus output with `+Inf` as its maximum. Automated/local evidence only |
| RouteLens and AstraNull full digest promotion and DAST | Partial | Those two repositories through the generic onboarding flow | [live image promotion and staging evidence](evidence/v0.2.14-live-poc.md), [RouteLens DefectDojo evidence](evidence/v0.2.28-routelens-defectdojo.md), [AstraNull DefectDojo evidence](evidence/v0.2.28-astranull-defectdojo.md), [live v0.2.36 fleet/promotion evidence](evidence/v0.2.36-live-control-plane-and-fleet-upgrade.md), [live v0.2.34 scheduled DAST evidence](evidence/v0.2.34-live-fleet-and-scheduled-dast.md), and [live v0.2.33 promotion and DAST evidence](evidence/v0.2.33-live-promotion-and-dast.md) | Broker profile and DefectDojo | Both repositories are upgraded to v0.2.36 with generic promotion (deterministic scanner, image build/smoke/Trivy/SBOM, push/sign/attest) and exact-digest ACTIVE DigitalOcean deployments while scanner mode remains report-only. Doctors are ready/report-only (~1.41 days; baseline missing; `rulesetReady=false`; `enforcementReady=false`). On 2026-08-01, genuine scheduled authenticated-baseline smoke completed for both current default-branch SHAs and exact deployed digests (AstraNull [`30684302779`](https://github.com/geekyshubham/AstraNull/actions/runs/30684302779), RouteLens [`30684781163`](https://github.com/geekyshubham/RouteLens/actions/runs/30684781163)); each skipped authenticated-full / dast-nightly. No scheduled authenticated-full DAST success and no new DefectDojo reimport are verified for those runs. Older RouteLens v0.2.34 scheduled baseline with independent DefectDojo Test ID 5 reimport, and RouteLens v0.2.35 genuine schedule baseline-only run `30550298775`, remain prior-release / baseline-only evidence. Production model credential/live AI review and seven-day live enforcement observation remain pending |
| Cross-provider model fallback | Not applicable | Disabled by default | [model protocol](model-protocol.md) | Explicit repository visibility/data-classification approval | Unavailable AI becomes advisory `AI review unavailable`; deterministic checks continue |

Statuses mean:

- **Working**: the described behavior has passing automated evidence.
- **Beta**: implemented with automated evidence but still needs the stated live
  environment verification.
- **Partial**: material behavior is intentionally incomplete.
- **Planned**: roadmap only; it must not be represented as implemented.
- **Not applicable**: deliberately excluded or disabled.
