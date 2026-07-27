# DAST

DAST is staging-only. Configuration contains one exact HTTPS origin, a safe
OpenAPI document, an opaque control-plane authentication profile, a protected
session assertion, and excluded destructive/internal routes.

Before ZAP:

1. Verify the deployed digest and expected workflow identity.
2. Resolve credentials only inside the control plane or ephemeral runner.
3. Authenticate and require the session assertion to succeed.
4. Compare the target origin byte-for-byte with the allowlist.
5. Prohibit production, link-local, metadata, localhost, wildcard, and redirected
   cross-origin targets.

Deploy-smoke profiles run for minutes; authenticated nightly profiles are capped at
45 minutes. The reusable workflow now fails closed unless an authenticated session
cookie is provided, the protected session assertion succeeds, and the OpenAPI URL
resolves to the exact target origin or an explicit allowlisted URL. DefectDojo
import/reimport remains control-plane work; the PoC reusable workflow does not
claim to perform it.
