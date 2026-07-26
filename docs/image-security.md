# Image security

The canonical pipeline builds `linux/amd64` once and treats the resulting content
as immutable. It runs repository tests, boots that exact image, checks health and
readiness, scans vulnerability/misconfiguration/secret evidence, and creates a
CycloneDX SBOM. Qualifying Critical findings, smoke failure, missing scan, or
missing SBOM fail the job.

When promotion is enabled, GitHub OIDC keylessly signs the pushed GHCR digest and
attaches the SBOM attestation. Verification pins the repository workflow identity
and issuer. DigitalOcean staging must deploy this exact digest, never rebuild or
retag source.

RouteLens must use the root multi-stage Dockerfile for web/worker/beat with
PostgreSQL and Redis and `/api/v1/health/`. AstraNull must use
`ops/digitalocean/Dockerfile`, an isolated database/tenant, `/health`, `/ready`, and
a generated safe OpenAPI artifact. Their live evidence remains Planned until
repository PRs and DigitalOcean staging runs pass.
