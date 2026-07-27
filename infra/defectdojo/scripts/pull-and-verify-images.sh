#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
"${SCRIPT_DIR}/preflight.sh"

images=(
  "defectdojo/defectdojo-django:3.1.200@sha256:b2b7b00ef0d53b6a7dd0b12ed2f645bef42263aeef674144bddead2d78cf65ad"
  "defectdojo/defectdojo-nginx:3.1.200@sha256:322fc39b1dfcdb78a3bcbdc9b3b413e4e74b8853ff8ca484922289f58d3e1468"
  "valkey/valkey:9.1.0-alpine@sha256:a35428eba9043cc0b79dbe54100f0c92784f2de00ad09b01182bfb1c5c83d1bd"
  "caddy:2.11.4-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a"
  "postgres:18.4-alpine@sha256:1b1689b20d16a014a3d195653381cf2caa75a41a92d93b255a9d6ea29fd353aa"
)

compose --profile operator pull

for image in "${images[@]}"; do
  architecture="$(docker image inspect --format '{{.Architecture}}' "${image}")"
  [[ "${architecture}" == "amd64" ]] || {
    printf 'Image resolved to unexpected architecture: %s\n' "${image}" >&2
    exit 1
  }
done

printf 'All immutable release images are present and resolve to linux/amd64.\n'
