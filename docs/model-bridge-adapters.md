# Model bridge adapters

`apps/model-bridge` keeps the public contract fixed at `guardian.review.v1` while
binding review profiles to adapter implementations through administrative config only.

Current adapters:

- `openai-responses`: direct HTTP `POST /v1/responses` with strict `text.format`
  JSON-schema output, explicit `reasoning.effort`, `store: false`, and `tools: []`
- `openai-compatible`: same request shape, but only after a startup probe proves the
  endpoint can complete a strict structured-output response
- `fixture-provider`: deterministic local fixture source for conformance and failure-path
  tests

Guardrails:

- core routing chooses binding aliases, not vendor names
- profile-to-model mapping lives only in bridge admin config
- profile-to-reasoning-effort mapping lives only in bridge admin config
- route fallback is disabled unless `fallbackBinding` is explicitly configured
- prompts delimit repository content as untrusted data
- bridge responses reject refusal, incomplete output, multiple text outputs, malformed
  JSON, and schema mismatches before anything reaches the control plane

Operationally, publish one bridge instance only when every routed binding agrees on
classification scope and retention semantics. The protocol capabilities endpoint cannot
express a per-profile classification matrix, so mixed classification sets are rejected at
startup to avoid false capability claims.

`store: false` is not treated as proof of zero retention. OpenAI bindings advertise
`bounded` retention by default because abuse-monitoring logs may be retained under the
account's data controls. `retention: "none"` additionally requires
`zeroDataRetentionVerified: true`, which is an administrator's assertion that the
applicable OpenAI account/project has Zero Data Retention enabled. See the official
[OpenAI data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint).
