import type { RepositoryInventoryState } from "./status.js";

/**
 * Review-value outcome counts for one advisory category. `fixed` is GuardianBot's accepted signal:
 * the finding stopped being reported after a verified incremental change rewrote its lines.
 * `dismissed` is an explicit human command. `ignored` is a finding still open when its pull
 * request merged. `unresolved` is a point-in-time count of findings still open with no outcome.
 */
export interface ReviewValueCounts {
  fixed: number;
  dismissed: number;
  ignored: number;
  unresolved: number;
}

export interface ReviewValueStats extends ReviewValueCounts {
  /** fixed / (fixed + dismissed), or null when that sample is empty rather than a misleading 0. */
  precision: number | null;
  /** fixed + dismissed: the explicit-signal sample `precision` is computed over. */
  sampleSize: number;
}

export interface ReviewValueSummary {
  totals: ReviewValueStats;
  byCategory: Record<string, ReviewValueStats>;
  repositories: Array<{
    repository: string;
    totals: ReviewValueStats;
    byCategory: Record<string, ReviewValueStats>;
  }>;
}

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
  /**
   * Per-category review-value counts derived from retained finding records. Absent when nothing
   * was measured for this repository, which is a different claim from measured-and-zero.
   */
  reviewValue?: { byCategory: Record<string, ReviewValueCounts> };
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
  /**
   * Present only when at least one repository supplied measured review-value counts, so a report
   * built from inputs that never measured them is byte-identical to the report before this field
   * existed.
   */
  reviewValue?: ReviewValueSummary;
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

const REVIEW_VALUE_CATEGORY = /^[a-z][a-z-]{0,31}$/;

function emptyCounts(): ReviewValueCounts {
  return { fixed: 0, dismissed: 0, ignored: 0, unresolved: 0 };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function addCounts(target: ReviewValueCounts, source: ReviewValueCounts): void {
  target.fixed += count(source.fixed);
  target.dismissed += count(source.dismissed);
  target.ignored += count(source.ignored);
  target.unresolved += count(source.unresolved);
}

/** Exposed so every consumer derives precision the same way, including the empty-sample rule. */
export function reviewValueStats(counts: ReviewValueCounts): ReviewValueStats {
  const sampleSize = counts.fixed + counts.dismissed;
  return {
    fixed: counts.fixed,
    dismissed: counts.dismissed,
    ignored: counts.ignored,
    unresolved: counts.unresolved,
    precision: sampleSize ? Number((counts.fixed / sampleSize).toFixed(4)) : null,
    sampleSize
  };
}

/**
 * Category keys arrive from retained finding records, so they are re-bounded here: anything that
 * is not a short lowercase slug collapses into `other` rather than becoming a report key.
 */
function reviewValueCategory(category: string): string {
  return REVIEW_VALUE_CATEGORY.test(category) ? category : "other";
}

function sortedStats(byCategory: Map<string, ReviewValueCounts>): Record<string, ReviewValueStats> {
  return Object.fromEntries(
    [...byCategory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, counts]) => [category, reviewValueStats(counts)])
  );
}

function buildReviewValueSummary(
  repositories: readonly RepositoryWeeklyMetrics[]
): ReviewValueSummary | undefined {
  const measured = repositories.filter((repository) => repository.reviewValue);
  if (!measured.length) return undefined;
  const totals = emptyCounts();
  const byCategory = new Map<string, ReviewValueCounts>();
  const perRepository: ReviewValueSummary["repositories"] = [];
  for (const repository of [...measured].sort((left, right) =>
    left.repository.localeCompare(right.repository)
  )) {
    const repositoryTotals = emptyCounts();
    const repositoryCategories = new Map<string, ReviewValueCounts>();
    for (const [rawCategory, counts] of Object.entries(
      repository.reviewValue?.byCategory ?? {}
    )) {
      const category = reviewValueCategory(rawCategory);
      const repositoryCategory = repositoryCategories.get(category) ?? emptyCounts();
      addCounts(repositoryCategory, counts);
      repositoryCategories.set(category, repositoryCategory);
      const fleetCategory = byCategory.get(category) ?? emptyCounts();
      addCounts(fleetCategory, counts);
      byCategory.set(category, fleetCategory);
      addCounts(repositoryTotals, counts);
    }
    addCounts(totals, repositoryTotals);
    perRepository.push({
      repository: repository.repository,
      totals: reviewValueStats(repositoryTotals),
      byCategory: sortedStats(repositoryCategories)
    });
  }
  return {
    totals: reviewValueStats(totals),
    byCategory: sortedStats(byCategory),
    repositories: perRepository
  };
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

  const reviewValue = buildReviewValueSummary(input.repositories);

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
    ...(reviewValue ? { reviewValue } : {}),
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
