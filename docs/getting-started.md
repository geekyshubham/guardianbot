# Getting started

## 1. Create the GitHub App

Create an App owned by the intended GitHub account. Set the webhook URL to
`https://YOUR_HOST/webhooks/github`, subscribe to installation repositories,
repository, pull request, and issue comment events, and grant:

- Repository metadata: read
- Contents, pull requests, issues, checks, and actions: read/write only where used
- Administration: not required by the App; `guardianctl enforce` uses the
  operator's normal GitHub authorization

Store the App ID, PEM private key, and webhook secret only on the control plane.

## 2. Deploy one DigitalOcean droplet

Create an Ubuntu droplet using `infra/digitalocean/cloud-init.yml`, point a DNS
record at it, then on the droplet:

```sh
git clone https://github.com/Geekyshubham/guardianbot.git /opt/guardianbot
cd /opt/guardianbot
cp .env.example .env
chmod 600 .env
docker compose -f infra/docker-compose.yml up -d --build
curl --fail https://YOUR_HOST/healthz
```

The bundled PostgreSQL and Valkey services are self-hosted on the droplet. No
managed database or non-DigitalOcean cloud is required.

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
guardianctl enforce OWNER/REPOSITORY
```

See [repository onboarding](onboarding-repositories.md) for lifecycle details.
