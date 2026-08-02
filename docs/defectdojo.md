# DefectDojo

GuardianBot treats DefectDojo as a central evidence system hosted only on
DigitalOcean. Consumer repositories never receive DefectDojo credentials. The new
integration package lives at `packages/defectdojo` and is deliberately
provider-neutral with respect to the rest of GuardianBot: it resolves only
environment-variable references, performs deterministic upserts, and emits
normalized failures suitable for control-plane handling.

## What is implemented

- `resolveDefectDojoConfig(...)` loads an HTTPS base URL and API token by
  environment-variable reference name, not by embedding values in repository
  configuration.
- `DefectDojoClient` supports authenticated GET/POST/PATCH requests with timeout,
  idempotent request IDs, pagination, retries, exponential backoff, and
  `Retry-After` handling.
- Product type, product, and engagement upserts are deterministic and safe to
  replay. Engagement creation always supplies the target dates required by the
  DefectDojo API; an existing engagement keeps its original lifecycle dates.
- Test lookup is read-only. GuardianBot never manually creates an incomplete
  Test record: the first report uses DefectDojo's official `import-scan`
  endpoint, and only a discovered existing Test ID may use `reimport-scan`.
- Scan submission chooses `import-scan` or `reimport-scan` explicitly based on the
  discovered test identity instead of relying on ambiguous latest-test selection.
- The reusable DAST workflow emits one provenance-bound artifact containing
  both `zap.json` and `zap.xml`. The control plane normalizes findings from JSON
  and submits XML to DefectDojo's `ZAP Scan` parser. Legacy JSON-only artifacts
  remain valid evidence but do not claim a successful DefectDojo ZAP import.
- `buildDefectDojoTags(...)` and `buildImmutableScanIdentity(...)` create stable
  repository/run metadata for tagging and audit trails.
- Dry-run mode returns planned API mutations without contacting DefectDojo, which
  makes onboarding and contract tests safe.
- A production-oriented DefectDojo OSS 3.1.200 deployment definition now lives
  under [`infra/defectdojo`](../infra/defectdojo/README.md). It is limited to an
  x86_64 DigitalOcean Droplet plus a dedicated DigitalOcean Managed PostgreSQL
  18 cluster and pins every container to an immutable platform manifest.
- The deployment includes root-only secret generation, managed PostgreSQL
  `verify-full` TLS, Caddy TLS ingress, resource/security bounds, one-shot
  migrations, nightly consistent backups, release-bound safe restore, systemd
  units, and live diagnostics.

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

## Control-plane configuration

DefectDojo is disabled unless both reference variables are configured. Keep all
four values only in encrypted DigitalOcean control-plane configuration:

```text
GUARDIANBOT_DEFECTDOJO_BASE_URL_REF=GUARDIANBOT_DEFECTDOJO_BASE_URL
GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF=GUARDIANBOT_DEFECTDOJO_API_TOKEN
GUARDIANBOT_DEFECTDOJO_BASE_URL=https://defectdojo.example.com
GUARDIANBOT_DEFECTDOJO_API_TOKEN=CONTROL_PLANE_ONLY_TOKEN
```

The base URL must use HTTPS outside loopback development. The API token must
belong to a dedicated automation user with only the product hierarchy, test
lookup, import, and reimport permissions needed by GuardianBot.

This deployment is DefectDojo **OSS**. Scope the automation identity with the
OSS Product Type **Authorized Users** model (non-staff, non-superuser, no
configuration permissions, authorized only on the Product Type GuardianBot
uses). Do **not** claim a DefectDojo Pro **API Importer** role exists here; that
role is Pro-only and is not available on this stack. Consumer repositories never
receive the token. Rotation procedure:
[Operator runbook](../infra/defectdojo/RUNBOOK.md#oss-automation-token-rotation).

## Live conformance command

The checked-in `semgrep-empty.json` fixture contains no credentials or
repository source. After building the package, an operator can prove the actual
DefectDojo API contract with an isolated engagement:

```sh
export GUARDIANBOT_DEFECTDOJO_BASE_URL_REF=GUARDIANBOT_DEFECTDOJO_BASE_URL
export GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF=GUARDIANBOT_DEFECTDOJO_API_TOKEN
export GUARDIANBOT_DEFECTDOJO_BASE_URL=https://defectdojo.example.com
export GUARDIANBOT_DEFECTDOJO_API_TOKEN=CONTROL_PLANE_ONLY_TOKEN
npm run conformance:live --workspace @guardianbot/defectdojo -- \
  --run-id 20260727T120000Z \
  --confirm guardianbot-defectdojo-live-conformance
```

This is an explicit live mutation. It creates one uniquely named conformance
engagement, imports the fixture through `import-scan`, reimports it through
`reimport-scan`, and fails unless both operations return the same Test ID. Reuse
of a run ID is rejected so a stale Test cannot make a first-import check pass.
The command never prints the API token.

## Failure behavior

- Import and reimport failures are normalized into `DefectDojoError` values with
  `kind`, `status`, `retryable`, `requestId`, and sanitized details.
- API tokens are never logged or interpolated into errors.
- A required import failure should block only the deterministic evidence gate, not
  the AI advisory review path.
- Raw immutable workflow artifacts remain the replay source of truth.

## Verification status

The dedicated DigitalOcean deployment has passed its public HTTPS doctor,
managed PostgreSQL TLS check, consistent backup, and isolated live
import/reimport conformance run. RouteLens workflow evidence has also created
and reimported stable Semgrep and Trivy Test IDs. That workflow run exposed a
format mismatch in the DAST path: DefectDojo 3.1.200 requires XML for `ZAP Scan`,
while GuardianBot originally submitted ZAP JSON. v0.2.28 fixes the artifact and
ingestion contracts with regression coverage. Live XML reimport for AstraNull
current-binding full is independently verified (TestImport 862); RouteLens
current-binding full import remains open.

**Live automation identity (2026-08-02 UTC):** control-plane token cut over to
OSS least-privilege user ID 5 `guardianbot-importer-prod` (active true, staff
false, superuser false, no configuration permissions), authorized only on
Product Type ID 2 via OSS Authorized Users. Live mutation conformance under that
identity: Product 20, Engagement 28, import/reimport TestImports 878/879 on
stable Test ID 46. DigitalOcean env-only cutover ACTIVE deployment
`b4f8fda3-c103-4771-91af-2bc0efd24b73`. The old overprivileged token is no longer
deployed but has **not** been revoked, and the old superuser account has **not**
been deactivated—credential rotation is not fully closed. A destructive restore
drill and HA remain unverified. Overall DefectDojo acceptance remains partial
while RouteLens full import, failed-import alerting, restore/HA, and old-token
retirement stay open.

See [v0.2.27 live evidence](evidence/v0.2.27-defectdojo.md) for platform
resources and
[v0.2.40 least-privilege cutover](evidence/v0.2.40-defectdojo-least-privilege.md)
for the automation identity evidence.

Deployment and operations details:

- [DigitalOcean boundary](../infra/defectdojo/DIGITALOCEAN.md)
- [Operator runbook](../infra/defectdojo/RUNBOOK.md)
