#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

OUTPUT_FILE="/etc/guardianbot/defectdojo.env"
DATABASE_PORT="25060"
DATABASE_NAME="defectdojo"
DATABASE_USER="defectdojo"
ADMIN_USER="guardianadmin"

usage() {
  cat <<'EOF'
Usage:
  sudo ./scripts/generate-env.sh \
    --domain defectdojo.example.com \
    --acme-email operator@example.com \
    --admin-email operator@example.com \
    --database-host private-example.db.ondigitalocean.com \
    --database-password-file /root/defectdojo-db-password \
    [--database-port 25060] \
    [--database-name defectdojo] \
    [--database-user defectdojo] \
    [--admin-user guardianadmin]

The output path is fixed at /etc/guardianbot/defectdojo.env. The script refuses
to overwrite an existing file and never prints generated or supplied secrets.
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "${value}" ]] || fail "${option} requires a value."
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --domain)
      require_value "$1" "${2:-}"
      DOMAIN="$2"
      shift 2
      ;;
    --acme-email)
      require_value "$1" "${2:-}"
      ACME_EMAIL="$2"
      shift 2
      ;;
    --admin-email)
      require_value "$1" "${2:-}"
      ADMIN_EMAIL="$2"
      shift 2
      ;;
    --database-host)
      require_value "$1" "${2:-}"
      DATABASE_HOST="$2"
      shift 2
      ;;
    --database-password-file)
      require_value "$1" "${2:-}"
      DATABASE_PASSWORD_FILE="$2"
      shift 2
      ;;
    --database-port)
      require_value "$1" "${2:-}"
      DATABASE_PORT="$2"
      shift 2
      ;;
    --database-name)
      require_value "$1" "${2:-}"
      DATABASE_NAME="$2"
      shift 2
      ;;
    --database-user)
      require_value "$1" "${2:-}"
      DATABASE_USER="$2"
      shift 2
      ;;
    --admin-user)
      require_value "$1" "${2:-}"
      ADMIN_USER="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || fail "This command must run as root."
[[ ! -e "${OUTPUT_FILE}" ]] || fail "${OUTPUT_FILE} already exists; refusing to overwrite it."
[[ "${DOMAIN:-}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
  || fail "The domain is not a valid lowercase DNS name."
[[ "${DATABASE_HOST:-}" == *.db.ondigitalocean.com ]] \
  || fail "The database host must be a DigitalOcean managed PostgreSQL hostname."
if [[ ! "${DATABASE_PORT}" =~ ^[0-9]{1,5}$ ]] \
  || (( 10#${DATABASE_PORT} < 1 || 10#${DATABASE_PORT} > 65535 )); then
  fail "The database port is invalid."
fi
[[ "${DATABASE_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]] \
  || fail "The database name contains unsupported characters."
[[ "${DATABASE_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]] \
  || fail "The database user contains unsupported characters."
[[ "${ADMIN_USER}" =~ ^[A-Za-z_][A-Za-z0-9_.@+-]{0,149}$ ]] \
  || fail "The admin user contains unsupported characters."
[[ "${ACME_EMAIL:-}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
  || fail "The ACME email address is invalid."
[[ "${ADMIN_EMAIL:-}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
  || fail "The admin email address is invalid."
[[ -f "${DATABASE_PASSWORD_FILE:-}" && ! -L "${DATABASE_PASSWORD_FILE}" ]] \
  || fail "The database password file must be a regular, non-symlink file."

password_mode="$(stat -c '%a' "${DATABASE_PASSWORD_FILE}")"
password_owner="$(stat -c '%u' "${DATABASE_PASSWORD_FILE}")"
[[ "${password_owner}" == "0" ]] || fail "The database password file must be owned by root."
[[ "${password_mode}" == "600" || "${password_mode}" == "400" ]] \
  || fail "The database password file must have mode 0600 or 0400."

IFS= read -r database_password < "${DATABASE_PASSWORD_FILE}" \
  || fail "The database password file is empty."
[[ "${#database_password}" -ge 24 ]] || fail "The database password must be at least 24 characters."
[[ "${#database_password}" -le 256 ]] || fail "The database password is unexpectedly long."
[[ "${database_password}" != *"'"* && "${database_password}" != *$'\r'* ]] \
  || fail "The database password contains a character unsupported by the Compose env format."
if [[ "$(awk 'END { print NR }' "${DATABASE_PASSWORD_FILE}")" -ne 1 ]]; then
  fail "The database password file must contain exactly one line."
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}
require_command openssl
require_command install
require_command mktemp

secret_key="$(openssl rand -hex 64)"
credential_key="$(openssl rand -hex 32)"
admin_password="$(openssl rand -hex 32)"
jira_webhook_secret="$(openssl rand -hex 32)"
temporary_file="$(mktemp)"
trap 'rm -f -- "${temporary_file}"' EXIT

{
  printf 'COMPOSE_PROJECT_NAME=guardianbot-defectdojo\n'
  printf 'DEFECTDOJO_DOMAIN=%s\n' "${DOMAIN}"
  printf 'CADDY_ACME_EMAIL=%s\n' "${ACME_EMAIL}"
  printf 'DD_DATABASE_HOST=%s\n' "${DATABASE_HOST}"
  printf 'DD_DATABASE_PORT=%s\n' "${DATABASE_PORT}"
  printf 'DD_DATABASE_NAME=%s\n' "${DATABASE_NAME}"
  printf 'DD_DATABASE_USER=%s\n' "${DATABASE_USER}"
  printf "DD_DATABASE_PASSWORD='%s'\n" "${database_password}"
  printf "DD_SECRET_KEY='%s'\n" "${secret_key}"
  printf "DD_CREDENTIAL_AES_256_KEY='%s'\n" "${credential_key}"
  printf 'DD_ADMIN_USER=%s\n' "${ADMIN_USER}"
  printf 'DD_ADMIN_MAIL=%s\n' "${ADMIN_EMAIL}"
  printf 'DD_ADMIN_FIRST_NAME=GuardianBot\n'
  printf 'DD_ADMIN_LAST_NAME=Operator\n'
  printf "DD_ADMIN_PASSWORD='%s'\n" "${admin_password}"
  printf "DD_JIRA_WEBHOOK_SECRET='%s'\n" "${jira_webhook_secret}"
} > "${temporary_file}"

install -d -m 0700 -o root -g root "$(dirname -- "${OUTPUT_FILE}")"
install -m 0600 -o root -g root "${temporary_file}" "${OUTPUT_FILE}"

unset database_password secret_key credential_key admin_password jira_webhook_secret
printf 'Created %s with owner root and mode 0600. Secret values were not printed.\n' "${OUTPUT_FILE}"
printf 'Store the initial admin password from that file in an approved password manager before first login.\n'
