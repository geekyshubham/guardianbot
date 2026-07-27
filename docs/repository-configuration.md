# Repository configuration

`.guardianbot/config.yml` is a declarative, versioned repository contract. The
canonical definition is the
[repository configuration schema](../schemas/repository-config.v1.schema.json).
GuardianBot generates this file during `guardianctl onboard`; editing it by hand
is optional.

The `1.0.0` schema remains backward compatible. Existing files that omit newer
optional sections continue to validate. A generated upgrade PR can add those
sections when a repository is ready to use them.

Provider endpoints, model IDs, GitHub tokens, DefectDojo credentials, staging
credentials, deployment credentials, and secret values are prohibited.
Authentication profiles are opaque control-plane references. Test and build
commands are declarations: GuardianBot executes them only inside GitHub-hosted
or explicitly configured ephemeral runners.

## Complete example

```yaml guardianbot-config=full
schemaVersion: 1.0.0
workflowVersion: 0123456789abcdef0123456789abcdef01234567
repository:
  defaultBranch: main
  releaseBranches: [main, release/1.x]
  languages: [python, typescript]
  packageManagers: [uv, npm]
  lockfiles: [uv.lock, package-lock.json]
  codeowners: .github/CODEOWNERS
  relatedRepositories: [acme/shared-contracts]
paths:
  source: ["src/**", "backend/**"]
  test: ["test/**", "tests/**"]
  generated: ["src/generated/**"]
  vendored: ["vendor/**"]
  excluded: ["node_modules/**", "dist/**", "vendor/**"]
review:
  automatic: true
  drafts: manual
  incremental: true
  manual: true
  targetBranches: [main, release/1.x]
  maxInlineComments: 8
  categories: [security, logic, reliability, contract, testing]
  highRiskPaths: ["**/auth/**", ".github/workflows/**", "**/migrations/**"]
  contextDocuments: [README.md, SECURITY.md, .github/CODEOWNERS]
  excludedPaths: ["node_modules/**", "dist/**", "vendor/**"]
  pathRules:
    - name: authentication
      paths: ["**/auth/**"]
      categories: [security, logic, testing]
      instructions:
        - Require negative authorization tests and tenant-isolation evidence.
runner:
  executionEnvironment: github-hosted
  testCommands: [python -m pytest, npm test]
  buildCommands: [npm run build]
scanners:
  mode: report-only
  semgrep: true
  trivy: true
  suppressions:
    - fingerprint: trivy:CVE-2099-0001:package-lock.json
      owner: "@security"
      reason: Compensating control verified in staging.
      ticket: SEC-123
      expiresAt: "2099-01-01T00:00:00.000Z"
image: null
dast: null
```

`paths.excluded` is the canonical scanner and index exclusion list. When
`review.excludedPaths` is also present, it must contain the same ordered values.
This prevents advisory review and deterministic scanners from silently
disagreeing about coverage.

## Auto-detection profiles

The onboarding report records evidence for each detected capability. Detection
does not execute repository code.

| Repository type | Detection evidence | Suggested runner commands |
| --- | --- | --- |
| Python | `pyproject.toml`, requirements files, `Pipfile`, Poetry, PDM, or uv lockfiles | `python -m pytest`; tool-specific build commands when declared |
| Node.js | `package.json` with npm, pnpm, Yarn, or Bun metadata and lockfiles | The package manager's declared `test` and `build` scripts |
| Swift | `Package.swift` and `Package.resolved` | `swift test`, `swift build` |
| Ruby | `Gemfile`, `Gemfile.lock`, gemspec, Rakefile, and RSpec paths | `bundle exec rspec` or `bundle exec rake test` |
| Container | `Dockerfile`, suffixed Dockerfiles, or `Containerfile` | Build and runtime smoke are enabled after configuration review |
| OpenAPI | OpenAPI/Swagger filenames or a valid OpenAPI marker in JSON/YAML | DAST remains off until an exact staging origin and auth profile are supplied |
| Documentation only | Markdown/MDX/AsciiDoc/reStructuredText without source files | Advisory review; source scanners are not applicable |

Generated, vendored, test, and source paths are derived from conventional
directories and observed files. Review every generated onboarding PR when a
repository uses nonstandard layouts.

## Container policy

Repositories without a container definition explicitly report image coverage as
`not applicable`. They do not fail because `image` is `null`.

```yaml guardianbot-config=image
image:
  name: acme/service
  dockerfile: ops/digitalocean/Dockerfile
  context: .
  platform: linux/amd64
  buildArguments:
    BUILD_MODE: release
  smokeProfile: multi-service
  registry: ghcr.io/acme/service
  healthPath: /health
  readinessPath: /ready
  containerPort: 8080
  ports:
    - name: http
      containerPort: 8080
      protocol: tcp
  signing:
    mode: keyless
    workflow: .github/workflows/guardianbot.yml
    ref: refs/heads/main
  sbomFormat: cyclonedx-json
  sbomRetentionDays: 30
  dependentServices: [postgres, redis]
  runtimeEnvironment:
    APP_MODE: staging
  ephemeralEnvironment: [DATABASE_URL, REDIS_URL, APPLICATION_SMOKE_SECRET]
  migrationCommand: python -m alembic upgrade head
  testCommand: python -m pytest
  deployment:
    environment: staging
    requireImmutableDigest: true
    requireSignature: true
    requireSbom: true
```

`buildArguments` and `runtimeEnvironment` accept only non-secret static values.
Secret-like keys are rejected. `ephemeralEnvironment` contains names only; the
runner generates or resolves their values without writing them to the
repository. `registry` is a GHCR destination, and promotion requires the same
immutable digest, expected keyless workflow identity, and CycloneDX SBOM
evidence.

## DAST policy

DAST configuration is staging-only. The primary origin and every additional
allowlisted origin must be an exact HTTPS origin without a path, query,
credentials, or fragment. GuardianBot never infers a production target.

```yaml guardianbot-config=dast
dast:
  allowedOrigin: https://staging.example.com
  allowedOrigins: [https://staging.example.com]
  openapi: docs/openapi.safe.yaml
  openapiSource: repository-file
  authenticationProfile: control-plane://profiles/example-staging
  sessionAssertionPath: /api/session
  profiles:
    deploySmoke: authenticated-baseline
    nightly: authenticated-full
  excludedRoutes: [/admin/reset, /internal]
```

For `repository-file`, `openapi` is a repository-relative JSON or YAML path. For
`live-endpoint`, it must resolve to the primary allowlisted origin. The
authentication profile resolves only in the control plane, and
`sessionAssertionPath` must prove protected access before an authenticated scan
continues. Exclude destructive, internal, reset, and administrative routes.
Start from the [validated safe OpenAPI example](examples/openapi.safe.yaml).

## Scanner modes and suppressions

- `advisory` records review and applicability without deterministic enforcement.
- `report-only` runs scanners and establishes a baseline without blocking.
- `enforce` permits the deterministic security gate to block under the central
  policy.

AI findings remain advisory in every mode. A suppression must include a stable
fingerprint, accountable owner, reviewed reason, ticket, and ISO date-time
expiry. Expired suppressions fail `guardianctl doctor`.

## Field reference

“Required” means required whenever the field's parent object is present. The
documentation gate compares this table and its requiredness with both the JSON
Schema and the inline `GuardianConfig` TypeScript interface.

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Repository configuration contract version; currently `1.0.0`. |
| `workflowVersion` | yes | Immutable 40-character GuardianBot workflow commit SHA. |
| `repository` | yes | Repository metadata used by onboarding and policy. |
| `repository.defaultBranch` | yes | Default branch observed from GitHub. |
| `repository.releaseBranches` | yes | Branches eligible for release-oriented checks and promotion. |
| `repository.languages` | yes | Detected language identifiers. |
| `repository.packageManagers` | no | Detected package-manager identifiers. |
| `repository.lockfiles` | no | Repository-relative dependency lockfiles. |
| `repository.codeowners` | no | Repository-relative CODEOWNERS path. |
| `repository.relatedRepositories` | no | Explicit, separately authorized cross-repository context allowlist. |
| `paths` | no | Canonical repository path classification. |
| `paths.source` | yes | Source path globs. |
| `paths.test` | yes | Test and fixture path globs. |
| `paths.generated` | yes | Generated-code path globs. |
| `paths.vendored` | yes | Vendored dependency path globs. |
| `paths.excluded` | yes | Paths excluded from indexing, advisory review, and applicable scanners. |
| `review` | yes | Advisory AI review policy. |
| `review.automatic` | yes | Whether ready pull requests trigger automatic review. |
| `review.drafts` | yes | Draft pull request behavior: skip, manual, or automatic. |
| `review.incremental` | yes | Whether later reviews start at the last reviewed commit. |
| `review.manual` | no | Whether `@guardianbot review` and `full-review` are enabled. |
| `review.targetBranches` | no | Branches eligible for automatic and manual review. |
| `review.maxInlineComments` | yes | Maximum evidence-backed inline comments per review. |
| `review.categories` | yes | Enabled review categories. |
| `review.highRiskPaths` | yes | Globs that raise deterministic change risk. |
| `review.contextDocuments` | no | Repository documents allowed as bounded review context. |
| `review.excludedPaths` | no | Advisory exclusion mirror of `paths.excluded`. |
| `review.pathRules` | no | Ordered, path-scoped review rules. |
| `review.pathRules.name` | yes | Stable human-readable rule name. |
| `review.pathRules.paths` | yes | Repository globs to which the rule applies. |
| `review.pathRules.categories` | no | Optional category restriction for the rule. |
| `review.pathRules.instructions` | yes | Trusted repository-policy instructions for matching paths. |
| `runner` | no | Commands permitted only in GitHub-hosted or ephemeral runners. |
| `runner.executionEnvironment` | yes | Execution boundary: `github-hosted` or an approved `ephemeral` runner. |
| `runner.testCommands` | yes | Auto-detected test commands. |
| `runner.buildCommands` | yes | Auto-detected build commands. |
| `scanners` | yes | Deterministic scanner policy. |
| `scanners.mode` | yes | Advisory, report-only, or enforce mode. |
| `scanners.semgrep` | yes | Whether Semgrep is applicable. |
| `scanners.trivy` | yes | Whether Trivy is applicable. |
| `scanners.suppressions` | no | Reviewed, expiring finding suppressions. |
| `scanners.suppressions.fingerprint` | yes | Stable finding fingerprint. |
| `scanners.suppressions.owner` | yes | Person or team accountable for the suppression. |
| `scanners.suppressions.reason` | yes | Reviewed suppression rationale. |
| `scanners.suppressions.ticket` | yes | Tracking ticket reference. |
| `scanners.suppressions.expiresAt` | yes | ISO date-time at which the suppression expires. |
| `image` | no | Container build, runtime-smoke, evidence, and promotion policy, or `null`. |
| `image.name` | no | Lowercase logical image name. |
| `image.dockerfile` | yes | Repository-relative Dockerfile or Containerfile path. |
| `image.context` | yes | Repository-relative build context or `.`. |
| `image.platform` | yes | Canonical platform; the PoC requires `linux/amd64`. |
| `image.buildArguments` | no | Non-secret static build arguments. |
| `image.smokeProfile` | no | HTTP, command, or multi-service runtime smoke profile. |
| `image.registry` | yes | Lowercase GHCR destination. |
| `image.healthPath` | yes | Origin-relative liveness path. |
| `image.readinessPath` | no | Origin-relative readiness path. |
| `image.containerPort` | no | Primary container port exposed to smoke checks. |
| `image.ports` | no | Named container ports required by smoke tests. |
| `image.ports.name` | yes | Stable lowercase port name. |
| `image.ports.containerPort` | yes | Port number from 1 through 65535. |
| `image.ports.protocol` | yes | TCP or UDP protocol. |
| `image.signing` | no | Keyless signing workflow identity policy. |
| `image.signing.mode` | yes | Signing mode; currently `keyless`. |
| `image.signing.workflow` | yes | Repository workflow path expected in the certificate identity. |
| `image.signing.ref` | yes | Exact branch or tag ref expected in the certificate identity. |
| `image.sbomFormat` | yes | Required CycloneDX JSON SBOM format. |
| `image.sbomRetentionDays` | no | Immutable SBOM artifact retention in days. |
| `image.dependentServices` | no | Disposable PostgreSQL and/or Redis services required by smoke tests. |
| `image.runtimeEnvironment` | no | Non-secret static runtime values. |
| `image.ephemeralEnvironment` | no | Runner-generated or control-plane-resolved environment key names. |
| `image.migrationCommand` | no | Migration command for disposable runtime state. |
| `image.testCommand` | no | Container-specific test command. |
| `image.deployment` | no | Staging environment and immutable promotion requirements. |
| `image.deployment.environment` | yes | GitHub deployment-environment name. |
| `image.deployment.requireImmutableDigest` | yes | Requires deployment by the tested image digest. |
| `image.deployment.requireSignature` | yes | Requires verified keyless signature identity. |
| `image.deployment.requireSbom` | yes | Requires SBOM evidence for the same digest. |
| `dast` | no | Staging-only DAST policy, or `null`. |
| `dast.allowedOrigin` | yes | Primary exact HTTPS staging origin. |
| `dast.allowedOrigins` | no | Complete exact-origin allowlist including the primary origin. |
| `dast.openapi` | yes | Safe repository OpenAPI file or allowlisted live endpoint. |
| `dast.openapiSource` | no | `repository-file` or `live-endpoint`. |
| `dast.authenticationProfile` | yes | Opaque `control-plane://profiles/...` authentication reference. |
| `dast.sessionAssertionPath` | yes | Protected path used to prove authenticated access. |
| `dast.profiles` | no | Deploy-smoke and nightly ZAP scan profiles. |
| `dast.profiles.deploySmoke` | yes | Short post-deployment DAST profile. |
| `dast.profiles.nightly` | yes | Deeper scheduled DAST profile. |
| `dast.excludedRoutes` | no | Destructive or internal origin-relative routes excluded from DAST. |
