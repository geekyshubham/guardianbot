# Monitoring reconciliation

Use this runbook when GuardianBot reports `missing-expected-runs`,
evidence-freshness drift, or repository inventory divergence.

1. Capture the affected repository, workflow/check key, branch, expected cadence,
   and the last successful observed run or import.
2. Verify whether the repository is intentionally advisory-only or not applicable
   before treating the gap as an incident.
3. Compare expected runs with GitHub workflow history, the latest repository
   index timestamp, and the latest DefectDojo/image evidence timestamps.
4. Preserve the failing evidence set and classify the gap as one of:
   configuration drift, scheduler gap, import failure, stale index, or stale
   image/deployment evidence.
5. Repair the source system first, then rerun the missing workflow/import rather
   than manually mutating monitoring state.
6. Record the restoration time and any period where enforcement or weekly
   reporting may have been incomplete.

Failure policy:

- Missing required runs remain visible as `missing-expected-runs`.
- Stale but previously successful runs downgrade to warning until the configured
  failure window expires.
- Invalid timestamps or digest mismatches fail closed.
