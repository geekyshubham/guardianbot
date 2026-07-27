#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-digitalocean-app-platform.sh APP_ID RELEASE_ASSET_DIRECTORY

The release directory must contain the canonical GuardianBot release assets,
including release-manifest.json and release-manifest.sigstore.json.
The script verifies the signed release, updates only GuardianBot service image
digests in the existing DigitalOcean App Platform spec, waits, and probes health.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

app_id="${1:-}"
release_directory="${2:-}"
if [[ -z "$app_id" || -z "$release_directory" || "${3:-}" != "" ]]; then
  usage
  exit 1
fi
[[ "$app_id" =~ ^[0-9a-f-]{36}$ ]] || die "APP_ID is not a UUID"
[[ -d "$release_directory" ]] || die "release asset directory does not exist"

require_command cosign
require_command curl
require_command doctl
require_command gh
require_command jq
require_command node

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest_path="$(cd "$release_directory" && pwd)/release-manifest.json"
manifest_bundle="$(cd "$release_directory" && pwd)/release-manifest.sigstore.json"
[[ -f "$manifest_path" ]] || die "release-manifest.json is missing"
[[ -f "$manifest_bundle" ]] || die "release-manifest.sigstore.json is missing"

release_tag="$(jq -er '.source.tag' "$manifest_path")"
release_sha="$(jq -er '.source.commit' "$manifest_path")"
release_repository="$(jq -er '.source.repository' "$manifest_path")"
release_ref="$(jq -er '.source.ref' "$manifest_path")"
release_image="$(jq -er '.image.name' "$manifest_path")"
release_digest="$(jq -er '.image.digest' "$manifest_path")"
release_reference="$(jq -er '.image.reference' "$manifest_path")"
workflow_identity="$(jq -er '.builder.workflowIdentity' "$manifest_path")"
expected_workflow_identity="$(
  printf 'https://github.com/%s/.github/workflows/release.yml@%s' \
    "$release_repository" "$release_ref"
)"

[[ "$release_repository" == "geekyshubham/guardianbot" ]] ||
  die "release repository is not Geekyshubham/guardianbot"
[[ "$release_image" == "ghcr.io/geekyshubham/guardianbot" ]] ||
  die "release image is not the canonical GuardianBot image"
[[ "$release_reference" == "${release_image}@${release_digest}" ]] ||
  die "release reference is inconsistent"
[[ "$release_ref" == "refs/tags/${release_tag}" ]] ||
  die "release ref is inconsistent"
[[ "$workflow_identity" == "$expected_workflow_identity" ]] ||
  die "release workflow identity is inconsistent"

(
  cd "$repository_root"
  RELEASE_ASSET_DIRECTORY="$(dirname "$manifest_path")" \
    node scripts/release-evidence.mjs verify-assets >/dev/null
  RELEASE_MANIFEST_PATH="$manifest_path" \
  RELEASE_TAG="$release_tag" \
  RELEASE_SHA="$release_sha" \
  RELEASE_REPOSITORY="$release_repository" \
  RELEASE_DIGEST="$release_digest" \
    node scripts/release-evidence.mjs verify-manifest >/dev/null
)
cosign verify-blob "$manifest_path" \
  --bundle "$manifest_bundle" \
  --certificate-identity "$workflow_identity" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  >/dev/null
cosign verify "$release_reference" \
  --certificate-identity "$workflow_identity" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  >/dev/null
cosign verify-attestation "$release_reference" \
  --type cyclonedx \
  --certificate-identity "$workflow_identity" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  >/dev/null
gh attestation verify "oci://${release_reference}" \
  --repo "$release_repository" \
  --bundle-from-oci \
  --cert-identity "$workflow_identity" \
  --cert-oidc-issuer "https://token.actions.githubusercontent.com" \
  --source-digest "$release_sha" \
  --source-ref "$release_ref" \
  --deny-self-hosted-runners \
  >/dev/null

temporary_directory="$(mktemp -d)"
spec_path="${temporary_directory}/app-spec.json"
updated_spec_path="${temporary_directory}/app-spec.updated.json"
app_state_path="${temporary_directory}/app-state.json"
deployed_spec_path="${temporary_directory}/deployed-spec.json"
cleanup() {
  rm -f "$spec_path" "$updated_spec_path" "$app_state_path" "$deployed_spec_path"
  rmdir "$temporary_directory" 2>/dev/null || true
}
trap cleanup EXIT
chmod 700 "$temporary_directory"

doctl apps spec get "$app_id" --format json >"$spec_path"
chmod 600 "$spec_path"
[[ "$(jq -er '.name' "$spec_path")" == "guardianbot-prod" ]] ||
  die "APP_ID does not resolve to the canonical guardianbot-prod app"
component_count="$(
  jq '[.services[]? | select(.name == "control-plane" or .name == "model-bridge")] | length' \
    "$spec_path"
)"
control_plane_count="$(
  jq '[.services[]? | select(.name == "control-plane")] | length' "$spec_path"
)"
[[ "$control_plane_count" == "1" ]] ||
  die "App spec must contain exactly one control-plane service"
[[ "$component_count" -ge 1 && "$component_count" -le 2 ]] ||
  die "App spec has an invalid GuardianBot service set"
jq -e '
  all(
    .services[]? |
      select(.name == "control-plane" or .name == "model-bridge");
    .image.registry_type == "GHCR" and
    (.image.registry | ascii_downcase) == "geekyshubham" and
    (.image.repository | ascii_downcase) == "guardianbot"
  )
' "$spec_path" >/dev/null || die "App spec contains an unexpected GuardianBot image source"

jq --arg digest "$release_digest" '
  .services |= map(
    if .name == "control-plane" or .name == "model-bridge"
    then .image.digest = $digest | del(.image.tag)
    else .
    end
  )
' "$spec_path" >"$updated_spec_path"
chmod 600 "$updated_spec_path"

doctl apps update "$app_id" --spec "$updated_spec_path" --wait >/dev/null

doctl apps get "$app_id" --output json >"$app_state_path"
chmod 600 "$app_state_path"
active_deployment="$(jq -er '.[0].active_deployment.id' "$app_state_path")"
[[ "$active_deployment" =~ ^[0-9a-f-]{36}$ ]] ||
  die "DigitalOcean did not report an active deployment"
[[ "$(jq -er '.[0].id' "$app_state_path")" == "$app_id" ]] ||
  die "DigitalOcean returned an unexpected app record"
default_ingress="$(jq -er '.[0].default_ingress' "$app_state_path")"
[[ "$default_ingress" == https://* ]] ||
  die "DigitalOcean did not report an HTTPS ingress"

doctl apps spec get "$app_id" \
  --deployment "$active_deployment" \
  --format json >"$deployed_spec_path"
chmod 600 "$deployed_spec_path"
jq -e --arg digest "$release_digest" '
  .name == "guardianbot-prod" and
  ([.services[]? | select(.name == "control-plane")] | length) == 1 and
  all(
    .services[]? |
      select(.name == "control-plane" or .name == "model-bridge");
    .image.registry_type == "GHCR" and
    (.image.registry | ascii_downcase) == "geekyshubham" and
    (.image.repository | ascii_downcase) == "guardianbot" and
    .image.digest == $digest and
    (.image | has("tag") | not)
  )
' "$deployed_spec_path" >/dev/null ||
  die "active deployment does not use the verified GuardianBot digest"

curl --fail --silent --show-error \
  --retry 8 \
  --retry-all-errors \
  --retry-delay 5 \
  "${default_ingress%/}/healthz" >/dev/null
curl --fail --silent --show-error \
  --retry 8 \
  --retry-all-errors \
  --retry-delay 5 \
  "${default_ingress%/}/readyz" >/dev/null

printf 'deployed %s as DigitalOcean deployment %s\n' \
  "$release_reference" "$active_deployment"
