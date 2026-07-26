# Changelog

All notable changes follow Keep a Changelog. GuardianBot uses semantic versioning;
reusable workflow commits remain immutable.

## [Unreleased]

## [0.1.1] - 2026-07-27

### Security

- Minimized the release runtime image and removed development dependencies and the
  bundled package manager after the v0.1.0 PoC image gate detected Critical
  operating-system and `tar` findings.

## [0.1.0] - 2026-07-27

### Added

- Provider-neutral `guardian.review.v1` protocol with strict validation.
- GitHub App control plane, repository discovery, advisory review, and isolation.
- Reusable onboarding/admin CLI and versioned repository configuration.
- Semgrep/Trivy, image/SBOM/Cosign, and allowlisted ZAP workflows.
- DigitalOcean Compose deployment and release-controlled documentation.
- Tagged GHCR control-plane image release with Trivy, CycloneDX, keyless signing,
  and verification evidence.

### Known limitations

- Live GitHub App, DigitalOcean, RouteLens, and AstraNull evidence is not yet
  verified; see `docs/status.md`.
