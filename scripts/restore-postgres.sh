#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/infra/docker-compose.yml"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-postgres.sh"

usage() {
  cat <<'EOF'
Usage:
  restore-postgres.sh --input /absolute/path/to/guardianbot-postgres-YYYYMMDDTHHMMSSZ.dump --yes
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

main() {
  local input="" confirmed="0"
  while [ $# -gt 0 ]; do
    case "$1" in
      --input)
        shift
        input="${1:-}"
        ;;
      --yes)
        confirmed="1"
        ;;
      -*|'')
        usage
        exit 1
        ;;
      *)
        usage
        die "unknown argument: $1"
        ;;
    esac
    shift || true
  done

  [ "$confirmed" = "1" ] || die "restore requires --yes"
  [ -n "$input" ] || die "restore requires --input"
  [ -f "$input" ] || die "backup file not found: $input"

  "$BACKUP_SCRIPT" >/dev/null

  docker compose -f "$COMPOSE_FILE" stop caddy control-plane
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U guardianbot -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'guardianbot' AND pid <> pg_backend_pid();" >/dev/null
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U guardianbot -d postgres \
    -c "DROP DATABASE IF EXISTS guardianbot;" >/dev/null
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U guardianbot -d postgres \
    -c "CREATE DATABASE guardianbot OWNER guardianbot;" >/dev/null

  docker compose -f "$COMPOSE_FILE" exec -T postgres sh -lc \
    'cat >/tmp/guardianbot-restore.dump && pg_restore --clean --if-exists --no-owner --no-privileges --username guardianbot --dbname guardianbot /tmp/guardianbot-restore.dump && rm -f /tmp/guardianbot-restore.dump' \
    < "$input"

  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U guardianbot -d guardianbot \
    -c "SELECT 1;" >/dev/null
  docker compose -f "$COMPOSE_FILE" start control-plane caddy
}

main "$@"
