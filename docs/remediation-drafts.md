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

## The deterministic validator

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
  `CODEOWNERS` anywhere, repository plumbing (`.gitattributes`, `.gitmodules`,
  `.pre-commit-config.yaml`, `.husky/**`), and lockfiles. The file is not
  binary by extension or content and decodes losslessly as UTF-8 without CRLF
  line endings. It must be a plain file: GitHub answers a symlink with its
  target's path, and any path mismatch is refused.
- The finding's whole line range lies inside one added-line range of this pull
  request's diff for that file.
- Size bounds: at most 50 replaced lines, at most 200 suggestion lines and
  8000 characters, and a file of at most 512 KiB.
- The splice is recomputed and checked independently: every line before and
  after the range must be byte-identical, and the replaced lines must equal the
  suggestion exactly. A suggestion that would not change the file is refused.

## Optional second-model validator

A deployment may add a veto-only second model. It is off unless
`GUARDIANBOT_REMEDIATION_VALIDATOR_URL` is set on the control plane, and it
uses its own contract, `guardian.remediation-validation.v1`
(`POST /v1/remediation-validations`, schemas in
`schemas/remediation-validation-{request,result}.v1.json`).
`guardian.review.v1` is unchanged.

- It runs only after the deterministic validator has accepted the draft, and it
  can only refuse. An `accept` adds nothing the deterministic checks did not
  already require; a `reject`, a timeout, an unreachable endpoint, malformed
  output, or a repository classification outside
  `GUARDIANBOT_REMEDIATION_VALIDATOR_CLASSIFICATIONS` all refuse the draft
  before anything is written, increment
  `guardianbot_remediation_draft_validator_rejected_total`, and reply with a
  fixed reason.
- The request carries only the replaced lines, the exact replacement, up to 20
  surrounding lines on each side (bounded to 4000 characters per side), the
  fingerprint, the path and range, and the category and severity only when they
  are values from the closed protocol enums. No finding title, evidence, or
  other model prose is sent back to a model.
- The reply is schema-checked: unknown fields are rejected, the request id must
  echo, and `reasons` must be non-empty exactly when the decision is `reject`.
- The draft body and the link comment say which validation ran. Without a
  configured validator they state that validation was deterministic only.

The URL must be HTTPS (plain HTTP only on loopback) and must not carry
credentials, a query, or a fragment. A bearer token is required outside
loopback. Credentials live in control-plane environment only and never reach
consumer repositories. A set but malformed configuration fails startup.

## What is written

When validation passes, GuardianBot:

1. creates `guardianbot/fix/<fingerprint-12>-<head-7>` at the pull request's
   head SHA. A redelivered command finds the same branch. Any writer can push
   to that branch, so an existing branch is reused only when it is at the head,
   or when it is exactly one commit ahead of the head and that commit modifies
   only the validated file and leaves it holding exactly the validated content.
   Anything else is refused;
2. commits the single-file change to that branch through the contents API,
   pinned to the file's blob SHA at the head;
3. opens a DRAFT pull request from that branch into the original pull
   request's head branch, with a fixed body stating it is AI-drafted and
   requires human review and approval. The title is built only from trusted
   fields: `GuardianBot AI draft: <category> fix for <fingerprint-12> in
   <path>`, where the category is a closed-enum value (otherwise `advisory`)
   and the path has backticks and control characters stripped. The
   model-written finding title never reaches it. If GitHub refuses the draft, an open
   pull request from the branch is linked only when it is a draft into that
   same head branch; a writer's non-draft pull request or one into another
   base is never presented as GuardianBot's, and the command replies with a
   refusal instead;
4. adds the `guardianbot-ai-draft` label (a failed label does not hide the
   link, because the body already says the same);
5. replies on the original pull request with the draft number and an explicit
   **pending** checks state, and records the draft (branch, draft number, the
   commit it wrote, and the link comment id) so later events can be matched to
   it.

Merging the draft into the pull request branch is a human decision.

## Check status

The App subscribes to no `check_suite` or `check_run` event, so check status
comes from `workflow_run` `completed` events, which it already receives. When a
run completes on a `guardianbot/fix/*` branch at exactly the recorded draft
commit, GuardianBot lists the workflow runs for that commit
(`GET /repos/{owner}/{repo}/actions/runs?head_sha=`, covered by the existing
`Actions: Read` permission) and updates the link comment:

- **pending** while there are no runs, any run is not completed, or GitHub
  reports more runs than one 100-run page. Zero runs is never a pass.
- **passed** only when every run completed as `success`, `skipped`, or
  `neutral`. The comment says this is not an approval.
- **failed** when any completed run concluded otherwise.

A run on any other commit of the branch, for example after a human pushed to
it, is ignored, so the comment never reports checks for content GuardianBot did
not write. Only workflow runs are counted; checks posted by other Apps without
a workflow are not visible through this path. Each settled change increments
`guardianbot_remediation_draft_checks_passed_total` or
`guardianbot_remediation_draft_checks_failed_total`.

## Branch cleanup

When the draft pull request closes (merged or not), or the source pull request
closes after its draft already has, GuardianBot deletes the draft branch only
if it can prove the branch is still exactly what it wrote:

- the branch name matches `guardianbot/fix/<hex>-<hex>`;
- the recorded commit was created by this command, not a reused branch;
- the branch tip still equals that commit; and
- that commit has exactly one parent, the pull request head it was cut from.

Anything else, such as a human push, a rewritten commit, or a reused branch,
leaves the branch in place and increments
`guardianbot_remediation_draft_branch_retained_total`. Deletions increment
`guardianbot_remediation_draft_branch_deleted_total`. Deleting a branch uses
the same `Contents: Read and write` permission Mode C already requires. The
record is dropped either way, and a branch that is already gone just drops it.
A draft that is still open when its source pull request closes is left for its
own close.

## Feedback on drafts and advisories

Negative feedback is command-only: `@guardianbot dismiss <id>` records a
finding as dismissed (see [review value](metrics.md#review-value)).
Thumbs-down reactions are not captured, because the App subscribes to no event
that delivers reactions, and adding one would change the default manifest.

## Limits

- The draft branch lives in the base repository, so anyone with read access
  can see it. Its content is a suggestion GuardianBot already published on the
  pull request.
- A draft opened before draft records existed, or one whose commit could not
  be verified, stays pending and its branch is never deleted automatically.
- A redelivered `workflow_run` or `pull_request` event that arrives after the
  record was settled or dropped does nothing.
- Live behaviour against GitHub, including any configured second-model
  validator, has not been exercised; it is covered by tests against a fake
  GitHub client and a stub validator.
