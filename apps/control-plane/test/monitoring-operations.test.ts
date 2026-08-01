import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { metricsRequestAuthorized } from "../src/http-security.js";
import {
  buildMonitoringOperationsStatus,
  MAX_OPERATIONS_ALERT_KEY_LENGTH,
  MAX_OPERATIONS_ALERT_SUMMARY_LENGTH,
  MAX_OPERATIONS_REPOSITORY_FULL_NAME_LENGTH,
  MONITORING_OPERATIONS_PATH,
  MONITORING_OPERATIONS_UNAVAILABLE_BODY,
  MONITORING_STATUS_SCHEMA_VERSION,
  monitoringUtcWeekKey,
  startOfUtcWeek,
  writeMonitoringOperationsStatus,
  writeMonitoringOperationsUnauthorized,
  writeMonitoringOperationsUnavailable
} from "../src/monitoring-operations.js";
import type { MonitoringServiceState } from "../src/monitoring-service.js";
import {
  assertActiveMonitoringAlertLimit,
  DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT,
  MAX_ACTIVE_MONITORING_ALERTS_LIMIT,
  MemoryStore,
  type MonitoringWeeklyReportRecord,
  type RepositoryRecord
} from "../src/store.js";

const NOW = new Date("2026-07-29T15:30:00.000Z");

function repository(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    installationId: 10,
    repositoryId: 20,
    fullName: "acme/service",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false,
    ...overrides
  };
}

function schedulerState(
  overrides: Partial<MonitoringServiceState> = {}
): MonitoringServiceState {
  return {
    enabled: true,
    started: true,
    running: false,
    lastDurationMs: 12,
    consecutiveFailures: 0,
    runsTotal: 3,
    successesTotal: 2,
    failuresTotal: 1,
    lockSkippedTotal: 0,
    repositoriesEvaluated: 1,
    failingRepositories: 1,
    warningRepositories: 0,
    activeAlerts: 1,
    ...overrides
  };
}

function weeklyReport(
  overrides: Partial<MonitoringWeeklyReportRecord> = {}
): MonitoringWeeklyReportRecord {
  return {
    weekKey: "v1:2026-07-27",
    periodStart: "2026-07-27T00:00:00.000Z",
    periodEnd: "2026-07-29T15:30:00.000Z",
    generatedAt: "2026-07-29T15:30:00.000Z",
    report: {
      periodStart: "2026-07-27T00:00:00.000Z",
      periodEnd: "2026-07-29T15:30:00.000Z",
      totalRepositories: 1,
      visibilityBreakdown: { public: 0, private: 1 },
      inventoryStates: {
        enforced: 0,
        "report-only": 1,
        "advisory-only": 0,
        "not-applicable": 0,
        misconfigured: 0,
        "missing-expected-runs": 0
      },
      review: {
        prsReviewed: 0,
        advisoryFindingsOpened: 0,
        advisoryFindingsAccepted: 0,
        advisoryFindingsDismissed: 0,
        advisoryFindingsResolved: 0,
        deterministicBlockersOpened: 0,
        bridgeFailures: 0,
        partialReviews: 0,
        latencyP50Ms: 0,
        latencyP95Ms: 0,
        inputUnits: 0,
        outputUnits: 0,
        estimatedCostUsd: 0
      },
      scanner: {
        expectedRuns: 1,
        successfulRuns: 0,
        evidenceCompleteRuns: 0,
        missingEvidenceAlerts: 1,
        importLagP50Ms: 0,
        importLagP95Ms: 0
      },
      monitoring: {
        freshIndexes: 0,
        staleIndexes: 0,
        expiredSuppressions: 0,
        expiringSuppressions: 0,
        protectedDigests: 0,
        completeEvidenceDigests: 0,
        missingEvidenceDigests: 0
      }
    },
    sourceCompleteness: {
      review: "unavailable",
      scanner: "latest-reconciliation",
      monitoring: "latest-reconciliation",
      imageProtection: "latest-reconciliation"
    },
    ...overrides
  };
}

/** One snapshot keeps the full active set: each save resolves keys omitted from the call. */
async function seedAlerts(
  store: MemoryStore,
  repositoryId: number,
  alerts: readonly {
    alertKey: string;
    summary?: string;
    severity?: "warning" | "failing";
  }[],
  observedAt = "2026-07-29T12:00:00.000Z"
): Promise<void> {
  await store.saveMonitoringSnapshot(
    {
      repositoryId,
      snapshotKey: `v1:seed-${alerts.length}`,
      observedAt,
      inventoryState: "report-only",
      overallStatus: "failing",
      checks: []
    },
    alerts.map((alert) => ({
      alertKey: alert.alertKey,
      severity: alert.severity ?? "failing",
      summary: alert.summary ?? `${alert.alertKey} summary`
    }))
  );
}

/** Mirrors production route policy for focused HTTP tests without booting the full plane. */
function createOperationsTestServer(options: {
  store: MemoryStore;
  monitoring: { getState(): MonitoringServiceState };
  token?: string;
  trustPrivate?: boolean;
  failBuild?: boolean;
}) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.url === MONITORING_OPERATIONS_PATH) {
        if (
          request.method !== "GET" ||
          !metricsRequestAuthorized(
            request.headers.authorization,
            options.token,
            options.trustPrivate === true
          )
        ) {
          writeMonitoringOperationsUnauthorized(response);
          return;
        }
        try {
          if (options.failBuild) {
            throw new Error("database failure containing secret material");
          }
          const status = await buildMonitoringOperationsStatus({
            store: options.store,
            monitoring: options.monitoring,
            now: NOW
          });
          writeMonitoringOperationsStatus(response, status);
        } catch {
          writeMonitoringOperationsUnavailable(response);
        }
        return;
      }
      response.writeHead(404).end();
    })();
  });
}

test("UTC week keys start Monday 00:00:00.000Z with v1:YYYY-MM-DD", () => {
  assert.equal(startOfUtcWeek(NOW).toISOString(), "2026-07-27T00:00:00.000Z");
  assert.equal(monitoringUtcWeekKey(NOW), "v1:2026-07-27");
  assert.equal(
    monitoringUtcWeekKey(new Date("2026-07-27T00:00:00.000Z")),
    "v1:2026-07-27"
  );
  assert.equal(
    monitoringUtcWeekKey(new Date("2026-08-02T23:59:59.999Z")),
    "v1:2026-07-27"
  );
  assert.equal(
    monitoringUtcWeekKey(new Date("2026-08-03T00:00:00.000Z")),
    "v1:2026-08-03"
  );
});

test("assertActiveMonitoringAlertLimit rejects invalid and unbounded values", () => {
  assert.doesNotThrow(() => assertActiveMonitoringAlertLimit(1));
  assert.doesNotThrow(() =>
    assertActiveMonitoringAlertLimit(MAX_ACTIVE_MONITORING_ALERTS_LIMIT)
  );
  assert.doesNotThrow(() =>
    assertActiveMonitoringAlertLimit(DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT)
  );
  for (const limit of [0, -1, 0.5, NaN, Infinity, 513, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertActiveMonitoringAlertLimit(limit),
      /active monitoring alert limit must be a safe integer between 1 and 512/
    );
  }
});

test("listActiveMonitoringAlerts applies an optional bound and preserves unbounded default", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedAlerts(
    store,
    20,
    Array.from({ length: 5 }, (_, index) => ({ alertKey: `alert-${index}` }))
  );
  assert.equal((await store.listActiveMonitoringAlerts(20)).length, 5);
  assert.equal((await store.listActiveMonitoringAlerts()).length, 5);
  assert.equal((await store.listActiveMonitoringAlerts(20, 2)).length, 2);
  assert.equal((await store.listActiveMonitoringAlerts(undefined, 3)).length, 3);
  await assert.rejects(
    () => store.listActiveMonitoringAlerts(undefined, 0),
    /active monitoring alert limit/
  );
  await assert.rejects(
    () => store.listActiveMonitoringAlerts(undefined, 10_000),
    /active monitoring alert limit/
  );
});

test("listActiveMonitoringAlertsPage reports truncation via limit+1 and embeds fullName", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedAlerts(
    store,
    20,
    Array.from({ length: 4 }, (_, index) => ({ alertKey: `cap-${index}` }))
  );
  const page = await store.listActiveMonitoringAlertsPage(3);
  assert.equal(page.limit, 3);
  assert.equal(page.alerts.length, 3);
  assert.equal(page.truncated, true);
  assert.equal(page.alerts[0]?.fullName, "acme/service");
  assert.equal(Object.hasOwn(page.alerts[0]!, "resolvedAt"), false);
  const exact = await store.listActiveMonitoringAlertsPage(4);
  assert.equal(exact.alerts.length, 4);
  assert.equal(exact.truncated, false);
  await assert.rejects(
    () => store.listActiveMonitoringAlertsPage(0),
    /active monitoring alert limit/
  );
});

test("Postgres page SQL JOINs repositories with stable ORDER BY and LIMIT limit+1", () => {
  const storeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/store.ts"),
    "utf8"
  );
  const pageMethodStart = storeSource.indexOf(
    "async listActiveMonitoringAlertsPage(\n    limit: number = DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT"
  );
  // PostgresStore method is the second occurrence after MemoryStore.
  const postgresPageStart = storeSource.indexOf(
    "async listActiveMonitoringAlertsPage(\n    limit: number = DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT",
    pageMethodStart + 1
  );
  assert.notEqual(postgresPageStart, -1, "Postgres listActiveMonitoringAlertsPage missing");
  const queryHelperStart = storeSource.indexOf(
    "private async queryActiveMonitoringAlertsPage(",
    postgresPageStart
  );
  assert.notEqual(queryHelperStart, -1, "queryActiveMonitoringAlertsPage missing");
  const queryHelper = storeSource.slice(queryHelperStart, queryHelperStart + 2_200);
  assert.match(queryHelper, /JOIN repositories/i);
  assert.match(
    queryHelper,
    /ORDER BY alerts\.repository_id ASC, alerts\.alert_key ASC/
  );
  assert.match(queryHelper, /LIMIT \$1/);
  assert.match(queryHelper, /repositories\.full_name/);
  // Page path must not select resolved_at / dump full alert rows for operators.
  assert.doesNotMatch(queryHelper, /alerts\.resolved_at/);
  assert.doesNotMatch(queryHelper, /SELECT \*/);
  // Operations page uses limit+1 sentinel through the helper.
  const pageBody = storeSource.slice(postgresPageStart, queryHelperStart);
  assert.match(pageBody, /limit \+ 1/);
  assert.match(pageBody, /queryActiveMonitoringAlertsPage/);
});

test("buildMonitoringOperationsStatus returns sanitized ledger and current week report", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await store.upsertRepository(
    repository({ repositoryId: 21, fullName: "acme/other" })
  );
  await seedAlerts(store, 20, [
    { alertKey: "scanner-trivy", summary: "trivy evidence incomplete" }
  ]);
  await store.saveMonitoringWeeklyReport(weeklyReport());

  const status = await buildMonitoringOperationsStatus({
    store,
    monitoring: { getState: () => schedulerState() },
    now: NOW
  });

  assert.equal(status.schemaVersion, MONITORING_STATUS_SCHEMA_VERSION);
  assert.equal(status.generatedAt, NOW.toISOString());
  assert.deepEqual(status.scheduler, {
    scope: "process-local",
    state: schedulerState()
  });
  // Only the alerting repository — quiet fleet members are not dumped.
  assert.deepEqual(status.repositories, {
    returnedAlertingCount: 1,
    complete: true,
    names: ["acme/service"]
  });
  assert.equal(status.activeAlerts.limit, DEFAULT_ACTIVE_MONITORING_ALERTS_LIMIT);
  assert.equal(status.activeAlerts.returned, 1);
  assert.equal(status.activeAlerts.truncated, false);
  assert.deepEqual(status.activeAlerts.items, [
    {
      repositoryId: 20,
      fullName: "acme/service",
      alertKey: "scanner-trivy",
      severity: "failing",
      summary: "trivy evidence incomplete",
      firstObservedAt: "2026-07-29T12:00:00.000Z",
      lastObservedAt: "2026-07-29T12:00:00.000Z"
    }
  ]);
  assert.equal(status.weeklyReport?.weekKey, "v1:2026-07-27");
  assert.equal(status.weeklyReport?.report.totalRepositories, 1);
  assert.deepEqual(status.weeklyReport?.sourceCompleteness, {
    review: "unavailable",
    scanner: "latest-reconciliation",
    monitoring: "latest-reconciliation",
    imageProtection: "latest-reconciliation"
  });

  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("indexSha"), false);
  assert.equal(serialized.includes("defaultBranch"), false);
  assert.equal(serialized.includes("payload"), false);
  assert.equal(serialized.includes("resolvedAt"), false);
  assert.equal(Object.hasOwn(status.activeAlerts.items[0]!, "resolvedAt"), false);
});

test("operations status lists only alerting repository names", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository({ repositoryId: 20, fullName: "acme/alerting" }));
  await store.upsertRepository(
    repository({ repositoryId: 21, fullName: "acme/quiet" })
  );
  await store.upsertRepository(
    repository({ repositoryId: 22, fullName: "acme/also-alerting" })
  );
  await seedAlerts(store, 20, [{ alertKey: "a1", summary: "first" }]);
  await seedAlerts(store, 22, [
    { alertKey: "b1", summary: "second" },
    { alertKey: "b2", summary: "third" }
  ]);

  const status = await buildMonitoringOperationsStatus({
    store,
    monitoring: { getState: () => schedulerState() },
    now: NOW
  });

  assert.deepEqual(status.repositories, {
    returnedAlertingCount: 2,
    complete: true,
    names: ["acme/alerting", "acme/also-alerting"]
  });
  assert.equal(status.repositories.names.includes("acme/quiet"), false);
  assert.equal(status.activeAlerts.returned, 3);
});

test("operations scheduler is marked process-local and weekly report null when absent", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedAlerts(store, 20, [{ alertKey: "scanner-trivy" }]);

  const status = await buildMonitoringOperationsStatus({
    store,
    monitoring: { getState: () => schedulerState({ running: true }) },
    now: NOW
  });

  assert.equal(status.scheduler.scope, "process-local");
  assert.deepEqual(status.scheduler.state, schedulerState({ running: true }));
  assert.equal(status.weeklyReport, null);
});

test("operations response caps fullName, alertKey, and summary lengths", async () => {
  const store = new MemoryStore();
  const longName = `org/${"n".repeat(400)}`;
  const longKey = `k${"e".repeat(400)}`;
  const longSummary = `s${"u".repeat(600)}`;
  await store.upsertRepository(
    repository({ repositoryId: 20, fullName: longName })
  );
  await seedAlerts(store, 20, [
    { alertKey: longKey, summary: longSummary }
  ]);

  const status = await buildMonitoringOperationsStatus({
    store,
    monitoring: { getState: () => schedulerState() },
    now: NOW
  });

  const item = status.activeAlerts.items[0]!;
  assert.equal(item.fullName.length, MAX_OPERATIONS_REPOSITORY_FULL_NAME_LENGTH);
  assert.equal(item.alertKey.length, MAX_OPERATIONS_ALERT_KEY_LENGTH);
  assert.equal(item.summary.length, MAX_OPERATIONS_ALERT_SUMMARY_LENGTH);
  assert.equal(item.fullName, longName.slice(0, MAX_OPERATIONS_REPOSITORY_FULL_NAME_LENGTH));
  assert.equal(item.alertKey, longKey.slice(0, MAX_OPERATIONS_ALERT_KEY_LENGTH));
  assert.equal(item.summary, longSummary.slice(0, MAX_OPERATIONS_ALERT_SUMMARY_LENGTH));
  assert.equal(
    status.repositories.names[0]?.length,
    MAX_OPERATIONS_REPOSITORY_FULL_NAME_LENGTH
  );
});

test("buildMonitoringOperationsStatus does not call listMonitoringRepositoryInventory", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedAlerts(store, 20, [{ alertKey: "scanner-trivy" }]);

  let inventoryCalls = 0;
  const guarded = {
    listActiveMonitoringAlertsPage: store.listActiveMonitoringAlertsPage.bind(store),
    getMonitoringWeeklyReport: store.getMonitoringWeeklyReport.bind(store),
    listMonitoringRepositoryInventory: async () => {
      inventoryCalls += 1;
      throw new Error("inventory must not be loaded for operations status");
    }
  };

  const status = await buildMonitoringOperationsStatus({
    store: guarded,
    monitoring: { getState: () => schedulerState() },
    now: NOW
  });

  assert.equal(inventoryCalls, 0);
  assert.equal(status.repositories.returnedAlertingCount, 1);
  assert.equal(status.repositories.complete, true);

  const opsSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/monitoring-operations.ts"),
    "utf8"
  );
  assert.doesNotMatch(opsSource, /listMonitoringRepositoryInventory/);
});

test("buildMonitoringOperationsStatus bounds alerts and marks truncation", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedAlerts(
    store,
    20,
    Array.from({ length: 5 }, (_, index) => ({ alertKey: `bound-${index}` }))
  );
  const status = await buildMonitoringOperationsStatus({
    store,
    monitoring: { getState: () => schedulerState({ activeAlerts: 5 }) },
    now: NOW,
    alertLimit: 3
  });
  assert.equal(status.activeAlerts.limit, 3);
  assert.equal(status.activeAlerts.returned, 3);
  assert.equal(status.activeAlerts.truncated, true);
  assert.equal(status.activeAlerts.items.length, 3);
  assert.equal(status.repositories.returnedAlertingCount, 1);
  assert.equal(status.repositories.complete, false);
});

test("Caddy public edge 404s /metrics and exact /operations/monitoring", () => {
  const caddyfile = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../infra/Caddyfile"
    ),
    "utf8"
  );
  assert.match(
    caddyfile,
    /@internal_metrics\s+path\s+\/metrics\s+\/operations\/monitoring/
  );
  assert.match(caddyfile, /respond @internal_metrics 404/);
  // Must not reverse-proxy these private paths through the public hostname block.
  const publicBlock = caddyfile.slice(
    caddyfile.indexOf("{$GUARDIANBOT_HOSTNAME}"),
    caddyfile.length
  );
  assert.match(publicBlock, /path \/metrics \/operations\/monitoring/);
});

test("operations HTTP route enforces metrics auth, GET-only, no-store, and static 503", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedAlerts(store, 20, [
    { alertKey: "scanner-trivy", summary: "trivy evidence incomplete" }
  ]);
  await store.saveMonitoringWeeklyReport(weeklyReport());

  const server = createOperationsTestServer({
    store,
    monitoring: { getState: () => schedulerState() },
    token: "ops-token"
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await fetch(`${base}${MONITORING_OPERATIONS_PATH}`);
    assert.equal(unauthorized.status, 404);
    assert.equal(await unauthorized.text(), "");

    const wrongToken = await fetch(`${base}${MONITORING_OPERATIONS_PATH}`, {
      headers: { authorization: "Bearer wrong" }
    });
    assert.equal(wrongToken.status, 404);
    assert.equal(await wrongToken.text(), "");

    const queryVariant = await fetch(`${base}${MONITORING_OPERATIONS_PATH}?verbose=1`, {
      headers: { authorization: "Bearer ops-token" }
    });
    assert.equal(queryVariant.status, 404);

    const post = await fetch(`${base}${MONITORING_OPERATIONS_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer ops-token" }
    });
    assert.equal(post.status, 404);
    assert.equal(await post.text(), "");

    const ok = await fetch(`${base}${MONITORING_OPERATIONS_PATH}`, {
      headers: { authorization: "Bearer ops-token" }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/json");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = (await ok.json()) as Awaited<
      ReturnType<typeof buildMonitoringOperationsStatus>
    >;
    assert.equal(body.schemaVersion, MONITORING_STATUS_SCHEMA_VERSION);
    assert.equal(body.scheduler.scope, "process-local");
    assert.equal(body.activeAlerts.items[0]?.fullName, "acme/service");
    assert.deepEqual(body.repositories, {
      returnedAlertingCount: 1,
      complete: true,
      names: ["acme/service"]
    });
    assert.equal(body.weeklyReport?.weekKey, "v1:2026-07-27");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("operations HTTP route returns static 503 JSON on internal failure", async () => {
  const store = new MemoryStore();
  const server = createOperationsTestServer({
    store,
    monitoring: { getState: () => schedulerState() },
    token: "ops-token",
    failBuild: true
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}${MONITORING_OPERATIONS_PATH}`,
      { headers: { authorization: "Bearer ops-token" } }
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.equal(text, MONITORING_OPERATIONS_UNAVAILABLE_BODY);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("database"), false);
    assert.equal(text.includes("Error"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("server wires monitoring operations beside metrics with the same auth policy", () => {
  const serverSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts"),
    "utf8"
  );
  const routeStart = serverSource.indexOf(
    'if (request.url === MONITORING_OPERATIONS_PATH)'
  );
  assert.notEqual(routeStart, -1, "operations route not wired");
  const section = serverSource.slice(routeStart, routeStart + 1_200);
  assert.match(section, /request\.method !== "GET"/);
  assert.match(section, /metricsRequestAuthorized/);
  assert.match(section, /GUARDIANBOT_METRICS_BEARER_TOKEN/);
  assert.match(section, /GUARDIANBOT_TRUST_PRIVATE_METRICS/);
  assert.match(section, /buildMonitoringOperationsStatus/);
  assert.match(section, /guardianbot\.monitoring_operations_failed/);
  assert.match(section, /boundedErrorKind\(error\)/);
  assert.match(section, /writeMonitoringOperationsUnavailable/);
  // Query-string variants must not match: exact path equality only, like /metrics.
  assert.doesNotMatch(section, /request\.url\.startsWith\(MONITORING_OPERATIONS_PATH\)/);
  assert.doesNotMatch(section, /new URL\(/);
});
