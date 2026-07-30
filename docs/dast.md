# DAST

GuardianBot runs DAST only against an exact, administratively approved HTTPS
staging origin. Repository configuration may select an opaque authentication
profile, but it cannot contain a credential, backend URL, DigitalOcean token, or
production target.

The [checked safe OpenAPI example](examples/openapi.safe.yaml) contains only
read-only probes. Documentation checks parse every OpenAPI example without
resolving remote references.

## One-time session broker

The reusable workflow requests a GitHub OIDC token for the audience
`guardianbot-dast-session` and calls the control-plane `/dast/session` endpoint.
The broker verifies all of the following before it returns a credential:

- the repository name and numeric repository ID are active in GuardianBot;
- the run ID, run attempt, head SHA, and default-branch ref match the request;
- the caller is `.github/workflows/guardianbot.yml`;
- the called workflow is `.github/workflows/reusable-dast.yml` at the exact
  trusted GuardianBot commit;
- the runner is GitHub-hosted and the event matches the requested scan profile:
  `authenticated-baseline` allows `schedule` or `workflow_dispatch`;
  `authenticated-full` allows only a genuine `schedule` event (manual dispatch
  cannot obtain a full session). Push-triggered DAST is rejected to avoid
  racing image promotion;
- the protected environment and OIDC subject are exactly
  `guardianbot-dast`; and
- the profile origin and protected assertion path exactly match the request;
  and
- accepted image-promotion evidence proves that the same default-branch SHA is
  active and healthy in the profile's DigitalOcean environment at the exact
  approved origin.

Each repository, run attempt, profile, commit, and origin can obtain a session
only once. Issuance leases are durable in PostgreSQL, and the response is
returned with `Cache-Control: no-store`. The response binds the session to the
deployed `sha256:` image digest and environment; both values are retained in
the signed DAST evidence and DefectDojo tags.

Configure profiles centrally in `GUARDIANBOT_DAST_PROFILES_JSON`. The normal
`exchange` mode asks a same-origin staging endpoint for a short-lived
credential; only the control plane knows the exchange authorization value:

```json
{
  "routelens-staging": {
    "mode": "exchange",
    "repository": "Geekyshubham/RouteLens",
    "repositoryId": 123456789,
    "origin": "https://routelens-staging.example.com",
    "deploymentEnvironment": "staging",
    "sessionAssertionPath": "/api/v1/protected-session/",
    "headerName": "Authorization",
    "ttlSeconds": 600,
    "exchangeUrl": "https://routelens-staging.example.com/guardianbot/session",
    "exchangeCredentialEnv": "ROUTELENS_DAST_EXCHANGE_TOKEN"
  }
}
```

The exchange request includes the exact `deploymentEnvironment` and
`deployedDigest`. The exchange endpoint must return only `schemaVersion`,
`credential`, and `expiresAt`. Its credential must remain valid for more than
30 seconds and no longer than the requested profile TTL.

Static mode is a lower-assurance PoC escape hatch. It is rejected unless the
individual profile contains `pocStaticCredential: true` and the control plane
sets `GUARDIANBOT_ALLOW_POC_STATIC_DAST=1`. It must not be used as the
production design.

## Workflow safety

Before ZAP, the reusable workflow:

1. proves the protected assertion returns 401 or 403 without authentication;
2. obtains the one-time credential and masks it immediately;
3. proves the assertion returns 2xx with the credential;
4. accepts an OpenAPI file from the exact checked-out commit or a same-origin
   live schema endpoint;
5. rejects remote references, cross-origin servers, unsafe redirects, private
   targets, and routes excluded by configuration;
6. removes every operation except `GET`, `HEAD`, and `OPTIONS`, and fails when
   no safe operation remains; and
7. destroys the temporary credential file and publishes only scrubbed,
   digest-bound evidence.

The `guardianbot-dast` environment should require reviewers. Consumer
repositories do not store a DAST session secret and do not pass `secrets:
inherit`.

The generated caller and session broker both enforce profile binding:

- `authenticated-baseline` smoke scans are capped at 15 minutes (and at least
  5 minutes overall) and may run on the smoke schedule or on manual
  `workflow_dispatch` after promotion;
- `authenticated-full` nightly scans are schedule-only at the caller (`if:`
  binds the nightly cron) and at the session broker; they require at least 30
  minutes and are capped at 45 minutes; and
- `scanProfile` is part of the session request and the one-time issuance lease,
  so a baseline lease cannot be reused for full (or the reverse). Invalid
  baseline/full minute constraints fail early in the reusable workflow before
  ZAP runs.

Manual `workflow_dispatch` therefore remains baseline-only. GuardianBot
evidence keys distinguish smoke and nightly, so smoke cannot satisfy nightly
monitoring. The current DefectDojo reimport may use the same test identity with
run/profile provenance, and independent nightly import evidence remains
required.

## Failure behavior

An unauthorized origin, missing exact-head deployment, digest mismatch, failed
unauthenticated assertion, unavailable broker, replayed issuance, invalid
OpenAPI document, missing ZAP output, or failed required import leaves DAST
evidence missing or failed. AI review continues to be advisory, but a
configured deterministic DAST requirement does not pass.

RouteLens and AstraNull use this same generic contract. Their exact origins,
repository IDs, exchange endpoints, and protected assertion paths will be added
only after isolated DigitalOcean staging exists; no successful live
authenticated DAST evidence is claimed yet.
