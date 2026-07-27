# Monitoring evidence gap

Use this runbook when SBOM, signature, deployment, scan, or DefectDojo import
evidence is absent, stale, or bound to the wrong digest.

1. Identify the expected immutable digest or repository artifact subject.
2. Confirm whether the missing evidence is required for that repository type.
   Repositories without containers remain `not applicable` for image evidence.
3. Check whether the latest evidence item failed, went stale, or was produced
   for a different digest/environment pair.
4. Recreate evidence by rerunning the owning workflow or import path. Do not
   create synthetic evidence rows.
5. If deployment evidence references a different digest than the signed image,
   treat it as an integrity incident until promotion records align again.
6. Keep the evidence timeline with observed timestamps, digest, environment, and
   corrective action in the incident record.

Failure policy:

- Missing required evidence fails deterministic monitoring.
- Stale required evidence warns first, then escalates based on repository policy.
- Digest mismatch fails immediately.
