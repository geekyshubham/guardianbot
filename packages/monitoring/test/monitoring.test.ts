import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWeeklyCoverageReport,
  classifyRepositoryInventoryState,
  evaluateFreshness,
  evaluateImageEvidence,
  evaluateIndexFreshness,
  evaluateRepositoryMonitoring,
  evaluateSuppressions,
  fixedClock,
  reconcileExpectedRuns,
  reviewValueStats,
  reconcileEvidence,
  worstMonitoringStatus
} from "../src/index.js";

const clock = fixedClock("2026-07-27T10:00:00.000Z");

test("evaluateFreshness fails closed when evidence is missing", () => {
  const result = evaluateFreshness(
    {
      key: "imports",
      label: "DefectDojo import",
      observedAt: null,
      warnAfterMs: 60_000,
      failAfterMs: 120_000
    },
    clock
  );
  assert.equal(result.status, "failing");
});

test("evaluateIndexFreshness warns on commit drift", () => {
  const result = evaluateIndexFreshness(
    {
      indexedAt: "2026-07-27T09:55:00.000Z",
      warnAfterMs: 10 * 60_000,
      failAfterMs: 20 * 60_000,
      indexedCommitSha: "a".repeat(40),
      expectedCommitSha: "b".repeat(40)
    },
    clock
  );
  assert.equal(result.status, "warning");
  assert.equal(result.metadata?.indexedCommitSha, "a".repeat(40));
});

test("reconcileExpectedRuns reports missing required and stale optional runs deterministically", () => {
  const result = reconcileExpectedRuns(
    [
      {
        key: "pr-gate",
        workflow: "guardianbot/security-gate",
        event: "pull_request",
        branch: "main",
        required: true,
        maxAgeMs: 60 * 60_000
      },
      {
        key: "nightly",
        workflow: "guardianbot/security-gate",
        event: "schedule",
        required: false,
        maxAgeMs: 12 * 60 * 60_000
      }
    ],
    [
      {
        workflow: "guardianbot/security-gate",
        event: "schedule",
        startedAt: "2026-07-26T00:00:00.000Z",
        completedAt: "2026-07-26T00:30:00.000Z",
        status: "completed",
        conclusion: "success"
      }
    ],
    clock
  );
  assert.equal(result.missingRequiredCount, 1);
  assert.equal(result.checks[0]?.status, "failing");
  assert.equal(result.checks[1]?.status, "not-applicable");
});

test("reconcileEvidence validates digest-scoped evidence freshness", () => {
  const result = reconcileEvidence(
    [
      {
        key: "sbom",
        kind: "sbom",
        required: true,
        maxAgeMs: 60 * 60_000,
        digest: "sha256:abc",
        environment: "staging"
      }
    ],
    [
      {
        kind: "sbom",
        observedAt: "2026-07-27T09:40:00.000Z",
        status: "success",
        digest: "sha256:abc",
        environment: "staging"
      }
    ],
    clock
  );
  assert.equal(result.status, "passing");
});

test("reconcileEvidence keeps evidence identity separate from the artifact digest", () => {
  const result = reconcileEvidence(
    [
      {
        key: "deployment",
        kind: "deployment",
        evidenceKey: "image-promotion:deployment:staging",
        required: true,
        maxAgeMs: 60 * 60_000,
        digest: "sha256:expected",
        environment: "staging"
      }
    ],
    [
      {
        kind: "deployment",
        evidenceKey: "image-promotion:deployment:other",
        observedAt: "2026-07-27T09:40:00.000Z",
        status: "success",
        digest: "sha256:expected",
        environment: "staging"
      },
      {
        kind: "deployment",
        evidenceKey: "image-promotion:deployment:staging",
        observedAt: "2026-07-27T09:41:00.000Z",
        status: "success",
        digest: "sha256:wrong",
        environment: "staging"
      }
    ],
    clock
  );
  assert.equal(result.status, "failing");
  assert.equal(result.missingCount, 1);
});

test("evaluateImageEvidence fails on deployed digest drift", () => {
  const result = evaluateImageEvidence(
    {
      digest: "sha256:expected",
      deployedDigest: "sha256:actual",
      environment: "staging",
      sbomMaxAgeMs: 60 * 60_000,
      signatureMaxAgeMs: 60 * 60_000,
      deploymentMaxAgeMs: 60 * 60_000,
      evidence: []
    },
    clock
  );
  assert.equal(result.status, "failing");
  assert.equal(result.checks[0]?.key, "deployed-digest");
});

test("evaluateSuppressions distinguishes expired open findings from upcoming expiries", () => {
  const result = evaluateSuppressions(
    [
      {
        fingerprint: "a",
        owner: "team-a",
        reason: "pending fix",
        ticket: "SEC-1",
        expiresAt: "2026-07-27T09:59:00.000Z",
        findingOpen: true
      },
      {
        fingerprint: "b",
        owner: "team-b",
        reason: "scheduled change",
        ticket: "SEC-2",
        expiresAt: "2026-07-27T10:30:00.000Z"
      }
    ],
    { notifyBeforeMs: 60 * 60_000 },
    clock
  );
  assert.equal(result.status, "failing");
  assert.equal(result.expired.length, 1);
  assert.equal(result.expiringSoon.length, 1);
});

test("classifyRepositoryInventoryState separates missing runs from enforced repositories", () => {
  assert.equal(
    classifyRepositoryInventoryState({
      configValid: true,
      deterministicApplicable: true,
      reviewEnabled: true,
      scannerMode: "report-only",
      missingExpectedRuns: 1
    }),
    "missing-expected-runs"
  );
  assert.equal(
    classifyRepositoryInventoryState({
      configValid: true,
      deterministicApplicable: true,
      reviewEnabled: true,
      scannerMode: "enforce",
      baselineReady: true,
      expectedRunsStatus: "passing",
      evidenceStatus: "passing",
      imageStatus: "passing",
      indexStatus: "passing"
    }),
    "enforced"
  );
});

test("evaluateRepositoryMonitoring aggregates checks for scheduler wiring", () => {
  const result = evaluateRepositoryMonitoring(
    {
      repository: {
        key: "acme/api",
        reviewEnabled: true,
        configValid: true,
        scannerMode: "report-only",
        deterministicApplicable: true,
        baselineReady: true
      },
      expectedRuns: {
        expected: [
          {
            key: "nightly",
            workflow: "guardianbot/security-gate",
            event: "schedule",
            required: true,
            maxAgeMs: 48 * 60 * 60_000
          }
        ],
        observed: [
          {
            workflow: "guardianbot/security-gate",
            event: "schedule",
            startedAt: "2026-07-27T08:00:00.000Z",
            completedAt: "2026-07-27T08:20:00.000Z",
            status: "completed",
            conclusion: "success"
          }
        ]
      },
      index: {
        indexedAt: "2026-07-27T09:50:00.000Z",
        warnAfterMs: 6 * 60 * 60_000,
        failAfterMs: 24 * 60 * 60_000
      },
      evidence: {
        requirements: [
          {
            key: "import",
            kind: "defectdojo-import",
            required: true,
            maxAgeMs: 24 * 60 * 60_000
          }
        ],
        observed: [
          {
            kind: "defectdojo-import",
            observedAt: "2026-07-27T09:00:00.000Z",
            status: "success"
          }
        ]
      },
      suppressions: {
        records: [],
        notifyBeforeMs: 60 * 60_000
      }
    },
    clock
  );
  assert.equal(result.inventoryState, "report-only");
  assert.equal(result.overallStatus, "passing");
  assert.equal(result.checks.length, 4);
});

test("buildWeeklyCoverageReport aggregates state and latency percentiles", () => {
  const report = buildWeeklyCoverageReport({
    periodStart: "2026-07-20T10:00:00.000Z",
    periodEnd: "2026-07-27T10:00:00.000Z",
    repositories: [
      {
        repository: "acme/api",
        visibility: "private",
        inventoryState: "enforced",
        review: {
          prsReviewed: 4,
          advisoryFindingsOpened: 3,
          advisoryFindingsAccepted: 1,
          advisoryFindingsDismissed: 1,
          advisoryFindingsResolved: 2,
          deterministicBlockersOpened: 1,
          bridgeFailures: 0,
          partialReviews: 1,
          latencySamplesMs: [3000, 5000, 7000],
          inputUnits: 1000,
          outputUnits: 200,
          estimatedCostUsd: 0.42
        },
        scanner: {
          expectedRuns: 7,
          successfulRuns: 6,
          evidenceCompleteRuns: 5,
          missingEvidenceAlerts: 1,
          importLagSamplesMs: [1000, 2000]
        },
        monitoring: {
          freshIndexes: 1,
          staleIndexes: 0,
          expiredSuppressions: 0,
          expiringSuppressions: 1,
          protectedDigests: 2,
          completeEvidenceDigests: 2,
          missingEvidenceDigests: 0
        }
      },
      {
        repository: "acme/docs",
        visibility: "public",
        inventoryState: "advisory-only",
        review: {
          prsReviewed: 2,
          advisoryFindingsOpened: 1,
          advisoryFindingsAccepted: 1,
          advisoryFindingsDismissed: 0,
          advisoryFindingsResolved: 1,
          deterministicBlockersOpened: 0,
          bridgeFailures: 1,
          partialReviews: 0,
          latencySamplesMs: [2000, 9000]
        },
        scanner: {
          expectedRuns: 0,
          successfulRuns: 0,
          evidenceCompleteRuns: 0,
          missingEvidenceAlerts: 0,
          importLagSamplesMs: []
        },
        monitoring: {
          freshIndexes: 1,
          staleIndexes: 0,
          expiredSuppressions: 0,
          expiringSuppressions: 0,
          protectedDigests: 0,
          completeEvidenceDigests: 0,
          missingEvidenceDigests: 0
        }
      }
    ]
  });
  assert.equal(report.totalRepositories, 2);
  assert.equal(report.inventoryStates.enforced, 1);
  assert.equal(report.inventoryStates["advisory-only"], 1);
  assert.equal(report.review.prsReviewed, 6);
  assert.equal(report.review.latencyP50Ms, 5000);
  assert.equal(report.review.latencyP95Ms, 9000);
});

test("worstMonitoringStatus prefers failing over warning and passing", () => {
  assert.equal(worstMonitoringStatus(["passing", "warning", "failing"]), "failing");
});

test("evaluateIndexFreshness surfaces the truncation ratio so under-indexing is visible", () => {
  const base = {
    indexedAt: "2026-07-27T09:55:00.000Z",
    warnAfterMs: 10 * 60_000,
    failAfterMs: 20 * 60_000,
    indexedCommitSha: "a".repeat(40),
    expectedCommitSha: "a".repeat(40)
  };

  // A fresh index at the expected commit looks perfectly healthy to an age-based
  // check even when a cap dropped most of the repository. The ratio is what makes
  // that difference legible.
  const truncated = evaluateIndexFreshness({ ...base, truncationRatio: 0.6 }, clock);
  assert.equal(truncated.status, "warning");
  assert.equal(truncated.metadata?.truncationRatio, 0.6);
  assert.match(truncated.summary, /covers only 40%/);

  // Full coverage is unchanged from the previous behaviour.
  const complete = evaluateIndexFreshness({ ...base, truncationRatio: 0 }, clock);
  assert.equal(complete.status, "passing");
  assert.equal(complete.metadata?.truncationRatio, undefined);

  // A small shortfall is reported without changing status, so one unreadable file
  // does not read the same as a truncated repository.
  const minor = evaluateIndexFreshness({ ...base, truncationRatio: 0.02 }, clock);
  assert.equal(minor.status, "passing");
  assert.equal(minor.metadata?.truncationRatio, 0.02);

  // Staleness still outranks coverage: a stale index is not downgraded to warning.
  const stale = evaluateIndexFreshness(
    { ...base, indexedAt: "2026-07-27T08:00:00.000Z", truncationRatio: 0.9 },
    clock
  );
  assert.equal(stale.status, "failing");
  assert.equal(stale.metadata?.truncationRatio, 0.9);
});

function reviewValueRepository(repository: string, reviewValue?: Record<string, any>) {
  return {
    repository,
    visibility: "private" as const,
    inventoryState: "enforced" as const,
    review: {
      prsReviewed: 0,
      advisoryFindingsOpened: 0,
      advisoryFindingsAccepted: 0,
      advisoryFindingsDismissed: 0,
      advisoryFindingsResolved: 0,
      deterministicBlockersOpened: 0,
      bridgeFailures: 0,
      partialReviews: 0,
      latencySamplesMs: []
    },
    scanner: {
      expectedRuns: 0,
      successfulRuns: 0,
      evidenceCompleteRuns: 0,
      missingEvidenceAlerts: 0,
      importLagSamplesMs: []
    },
    monitoring: {
      freshIndexes: 0,
      staleIndexes: 0,
      expiredSuppressions: 0,
      expiringSuppressions: 0,
      protectedDigests: 0,
      completeEvidenceDigests: 0,
      missingEvidenceDigests: 0
    },
    ...(reviewValue ? { reviewValue } : {})
  };
}

test("review value precision is accepted over accepted plus dismissed, with its sample size", () => {
  assert.deepEqual(reviewValueStats({ fixed: 3, dismissed: 1, ignored: 5, unresolved: 2 }), {
    fixed: 3,
    dismissed: 1,
    ignored: 5,
    unresolved: 2,
    precision: 0.75,
    sampleSize: 4
  });
  assert.equal(reviewValueStats({ fixed: 0, dismissed: 0, ignored: 9, unresolved: 1 }).precision, null);
});

test("weekly review value aggregates per repository and category and is omitted when unmeasured", () => {
  const period = { periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-08-16T00:00:00.000Z" };
  const unmeasured = buildWeeklyCoverageReport({
    ...period,
    repositories: [reviewValueRepository("acme/api")]
  });
  assert.equal("reviewValue" in unmeasured, false);

  const report = buildWeeklyCoverageReport({
    ...period,
    repositories: [
      reviewValueRepository("acme/web", {
        byCategory: { security: { fixed: 1, dismissed: 1, ignored: 0, unresolved: 2 } }
      }),
      reviewValueRepository("acme/api", {
        byCategory: {
          security: { fixed: 2, dismissed: 0, ignored: 1, unresolved: 0 },
          "Not A Category!": { fixed: 0, dismissed: 1, ignored: 0, unresolved: 0 }
        }
      })
    ]
  });
  assert.equal(report.reviewValue?.totals.fixed, 3);
  assert.equal(report.reviewValue?.totals.dismissed, 2);
  assert.equal(report.reviewValue?.totals.precision, 0.6);
  assert.equal(report.reviewValue?.totals.sampleSize, 5);
  assert.equal(report.reviewValue?.byCategory.security?.precision, 0.75);
  assert.equal(report.reviewValue?.byCategory.other?.dismissed, 1);
  assert.deepEqual(
    report.reviewValue?.repositories.map((entry) => entry.repository),
    ["acme/api", "acme/web"]
  );
});
