# Monitoring weekly report

The weekly report is a rollup, not a source of truth. Build it from deterministic
repository snapshots and bounded review/scanner metrics only.

1. Use a period no longer than seven days.
2. Aggregate inventory states, review latency, bridge failures, expected-run
   coverage, evidence completeness, import lag, stale indexes, suppression
   counts, and protected digest coverage.
3. Keep AI advisory metrics separate from deterministic gate metrics.
4. Separate public and private repository counts. Never include repository text
   or prompt content in labels or exported report fields.
5. If the report omits repositories because reconciliation data is missing,
   declare the omission and repair monitoring before using the report for
   release-quality claims.

Failure policy:

- Invalid period ranges fail closed.
- Reports spanning more than seven days are rejected.
- Missing latency or import-lag samples render percentile outputs as `0` rather
  than invented estimates.
