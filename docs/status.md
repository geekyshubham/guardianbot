# Capability status

Release: `0.1.1-poc`  
Last verified: 2026-07-27

| Capability | Status | Scope | Evidence | Known limitation / failure behavior |
| --- | --- | --- | --- | --- |
| Strict `guardian.review.v1` validation | Working | Any conforming bridge | `packages/protocol/test/protocol.test.ts` | Invalid output is discarded |
| Repository detection/config generation | Working | Python, Node, Swift, Ruby, Docker, docs | `packages/core/test/core.test.ts` | Heuristic detection, no command execution |
| `guardianctl onboard` generation | Working | GitHub repositories | [12 generated onboarding PRs](https://github.com/pulls?q=is%3Apr+author%3Ageekyshubham+%22onboard+GuardianBot%22) | Ten merged normally; two held by pre-existing CI |
| Generated-caller drift detection | Working | Onboarded repositories | `packages/guardianctl/test/cli.test.ts` | `doctor` requires a reachable latest workflow run |
| App repository discovery/onboarding issue | Beta | GitHub App installations | `apps/control-plane/src/service.ts` | Needs live App verification |
| Advisory PR review placeholder/update | Beta | Ready PRs | `apps/control-plane/test/service.test.ts` | Inline review comments not yet posted |
| Incremental stable-fingerprint lifecycle | Partial | PR review records | Store and protocol tests | Resolution/supersession UI planned |
| Semgrep/Trivy reusable gate | Beta | Code/dependency repositories | Ten default-branch runs passed within 35 seconds of merge | Enforce mode now requires a checked-in reviewed baseline; automatic historical reconciliation is still partial |
| Image build/runtime/Trivy/SBOM | Beta | Docker repositories | [AstraNull run 30219565321](https://github.com/Geekyshubham/AstraNull/actions/runs/30219565321), [RouteLens run 30219565657](https://github.com/Geekyshubham/RouteLens/actions/runs/30219565657) | Runtime and SBOM verified; both correctly blocked before promotion by Critical findings |
| Cosign image promotion | Beta | Critical-clean default-branch images | [GuardianBot release run 30217789531](https://github.com/Geekyshubham/guardianbot/actions/runs/30217789531) | Verified for GuardianBot; RouteLens/AstraNull remain blocked |
| DAST exact-origin ZAP | Beta | Safe staging with OpenAPI | `reusable-dast.yml` | Fails closed without an authenticated session cookie; DefectDojo import remains external to the reusable workflow |
| DefectDojo reimport client | Beta | Self-hosted on DigitalOcean | core typecheck/tests | Full reconciliation scheduler planned |
| Local semantic index | Partial | Text/symbol fallback | core tests | Tree-sitter and pgvector persistence planned |
| Continuous monitoring | Partial | Ten onboarded repositories | generated nightly workflow | Digest rescans/15-minute smoke scheduler planned |
| DigitalOcean deployment definitions | Beta | Single droplet | Compose/config validation | HA, restore drill not verified |
| Signed release container | Working | GuardianBot control plane | [release run 30217789531](https://github.com/Geekyshubham/guardianbot/actions/runs/30217789531) | Digest `sha256:340fefd23012d84a6f07d82b87b22f27c0d52d1cdd2a9e7f2b00f283a17b87b0` |
| RouteLens/AstraNull full digest promotion | Planned | Those repositories | Blocking evidence in runs 30219565321 and 30219565657 | Critical image findings, existing repository CI, application-test wiring, signing, deployment, and authenticated DAST remain |
| Cross-provider model fallback | Not applicable | Disabled by default | Protocol design | Requires explicit approval |

Statuses mean: Working has automated local evidence; Beta is implemented but needs
live environment verification; Partial omits material behavior; Planned is roadmap
only; Not applicable is deliberately excluded.
