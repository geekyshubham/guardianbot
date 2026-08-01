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
mkdir guardianbot-release-v0.2.11
gh release download v0.2.11 \
  --repo Geekyshubham/guardianbot \
  --dir guardianbot-release-v0.2.11
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
  guardianbot-release-v0.2.11
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
- `GUARDIANBOT_DAST_PROFILES_JSON`, including the exact DigitalOcean
  deployment environment for each target, and its referenced exchange-secret
  environment variables; and
- `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` and the centrally referenced
  DigitalOcean API token.

The profile JSON documents contain identifiers and environment-variable names,
not secret values. Keep each actual secret in encrypted App Platform
configuration.
The DAST broker reads accepted deployment evidence from the durable store and
will not issue a session until the scheduled/manual run SHA matches the
healthy deployed digest and origin.

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
  /opt/guardianbot/releases/guardianbot-release-v0.2.11
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

### Schema migration on boot

Migrations run inside store construction, before the process opens a port, and
are serialised across booting instances by a PostgreSQL advisory lock. Every
wait is finite so a stalled peer cannot hold a deployment open indefinitely:
the migration session sets a 10 second `lock_timeout` and a 120 second
`statement_timeout`, and acquires the lock with 30 attempts at one second
intervals.

An instance that cannot acquire the lock fails to boot with
`MigrationLockUnavailableError`. That is the intended fail-loud path, not a
defect: it means a peer instance held the migration lock for roughly thirty
seconds. Restarting the container is the normal remedy, since the peer has
usually finished by then. If a legitimate migration on a large `reviews` table
needs longer than that budget, treat repeated failures as a signal to run the
deployment with a single instance rather than to raise the bounds blindly.

A boot that fails this way has applied no partial schema change beyond
statements that already committed, and every statement is additive and
re-runnable, so a retry resumes safely.

### Approximate vector index

Repository retrieval ranks in the database when pgvector is present. The
nearest-neighbour read uses `repository_index_vectors.vector_ann`, a column
declared at the indexed embedding width (96) and written only for rows whose own
`dimensions` match it. A provider configured to another width keeps working
through an exact scan rather than failing a write.

Boot builds the index itself only while the table is effectively empty, because
`CREATE INDEX` holds ACCESS EXCLUSIVE and migrations run before the port opens.
At or above 2000 rows in `repository_index_vectors` the build is left to an
operator, which is the normal path rather than the exception. The gate counts
total rows rather than rows carrying a vector: `CREATE INDEX` scans the whole
heap and locks the whole table either way, so a large table with few populated
vectors is exactly the case that must not build inline.

```sh
psql "$DATABASE_URL" -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS \
  repository_index_vectors_ann_idx ON repository_index_vectors \
  USING hnsw (vector_ann vector_cosine_ops);"
```

`CONCURRENTLY` cannot run inside a transaction block, so issue it as its own
statement and not under `psql -1`, `BEGIN`, or a migration wrapper. A build that
fails part way leaves an invalid index behind that no query will use; drop it
before retrying rather than assuming the retry replaces it:

```sh
psql "$DATABASE_URL" -c "SELECT indisvalid FROM pg_index \
  WHERE indexrelid = 'repository_index_vectors_ann_idx'::regclass;"
psql "$DATABASE_URL" -c "DROP INDEX CONCURRENTLY IF EXISTS repository_index_vectors_ann_idx;"
```

Queries stay correct whether or not the index exists, so its absence shows up as
cost rather than as an error. Three gauges on `/metrics` separate a healthy
install from an under-indexed one:

| Metric | Meaning |
| --- | --- |
| `guardianbot_repository_index_storage_mode{mode="…"}` | `pgvector`, `json-array-fallback`, or `memory` |
| `guardianbot_repository_index_ann_ready` | `1` only when the dimensioned column and its index both exist |
| `guardianbot_repository_index_uncovered_vector_rows` | rows carrying no durable vector after the boot backfill |

`mode="pgvector"` with `ann_ready 0` is the state to alert on: every retrieval
read is an exact scan over the snapshot. Build the index out of band as above.

A non-zero uncovered count means rows written before the durable vector column
existed are still scored in memory rather than in the database. Boot backfills a
bounded number of them per start, and republishing a repository index rewrites
its rows in full, so the count converges through repeated boots or through
republication. Migration steps that degrade this way do not fail boot; they log
`guardianbot.migration_step_degraded` with the step name and SQLSTATE.

## Monitoring

Monitor at minimum:

- public `/healthz` and `/readyz`;
- scheduler run, failure, duration, and last-success metrics;
- GitHub webhook 4xx/5xx rates and replay rejections;
- webhook queue depth, pending/leased/dead-letter gauges, and cleanup failures;
- bridge availability and review latency;
- expected workflow runs, repository-index freshness, and scanner evidence;
- distinct DAST smoke/nightly freshness and DefectDojo imports;
- exact scan/SBOM/signature/deployment digest agreement; and
- suppression expiry and weekly coverage snapshots.

### Private metrics and operator monitoring status

`/metrics` and `GET /operations/monitoring` share the same private-metrics
trust policy. Public Caddy returns `404` for both paths. On App Platform, exact
bearer authentication is required; private Compose may instead set
`GUARDIANBOT_TRUST_PRIVATE_METRICS=1` on a genuinely private network. Neither
path needs direct database or SSH firewall broadening—operators scrape or
curl the control plane with the same credentials already used for metrics.

Successful access requires `GUARDIANBOT_METRICS_BEARER_TOKEN` (or the private
Compose trust override). Unauthorized callers, non-`GET` methods, query
strings, and trailing-slash variants of `/operations/monitoring` return an
empty `404`. Never put the bearer value in documentation, tickets, or shell
history that will be committed; load it from the operator environment or the
DigitalOcean secret store.

```sh
# App Platform or any deployment that requires the metrics bearer.
# Export GUARDIANBOT_METRICS_BEARER_TOKEN from the local operator credential
# store first; do not inline the token.
curl -fsS \
  -H "Authorization: Bearer ${GUARDIANBOT_METRICS_BEARER_TOKEN}" \
  "https://${GUARDIANBOT_HOSTNAME}/metrics"

curl -fsS \
  -H "Authorization: Bearer ${GUARDIANBOT_METRICS_BEARER_TOKEN}" \
  "https://${GUARDIANBOT_HOSTNAME}/operations/monitoring"
```

`GET /operations/monitoring` is a read-only operator ledger. Responses use
schema `guardianbot.monitoring.status.v1` with `cache-control: no-store` on
both `200` and the fixed `503` body
`{"error":"monitoring operations unavailable"}`. Internal failures log only a
bounded error kind; they never return config, evidence payloads, index
contents, credentials, digests, webhook payloads, resolved rows, or raw
provider text.

Response fields:

| Field | Source | Notes |
| --- | --- | --- |
| `generatedAt` | request time | ISO-8601 UTC |
| `scheduler` | process-local | `scope` is always `process-local`; gauges describe this instance only and are not fleet-authoritative |
| `activeAlerts` | store-backed | At most 512 sanitized active alerts from a stable bounded PostgreSQL JOIN (`repository_id`, `alert_key` order); `truncated` is explicit when more exist |
| `repositories` | derived from the alert page | Page-scoped unique repository names and `returnedAlertingCount`; `complete` is true only when the alert page itself is not truncated—not a fleet total |
| `weeklyReport` | store-backed | Current UTC-week aggregate (`v1:YYYY-MM-DD` for that Monday) or `null` when no report row exists yet |

Alert `fullName`, `alertKey`, and `summary` are length-capped (255 / 256 /
512). Truncation is silent character clipping at those bounds; page-level
truncation is the separate boolean on `activeAlerts`. Health/readiness
endpoints are useful process signals, not substitutes for external probes and
evidence reconciliation.

### Webhook queue retention

The control-plane worker periodically purges only terminal webhook rows
(`succeeded` and `dead-letter`). Pending and leased jobs are never deleted.
Cleanup runs in a separate loop so purge failures cannot block review handling.

| Environment variable | Default | Bounds |
| --- | --- | --- |
| `GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS` | 7 days | 1 hour … 365 days |
| `GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS` | 30 days | 1 hour … 365 days; must be ≥ succeeded retention |
| `GUARDIANBOT_WEBHOOK_CLEANUP_INTERVAL_MS` | 1 hour | 1 minute … 24 hours |
| `GUARDIANBOT_WEBHOOK_CLEANUP_BATCH_LIMIT` | 1000 | 1 … 10000 |

Invalid values fail boot with a clear error, including dead-letter retention
shorter than succeeded retention. Each cleanup batch is hard-capped (API and
env) and multi-instance safe (`FOR UPDATE SKIP LOCKED` on PostgreSQL).
Shutdown aborts the cleanup sleep so SIGTERM does not wait out the interval.

### Review finding retention

Each review record retains one entry per finding fingerprint so a resolved or
superseded finding can still be presented and its inline comment closed. The
retention window and the cap reach only terminal findings: an `open` finding is
live advisory state and is retained even when that holds the record above the
cap.

| Environment variable | Default | Bounds |
| --- | --- | --- |
| `GUARDIANBOT_REVIEW_FINDING_RETENTION_MS` | 90 days | 24 hours … 365 days |
| `GUARDIANBOT_REVIEW_FINDING_LIMIT` | 200 | 1 … 5000 |
| `GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS` | 365 days | 24 hours … 5 years |

Invalid or out-of-range values fail boot with a clear error naming the variable
and its bounds. Set the limit at or above the effective maximum inline comments
per review; below that, terminal findings are retained rather than dropped for
no reduction, so provenance survives but the record stays above the cap.

Two rules do reach an open finding, because "retained while it is still
reported" is not a bound on its own:

- `GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS` is an absolute ceiling
  measured from when a finding was first seen, not last observed, so
  re-observing it cannot extend it. A pull request can stay open indefinitely,
  and without this its retained reviewer-engagement identifiers would be too.
- Removing a repository, or uninstalling the App, discards the retained findings
  of every affected repository immediately. Both bounds above are applied while
  a review is being published, and nothing is ever published for a removed
  repository again, so removal has to be its own trigger. A *suspension* is
  reversible and does not discard.

The lifetime evicted counter advances by whatever a discard actually dropped, so
`findings_evicted_total` stays a truthful operator signal in both cases.

## First live AI review checklist

Use this only when enabling the first production AI-backed review. Do not treat
local developer credentials as production secrets.

1. Deploy the model bridge as an isolated service with its own config; keep
   provider API keys only on the bridge process.
2. Prefer the provider-neutral control-plane registry
   (`GUARDIAN_REVIEW_REGISTRY_JSON` or legacy `GUARDIAN_MODEL_BACKEND_REGISTRY`)
   that names only bridge endpoints, bearer-token env refs, allowed
   classifications, and routes—never provider product names, model ids, or
   upstream provider URLs.
3. Confirm registry/bridge separation: the control plane holds bridge URL and
   bridge bearer token only; adapter bindings and provider credentials exist
   only on the bridge.
4. Allowed classifications must include `private` for private repositories and
   `restricted` for internal repositories, as applicable (internal visibility
   is routed as `restricted`).
5. Run bridge health and protocol conformance, then exercise one ready pull
   request and confirm either a grounded review or advisory
   `AI review unavailable` without leaking prompts, credentials, or provider
   bodies.
6. Keep cross-backend fallback off unless explicitly approved.

## Host and secret operations

The droplet cloud-init profile enables UFW default-deny inbound policy,
unattended security upgrades, SSH password/root-login disablement, Docker
live-restore/log rotation, and `fail2ban`.

Rotate the GitHub App private key, webhook secret, evidence signing secret,
model bridge token, DAST exchange credentials, DigitalOcean token, DefectDojo
token, and database credentials independently. Emergency disablement removes
GitHub App access or stops the control plane; consumer security workflows
continue at their immutable pinned commit.
