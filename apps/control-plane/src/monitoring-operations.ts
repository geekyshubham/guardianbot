import type { ServerResponse } from "node:http";
import type { MonitoringService, MonitoringServiceState } from "./monitoring-service.js";
import {
  DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT,
  type ActiveMonitoringAlertPageItem,
  type ActiveMonitoringAlertsPage,
  type MonitoringAlertRecord,
  type MonitoringWeeklyReportRecord,
  type Store
} from "./store.js";

export const MONITORING_OPERATIONS_PATH = "/operations/monitoring";
export const MONITORING_STATUS_SCHEMA_VERSION = "guardianbot.monitoring.status.v1" as const;
export const MONITORING_OPERATIONS_UNAVAILABLE_BODY =
  '{"error":"monitoring operations unavailable"}';

/** Defense-in-depth caps on operator-facing strings (writer is already sanitized). */
export const MAX_OPERATIONS_REPOSITORY_FULL_NAME_LENGTH = 255;
export const MAX_OPERATIONS_ALERT_KEY_LENGTH = 256;
export const MAX_OPERATIONS_ALERT_SUMMARY_LENGTH = 512;

export interface SanitizedMonitoringAlert {
  repositoryId: number;
  fullName: string;
  alertKey: string;
  severity: MonitoringAlertRecord["severity"];
  summary: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface MonitoringOperationsScheduler {
  /** This process only; not a fleet-authoritative snapshot. */
  scope: "process-local";
  state: MonitoringServiceState;
}

export interface MonitoringOperationsStatus {
  schemaVersion: typeof MONITORING_STATUS_SCHEMA_VERSION;
  generatedAt: string;
  scheduler: MonitoringOperationsScheduler;
  /**
   * Unique repository names from the bounded alert page only — never the full
   * fleet dump, never a total across unreturned alerts.
   */
  repositories: {
    /** Count of unique names in the returned page (not a fleet total). */
    returnedAlertingCount: number;
    /** Exactly `!activeAlerts.truncated` — page is complete, not a total claim. */
    complete: boolean;
    names: string[];
  };
  activeAlerts: {
    limit: number;
    returned: number;
    truncated: boolean;
    items: SanitizedMonitoringAlert[];
  };
  weeklyReport: MonitoringWeeklyReportRecord | null;
}

export interface MonitoringOperationsSources {
  store: Pick<Store, "listActiveMonitoringAlertsPage" | "getMonitoringWeeklyReport">;
  monitoring: Pick<MonitoringService, "getState">;
  now?: Date;
  alertLimit?: number;
}

/** Monday 00:00:00.000Z of the UTC week containing `value`. */
export function startOfUtcWeek(value: Date): Date {
  const start = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

/** Existing weekly-report key shape: `v1:YYYY-MM-DD` for the Monday of the UTC week. */
export function monitoringUtcWeekKey(value: Date): string {
  return `v1:${startOfUtcWeek(value).toISOString().slice(0, 10)}`;
}

function capResponseString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function mapAlert(alert: ActiveMonitoringAlertPageItem): SanitizedMonitoringAlert {
  return {
    repositoryId: alert.repositoryId,
    fullName: capResponseString(
      alert.fullName,
      MAX_OPERATIONS_REPOSITORY_FULL_NAME_LENGTH
    ),
    alertKey: capResponseString(alert.alertKey, MAX_OPERATIONS_ALERT_KEY_LENGTH),
    severity: alert.severity,
    summary: capResponseString(alert.summary, MAX_OPERATIONS_ALERT_SUMMARY_LENGTH),
    firstObservedAt: alert.firstObservedAt,
    lastObservedAt: alert.lastObservedAt
  };
}

/**
 * Read-only operator snapshot: process-local scheduler gauges, alerting
 * repository names from the bounded alert page, the alert ledger itself, and
 * the current UTC-week report. Never loads the full fleet inventory. Never
 * includes config, evidence, credentials, digests, index data, or payloads.
 */
export async function buildMonitoringOperationsStatus(
  sources: MonitoringOperationsSources
): Promise<MonitoringOperationsStatus> {
  const now = sources.now ?? new Date();
  const alertLimit = sources.alertLimit ?? DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT;
  const [alertPage, weeklyReport] = await Promise.all([
    sources.store.listActiveMonitoringAlertsPage(alertLimit),
    sources.store.getMonitoringWeeklyReport(monitoringUtcWeekKey(now))
  ]);

  const activeAlerts = toActiveAlertsSection(alertPage);
  return {
    schemaVersion: MONITORING_STATUS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    scheduler: {
      scope: "process-local",
      state: sources.monitoring.getState()
    },
    repositories: alertingRepositoriesSection(
      activeAlerts.items,
      activeAlerts.truncated
    ),
    activeAlerts,
    weeklyReport: weeklyReport ?? null
  };
}

function toActiveAlertsSection(
  page: ActiveMonitoringAlertsPage
): MonitoringOperationsStatus["activeAlerts"] {
  const items = page.alerts.map(mapAlert);
  return {
    limit: page.limit,
    returned: items.length,
    truncated: page.truncated,
    items
  };
}

/** Unique repository names from the returned alert page only, in first-seen order. */
function alertingRepositoriesSection(
  items: readonly SanitizedMonitoringAlert[],
  truncated: boolean
): MonitoringOperationsStatus["repositories"] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.fullName || seen.has(item.fullName)) continue;
    seen.add(item.fullName);
    names.push(item.fullName);
  }
  return {
    returnedAlertingCount: names.length,
    complete: !truncated,
    names
  };
}

export function writeMonitoringOperationsUnauthorized(response: ServerResponse): void {
  response.writeHead(404).end();
}

export function writeMonitoringOperationsUnavailable(response: ServerResponse): void {
  response
    .writeHead(503, {
      "content-type": "application/json",
      "cache-control": "no-store"
    })
    .end(MONITORING_OPERATIONS_UNAVAILABLE_BODY);
}

export function writeMonitoringOperationsStatus(
  response: ServerResponse,
  status: MonitoringOperationsStatus
): void {
  response
    .writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    })
    .end(JSON.stringify(status));
}
