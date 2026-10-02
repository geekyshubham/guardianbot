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

## Deployed digest rescan

When `image.deployment` is configured, the generated caller adds a
schedule-only `guardianbot/image-rescan` job (cron `13 3 * * *`) that calls the
read-only `reusable-image-rescan.yml` workflow. Callers without
`image.deployment` are byte-identical to earlier releases. There is no new
configuration field.

The rescan never builds, pushes, signs, or deploys. Each night it:

1. requests a GitHub OIDC token with audience `guardianbot-image-rescan` from
   the `guardianbot-image-rescan` GitHub environment and calls
   `POST /image/rescan-target`;
2. receives the exact digest, image reference, keyless signing identity, and
   deployment run from the latest accepted `deployment:<environment>` evidence.
   The target is never resolved from a tag;
3. verifies the Cosign signature and the CycloneDX SBOM attestation for that
   identity, then pulls the image by digest and checks the pulled RepoDigest;
4. runs the pinned Trivy image scan and generates a fresh CycloneDX SBOM; and
5. uploads provenance-bound `image-rescan` evidence.

The endpoint applies the same checks as the DAST session broker: repository,
run, commit, trusted workflow SHA, hosted runner, and environment claims. It
fails closed when the repository has no accepted deployment for the requested
environment or when the stored evidence is incomplete. The reusable workflow
then fails closed when the returned reference does not match the configured
image name and digest, and the control plane later requires the uploaded
evidence to match the stored deployment exactly.

The control plane independently verifies the uploaded evidence. It requires a
default-branch schedule run, re-verifies the signature and SBOM attestation,
requires the Trivy report to name the exact deployed reference, rejects scanner
errors, and requires the reported Critical count to match the report. It records:

- `image-rescan:<environment>`: finding counts plus a bounded SBOM diff
  (added, removed, and version-changed components keyed by purl or
  name+ecosystem) against the previously attested SBOM; and
- `promotion-freeze:<environment>`: `failure` when the rescan finds one or more
  Critical vulnerabilities in the running digest, otherwise `success`.

SBOM diff heuristics flag possible typosquats, dependency-confusion names, and
version downgrades. They are advisory only and never block, waive, or approve.
The typosquat comparison skips names longer than 64 characters and stops at a
fixed work budget; when the budget or a list cap is reached the diff is marked
`truncated`, so a missing signal is not evidence of a clean dependency set.
The promotion freeze is a signal in evidence and monitoring. Rescan ingestion
never changes the running deployment, and promotion does not yet enforce the
freeze.

Monitoring adds two checks for repositories with `image.deployment`:

- `image-rescan-coverage`: passing when a successful rescan of the deployed
  digest is within the evidence max age, warning when it is older, and failing
  when it is older than twice the max age or missing after the first window
  following a deployment; and
- `image-promotion-freeze`: failing when the latest rescan of the deployed
  digest reports new Critical findings or has no freeze record.

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
