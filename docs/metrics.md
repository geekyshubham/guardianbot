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
