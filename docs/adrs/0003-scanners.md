# ADR 0003: Semgrep and Trivy

Status: Accepted for the PoC.

Semgrep provides source rules; Trivy provides dependency, image, configuration,
license, secret, and SBOM coverage. Both emit machine-readable evidence that is
normalized before policy. Tool versions are centrally maintained.
