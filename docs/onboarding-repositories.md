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
  (36 hours by default) and the actual `guardianbot/security-gate` check GitHub
  attached to that commit;
- a reviewed `.guardianbot/baseline.json`, the first successful report-only run,
  and the elapsed observation period;
- active rulesets or classic branch protection requiring the exact observed gate
  check when scanner mode is `enforce`.

App installation endpoints are not visible to every GitHub token. In that case
`doctor` reports the App check as `unobservable` without treating it as proof of
absence; normal repository access is still verified. An observable missing or
suspended installation is a failure for a configured repository.

## Baseline and enforcement

The baseline is committed separately and reviewed like source code. It is either a
JSON array of lowercase SHA-256 fingerprints or an object with a `fingerprints`
array:

```json
{
  "fingerprints": [
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

Empty, duplicate, malformed, or missing baseline fingerprints are not ready for
enforcement. The seven-day clock starts at the first successful default-branch
GuardianBot run after the current report-only configuration was committed, not
when an onboarding PR was opened.

`doctor.status: ready` means the repository is healthy in its current mode.
`doctor.enforcementReady` separately indicates that the baseline and observation
prerequisites are complete. `guardianctl enforce` fails closed unless every
promotion prerequisite passes. It then creates or repairs the strict required-check
ruleset using the check name GitHub actually emitted and opens a draft PR changing
scanner mode from `report-only` to `enforce`. Merge only after that PR's
enforcement-mode check succeeds.

The defaults can be tightened for an installation with
`GUARDIANBOT_EXPECTED_RUN_MAX_AGE_HOURS` and
`GUARDIANBOT_REPORT_ONLY_MINIMUM_DAYS`. Both must be positive numbers, and the
minimum observation period cannot be configured below seven days.

## Inventory and upgrades

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
