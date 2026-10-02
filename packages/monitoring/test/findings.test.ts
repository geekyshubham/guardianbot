import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_WEEKLY_FINDING_OWNERS,
  buildWeeklyCoverageReport,
  emptyFindingsMetrics,
  evaluateFindingsCapacity,
  evaluateFindingsLifecycle,
  findingAgeBucket,
  fixedClock,
  isFindingSlaBreached,
  type FindingLifecycleInput,
  type RepositoryWeeklyMetrics
} from "../src/index.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

function finding(overrides: Partial<FindingLifecycleInput> = {}): FindingLifecycleInput {
  return {
    status: "open",
    severity: "critical",
    owner: "@acme/app",
    firstSeenAt: new Date(NOW - DAY_MS).toISOString(),
    slaDueAt: new Date(NOW + DAY_MS).toISOString(),
    ...overrides
  };
}

test("age buckets and SLA breach fail closed on unreadable timestamps", () => {
  assert.equal(findingAgeBucket(new Date(NOW - 7 * DAY_MS).toISOString(), NOW), "0-7d");
  assert.equal(findingAgeBucket(new Date(NOW - 8 * DAY_MS).toISOString(), NOW), "8-30d");
  assert.equal(findingAgeBucket(new Date(NOW - 60 * DAY_MS).toISOString(), NOW), "31-90d");
  assert.equal(findingAgeBucket(new Date(NOW - 91 * DAY_MS).toISOString(), NOW), "over-90d");
  assert.equal(findingAgeBucket("garbage", NOW), "over-90d");

  assert.equal(isFindingSlaBreached(finding(), NOW), false);
  assert.equal(isFindingSlaBreached(finding({ slaDueAt: new Date(NOW).toISOString() }), NOW), true);
  assert.equal(isFindingSlaBreached(finding({ slaDueAt: "garbage" }), NOW), true);
  assert.equal(isFindingSlaBreached(finding({ slaDueAt: undefined }), NOW), false);
  assert.equal(
    isFindingSlaBreached(finding({ status: "risk-accepted", slaDueAt: "2020-01-01T00:00:00.000Z" }), NOW),
    false
  );
});

test("lifecycle evaluation counts only open findings toward owners, severity, and age", () => {
  const evaluation = evaluateFindingsLifecycle(
    [
      finding(),
      finding({ severity: "high", owner: "unowned", slaDueAt: "2026-07-01T00:00:00.000Z", ticketFailed: true }),
      finding({ status: "fixed" }),
      finding({ status: "suppressed" }),
      finding({ status: "risk-accepted" })
    ],
    fixedClock(new Date(NOW))
  );
  assert.equal(evaluation.metrics.open, 2);
  assert.equal(evaluation.metrics.breached, 1);
  assert.equal(evaluation.metrics.fixed, 1);
  assert.equal(evaluation.metrics.suppressed, 1);
  assert.equal(evaluation.metrics.riskAccepted, 1);
  assert.equal(evaluation.metrics.ticketFailures, 1);
  assert.deepEqual(evaluation.metrics.byOwner, { "@acme/app": 1, unowned: 1 });
  assert.deepEqual(
    evaluation.checks.map((check) => [check.key, check.status]),
    [
      ["findings-sla", "failing"],
      ["findings-ticketing", "warning"]
    ]
  );
  const clean = evaluateFindingsLifecycle([], fixedClock(new Date(NOW)));
  assert.deepEqual(clean.metrics, emptyFindingsMetrics());
  assert.equal(clean.checks.every((check) => check.status === "passing"), true);
});

function weeklyRepository(name: string, findings?: RepositoryWeeklyMetrics["findings"]): RepositoryWeeklyMetrics {
  return {
    repository: name,
    visibility: "private",
    inventoryState: "report-only",
    review: {
      prsReviewed: 0,
      advisoryFindingsOpened: 0,
      advisoryFindingsAccepted: 0,
      advisoryFindingsDismissed: 0,
      advisoryFindingsResolved: 0,
      deterministicBlockersOpened: 0,
      bridgeFailures: 0,
      partialReviews: 0
    },
    scanner: { expectedRuns: 1, successfulRuns: 1, evidenceCompleteRuns: 1, missingEvidenceAlerts: 0 },
    monitoring: {
      freshIndexes: 1,
      staleIndexes: 0,
      expiredSuppressions: 0,
      expiringSuppressions: 0,
      protectedDigests: 0,
      completeEvidenceDigests: 0,
      missingEvidenceDigests: 0
    },
    ...(findings ? { findings } : {})
  };
}

test("the weekly report adds a deterministic findings section only when metrics exist", () => {
  const period = { periodStart: "2026-07-27T00:00:00.000Z", periodEnd: "2026-07-27T12:00:00.000Z" };
  const without = buildWeeklyCoverageReport({ ...period, repositories: [weeklyRepository("a/b")] });
  assert.equal(Object.hasOwn(without, "findings"), false);

  const many = emptyFindingsMetrics();
  many.open = MAX_WEEKLY_FINDING_OWNERS + 2;
  for (let index = 0; index < MAX_WEEKLY_FINDING_OWNERS + 2; index += 1) {
    many.byOwner[`@acme/team-${String(index).padStart(3, "0")}`] = 1;
  }
  many.bySeverity.critical = many.open;
  many.ageBuckets["0-7d"] = many.open;
  const report = buildWeeklyCoverageReport({
    ...period,
    repositories: [weeklyRepository("a/b", many), weeklyRepository("a/c")]
  });
  assert.equal(report.findings?.source, "deterministic-scanners");
  assert.equal(report.findings?.open, MAX_WEEKLY_FINDING_OWNERS + 2);
  assert.equal(Object.keys(report.findings?.byOwner ?? {}).length, MAX_WEEKLY_FINDING_OWNERS);
  assert.equal(report.findings?.otherOwners, 2);
  // AI review metrics stay separate from deterministic finding metrics.
  assert.equal(report.review.advisoryFindingsOpened, 0);
});

test("findings-capacity fails on dropped Critical or High findings and warns on other loss", () => {
  const base = { lastDropped: 0, lastDroppedCriticalHigh: 0, droppedTotal: 0, untrustedMarkers: 0 };
  assert.equal(evaluateFindingsCapacity(base).status, "passing");
  assert.equal(evaluateFindingsCapacity({ ...base, droppedTotal: 9 }).status, "passing", "only the latest merge alerts");
  const lowLoss = evaluateFindingsCapacity({ ...base, lastDropped: 3, droppedTotal: 3 });
  assert.equal(lowLoss.status, "warning");
  assert.match(lowLoss.summary, /3 finding record\(s\) were dropped/);
  const foreign = evaluateFindingsCapacity({ ...base, untrustedMarkers: 2 });
  assert.equal(foreign.status, "warning");
  assert.match(foreign.summary, /not opened by this GitHub App/);
  const severe = evaluateFindingsCapacity({ ...base, lastDropped: 3, lastDroppedCriticalHigh: 1, droppedTotal: 3 });
  assert.equal(severe.status, "failing");
  assert.equal(severe.key, "findings-capacity");
  const evaluation = evaluateFindingsLifecycle([], fixedClock(new Date(NOW)), severe.metadata as typeof base);
  assert.deepEqual(
    evaluation.checks.map((check) => [check.key, check.status]),
    [
      ["findings-sla", "passing"],
      ["findings-ticketing", "passing"],
      ["findings-capacity", "failing"]
    ]
  );
});
