# Capability status

Release: `0.2.11`
Last verified: 2026-07-28

This matrix is the authoritative distinction between implemented behavior and
roadmap intent. A local automated test is evidence that a contract works in the
test environment; it is not evidence that the corresponding GitHub or
DigitalOcean integration is live.

| Capability | Status | Supported scope | Last verified evidence | Required configuration | Known limitation / failure behavior |
| --- | --- | --- | --- | --- | --- |
| `guardian.review.v1` protocol and strict result validation | Working | Any conforming bridge | [protocol tests](../packages/protocol/test/protocol.test.ts) | Approved administrative backend profile | Invalid, ungrounded, stale, oversized, or malformed output is discarded |
| Provider-neutral backend registry | Working | Administratively approved bridges | [control-plane bridge tests](../apps/control-plane/test/backend-registry-private-network.test.ts) | Backend URL/token only on the control plane | Cross-backend fallback is off unless explicitly approved |
| Responses API strict adapter | Working | `gpt-5.6-terra` routine and `gpt-5.6-sol` high-risk/benchmark profiles | [bridge adapter tests](../apps/model-bridge/test/adapters.test.ts) | OpenAI credential only in the isolated bridge | Automated evidence only; no production bridge credential is configured yet |
| OpenAI-compatible and fixture adapters | Working | Capability-checked compatible gateways and tests | [bridge service tests](../apps/model-bridge/test/service.test.ts) | Administrative adapter configuration | Unsupported strict-schema capabilities fail closed |
| Documentation quality gates | Working | Tracked repository documentation | [documentation gate tests](../scripts/check-docs.test.mjs) | None | Normal CI validates external URL structure; live external reachability is opt-in |
| Repository detection and configuration generation | Working | Python, Node, Swift, Ruby, Docker, OpenAPI, and documentation repositories | [detection tests](../packages/core/test/detection-contract.test.ts) | Repository read access | Detection is bounded and heuristic; it does not execute discovered commands |
| `guardianctl onboard`, `doctor`, `enforce`, `upgrade`, `inventory`, and `offboard` | Working | Authenticated GitHub repositories | [CLI tests](../packages/guardianctl/test/cli.test.ts) | Operator GitHub authorization and immutable workflow SHA | Live App, ruleset, and workflow evidence must remain reachable |
| GitHub App discovery and onboarding issue | Beta | Selected App installations | [control-plane service tests](../apps/control-plane/test/service.test.ts) | App permissions and subscribed events | The new Geekyshubham App has not yet been created and installed |
| Advisory PR placeholder and grouped review | Beta | Ready pull requests | [control-plane service tests](../apps/control-plane/test/service.test.ts) | Active repository record and approved bridge | Inline finding publication and live end-to-end App evidence remain incomplete |
| Incremental stable-fingerprint lifecycle | Partial | Persisted PR review records | [store tests](../apps/control-plane/test/store.test.ts) | Active repository | Resolved/superseded presentation and full feedback analytics remain planned |
| Semgrep and full-class Trivy gate | Beta | Code, dependency, configuration, secret, and license evidence | [scanner tests](../packages/core/test/core.test.ts), [zero-result sanitizer tests](../packages/core/test/trivy-sanitizer.test.ts), and [workflow security tests](../packages/core/test/workflow-security.test.ts) | Generated caller; reviewed baseline for enforce mode | License findings stay report-only; live consumer runs against the 0.2.11 workflow SHA remain to be verified |
| Trusted scanner evidence ingestion | Beta | Pinned reusable workflows on GitHub-hosted runners | [evidence tests](../apps/control-plane/test/scanner-evidence.test.ts) | Exact workflow SHA, App Actions read, and evidence attestation | Missing, mismatched, oversized, or untrusted evidence fails reconciliation |
| Image build, runtime smoke, Trivy, and CycloneDX SBOM | Beta | Dockerized repositories | [workflow security tests](../packages/core/test/workflow-security.test.ts) | Declarative image profile | RouteLens and AstraNull still have blocking findings and have not completed promotion |
| Cosign and provenance-bound image promotion | Beta | Critical-clean default-branch images | [release evidence tests](../scripts/release-evidence.test.mjs) and [live v0.2.11 evidence](evidence/v0.2.11-digitalocean-app-platform.md) | GitHub OIDC and immutable release identity | GuardianBot v0.2.11 is verified live; consumer-repository promotion remains unverified |
| Deployment-bound one-time DAST session broker | Beta | Exact-origin DigitalOcean staging with an approved authentication profile | [session broker tests](../apps/control-plane/test/dast-session.test.ts) | `GUARDIANBOT_DAST_PROFILES_JSON`, matching accepted deployment evidence, and protected `guardianbot-dast` environment | Sessions fail closed unless the current default-branch SHA, environment, origin, and digest all match; static credentials require an explicit PoC-only switch |
| Exact-origin safe-operation ZAP smoke and nightly workflows | Beta | `GET`, `HEAD`, and `OPTIONS` OpenAPI routes on isolated staging | [workflow security tests](../packages/core/test/workflow-security.test.ts) | Onboarding DAST configuration, deployment-bound broker profile, and scheduled/manual run | Live RouteLens/AstraNull authenticated runs and imports remain unverified |
| DefectDojo import/reimport client | Beta | Self-hosted DefectDojo v2 | [client tests](../packages/defectdojo/test/client.test.ts) and [immutable stack tests](../tests/infra-defectdojo.test.mjs) | Central HTTPS URL/token and verified DigitalOcean stack | Dedicated DigitalOcean service and live import/reimport evidence remain |
| Repository-isolated index | Partial | Python, JavaScript/TypeScript, Swift, Ruby, and text fallback | [indexer tests](../packages/core/test/indexer.test.ts) | Active repository and commit snapshot | Durable pgvector adapter and production-scale history retrieval remain planned |
| Continuous reconciliation and weekly coverage | Beta | Installed repositories with expected workflows | [monitoring tests](../packages/monitoring/test/monitoring.test.ts) and [service tests](../apps/control-plane/test/monitoring-service.test.ts) | Scheduler, App Actions read, and durable store | Automated contracts pass; live multi-repository scheduler evidence remains |
| Exact signed/deployed image evidence matching | Beta | Repositories with image promotion and deployment configuration | [monitoring tests](../packages/monitoring/test/monitoring.test.ts) | Matching signed digest and deployment environment | A local Docker image ID is never accepted as a registry digest |
| DigitalOcean App Platform digest reconciler | Beta | Centrally allowlisted GHCR services, workers, and jobs | [deployment tests](../apps/control-plane/test/digitalocean-deployment.test.ts) | `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` and central token reference | All selected components update atomically in tests; RouteLens/AstraNull live staging is not created or verified |
| Signed GuardianBot DigitalOcean deployment scripts | Beta | Dedicated droplet or existing `guardianbot-prod` App Platform app | [deployment script tests](../scripts/deployment-security.test.mjs) and [live v0.2.11 evidence](evidence/v0.2.11-digitalocean-app-platform.md) | Canonical signed release asset directory | App Platform deployment is live; the droplet path, restore drills, and HA remain unverified |
| Control-plane PostgreSQL and private metrics transport | Working | DigitalOcean managed PostgreSQL or private Compose PostgreSQL | [database tests](../apps/control-plane/test/store.test.ts) and [HTTP security tests](../apps/control-plane/test/http-security.test.ts) | CA pin for managed PostgreSQL; private metrics policy | Readiness is process/store oriented, not a substitute for external health monitoring |
| RouteLens and AstraNull full digest promotion and DAST | Planned | Those two repositories through the generic onboarding flow | Earlier blocking workflow evidence only | Clean image gate, isolated staging, broker profile, and DefectDojo | No successful signed deployment or authenticated ZAP evidence exists yet |
| Cross-provider model fallback | Not applicable | Disabled by default | [model protocol](model-protocol.md) | Explicit repository visibility/data-classification approval | Unavailable AI becomes advisory `AI review unavailable`; deterministic checks continue |

Statuses mean:

- **Working**: the described behavior has passing automated evidence.
- **Beta**: implemented with automated evidence but still needs the stated live
  environment verification.
- **Partial**: material behavior is intentionally incomplete.
- **Planned**: roadmap only; it must not be represented as implemented.
- **Not applicable**: deliberately excluded or disabled.
