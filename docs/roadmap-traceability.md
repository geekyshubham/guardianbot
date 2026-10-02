# Roadmap traceability

This page maps each roadmap item to the code that implements it, the tests
that cover it, its status in [capability status](status.md), and what is
still needed before it can be accepted. [Capability status](status.md) is
authoritative. If this page and that one disagree, status wins.

Items added in the unreleased roadmap-completion change (release-branch
coverage, organization severity map, digest rescan and SBOM diff, release
gate, findings lifecycle, AI value metrics, and Mode C drafts) have
**automated test evidence only**. None of them has run against live GitHub,
GHCR, DefectDojo, DigitalOcean, Jira, Slack, or a production PostgreSQL
instance.

## PR gateway and policy

| Roadmap item | Code | Tests | Status | Remaining (live evidence) |
| --- | --- | --- | --- | --- |
| PR gateway: Semgrep, Trivy filesystem, AI review | [reusable security workflow](../.github/workflows/reusable-security.yml), [scanners](../packages/core/src/scanners.ts), [service](../apps/control-plane/src/service.ts) | [core tests](../packages/core/test/core.test.ts), [workflow security tests](../packages/core/test/workflow-security.test.ts), [service tests](../apps/control-plane/test/service.test.ts) | Beta (scanners), Beta (advisory review) | Seven-day report-only observation, reviewed baselines, and live enforcement. A production model credential and one live real-model AI review |
| Release-branch coverage (`scanners.releaseBranches`) | [workflow generator](../packages/core/src/workflow.ts), [config](../packages/core/src/config.ts), [guardianctl](../packages/guardianctl/src/index.ts), [readiness script](../scripts/verify-enforcement-readiness.mjs) | [PR policy tests](../packages/core/test/pr-policy.test.ts), [CLI tests](../packages/guardianctl/test/cli.test.ts), [readiness tests](../scripts/verify-enforcement-readiness.test.mjs), [monitoring tests](../apps/control-plane/test/monitoring-service.test.ts) | Beta, automated tests only | Operator sets `scanners.releaseBranches`, merges a `guardianctl upgrade` PR, and configures release-branch rulesets by hand. A live release-branch push run is still needed |
| Organization severity map (Semgrep `guardianbot-severity`) | [rule pack](../rules/semgrep.yml), [reusable security workflow](../.github/workflows/reusable-security.yml), [scanners](../packages/core/src/scanners.ts) | [PR policy tests](../packages/core/test/pr-policy.test.ts), [workflow security tests](../packages/core/test/workflow-security.test.ts) | Beta, automated tests only | A live gate run that records `severitySource` in `gate.json`. Unmapped native `ERROR` findings no longer block in enforce mode |

## Image, rescan, and DAST

| Roadmap item | Code | Tests | Status | Remaining (live evidence) |
| --- | --- | --- | --- | --- |
| Image gate: Trivy image, CycloneDX SBOM, Cosign | [reusable image workflow](../.github/workflows/reusable-image.yml), [scanner evidence](../apps/control-plane/src/scanner-evidence.ts) | [workflow security tests](../packages/core/test/workflow-security.test.ts), [release evidence tests](../scripts/release-evidence.test.mjs) | Working | Already live for RouteLens and AstraNull (see [status](status.md)) |
| Deployed-digest rescan and SBOM diff | [rescan workflow](../.github/workflows/reusable-image-rescan.yml), [rescan target endpoint](../apps/control-plane/src/image-rescan.ts), [SBOM diff](../packages/core/src/sbom-diff.ts), [monitoring](../apps/control-plane/src/monitoring-service.ts) | [rescan tests](../apps/control-plane/test/image-rescan.test.ts), [SBOM diff tests](../packages/core/test/sbom-diff.test.ts), [scanner evidence tests](../apps/control-plane/test/scanner-evidence.test.ts) | Beta, automated tests only | A `guardianbot-image-rescan` environment per repository, regenerated callers, a control-plane redeploy, and one live nightly run. Promotion does not enforce the freeze signal yet. Rescan findings are not imported into DefectDojo |
| Authenticated ZAP DAST | [reusable DAST workflow](../.github/workflows/reusable-dast.yml), [DAST session broker](../apps/control-plane/src/dast-session.ts) | [session broker tests](../apps/control-plane/test/dast-session.test.ts), [workflow security tests](../packages/core/test/workflow-security.test.ts) | Beta | Scheduled authenticated-full DAST on the current digests for RouteLens (still open) |
| Nightly rescans | [rescan workflow](../.github/workflows/reusable-image-rescan.yml), [reusable DAST workflow](../.github/workflows/reusable-dast.yml) | [workflow security tests](../packages/core/test/workflow-security.test.ts), [monitoring tests](../apps/control-plane/test/monitoring-service.test.ts) | Beta, automated tests only for image rescans | A live nightly image rescan and a passing `image-rescan-coverage` check |

## Release and findings management

| Roadmap item | Code | Tests | Status | Remaining (live evidence) |
| --- | --- | --- | --- | --- |
| DefectDojo as system of record | [DefectDojo client](../packages/defectdojo/src/index.ts), [scanner evidence](../apps/control-plane/src/scanner-evidence.ts) | [client tests](../packages/defectdojo/test/client.test.ts), [scanner evidence tests](../apps/control-plane/test/scanner-evidence.test.ts) | Working (import/reimport) | Current RouteLens DefectDojo reimport, a tested failed-import alert, and retirement of the old token and superuser account |
| Digest-scoped release gate | [release gate workflow](../.github/workflows/reusable-release-gate.yml), [endpoint](../apps/control-plane/src/release-gate.ts), [policy](../apps/control-plane/src/release-gate-policy.ts), [DigitalOcean deployment](../apps/control-plane/src/digitalocean-deployment.ts) | [policy tests](../apps/control-plane/test/release-gate-policy.test.ts), [endpoint tests](../apps/control-plane/test/release-gate.test.ts), [deployment tests](../apps/control-plane/test/digitalocean-deployment.test.ts), [client tests](../packages/defectdojo/test/client.test.ts) | Beta, automated tests only | A `guardianbot-release-gate` environment, `GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA`, DefectDojo read access to findings and risk acceptances, and one live gate decision. See [release gate](release-gate.md) |
| SLA aging, owners, and tickets | [findings lifecycle](../apps/control-plane/src/findings-lifecycle.ts), [ticketing](../apps/control-plane/src/ticketing.ts), [monitoring findings](../packages/monitoring/src/findings.ts) | [lifecycle tests](../apps/control-plane/test/findings-lifecycle.test.ts), [ticketing tests](../apps/control-plane/test/ticketing.test.ts), [monitoring findings tests](../packages/monitoring/test/findings.test.ts), [store tests](../apps/control-plane/test/store.test.ts) | Beta, automated tests only (off by default) | `GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED`, provider configuration, and live GitHub Issues, Jira, and Slack delivery. The new tables have not run on a real PostgreSQL. See [findings lifecycle](findings-lifecycle.md) |

## AI review

| Roadmap item | Code | Tests | Status | Remaining (live evidence) |
| --- | --- | --- | --- | --- |
| Mode A: grouped advisory review | [service](../apps/control-plane/src/service.ts), [render](../apps/control-plane/src/render.ts) | [service tests](../apps/control-plane/test/service.test.ts) | Beta | One live real-model PR review. The live fixture-bridge comment proves plumbing only |
| Mode B: inline advisories with exact suggestions | [render](../apps/control-plane/src/render.ts), [service](../apps/control-plane/src/service.ts) | [service tests](../apps/control-plane/test/service.test.ts) | Partial | Live inline suggestions from a real model and live `pull_request_review_comment` events |
| Mode C: remediation draft PRs | [remediation draft](../apps/control-plane/src/remediation-draft.ts), [service](../apps/control-plane/src/service.ts), [App auth](../apps/control-plane/src/app-auth.ts) | [remediation draft tests](../apps/control-plane/test/remediation-draft.test.ts), [service tests](../apps/control-plane/test/service.test.ts) | Partial, automated tests only (off by default) | `Contents: Read and write` granted and accepted per installation, `GUARDIANBOT_REMEDIATION_DRAFTS=1`, and one live draft. Draft checks are never confirmed and draft branches are not cleaned up. See [remediation drafts](remediation-drafts.md) |
| AI value metrics (fixed, dismissed, ignored, precision) | [review value](../apps/control-plane/src/review-value.ts), [weekly report](../packages/monitoring/src/weekly-report.ts), [metrics](../apps/control-plane/src/metrics.ts) | [review value tests](../apps/control-plane/test/review-value.test.ts), [monitoring tests](../packages/monitoring/test/monitoring.test.ts), [metrics tests](../apps/control-plane/test/metrics.test.ts) | Beta, automated tests only | A live weekly report with `reviewValue` measured from real reviews. Needs a production model route first. See [metrics](metrics.md#review-value) |

## Fleet and operations

| Roadmap item | Code | Tests | Status | Remaining (live evidence) |
| --- | --- | --- | --- | --- |
| Fleet onboarding and upgrade via `guardianctl` | [guardianctl](../packages/guardianctl/src/index.ts) | [CLI tests](../packages/guardianctl/test/cli.test.ts) | Working | Already live on the fleet. Repositories that opt into new features need a regenerated caller |
| Monitoring, weekly report, and runbooks | [monitoring service](../apps/control-plane/src/monitoring-service.ts), [weekly report](../packages/monitoring/src/weekly-report.ts), [runbooks](runbooks/README.md) | [monitoring tests](../packages/monitoring/test/monitoring.test.ts), [service tests](../apps/control-plane/test/monitoring-service.test.ts) | Beta | Weekly cadence across several UTC weeks, alert delivery, restore and rotation drills, and HA. The new rescan, findings SLA, and ticketing checks have no live evidence |
