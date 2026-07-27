#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/infra/docker-compose.yml"
ENV_FILE="${REPO_DIR}/.env"
STATE_DIR="${REPO_DIR}/.deploy-state"
CURRENT_IMAGE_FILE="${STATE_DIR}/current-image"
PREVIOUS_IMAGE_FILE="${STATE_DIR}/previous-image"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-postgres.sh"

usage() {
  cat <<'EOF'
Usage:
  deploy-digitalocean.sh deploy <ghcr-image@sha256:digest>
  deploy-digitalocean.sh verify
  deploy-digitalocean.sh rollback [<ghcr-image@sha256:digest>]

This script is intended for the DigitalOcean control-plane droplet only.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%OLp' "$1"
  fi
}

env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

ensure_prerequisites() {
  require_command docker
  require_command curl
  [ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
  mkdir -p "$STATE_DIR"

  local mode
  mode="$(file_mode "$ENV_FILE")"
  case "$mode" in
    600|400) ;;
    *) die "$ENV_FILE must be chmod 600 or 400; found mode $mode" ;;
  esac

  local required_keys=(
    GUARDIANBOT_HOSTNAME
    GUARDIANBOT_STATE_DIR
    POSTGRES_PASSWORD
    GITHUB_APP_ID
    GITHUB_APP_PRIVATE_KEY
    GITHUB_WEBHOOK_SECRET
  )
  local key
  for key in "${required_keys[@]}"; do
    [ -n "$(env_value "$key")" ] || die "$key is missing from $ENV_FILE"
  done

  export COMPOSE_PROJECT_NAME="guardianbot"
}

current_image() {
  if docker compose -f "$COMPOSE_FILE" ps -q control-plane >/dev/null 2>&1; then
    local container_id
    container_id="$(docker compose -f "$COMPOSE_FILE" ps -q control-plane || true)"
    if [ -n "$container_id" ]; then
      docker inspect --format '{{.Config.Image}}' "$container_id"
      return 0
    fi
  fi
  return 1
}

wait_for_health() {
  local service="$1"
  local timeout="${2:-120}"
  local started_at
  started_at="$(date +%s)"
  while true; do
    local container_id status
    container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$service" 2>/dev/null || true)"
    [ -n "$container_id" ] || die "$service is not running"
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    case "$status" in
      healthy|running) return 0 ;;
      unhealthy|exited|dead) die "$service entered bad state: $status" ;;
    esac
    if [ $(( "$(date +%s)" - started_at )) -ge "$timeout" ]; then
      die "timed out waiting for $service to become healthy"
    fi
    sleep 3
  done
}

verify_stack() {
  local hostname
  hostname="$(env_value GUARDIANBOT_HOSTNAME)"

  docker compose -f "$COMPOSE_FILE" ps
  wait_for_health postgres 180
  wait_for_health control-plane 180

  curl --fail --silent --show-error \
    --resolve "${hostname}:443:127.0.0.1" \
    "https://${hostname}/healthz" >/dev/null
}

deploy_image() {
  local image="${1:-}"
  [ -n "$image" ] || die "deploy requires an immutable image digest"
  case "$image" in
    *@sha256:*) ;;
    *) die "image must be pinned by digest, for example ghcr.io/org/guardianbot@sha256:..." ;;
  esac

  ensure_prerequisites
  export GUARDIANBOT_IMAGE="$image"

  if current="$(current_image 2>/dev/null || true)"; then
    printf '%s\n' "$current" > "$PREVIOUS_IMAGE_FILE"
  fi

  docker pull "$GUARDIANBOT_IMAGE"
  if docker compose -f "$COMPOSE_FILE" ps -q postgres >/dev/null 2>&1 &&
     [ -n "$(docker compose -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)" ]; then
    "$BACKUP_SCRIPT"
  fi

  docker compose -f "$COMPOSE_FILE" pull control-plane postgres caddy prometheus
  docker compose -f "$COMPOSE_FILE" up -d postgres
  wait_for_health postgres 180
  docker compose -f "$COMPOSE_FILE" up -d control-plane caddy prometheus
  verify_stack

  printf '%s\n' "$GUARDIANBOT_IMAGE" > "$CURRENT_IMAGE_FILE"
}

rollback_image() {
  ensure_prerequisites
  local image="${1:-}"
  if [ -z "$image" ]; then
    [ -f "$PREVIOUS_IMAGE_FILE" ] || die "no previous image recorded"
    image="$(cat "$PREVIOUS_IMAGE_FILE")"
  fi
  case "$image" in
    *@sha256:*) ;;
    *) die "rollback image must be pinned by digest" ;;
  esac

  export GUARDIANBOT_IMAGE="$image"
  docker pull "$GUARDIANBOT_IMAGE"
  docker compose -f "$COMPOSE_FILE" up -d control-plane caddy
  verify_stack
  printf '%s\n' "$GUARDIANBOT_IMAGE" > "$CURRENT_IMAGE_FILE"
}

main() {
  local command="${1:-}"
  case "$command" in
    deploy)
      shift
      deploy_image "${1:-}"
      ;;
    verify)
      ensure_prerequisites
      export GUARDIANBOT_IMAGE="${GUARDIANBOT_IMAGE:-$(cat "$CURRENT_IMAGE_FILE" 2>/dev/null || true)}"
      [ -n "${GUARDIANBOT_IMAGE:-}" ] || die "set GUARDIANBOT_IMAGE or deploy once first"
      verify_stack
      ;;
    rollback)
      shift
      rollback_image "${1:-}"
      ;;
    -*|'')
      usage
      exit 1
      ;;
    *)
      usage
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
