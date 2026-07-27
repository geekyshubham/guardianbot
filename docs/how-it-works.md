# How it works

## Event to review

```mermaid
sequenceDiagram
  participant G as GitHub
  participant C as Control plane
  participant S as Repository store/index
  participant B as Approved bridge
  G->>C: Signed PR webhook
  C->>G: In-progress placeholder
  C->>S: Load isolated repository context
  C->>B: Bounded guardian.review.v1 request
  B-->>C: Strict ReviewResult JSON
  C->>C: Schema, SHA, line, evidence, duplicate validation
  C->>G: Update placeholder
```

The bridge gets no tools, tokens, network authority, or GitHub client.

## Repository index and review scope

```mermaid
flowchart LR
  SNAP["Repository snapshot plus commit"] --> SCOPE["Validate repository scope, commit, and paths"]
  SCOPE --> PARSE["Tree-sitter or bounded text fallback"]
  PARSE --> GRAPH["Symbols, imports, calls, tests, config, schemas, ownership, history"]
  GRAPH --> LOCAL["Deterministic local vectors or labeled lexical fallback"]
  LOCAL --> KEY["Repository-and-commit storage key"]
  KEY --> RETRIEVE["Scope-checked retrieval"]
```

Retrieval always supplies the expected repository scope and commit. Related
repositories require a bilateral administrative allowlist, and non-public context
cannot flow into a public review. Repository text and history remain untrusted data;
control tokens are escaped before review-bundle wrapping.

Reviews of at most 50 files and 5,000 changed lines use the full changed-symbol
graph. Above either limit the result is explicitly partial: GuardianBot selects
deterministic security clusters (identity, secrets, supply chain, schemas, network,
and runtime policy), expands their callers, callees, tests, and supporting files,
and reports the omitted paths.

## Workflow to gate

```mermaid
flowchart LR
  PR["PR or nightly trigger"] --> CALL["Immutable caller SHA"]
  CALL --> SEM["Semgrep"]
  CALL --> TRI["Trivy"]
  SEM --> NORM["Normalized evidence"]
  TRI --> NORM
  NORM --> POL["New-finding policy"]
  POL --> ART["Immutable artifacts"]
  POL --> CHECK["guardianbot/security-gate"]
```

AI findings remain advisory. Scanner crashes and missing evidence fail deterministic
enforcement.

## Image and DAST

The image workflow builds one `linux/amd64` image, runs smoke checks, scans it,
creates CycloneDX, pushes by content, signs keylessly, and verifies workflow
identity. The same digest is the only valid DigitalOcean staging promotion input.
ZAP accepts only the configured exact HTTPS origin and safe OpenAPI artifact.

Nightly callers provide full scans. The production roadmap adds reconciliation for
deployed digest rescans, expected runs, imports, expiry, and weekly value reporting.
