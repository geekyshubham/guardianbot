# Roadmap

## Verified PoC

Automated evidence currently covers protocol and strict bridge validation,
including real HTTP loopback model-bridge conformance and fail-closed
request/output validation; repository detection/config generation; Tree-sitter/
text indexing; lifecycle CLI commands including provenance-bound
`guardianctl baseline` draft creation after the seven-day report-only gate;
GitHub App webhook behavior with authoritative pending/leased/dead-letter/
runnable queue metrics and bounded terminal retention/cleanup; full-class
Semgrep/Trivy policy; trusted evidence ingestion; image/SBOM/signature
contracts; one-time DAST sessions; distinct smoke/nightly ZAP evidence; durable
monitoring; exact signed/deployed digest reconciliation; and signed
DigitalOcean deployment scripts.

## Live PoC verification

- Publish the next immutable release under `Geekyshubham/guardianbot`.
- Deploy that exact signed release to the existing DigitalOcean control plane.
- Create/configure/install the Geekyshubham GitHub App after explicit operator
  confirmation.
- Onboard fresh Python, Node, Swift, Ruby, Docker, and documentation fixtures.
- Create isolated RouteLens and AstraNull staging on DigitalOcean only.
- Run RouteLens and AstraNull image/signing/deployment/DAST pipelines and retain
  evidence.
- Deploy dedicated DefectDojo on DigitalOcean and exercise import, reimport,
  backup, and recovery.
- Verify the continuous scheduler, weekly report, alert delivery, and repository
  discovery against every selected installation repository.
- Complete scheduled authenticated-full nightly DAST evidence.
- Configure a production model credential and verify live AI-backed review.
- Complete seven-day report-only observation and live enforcement promotion.

## Production work

Durable pgvector retrieval and production-scale history; independently scaled
worker queues; complete fingerprint resolution/supersession presentation;
inline GitHub suggestions and feedback analytics; related-repository approval
workflow; HA and disaster recovery; rate limits and load tests; audit export;
secret-rotation and incident drills; and a defined release rollback SLO.
