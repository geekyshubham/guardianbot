import type { MonitoringClock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { MonitoringCheckResult } from "./status.js";

/**
 * Deterministic finding-lifecycle inputs. These are derived only from accepted
 * default-branch or deployed-digest scanner evidence; AI review findings never
 * reach this module, so its metrics stay separate from advisory review metrics.
 */
export type FindingLifecycleStatusInput = "open" | "fixed" | "suppressed" | "risk-accepted";
export type FindingSeverityInput = "critical" | "high" | "medium" | "low" | "info";
export type FindingAgeBucket = "0-7d" | "8-30d" | "31-90d" | "over-90d";

export interface FindingLifecycleInput {
  status: FindingLifecycleStatusInput;
  severity: FindingSeverityInput;
  owner: string;
  firstSeenAt: string;
  slaDueAt?: string;
  /** True when the last ticket or notifier update for this finding failed. */
  ticketFailed?: boolean;
}

export interface RepositoryFindingsMetrics {
  open: number;
  breached: number;
  fixed: number;
  suppressed: number;
  riskAccepted: number;
  ticketFailures: number;
  bySeverity: Record<FindingSeverityInput, number>;
  byOwner: Record<string, number>;
  ageBuckets: Record<FindingAgeBucket, number>;
}

/** Repository-level lifecycle health that no single record carries. */
export interface FindingsLifecycleCapacityInput {
  /** Records the latest merge dropped because the repository exceeded its record bound. */
  lastDropped: number;
  /** Open Critical or High records among `lastDropped`. */
  lastDroppedCriticalHigh: number;
  droppedTotal: number;
  /** Marker-bearing issues the latest marker scan ignored because this App did not open them. */
  untrustedMarkers: number;
}

export interface FindingsLifecycleEvaluation {
  checks: MonitoringCheckResult[];
  metrics: RepositoryFindingsMetrics;
}

const DAY_MS = 24 * 60 * 60_000;

export function emptyFindingsMetrics(): RepositoryFindingsMetrics {
  return {
    open: 0,
    breached: 0,
    fixed: 0,
    suppressed: 0,
    riskAccepted: 0,
    ticketFailures: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    byOwner: {},
    ageBuckets: { "0-7d": 0, "8-30d": 0, "31-90d": 0, "over-90d": 0 }
  };
}

export function findingAgeBucket(firstSeenAt: string, now: number): FindingAgeBucket {
  const first = Date.parse(firstSeenAt);
  // An unparseable first-seen time is treated as the oldest bucket so a corrupt
  // row can never make an open finding look fresher than it is.
  const ageDays = Number.isNaN(first) ? Number.POSITIVE_INFINITY : (now - first) / DAY_MS;
  if (ageDays <= 7) return "0-7d";
  if (ageDays <= 30) return "8-30d";
  if (ageDays <= 90) return "31-90d";
  return "over-90d";
}

export function isFindingSlaBreached(record: FindingLifecycleInput, now: number): boolean {
  if (record.status !== "open" || !record.slaDueAt) return false;
  const due = Date.parse(record.slaDueAt);
  // A tracked open finding whose due date cannot be read fails closed as breached.
  return Number.isNaN(due) || due <= now;
}

export function evaluateFindingsLifecycle(
  records: readonly FindingLifecycleInput[],
  clock: MonitoringClock = systemClock,
  capacity?: FindingsLifecycleCapacityInput
): FindingsLifecycleEvaluation {
  const now = clock.now().getTime();
  const metrics = emptyFindingsMetrics();
  for (const record of records) {
    if (record.ticketFailed) metrics.ticketFailures += 1;
    if (record.status === "fixed") {
      metrics.fixed += 1;
      continue;
    }
    if (record.status === "suppressed") {
      metrics.suppressed += 1;
      continue;
    }
    if (record.status === "risk-accepted") {
      metrics.riskAccepted += 1;
      continue;
    }
    metrics.open += 1;
    metrics.bySeverity[record.severity] += 1;
    metrics.byOwner[record.owner] = (metrics.byOwner[record.owner] ?? 0) + 1;
    metrics.ageBuckets[findingAgeBucket(record.firstSeenAt, now)] += 1;
    if (isFindingSlaBreached(record, now)) metrics.breached += 1;
  }
  const checks: MonitoringCheckResult[] = [
    {
      key: "findings-sla",
      status: metrics.breached > 0 ? "failing" : "passing",
      summary:
        metrics.breached > 0
          ? `${metrics.breached} open deterministic finding(s) are past their SLA due date`
          : "No open deterministic finding is past its SLA due date",
      metadata: { open: metrics.open, breached: metrics.breached }
    },
    {
      key: "findings-ticketing",
      status: metrics.ticketFailures > 0 ? "warning" : "passing",
      summary:
        metrics.ticketFailures > 0
          ? `${metrics.ticketFailures} finding ticket or notification update(s) failed and will be retried`
          : "Finding tickets and notifications are up to date",
      metadata: { failures: metrics.ticketFailures }
    }
  ];
  if (capacity) checks.push(evaluateFindingsCapacity(capacity));
  return { checks, metrics };
}

/**
 * `findings-capacity` fails when the record bound forced out an open Critical or High
 * finding, and warns when it forced out anything else or when issues carrying a
 * finding marker were ignored because this App did not open them. Dropped records are
 * a real loss of tracking, so they are never silent.
 */
export function evaluateFindingsCapacity(capacity: FindingsLifecycleCapacityInput): MonitoringCheckResult {
  const metadata = {
    lastDropped: capacity.lastDropped,
    lastDroppedCriticalHigh: capacity.lastDroppedCriticalHigh,
    droppedTotal: capacity.droppedTotal,
    untrustedMarkers: capacity.untrustedMarkers
  };
  if (capacity.lastDroppedCriticalHigh > 0) {
    return {
      key: "findings-capacity",
      status: "failing",
      summary: `${capacity.lastDroppedCriticalHigh} open Critical or High finding(s) were dropped because the repository exceeded its lifecycle record bound`,
      metadata
    };
  }
  const problems: string[] = [];
  if (capacity.lastDropped > 0) {
    problems.push(`${capacity.lastDropped} finding record(s) were dropped because the repository exceeded its lifecycle record bound`);
  }
  if (capacity.untrustedMarkers > 0) {
    problems.push(`${capacity.untrustedMarkers} issue(s) carry a finding marker but were not opened by this GitHub App and were ignored`);
  }
  return {
    key: "findings-capacity",
    status: problems.length ? "warning" : "passing",
    summary: problems.length ? problems.join("; ") : "Finding lifecycle records fit their bound and no foreign marker issue was seen",
    metadata
  };
}
