# Release policy

GuardianBot releases use semantic versions, annotated Git tags, one
`linux/amd64` control-plane image, and evidence bound to the image's registry
digest. Deployments consume `image.reference` from
`release-manifest.json`; they never deploy a mutable tag.

## Repository prerequisites

Before publishing, administrators must configure GitHub rulesets that:

- require pull requests and passing CI on `main`;
- restrict creation of `v*` tags to release maintainers;
- prevent tag updates and deletion;
- enable immutable GitHub Releases where the repository plan supports them.

The root package and every workspace package use the same version, and
`CHANGELOG.md` contains a dated section for it. A release tag is exactly
`v<package version>` without SemVer build metadata. The tag must be annotated,
point to a commit reachable from `main`, and match the commit checked out by the
release job.

Consumer repositories pin reusable workflows to a full 40-character GuardianBot
commit, never a release tag or branch. Workflow upgrades remain reviewable
configuration PRs.

## Publication gate

The release workflow separates read-only verification from publication:

1. The read-only job validates the tag, commit, package versions, and `main`
   ancestry, then runs schema generation checks, protocol contract tests,
   package tests, builds, and documentation gates.
2. The image-publication job repeats source validation and receives package,
   attestation, and OIDC permissions, but only read access to repository
   contents. A separate final job receives release-write permission and no
   package or OIDC permission.
3. If either stable tag already exists, the run enters a strict recovery path:
   existing stable tags must agree on one digest and that digest must already
   carry valid GitHub provenance, a Cosign signature, and a CycloneDX
   attestation for the exact tag commit. An unknown or partially trusted digest
   is never adopted. Network or registry errors are not interpreted as absence.
4. A new image is built once for `linux/amd64` from digest-pinned base images.
   A recovered image is pulled by its already verified digest. Trivy, itself
   referenced by an immutable digest, scans vulnerabilities, image
   misconfigurations, and embedded secrets and blocks Critical results before
   publication.
5. Trivy generates a CycloneDX JSON SBOM from that same local image. The image
   is first pushed under `candidate-<run id>-<attempt>`, making failed attempts
   unambiguous and preventing a stable tag from exposing an unsigned image.
6. GitHub creates SLSA build provenance for the digest and stores it in both the
   repository attestation service and GHCR. The workflow independently verifies
   both the downloaded provenance bundle and the OCI copy against the exact
   certificate identity, source ref, source commit, repository, and
   GitHub-hosted runner claim.
7. Cosign signs the exact digest and attaches the CycloneDX SBOM as an
   attestation. Both are verified against the exact release-workflow identity;
   regular-expression identity matching is not accepted.
8. GuardianBot creates a digest-first deployment manifest containing hashes of
   the scan, SBOM, GitHub provenance, and verification results. The manifest is
   independently validated, signed as a keyless Sigstore blob, and accompanied
   by SHA-256 checksums.
9. Only after every verification succeeds are `vX.Y.Z` and `sha-<commit>`
   attached to the verified digest. Existing tags are accepted only when they
   already match that exact digest, which makes a partially completed two-tag
   publication safely resumable without overwriting either tag.
10. The GitHub Release is created as a draft, every uploaded asset is compared
    byte-for-byte against a fixed canonical allowlist, and only then is the
    release published. Unexpected draft or published assets fail the run. A
    resumed run may replace canonical assets only while the release is still a
    draft. An already published release is accepted only after its exact asset
    set, checksums, manifest contents, and manifest signature verify. The
    Actions evidence artifact is retained for 90 days.

When a run fails before stable tag attachment, cleanup locates the GHCR package
version by its run-scoped candidate tag and deletes it only if that candidate is
the version's sole tag. If a stable alias exists, cleanup deliberately retains
the candidate as audit evidence. Cleanup inability is recorded and does not
weaken the original failure.

All action dependencies use full commit pins. Updating an action, Trivy image,
Cosign installer, runner image, or release policy requires a reviewed pull
request and a fresh release-policy test.

## Consumer verification

An operator must obtain these assets from the GitHub Release:

- `release-manifest.json`;
- `release-manifest.sigstore.json`;
- `github-provenance.sigstore.json`;
- `sbom.cdx.json`;
- `checksums.sha256`.

Verify the checksums and the signed manifest before reading the deployment
reference:

```bash
sha256sum --check checksums.sha256
cosign verify-blob release-manifest.json \
  --bundle release-manifest.sigstore.json \
  --certificate-identity \
  "https://github.com/Geekyshubham/guardianbot/.github/workflows/release.yml@refs/tags/vX.Y.Z" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
jq -er '.image.reference' release-manifest.json
```

Then verify the referenced image independently:

```bash
image="$(jq -er '.image.reference' release-manifest.json)"
source_sha="$(jq -er '.source.commit' release-manifest.json)"
source_ref="$(jq -er '.source.ref' release-manifest.json)"
identity="https://github.com/Geekyshubham/guardianbot/.github/workflows/release.yml@$source_ref"
cosign verify "$image" \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
gh attestation verify "oci://$image" \
  --repo Geekyshubham/guardianbot \
  --bundle-from-oci \
  --cert-identity "$identity" \
  --cert-oidc-issuer "https://token.actions.githubusercontent.com" \
  --signer-workflow \
  github.com/Geekyshubham/guardianbot/.github/workflows/release.yml \
  --source-digest "$source_sha" \
  --source-ref "$source_ref" \
  --deny-self-hosted-runners
```

Deployment automation must pass the exact `name@sha256:...` value through to
DigitalOcean and verify the running digest. A tag is discovery metadata only.

## Failure and recovery

No workflow rerun may overwrite a published version or commit tag. Before stable
publication, an isolated failed candidate can be deleted automatically. After
either stable tag is visible, a rerun may continue only through the strict
recovery checks above; it recreates evidence from the already trusted digest,
adds a missing stable alias, and safely replaces assets only in an unpublished
draft. Published release assets are never replaced. If those checks fail,
preserve the evidence for incident review, mark the version as failed or
withdrawn, and publish a new patch version. Do not delete, move, or reuse stable
release tags.

A capability release additionally requires `docs/status.md` and `CHANGELOG.md`
updates. Breaking protocol or repository-configuration changes require a major
release and generated migration PRs. A rollback is a new version that restores
the last known-good source while preserving the failed release's evidence.

The documentation gate evaluates capability paths against the current working
tree locally and against the merge base in CI. Changes under application/package
source, schemas, workflows, deployment infrastructure, operational scripts, or
workspace package manifests must update both `docs/status.md` and
`CHANGELOG.md`. Set `DOCS_DIFF_BASE` only when a CI system cannot expose its
normal base ref.
