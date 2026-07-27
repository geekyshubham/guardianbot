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
    return {
      ...freshness,
      status: "warning",
      summary: "Repository index is fresh but trails the expected commit",
      metadata: {
        ...(freshness.metadata ?? {}),
        expectedCommitSha: input.expectedCommitSha,
        indexedCommitSha: input.indexedCommitSha
      }
    };
  }

  return {
    ...freshness,
    metadata: {
      ...(freshness.metadata ?? {}),
      expectedCommitSha: input.expectedCommitSha ?? null,
      indexedCommitSha: input.indexedCommitSha ?? null
    }
  };
}
