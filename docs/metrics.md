# Metrics

Measure review usefulness rather than comment volume:

- accepted/edited/dismissed findings and time to resolution;
- true/false-positive feedback by category and severity;
- deterministic scan coverage, evidence completeness, and baseline age;
- review latency at p50/p95, bridge failure rate, and partial-review rate;
- input/output units and cost by administrative profile;
- PRs reviewed, repositories onboarded, enforced/report-only/advisory-only states;
- image digests with scan/SBOM/signature/deployment/DAST evidence;
- expired suppressions, missing scheduled runs, and import reconciliation lag.

Reports must separate AI advisory value from deterministic gate value and public
from private repository data. Never export repository text in metric labels.

## Monitoring model

GuardianBot monitoring should publish deterministic repository snapshots, not
best-effort dashboards. Each snapshot evaluates:

- expected workflow runs versus the latest observed PR, push, and scheduled runs;
- repository-index freshness and optional commit drift;
- required evidence freshness for imports, scans, SBOMs, signatures, and deployments;
- suppression expiry with explicit owner/ticket accountability;
- repository inventory state as one of `enforced`, `report-only`,
  `advisory-only`, `not-applicable`, `misconfigured`, or
  `missing-expected-runs`.

Weekly value reporting aggregates those snapshots across at most seven days and
keeps review-value metrics separate from deterministic coverage metrics. Missing
samples stay zero-valued rather than extrapolated.

Metrics transport stays private by default. Public Caddy exposure returns `404`
for `/metrics`; successful access requires
`GUARDIANBOT_METRICS_BEARER_TOKEN` or an explicitly trusted private-runtime
override with `GUARDIANBOT_TRUST_PRIVATE_METRICS=1`.
