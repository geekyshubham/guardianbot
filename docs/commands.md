# Pull request commands

Commands are issue comments on a pull request. Authorization requires write,
maintain, or admin on the repository. `pause` and `resume` additionally require
maintain or admin. No command merges code, approves a pull request, pushes to a
contributor's branch, or waives deterministic scanners. AI output remains
advisory. The only command that can write to a repository is the opt-in
`draft-fix` below, and it writes only to a new `guardianbot/fix/*` branch.

Implemented commands:

- `@guardianbot review`: run an incremental advisory review from the last
  reviewed head SHA (or a full first-pass when none exists).
- `@guardianbot full-review`: discard incremental scope and review bounded
  clusters on the current head.
- `@guardianbot explain <id>`: restate a published finding's evidence and impact
  for the matching finding id on this pull request.
- `@guardianbot suggest-fix <id>`: restate any exact safe replacement already
  published for that finding id as an advisory suggestion block. If none was
  published, the reply says so and points back to the finding's remediation
  guidance.
- `@guardianbot status`: show advisory pause state, App lifecycle, last reviewed
  head, finding lifecycle counts, configured review routes, and scanner state.
  Deterministic workflow diagnostics still come from
  `guardianctl doctor OWNER/REPOSITORY`.
- `@guardianbot dismiss <id>`: record a published finding as dismissed for
  review-value analytics. The advisory comment, the finding's lifecycle state,
  and deterministic scanners are unchanged; only the outcome and its timestamp
  are retained, never who dismissed it or why. Repeating it is a no-op.
- `@guardianbot draft-fix <fingerprint>`: Mode C. Disabled by default; see
  [remediation drafts](remediation-drafts.md). When enabled and permitted, opens
  a labelled DRAFT pull request applying the finding's exact validated
  suggestion, targeting this pull request's head branch. Otherwise the reply
  states that drafting is unavailable and why. Comments from bots are ignored
  without a reply, and fork pull requests are refused.
- `@guardianbot pause`: pause automatic AI advisory review. Manual `review`
  remains available; scanners and merge protection are unchanged.
- `@guardianbot resume`: resume automatic AI advisory review.
- `@guardianbot help`: list the supported commands.

`<id>` is the finding ID or a prefix of the fingerprint shown on the
advisory. An identifier that matches more than one open GuardianBot advisory is
refused rather than guessed.

Unknown commands receive an error that points at `help`. Unauthorized actors are
rejected without side effects. Production model credentials and live AI-backed
results remain environment-dependent; unavailable backends degrade to advisory
unavailability rather than inventing findings.
