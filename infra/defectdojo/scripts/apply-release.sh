#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
"${SCRIPT_DIR}/preflight.sh"

printf 'Creating the required pre-upgrade backup.\n'
"${SCRIPT_DIR}/backup.sh" --retention-days 14
"${SCRIPT_DIR}/pull-and-verify-images.sh"

printf 'Stopping write paths before migrations.\n'
compose stop -t 90 caddy nginx celerybeat celeryworker uwsgi

compose up --no-deps --force-recreate initializer
compose up -d --remove-orphans
"${SCRIPT_DIR}/wait-ready.sh" 900
"${SCRIPT_DIR}/doctor.sh"

printf 'Applied and verified the immutable release in release-manifest.json.\n'
