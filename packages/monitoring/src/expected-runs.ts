import type { MonitoringClock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { MonitoringCheckResult, MonitoringStatus } from "./status.js";
import { worstMonitoringStatus } from "./status.js";

export type WorkflowEvent = "pull_request" | "push" | "schedule" | "workflow_dispatch";
export type WorkflowConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped";
export type WorkflowRunStatus = "queued" | "in_progress" | "completed";

export interface ExpectedWorkflowRun {
  key: string;
  workflow: string;
  event: WorkflowEvent;
  branch?: string;
  required: boolean;
  maxAgeMs: number;
  description?: string;
}

export interface ObservedWorkflowRun {
  workflow: string;
  event: string;
  branch?: string;
  startedAt: string;
  completedAt?: string;
  status: WorkflowRunStatus;
  conclusion?: WorkflowConclusion;
  url?: string;
}

export interface ExpectedRunReconciliation {
  status: MonitoringStatus;
  checks: MonitoringCheckResult[];
  missingRequiredCount: number;
  failingCount: number;
  warningCount: number;
}

function runMetadata(
  expected: ExpectedWorkflowRun,
  run?: ObservedWorkflowRun | null
): Record<string, boolean | number | string | null> {
  return {
    workflow: expected.workflow,
    event: expected.event,
    branch: expected.branch ?? null,
    required: expected.required,
    status: run?.status ?? null,
    conclusion: run?.conclusion ?? null,
    url: run?.url ?? null
  };
}

function timestampForRun(run: ObservedWorkflowRun): number {
  const value = new Date(run.completedAt ?? run.startedAt).getTime();
  return Number.isNaN(value) ? -1 : value;
}

function latestMatchingRun(
  expected: ExpectedWorkflowRun,
  observed: ObservedWorkflowRun[]
): ObservedWorkflowRun | null {
  const matches = observed.filter(
    (run) =>
      run.workflow === expected.workflow &&
      run.event === expected.event &&
      (expected.branch ? run.branch === expected.branch : true)
  );
  if (!matches.length) return null;
  return matches.sort((left, right) => timestampForRun(right) - timestampForRun(left))[0] ?? null;
}

export function reconcileExpectedRuns(
  expected: ExpectedWorkflowRun[],
  observed: ObservedWorkflowRun[],
  clock: MonitoringClock = systemClock
): ExpectedRunReconciliation {
  const checks = expected.map((item) => {
    const run = latestMatchingRun(item, observed);
    if (!run) {
      return {
        key: item.key,
        status: item.required ? "failing" : "warning",
        summary: item.required
          ? `Expected ${item.workflow} ${item.event} run is missing`
          : `Optional ${item.workflow} ${item.event} run has not executed`,
        metadata: runMetadata(item)
      } satisfies MonitoringCheckResult;
    }

    const observedAt = run.completedAt ?? run.startedAt;
    const ageMs = Math.max(0, clock.now().getTime() - new Date(observedAt).getTime());
    if (run.status !== "completed") {
      return {
        key: item.key,
        status: ageMs > item.maxAgeMs ? "failing" : "warning",
        summary:
          ageMs > item.maxAgeMs
            ? `${item.workflow} ${item.event} run is still in progress past its freshness window`
            : `${item.workflow} ${item.event} run is still in progress`,
        observedAt,
        ageMs,
        metadata: runMetadata(item, run)
      } satisfies MonitoringCheckResult;
    }

    if (run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped") {
      return {
        key: item.key,
        status: "failing",
        summary: `${item.workflow} ${item.event} run concluded ${run.conclusion ?? "unknown"}`,
        observedAt,
        ageMs,
        metadata: runMetadata(item, run)
      } satisfies MonitoringCheckResult;
    }

    if (ageMs > item.maxAgeMs) {
      return {
        key: item.key,
        status: item.required ? "warning" : "not-applicable",
        summary: `${item.workflow} ${item.event} run is stale`,
        observedAt,
        ageMs,
        metadata: runMetadata(item, run)
      } satisfies MonitoringCheckResult;
    }

    return {
      key: item.key,
      status: "passing",
      summary: `${item.workflow} ${item.event} run is current`,
      observedAt,
      ageMs,
      metadata: runMetadata(item, run)
    } satisfies MonitoringCheckResult;
  });

  return {
    status: worstMonitoringStatus(checks.map((check) => check.status)),
    checks,
    missingRequiredCount: checks.filter(
      (check) => check.status === "failing" && check.summary.startsWith("Expected ")
    ).length,
    failingCount: checks.filter((check) => check.status === "failing").length,
    warningCount: checks.filter((check) => check.status === "warning").length
  };
}
