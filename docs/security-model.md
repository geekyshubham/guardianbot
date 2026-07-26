# Security model

Assets are GitHub installation tokens, repository contents, review evidence,
backend credentials, scanner artifacts, signing identity, and staging sessions.

Controls:

- App tokens are installation-scoped and short lived. Webhooks use HMAC SHA-256 and
  delivery replay protection.
- Repository text is untrusted. It cannot choose a backend URL, credential, model
  ID, or tool. Context is size bounded and repository/commit scoped.
- Models receive no tools or credentials. Results are discarded unless schema,
  request ID, head SHA, changed line, count, and fingerprint checks pass.
- Consumer repositories store no GuardianBot infrastructure secret.
- Scanner evidence, not AI severity, drives blocking.
- DAST requires an exact HTTPS staging allowlist and safe routes.
- Image promotion uses digest, keyless workflow identity, and CycloneDX evidence.
- PostgreSQL and DefectDojo remain private on DigitalOcean networks.

Primary threats include prompt injection in code, malicious PR workflows, webhook
forgery/replay, cross-repository leakage, compromised bridge output, scanner
evidence deletion, staging-to-production confusion, and supply-chain tag movement.
Residual PoC risks are listed in [status](status.md); live hardening requires secret
rotation, queue isolation, backups, rate limits, audit export, and incident drills.
