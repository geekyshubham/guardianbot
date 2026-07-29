#!/usr/bin/env bash
set -euo pipefail

root_dir=${1:-/opt/guardianbot-staging}
environment_file=${2:-/etc/guardianbot/staging.env}
compose_file="$root_dir/compose.yml"

set -a
# shellcheck disable=SC1090
source "$environment_file"
set +a

compose=(docker compose --env-file "$environment_file" -f "$compose_file")

for service in routelens-postgres routelens-redis routelens astranull-postgres astranull caddy; do
  container_id=$("${compose[@]}" ps -q "$service")
  if [[ -z $container_id ]]; then
    echo "$service is not running" >&2
    exit 1
  fi
done

for attempt in $(seq 1 45); do
  route_health=$(curl --fail --silent --show-error "https://${ROUTELENS_HOST}/api/v1/health/" || true)
  astra_health=$(curl --fail --silent --show-error "https://${ASTRANULL_HOST}/health" || true)
  astra_ready=$(curl --fail --silent --show-error "https://${ASTRANULL_HOST}/ready" || true)
  if [[ $route_health == *'"status":"healthy"'* && -n $astra_health && -n $astra_ready ]]; then
    echo "RouteLens and AstraNull staging are healthy"
    exit 0
  fi
  sleep 4
done

echo "staging health verification timed out" >&2
"${compose[@]}" ps >&2
exit 1
