#!/usr/bin/env bash
set -euo pipefail

root_dir=${1:-/opt/guardianbot-staging}
environment_file=${2:-/etc/guardianbot/staging.env}
compose_file="$root_dir/compose.yml"

if [[ ! -r $environment_file ]]; then
  echo "missing staging environment: $environment_file" >&2
  exit 66
fi

compose=(docker compose --env-file "$environment_file" -f "$compose_file")

"${compose[@]}" config --quiet
"${compose[@]}" pull caddy routelens-postgres routelens-redis astranull-postgres
"${compose[@]}" up -d routelens-postgres routelens-redis astranull-postgres

"${compose[@]}" run --rm --no-deps routelens python manage.py migrate --noinput
"${compose[@]}" run --rm --no-deps astranull node scripts/migrate-postgres.mjs

"${compose[@]}" up -d --remove-orphans
"$root_dir/scripts/doctor.sh" "$root_dir" "$environment_file"
