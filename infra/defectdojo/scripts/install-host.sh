#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SOURCE_SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_STACK_DIR="$(dirname -- "${SOURCE_SCRIPT_DIR}")"
INSTALL_DIR="/opt/guardianbot-defectdojo"
START_STACK=false

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

install -d -m 0755 -o root -g root "${INSTALL_DIR}"
install -d -m 0755 -o root -g root "${INSTALL_DIR}/scripts"
install -m 0644 -o root -g root "${SOURCE_STACK_DIR}/compose.yml" "${INSTALL_DIR}/compose.yml"
install -m 0644 -o root -g root "${SOURCE_STACK_DIR}/Caddyfile" "${INSTALL_DIR}/Caddyfile"
install -m 0644 -o root -g root "${SOURCE_STACK_DIR}/release-manifest.json" "${INSTALL_DIR}/release-manifest.json"
for script in "${SOURCE_STACK_DIR}"/scripts/*.sh; do
  install -m 0755 -o root -g root "${script}" "${INSTALL_DIR}/scripts/$(basename -- "${script}")"
done
install -m 0755 -o root -g root \
  "${SOURCE_STACK_DIR}/scripts/restore-volume.py" \
  "${INSTALL_DIR}/scripts/restore-volume.py"

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
systemctl daemon-reload

printf 'Installed immutable DefectDojo definitions in %s.\n' "${INSTALL_DIR}"
printf 'Existing environment and CA files in /etc/guardianbot were not changed.\n'

if [[ "${START_STACK}" == "true" ]]; then
  "${INSTALL_DIR}/scripts/preflight.sh"
  systemctl enable --now guardianbot-defectdojo.service
  systemctl enable --now guardianbot-defectdojo-backup.timer
  "${INSTALL_DIR}/scripts/doctor.sh"
else
  printf 'Run preflight, then enable the service and backup timer after DNS and firewall setup.\n'
fi
