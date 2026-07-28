#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SOURCE_SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_STACK_DIR="$(dirname -- "${SOURCE_SCRIPT_DIR}")"
INSTALL_DIR="/opt/guardianbot-defectdojo"
START_STACK=false

# shellcheck source=lib.sh
source "${SOURCE_SCRIPT_DIR}/lib.sh"

if [[ "${1:-}" == "--start" && "$#" -eq 1 ]]; then
  START_STACK=true
elif [[ "$#" -ne 0 ]]; then
  printf 'Usage: sudo %s [--start]\n' "$0" >&2
  exit 1
fi

[[ "${EUID}" -eq 0 ]] || {
  printf 'This command must run as root.\n' >&2
  exit 1
}
[[ "$(uname -m)" == "x86_64" ]] || {
  printf 'This immutable release requires an x86_64 DigitalOcean Droplet.\n' >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf 'Docker Engine is required.\n' >&2
  exit 1
}
docker compose version >/dev/null
command -v systemctl >/dev/null 2>&1 || {
  printf 'systemd is required.\n' >&2
  exit 1
}
require_command git
require_command jq
require_command sha256sum

verify_stack_definition source
source_commit="$(jq -er '.guardianbotSource.commit' "${RELEASE_MANIFEST}")"
if [[ "${source_commit}" == '$Format:%H$' ]]; then
  repository_root="$(git -C "${SOURCE_STACK_DIR}" rev-parse --show-toplevel)"
  source_commit="$(git -C "${repository_root}" rev-parse HEAD)"
  [[ "${source_commit}" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'Could not resolve an exact GuardianBot source commit.\n' >&2
    exit 1
  }
  relative_stack="${SOURCE_STACK_DIR#"${repository_root}/"}"
  [[ "${relative_stack}" != "${SOURCE_STACK_DIR}" ]] || {
    printf 'DefectDojo source is not inside the resolved GuardianBot repository.\n' >&2
    exit 1
  }
  if [[ -n "$(git -C "${repository_root}" status --porcelain=v1 --untracked-files=all -- "${relative_stack}")" ]]; then
    printf 'DefectDojo source differs from GuardianBot commit %s; refusing installation.\n' "${source_commit}" >&2
    exit 1
  fi
fi
[[ "${source_commit}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Release manifest does not resolve to an exact GuardianBot source commit.\n' >&2
  exit 1
}

resolved_manifest="$(mktemp)"
cleanup() {
  rm -f -- "${resolved_manifest}"
}
trap cleanup EXIT
jq --arg commit "${source_commit}" \
  '.guardianbotSource.commit = $commit' \
  "${RELEASE_MANIFEST}" >"${resolved_manifest}"
chmod 0600 "${resolved_manifest}"

install -d -m 0755 -o root -g root "${INSTALL_DIR}"
install -d -m 0755 -o root -g root "${INSTALL_DIR}/scripts"
install -d -m 0755 -o root -g root "${INSTALL_DIR}/systemd"
install -m 0644 -o root -g root "${SOURCE_STACK_DIR}/compose.yml" "${INSTALL_DIR}/compose.yml"
install -m 0644 -o root -g root "${SOURCE_STACK_DIR}/Caddyfile" "${INSTALL_DIR}/Caddyfile"
install -m 0644 -o root -g root "${SOURCE_STACK_DIR}/cloud-init.yml" "${INSTALL_DIR}/cloud-init.yml"
install -m 0644 -o root -g root "${resolved_manifest}" "${INSTALL_DIR}/release-manifest.json"
for relative_path in "${STACK_DEFINITION_FILES[@]}"; do
  [[ "${relative_path}" == scripts/*.sh ]] || continue
  install -m 0755 -o root -g root \
    "${SOURCE_STACK_DIR}/${relative_path}" \
    "${INSTALL_DIR}/${relative_path}"
done
install -m 0755 -o root -g root \
  "${SOURCE_STACK_DIR}/scripts/restore-volume.py" \
  "${INSTALL_DIR}/scripts/restore-volume.py"
for relative_path in "${STACK_DEFINITION_FILES[@]}"; do
  [[ "${relative_path}" == systemd/* ]] || continue
  install -m 0644 -o root -g root \
    "${SOURCE_STACK_DIR}/${relative_path}" \
    "${INSTALL_DIR}/${relative_path}"
done

install -d -m 0700 -o root -g root /etc/guardianbot
install -d -m 0700 -o root -g root /var/backups/guardianbot/defectdojo
install -m 0644 -o root -g root \
  "${SOURCE_STACK_DIR}/systemd/guardianbot-defectdojo.service" \
  /etc/systemd/system/guardianbot-defectdojo.service
install -m 0644 -o root -g root \
  "${SOURCE_STACK_DIR}/systemd/guardianbot-defectdojo-backup.service" \
  /etc/systemd/system/guardianbot-defectdojo-backup.service
install -m 0644 -o root -g root \
  "${SOURCE_STACK_DIR}/systemd/guardianbot-defectdojo-backup.timer" \
  /etc/systemd/system/guardianbot-defectdojo-backup.timer
"${INSTALL_DIR}/scripts/verify-stack-definition.sh"
systemctl daemon-reload
trap - EXIT
cleanup

printf 'Installed immutable DefectDojo definitions from GuardianBot commit %s in %s.\n' \
  "${source_commit}" "${INSTALL_DIR}"
printf 'Existing environment and CA files in /etc/guardianbot were not changed.\n'

if [[ "${START_STACK}" == "true" ]]; then
  "${INSTALL_DIR}/scripts/preflight.sh"
  systemctl enable --now guardianbot-defectdojo.service
  systemctl enable --now guardianbot-defectdojo-backup.timer
  "${INSTALL_DIR}/scripts/doctor.sh"
else
  printf 'Run preflight, then enable the service and backup timer after DNS and firewall setup.\n'
fi
