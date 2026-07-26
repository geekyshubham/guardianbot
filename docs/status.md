# Capability status

Release: `0.1.1-poc`  
Last verified: 2026-07-27

| Capability | Status | Scope | Evidence | Known limitation / failure behavior |
| --- | --- | --- | --- | --- |
| Strict `guardian.review.v1` validation | Working | Any conforming bridge | `packages/protocol/test/protocol.test.ts` | Invalid output is discarded |
| Repository detection/config generation | Working | Python, Node, Swift, Ruby, Docker, docs | `packages/core/test/core.test.ts` | Heuristic detection, no command execution |
| `guardianctl onboard` generation | Working | GitHub repositories | `packages/guardianctl/test/cli.test.ts` | Live PR verification pending published SHA |
| App repository discovery/onboarding issue | Beta | GitHub App installations | `apps/control-plane/src/service.ts` | Needs live App verification |
| Advisory PR review placeholder/update | Beta | Ready PRs | `apps/control-plane/test/service.test.ts` | Inline review comments not yet posted |
| Incremental stable-fingerprint lifecycle | Partial | PR review records | Store and protocol tests | Resolution/supersession UI planned |
| Semgrep/Trivy reusable gate | Beta | Code/dependency repositories | Workflow syntax and CI | Baseline diff reconciliation is partial |
| Image smoke/Trivy/SBOM/Cosign | Beta | Docker repositories | `reusable-image.yml` | Dependent-service orchestration is repository work |
| DAST exact-origin ZAP | Beta | Safe staging with OpenAPI | `reusable-dast.yml` | Authentication injection/import automation partial |
| DefectDojo reimport client | Beta | Self-hosted on DigitalOcean | core typecheck/tests | Full reconciliation scheduler planned |
| Local semantic index | Partial | Text/symbol fallback | core tests | Tree-sitter and pgvector persistence planned |
| Continuous monitoring | Partial | Nightly caller schedule | generated workflow | Digest rescans/15-minute smoke scheduler planned |
| DigitalOcean deployment definitions | Beta | Single droplet | Compose/config validation | HA, restore drill not verified |
| Signed release container | Working | GuardianBot control plane | [release run 30217789531](https://github.com/Geekyshubham/guardianbot/actions/runs/30217789531) | Digest `sha256:340fefd23012d84a6f07d82b87b22f27c0d52d1cdd2a9e7f2b00f283a17b87b0` |
| RouteLens/AstraNull full digest promotion | Planned | Those repositories | None yet | Must not claim until live workflows pass |
| Cross-provider model fallback | Not applicable | Disabled by default | Protocol design | Requires explicit approval |

Statuses mean: Working has automated local evidence; Beta is implemented but needs
live environment verification; Partial omits material behavior; Planned is roadmap
only; Not applicable is deliberately excluded.
