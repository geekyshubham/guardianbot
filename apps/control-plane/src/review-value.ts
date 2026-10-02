import type { ReviewValueCounts } from "@guardianbot/monitoring";
import type { ReviewActivityRecord, ReviewFindingRecord } from "./store.js";

/**
 * Review-value analytics derived from retained finding records.
 *
 * Everything here is pure and operates on the derived per-finding fields only: fingerprint,
 * lifecycle state, provenance timestamps, category, line range, and the closed-union outcome.
 * No reviewer identity and no comment text is an input, so nothing here can leak either.
 */

export interface ChangedFilePatch {
  filename: string;
  previous_filename?: string;
  patch?: string;
}

/**
 * Old-side line numbers a unified diff deleted or rewrote. A finding's line range refers to the
 * previously reviewed head, so this is the side that says whether those exact lines changed.
 */
export function removedLineNumbers(patch: string): Set<number> {
  const removed = new Set<number>();
  let oldLine = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      continue;
    }
    if (!oldLine) continue;
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      continue;
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
    }
  }
  return removed;
}

export interface MarkFixedOutcomesResult {
  findings: ReviewFindingRecord[];
  fixed: number;
}

/**
 * Marks findings `fixed` when a verified incremental change rewrote their lines and the model then
 * stopped reporting them. All of these must hold, and anything weaker records no outcome at all:
 *
 * - the finding was `open` before this review and is terminal after it;
 * - it carries no outcome yet (an explicit dismissal is never overwritten);
 * - its retained path and line range are known;
 * - the incremental diff the model actually received rewrote at least one old-side line inside
 *   that range. A finding whose file was omitted from the bounded bundle could not have been
 *   reported, so its disappearance says nothing and it is not counted.
 *
 * `changedFiles` must be the files included in the model's bundle for an incremental review whose
 * base GitHub verified as the previously reviewed head; the caller owns that precondition.
 */
export function markFixedOutcomes(
  previous: readonly ReviewFindingRecord[] | undefined,
  merged: readonly ReviewFindingRecord[],
  changedFiles: readonly ChangedFilePatch[],
  now: Date
): MarkFixedOutcomesResult {
  const wasOpen = new Set(
    (previous ?? [])
      .filter((finding) => finding.state === "open")
      .map((finding) => finding.fingerprint)
  );
  const removedByPath = new Map<string, Set<number>>();
  for (const file of changedFiles) {
    if (!file.patch) continue;
    const removed = removedLineNumbers(file.patch);
    if (!removed.size) continue;
    // The finding's path is the path at the previously reviewed head, which is the old name of a
    // renamed file.
    removedByPath.set(file.previous_filename ?? file.filename, removed);
  }
  let fixed = 0;
  const nowIso = now.toISOString();
  const findings = merged.map((finding) => {
    if (
      finding.state === "open" ||
      finding.outcome !== undefined ||
      !wasOpen.has(finding.fingerprint) ||
      !finding.path ||
      !finding.startLine ||
      !finding.endLine
    ) {
      return finding;
    }
    const removed = removedByPath.get(finding.path);
    if (!removed) return finding;
    let rewritten = false;
    for (let line = finding.startLine; line <= finding.endLine; line += 1) {
      if (removed.has(line)) {
        rewritten = true;
        break;
      }
    }
    if (!rewritten) return finding;
    fixed += 1;
    return { ...finding, outcome: "fixed" as const, outcomeAt: nowIso };
  });
  return { findings, fixed };
}

/**
 * Re-applies human-recorded outcomes from the latest retained row onto findings a review computed
 * from an earlier read. A review publishes its merged findings by overwriting the schemaless
 * column, so a dismissal (or a merge's `ignored`) recorded while the model call was in flight
 * would otherwise be silently lost even though the command already replied that it was recorded.
 * `dismissed` wins over any derived outcome, matching `applyFindingOutcome`; `ignored` reaches
 * only findings that carry no outcome. The caller re-reads immediately before its write, which
 * narrows the window to that read-write gap rather than the whole review.
 */
export function carryRecordedOutcomes(
  findings: readonly ReviewFindingRecord[],
  latest: readonly ReviewFindingRecord[] | undefined
): ReviewFindingRecord[] {
  const recorded = new Map(
    (latest ?? [])
      .filter((finding) => finding.outcome === "dismissed" || finding.outcome === "ignored")
      .map((finding) => [finding.fingerprint, finding])
  );
  if (!recorded.size) return [...findings];
  return findings.map((finding) => {
    const source = recorded.get(finding.fingerprint);
    if (!source || finding.outcome === "dismissed" || finding.outcome === source.outcome) {
      return finding;
    }
    if (source.outcome === "ignored" && finding.outcome !== undefined) return finding;
    return {
      ...finding,
      outcome: source.outcome,
      ...(source.outcomeAt ? { outcomeAt: source.outcomeAt } : {})
    };
  });
}

/** True when any of the finding's own timestamps falls inside the period. */
function touchedInPeriod(finding: ReviewFindingRecord, start: number, end: number): boolean {
  return (
    within(finding.firstSeenAt, start, end) ||
    within(finding.lastSeenAt, start, end) ||
    within(finding.outcomeAt, start, end)
  );
}

export interface ReviewActivityAggregate {
  /** True when at least one retained finding was first seen, last seen, or given an outcome in the period. */
  measured: boolean;
  advisoryFindingsOpened: number;
  advisoryFindingsAccepted: number;
  advisoryFindingsDismissed: number;
  advisoryFindingsResolved: number;
  byCategory: Record<string, ReviewValueCounts>;
}

const UNCATEGORIZED = "uncategorized";

function within(value: string | undefined, start: number, end: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= start && parsed <= end;
}

/**
 * Aggregates one repository's retained review rows into the weekly review fields. Period counts
 * use each finding's own timestamps, so a row touched this week for an unrelated reason does not
 * re-count old outcomes:
 *
 * - opened: first seen in the period;
 * - accepted: outcome `fixed` recorded in the period;
 * - dismissed: outcome `dismissed` recorded in the period;
 * - resolved: reached a terminal lifecycle state, last observed in the period;
 * - per category, `unresolved` is a point-in-time count of findings still open with no outcome and
 *   observed in the period.
 */
export function aggregateReviewActivity(
  reviews: readonly ReviewActivityRecord[],
  periodStart: Date,
  periodEnd: Date
): ReviewActivityAggregate {
  const start = periodStart.getTime();
  const end = periodEnd.getTime();
  const aggregate: ReviewActivityAggregate = {
    // Measured means a retained finding was observed in the period, not merely that a row was
    // read: the PostgreSQL read prefilters by row `updated_at` and the in-memory read does not, so
    // a row-count test would label the same data differently per store.
    measured: reviews.some((review) =>
      review.findings.some((finding) => touchedInPeriod(finding, start, end))
    ),
    advisoryFindingsOpened: 0,
    advisoryFindingsAccepted: 0,
    advisoryFindingsDismissed: 0,
    advisoryFindingsResolved: 0,
    byCategory: {}
  };
  const bucket = (category: string | undefined): ReviewValueCounts => {
    const key = category ?? UNCATEGORIZED;
    const existing = aggregate.byCategory[key];
    if (existing) return existing;
    const created = { fixed: 0, dismissed: 0, ignored: 0, unresolved: 0 };
    aggregate.byCategory[key] = created;
    return created;
  };
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (within(finding.firstSeenAt, start, end)) aggregate.advisoryFindingsOpened += 1;
      if (finding.state !== "open" && within(finding.lastSeenAt, start, end)) {
        aggregate.advisoryFindingsResolved += 1;
      }
      if (finding.outcome && within(finding.outcomeAt, start, end)) {
        const counts = bucket(finding.category);
        counts[finding.outcome] += 1;
        if (finding.outcome === "fixed") aggregate.advisoryFindingsAccepted += 1;
        if (finding.outcome === "dismissed") aggregate.advisoryFindingsDismissed += 1;
      } else if (
        finding.state === "open" &&
        finding.outcome === undefined &&
        within(finding.lastSeenAt, start, end)
      ) {
        bucket(finding.category).unresolved += 1;
      }
    }
  }
  return aggregate;
}
