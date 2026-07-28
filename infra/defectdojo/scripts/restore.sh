#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
require_command flock
require_command sha256sum
verify_stack_definition installed
"${SCRIPT_DIR}/preflight.sh"

backup_id="${1:-}"
confirmation="${2:-}"
expected_confirmation="RESTORE-guardianbot-defectdojo-${backup_id}"
if [[ ! "${backup_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ || "${confirmation}" != "${expected_confirmation}" || "$#" -ne 2 ]]; then
  printf 'Usage: sudo %s BACKUP_ID RESTORE-guardianbot-defectdojo-BACKUP_ID\n' "$0" >&2
  exit 1
fi

backup_dir="${BACKUP_ROOT}/${backup_id}"
[[ -d "${backup_dir}" && ! -L "${backup_dir}" ]] || {
  printf 'Backup does not exist: %s\n' "${backup_id}" >&2
  exit 1
}
required_files=(
  SHA256SUMS
  caddy-config.tar.gz
  caddy-data.tar.gz
  database.dump
  media.tar.gz
  release-manifest.json
)
for file in "${required_files[@]}"; do
  [[ -f "${backup_dir}/${file}" && ! -L "${backup_dir}/${file}" ]] || {
    printf 'Backup is missing regular file: %s\n' "${file}" >&2
    exit 1
  }
done
(
  cd "${backup_dir}"
  sha256sum --check --quiet SHA256SUMS
)
cmp --silent "${STACK_DIR}/release-manifest.json" "${backup_dir}/release-manifest.json" || {
  printf 'Backup release differs from the installed release. Restore the matching immutable release definition first.\n' >&2
  exit 1
}
verify_stack_definition installed

printf 'Creating a safety backup before destructive restore.\n'
"${SCRIPT_DIR}/backup.sh" --no-prune

exec 9>"/run/lock/guardianbot-defectdojo-backup.lock"
flock -n 9 || {
  printf 'Another DefectDojo backup or restore operation is active.\n' >&2
  exit 1
}

printf 'Stopping DefectDojo. A failed restore intentionally leaves the stack stopped.\n'
compose stop -t 90 caddy nginx celerybeat celeryworker uwsgi valkey

# The single-quoted command expands only inside the utility container.
# shellcheck disable=SC2016
compose run \
  --rm \
  --no-deps \
  --env "RESTORE_ID=${backup_id}" \
  postgres-tools \
  -eu \
  -c '
    pg_restore \
      --clean \
      --if-exists \
      --exit-on-error \
      --no-owner \
      --no-privileges \
      --dbname="${PGDATABASE}" \
      "/backup/${RESTORE_ID}/database.dump"
  '

# The single-quoted command expands only inside the utility container.
# shellcheck disable=SC2016
compose run \
  --rm \
  --no-deps \
  --env "RESTORE_ID=${backup_id}" \
  operator \
  -Eeuo pipefail \
  -c '
    python3 /operator/restore-volume.py media --archive "/backup/${RESTORE_ID}/media.tar.gz"
    python3 /operator/restore-volume.py caddy-data --archive "/backup/${RESTORE_ID}/caddy-data.tar.gz"
    python3 /operator/restore-volume.py caddy-config --archive "/backup/${RESTORE_ID}/caddy-config.tar.gz"
    python3 /operator/restore-volume.py valkey --clear-only
  '

compose up --no-deps --force-recreate initializer
compose up -d --remove-orphans
"${SCRIPT_DIR}/wait-ready.sh" 900
"${SCRIPT_DIR}/doctor.sh"

printf 'Restored and verified DefectDojo backup %s. The replayable Valkey queue was intentionally reset.\n' "${backup_id}"
