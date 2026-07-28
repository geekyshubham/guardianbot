#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(dirname -- "${SCRIPT_DIR}")"
ENV_FILE="/etc/guardianbot/defectdojo.env"
# These shared paths are consumed by scripts that source this library.
# shellcheck disable=SC2034
CA_FILE="/etc/guardianbot/do-postgres-ca.crt"
# shellcheck disable=SC2034
BACKUP_ROOT="/var/backups/guardianbot/defectdojo"
COMPOSE_FILE="${STACK_DIR}/compose.yml"
RELEASE_MANIFEST="${STACK_DIR}/release-manifest.json"
STACK_DEFINITION_FILES=(
  Caddyfile
  cloud-init.yml
  compose.yml
  scripts/apply-release.sh
  scripts/backup.sh
  scripts/doctor.sh
  scripts/generate-env.sh
  scripts/install-host.sh
  scripts/lib.sh
  scripts/preflight.sh
  scripts/pull-and-verify-images.sh
  scripts/restore-volume.py
  scripts/restore.sh
  scripts/verify-stack-definition.sh
  scripts/wait-ready.sh
  systemd/guardianbot-defectdojo-backup.service
  systemd/guardianbot-defectdojo-backup.timer
  systemd/guardianbot-defectdojo.service
)

compose() {
  docker compose \
    --project-directory "${STACK_DIR}" \
    --env-file "${ENV_FILE}" \
    --file "${COMPOSE_FILE}" \
    "$@"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    printf 'This command must run as root.\n' >&2
    exit 1
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    exit 1
  fi
}

verify_stack_definition() {
  local mode="${1:-installed}"
  local expected_count actual_count relative_path expected_hash actual_hash
  local source_commit installed_unit

  if [[ "${mode}" != "source" && "${mode}" != "installed" ]]; then
    printf 'Unknown stack-definition verification mode: %s\n' "${mode}" >&2
    exit 1
  fi
  require_command cmp
  require_command jq
  require_command sha256sum

  [[ -f "${RELEASE_MANIFEST}" && ! -L "${RELEASE_MANIFEST}" ]] || {
    printf 'Release manifest must be a regular non-symlink file: %s\n' "${RELEASE_MANIFEST}" >&2
    exit 1
  }
  jq -e '
    type == "object" and
    (keys == [
      "defectdojoRelease",
      "guardianbotSource",
      "images",
      "platform",
      "schemaVersion",
      "stackDefinition",
      "upstreamCommit",
      "upstreamTagObject"
    ]) and
    .schemaVersion == "1.0.0" and
    .guardianbotSource.repository ==
      "https://github.com/geekyshubham/guardianbot" and
    (.guardianbotSource | keys == ["commit", "repository"]) and
    .stackDefinition.algorithm == "sha256" and
    (.stackDefinition | keys == ["algorithm", "files"]) and
    (.stackDefinition.files | type == "object")
  ' "${RELEASE_MANIFEST}" >/dev/null || {
    printf 'Release manifest has an invalid stack-definition contract.\n' >&2
    exit 1
  }

  source_commit="$(jq -er '.guardianbotSource.commit' "${RELEASE_MANIFEST}")"
  if [[ "${mode}" == "source" && "${source_commit}" == '$Format:%H$' ]]; then
    :
  elif [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Release manifest does not bind an exact GuardianBot source commit.\n' >&2
    exit 1
  fi

  expected_count="${#STACK_DEFINITION_FILES[@]}"
  actual_count="$(jq -er '.stackDefinition.files | length' "${RELEASE_MANIFEST}")"
  [[ "${actual_count}" == "${expected_count}" ]] || {
    printf 'Release manifest stack-definition file set is incomplete.\n' >&2
    exit 1
  }

  for relative_path in "${STACK_DEFINITION_FILES[@]}"; do
    [[ -f "${STACK_DIR}/${relative_path}" && ! -L "${STACK_DIR}/${relative_path}" ]] || {
      printf 'Stack definition is missing a regular file: %s\n' "${relative_path}" >&2
      exit 1
    }
    expected_hash="$(
      jq -er --arg path "${relative_path}" \
        '.stackDefinition.files[$path]' "${RELEASE_MANIFEST}"
    )"
    [[ "${expected_hash}" =~ ^[0-9a-f]{64}$ ]] || {
      printf 'Release manifest has an invalid checksum for %s.\n' "${relative_path}" >&2
      exit 1
    }
    actual_hash="$(sha256sum -- "${STACK_DIR}/${relative_path}")"
    actual_hash="${actual_hash%% *}"
    [[ "${actual_hash}" == "${expected_hash}" ]] || {
      printf 'Stack definition drift detected: %s\n' "${relative_path}" >&2
      exit 1
    }
  done

  if [[ "${mode}" == "installed" ]]; then
    for relative_path in "${STACK_DEFINITION_FILES[@]}"; do
      [[ "${relative_path}" == systemd/* ]] || continue
      installed_unit="/etc/systemd/system/${relative_path#systemd/}"
      [[ -f "${installed_unit}" && ! -L "${installed_unit}" ]] || {
        printf 'Installed systemd unit is missing or unsafe: %s\n' "${installed_unit}" >&2
        exit 1
      }
      cmp --silent "${STACK_DIR}/${relative_path}" "${installed_unit}" || {
        printf 'Installed systemd unit drift detected: %s\n' "${installed_unit}" >&2
        exit 1
      }
    done
  fi
}

read_public_env_value() {
  local key="$1"
  local value

  value="$(sed -n "s/^${key}=//p" "${ENV_FILE}")"
  if [[ -z "${value}" || "${value}" == *$'\n'* ]]; then
    printf 'Expected exactly one non-empty %s entry in %s.\n' "${key}" "${ENV_FILE}" >&2
    exit 1
  fi
  printf '%s' "${value}"
}
