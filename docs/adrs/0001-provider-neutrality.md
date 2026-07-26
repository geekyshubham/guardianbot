# ADR 0001: Provider-neutral model boundary

Status: Accepted.

GuardianBot speaks only `guardian.review.v1`. Bridges own provider translation,
credentials, structured-output configuration, and administrative profile mapping.
This keeps repository configuration portable and prevents provider SDKs or model
names from entering the control plane.
