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
- schema-invalid review requests return a deterministic non-retryable `400`
  `bad_request` response; malformed JSON is also `400`; provider and internal
  failures stay sanitized and never leak prompts, credentials, endpoints, or
  provider response bodies

## Control plane vs bridge configuration

The control plane points only at bridge HTTP origins. Prefer the administrative
registry JSON (`GUARDIAN_REVIEW_REGISTRY_JSON`, or legacy
`GUARDIAN_MODEL_BACKEND_REGISTRY`) so profiles map to bridge aliases. The legacy
single-backend pair `GUARDIAN_MODEL_BACKEND_URL` /
`GUARDIAN_MODEL_BACKEND_TOKEN` remains available when no registry is set. Do not
put provider product names, model ids, or upstream provider URLs into control-plane
config; those belong only in bridge admin config
(`GUARDIAN_MODEL_BRIDGE_CONFIG_JSON` or `GUARDIAN_MODEL_BRIDGE_CONFIG_FILE`).

Repository `.guardianbot/config.yml` may set optional `review.profile` to one of
`automatic`, `routine-review`, `high-risk-review`, or `benchmark-review`. That
field selects only an approved profile name. It cannot choose a backend URL,
binding alias, model id, credential, or fallback. When the selected profile has
no administrative route, the control plane publishes advisory
`AI review unavailable` and deterministic checks continue.

## Packaged fixture-provider conformance

The model-bridge package includes a deterministic zero-finding fixture at
`apps/model-bridge/fixtures/live-conformance.json`. In a signed runtime image
the same file is available at
`/app/apps/model-bridge/fixtures/live-conformance.json` once that image is
released. The fixture returns a strict zero-finding `guardian.review.v1`
result for bridge and plumbing verification only. It is never production AI
and must not be treated as a live model review.

Fixture deployments must:

- set `adapter: "fixture-provider"` and point `fixtureFile` at the packaged
  conformance path
- explicitly map every routed profile's `profileModels` entry to
  `fixture-conformance` (omitted keys keep the default real model ids such as
  `gpt-5.6-terra` / `gpt-5.6-sol`)
- use an explicit partial control-plane registry that routes only the intended
  verification profile (typically `benchmark-review`) to the fixture bridge
- never use the legacy single-backend
  `GUARDIAN_MODEL_BACKEND_URL` / `GUARDIAN_MODEL_BACKEND_TOKEN` pair for fixture
  verification, because that pair collapses every profile onto one backend
- never route routine or high-risk production reviews to the fixture

Safe administrative example for local or private-network plumbing checks
(placeholders only; no secrets or public provider URLs):

```json
{
  "protocolVersion": "guardian.review.v1",
  "bindings": {
    "fixture-conformance": {
      "adapter": "fixture-provider",
      "fixtureFile": "/app/apps/model-bridge/fixtures/live-conformance.json",
      "allowedClassifications": ["public", "private"],
      "retention": "bounded",
      "usageReporting": false,
      "profileModels": {
        "benchmark-review": "fixture-conformance"
      }
    }
  },
  "routes": {
    "benchmark-review": {
      "binding": "fixture-conformance"
    }
  }
}
```

Matching control-plane registry shape (partial routes only; private placeholder
endpoint):

```json
{
  "protocolVersion": "guardian.review.v1",
  "backends": {
    "fixture-bridge": {
      "endpoint": "http://model-bridge.internal:3001",
      "tokenEnv": "GUARDIAN_MODEL_BRIDGE_TOKEN",
      "allowedClassifications": ["public", "private"]
    }
  },
  "routes": {
    "benchmark-review": "fixture-bridge"
  }
}
```

Leave `routine-review` and `high-risk-review` unmapped in that partial registry
so ordinary repository reviews stay unavailable rather than silently hitting the
fixture. Current fixture and repository-selected profile coverage is
automated/local only; production OpenAI Responses credentials and live AI PR
review remain open.

## Running the included bridge

Run the bridge as its own process, separate from the control plane:

```sh
export HOST=127.0.0.1
export PORT=3001
export GUARDIAN_MODEL_BRIDGE_TOKEN=CONTROL_PLANE_TO_BRIDGE_TOKEN
export GUARDIAN_MODEL_BRIDGE_CONFIG_JSON='{"protocolVersion":"guardian.review.v1","bindings":{"default":{"adapter":"openai-responses","apiKeyEnv":"OPENAI_API_KEY","allowedClassifications":["public","private"],"retention":"bounded"}},"routes":{"routine-review":{"binding":"default"},"high-risk-review":{"binding":"default"},"benchmark-review":{"binding":"default"}}}'
export OPENAI_API_KEY=PROVIDER_SECRET_ONLY_ON_BRIDGE
npm run build --workspace @guardianbot/model-bridge
npm start --workspace @guardianbot/model-bridge
```

Loopback-only local development may omit the bearer token; any non-loopback bind
requires `GUARDIAN_MODEL_BRIDGE_TOKEN`. Verify with `GET /healthz`, authenticated
`GET /v1/capabilities`, and the package tests
(`npm test --workspace @guardianbot/model-bridge`), including the loopback
protocol-client wire conformance suite.

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
