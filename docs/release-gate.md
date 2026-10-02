# Release gate

The release gate is a deterministic promotion decision for one exact release
candidate: repository, commit, image digest, and deployment environment. It
passes only when the digest is signed by the trusted image workflow, its
accepted image-promotion evidence is clean, and DefectDojo holds no active
release-blocking finding tied to that candidate. AI findings are never inputs
and can never block, waive, or approve a release.

The gate is opt-in. Repositories that do not call the reusable workflow, and
DigitalOcean profiles that do not set `requireReleaseGate`, behave exactly as
before.

## Candidate scope

A candidate is the tuple:

- the GitHub repository and its numeric repository ID;
- the default-branch commit that produced the image;
- the exact `sha256:` image digest; and
- the target environment, such as `staging`.

DefectDojo findings are read from the repository's product (its full name) and
the `<default-branch>/security`, `<default-branch>/image`, and
`<default-branch>/dast` engagements. Scope is then decided by the GuardianBot
tags on each finding's DefectDojo Test, not by product or engagement names
alone. Finding-level tags are ignored, because they are editable in DefectDojo
and must not move a finding out of scope:

1. the Test must carry `guardianbot:repo-id:<id>` for the candidate repository;
2. a Test with a `guardianbot:env:` tag is in scope only for that environment;
3. a Test with a `guardianbot:image:` tag is in scope only for that digest; and
4. any other Test is in scope only when its `guardianbot:commit:` tag is the
   candidate commit.

Findings on another product, another environment, an older digest, or another
commit are counted as out of scope and do not block.

The gate also requires that DefectDojo actually describes the candidate:

- at least one in-scope SAST (`security`) Test and one in-scope `image` Test,
  plus an in-scope `dast` Test when the policy requires `deployed-rescan`;
- GuardianBot reimports into one Test per engagement and scan type, and
  DefectDojo replaces a Test's tags on reimport. When every Test of a
  commit-scoped scan type now names another commit, the candidate's findings
  for that scan are unknown, so the gate fails with `defectdojo-scope-missing`
  instead of ignoring them. In practice the gate can pass only the commit most
  recently imported on the default branch; and
- Tests or findings with malformed IDs fail the gate as `gate-unavailable`.

## Decision

The gate fails with a named blocker code for each of these conditions:

| Code | Meaning |
| --- | --- |
| `unsigned-digest` | No accepted Cosign signature is bound to the exact digest. |
| `wrong-signer` | The signature identity is not the trusted `reusable-image.yml` at the trusted SHA. |
| `image-scan-missing` / `image-scan-critical` | No accepted Trivy image result, or it is not Critical-clean. |
| `sbom-missing` | No accepted CycloneDX SBOM for the same artifact. |
| `deployed-rescan-missing` / `deployed-rescan-failed` | Only when the policy requires `deployed-rescan`: no successful DAST summary for the digest in the environment. |
| `defectdojo-scope-missing` | No in-scope SAST or image import (or DAST, when a rescan is required) exists, or a commit-scoped scan was last reimported for another commit. |
| `release-blocking-finding` | An active, unmitigated in-scope finding at a blocking severity. |
| `risk-acceptance-invalid` | A risk-accepted finding whose acceptance is unnamed, expired, or does not cover it. |
| `gate-unavailable` | DefectDojo is unconfigured, unreachable, or returned an invalid response. |

By default only Critical findings block, and only verified findings are
considered. A finding with an unrecognized severity is labelled `unclassified`
and blocks. Signature, image scan, and SBOM evidence are always read from one
accepted image-promotion artifact of a default-branch `push` run.

The only exception path is a named DefectDojo risk acceptance with an
expiration date in the future, on a finding DefectDojo itself marks
`risk_accepted`. The acceptance decision must be accept (`A`) and its
`accepted_findings` list must include the finding. An acceptance history on a
finding that is no longer risk-accepted is ignored. Each
honoured acceptance is reported in the decision's `exceptions` list with its
name, ID, expiry, and finding reference. GuardianBot never creates or extends
risk acceptances.

Every failure path is closed: missing configuration, a missing or unreachable
DefectDojo, malformed evidence, or an unexpected response yields a failing or
unavailable result, never a pass.

## Running the gate from a repository

Call the reusable workflow from the repository's `.github/workflows/guardianbot.yml`
on `workflow_dispatch`, after the image-promotion `push` run for the same
default-branch commit has completed:

```yaml
on:
  workflow_dispatch:
    inputs:
      image-digest: { required: true, type: string }
      environment: { required: true, type: string, default: staging }

jobs:
  release-gate:
    uses: geekyshubham/guardianbot/.github/workflows/reusable-release-gate.yml@<40-character-release-sha>
    permissions:
      contents: read
      id-token: write
      packages: read
    with:
      image-name: ghcr.io/owner/repository
      image-digest: ${{ inputs.image-digest }}
      environment: ${{ inputs.environment }}
```

The reusable workflow:

1. runs only for `workflow_dispatch`, in the `guardianbot-release-gate`
   GitHub environment, on a GitHub-hosted runner;
2. validates the image name, digest, and environment inputs through
   environment variables only;
3. independently runs `cosign verify` against the exact certificate identity
   `https://github.com/<engine-repository>/.github/workflows/reusable-image.yml@<sha>`
   and the GitHub Actions OIDC issuer, and requires every verified signature to
   name the candidate digest;
4. obtains a GitHub OIDC token for the `guardianbot-release-gate` audience and
   posts the candidate to the control plane's `POST /release/gate`;
5. rejects any response that is not a 200 decision bound to the same
   repository ID, commit, digest, and environment, or a pass whose expected
   signer differs from the one it verified;
6. writes `decision.json` as the `guardianbot-release-gate-<run>-<attempt>`
   artifact and a sanitized job summary; and
7. fails the job unless the decision is `pass`.

`image-workflow-sha` defaults to the release gate workflow's own SHA. Set it
only when the repository pins `reusable-image.yml` to a different GuardianBot
release. The commit evaluated is the dispatch run's `GITHUB_SHA`, so dispatch
the gate from the same default-branch commit that built the image.

The repository receives no DefectDojo, DigitalOcean, model, or ticketing
credential. All of those stay in control-plane configuration.

## Control-plane endpoint

`POST /release/gate` accepts `application/json` with `schemaVersion`,
`repository`, `repositoryId`, `runId`, `runAttempt`, `headSha`, `imageDigest`,
and `environment`. It applies the same identity contract as the DAST broker,
with these values:

- OIDC audience `guardianbot-release-gate`;
- event `workflow_dispatch` only, on the repository's default branch;
- caller workflow `.github/workflows/guardianbot.yml` at the default branch;
- job workflow `reusable-release-gate.yml` from
  `GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY` at
  `GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA`; and
- environment and subject `guardianbot-release-gate`.

Both pass and fail decisions return HTTP 200 with `cache-control: no-store`, so
the workflow can always record the decision. Request, identity, repository, or
configuration errors return 400, 401, 403, or 503 and never a decision.

## Control-plane configuration

| Variable | Purpose |
| --- | --- |
| `GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA` | Exact trusted `reusable-release-gate.yml` SHA. Falls back to `GUARDIANBOT_TRUSTED_WORKFLOW_SHA`. |
| `GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA` | Existing variable; also defines the expected signer identity. |
| `GUARDIANBOT_RELEASE_GATE_POLICY_JSON` | Optional policy override; defaults shown below. |
| `GUARDIANBOT_DEFECTDOJO_BASE_URL_REF` / `GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF` | Existing DefectDojo references. Without them every decision fails as `gate-unavailable`. |

```json guardianbot-config=none
{
  "blockingSeverities": ["critical"],
  "blockHigh": false,
  "verifiedOnly": true,
  "requiredEvidence": ["signature", "image-scan", "sbom"]
}
```

`blockingSeverities` must include `critical`; `blockHigh: true` adds `high`.
`requiredEvidence` must include `signature` and may add `deployed-rescan`.
Unknown fields are rejected and leave the gate unconfigured (503).

## DigitalOcean promotion gate

A `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` profile may set
`"requireReleaseGate": true` (default `false`). The reconciler then evaluates
the same decision for the promotion candidate after image-reference validation
and before acquiring the deployment lease or calling DigitalOcean. A failing or
unavailable decision refuses the promotion with the blocker codes. Profiles
without the flag are unchanged. Do not require `deployed-rescan` for a gated
profile's first promotion: a rescan of a digest in an environment cannot exist
before that digest is deployed there, so such a policy refuses every new
digest.

## Operator steps

- Create the `guardianbot-release-gate` environment in each consumer
  repository, ideally with required reviewers.
- Set `GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA` (or rely on
  `GUARDIANBOT_TRUSTED_WORKFLOW_SHA`) on the control plane.
- Confirm the DefectDojo automation user can read products, engagements,
  tests, and findings (including each finding's embedded `accepted_risks`)
  for the GuardianBot Product Type.

`guardianctl` does not ship a local release check: the decision depends on
DefectDojo state, and operator machines do not hold DefectDojo credentials.

## Verification status

The evaluator, endpoint, store queries, DigitalOcean flag, and workflow
structure are covered by unit tests only. No live release gate run, live
DefectDojo risk-acceptance query, or gated DigitalOcean promotion has been
recorded. See [status](status.md) for what is verified live.
