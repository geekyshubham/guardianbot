# Findings lifecycle

GuardianBot can track deterministic scanner findings over time: who owns each
one, how long it has been open, when its SLA is due, and whether it has
breached. The lifecycle is a control-plane feature and is off unless an
operator enables it (see [operations](operations.md#findings-lifecycle-and-sla)).
It never changes the security gate, caller workflows, or evidence acceptance.

## Trusted inputs

A lifecycle record changes only from scanner evidence the control plane has
already accepted:

- Semgrep and Trivy filesystem findings from a default-branch `push` or
  `schedule` run of the repository itself;
- Trivy image findings from image-validation or image-promotion evidence of
  such a run; and
- ZAP findings from DAST evidence whose validated scan status names the
  deployed digest and environment.

Pull-request evidence, fork evidence, manual dispatch runs, and AI review
findings are ignored. Records are keyed by the scanner's root-cause
fingerprint, so one root cause is one record regardless of how often it is
reported.

## Streams and fixes

Each scanner forms a stream: `semgrep`, `trivy-fs`, `trivy-image`, and
`zap:<smoke|nightly>:<environment>`. A finding is fixed when a later complete
scan of every stream that reported it no longer reports it. A stream is
incomplete when its scanner reported an error, ZAP exited with a failure code,
or more than 500 unique findings were reported; an incomplete scan can open or
refresh findings but never fixes one. Each stream keeps a run watermark, so a
delayed retry of an older run cannot reopen or fix what a newer run decided.

A fixed finding that returns starts a new episode: `firstSeenAt` is kept, and
`openedAt` and the SLA due date restart.

## Status and suppression

Status is `open`, `fixed`, `suppressed`, or `risk-accepted`. Suppressions use
the same rules as the security gate: an entry in `scanners.suppressions` with
a matching fingerprint and an unexpired `expiresAt` is active. An active
suppression whose reason begins `risk accepted` (or `risk-accepted`) maps to
`risk-accepted`; any other active suppression maps to `suppressed`. When it
expires, the finding is `open` again.

## Ownership

Owners come from the repository's indexed default-branch commit:

1. the last matching `findings.ownership.rules` entry;
2. the owners of the last matching CODEOWNERS rule;
3. `findings.ownership.serviceOwner` for image and DAST findings, which have no
   repository path; otherwise
4. the explicit owner `unowned`.

If the index or configuration is unavailable, previously resolved owners are
kept. See [repository configuration](repository-configuration.md#finding-ownership-and-tickets).

## SLA

SLA days per severity live in control-plane environment
(`GUARDIANBOT_FINDINGS_SLA_JSON`, default critical 7 days and high 30 days).
Severities without an entry are tracked but not aged against an SLA or
ticketed. Monitoring raises `findings-sla` when an open finding is past its due
date and adds a deterministic `findings` section to the weekly report with
counts by status, severity, owner, and age bucket. Advisory AI metrics stay in
their own section.

## Tickets and notifications

All providers are optional and configured only in the control plane:

- **GitHub issues**: one issue per root cause, recovered idempotently through a
  hidden `guardianbot-finding:<fingerprint>` marker. Only issues this GitHub App
  opened are trusted: `performed_via_github_app.id` equals `GITHUB_APP_ID`, or
  the author is the App's own `<slug>[bot]` account. The App id and slug come
  from `GET /app` with the App JWT and must match `GITHUB_APP_ID`, or ticketing
  fails closed. A marker on any other issue (a human's, or another App's or
  bot's) is ignored and counted. Requires `findings.githubIssues: true` in the
  repository and is never used on public repositories.
- **Jira**: one issue per root cause, found again through a per-fingerprint
  label with the enhanced `/rest/api/2/search/jql` endpoint (the legacy
  `/rest/api/2/search` is being removed by Atlassian). Searches are bounded by
  project and label, follow `nextPageToken`, and stop after a fixed page cap.
  Issues move into the done category on close.
- **Slack-compatible webhook**: a notification when a finding opens, breaches,
  or closes.

Ticket content is bounded scanner metadata only: source, rule, severity,
location, owner, status, and lifecycle dates. Scanner titles and descriptions
are never copied. Failures are retried, stored as a sanitized error kind, and
raised as `findings-ticketing`; they never fail scanner acceptance. See the
[SLA breach runbook](runbooks/sla-breach.md).

Ticket work is chosen and claimed under the per-repository lifecycle lock, the
lock is released, and only then are providers called, so a slow provider never
stalls scanner merges. Each claim is a lease (10 minutes). A result is recorded
only while its claim still holds, and recording the ticket and clearing the
claim is one atomic write, so a pass whose lease expired and was taken over can
never overwrite the newer result. Scanner merges never write ticket state.

## Record bound

Each repository keeps at most 5000 lifecycle records. When a merge exceeds the
bound, long-fixed records without an open ticket are retired first; that is
routine and not alerted. Anything still over the bound is dropped, spending
non-open and low-severity records first and open Critical or High findings only
when nothing else is left. Drops are recorded on the repository and raise the
`findings-capacity` monitoring check: failing when an open Critical or High
finding was dropped, warning for any other drop. The same check warns when a
GitHub marker scan ignored issues this App did not open.
