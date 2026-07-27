# Release policy

Releases use semantic versions and an annotated Git tag. Publish the control-plane
image and CLI from the same commit. Consumer repositories pin reusable workflows
to the full 40-character commit, never a tag or branch.

A capability release requires protocol/schema compatibility checks, tests, docs
quality gates, `docs/status.md`, `CHANGELOG.md`, container scan/SBOM/signature, and
a rollback commit. Breaking protocol or repository schema changes require a major
release and generated migration PR.

The documentation gate evaluates capability paths against the current working
tree locally and against the merge base in CI. Changes under application/package
source, schemas, workflows, deployment infrastructure, operational scripts, or
workspace package manifests must update both `docs/status.md` and `CHANGELOG.md`.
Set `DOCS_DIFF_BASE` only when a CI system cannot expose its normal base ref.
