# Security model

GuardianBot protects GitHub installation credentials, repository contents,
review evidence, model-backend credentials, scanner artifacts, signing
identity, DigitalOcean deployment authority, DAST sessions, DefectDojo
evidence, and PostgreSQL state.

## Trust boundaries

### GitHub App and webhooks

GitHub App tokens are installation-scoped and short-lived. Incoming webhooks
require HMAC SHA-256 verification, a bounded body, a unique delivery ID, and
durable replay protection. The App has read-only Actions/Contents access and
read/write Issues/Pull requests access; repository Administration remains an
operator action in `guardianctl`.

Scanner evidence is accepted only after the control plane verifies the GitHub
workflow run, repository, commit, event, run attempt, GitHub-hosted runner,
caller workflow, exact reusable-workflow SHA, artifact digest, and signed
attestation. Consumer repositories cannot substitute their own evidence
directory or symlink.

### Repository content and isolation

Repository files, diffs, issues, commit messages, generated files, scanner
output, OpenAPI documents, and documentation are untrusted data. They cannot
select a backend URL, credential, provider, model ID, tool, DigitalOcean app, or
DAST origin.

Every index and review is labeled by numeric repository ID, visibility, and
commit. Related-repository retrieval requires a bilateral administrative
allowlist. Private or internal context never flows into a public review. Review
context is size bounded and the model sees only the selected commit-scoped
bundle.

### Model bridge

The control plane speaks only `guardian.review.v1`; provider details live
behind the isolated bridge. Models receive no tools, GitHub access, control
plane token, backend credential, or arbitrary network capability from
GuardianBot. Repository context is explicitly delimited as untrusted data.

The Responses adapter requests native strict Structured Outputs with
`tools: []` and `store: false`. `store: false` is not represented as zero
retention: the bridge advertises `retention: none` only after an administrator
asserts that Zero Data Retention is actually approved and configured.

Every result must match the canonical schema and pass independent request ID,
head SHA, file, changed-line, evidence, severity, count, fingerprint, and
duplicate validation. Refusals, malformed or oversized bodies, stale results,
timeouts, and unavailable backends become advisory `AI review unavailable`.
They never weaken deterministic checks.

### Image deployment and DAST

Image promotion is bound to a registry digest, GitHub OIDC workflow identity,
CycloneDX SBOM, signature, and provenance. DigitalOcean deployment authority
exists only in central allowlist profiles. The reconciler can update only the
configured App Platform app, named services, and GHCR image source, then must
observe the same active digest and successful health/readiness probes.

DAST requires an exact public HTTPS origin, a safe repository or same-origin
OpenAPI document, a protected environment, and a one-time OIDC-bound session.
The broker also requires accepted deployment evidence for the same current
default-branch SHA, administratively selected DigitalOcean environment, exact
origin, and immutable image digest. Scheduled/manual DAST is rejected until
that evidence exists; push-triggered DAST is prohibited to avoid a
pre-promotion race.
The normal broker mode exchanges a central secret at a same-origin target
endpoint for a short-lived credential. Static credentials require an explicit
PoC-only switch. The workflow proves protected access fails without the
credential before testing authenticated routes, removes all mutating OpenAPI
operations, and records the deployed digest in trusted evidence.

Production, localhost, link-local, private-address, cross-origin, redirected,
destructive, and explicitly excluded routes are prohibited.

### Data stores and networks

PostgreSQL, DefectDojo, and optional staging dependencies remain on
DigitalOcean. Managed PostgreSQL uses its CA through
`GUARDIANBOT_DATABASE_CA_CERT`; private Compose PostgreSQL is not exposed
publicly. Public `/metrics` and `/operations/monitoring` access is closed by
default: the public Caddy edge returns `404` for both paths, and App Platform
requires the exact metrics bearer. Private Compose may trust the private
network only when `GUARDIANBOT_TRUST_PRIVATE_METRICS=1` is set deliberately.
Neither private path requires opening direct database or SSH firewall access
to operators. The operations endpoint is read-only and returns only a
sanitized, bounded alert page plus process-local scheduler state and the
current UTC-week report or `null`—never config, evidence payloads, index
contents, credentials, digests, webhook payloads, resolved rows, or raw
provider text.

Consumer repositories contain no model, DefectDojo, database, DigitalOcean,
DAST, evidence-signing, or GitHub App secret. Repository configuration contains
only opaque profile references.

## Threats and failure isolation

Primary threats include prompt injection in code, malicious pull-request
workflows, webhook forgery or replay, cross-repository leakage, compromised
bridge output, evidence substitution/deletion, artifact path attacks, mutable
image tags, DigitalOcean target confusion, session replay, staging-to-production
confusion, and supply-chain identity movement.

The principal failure-isolation rules are:

- AI output is always advisory.
- Scanner crashes, invalid baselines, missing artifacts, missing imports, or
  identity mismatches fail deterministic evidence.
- A model-backend outage does not block deterministic security jobs.
- A DAST or deployment profile authorizes exactly one repository/target
  relationship.
- Scheduled findings may freeze future promotion but do not interrupt a running
  workload.
- Removing App access stops new control-plane actions without deleting retained
  audit evidence.

Residual PoC limitations and live-verification gaps are tracked in
[capability status](status.md). Production operation additionally requires
tested secret rotation, backups/restores, rate limits, audit export, dependency
patching, alert delivery, and incident drills.

## Reviewer feedback retention

Reviewer engagement with a published advisory is personal data, so only a
derived signal is retained: that a human replied to a specific advisory, and
when. Capture requires the `pull_request_review_comment` event. Until an
operator applies that event from the App manifest, nothing is delivered and
nothing is retained.

Against each retained finding, inside the existing review record, GuardianBot
keeps a count of observed human replies, the first and last observation
timestamps, and a bounded ring of the GitHub review-comment identifiers already
counted. Against the review row it keeps one integer aggregate.

Deliberately not retained: reviewer logins or any other reviewer identity,
comment bodies or any excerpt of them, and any per-reviewer breakdown anywhere.
Metric labels never carry a reviewer, repository, or comment identifier; the
engagement metric is a bare unlabelled aggregate, because a label would be
retained by every scraper indefinitely.

That commitment covers the webhook queue as well, which is where it would
otherwise be broken. A delivery is persisted to `webhook_jobs.payload` before it
is processed, so it is durable for the queue's own retention window rather than
for the moment the handler runs, and the raw
`pull_request_review_comment` payload GitHub sends carries the full reply body
and the reviewer's login, id, and avatar URL. A delivery of that event is
therefore reduced to an allowlist before it is written: the action, the comment
id and its `in_reply_to_id`, the pull-request number, the repository id and full
name, and the installation id. The body, the diff hunk, the comment URL, the
pull-request title and body, and the reviewer's id and avatar URL are dropped and
never reach the database. The login is replaced by a fixed placeholder that
preserves only whether the author was an App, which is the single bit the handler
reads it for — a bot replying to its own advisory is not engagement. The reply
body is not needed at all, because the finding is identified from the *parent*
advisory, which is read back from the GitHub API.

The reduction is an allowlist rather than a blacklist, so a field GitHub adds to
this event later cannot silently reintroduce free text, and it is applied inside
the store at the point the payload becomes durable rather than in the caller, so
another enqueue path cannot bypass it. It is scoped to this one event: an
`issue_comment` delivery carries the operator's slash command in `comment.body`
and authorizes it by the author's login, so those fields are load-bearing there
and every other event is persisted unchanged.

What the queue does retain for the two comment identifiers above is bounded by
`GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS` (default 7 days) and
`GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS` (default 30 days), after which the
row is deleted. They are the same pseudonymous identifiers discussed below and
are treated the same way. GitHub request paths embed such identifiers too, so a
failed API call reports only its method and HTTP status: the path and the response
body are left out of the error, because a delivery's error text is persisted to an
unbounded column and would otherwise carry an identifier past the bounded records
that are supposed to be its only home.

The retained comment identifiers are the one exception to storing no
identifier, and they exist solely to make counting idempotent: a webhook
delivery can be retried, and without them a redelivery would inflate the only
signal this path produces. They identify a comment rather than a person, but
they are pseudonymous rather than anonymous — an authorized installation token
could still resolve one back to its author through the GitHub API, so they are
treated as personal data. The ring is capped at twenty per finding, covering the
redelivery window rather than a conversation, and older identifiers are
forgotten as it rolls over.

Feedback lives inside the findings column, so it inherits the review-finding
retention bounds — `GUARDIANBOT_REVIEW_FINDING_RETENTION_MS` (default 90 days)
and `GUARDIANBOT_REVIEW_FINDING_LIMIT` (default 200 per review) — in the same
idiom as the `GUARDIANBOT_WEBHOOK_*` bounds. Those two govern terminal findings
only: an open finding is live advisory state and is retained while it is still
reported, so its engagement signal persists for as long as the finding does.

Liveness alone is not a retention bound, though, so two further rules apply to
open findings. `GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS` (default 365
days) is an absolute ceiling measured from when a finding was first seen rather
than last observed, so continuing to re-report a finding on a long-lived pull
request cannot extend it indefinitely. And because both TTLs are applied while a
review is being published, a repository that is removed — or whose installation
is uninstalled — would never be visited again and would retain its open findings
for as long as the database exists; removal therefore discards the retained
findings of every affected repository immediately. A suspension is reversible and
does not discard.

The integer aggregate is not per-person data and survives eviction of the
per-finding records that produced it, including a removal discard.
