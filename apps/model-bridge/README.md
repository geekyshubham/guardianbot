# Model Bridge

`apps/model-bridge` is a standalone `guardian.review.v1` bridge service. It exposes:

- `GET /healthz`
- `GET /v1/capabilities`
- `POST /v1/reviews`

It keeps provider details behind adapter bindings, uses strict schema validation at
every boundary, and does not depend on any vendor SDK.

## Environment

Configuration is administrative only and is loaded from exactly one of:

1. `GUARDIAN_MODEL_BRIDGE_CONFIG_JSON`
2. `GUARDIAN_MODEL_BRIDGE_CONFIG_FILE`

`GUARDIAN_MODEL_BRIDGE_CONFIG_JSON` wins when both are present. The file path may be
absolute or relative to the current working directory. If neither is set, startup fails.

The HTTP listener uses:

- `HOST`: optional, default `127.0.0.1`
- `PORT`: optional integer, default `3001`
- `GUARDIAN_MODEL_BRIDGE_TOKEN`: required bearer token for `/v1/capabilities` and
  `/v1/reviews` unless the bridge is loopback-only for local development

Secrets may be embedded directly in bridge config with `apiKey`, but the intended path
is `apiKeyEnv`, which reads a bearer token from the named environment variable at
startup.

## Config shape

```json
{
  "protocolVersion": "guardian.review.v1",
  "limits": {
    "requestBodyBytes": 2097152,
    "responseBodyBytes": 1048576,
    "startupProbeTimeoutMs": 10000
  },
  "bindings": {
    "default-openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://api.openai.com",
      "apiKeyEnv": "OPENAI_API_KEY",
      "allowedClassifications": ["public", "private"],
      "retention": "bounded",
      "usageReporting": true
    },
    "local-compatible": {
      "adapter": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434",
      "allowedClassifications": ["public"],
      "retention": "none",
      "usageReporting": false,
      "profileModels": {
        "routine-review": "my-local-model",
        "high-risk-review": "my-local-model",
        "benchmark-review": "my-local-model"
      }
    },
    "fixtures": {
      "adapter": "fixture-provider",
      "fixtureFile": "./test/fixtures/conformance.json",
      "allowedClassifications": ["public", "private", "restricted"]
    }
  },
  "routes": {
    "routine-review": {
      "binding": "default-openai"
    },
    "high-risk-review": {
      "binding": "default-openai"
    },
    "benchmark-review": {
      "binding": "default-openai"
    }
  }
}
```

## Binding semantics

Common binding fields:

- `adapter`: one of `openai-responses`, `openai-compatible`, `fixture-provider`
- `allowedClassifications`: non-empty array of `public`, `private`, `restricted`
- `timeoutMs`: optional integer between `1000` and `600000`, default `90000`
- `maxInputCharacters`: optional integer, default `400000`
- `maxOutputTokens`: optional integer between `256` and `65536`, default `12000`
- `retention`: optional for OpenAI (default `bounded`) and fixture bindings, required
  for compatible bindings
- `usageReporting`: optional, default `true` for OpenAI, `false` otherwise
- `profileModels`: optional mapping from review profile to opaque model id
- `profileReasoningEfforts`: optional mapping from review profile to `none`, `low`,
  `medium`, `high`, `xhigh`, or `max`

Default profile models for OpenAI-family bindings when `profileModels` is omitted:

- `routine-review`: `gpt-5.6-terra`
- `high-risk-review`: `gpt-5.6-sol`
- `benchmark-review`: `gpt-5.6-sol`
- `fallback-review`: `gpt-5.6-terra`

Default reasoning effort for every profile when `profileReasoningEfforts` is omitted:

- `medium`

OpenAI-family fields:

- `baseUrl`: optional absolute HTTP(S) URL, default `https://api.openai.com`
- `apiKey`: optional bearer token
- `apiKeyEnv`: optional environment variable name containing the bearer token
- `allowInsecureHttpForLocalDev`: optional boolean for `openai-compatible` only; allows
  HTTP only for local/private gateways and never for `openai-responses`
- `zeroDataRetentionVerified`: OpenAI-only administrative assertion. It must be `true`
  before an `openai-responses` binding may advertise `retention: "none"`. Set this only
  after the account/project is approved and configured for Zero Data Retention; sending
  `store: false` alone is not evidence of zero retention.

`openai-compatible` bindings are probed during startup with a strict structured-output
request against `/v1/responses`. Startup fails closed if the endpoint refuses the probe,
returns malformed output, omits strict JSON-schema support, or cannot complete within
the configured timeout.

Fixture-provider fields:

- `fixtureFile`: required path to JSON fixtures

Fixture file shape:

```json
{
  "capabilities": {
    "structuredOutput": true,
    "retention": "none",
    "usageReporting": false
  },
  "defaultResult": { "...": "canonical ReviewResult" },
  "byRequestId": {
    "req-123": { "...": "canonical ReviewResult" }
  },
  "errorsByRequestId": {
    "req-timeout": { "code": "timeout" },
    "req-refusal": { "code": "refusal" }
  }
}
```

Supported fixture error codes are `timeout`, `refusal`, `invalid_output`, and
`unavailable`.

## Routes

`routes` is a partial mapping of protocol review profiles to route definitions:

```json
{
  "routine-review": {
    "binding": "default-openai",
    "fallbackBinding": "fixtures",
    "timeoutMs": 90000,
    "maxInputCharacters": 400000,
    "maxOutputTokens": 12000
  }
}
```

Route fields:

- `binding`: required binding alias
- `fallbackBinding`: optional explicit fallback binding alias; no fallback occurs without it,
  and the fallback classification set must be a superset of the primary set
- `timeoutMs`: optional route override
- `maxInputCharacters`: optional route override
- `maxOutputTokens`: optional route override

Capabilities are published only when every routed binding agrees on retention,
classification set, and structured-output support. This prevents the bridge from
advertising profile/classification combinations it cannot honor consistently.

## Security behavior

- `/v1/capabilities` and `/v1/reviews` require constant-time bearer auth whenever the
  bridge is not loopback-only local development.
- Repository text is passed as explicitly delimited untrusted data.
- The bridge sends `store: false`, `tools: []`, and no `tool_choice`. `store: false`
  disables Responses application-state storage, but default provider abuse-monitoring
  retention can still apply; the bridge therefore reports `bounded` retention unless
  Zero Data Retention has been administratively verified.
- The bridge never logs prompts, completions, or token counts.
- Provider errors are redacted before they cross the HTTP boundary.
- Refusals, incomplete responses, malformed JSON, duplicate text outputs, schema
  mismatches, and oversized bodies are rejected.

## Commands

```sh
npm test --prefix apps/model-bridge
npm run typecheck --prefix apps/model-bridge
npm run build --prefix apps/model-bridge
```
