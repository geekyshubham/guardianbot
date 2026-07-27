# Getting started

## 1. Create the GitHub App

Create an App owned by the intended GitHub account. Set the webhook URL to
`https://YOUR_HOST/webhooks/github`, subscribe to installation repositories,
repository, pull request, issue comment, and workflow run events, and grant:

- Repository metadata: read
- Actions: read, so `workflow_run` deliveries can be reconciled with immutable
  scanner evidence
- Contents: read
- Pull requests, issues, and checks: read/write only where used
- Administration: not required by the App; `guardianctl enforce` uses the
  operator's normal GitHub authorization

Store the App ID, PEM private key, and webhook secret only on the control plane.

## 2. Deploy one DigitalOcean droplet

Create an Ubuntu droplet using `infra/digitalocean/cloud-init.yml`, point a DNS
record at it, attach and mount an encrypted volume at `/var/lib/guardianbot`,
then on the droplet:

```sh
git clone https://github.com/Geekyshubham/guardianbot.git /opt/guardianbot
cd /opt/guardianbot
cp .env.example .env
chmod 600 .env
cat >> .env <<'EOF'
GUARDIANBOT_HOSTNAME=guardianbot.example.com
GUARDIANBOT_STATE_DIR=/var/lib/guardianbot
EOF

./scripts/deploy-digitalocean.sh deploy \
  ghcr.io/geekyshubham/guardianbot@sha256:340fefd23012d84a6f07d82b87b22f27c0d52d1cdd2a9e7f2b00f283a17b87b0
./scripts/deploy-digitalocean.sh verify
```

The control plane now deploys only from the signed GHCR digest. PostgreSQL,
Caddy, and Prometheus are pinned by digest, and their state lives under
`GUARDIANBOT_STATE_DIR` on the encrypted DigitalOcean volume. The optional
`valkey` service is kept behind the `queue` profile until the production worker
path exists:

```sh
docker compose -f infra/docker-compose.yml --profile queue up -d valkey
```

No managed database or non-DigitalOcean cloud is required.

## 3. Connect a model bridge

Deploy any conforming bridge reachable from the control plane. Set
`GUARDIAN_MODEL_BACKEND_URL` and, if required,
`GUARDIAN_MODEL_BACKEND_TOKEN`. Verify `/healthz`, `/v1/capabilities`, and the
conformance tests described in [building a bridge](building-a-model-bridge.md).
Backend and profile routing is administrative configuration, never repository
configuration.

## 4. Install and onboard

Install the App on a selected repository. GuardianBot opens an inventory issue and
provides advisory behavior. Then run:

```sh
export GUARDIANBOT_WORKFLOW_SHA=<published-guardianbot-commit>
guardianctl onboard OWNER/REPOSITORY
guardianctl doctor OWNER/REPOSITORY
```

Merge the generated draft PR to start the report-only observation period. After a
healthy baseline:

```sh
edit .guardianbot/config.yml   # set scanners.mode: enforce
edit .guardianbot/baseline.json
guardianctl enforce OWNER/REPOSITORY
```

See [repository onboarding](onboarding-repositories.md) for lifecycle details.

## 5. Backups, restore, and rollback

Take an application-consistent PostgreSQL backup to the encrypted DigitalOcean
volume before each deploy and at least daily:

```sh
./scripts/backup-postgres.sh
```

Restore requires an explicit file path and confirmation flag:

```sh
./scripts/restore-postgres.sh --input /var/lib/guardianbot/backups/guardianbot-postgres-YYYYMMDDTHHMMSSZ.dump --yes
```

Roll back the control plane to the previously recorded digest:

```sh
./scripts/deploy-digitalocean.sh rollback
```

The rollback path changes the control-plane image only. Restore PostgreSQL from
backup separately when a release or migration requires data rollback.
