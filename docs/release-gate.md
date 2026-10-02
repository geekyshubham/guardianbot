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
`<default-branch>/dast` engagements. Deployed-digest rescans import into a
separate `<default-branch>/image-rescan` engagement that the gate does not
read; their result reaches the gate through control-plane evidence instead. Scope is then decided by the GuardianBot
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

- at least one in-scope SAST (`security`) Test and one in-scope `image` Test.
  DAST Tests are never required: they describe digests already deployed;
- GuardianBot reimports into one Test per engagement and scan type, and
  DefectDojo replaces a Test's tags on reimport. When every Test of a
  commit-scoped scan type now names a newer commit, DefectDojo no longer
  describes the candidate. The gate then accepts the candidate commit's own
  accepted scan summary in its place, and otherwise fails with
  `defectdojo-scope-missing`:
  - a Semgrep or filesystem Trivy Test is proven by the matching
    `semgrep-summary` or `trivy-summary` of the newest accepted default-branch
    `push` security artifact for the candidate commit. The summary must be a
    successful scan with release severity counts, which count every distinct
    finding at the higher of its policy and native severity, and must be zero
    at every blocking severity. Summaries recorded before this change carry no
    counts and never prove anything;
  - an `image` Trivy Test is proven by the candidate's own Critical-clean image
    scan, only while the policy blocks Critical alone, because the image scan
    reports Critical findings only; and
  - these counts ignore DefectDojo triage, so they can only be stricter than
    DefectDojo. A proven scan is listed as `commit-scan` evidence; and
- Tests or findings with malformed IDs fail the gate as `gate-unavailable`.

## Decision

The gate fails with a named blocker code for each of these conditions:

| Code | Meaning |
| --- | --- |
| `unsigned-digest` | No accepted Cosign signature is bound to the exact digest. |
| `wrong-signer` | The signature identity is not the trusted `reusable-image.yml` at the trusted SHA. |
| `image-scan-missing` / `image-scan-critical` | No accepted Trivy image result, or it is not Critical-clean. |
| `sbom-missing` | No accepted CycloneDX SBOM for the same artifact. |
| `promotion-frozen` | Always enforced: the newest verified scheduled rescan of the candidate digest, in any environment, found Critical findings or has no clean freeze record. |
| `deployed-rescan-missing` / `deployed-rescan-failed` | Only when the policy requires `deployed-rescan`: the digest GuardianBot last deployed in the candidate environment has no verified rescan within 48 hours, or its rescan was not fully reconciled (DefectDojo import pending) or has a malformed count. Nothing deployed yet is not a blocker. |
| `defectdojo-scope-missing` | No in-scope SAST or image import exists, or a commit-scoped scan was last reimported for another commit and no clean summary of the candidate commit stands in for it. |
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
`requiredEvidence` must include `signature` and may add `deployed-rescan`,
which requires current rescan coverage of whatever is already running in the
candidate environment. A freeze on that running digest does not block a
different candidate, since promoting a Critical-clean replacement is how a
freeze is fixed.
Unknown fields are rejected and leave the gate unconfigured (503).

## DigitalOcean promotion gate

A `GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON` profile may set
`"requireReleaseGate": true` (default `false`). The reconciler then evaluates
the same decision for the promotion candidate after image-reference validation
and before acquiring the deployment lease or calling DigitalOcean. A failing or
unavailable decision refuses the promotion with the blocker codes. Profiles
without the flag skip the gate, but every profile still refuses a frozen
digest (see [image security](image-security.md#deployed-digest-rescan)).
`deployed-rescan` is safe to require for a gated profile: it checks the digest
already deployed, and the first promotion into an empty environment has
nothing to rescan.

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

The evaluator, endpoint, store queries, DigitalOcean flag, freeze
enforcement, and workflow structure are covered by unit tests, and the new
store queries by the real-PostgreSQL parity suite, only. No live release gate run, live
DefectDojo risk-acceptance query, or gated DigitalOcean promotion has been
recorded. See [status](status.md) for what is verified live.
