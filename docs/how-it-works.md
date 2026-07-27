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
  CALL --> TRI["Trivy vulnerability, config, secret, and license scans"]
  SEM --> NORM["Normalized evidence"]
  TRI --> NORM
  NORM --> POL["New-finding policy"]
  POL --> ART["Immutable artifacts"]
  ART --> ATT["Control-plane identity and attestation verification"]
  POL --> CHECK["guardianbot/security-gate"]
```

AI findings remain advisory. Scanner crashes and missing evidence fail deterministic
enforcement.

## Image and DAST

```mermaid
sequenceDiagram
  participant W as "Pinned image workflow"
  participant R as "GHCR"
  participant C as "GuardianBot control plane"
  participant D as "Allowlisted DigitalOcean app"
  W->>W: "Build linux/amd64, test, boot, scan, create SBOM"
  W->>R: "Push exact digest, sign, attach SBOM"
  W->>C: "Attested image-promotion evidence"
  C->>C: "Verify repository, run, SHA, workflow, digest"
  C->>D: "Update approved services to exact digest"
  D-->>C: "Active deployment with same digest"
  C->>D: "Health and readiness probes"
  C->>C: "Record deployment evidence"
```

The DigitalOcean API token and target allowlist exist only on the control
plane. Monitoring reports an image protected only when its scan, SBOM,
signature, and deployment evidence agree on the registry digest.

```mermaid
sequenceDiagram
  participant W as "Pinned DAST workflow"
  participant O as "GitHub OIDC"
  participant C as "GuardianBot session broker"
  participant S as "Exact staging origin"
  participant Z as "ZAP"
  W->>S: "Protected assertion without credential"
  S-->>W: "401 or 403"
  W->>O: "OIDC token for guardianbot-dast-session"
  W->>C: "One-time session request"
  C->>C: "Verify repo, run, commit, workflow SHA, runner, environment"
  C->>S: "Exchange for short-lived credential"
  S-->>C: "Credential and bounded expiry"
  C-->>W: "Masked one-time header"
  W->>S: "Protected assertion with credential"
  S-->>W: "2xx"
  W->>Z: "Safe same-origin OpenAPI and exact origin"
  Z-->>W: "Scrubbed smoke or nightly report"
```

The 15-minute smoke and nightly authenticated scans use distinct evidence and
DefectDojo import identities. Expected-run reconciliation, index freshness,
evidence freshness, suppression expiry, exact signed/deployed digest matching,
and weekly aggregate coverage are persisted by the monitoring scheduler.
