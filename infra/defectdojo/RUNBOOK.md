# DefectDojo operator runbook

All commands run on the DigitalOcean Droplet as root. The installed stack lives
at `/opt/guardianbot-defectdojo`; secrets and the PostgreSQL CA live under
`/etc/guardianbot`.

## Health and diagnosis

```bash
systemctl status guardianbot-defectdojo.service
/opt/guardianbot-defectdojo/scripts/doctor.sh
docker compose \
  --project-directory /opt/guardianbot-defectdojo \
  --env-file /etc/guardianbot/defectdojo.env \
  --file /opt/guardianbot-defectdojo/compose.yml \
  ps
```

`doctor.sh` proves:

- all long-running containers are healthy;
- the initializer completed successfully;
- the public `/healthz` endpoint has a valid TLS chain;
- required response security headers are present;
- Django's deployment checks complete;
- Django's active PostgreSQL session uses TLS.

Inspect only the affected service and keep log output bounded:

```bash
docker compose \
  --project-directory /opt/guardianbot-defectdojo \
  --env-file /etc/guardianbot/defectdojo.env \
  --file /opt/guardianbot-defectdojo/compose.yml \
  logs --tail 200 SERVICE
```

Never run `docker compose config` without redirecting output during incident
handling: its normalized output includes container environment values.

## Backup

The systemd timer runs nightly with a randomized delay:

```bash
systemctl list-timers guardianbot-defectdojo-backup.timer
systemctl start guardianbot-defectdojo-backup.service
journalctl -u guardianbot-defectdojo-backup.service --since today
```

Manual backup:

```bash
/opt/guardianbot-defectdojo/scripts/backup.sh --retention-days 14
```

The script takes an exclusive lock, briefly stops public and worker write paths,
creates a custom-format PostgreSQL dump, archives media and Caddy state, records
the immutable release, creates SHA-256 checksums, restarts services, and waits
for readiness. Backup directories are root-only under
`/var/backups/guardianbot/defectdojo`.

Valkey is excluded. GuardianBot must replay incomplete scan imports from
immutable evidence after a restore.

## Restore drill or incident restore

Restore is destructive and release-bound. First install the exact Compose and
release manifest recorded in the target backup. List available IDs without
printing file contents:

```bash
find /var/backups/guardianbot/defectdojo \
  -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
```

Then restore:

```bash
/opt/guardianbot-defectdojo/scripts/restore.sh \
  20260727T023000Z \
  RESTORE-guardianbot-defectdojo-20260727T023000Z
```

The script validates checksums and release identity, makes a safety backup,
stops the stack, cleans and restores the dedicated database, safely extracts
allowlisted volume archives, clears the replayable Valkey queue, reruns the
idempotent initializer, and executes `doctor.sh`.

If restore fails after shutdown, the stack intentionally remains stopped.
Preserve logs, correct the cause, and retry with either the requested backup or
the automatically created safety backup. Do not start uWSGI against a
partially-restored database.

## Release update

Do not edit a running installation in place.

1. Review the official DefectDojo release notes and upgrade guide.
2. Update `compose.yml` and `release-manifest.json` together with exact
   `linux/amd64` manifest digests.
3. Run:

   ```bash
   node infra/defectdojo/validate-config.mjs
   node --test tests/infra-defectdojo.test.mjs
   docker compose \
     --project-directory infra/defectdojo \
     --env-file infra/defectdojo/env.example \
     --file infra/defectdojo/compose.yml \
     config --quiet
   ```

4. Install the reviewed files on the Droplet without changing `/etc/guardianbot`.
5. Apply the release:

   ```bash
   /opt/guardianbot-defectdojo/scripts/apply-release.sh
   ```

The script requires a backup, pulls and architecture-checks immutable images,
stops write paths, runs the official initializer/migrations, restarts the stack,
and runs the full doctor.

Container rollback after database migrations is unsafe. Roll back by installing
the prior immutable definition and restoring its matching pre-upgrade backup.

## Secret rotation

Never rotate `DD_CREDENTIAL_AES_256_KEY` as a routine operation. It protects
stored integration credentials; losing it makes those values unrecoverable.
Back it up in the approved secret manager and preserve it across upgrades and
restores.

Preserve `DD_SECRET_KEY` unless a documented Django key rotation procedure and
forced session invalidation are planned.

For a database password rotation:

1. create or rotate the dedicated user in DigitalOcean;
2. copy `/etc/guardianbot/defectdojo.env` to a root-only recovery file;
3. atomically replace only `DD_DATABASE_PASSWORD`;
4. run `preflight.sh`;
5. restart the service and run `doctor.sh`;
6. securely remove the recovery file after verification.

Rotate the bootstrap administrator password in the DefectDojo UI. Rotate the
GuardianBot API token by creating a new token, updating only the GuardianBot
control-plane secret, verifying an import, and then revoking the old token.

## Emergency disablement

Stop ingress and workers without deleting evidence:

```bash
systemctl stop guardianbot-defectdojo.service
```

If only GuardianBot imports are compromised, revoke or rotate the dedicated API
token first; the DefectDojo UI can remain available. If the Droplet is
compromised, remove it from PostgreSQL trusted sources and the Cloud Firewall,
preserve DigitalOcean snapshots/logs for investigation, rotate database and API
credentials, and restore onto a fresh Droplet from a verified backup.

Never use `docker compose down --volumes`, delete the managed database, or
overwrite `/etc/guardianbot/defectdojo.env` during emergency containment.
