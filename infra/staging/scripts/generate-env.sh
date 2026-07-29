#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 OUTPUT_FILE ROUTELENS_HOST ASTRANULL_HOST" >&2
  exit 64
fi

output_file=$1
routelens_host=$2
astranull_host=$3

host_pattern='^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
if [[ ! $routelens_host =~ $host_pattern || ! $astranull_host =~ $host_pattern ]]; then
  echo "staging hosts must be lowercase DNS names" >&2
  exit 65
fi

umask 077
temporary_file=$(mktemp "${output_file}.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT

{
  printf 'ROUTELENS_HOST=%s\n' "$routelens_host"
  printf 'ASTRANULL_HOST=%s\n' "$astranull_host"
  printf 'ROUTELENS_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'ROUTELENS_DJANGO_SECRET_KEY=%s\n' "$(openssl rand -hex 48)"
  printf 'ROUTELENS_EMAIL_HOST_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'ASTRANULL_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'ASTRANULL_SECRET_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'ASTRANULL_PROBE_WORKER_SECRET=%s\n' "$(openssl rand -hex 32)"
} >"$temporary_file"

install -m 600 "$temporary_file" "$output_file"
echo "Wrote root-only staging environment to $output_file"
