#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
require_command docker
require_command openssl
require_command stat
require_command ufw
verify_stack_definition installed

[[ "$(uname -m)" == "x86_64" ]] || {
  printf 'This release is pinned to linux/amd64 and requires an x86_64 host.\n' >&2
  exit 1
}

[[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || {
  printf 'Missing regular environment file: %s\n' "${ENV_FILE}" >&2
  exit 1
}
[[ "$(stat -c '%u:%a' "${ENV_FILE}")" == "0:600" ]] || {
  printf '%s must be owned by root with mode 0600.\n' "${ENV_FILE}" >&2
  exit 1
}

allowed_keys=(
  COMPOSE_PROJECT_NAME
  CADDY_ACME_EMAIL
  DD_ADMIN_FIRST_NAME
  DD_ADMIN_LAST_NAME
  DD_ADMIN_MAIL
  DD_ADMIN_PASSWORD
  DD_ADMIN_USER
  DD_CREDENTIAL_AES_256_KEY
  DD_DATABASE_HOST
  DD_DATABASE_NAME
  DD_DATABASE_PASSWORD
  DD_DATABASE_PORT
  DD_DATABASE_USER
  DD_JIRA_WEBHOOK_SECRET
  DD_SECRET_KEY
  DEFECTDOJO_DOMAIN
)

for key in "${allowed_keys[@]}"; do
  count="$(grep -c "^${key}=." "${ENV_FILE}" || true)"
  [[ "${count}" == "1" ]] || {
    printf '%s must contain exactly one non-empty %s entry.\n' "${ENV_FILE}" "${key}" >&2
    exit 1
  }
done

while IFS='=' read -r key _; do
  [[ -n "${key}" ]] || {
    printf '%s contains an empty or malformed entry.\n' "${ENV_FILE}" >&2
    exit 1
  }
  allowed=false
  for allowed_key in "${allowed_keys[@]}"; do
    if [[ "${key}" == "${allowed_key}" ]]; then
      allowed=true
      break
    fi
  done
  [[ "${allowed}" == "true" ]] || {
    printf '%s contains an unsupported or malformed key.\n' "${ENV_FILE}" >&2
    exit 1
  }
done < "${ENV_FILE}"

if grep -q '^DD_DATABASE_URL=' "${ENV_FILE}"; then
  printf 'DD_DATABASE_URL is prohibited; use component settings with libpq TLS enforcement.\n' >&2
  exit 1
fi
if grep -q 'replace-with-' "${ENV_FILE}"; then
  printf '%s still contains documentation placeholder values.\n' "${ENV_FILE}" >&2
  exit 1
fi

project_name="$(read_public_env_value COMPOSE_PROJECT_NAME)"
[[ "${project_name}" == "guardianbot-defectdojo" ]] || {
  printf 'COMPOSE_PROJECT_NAME must remain guardianbot-defectdojo.\n' >&2
  exit 1
}

database_host="$(read_public_env_value DD_DATABASE_HOST)"
[[ "${database_host}" == *.db.ondigitalocean.com ]] || {
  printf 'DD_DATABASE_HOST must reference DigitalOcean managed PostgreSQL.\n' >&2
  exit 1
}

domain="$(read_public_env_value DEFECTDOJO_DOMAIN)"
[[ "${domain}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || {
  printf 'DEFECTDOJO_DOMAIN is invalid.\n' >&2
  exit 1
}

database_port="$(read_public_env_value DD_DATABASE_PORT)"
if [[ ! "${database_port}" =~ ^[0-9]{1,5}$ ]] \
  || (( 10#${database_port} < 1 || 10#${database_port} > 65535 )); then
  printf 'DD_DATABASE_PORT is invalid.\n' >&2
  exit 1
fi

[[ -f "${CA_FILE}" && ! -L "${CA_FILE}" ]] || {
  printf 'Missing regular DigitalOcean PostgreSQL CA file: %s\n' "${CA_FILE}" >&2
  exit 1
}
[[ "$(stat -c '%u' "${CA_FILE}")" == "0" ]] || {
  printf '%s must be owned by root.\n' "${CA_FILE}" >&2
  exit 1
}
ca_mode="$(stat -c '%a' "${CA_FILE}")"
if (( (8#${ca_mode} & 8#022) != 0 )); then
  printf '%s must not be writable by group or other users.\n' "${CA_FILE}" >&2
  exit 1
fi
openssl x509 -in "${CA_FILE}" -noout -checkend 604800 >/dev/null || {
  printf 'The DigitalOcean PostgreSQL CA is invalid or expires within seven days.\n' >&2
  exit 1
}

docker compose version >/dev/null
compose config --quiet

if compose config --services | grep -qx postgres; then
  printf 'A local PostgreSQL service is prohibited for this deployment.\n' >&2
  exit 1
fi

ufw_status="$(LC_ALL=C ufw status)"
grep -Eq '^Status:[[:space:]]+active$' <<<"${ufw_status}" || {
  printf 'UFW must be active before DefectDojo starts.\n' >&2
  exit 1
}
for public_rule in 443/tcp 443/udp; do
  grep -Eq "^${public_rule}[[:space:]]+ALLOW[[:space:]]+Anywhere" \
    <<<"${ufw_status}" || {
    printf 'UFW must explicitly allow %s; DigitalOcean Cloud Firewall must match it.\n' \
      "${public_rule}" >&2
    exit 1
  }
done

printf 'DefectDojo preflight passed without exposing secret values.\n'
