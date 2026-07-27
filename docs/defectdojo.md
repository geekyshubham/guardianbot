# DefectDojo

GuardianBot treats DefectDojo as a central evidence system hosted only on
DigitalOcean. Consumer repositories never receive DefectDojo credentials. The new
integration package lives at `packages/defectdojo` and is deliberately
provider-neutral with respect to the rest of GuardianBot: it resolves only
environment-variable references, performs deterministic upserts, and emits
normalized failures suitable for control-plane handling.

## What is implemented

- `resolveDefectDojoConfig(...)` loads `DEFECTDOJO_URL` and `DEFECTDOJO_API_TOKEN`
  by reference name, not by embedding values in repository configuration.
- `DefectDojoClient` supports authenticated GET/POST/PATCH requests with timeout,
  idempotent request IDs, pagination, retries, exponential backoff, and
  `Retry-After` handling.
- Product type, product, engagement, and test discovery/upsert flows are
  deterministic and safe to replay.
- Scan submission chooses `import-scan` or `reimport-scan` explicitly based on the
  discovered test identity instead of relying on ambiguous latest-test selection.
- `buildDefectDojoTags(...)` and `buildImmutableScanIdentity(...)` create stable
  repository/run metadata for tagging and audit trails.
- Dry-run mode returns planned API mutations without contacting DefectDojo, which
  makes onboarding and contract tests safe.

## Mapping model

For this PoC, keep one product per GitHub repository:

- Product type: `GitHub Repositories`
- Product: repository slug such as `Geekyshubham/guardianbot`
- Engagement: branch plus scan profile such as `main:nightly` or `main:pr`
- Test: scanner plus logical title such as `Semgrep JSON Report / main/nightly`

Tags should remain immutable per scan run and include at least:

- repository ID and slug
- repository visibility
- branch
- scan profile
- workflow run and attempt
- commit SHA
- optional staging environment
- optional image digest

## Import policy

Reimport the same logical test whenever a matching test already exists inside the
engagement. This keeps DefectDojo history intact, lets absent findings close
normally, and preserves native deduplication behavior. Create a fresh test only
when the engagement/scan/title tuple has not been seen before.

GuardianBot fingerprints remain useful for local policy and suppression handling,
but DefectDojo ownership stays tied to scanner-native imports, tests, and import
history.

## Failure behavior

- Import and reimport failures are normalized into `DefectDojoError` values with
  `kind`, `status`, `retryable`, `requestId`, and sanitized details.
- API tokens are never logged or interpolated into errors.
- A required import failure should block only the deterministic evidence gate, not
  the AI advisory review path.
- Raw immutable workflow artifacts remain the replay source of truth.

## Current limitation

This package is implemented and covered with mocked HTTP tests, but the control
plane still needs to wire it into workflow-report ingestion and scheduled
reconciliation before `docs/status.md` can claim full production coverage.
