# Repository configuration

The schema is `schemas/repository-config.v1.schema.json`. Backend URLs, model IDs,
DefectDojo credentials, staging credentials, and GitHub App secrets are prohibited.

```yaml
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

```yaml
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

```yaml
dast:
  allowedOrigin: https://staging.example.com
  openapi: /openapi.safe.json
  authenticationProfile: control-plane://profiles/example-staging
  sessionAssertionPath: /api/session
  excludedRoutes: [/admin/reset, /internal]
```

The DAST origin must be an exact HTTPS origin. Authentication references resolve
only in the control plane. A repository without a Dockerfile reports image
coverage as `not applicable`.

Node, Swift, Ruby, and documentation-only repositories use the same structure;
only languages, commands reported by detection, scanner applicability, and optional
image/DAST sections differ.
