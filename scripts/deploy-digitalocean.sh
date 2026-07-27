#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/infra/docker-compose.yml"
ENV_FILE="${REPO_DIR}/.env"
STATE_DIR="${REPO_DIR}/.deploy-state"
CURRENT_RELEASE_DIR="${STATE_DIR}/current-release"
PREVIOUS_RELEASE_DIR="${STATE_DIR}/previous-release"
CURRENT_IMAGE_FILE="${STATE_DIR}/current-image"
PREVIOUS_IMAGE_FILE="${STATE_DIR}/previous-image"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-postgres.sh"
CANONICAL_REPOSITORY="geekyshubham/guardianbot"
CANONICAL_IMAGE="ghcr.io/geekyshubham/guardianbot"
GITHUB_OIDC_ISSUER="https://token.actions.githubusercontent.com"

usage() {
  cat <<'EOF'
Usage:
  deploy-digitalocean.sh deploy <release-asset-directory>
  deploy-digitalocean.sh verify
  deploy-digitalocean.sh rollback [<release-asset-directory>]

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
  [ ! -L "$STATE_DIR" ] || die "deployment state directory must not be a symlink"
  mkdir -p "$STATE_DIR"
  [ -d "$STATE_DIR" ] || die "deployment state path is not a directory"
  chmod 700 "$STATE_DIR"

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

ensure_release_verification_prerequisites() {
  require_command cosign
  require_command gh
  require_command jq
  require_command node
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

release_manifest_field() {
  local manifest_path="$1"
  local expression="$2"
  local label="$3"
  jq -er "$expression" "$manifest_path" 2>/dev/null ||
    die "release manifest is missing ${label}"
}

release_reference_from_directory() {
  local release_directory="$1"
  release_manifest_field \
    "${release_directory}/release-manifest.json" \
    '.image.reference' \
    "the image reference"
}

copy_release_directory() {
  local source_directory="$1"
  local target_directory="$2"
  mkdir -p "$target_directory"
  chmod 700 "$target_directory"
  cp "$source_directory"/* "$target_directory"/
  chmod 600 "$target_directory"/*
}

remove_state_release_directory() {
  local target_directory="$1"
  case "$target_directory" in
    "$CURRENT_RELEASE_DIR"|"$PREVIOUS_RELEASE_DIR") ;;
    *) die "refusing to remove an unexpected deployment state path" ;;
  esac
  if [ -L "$target_directory" ]; then
    die "deployment release state must not be a symlink"
  fi
  if [ -e "$target_directory" ]; then
    [ -d "$target_directory" ] ||
      die "deployment release state is not a directory"
    rm -r -- "$target_directory"
  fi
}

verify_release_directory() {
  local release_directory="${1:-}"
  [ -n "$release_directory" ] || die "release asset directory is required"
  [[ -d "$release_directory" ]] || die "release asset directory does not exist"

  ensure_release_verification_prerequisites

  local absolute_release_directory
  absolute_release_directory="$(cd "$release_directory" && pwd)"
  local manifest_path="${absolute_release_directory}/release-manifest.json"
  local manifest_bundle="${absolute_release_directory}/release-manifest.sigstore.json"
  [[ -f "$manifest_path" ]] || die "release-manifest.json is missing"
  [[ -f "$manifest_bundle" ]] || die "release-manifest.sigstore.json is missing"

  (
    cd "$REPO_DIR"
    RELEASE_ASSET_DIRECTORY="$absolute_release_directory" \
      node scripts/release-evidence.mjs verify-assets >/dev/null
  )

  local release_tag
  local release_sha
  local release_repository
  local release_ref
  local release_image
  local release_digest
  local release_reference
  local workflow_identity
  local expected_workflow_identity
  release_tag="$(release_manifest_field "$manifest_path" '.source.tag' "source.tag")"
  release_sha="$(release_manifest_field "$manifest_path" '.source.commit' "source.commit")"
  release_repository="$(release_manifest_field "$manifest_path" '.source.repository' "source.repository")"
  release_ref="$(release_manifest_field "$manifest_path" '.source.ref' "source.ref")"
  release_image="$(release_manifest_field "$manifest_path" '.image.name' "image.name")"
  release_digest="$(release_manifest_field "$manifest_path" '.image.digest' "image.digest")"
  release_reference="$(release_manifest_field "$manifest_path" '.image.reference' "image.reference")"
  workflow_identity="$(release_manifest_field "$manifest_path" '.builder.workflowIdentity' "builder.workflowIdentity")"
  expected_workflow_identity="$(
    printf 'https://github.com/%s/.github/workflows/release.yml@%s' \
      "$release_repository" "$release_ref"
  )"

  [[ "$release_repository" == "$CANONICAL_REPOSITORY" ]] ||
    die "release repository is not ${CANONICAL_REPOSITORY}"
  [[ "$release_image" == "$CANONICAL_IMAGE" ]] ||
    die "release image is not ${CANONICAL_IMAGE}"
  [[ "$release_reference" == "${release_image}@${release_digest}" ]] ||
    die "release reference is inconsistent"
  [[ "$release_ref" == "refs/tags/${release_tag}" ]] ||
    die "release ref is inconsistent"
  [[ "$workflow_identity" == "$expected_workflow_identity" ]] ||
    die "release workflow identity is inconsistent"

  (
    cd "$REPO_DIR"
    RELEASE_MANIFEST_PATH="$manifest_path" \
    RELEASE_TAG="$release_tag" \
    RELEASE_SHA="$release_sha" \
    RELEASE_REPOSITORY="$release_repository" \
    RELEASE_DIGEST="$release_digest" \
      node scripts/release-evidence.mjs verify-manifest >/dev/null
  )
  cosign verify-blob "$manifest_path" \
    --bundle "$manifest_bundle" \
    --certificate-identity "$workflow_identity" \
    --certificate-oidc-issuer "$GITHUB_OIDC_ISSUER" \
    >/dev/null
  cosign verify "$release_reference" \
    --certificate-identity "$workflow_identity" \
    --certificate-oidc-issuer "$GITHUB_OIDC_ISSUER" \
    >/dev/null
  cosign verify-attestation "$release_reference" \
    --type cyclonedx \
    --certificate-identity "$workflow_identity" \
    --certificate-oidc-issuer "$GITHUB_OIDC_ISSUER" \
    >/dev/null
  gh attestation verify "oci://${release_reference}" \
    --repo "$release_repository" \
    --bundle-from-oci \
    --cert-identity "$workflow_identity" \
    --cert-oidc-issuer "$GITHUB_OIDC_ISSUER" \
    --source-digest "$release_sha" \
    --source-ref "$release_ref" \
    --deny-self-hosted-runners \
    >/dev/null

  VERIFIED_RELEASE_DIRECTORY="$absolute_release_directory"
  VERIFIED_RELEASE_REFERENCE="$release_reference"
}

record_release_state() {
  local deployed_release_directory="$1"
  local current_stage
  current_stage="$(mktemp -d "${STATE_DIR}/current-release.XXXXXX")"
  copy_release_directory "$deployed_release_directory" "$current_stage"

  local previous_stage=""
  local previous_reference=""
  if [ -d "$CURRENT_RELEASE_DIR" ]; then
    previous_stage="$(mktemp -d "${STATE_DIR}/previous-release.XXXXXX")"
    copy_release_directory "$CURRENT_RELEASE_DIR" "$previous_stage"
    previous_reference="$(release_reference_from_directory "$CURRENT_RELEASE_DIR")"
  fi

  remove_state_release_directory "$CURRENT_RELEASE_DIR"
  remove_state_release_directory "$PREVIOUS_RELEASE_DIR"
  mv "$current_stage" "$CURRENT_RELEASE_DIR"
  if [ -n "$previous_stage" ]; then
    mv "$previous_stage" "$PREVIOUS_RELEASE_DIR"
  fi

  printf '%s\n' "$(release_reference_from_directory "$CURRENT_RELEASE_DIR")" \
    > "$CURRENT_IMAGE_FILE"
  chmod 600 "$CURRENT_IMAGE_FILE"

  if [ -n "$previous_reference" ]; then
    printf '%s\n' "$previous_reference" > "$PREVIOUS_IMAGE_FILE"
    chmod 600 "$PREVIOUS_IMAGE_FILE"
  else
    rm -f "$PREVIOUS_IMAGE_FILE"
  fi
}

verify_stack() {
  local expected_image="${1:-}"
  local hostname
  hostname="$(env_value GUARDIANBOT_HOSTNAME)"

  docker compose -f "$COMPOSE_FILE" ps
  wait_for_health postgres 180
  wait_for_health control-plane 180

  if [ -n "$expected_image" ]; then
    local actual_image
    actual_image="$(current_image 2>/dev/null || true)"
    [ -n "$actual_image" ] || die "control-plane image is not running"
    [ "$actual_image" = "$expected_image" ] ||
      die "control-plane image mismatch: expected $expected_image, got $actual_image"
  fi

  curl --fail --silent --show-error \
    --resolve "${hostname}:443:127.0.0.1" \
    "https://${hostname}/healthz" >/dev/null
  curl --fail --silent --show-error \
    --resolve "${hostname}:443:127.0.0.1" \
    "https://${hostname}/readyz" >/dev/null
}

deploy_release() {
  local release_directory="${1:-}"
  verify_release_directory "$release_directory"
  ensure_prerequisites
  export GUARDIANBOT_IMAGE="$VERIFIED_RELEASE_REFERENCE"

  docker pull "$GUARDIANBOT_IMAGE"
  if docker compose -f "$COMPOSE_FILE" ps -q postgres >/dev/null 2>&1 &&
     [ -n "$(docker compose -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)" ]; then
    "$BACKUP_SCRIPT"
  fi

  docker compose -f "$COMPOSE_FILE" pull control-plane postgres caddy prometheus
  docker compose -f "$COMPOSE_FILE" up -d postgres
  wait_for_health postgres 180
  docker compose -f "$COMPOSE_FILE" up -d control-plane caddy prometheus
  verify_stack "$GUARDIANBOT_IMAGE"
  record_release_state "$VERIFIED_RELEASE_DIRECTORY"
}

rollback_release() {
  local release_directory="${1:-}"
  if [ -z "$release_directory" ]; then
    [ -d "$PREVIOUS_RELEASE_DIR" ] ||
      die "no previous verified release recorded; pass a canonical release asset directory explicitly"
    release_directory="$PREVIOUS_RELEASE_DIR"
  fi
  deploy_release "$release_directory"
}

main() {
  local command="${1:-}"
  case "$command" in
    deploy)
      shift
      deploy_release "${1:-}"
      ;;
    verify)
      ensure_prerequisites
      if [ -d "$CURRENT_RELEASE_DIR" ]; then
        verify_release_directory "$CURRENT_RELEASE_DIR"
        export GUARDIANBOT_IMAGE="$VERIFIED_RELEASE_REFERENCE"
      else
        export GUARDIANBOT_IMAGE="${GUARDIANBOT_IMAGE:-$(cat "$CURRENT_IMAGE_FILE" 2>/dev/null || true)}"
      fi
      [ -n "${GUARDIANBOT_IMAGE:-}" ] || die "set GUARDIANBOT_IMAGE or deploy once first"
      verify_stack "$GUARDIANBOT_IMAGE"
      ;;
    rollback)
      shift
      rollback_release "${1:-}"
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
