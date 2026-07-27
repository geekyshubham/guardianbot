# Repository configuration

The canonical definition is the
[repository configuration schema](../schemas/repository-config.v1.schema.json).
Backend URLs, model IDs, DefectDojo credentials, staging credentials, and GitHub
App secrets are prohibited.

```yaml guardianbot-config=full
schemaVersion: 1.0.0
workflowVersion: 0123456789abcdef0123456789abcdef01234567
repository:
  defaultBranch: main
  releaseBranches: [main]
  languages: [python]
  relatedRepositories: []
review:
  automatic: true
  drafts: manual
  incremental: true
  maxInlineComments: 8
  categories: [security, logic, reliability, testing]
  highRiskPaths: ["**/auth/**", ".github/workflows/**"]
  contextDocuments: [README.md, SECURITY.md, .github/CODEOWNERS]
  excludedPaths: ["**/vendor/**", "**/dist/**"]
scanners:
  mode: report-only
  semgrep: true
  trivy: true
  suppressions: []
image: null
dast: null
```

Language detection selects `python -m pytest`, `npm test`, `swift test`, or
`bundle exec rake test` as a report in the onboarding PR. Commands run only in
GitHub-hosted or ephemeral runners.

Container example:

```yaml guardianbot-config=image
image:
  dockerfile: ops/digitalocean/Dockerfile
  context: .
  platform: linux/amd64
  registry: ghcr.io/owner/repository
  healthPath: /health
  readinessPath: /ready
  sbomFormat: cyclonedx-json
  dependentServices: [postgres, redis]
  runtimeEnvironment:
    PORT: "8080"
  # Runner-generated startup-only values; no secret value is stored here.
  ephemeralEnvironment: [APPLICATION_SMOKE_SECRET]
```

DAST example:

```yaml guardianbot-config=dast
dast:
  allowedOrigin: https://staging.example.com
  openapi: /openapi.safe.yaml
  authenticationProfile: control-plane://profiles/example-staging
  sessionAssertionPath: /api/session
  excludedRoutes: [/admin/reset, /internal]
```

The DAST origin must be an exact HTTPS origin. Authentication references resolve
only in the control plane. Start with the
[validated safe OpenAPI example](examples/openapi.safe.yaml), publish only
non-destructive staging operations, and keep every reference internal to that
document. A repository without a Dockerfile reports image coverage as
`not applicable`.

Node, Swift, Ruby, and documentation-only repositories use the same structure;
only languages, commands reported by detection, scanner applicability, and optional
image/DAST sections differ.

## Field reference

“Required” means required whenever the field's parent object is present. The docs
gate compares this list and its requiredness with both the JSON Schema and the
`GuardianConfig` TypeScript interface.

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Repository configuration contract version. |
| `workflowVersion` | yes | Immutable 40-character GuardianBot workflow commit. |
| `repository` | yes | Repository identity and language scope. |
| `repository.defaultBranch` | yes | Default branch name. |
| `repository.releaseBranches` | yes | Branches eligible for release-oriented checks. |
| `repository.languages` | yes | Detected language identifiers. |
| `repository.relatedRepositories` | no | Explicitly related repositories used for context. |
| `review` | yes | Advisory review policy. |
| `review.automatic` | yes | Whether automatic review is enabled. |
| `review.drafts` | yes | Draft pull request behavior. |
| `review.incremental` | yes | Whether reviews are limited to incremental changes. |
| `review.maxInlineComments` | yes | Maximum inline comments per review. |
| `review.categories` | yes | Enabled review categories. |
| `review.highRiskPaths` | yes | Globs that raise review risk. |
| `review.contextDocuments` | no | Repository documents allowed as review context. |
| `review.excludedPaths` | no | Paths excluded from advisory review. |
| `scanners` | yes | Deterministic scanner policy. |
| `scanners.mode` | yes | Advisory, report-only, or enforce mode. |
| `scanners.semgrep` | yes | Whether Semgrep runs. |
| `scanners.trivy` | yes | Whether Trivy runs. |
| `scanners.suppressions` | no | Reviewed, expiring finding suppressions. |
| `scanners.suppressions.fingerprint` | yes | Stable finding fingerprint. |
| `scanners.suppressions.owner` | yes | Person or team accountable for the suppression. |
| `scanners.suppressions.reason` | yes | Reviewed suppression rationale. |
| `scanners.suppressions.ticket` | yes | Tracking ticket reference. |
| `scanners.suppressions.expiresAt` | yes | ISO date-time at which the suppression expires. |
| `image` | no | Container build and runtime-smoke policy, or `null`. |
| `image.dockerfile` | yes | Dockerfile path. |
| `image.context` | yes | Container build context. |
| `image.platform` | yes | Target container platform. |
| `image.registry` | yes | Target registry and repository. |
| `image.healthPath` | yes | Liveness probe path. |
| `image.readinessPath` | no | Readiness probe path. |
| `image.containerPort` | no | Container port exposed to smoke checks. |
| `image.sbomFormat` | yes | Required CycloneDX JSON SBOM format. |
| `image.dependentServices` | no | Disposable services needed by runtime smoke. |
| `image.runtimeEnvironment` | no | Non-secret static runtime values. |
| `image.ephemeralEnvironment` | no | Runner-generated startup-only environment keys. |
| `image.migrationCommand` | no | Optional migration command for disposable runtime state. |
| `image.testCommand` | no | Optional container-specific test command. |
| `dast` | no | Staging-only DAST policy, or `null`. |
| `dast.allowedOrigin` | yes | Exact HTTPS staging origin. |
| `dast.openapi` | yes | Safe OpenAPI path or allowlisted URL. |
| `dast.authenticationProfile` | yes | Opaque control-plane authentication reference. |
| `dast.sessionAssertionPath` | yes | Protected path used to prove authentication. |
| `dast.excludedRoutes` | no | Destructive or internal routes excluded from DAST. |
