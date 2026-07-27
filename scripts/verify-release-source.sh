#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

required_environment=(
  GH_TOKEN
  RELEASE_DEFAULT_BRANCH
  RELEASE_REF
  RELEASE_REPOSITORY
  RELEASE_SHA
  RELEASE_TAG
)
for environment_name in "${required_environment[@]}"; do
  if [[ -z "${!environment_name:-}" ]]; then
    echo "${environment_name} is required" >&2
    exit 1
  fi
done

[[ "${RELEASE_REPOSITORY}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "release repository has an invalid format"
[[ "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "release commit has an invalid format"
[[ "${RELEASE_TAG}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] ||
  fail "release tag has an invalid format"
[[ "${RELEASE_REF}" == "refs/tags/${RELEASE_TAG}" ]] ||
  fail "release ref does not match the release tag"
[[ "${RELEASE_DEFAULT_BRANCH}" != *$'\n'* ]] ||
  fail "default branch contains a line break"
[[ "${RELEASE_DEFAULT_BRANCH}" != *$'\r'* ]] ||
  fail "default branch contains a line break"

checkout_sha="$(git rev-parse HEAD)"
[[ "${checkout_sha}" == "${RELEASE_SHA}" ]] ||
  fail "checked-out commit does not match the release event"

remote_ref_record="$(
  gh api \
    "repos/${RELEASE_REPOSITORY}/git/ref/tags/${RELEASE_TAG}" \
    --jq '[.ref, .object.type, .object.sha] | @tsv'
)"
IFS=$'\t' read -r remote_ref remote_ref_type remote_tag_object_sha \
  <<<"${remote_ref_record}"
[[ "${remote_ref}" == "${RELEASE_REF}" ]] ||
  fail "remote tag ref does not match the release event"
[[ "${remote_ref_type}" == "tag" ]] ||
  fail "remote release ref is not an annotated tag"
[[ "${remote_tag_object_sha}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "remote annotated tag object has an invalid identifier"

remote_tag_record="$(
  gh api \
    "repos/${RELEASE_REPOSITORY}/git/tags/${remote_tag_object_sha}" \
    --jq '[.tag, .object.type, .object.sha] | @tsv'
)"
IFS=$'\t' read -r remote_tag remote_target_type remote_target_sha \
  <<<"${remote_tag_record}"
[[ "${remote_tag}" == "${RELEASE_TAG}" ]] ||
  fail "remote annotated tag name does not match the release event"
[[ "${remote_target_type}" == "commit" ]] ||
  fail "remote annotated tag does not target a commit"
[[ "${remote_target_sha}" == "${RELEASE_SHA}" ]] ||
  fail "remote annotated tag does not target the release commit"

repository_owner="${RELEASE_REPOSITORY%%/*}"
repository_name="${RELEASE_REPOSITORY#*/}"
default_branch_record="$(
  gh api graphql \
    -f query='
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
              }
            }
          }
        }
      }
    ' \
    -f "owner=${repository_owner}" \
    -f "name=${repository_name}" \
    --jq '
      [
        .data.repository.defaultBranchRef.name,
        .data.repository.defaultBranchRef.target.oid
      ] | @tsv
    '
)"
IFS=$'\t' read -r remote_default_branch default_branch_sha \
  <<<"${default_branch_record}"
[[ "${remote_default_branch}" == "${RELEASE_DEFAULT_BRANCH}" ]] ||
  fail "release event default branch is stale"
[[ "${default_branch_sha}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "remote default branch commit has an invalid identifier"

compare_status="$(
  gh api \
    "repos/${RELEASE_REPOSITORY}/compare/${RELEASE_SHA}...${default_branch_sha}" \
    --jq '.status'
)"
[[ "${compare_status}" == "identical" || "${compare_status}" == "ahead" ]] ||
  fail "release commit is not reachable from the current default branch"
