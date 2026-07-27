import type { MonitoringClock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { EvidenceRecord, EvidenceRequirement, EvidenceReconciliation, ImageEvidenceInput } from "./evidence.js";
import { evaluateImageEvidence, reconcileEvidence } from "./evidence.js";
import type { ExpectedRunReconciliation, ExpectedWorkflowRun, ObservedWorkflowRun } from "./expected-runs.js";
import { reconcileExpectedRuns } from "./expected-runs.js";
import type { IndexFreshnessInput } from "./freshness.js";
import { evaluateIndexFreshness } from "./freshness.js";
import type { MonitoringCheckResult, MonitoringStatus, RepositoryInventoryState } from "./status.js";
import { worstMonitoringStatus } from "./status.js";
import type { SuppressionEvaluation, SuppressionRecord } from "./suppressions.js";
import { evaluateSuppressions } from "./suppressions.js";

export type ScannerMode = "advisory" | "report-only" | "enforce";

export interface RepositoryMonitoringInput {
  repository: {
    key: string;
    reviewEnabled: boolean;
    configValid: boolean;
    scannerMode: ScannerMode;
    deterministicApplicable: boolean;
    baselineReady?: boolean;
  };
  expectedRuns?: {
    expected: ExpectedWorkflowRun[];
    observed: ObservedWorkflowRun[];
  };
  index?: IndexFreshnessInput;
  evidence?: {
    requirements: EvidenceRequirement[];
    observed: EvidenceRecord[];
  };
  image?: ImageEvidenceInput | null;
  suppressions?: {
    records: SuppressionRecord[];
    notifyBeforeMs: number;
  };
}

export interface RepositoryMonitoringSnapshot {
  repository: string;
  inventoryState: RepositoryInventoryState;
  overallStatus: MonitoringStatus;
  checks: MonitoringCheckResult[];
  expectedRuns?: ExpectedRunReconciliation;
  evidence?: EvidenceReconciliation;
  suppressions?: SuppressionEvaluation;
}

export function classifyRepositoryInventoryState(input: {
  configValid: boolean;
  deterministicApplicable: boolean;
  reviewEnabled: boolean;
  scannerMode: ScannerMode;
  baselineReady?: boolean;
  expectedRunsStatus?: ExpectedRunReconciliation["status"];
  missingExpectedRuns?: number;
  evidenceStatus?: EvidenceReconciliation["status"];
  imageStatus?: MonitoringStatus;
  indexStatus?: MonitoringStatus;
}): RepositoryInventoryState {
  if (!input.configValid) {
    return "misconfigured";
  }
  if (!input.deterministicApplicable && !input.reviewEnabled) {
    return "not-applicable";
  }
  if ((input.missingExpectedRuns ?? 0) > 0) {
    return "missing-expected-runs";
  }
  if (input.scannerMode === "enforce" && input.baselineReady === false) {
    return "misconfigured";
  }
  if (input.scannerMode === "enforce") {
    const blockingStatuses = [
      input.expectedRunsStatus,
      input.evidenceStatus,
      input.imageStatus,
      input.indexStatus
    ].filter((value): value is MonitoringStatus => Boolean(value));
    return blockingStatuses.includes("failing") ? "misconfigured" : "enforced";
  }
  if (input.scannerMode === "report-only" && input.deterministicApplicable) {
    return "report-only";
  }
  return "advisory-only";
}

export function evaluateRepositoryMonitoring(
  input: RepositoryMonitoringInput,
  clock: MonitoringClock = systemClock
): RepositoryMonitoringSnapshot {
  const checks: MonitoringCheckResult[] = [];

  const expectedRuns = input.expectedRuns
    ? reconcileExpectedRuns(input.expectedRuns.expected, input.expectedRuns.observed, clock)
    : undefined;
  if (expectedRuns) checks.push(...expectedRuns.checks);

  const indexCheck = input.index ? evaluateIndexFreshness(input.index, clock) : undefined;
  if (indexCheck) checks.push(indexCheck);

  const evidence = input.evidence
    ? reconcileEvidence(input.evidence.requirements, input.evidence.observed, clock)
    : undefined;
  if (evidence) checks.push(...evidence.checks);

  const image = input.image ? evaluateImageEvidence(input.image, clock) : undefined;
  if (image) checks.push(...image.checks);

  const suppressions = input.suppressions
    ? evaluateSuppressions(input.suppressions.records, { notifyBeforeMs: input.suppressions.notifyBeforeMs }, clock)
    : undefined;
  if (suppressions) checks.push(suppressions.check);

  const inventoryState = classifyRepositoryInventoryState({
    configValid: input.repository.configValid,
    deterministicApplicable: input.repository.deterministicApplicable,
    reviewEnabled: input.repository.reviewEnabled,
    scannerMode: input.repository.scannerMode,
    baselineReady: input.repository.baselineReady,
    expectedRunsStatus: expectedRuns?.status,
    missingExpectedRuns: expectedRuns?.missingRequiredCount,
    evidenceStatus: evidence?.status,
    imageStatus: image?.status,
    indexStatus: indexCheck?.status
  });

  return {
    repository: input.repository.key,
    inventoryState,
    overallStatus: worstMonitoringStatus(checks.map((check) => check.status)),
    checks,
    expectedRuns,
    evidence,
    suppressions
  };
}
