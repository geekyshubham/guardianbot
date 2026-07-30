# Pull request commands

Commands are issue comments on a pull request. Authorization requires write,
maintain, or admin on the repository. `pause` and `resume` additionally require
maintain or admin. No command merges code, commits changes, or waives
deterministic scanners. AI output remains advisory.

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
- `@guardianbot pause`: pause automatic AI advisory review. Manual `review`
  remains available; scanners and merge protection are unchanged.
- `@guardianbot resume`: resume automatic AI advisory review.
- `@guardianbot help`: list the supported commands.

Unknown commands receive an error that points at `help`. Unauthorized actors are
rejected without side effects. Production model credentials and live AI-backed
results remain environment-dependent; unavailable backends degrade to advisory
unavailability rather than inventing findings.
