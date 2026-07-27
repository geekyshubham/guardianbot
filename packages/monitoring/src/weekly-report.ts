import type { RepositoryInventoryState } from "./status.js";

export interface RepositoryWeeklyMetrics {
  repository: string;
  visibility: "public" | "private";
  inventoryState: RepositoryInventoryState;
  review: {
    prsReviewed: number;
    advisoryFindingsOpened: number;
    advisoryFindingsAccepted: number;
    advisoryFindingsDismissed: number;
    advisoryFindingsResolved: number;
    deterministicBlockersOpened: number;
    bridgeFailures: number;
    partialReviews: number;
    latencySamplesMs?: number[];
    inputUnits?: number;
    outputUnits?: number;
    estimatedCostUsd?: number;
  };
  scanner: {
    expectedRuns: number;
    successfulRuns: number;
    evidenceCompleteRuns: number;
    missingEvidenceAlerts: number;
    importLagSamplesMs?: number[];
  };
  monitoring: {
    freshIndexes: number;
    staleIndexes: number;
    expiredSuppressions: number;
    expiringSuppressions: number;
    protectedDigests: number;
    completeEvidenceDigests: number;
    missingEvidenceDigests: number;
  };
}

export interface WeeklyCoverageReport {
  periodStart: string;
  periodEnd: string;
  totalRepositories: number;
  visibilityBreakdown: Record<"public" | "private", number>;
  inventoryStates: Record<RepositoryInventoryState, number>;
  review: {
    prsReviewed: number;
    advisoryFindingsOpened: number;
    advisoryFindingsAccepted: number;
    advisoryFindingsDismissed: number;
    advisoryFindingsResolved: number;
    deterministicBlockersOpened: number;
    bridgeFailures: number;
    partialReviews: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    inputUnits: number;
    outputUnits: number;
    estimatedCostUsd: number;
  };
  scanner: {
    expectedRuns: number;
    successfulRuns: number;
    evidenceCompleteRuns: number;
    missingEvidenceAlerts: number;
    importLagP50Ms: number;
    importLagP95Ms: number;
  };
  monitoring: {
    freshIndexes: number;
    staleIndexes: number;
    expiredSuppressions: number;
    expiringSuppressions: number;
    protectedDigests: number;
    completeEvidenceDigests: number;
    missingEvidenceDigests: number;
  };
}

function sum(values: Iterable<number | undefined>): number {
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}

function quantile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index] ?? 0;
}

export function buildWeeklyCoverageReport(input: {
  periodStart: string;
  periodEnd: string;
  repositories: RepositoryWeeklyMetrics[];
}): WeeklyCoverageReport {
  const start = new Date(input.periodStart);
  const end = new Date(input.periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Weekly coverage report requires a valid increasing time range");
  }
  const durationMs = end.getTime() - start.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (durationMs > sevenDaysMs + 60_000) {
    throw new Error("Weekly coverage report cannot exceed seven days");
  }

  const visibilityBreakdown = { public: 0, private: 0 };
  const inventoryStates: WeeklyCoverageReport["inventoryStates"] = {
    enforced: 0,
    "report-only": 0,
    "advisory-only": 0,
    "not-applicable": 0,
    misconfigured: 0,
    "missing-expected-runs": 0
  };
  const latencySamples: number[] = [];
  const importLagSamples: number[] = [];

  for (const repository of input.repositories) {
    visibilityBreakdown[repository.visibility] += 1;
    inventoryStates[repository.inventoryState] += 1;
    latencySamples.push(...(repository.review.latencySamplesMs ?? []));
    importLagSamples.push(...(repository.scanner.importLagSamplesMs ?? []));
  }

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalRepositories: input.repositories.length,
    visibilityBreakdown,
    inventoryStates,
    review: {
      prsReviewed: sum(input.repositories.map((repository) => repository.review.prsReviewed)),
      advisoryFindingsOpened: sum(
        input.repositories.map((repository) => repository.review.advisoryFindingsOpened)
      ),
      advisoryFindingsAccepted: sum(
        input.repositories.map((repository) => repository.review.advisoryFindingsAccepted)
      ),
      advisoryFindingsDismissed: sum(
        input.repositories.map((repository) => repository.review.advisoryFindingsDismissed)
      ),
      advisoryFindingsResolved: sum(
        input.repositories.map((repository) => repository.review.advisoryFindingsResolved)
      ),
      deterministicBlockersOpened: sum(
        input.repositories.map((repository) => repository.review.deterministicBlockersOpened)
      ),
      bridgeFailures: sum(input.repositories.map((repository) => repository.review.bridgeFailures)),
      partialReviews: sum(input.repositories.map((repository) => repository.review.partialReviews)),
      latencyP50Ms: quantile(latencySamples, 0.5),
      latencyP95Ms: quantile(latencySamples, 0.95),
      inputUnits: sum(input.repositories.map((repository) => repository.review.inputUnits)),
      outputUnits: sum(input.repositories.map((repository) => repository.review.outputUnits)),
      estimatedCostUsd: Number(
        sum(input.repositories.map((repository) => repository.review.estimatedCostUsd)).toFixed(4)
      )
    },
    scanner: {
      expectedRuns: sum(input.repositories.map((repository) => repository.scanner.expectedRuns)),
      successfulRuns: sum(input.repositories.map((repository) => repository.scanner.successfulRuns)),
      evidenceCompleteRuns: sum(
        input.repositories.map((repository) => repository.scanner.evidenceCompleteRuns)
      ),
      missingEvidenceAlerts: sum(
        input.repositories.map((repository) => repository.scanner.missingEvidenceAlerts)
      ),
      importLagP50Ms: quantile(importLagSamples, 0.5),
      importLagP95Ms: quantile(importLagSamples, 0.95)
    },
    monitoring: {
      freshIndexes: sum(input.repositories.map((repository) => repository.monitoring.freshIndexes)),
      staleIndexes: sum(input.repositories.map((repository) => repository.monitoring.staleIndexes)),
      expiredSuppressions: sum(
        input.repositories.map((repository) => repository.monitoring.expiredSuppressions)
      ),
      expiringSuppressions: sum(
        input.repositories.map((repository) => repository.monitoring.expiringSuppressions)
      ),
      protectedDigests: sum(
        input.repositories.map((repository) => repository.monitoring.protectedDigests)
      ),
      completeEvidenceDigests: sum(
        input.repositories.map((repository) => repository.monitoring.completeEvidenceDigests)
      ),
      missingEvidenceDigests: sum(
        input.repositories.map((repository) => repository.monitoring.missingEvidenceDigests)
      )
    }
  };
}
