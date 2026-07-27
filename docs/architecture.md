# Architecture

The control plane is a stateless Node service behind Caddy. PostgreSQL owns
repository records and review state; the core package defines a pgvector-ready
repository-index persistence contract, while the durable PostgreSQL adapter remains
to be wired into the control plane. Valkey is reserved for background queues.
Reusable GitHub-hosted workflows execute untrusted builds outside the control
plane. DefectDojo and monitoring are self-hosted on DigitalOcean.

Trust boundaries:

1. GitHub webhooks enter through HMAC and delivery replay validation.
2. Repository content is untrusted and stays labeled by repository ID, commit SHA,
   visibility, and related-repository allowlist.
3. The model bridge is an untrusted compute boundary: bounded inputs, no tools,
   strict output schema.
4. Scanner evidence is deterministic and independently normalized.
5. DigitalOcean staging is isolated from production and allowlisted for DAST.

One backend failure cannot block deterministic checks. One repository's context is
never queried for another unless both configurations explicitly allow the
relationship. Context from a private or internal related repository never flows
into a public repository review.

Core index version 2 keys every snapshot by stable repository scope and commit.
Tree-sitter WASM extracts symbols, imports, and name-resolved call edges for Python,
JavaScript/TypeScript, Swift, and Ruby; unsupported, oversized, or parser-failing
files retain deterministic text indexing. Embeddings are local-only: a caller may
provide a deterministic local model, otherwise GuardianBot labels and uses lexical
feature hashing rather than claiming semantic vectors. The durable PostgreSQL/
pgvector implementation and control-plane job wiring remain production work.
