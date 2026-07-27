import type { MonitoringClock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { MonitoringCheckResult, MonitoringStatus } from "./status.js";

export interface SuppressionRecord {
  fingerprint: string;
  owner: string;
  reason: string;
  ticket: string;
  expiresAt: string;
  findingOpen?: boolean;
}

export interface SuppressionEvaluation {
  status: MonitoringStatus;
  check: MonitoringCheckResult;
  expired: SuppressionRecord[];
  expiringSoon: SuppressionRecord[];
  active: SuppressionRecord[];
}

export function evaluateSuppressions(
  suppressions: SuppressionRecord[],
  options: {
    notifyBeforeMs: number;
  },
  clock: MonitoringClock = systemClock
): SuppressionEvaluation {
  const now = clock.now().getTime();
  const expired: SuppressionRecord[] = [];
  const expiringSoon: SuppressionRecord[] = [];
  const active: SuppressionRecord[] = [];

  for (const suppression of suppressions) {
    const expiry = new Date(suppression.expiresAt).getTime();
    if (Number.isNaN(expiry)) {
      expired.push(suppression);
      continue;
    }
    if (expiry <= now) {
      expired.push(suppression);
      continue;
    }
    if (expiry - now <= options.notifyBeforeMs) {
      expiringSoon.push(suppression);
      continue;
    }
    active.push(suppression);
  }

  const openExpiredCount = expired.filter((item) => item.findingOpen !== false).length;
  const status: MonitoringStatus =
    openExpiredCount > 0 ? "failing" : expiringSoon.length > 0 ? "warning" : "passing";

  return {
    status,
    expired,
    expiringSoon,
    active,
    check: {
      key: "suppression-expiry",
      status,
      summary:
        openExpiredCount > 0
          ? `${openExpiredCount} suppression(s) expired while findings remain open`
          : expiringSoon.length > 0
            ? `${expiringSoon.length} suppression(s) expire soon`
            : "Suppressions are current",
      metadata: {
        activeCount: active.length,
        expiringSoonCount: expiringSoon.length,
        expiredCount: expired.length,
        openExpiredCount
      }
    }
  };
}
