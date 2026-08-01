import type { MonitoringClock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { MonitoringCheckResult } from "./status.js";

export interface FreshnessInput {
  key: string;
  label: string;
  observedAt?: string | null;
  warnAfterMs: number;
  failAfterMs: number;
  missingSummary?: string;
}

export function evaluateFreshness(
  input: FreshnessInput,
  clock: MonitoringClock = systemClock
): MonitoringCheckResult {
  if (!input.observedAt) {
    return {
      key: input.key,
      status: "failing",
      summary: input.missingSummary ?? `${input.label} has never been observed`
    };
  }

  const observed = new Date(input.observedAt);
  if (Number.isNaN(observed.getTime())) {
    return {
      key: input.key,
      status: "failing",
      summary: `${input.label} timestamp is invalid`,
      observedAt: input.observedAt
    };
  }

  const ageMs = Math.max(0, clock.now().getTime() - observed.getTime());
  if (ageMs >= input.failAfterMs) {
    return {
      key: input.key,
      status: "failing",
      summary: `${input.label} is stale`,
      observedAt: observed.toISOString(),
      ageMs
    };
  }
  if (ageMs >= input.warnAfterMs) {
    return {
      key: input.key,
      status: "warning",
      summary: `${input.label} is nearing freshness expiry`,
      observedAt: observed.toISOString(),
      ageMs
    };
  }
  return {
    key: input.key,
    status: "passing",
    summary: `${input.label} is fresh`,
    observedAt: observed.toISOString(),
    ageMs
  };
}

export interface IndexFreshnessInput {
  indexedAt?: string | null;
  warnAfterMs: number;
  failAfterMs: number;
  expectedCommitSha?: string | null;
  indexedCommitSha?: string | null;
  /**
   * Fraction of indexable files the published index does not cover, 0-1. A fresh
   * index at the expected commit can still be a poor index if most of the
   * repository was dropped by a cap, so coverage is reported independently of age.
   */
  truncationRatio?: number | null;
  /** Ratio at or above which under-indexing is reported as a warning. */
  truncationWarnRatio?: number;
}

/**
 * Under-indexing is invisible in an age-based check: a repository truncated to a
 * fraction of its files still looks perfectly fresh. This reports the ratio as
 * check metadata always, and raises a warning once it crosses the threshold, so
 * the gap is legible without changing how staleness is judged.
 */
function withIndexCoverage(
  check: MonitoringCheckResult,
  input: IndexFreshnessInput
): MonitoringCheckResult {
  const ratio = input.truncationRatio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) {
    return check;
  }
  const bounded = Math.min(Math.max(ratio, 0), 1);
  const warnRatio = input.truncationWarnRatio ?? 0.1;
  const metadata = { ...(check.metadata ?? {}), truncationRatio: bounded };
  if (check.status === "failing" || bounded < warnRatio) {
    return { ...check, metadata };
  }
  return {
    ...check,
    status: "warning",
    summary: `${check.summary}; index covers only ${Math.round((1 - bounded) * 100)}% of indexable files`,
    metadata
  };
}

export function evaluateIndexFreshness(
  input: IndexFreshnessInput,
  clock: MonitoringClock = systemClock
): MonitoringCheckResult {
  const freshness = evaluateFreshness(
    {
      key: "index-freshness",
      label: "Repository index",
      observedAt: input.indexedAt,
      warnAfterMs: input.warnAfterMs,
      failAfterMs: input.failAfterMs,
      missingSummary: "Repository index has not been built"
    },
    clock
  );

  if (
    freshness.status !== "failing" &&
    input.expectedCommitSha &&
    input.indexedCommitSha &&
    input.expectedCommitSha !== input.indexedCommitSha
  ) {
    return withIndexCoverage(
      {
        ...freshness,
        status: "warning",
        summary: "Repository index is fresh but trails the expected commit",
        metadata: {
          ...(freshness.metadata ?? {}),
          expectedCommitSha: input.expectedCommitSha,
          indexedCommitSha: input.indexedCommitSha
        }
      },
      input
    );
  }

  return withIndexCoverage(
    {
      ...freshness,
      metadata: {
        ...(freshness.metadata ?? {}),
        expectedCommitSha: input.expectedCommitSha ?? null,
        indexedCommitSha: input.indexedCommitSha ?? null
      }
    },
    input
  );
}
