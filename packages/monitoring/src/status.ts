export type MonitoringStatus = "passing" | "warning" | "failing" | "not-applicable";

export type RepositoryInventoryState =
  | "enforced"
  | "report-only"
  | "advisory-only"
  | "not-applicable"
  | "misconfigured"
  | "missing-expected-runs";

export interface MonitoringCheckResult {
  key: string;
  status: MonitoringStatus;
  summary: string;
  observedAt?: string;
  ageMs?: number;
  metadata?: Record<string, boolean | number | string | null>;
}

const STATUS_WEIGHT: Record<MonitoringStatus, number> = {
  failing: 3,
  warning: 2,
  passing: 1,
  "not-applicable": 0
};

export function compareMonitoringStatus(
  left: MonitoringStatus,
  right: MonitoringStatus
): number {
  return STATUS_WEIGHT[left] - STATUS_WEIGHT[right];
}

export function worstMonitoringStatus(statuses: Iterable<MonitoringStatus>): MonitoringStatus {
  let worst: MonitoringStatus = "not-applicable";
  for (const status of statuses) {
    if (compareMonitoringStatus(status, worst) > 0) {
      worst = status;
    }
  }
  return worst;
}
