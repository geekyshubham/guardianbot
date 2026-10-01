# Remediation drafts (Mode C)

Mode C turns one of GuardianBot's own validated advisory suggestions into a
DRAFT pull request, on explicit request from a repository writer. It is
disabled by default, and the default App manifest does not grant the
permission it needs. Nothing about Mode C merges, approves, or pushes to a
contributor's branch, and AI output still never blocks, waives, or approves
anything.

## Enabling it

Both of these must hold, and either one missing leaves the feature off:

1. The control plane runs with `GUARDIANBOT_REMEDIATION_DRAFTS=1`. Any other
   value, including unset, disables it.
2. The installation token GitHub mints for the repository actually reports
   `contents: write`. GuardianBot reads the permissions GitHub returns with
   each installation token and does not infer them from configuration. The
   default manifest grants `contents: read`, so an operator has to add
   `contents: write` to the App and the installation owner has to accept the
   change. See [the GitHub App permissions](github-app.md#optional-mode-c-permission).

When either is missing, `@guardianbot draft-fix` replies that drafting is
unavailable, increments `guardianbot_remediation_draft_unavailable_total`, and
writes nothing.

## Who can trigger it

- Only an `issue_comment` reading `@guardianbot draft-fix <fingerprint>` on a
  pull request.
- The commenter's repository permission is read from the GitHub API and must be
  write, maintain, or admin.
- Comments from bot accounts (a `[bot]` login or a `Bot` user type) are ignored
  without a reply, so one automation cannot chain another into opening pull
  requests.
- The pull request head must be in the same repository. Fork pull requests, a
  deleted head repository, and pull requests whose head branch is itself a
  `guardianbot/fix/*` branch are refused.

## The deterministic second validator

The draft is written only after every check below passes. Each check fails
closed with a fixed reason in the reply.

- The identifier resolves to exactly one of GuardianBot's own open top-level
  advisories on this pull request, and its marker resolves to a retained
  finding.
- The finding is `open`, was not dismissed, and was last observed at the
  pull request's current head. The retained review's reviewed head must equal
  that head too, so a draft is never built from a stale review.
- The finding carries an exact suggestion. The review row retains only a
  SHA-256 digest of the suggestion GuardianBot validated and published; the
  suggestion read back from the published advisory must hash to the same digest.
- The path is a normalized repository path and is not protected. Protected
  paths include `.github/**`, `.guardianbot/**`, other CI directories and
  files (`.circleci/`, `.gitlab-ci.yml`, `Jenkinsfile`, and similar),
  `CODEOWNERS` anywhere, and lockfiles. The file is not binary by extension or
  content and decodes losslessly as UTF-8 without CRLF line endings.
- The finding's whole line range lies inside one added-line range of this pull
  request's diff for that file.
- Size bounds: at most 50 replaced lines, at most 200 suggestion lines and
  8000 characters, and a file of at most 512 KiB.
- The splice is recomputed and checked independently: every line before and
  after the range must be byte-identical, and the replaced lines must equal the
  suggestion exactly. A suggestion that would not change the file is refused.

No second model is consulted. `guardian.review.v1` has no validation
operation, and adding one would change the frozen protocol, so validation is
deterministic only.

## What is written

When validation passes, GuardianBot:

1. creates `guardianbot/fix/<fingerprint-12>-<head-7>` at the pull request's
   head SHA. A redelivered command finds the same branch. An existing branch is
   reused only when it is at the head or exactly one commit ahead of it;
   anything else is refused;
2. commits the single-file change to that branch through the contents API,
   pinned to the file's blob SHA at the head;
3. opens a DRAFT pull request from that branch into the original pull
   request's head branch, with a fixed body stating it is AI-drafted and
   requires human review and approval;
4. adds the `guardianbot-ai-draft` label (a failed label does not hide the
   link, because the body already says the same);
5. replies on the original pull request with the draft number and an explicit
   **pending** checks state.

GuardianBot does not wait for or report the draft's checks. The App subscribes
to no `check_suite` or `check_run` event, so the link is posted immediately in
the checks-pending state, and the reviewer confirms the checks on the draft.
Merging the draft into the pull request branch is a human decision.

## Limits

- The draft branch lives in the base repository, so anyone with read access
  can see it. Its content is a suggestion GuardianBot already published on the
  pull request.
- Draft branches are not cleaned up automatically.
- Live behaviour against GitHub has not been exercised; it is covered by tests
  against a fake GitHub client.
