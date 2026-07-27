# Operations

Deploy the Compose stack on one dedicated DigitalOcean droplet in a private VPC,
with an encrypted attached volume mounted at `GUARDIANBOT_STATE_DIR`
(recommended: `/var/lib/guardianbot`). The runtime path is intentionally
single-host today: Caddy terminates TLS, PostgreSQL stays private, and the
optional Valkey profile remains disabled until the worker path exists.

## Deployment boundary

- Deploy only the signed control-plane image digest published by the release
  workflow. Do not build from source on the droplet.
- Keep `infra/docker-compose.yml` pinned to immutable digests for GuardianBot,
  PostgreSQL, Caddy, and Prometheus.
- Store `.env` on the droplet with `0600` permissions. Consumer repositories
  never receive these values.
- For managed PostgreSQL, set `GUARDIANBOT_DATABASE_CA_CERT` to the provider CA
  PEM (literal or `\n`-escaped). GuardianBot removes weaker TLS query parameters
  from `DATABASE_URL` and verifies the server against that CA. Local private
  Compose PostgreSQL does not set this override.
- Mount all persistent state under `GUARDIANBOT_STATE_DIR` on the encrypted
  DigitalOcean volume.

## Standard deploy

```sh
cd /opt/guardianbot
./scripts/backup-postgres.sh
./scripts/deploy-digitalocean.sh deploy ghcr.io/geekyshubham/guardianbot@sha256:340fefd23012d84a6f07d82b87b22f27c0d52d1cdd2a9e7f2b00f283a17b87b0
./scripts/deploy-digitalocean.sh verify
```

The deploy script:

- refuses mutable image references
- validates `.env` permissions and required secrets
- records the previous image for rollback
- waits for PostgreSQL and the control plane to become healthy
- verifies the HTTPS `/healthz` route through Caddy on the configured hostname

`guardianctl upgrade` still delivers consumer-workflow pin updates through draft
PRs. It does not change the control-plane deployment.

## Monitoring

Monitor at minimum:

- `https://HOST/healthz`
- container health for `postgres`, `control-plane`, and `prometheus`
- the internal `http://control-plane:3000/metrics` Prometheus target on the
  explicitly trusted private Compose network
- GitHub webhook 4xx/5xx rates
- review latency and AI-backend availability
- scanner evidence freshness, imports, suppression expiry, and missing evidence

Public Caddy requests to `/metrics` return `404`. Outside the trusted private
Compose network, configure `GUARDIANBOT_METRICS_BEARER_TOKEN`; metrics stay closed
when neither that token nor the explicit private-network trust flag is present.
Current limitations still apply: `/readyz` and `/metrics` are not deep dependency
checks, so container health and deploy verification remain required.

## Backup and restore

Back up PostgreSQL to the encrypted DigitalOcean volume before each deploy and on
a scheduled cadence such as daily cron:

```sh
cd /opt/guardianbot
./scripts/backup-postgres.sh
```

Restore into the same droplet only after taking a fresh pre-restore backup:

```sh
./scripts/restore-postgres.sh --input /var/lib/guardianbot/backups/guardianbot-postgres-YYYYMMDDTHHMMSSZ.dump --yes
```

Test restore into an isolated DigitalOcean environment before calling the stack
production-ready for regulated or business-critical workloads.

## Rollback

Application rollback is explicit and image-based:

```sh
cd /opt/guardianbot
./scripts/deploy-digitalocean.sh rollback
```

This rolls the control plane back to the previously recorded digest and re-runs
health verification. Data rollback is separate and must use
`restore-postgres.sh` with a known-good backup.

## Host hardening

`infra/digitalocean/cloud-init.yml` now enables:

- UFW default deny for inbound traffic, limited SSH, and ports 80/443 only
- unattended security upgrades
- SSH password and root-login disablement
- Docker live-restore and log rotation
- `fail2ban` for SSH

Rotate the GitHub App PEM, webhook secret, model bridge token, DefectDojo token,
and staging credentials independently. Emergency disablement removes App access
or stops the control plane; repository security workflows continue at their
pinned commit.
