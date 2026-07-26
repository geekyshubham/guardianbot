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
45 minutes. Evidence is imported/reimported into DefectDojo. The PoC reusable
workflow enforces the exact origin and OpenAPI scan; session injection and import
automation are Partial.
