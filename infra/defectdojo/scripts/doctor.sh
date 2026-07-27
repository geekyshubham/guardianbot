#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
"${SCRIPT_DIR}/preflight.sh"
"${SCRIPT_DIR}/wait-ready.sh" 120

compose exec -T uwsgi python3 manage.py check --deploy
compose exec -T uwsgi python3 manage.py shell --no-imports -c \
  "from django.db import connection; cursor = connection.cursor(); cursor.execute(\"select ssl from pg_stat_ssl where pid = pg_backend_pid()\"); assert cursor.fetchone() == (True,), \"PostgreSQL connection is not using TLS\""

domain="$(read_public_env_value DEFECTDOJO_DOMAIN)"
headers="$(curl \
  --fail \
  --silent \
  --show-error \
  --head \
  --max-time 15 \
  --proto '=https' \
  --tlsv1.2 \
  "https://${domain}/login")"
grep -qi '^strict-transport-security:' <<<"${headers}" || {
  printf 'The public endpoint is missing Strict-Transport-Security.\n' >&2
  exit 1
}
grep -qi '^x-content-type-options: nosniff' <<<"${headers}" || {
  printf 'The public endpoint is missing X-Content-Type-Options.\n' >&2
  exit 1
}

printf 'DefectDojo doctor passed: containers, HTTPS, Django deploy checks, and PostgreSQL TLS are healthy.\n'
