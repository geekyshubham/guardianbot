# Image security

The canonical workflow builds `linux/amd64` once and treats its content as
immutable. Repository tests and migrations run inside that exact image, after
which the workflow boots the image, checks health and readiness, runs Trivy, and
creates a CycloneDX SBOM. Qualifying Critical findings, smoke failure, missing
scan evidence, or a missing SBOM stop promotion.

## Validation and promotion

The reusable workflow can create disposable PostgreSQL and Redis containers on
an isolated Docker network. Declarative build, test, migration, and runtime
settings come from `.guardianbot/config.yml`; credentials are generated in the
runner and are never committed to the consumer repository.

Pull requests run only validation, with no package-publish or OIDC permission.
Default-branch promotion restores the exact validated image artifact, pushes it
to GHCR, signs the registry digest keylessly with Cosign, attaches the CycloneDX
SBOM attestation, and verifies the expected GitHub workflow identity. Evidence
paths are runner-controlled; a repository-created path or symlink fails closed.

The control plane independently accepts promotion evidence only from the
configured reusable workflow SHA on a GitHub-hosted runner. A local Docker image
ID is not a registry digest and cannot satisfy monitoring.

## DigitalOcean deployment reconciliation

Repositories contain no DigitalOcean secret. Administrators allowlist staging
destinations centrally with
`GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON`:

```json
{
  "repository-staging": {
    "repository": "owner/repository",
    "repositoryId": 123456789,
    "appId": "11111111-2222-4333-8444-555555555555",
    "appName": "repository-staging",
    "components": [
      { "kind": "service", "name": "web" },
      { "kind": "worker", "name": "worker" },
      { "kind": "job", "name": "migrate" }
    ],
    "imageName": "ghcr.io/owner/repository",
    "environment": "staging",
    "origin": "https://repository-staging.example.com",
    "healthPath": "/health",
    "readinessPath": "/ready",
    "apiTokenEnv": "DIGITALOCEAN_STAGING_TOKEN",
    "timeoutSeconds": 600
  }
}
```

`components` supports named App Platform `service`, `worker`, and `job`
components that all use the same approved GHCR image. Legacy single-service
profiles may use `serviceNames`; a profile must define exactly one form. The
referenced token exists only on the GuardianBot control plane. For a
trusted image-promotion artifact from the repository's default-branch `push`,
the reconciler:

1. verifies repository, numeric repository ID, run attempt, head SHA, exact
   GHCR image name, and digest;
2. acquires a durable repository/environment deployment lease;
3. reads only the configured DigitalOcean App Platform app;
4. verifies the exact app name, component names/kinds, and GHCR image source;
5. changes all and only those components from a tag to the approved digest in
   one App Platform specification update;
6. waits for the active deployment to report the same digest; and
7. probes the configured health and readiness paths without following
   redirects.

Success records `deployment:<environment>` evidence containing the deployed
digest. Monitoring requires the image Trivy result, SBOM, signature,
deployment, and—when configured—DAST/DefectDojo evidence to agree on that
digest and environment. A mismatch, incomplete App Platform response, failed
deployment, timeout, or failed probe cannot be reported as protected.

## RouteLens and AstraNull

The generated onboarding branches currently describe RouteLens's root
multi-stage Dockerfile and AstraNull's `ops/digitalocean/Dockerfile`. Local
hardening work is in progress for RouteLens web/worker/beat coverage and for
AstraNull's frozen production dependency install. Those changes are not
reported as working until their PR heads and public workflow evidence verify
them.

Both repositories must pass the same public onboarding, image, signing,
DigitalOcean promotion, and DAST contracts as every future repository. Their
earlier images correctly stopped before promotion because of blocking findings;
isolated live staging, signed digest deployment, and authenticated ZAP remain
unverified.
