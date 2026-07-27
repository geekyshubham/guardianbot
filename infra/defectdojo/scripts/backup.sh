#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
require_command flock
require_command sha256sum
"${SCRIPT_DIR}/preflight.sh"

retention_days=14
prune_backups=true
if [[ "${1:-}" == "--retention-days" ]]; then
  if [[ ! "${2:-}" =~ ^[0-9]+$ ]] || (( 10#${2} < 1 || 10#${2} > 365 )); then
    printf 'Retention must be between 1 and 365 days.\n' >&2
    exit 1
  fi
  retention_days="$2"
  shift 2
fi
if [[ "${1:-}" == "--no-prune" ]]; then
  prune_backups=false
  shift
fi
[[ "$#" -eq 0 ]] || {
  printf 'Usage: sudo %s [--retention-days DAYS] [--no-prune]\n' "$0" >&2
  exit 1
}

install -d -m 0700 -o root -g root "${BACKUP_ROOT}"
exec 9>"/run/lock/guardianbot-defectdojo-backup.lock"
flock -n 9 || {
  printf 'Another DefectDojo backup or restore operation is active.\n' >&2
  exit 1
}

backup_id="$(date -u +'%Y%m%dT%H%M%SZ')"
backup_dir="${BACKUP_ROOT}/${backup_id}"
[[ ! -e "${backup_dir}" ]] || {
  printf 'A backup with ID %s already exists; retry after the current UTC second.\n' "${backup_id}" >&2
  exit 1
}
install -d -m 0700 -o root -g root "${backup_dir}"

services_stopped=false
restart_services() {
  if [[ "${services_stopped}" == "true" ]]; then
    compose start uwsgi celeryworker celerybeat nginx caddy >/dev/null 2>&1 || true
  fi
}
trap restart_services EXIT

printf 'Pausing DefectDojo writers for a consistent database and media snapshot.\n'
compose stop -t 90 caddy nginx celerybeat celeryworker uwsgi
services_stopped=true

# The single-quoted command expands only inside the utility container.
# shellcheck disable=SC2016
compose run \
  --rm \
  --no-deps \
  --env "BACKUP_ID=${backup_id}" \
  postgres-tools \
  -eu \
  -c '
    umask 077
    pg_dump \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
      --file="/backup/${BACKUP_ID}/database.dump" \
      --dbname="${PGDATABASE}"
  '

# The single-quoted command expands only inside the utility container.
# shellcheck disable=SC2016
compose run \
  --rm \
  --no-deps \
  --env "BACKUP_ID=${backup_id}" \
  operator \
  -Eeuo pipefail \
  -c '
    umask 077
    tar --create --gzip --file="/backup/${BACKUP_ID}/media.tar.gz" --directory=/restore/media .
    tar --create --gzip --file="/backup/${BACKUP_ID}/caddy-data.tar.gz" --directory=/restore/caddy-data .
    tar --create --gzip --file="/backup/${BACKUP_ID}/caddy-config.tar.gz" --directory=/restore/caddy-config .
  '

install -m 0600 -o root -g root "${STACK_DIR}/release-manifest.json" "${backup_dir}/release-manifest.json"
(
  cd "${backup_dir}"
  sha256sum \
    caddy-config.tar.gz \
    caddy-data.tar.gz \
    database.dump \
    media.tar.gz \
    release-manifest.json > SHA256SUMS
)
chmod 0600 "${backup_dir}/"*

compose start uwsgi celeryworker celerybeat nginx caddy
services_stopped=false
trap - EXIT
"${SCRIPT_DIR}/wait-ready.sh" 600

if [[ "${prune_backups}" == "true" ]]; then
  if [[ "${BACKUP_ROOT}" != "/var/backups/guardianbot/defectdojo" ]]; then
    printf 'Unexpected backup root; refusing retention cleanup.\n' >&2
    exit 1
  fi
  find "${BACKUP_ROOT}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -mtime "+${retention_days}" \
    -exec rm -rf -- {} +
fi

printf 'Created consistent DefectDojo backup %s with SHA-256 checksums.\n' "${backup_id}"
printf 'Valkey is intentionally excluded because it is a replayable task broker, not a source of record.\n'
