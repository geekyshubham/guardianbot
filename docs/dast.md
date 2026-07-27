# DAST

DAST is staging-only. Configuration contains one exact HTTPS origin, a safe
OpenAPI document, an opaque control-plane authentication profile, a protected
session assertion, and excluded destructive/internal routes.

The [checked example OpenAPI document](examples/openapi.safe.yaml) contains only
read-only staging probes. Documentation checks parse and validate every
`docs/examples/openapi*.yaml` or `.json` file without resolving remote references.

Before ZAP:

1. Verify the deployed digest and expected workflow identity.
2. Resolve credentials only inside the control plane or ephemeral runner.
3. Authenticate and require the session assertion to succeed.
4. Compare the target origin byte-for-byte with the allowlist.
5. Prohibit production, link-local, metadata, localhost, wildcard, and redirected
   cross-origin targets.

Deploy-smoke profiles run for minutes; authenticated nightly profiles are capped at
45 minutes, and configured durations outside 5–45 minutes fail validation. The
reusable workflow never runs on pull requests and uses the protected GitHub
environment `guardianbot-dast`; operators should configure its required reviewers
and restrict staging secrets to that environment.

The workflow fails closed unless an ephemeral `session_cookie` is provided. It
first requires the protected assertion to return 401/403 without that cookie, then
requires a 2xx response with it. It also requires the OpenAPI URL to resolve to the
exact target origin or an explicit allowlisted URL, and scrubs the session value
from logs and temporary files. DefectDojo import/reimport remains control-plane
work; the PoC reusable workflow does not claim to perform it.
