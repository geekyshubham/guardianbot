#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
require_command curl

timeout_seconds="${1:-600}"
if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]] \
  || (( 10#${timeout_seconds} < 30 || 10#${timeout_seconds} > 1800 )); then
  printf 'Timeout must be between 30 and 1800 seconds.\n' >&2
  exit 1
fi

deadline=$((SECONDS + timeout_seconds))
services=(valkey uwsgi celeryworker celerybeat nginx caddy)

while (( SECONDS < deadline )); do
  initializer_id="$(compose ps -aq initializer)"
  if [[ -n "${initializer_id}" ]]; then
    initializer_status="$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "${initializer_id}")"
    if [[ "${initializer_status}" == "exited:0" ]]; then
      all_healthy=true
      for service in "${services[@]}"; do
        container_id="$(compose ps -q "${service}")"
        if [[ -z "${container_id}" ]]; then
          all_healthy=false
          break
        fi
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
        if [[ "${health}" != "healthy" ]]; then
          all_healthy=false
          break
        fi
      done
      if [[ "${all_healthy}" == "true" ]]; then
        domain="$(read_public_env_value DEFECTDOJO_DOMAIN)"
        if curl \
          --fail \
          --silent \
          --show-error \
          --max-time 15 \
          --proto '=https' \
          --tlsv1.2 \
          "https://${domain}/healthz" >/dev/null; then
          printf 'DefectDojo is healthy through its public TLS endpoint.\n'
          exit 0
        fi
      fi
    elif [[ "${initializer_status}" == exited:* && "${initializer_status}" != "exited:0" ]]; then
      printf 'The DefectDojo initializer failed (%s).\n' "${initializer_status}" >&2
      compose logs --tail 100 initializer >&2
      exit 1
    fi
  fi
  sleep 5
done

printf 'DefectDojo did not become ready within %s seconds.\n' "${timeout_seconds}" >&2
compose ps >&2
exit 1
