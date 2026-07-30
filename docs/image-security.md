# Image security

The canonical workflow builds `linux/amd64` once and treats its content as
immutable. Repository tests and migrations run inside that exact image, after
which the workflow boots the image, checks health and readiness, runs Trivy, and
creates a CycloneDX SBOM. Qualifying Critical findings, smoke failure, missing
scan evidence, or a missing SBOM stop promotion.

In `advisory` and `report-only` modes, image findings are retained and attested
without failing the validation check. Generated configs default
`image.deployment.promotionMode` to `enforce-only`, so report-only callers keep
`push: false`. Operators may opt into `verified-default-branch` so a report-only
repository can publish a default-branch image only when the reusable workflow
independently confirms a Critical-clean, non-error Trivy result. After
`guardianctl enforce`, Critical findings fail the validation check.

## Validation and promotion

The reusable workflow can create disposable PostgreSQL and Redis containers on
an isolated Docker network. Declarative build, test, migration, and runtime
settings come from `.guardianbot/config.yml`; credentials are generated in the
runner and are never committed to the consumer repository.

Pull requests run only validation, with no package-publish permission. The
caller's `push` input is operator intent only. Generated callers always pass
`promotion-mode` (defaulting omitted config to `enforce-only`). Promotion and
exact-image transfer upload also require the reusable workflow's Critical-clean
`promotion-eligible` output, mode authorization (`promotion-authorized`:
`policy-mode=enforce`, or `report-only` with `promotion-mode=verified-default-branch`;
advisory never authorizes), a default-branch `push` event, and the protected
`guardianbot-image-promotion` environment. Before registry authentication the
promote job independently re-reads downloaded `policy.json` and
`trivy-image.json`, rejects scanner errors, and requires both the policy
Critical count and a case-insensitive recomputed Trivy Critical count to be
exactly zero and matching. Qualifying promotion restores the exact validated
image artifact, pushes it to GHCR, signs the registry digest keylessly with
Cosign, attaches the CycloneDX SBOM attestation, and verifies the expected
GitHub workflow identity. Evidence paths are runner-controlled; a
repository-created path or symlink fails closed.

The control plane independently accepts promotion evidence only from the
configured reusable workflow SHA on a GitHub-hosted runner, and rejects
Critical-bearing image-promotion artifacts before signature or DigitalOcean
processing even when workflow metadata otherwise looks trusted. A local Docker
image ID is not a registry digest and cannot satisfy monitoring.

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

RouteLens and AstraNull were onboarded through the same generated configuration
and reusable workflows as any future repository. Their default-branch runs
built, tested, migrated, runtime-smoked, scanned, SBOM-attested, keylessly
signed, and promoted exact images. Those digests are deployed on the
DigitalOcean-only [`infra/staging`](../infra/staging/README.md) stack with
separate internal networks and PostgreSQL databases.

The [live v0.2.14 evidence](evidence/v0.2.14-live-poc.md) records the immutable
image identities, HTTPS health/readiness, protected-route rejection, and
cross-repository database isolation. Deployment-bound GuardianBot
reconciliation, authenticated ZAP, and DefectDojo remain unverified and are not
implied by the staging health evidence.
