# Operations

GuardianBot supports two DigitalOcean-only control-plane layouts:

- an existing DigitalOcean App Platform app with managed PostgreSQL; or
- one dedicated Ubuntu droplet in a private VPC, with an encrypted attached
  volume mounted at `GUARDIANBOT_STATE_DIR`.

Consumer repositories never receive control-plane, model, database,
DefectDojo, DAST, or DigitalOcean credentials.

## Release boundary

Deploy only a canonical GuardianBot GitHub Release asset set. A release
directory contains the checksummed manifest, Sigstore bundle, provenance
bundles, verification records, and SBOM needed to prove the exact GHCR digest.
Do not deploy a raw digest copied from a log and do not build source on the
DigitalOcean host.

Install `cosign`, `gh`, `jq`, `node`, and `curl` on either deployment host. App
Platform deployment also requires an authenticated `doctl`; droplet deployment
requires Docker with Compose.

Download a complete release to a new operator-controlled directory:

```sh
mkdir guardianbot-release-v0.2.6
gh release download v0.2.6 \
  --repo Geekyshubham/guardianbot \
  --dir guardianbot-release-v0.2.6
```

The deployment scripts verify:

- the fixed release-asset allowlist and checksums;
- repository, tag, source ref, and source commit;
- the keylessly signed release manifest;
- the exact GHCR image signature and CycloneDX attestation;
- GitHub artifact provenance from the canonical release workflow; and
- the active DigitalOcean deployment's exact digest.

## DigitalOcean App Platform

For the existing `guardianbot-prod` app:

```sh
./scripts/deploy-digitalocean-app-platform.sh \
  11111111-2222-4333-8444-555555555555 \
  guardianbot-release-v0.2.6
```

The script refuses an unexpected app name or image source, updates only the
`control-plane` and optional `model-bridge` service, removes mutable tags, waits
for an active deployment, re-reads that deployment's spec, and probes
`/healthz` and `/readyz`.

App-level environment configuration must include:

- GitHub App ID, private key, and webhook secret;
- `GUARDIANBOT_EVIDENCE_SIGNING_SECRET`;
- exact trusted security, image, and DAST reusable-workflow SHAs;
- `DATABASE_URL` and
  `GUARDIANBOT_DATABASE_CA_CERT=${guardianbot-db.CA_CERT}` for the managed
  DigitalOcean database binding;
- model bridge URL/token, when a bridge is enabled;
- `GUARDIANBOT_DAST_PROFILES_JSON` and its referenced exchange-secret
  environment variables; and
- `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` and the centrally referenced
  DigitalOcean API token.

The profile JSON documents contain identifiers and environment-variable names,
not secret values. Keep each actual secret in encrypted App Platform
configuration.

To roll back App Platform, run the same verified script with the retained asset
directory for the previous release. Database rollback is a separate,
explicitly approved restore operation.

## Dedicated droplet

The Compose topology uses Caddy for TLS, private PostgreSQL, and private
Prometheus. Its optional Valkey profile remains disabled until a worker queue
requires it. Keep `.env` at mode `0600` or `0400`, pin support containers by
digest, and mount all persistent state below the encrypted
`GUARDIANBOT_STATE_DIR`.

Before a deployment:

```sh
cd /opt/guardianbot
./scripts/backup-postgres.sh
./scripts/deploy-digitalocean.sh deploy \
  /opt/guardianbot/releases/guardianbot-release-v0.2.6
./scripts/deploy-digitalocean.sh verify
```

The script retains canonical current and previous release assets in a
non-symlink deployment-state directory, verifies the running container's exact
image, waits for PostgreSQL and the control plane, and probes the external
`/healthz` and `/readyz` routes.

Droplet rollback re-verifies the retained previous release before deployment:

```sh
./scripts/deploy-digitalocean.sh rollback
```

## PostgreSQL, backup, and restore

For DigitalOcean managed PostgreSQL, set
`GUARDIANBOT_DATABASE_CA_CERT` to the DigitalOcean CA PEM. GuardianBot removes
weaker TLS query parameters from `DATABASE_URL` and verifies the database
server against that CA. Private Compose PostgreSQL does not use this override.

Back up droplet PostgreSQL before each deployment and on a daily schedule:

```sh
cd /opt/guardianbot
./scripts/backup-postgres.sh
```

Restore only after taking a new pre-restore backup:

```sh
./scripts/restore-postgres.sh \
  --input /var/lib/guardianbot/backups/guardianbot-postgres-YYYYMMDDTHHMMSSZ.dump \
  --yes
```

Run a restore drill in an isolated DigitalOcean environment before declaring
the system ready for business-critical retention requirements.

## Monitoring

Monitor at minimum:

- public `/healthz` and `/readyz`;
- scheduler run, failure, duration, and last-success metrics;
- GitHub webhook 4xx/5xx rates and replay rejections;
- bridge availability and review latency;
- expected workflow runs, repository-index freshness, and scanner evidence;
- distinct DAST smoke/nightly freshness and DefectDojo imports;
- exact scan/SBOM/signature/deployment digest agreement; and
- suppression expiry and weekly coverage snapshots.

Public Caddy requests to `/metrics` return `404`. Metrics access requires
`GUARDIANBOT_METRICS_BEARER_TOKEN` unless the deployment explicitly enables
`GUARDIANBOT_TRUST_PRIVATE_METRICS=1` on a genuinely private Compose network.
Health/readiness endpoints are useful process signals, not substitutes for
external probes and evidence reconciliation.

## Host and secret operations

The droplet cloud-init profile enables UFW default-deny inbound policy,
unattended security upgrades, SSH password/root-login disablement, Docker
live-restore/log rotation, and `fail2ban`.

Rotate the GitHub App private key, webhook secret, evidence signing secret,
model bridge token, DAST exchange credentials, DigitalOcean token, DefectDojo
token, and database credentials independently. Emergency disablement removes
GitHub App access or stops the control plane; consumer security workflows
continue at their immutable pinned commit.
