# Architecture

The control plane is a stateless Node service behind Caddy. PostgreSQL owns
repository records, review state, and future pgvector indexes; Valkey is reserved
for background queues. Reusable GitHub-hosted workflows execute untrusted builds
outside the control plane. DefectDojo and monitoring are self-hosted on
DigitalOcean.

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
relationship. The PoC local index uses feature hashing/text symbols; Tree-sitter
graphs and durable pgvector retrieval are the next production milestone.
