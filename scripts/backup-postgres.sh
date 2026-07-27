#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/infra/docker-compose.yml"
ENV_FILE="${REPO_DIR}/.env"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

ensure_mounted_backup_target() {
  local backup_dir="$1"
  command -v findmnt >/dev/null 2>&1 || return 0
  if findmnt -T "$backup_dir" -o TARGET,SOURCE -n | awk '$1 == "/" { exit 1 }'; then
    return 0
  fi
  if [ "${GUARDIANBOT_ALLOW_ROOTFS_BACKUPS:-0}" = "1" ]; then
    return 0
  fi
  die "backup directory resolves to the root filesystem; mount an encrypted DigitalOcean volume or set GUARDIANBOT_ALLOW_ROOTFS_BACKUPS=1 for a temporary exception"
}

main() {
  require_command docker
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE"

  local state_dir backup_dir file metadata container_id
  state_dir="${GUARDIANBOT_STATE_DIR:-$(env_value GUARDIANBOT_STATE_DIR)}"
  [ -n "$state_dir" ] || die "GUARDIANBOT_STATE_DIR is required"
  backup_dir="${GUARDIANBOT_BACKUP_DIR:-${state_dir}/backups}"
  ensure_mounted_backup_target "$backup_dir"
  install -d -m 0700 "$backup_dir"
  umask 077

  container_id="$(docker compose -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)"
  [ -n "$container_id" ] || die "postgres service is not running"

  file="${backup_dir}/guardianbot-postgres-${TIMESTAMP}.dump"
  metadata="${backup_dir}/guardianbot-postgres-${TIMESTAMP}.json"

  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump --format=custom --no-owner --no-privileges --username guardianbot guardianbot > "$file"

  cat > "$metadata" <<EOF
{
  "createdAt": "${TIMESTAMP}",
  "backupFile": "$(basename "$file")",
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "controlPlaneImage": "$(docker compose -f "$COMPOSE_FILE" ps -q control-plane >/dev/null 2>&1 && docker inspect --format '{{.Config.Image}}' "$(docker compose -f "$COMPOSE_FILE" ps -q control-plane 2>/dev/null || true)" 2>/dev/null || true)"
}
EOF

  docker compose -f "$COMPOSE_FILE" exec -T postgres sh -lc \
    'cat >/tmp/guardianbot-verify.dump && pg_restore --list /tmp/guardianbot-verify.dump >/dev/null && rm -f /tmp/guardianbot-verify.dump' \
    < "$file"

  printf '%s\n' "$file"
}

main "$@"
