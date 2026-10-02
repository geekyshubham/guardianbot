import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateReviewActivity,
  carryRecordedOutcomes,
  markFixedOutcomes,
  removedLineNumbers
} from "../src/review-value.js";
import { applyFindingOutcome, type ReviewFindingRecord } from "../src/store.js";

const NOW = new Date("2026-08-12T10:00:00.000Z");

function finding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    fingerprint: "a".repeat(64),
    state: "open",
    path: "src/a.ts",
    startLine: 10,
    endLine: 11,
    category: "security",
    firstSeenAt: "2026-08-11T00:00:00.000Z",
    lastSeenAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
}

test("removedLineNumbers reports old-side deleted and rewritten lines only", () => {
  const patch = [
    "@@ -10,3 +10,3 @@",
    " context",
    "-old eleven",
    "+new eleven",
    " context",
    "@@ -40,2 +40,3 @@",
    " keep",
    "+added only",
    " keep"
  ].join("\n");
  assert.deepEqual([...removedLineNumbers(patch)], [11]);
  assert.deepEqual([...removedLineNumbers("@@ -1 +1,2 @@\n line\n+added")], []);
});

test("a finding is fixed only when it closed after its exact lines were rewritten", () => {
  const previous = [finding()];
  const merged = [finding({ state: "resolved" })];
  const files = [{ filename: "src/a.ts", patch: "@@ -10,2 +10,2 @@\n line\n-bad\n+good" }];
  const result = markFixedOutcomes(previous, merged, files, NOW);
  assert.equal(result.fixed, 1);
  assert.equal(result.findings[0]?.outcome, "fixed");
  assert.equal(result.findings[0]?.outcomeAt, NOW.toISOString());
});

test("disappearance without a rewrite of the finding's lines records no outcome", () => {
  const previous = [finding()];
  const merged = [finding({ state: "resolved" })];
  // Lines outside the finding range changed; the file itself was in the bundle.
  const elsewhere = [{ filename: "src/a.ts", patch: "@@ -30 +30 @@\n-x\n+y" }];
  assert.equal(markFixedOutcomes(previous, merged, elsewhere, NOW).fixed, 0);
  // The file was omitted from the bounded bundle entirely.
  assert.equal(markFixedOutcomes(previous, merged, [], NOW).fixed, 0);
  // Still open: not fixed even though the lines changed.
  const rewrite = [{ filename: "src/a.ts", patch: "@@ -10 +10 @@\n-x\n+y" }];
  assert.equal(markFixedOutcomes(previous, [finding()], rewrite, NOW).fixed, 0);
  // Was not open before (already terminal): not re-counted.
  assert.equal(
    markFixedOutcomes([finding({ state: "superseded" })], merged, rewrite, NOW).fixed,
    0
  );
  // Never overwrites an explicit dismissal.
  const dismissed = markFixedOutcomes(
    previous,
    [finding({ state: "resolved", outcome: "dismissed", outcomeAt: "2026-08-11T05:00:00.000Z" })],
    rewrite,
    NOW
  );
  assert.equal(dismissed.fixed, 0);
  assert.equal(dismissed.findings[0]?.outcome, "dismissed");
});

test("a renamed file is matched by its previous name", () => {
  const files = [
    { filename: "src/b.ts", previous_filename: "src/a.ts", patch: "@@ -11 +11 @@\n-x\n+y" }
  ];
  assert.equal(
    markFixedOutcomes([finding()], [finding({ state: "superseded" })], files, NOW).fixed,
    1
  );
});

test("applyFindingOutcome records dismissal once and ignored only for open findings without an outcome", () => {
  const open = finding();
  const other = finding({ fingerprint: "b".repeat(64), state: "resolved" });
  const fixed = finding({ fingerprint: "c".repeat(64), outcome: "fixed", outcomeAt: "x" });
  const dismissed = applyFindingOutcome([open, other], {
    outcome: "dismissed",
    fingerprint: open.fingerprint,
    observedAt: NOW
  });
  assert.equal(dismissed.changed, 1);
  assert.equal(dismissed.findings[0]?.outcome, "dismissed");
  assert.equal(
    applyFindingOutcome(dismissed.findings, {
      outcome: "dismissed",
      fingerprint: open.fingerprint,
      observedAt: NOW
    }).changed,
    0
  );
  const ignored = applyFindingOutcome([open, other, fixed], { outcome: "ignored", observedAt: NOW });
  assert.equal(ignored.changed, 1);
  assert.deepEqual(
    ignored.findings.map((entry) => entry.outcome),
    ["ignored", undefined, "fixed"]
  );
});

test("weekly review activity counts per category by each finding's own timestamps", () => {
  const start = new Date("2026-08-10T00:00:00.000Z");
  const end = new Date("2026-08-16T23:59:59.999Z");
  const inWeek = "2026-08-12T00:00:00.000Z";
  const lastWeek = "2026-08-03T00:00:00.000Z";
  const aggregate = aggregateReviewActivity(
    [
      {
        pullNumber: 1,
        findings: [
          finding({ fingerprint: "1", state: "resolved", outcome: "fixed", outcomeAt: inWeek, lastSeenAt: inWeek }),
          finding({ fingerprint: "2", outcome: "dismissed", outcomeAt: inWeek }),
          finding({ fingerprint: "3", category: "logic", lastSeenAt: inWeek }),
          finding({ fingerprint: "4", outcome: "fixed", outcomeAt: lastWeek, firstSeenAt: lastWeek }),
          finding({ fingerprint: "5", category: undefined, outcome: "ignored", outcomeAt: inWeek })
        ]
      }
    ],
    start,
    end
  );
  assert.equal(aggregate.measured, true);
  assert.equal(aggregate.advisoryFindingsAccepted, 1);
  assert.equal(aggregate.advisoryFindingsDismissed, 1);
  assert.equal(aggregate.advisoryFindingsResolved, 1);
  assert.equal(aggregate.advisoryFindingsOpened, 4);
  assert.deepEqual(aggregate.byCategory, {
    security: { fixed: 1, dismissed: 1, ignored: 0, unresolved: 0 },
    logic: { fixed: 0, dismissed: 0, ignored: 0, unresolved: 1 },
    uncategorized: { fixed: 0, dismissed: 0, ignored: 1, unresolved: 0 }
  });
  assert.equal(aggregateReviewActivity([], start, end).measured, false);
});

test("retained analytics never carry reviewer identity or prose", () => {
  const result = markFixedOutcomes(
    [finding()],
    [finding({ state: "resolved" })],
    [{ filename: "src/a.ts", patch: "@@ -10 +10 @@\n-secret body text\n+other" }],
    NOW
  );
  assert.doesNotMatch(JSON.stringify(result), /secret body text|other/);
});

test("carryRecordedOutcomes re-applies a dismissal or merge outcome recorded after the review read", () => {
  const dismissedAt = "2026-08-12T09:00:00.000Z";
  const latest = [
    finding({ fingerprint: "1", outcome: "dismissed", outcomeAt: dismissedAt }),
    finding({ fingerprint: "2", outcome: "ignored", outcomeAt: dismissedAt }),
    finding({ fingerprint: "3", outcome: "ignored", outcomeAt: dismissedAt })
  ];
  const computed = [
    // Derived `fixed` loses to the human dismissal.
    finding({ fingerprint: "1", state: "resolved", outcome: "fixed", outcomeAt: NOW.toISOString() }),
    // No outcome yet: the merge's `ignored` is carried.
    finding({ fingerprint: "2" }),
    // Already fixed: `ignored` never overwrites an outcome.
    finding({ fingerprint: "3", state: "resolved", outcome: "fixed", outcomeAt: NOW.toISOString() }),
    // Not in the latest row: untouched.
    finding({ fingerprint: "4" })
  ];
  const carried = carryRecordedOutcomes(computed, latest);
  assert.deepEqual(
    carried.map((entry) => [entry.fingerprint, entry.outcome, entry.outcomeAt]),
    [
      ["1", "dismissed", dismissedAt],
      ["2", "ignored", dismissedAt],
      ["3", "fixed", NOW.toISOString()],
      ["4", undefined, undefined]
    ]
  );
  assert.deepEqual(carryRecordedOutcomes(computed, undefined), computed);
});

test("measured needs a finding observed in the period, independent of which rows a store returns", () => {
  const start = new Date("2026-08-10T00:00:00.000Z");
  const end = new Date("2026-08-16T23:59:59.999Z");
  const old = "2026-07-01T00:00:00.000Z";
  // The in-memory store returns every row; PostgreSQL would have filtered this one out.
  const stale = [{ pullNumber: 1, findings: [finding({ firstSeenAt: old, lastSeenAt: old })] }];
  assert.equal(aggregateReviewActivity(stale, start, end).measured, false);
  assert.equal(aggregateReviewActivity([{ pullNumber: 2, findings: [] }], start, end).measured, false);
  const outcomeOnly = [{
    pullNumber: 3,
    findings: [finding({ firstSeenAt: old, lastSeenAt: old, outcome: "dismissed", outcomeAt: "2026-08-12T00:00:00.000Z" })]
  }];
  assert.equal(aggregateReviewActivity(outcomeOnly, start, end).measured, true);
});
