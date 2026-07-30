# Onboarding repositories

App installation creates a repository record keyed by GitHub repository ID,
inspects the default branch read-only, and opens an onboarding issue. Scanner
coverage remains `not configured`.

`guardianctl onboard OWNER/REPOSITORY` detects Python, Node, Swift, Ruby,
lockfiles, Dockerfiles, OpenAPI, CODEOWNERS, test commands, health endpoints, and
PostgreSQL/Redis hints. It validates and writes only:

- `.guardianbot/config.yml`
- `.guardianbot/onboarding.md`
- `.github/workflows/guardianbot.yml`

It creates one draft PR. The workflow calls GuardianBot at an immutable commit.
No scanner implementation or infrastructure credential enters the repository.

For a known staging contract, operators may supply reusable declarative overrides:
`--dockerfile`, `--health-path`, `--readiness-path`, `--image-promotion`,
`--dast-origin`, `--openapi`, `--auth-profile`, and `--session-path`. GuardianBot
validates that the Dockerfile exists, requires configured image deployment for
`--image-promotion` (`enforce-only` or `verified-default-branch`), and requires
the complete DAST tuple; none of these flags accepts a secret.

Lifecycle commands:

```sh
guardianctl doctor OWNER/REPOSITORY
guardianctl enforce OWNER/REPOSITORY
guardianctl upgrade OWNER/REPOSITORY
guardianctl inventory
guardianctl offboard OWNER/REPOSITORY
```

`upgrade` applies the same validated image and DAST overrides to an
already-onboarded repository. It opens one generated PR containing the
configuration and caller changes:

```sh
guardianctl upgrade OWNER/REPOSITORY \
  --image-promotion verified-default-branch \
  --dast-origin https://staging.example.com \
  --openapi /openapi.json \
  --auth-profile control-plane://profiles/example-staging \
  --session-path /api/protected
```

All four DAST options are required together. Partial profiles are rejected, and
no credential or backend URL is written to the consumer repository.
`--image-promotion verified-default-branch` is the explicit opt-in that lets a
report-only Docker repository render default-branch push intent; Critical-clean
eligibility remains enforced inside the reusable image workflow.

`doctor` validates:

- operator repository access and GuardianBot App access when the operator token can
  observe GitHub App installations;
- the configuration schema, repository/default-branch contract, and immutable
  configuration and reusable-workflow pins;
- the complete generated caller against image configuration, including manual
  caller drift when the release pin itself has not changed;
- optional image paths/runtime fields and the exact-origin DAST contract;
- a fresh successful default-branch push, scheduled, or manually dispatched run
  (36 hours by default) and the actual `guardianbot/security-gate` evidence from
  the most recent fresh run that emitted the gate (Actions job metadata, or a
  check-run URL bound to that run id—not an unrelated same-SHA check). A later
  DAST-only schedule that omits or skips the gate is ignored for security-gate
  readiness. A later push or manual dispatch with a missing or skipped gate
  fails closed and cannot reuse an older success. A scheduled run that actually
  emits a non-skipped failed gate also fails closed;
- a reviewed `.guardianbot/baseline.json`, the first successful report-only
  default-branch push or `workflow_dispatch` whose exact run has a present,
  non-skipped, successful security gate (scheduled runs never start the
  seven-day clock), and the elapsed observation period;
- active rulesets or classic branch protection requiring the exact observed gate
  check when scanner mode is `enforce`.

App installation endpoints are not visible to every GitHub token. In that case
`doctor` reports the App check as `unobservable` without treating it as proof of
absence; normal repository access is still verified. An observable missing or
suspended installation is a failure for a configured repository.

## Baseline and enforcement

After report-only observation is complete, open a baseline draft PR from a
successful local `gate.json` artifact produced by the current reusable security
workflow:

```bash
guardianctl baseline OWNER/REPOSITORY --from-gate path/to/gate.json
```

The command requires App access, a healthy current configuration, report-only
scanner mode, a fresh successful security gate, and the completed minimum
observation period. The gate artifact must include repository, head SHA, run ID,
and run attempt provenance bound to that latest doctor-observed run; older gate
artifacts without those fields fail with an upgrade/rerun message. It never
switches scanner mode, never changes rulesets, and never merges. Use `--dry-run`
to render the baseline document without writes.

The baseline is committed separately and reviewed like source code. Preferred
form is the versioned object produced by `guardianctl baseline`. `generatedAt` is
only the generation timestamp; human review evidence is the pull request's review
and merge. `source.runId` / `source.headSha` must match the doctor-observed
security-gate evidence run (not a later DAST-only schedule on the same commit):

```json guardianbot-config=none
{
  "schemaVersion": "guardianbot.baseline.v1",
  "fingerprints": [
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ],
  "generatedAt": "2026-07-27T06:00:00.000Z",
  "source": {
    "gateSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "mode": "report-only",
    "repository": "acme/service",
    "headSha": "cccccccccccccccccccccccccccccccccccccccc",
    "runId": 200,
    "runAttempt": 1
  }
}
```

Legacy non-empty arrays and `{ "fingerprints": [...] }` documents remain accepted.
An empty fingerprint list is accepted only for the versioned object with a
canonical RFC3339 UTC `generatedAt` and valid source
`gateSha256` / `mode` / `repository` / `headSha` / `runId` / `runAttempt`; empty
legacy baselines are rejected. Duplicate, malformed, or missing baseline documents
are not ready for enforcement. The seven-day clock starts at the first successful
default-branch push or `workflow_dispatch` after the current report-only
configuration was committed whose exact run has a present, non-skipped,
successful security gate—not when an onboarding PR was opened, not from a
missing/skipped/failed gate, and not from any scheduled run (including a
security-bearing schedule). Onboarding normally starts the clock via the merge
push that lands the generated caller.

`doctor.status: ready` means the repository is healthy in its current mode.
`doctor.enforcementReady` separately indicates that the baseline and observation
prerequisites are complete. `guardianctl enforce` fails closed unless every
promotion prerequisite passes. It then creates or repairs the strict required-check
ruleset using the check name GitHub actually emitted and opens a draft PR changing
scanner mode from `report-only` to `enforce`. Pull-request checks remain
report-only because they bind the base-branch configuration; merge only after
ordinary checks and human review. Immediately after merge, verify the first
enforce-mode default-branch gate and revert or disable enforcement if it fails.

The defaults can be tightened for an installation with
`GUARDIANBOT_EXPECTED_RUN_MAX_AGE_HOURS` and
`GUARDIANBOT_REPORT_ONLY_MINIMUM_DAYS`. Both must be positive numbers, and the
minimum observation period cannot be configured below seven days.

## Inventory and upgrades

`inventory` may run without `GUARDIANBOT_WORKFLOW_SHA`. In that mode it still
validates immutable config/caller pins, internal caller consistency, config-to-
caller pin match, and the usual drift/schema/run/evidence checks, deriving the
expected pin from each repository rather than treating the CLI all-zero
placeholder as a target. Supplying a published SHA additionally flags
repositories whose pins are behind that target. `upgrade` and `upgrade --all`
still require an explicit published SHA.

`inventory` paginates all operator-owned repositories and emits one of:

- `enforced`: enforce mode, fresh successful evidence, and the exact strict
  required check;
- `report-only`: healthy report-only execution, whether or not promotion
  prerequisites have matured;
- `advisory-only`: App/advisory coverage without a repository scanner gate;
- `not-applicable`: an archived repository, a fork, or an observably uninstalled
  repository with no caller/configuration;
- `misconfigured`: partial files, invalid configuration, caller/pin drift, failed
  evidence, missing App access where observable, or invalid enforce protection;
- `missing-expected-runs`: the expected run or gate check is absent or stale.

`upgrade` requires a 40-character lowercase commit SHA and regenerates drifted
callers even when their existing pin already equals that SHA. `upgrade --all`
paginates the repository inventory, skips archives and forks, and reports
per-repository failures without stopping the remaining upgrades.

## Offboarding

`offboard --dry-run` returns the validated removal plan. The applied command opens
a draft PR deleting only:

- `.guardianbot/config.yml`
- `.github/workflows/guardianbot.yml`

It deliberately retains `.guardianbot/onboarding.md`,
`.guardianbot/baseline.json`, GitHub Actions artifacts, control-plane records,
installation events, and other App audit evidence. It refuses to delete an
unrecognized configuration or workflow at a managed path.

Immediately before merging the offboarding PR, remove the GuardianBot
required-check rule; deleting the caller means that check will no longer be
emitted. After the PR merges, remove repository access from the GitHub App. These
external actions are reported in the plan but the CLI does not perform them, so it
never deletes App audit evidence as a side effect.
