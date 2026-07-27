# Getting started

This guide keeps every infrastructure component on GitHub or DigitalOcean. No
consumer repository receives a GuardianBot infrastructure secret.

## 1. Create and install the GitHub App

Create the App under the intended GitHub account and set the webhook URL to:

```text
https://YOUR_GUARDIANBOT_HOST/webhooks/github
```

Subscribe to installation/repository selection, repository, pull request, issue
comment, push, and workflow run events. Grant the minimum repository
permissions:

- Metadata: read
- Actions: read
- Contents: read
- Issues: read/write
- Pull requests: read/write

The App does not need Administration permission. `guardianctl enforce` uses the
operator's normal GitHub authorization for rulesets.

Store the App ID, generated private key, and webhook secret only in encrypted
DigitalOcean environment configuration. Select repositories explicitly during
installation; newly selected repositories are discovered from App events.

## 2. Deploy the control plane on DigitalOcean

Download a canonical signed GuardianBot release and use one of the verified
deployment scripts described in [operations](operations.md).

For an existing DigitalOcean App Platform app:

```sh
mkdir guardianbot-release-v0.2.3
gh release download v0.2.3 \
  --repo Geekyshubham/guardianbot \
  --dir guardianbot-release-v0.2.3
./scripts/deploy-digitalocean-app-platform.sh \
  11111111-2222-4333-8444-555555555555 \
  guardianbot-release-v0.2.3
```

For a dedicated DigitalOcean droplet, create Ubuntu with
`infra/digitalocean/cloud-init.yml`, attach an encrypted volume at
`/var/lib/guardianbot`, place the release assets below an operator-owned
directory, and run:

```sh
cd /opt/guardianbot
cp .env.example .env
chmod 600 .env
./scripts/deploy-digitalocean.sh deploy \
  /opt/guardianbot/releases/guardianbot-release-v0.2.3
./scripts/deploy-digitalocean.sh verify
```

Both scripts reject a release unless its fixed asset set, manifest signature,
GHCR signature, CycloneDX attestation, GitHub provenance, source commit, source
ref, and workflow identity all verify.

Use DigitalOcean managed PostgreSQL with
`GUARDIANBOT_DATABASE_CA_CERT` or private Compose PostgreSQL on the droplet.
Do not connect GuardianBot to an external database provider.

## 3. Connect a conforming model bridge

The control plane communicates only through `guardian.review.v1`. Deploy
`apps/model-bridge` as an isolated service or connect another conforming bridge,
then configure only:

```text
GUARDIAN_MODEL_BACKEND_URL=https://INTERNAL_BRIDGE_ORIGIN
GUARDIAN_MODEL_BACKEND_TOKEN=CONTROL_PLANE_TO_BRIDGE_TOKEN
```

The included `openai-responses` adapter calls the Responses API with native
strict Structured Outputs. Its default profile mapping is:

- `routine-review` to `gpt-5.6-terra`;
- `high-risk-review` to `gpt-5.6-sol`; and
- `benchmark-review` to `gpt-5.6-sol`.

Put `OPENAI_API_KEY` only in the model-bridge service. The model receives
bounded, explicitly delimited untrusted repository context, no tools, no GitHub
client, and no credentials. Malformed output is discarded. `store: false` is
used, but the bridge reports bounded retention unless Zero Data Retention is
separately approved and administratively verified.

An `openai-compatible` binding can target a local or hosted compatible gateway
only after its strict-schema capability probe passes. The fixture adapter is
for conformance tests, not a production model.

Verify the bridge endpoints and run the conformance tests from
[building a model bridge](building-a-model-bridge.md). If the bridge is
unavailable, GuardianBot reports AI review unavailable and deterministic
scanner checks continue.

## 4. Configure central staging services

Before enabling image deployment or DAST for a repository, configure:

- a DigitalOcean App Platform allowlist profile in
  `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON`;
- a one-time staging authentication profile in
  `GUARDIANBOT_DAST_PROFILES_JSON`; and
- the referenced DigitalOcean and target-exchange secrets only in the control
  plane.

See [image security](image-security.md) and [DAST](dast.md). Repositories
without a Dockerfile report image coverage as not applicable. Repositories
without a DAST profile do not receive a missing-DAST failure.

## 5. Onboard a repository

Install or extend App access to the repository. GuardianBot inventories it and
opens an advisory onboarding issue. Then run:

```sh
export GUARDIANBOT_WORKFLOW_SHA=0123456789abcdef0123456789abcdef01234567
guardianctl onboard OWNER/REPOSITORY
guardianctl doctor OWNER/REPOSITORY
```

`onboard` creates one draft PR containing only
`.guardianbot/config.yml`, a small immutable caller workflow, and an onboarding
report. It copies no scanner implementation or infrastructure credential.

Merge the PR to begin the seven-day report-only period. After a reviewed,
healthy baseline, set `scanners.mode: enforce`, update the baseline document,
and run:

```sh
guardianctl enforce OWNER/REPOSITORY
```

Use `guardianctl inventory` for fleet state and `guardianctl upgrade --all` to
open immutable pin-update PRs. See
[repository onboarding](onboarding-repositories.md) for the complete lifecycle.

## 6. Verify and operate

Check:

- `/healthz` and `/readyz`;
- receipt of a signed GitHub webhook;
- creation of the repository inventory issue;
- the first advisory PR review;
- the first scanner artifact and evidence attestation; and
- monitoring freshness after the onboarding PR merges.

Back up before each control-plane deployment. A droplet rolls back with
`./scripts/deploy-digitalocean.sh rollback`; App Platform rolls back by
re-running the verified deployment script with the previous release asset
directory. Database restore is a separate operation.
