# Metrics

Measure review usefulness rather than comment volume:

- accepted/edited/dismissed findings and time to resolution;
- true/false-positive feedback by category and severity;
- deterministic scan coverage, evidence completeness, and baseline age;
- review latency at p50/p95, bridge failure rate, and partial-review rate;
- input/output units and cost by administrative profile;
- PRs reviewed, repositories onboarded, enforced/report-only/advisory-only states;
- image digests with scan/SBOM/signature/deployment/DAST evidence;
- exact deployed digests that are protected, evidence-complete, or missing
  required evidence;
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
keeps review-value metrics separate from deterministic coverage metrics.
GuardianBot labels each source family with its completeness. The current
control-plane report uses `latest-reconciliation` for scanner, monitoring, and
image-protection values rather than pretending that current snapshots are an
event-complete weekly history. Review metrics are derived from retained
review findings, described below.

## Review value

Each retained finding can carry one outcome, kept beside its lifecycle state
rather than replacing it:

- `fixed`: on a verified incremental review, the finding was open, the
  incremental diff the model received rewrote or deleted at least one of its
  lines, and the model then stopped reporting it. A finding that disappears
  because its file was left out of the bounded bundle, or because the
  incremental base could not be verified, records nothing. If the finding
  later returns, the `fixed` outcome is withdrawn.
- `dismissed`: a repository writer ran `@guardianbot dismiss <id>`. This is
  the explicit negative signal. Thumbs-down reactions are not used because no
  subscribed event delivers them, and reply text is not used because it is
  dropped before storage.
- `ignored`: still open with no outcome when the pull request merged
  (`pull_request` `closed` with `merged: true`). Closing without merging
  records nothing.

Reviewer identity and reviewer text are never stored for any of these.

The weekly report reads at most 1000 retained review rows per repository
updated since the start of the UTC week. It counts outcomes by their own
timestamps, so a row touched for another reason does not recount old outcomes:

- `review.advisoryFindingsOpened`, `Accepted` (`fixed`), `Dismissed`, and
  `Resolved` are filled from that data.
- `reviewValue` gives `fixed`, `dismissed`, `ignored`, and `unresolved` (open,
  no outcome, observed this week) per category and per repository, and
  `precision = fixed / (fixed + dismissed)` with its `sampleSize`. Precision is
  `null` when the sample is zero.
- Category keys outside `^[a-z][a-z-]{0,31}$` are reported as `other`, and
  findings without a category as `uncategorized`.

`sourceCompleteness.review` is:

| Value | Meaning |
| --- | --- |
| `unavailable` | No retained review rows were read for any repository this week |
| `retained-findings` | Every repository read succeeded and none was truncated |
| `retained-findings-partial` | At least one repository read failed or hit the row cap |

`prsReviewed`, `deterministicBlockersOpened`, `bridgeFailures`,
`partialReviews`, latency, and cost stay `0` or empty because nothing records
them yet. Read them as unmeasured, not as zero. `ignored` is a weak signal: a
merged pull request can still carry a correct finding that nobody acted on.

Prometheus counters for the same signals are bare aggregates with no labels,
so no repository, category, or reviewer text reaches a label:

| Metric | Meaning |
| --- | --- |
| `guardianbot_finding_outcome_fixed_total` | Findings marked `fixed` |
| `guardianbot_finding_outcome_dismissed_total` | Findings recorded `dismissed` |
| `guardianbot_finding_outcome_ignored_total` | Findings recorded `ignored` at merge |
| `guardianbot_remediation_draft_created_total` | Mode C draft pull requests opened |
| `guardianbot_remediation_draft_rejected_total` | `draft-fix` refused by scope or validation |
| `guardianbot_remediation_draft_unavailable_total` | `draft-fix` with the flag off or no `contents: write` |

Image protection is counted from the latest reconciliation only when the
required scan, SBOM, signature, and deployment evidence agree on the exact
registry digest and configured environment. Missing samples are never
extrapolated; a zero has meaning only alongside its source-completeness label.

Metrics transport stays private by default. Public Caddy exposure returns `404`
for both `/metrics` and `GET /operations/monitoring`. Successful access to
either path requires `GUARDIANBOT_METRICS_BEARER_TOKEN` or an explicitly trusted
private-runtime override with `GUARDIANBOT_TRUST_PRIVATE_METRICS=1` on a
genuinely private Compose network. App Platform always requires the exact
bearer; unauthorized, non-`GET`, query-string, and trailing-slash variants of
the operations path return an empty `404`. The bearer lives only as a
DigitalOcean secret and local operator credential—never in repository docs or
committed config. Operators do not need broader database or SSH firewall
access; scrape or curl the control plane instead. Operator ledger shape and
field semantics are documented in
[operations](operations.md#private-metrics-and-operator-monitoring-status).

## Control-plane webhook queue gauges

`/metrics` refreshes webhook queue gauges from the shared store before
rendering so multi-instance scrapes stay database-true. If that store refresh
fails, the endpoint returns `503` rather than fabricating a zero backlog.

Queue gauges (no repository identifiers or secrets in labels):

| Metric | Meaning |
| --- | --- |
| `guardianbot_queue_depth` | Runnable backlog: pending jobs available now plus expired/reclaimable leases |
| `guardianbot_webhook_jobs_pending` | Jobs with status `pending` (includes not-yet-available retries) |
| `guardianbot_webhook_jobs_leased` | Jobs with status `leased` |
| `guardianbot_webhook_jobs_dead_letter` | Jobs with status `dead-letter` |
| `guardianbot_jobs_in_flight` | Process-local job currently being handled |

Related counters:

- `guardianbot_webhook_enqueued_total`, `guardianbot_webhook_claimed_total`
- `guardianbot_webhook_succeeded_total`, `guardianbot_webhook_failed_total`
- `guardianbot_webhook_dead_letter_total`
- `guardianbot_webhook_cleanup_deleted_total`, `guardianbot_webhook_cleanup_failures_total`
- `guardianbot_github_rate_limited_total`: deliveries requeued because GitHub
  reported a primary or secondary rate limit. These requeue at the reported
  reset instant and do not consume the delivery attempt budget, so a sustained
  rise here means slower reviews rather than dead-lettered work.
- `guardianbot_finding_reappeared_total`: findings that returned after being
  resolved or superseded. A rise indicates regressions reaching pull requests
  again, not a GuardianBot fault.

Rate-limit gauge:

| Metric | Meaning |
| --- | --- |
| `guardianbot_github_ratelimit_remaining` | Remaining GitHub request budget last reported by an API response |

This gauge is absent until GitHub reports a budget, so an unknown allowance is
never scraped as an exhausted one. Alert on it only once present.
