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
