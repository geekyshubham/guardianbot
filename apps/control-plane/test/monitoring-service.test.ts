import assert from "node:assert/strict";
import { test } from "node:test";
import {
  indexRepositorySyntaxAware,
  toPersistedVectorRows,
  type GuardianConfig,
  type PersistedVectorRow
} from "@guardianbot/core";
import {
  MAX_MONITORING_INTERVAL_MS,
  MIN_MONITORING_INTERVAL_MS,
  MonitoringService,
  monitoringOptionsFromEnvironment
} from "../src/monitoring-service.js";
import {
  MemoryStore,
  buildRepositoryIndexVectorBatchStatement,
  type RepositoryRecord,
  type ScannerEvidenceRecord,
  type ScannerWorkflowRunRecord
} from "../src/store.js";

const INITIAL_NOW = Date.parse("2026-07-27T12:00:00.000Z");

function repository(
  overrides: Partial<RepositoryRecord> = {}
): RepositoryRecord {
  return {
    installationId: 10,
    repositoryId: 20,
    fullName: "acme/service",
    visibility: "private",
    defaultBranch: "main",
    indexSha: "a".repeat(40),
    indexUpdatedAt: "2026-07-27T11:50:00.000Z",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false,
    ...overrides
  };
}

function scannerRun(
  overrides: Partial<ScannerWorkflowRunRecord> = {}
): ScannerWorkflowRunRecord {
  return {
    repositoryId: 20,
    runId: 500,
    runAttempt: 1,
    headSha: "a".repeat(40),
    headBranch: "main",
    event: "schedule",
    startedAt: "2026-07-27T11:30:00.000Z",
    completedAt: "2026-07-27T11:40:00.000Z",
    workflowPath: ".github/workflows/guardianbot.yml",
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: [],
    processedAt: "2026-07-27T11:40:00.000Z",
    ...overrides
  };
}

function evidence(
  evidenceKey: string,
  kind: string,
  status: "success" | "failure" = "success",
  overrides: Partial<ScannerEvidenceRecord> = {}
): ScannerEvidenceRecord {
  return {
    repositoryId: 20,
    runId: 500,
    runAttempt: 1,
    artifactId: 700,
    artifactType: "security",
    evidenceKey,
    kind,
    source: "test",
    status,
    observedAt: "2026-07-27T11:45:00.000Z",
    ...overrides
  };
}

async function seedConfiguredRepository(store: MemoryStore): Promise<void> {
  await store.upsertRepository(repository());
  await seedImmutableConfigIndex(store);
  await store.upsertScannerWorkflowRun(scannerRun());
  await store.upsertScannerEvidence(evidence("semgrep-summary", "semgrep"));
  await store.upsertScannerEvidence(
    evidence("trivy-summary", "trivy", "failure", {
      details: "request failed for https://operator:secret@example.invalid"
    })
  );
  await store.upsertScannerEvidence(
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import")
  );
}

async function seedImmutableConfigIndex(
  store: MemoryStore,
  overrides: Partial<GuardianConfig["scanners"]> = {},
  baselineContent?: string
): Promise<void> {
  const config: GuardianConfig = {
    schemaVersion: "1.0.0",
    workflowVersion: "b".repeat(40),
    repository: {
      defaultBranch: "main",
      releaseBranches: [],
      languages: ["typescript"]
    },
    review: {
      automatic: true,
      drafts: "skip",
      incremental: true,
      maxInlineComments: 10,
      categories: [],
      highRiskPaths: []
    },
    scanners: {
      mode: "report-only",
      semgrep: true,
      trivy: true,
      suppressions: [],
      ...overrides
    },
    image: null,
    dast: null
  };
  const files: Record<string, string> = {
    ".guardianbot/config.yml": JSON.stringify(config)
  };
  if (baselineContent !== undefined) {
    files[".guardianbot/baseline.json"] = baselineContent;
  }
  const index = await indexRepositorySyntaxAware({
    repository: "acme/service",
    repositoryId: 20,
    repositoryScope: "github:20",
    visibility: "private",
    commitSha: "a".repeat(40),
    files
  });
  await store.replaceRepositoryIndex(
    20,
    index,
    toPersistedVectorRows(index),
    new Date("2026-07-27T11:50:00.000Z")
  );
}

class FailingInventoryStore extends MemoryStore {
  override async listMonitoringRepositoryInventory(): Promise<never> {
    throw new Error("database failure containing secret material");
  }
}

test("monitoring environment defaults off in tests and enforces production interval bounds", () => {
  assert.deepEqual(monitoringOptionsFromEnvironment({ NODE_ENV: "test" }), {
    enabled: false,
    intervalMs: 15 * 60_000
  });
  assert.deepEqual(
    monitoringOptionsFromEnvironment({
      NODE_ENV: "test",
      GUARDIANBOT_MONITORING_ENABLED: "true",
      GUARDIANBOT_MONITORING_INTERVAL_MS: String(MIN_MONITORING_INTERVAL_MS)
    }),
    {
      enabled: true,
      intervalMs: MIN_MONITORING_INTERVAL_MS
    }
  );
  assert.throws(
    () =>
      monitoringOptionsFromEnvironment({
        GUARDIANBOT_MONITORING_INTERVAL_MS: String(MIN_MONITORING_INTERVAL_MS - 1)
      }),
    /must be an integer between/
  );
  assert.throws(
    () =>
      monitoringOptionsFromEnvironment({
        GUARDIANBOT_MONITORING_INTERVAL_MS: String(MAX_MONITORING_INTERVAL_MS + 1)
      }),
    /must be an integer between/
  );
});

test("reconciliation persists sanitized snapshots and idempotent alerts from stored evidence", async () => {
  const store = new MemoryStore();
  await seedConfiguredRepository(store);
  let nowMs = INITIAL_NOW;
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(nowMs) }
  });

  const first = await monitoring.reconcileOnce();
  assert.equal(first.acquired, true);
  assert.equal(first.repositoriesEvaluated, 1);
  assert.equal(first.failingRepositories, 1);
  assert.equal(first.activeAlerts, 2);

  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.inventoryState, "report-only");
  assert.equal(snapshot?.overallStatus, "failing");
  assert.equal(snapshot?.checks.find((check) => check.key === "scanner-trivy")?.status, "failing");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-trivy-import")?.status,
    "failing"
  );
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(
    Object.hasOwn(snapshot?.checks.find((check) => check.key === "scanner-trivy") ?? {}, "metadata"),
    false
  );

  const firstAlerts = await store.listActiveMonitoringAlerts(20);
  assert.deepEqual(
    firstAlerts.map((alert) => alert.alertKey),
    ["scanner-trivy", "scanner-trivy-import"]
  );
  await monitoring.reconcileOnce();
  const repeatedAlerts = await store.listActiveMonitoringAlerts(20);
  assert.deepEqual(
    repeatedAlerts.map((alert) => alert.firstObservedAt),
    firstAlerts.map((alert) => alert.firstObservedAt)
  );

  nowMs += 2 * 60_000;
  await store.upsertScannerWorkflowRun(
    scannerRun({
      runId: 501,
      startedAt: new Date(nowMs - 60_000).toISOString(),
      completedAt: new Date(nowMs - 30_000).toISOString(),
      processedAt: new Date(nowMs - 20_000).toISOString()
    })
  );
  await store.upsertScannerEvidence(
    evidence("trivy-summary", "trivy", "success", {
      runId: 501,
      observedAt: new Date(nowMs - 30_000).toISOString()
    })
  );
  await store.upsertScannerEvidence(
    evidence("semgrep-summary", "semgrep", "success", {
      runId: 501,
      observedAt: new Date(nowMs - 30_000).toISOString()
    })
  );
  await store.upsertScannerEvidence(
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import", "success", {
      runId: 501,
      observedAt: new Date(nowMs - 30_000).toISOString()
    })
  );
  await store.upsertScannerEvidence(
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import", "success", {
      runId: 501,
      observedAt: new Date(nowMs - 30_000).toISOString()
    })
  );
  const recovered = await monitoring.reconcileOnce();
  assert.equal(recovered.activeAlerts, 0);
  assert.deepEqual(await store.listActiveMonitoringAlerts(20), []);
  assert.equal((await store.getLatestMonitoringSnapshot(20))?.overallStatus, "passing");

  const metrics = monitoring.renderMetrics();
  assert.match(metrics, /guardianbot_monitoring_repositories 1/);
  assert.match(metrics, /guardianbot_monitoring_active_alerts 0/);
  assert.equal(metrics.includes("acme/service"), false);
  assert.equal(metrics.includes("secret"), false);

  const weekly = await store.getMonitoringWeeklyReport("v1:2026-07-27");
  assert.equal(weekly?.generatedAt, new Date(nowMs).toISOString());
  assert.equal(weekly?.periodStart, "2026-07-27T00:00:00.000Z");
  assert.equal(weekly?.periodEnd, new Date(nowMs).toISOString());
  assert.equal(weekly?.report.totalRepositories, 1);
  assert.equal(weekly?.report.scanner.expectedRuns, 1);
  assert.equal(weekly?.report.scanner.successfulRuns, 1);
  assert.equal(weekly?.report.scanner.evidenceCompleteRuns, 1);
  assert.equal(weekly?.report.review.prsReviewed, 0);
  assert.deepEqual(weekly?.sourceCompleteness, {
    review: "unavailable",
    scanner: "latest-reconciliation",
    monitoring: "latest-reconciliation",
    imageProtection: "latest-reconciliation"
  });
});

test("the Store lock skips a competing reconciliation and releases cleanly", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository({ scannerState: "not-configured" }));
  const held = await store.acquireMonitoringLock();
  assert.ok(held);
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  assert.equal((await monitoring.reconcileOnce()).acquired, false);
  assert.equal(monitoring.getState().lockSkippedTotal, 1);
  await held.release();
  assert.equal((await monitoring.reconcileOnce()).acquired, true);
  const nextLock = await store.acquireMonitoringLock();
  assert.ok(nextLock);
  await nextLock.release();
});

test("a fresh default-branch push cannot satisfy the scheduled-run expectation", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedImmutableConfigIndex(store);
  await store.upsertScannerWorkflowRun(
    scannerRun({
      event: "push",
      runId: 600
    })
  );
  for (const record of [
    evidence("semgrep-summary", "semgrep", "success", { runId: 600 }),
    evidence("trivy-summary", "trivy", "success", { runId: 600 }),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import", "success", {
      runId: 600
    }),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import", "success", {
      runId: 600
    })
  ]) {
    await store.upsertScannerEvidence(record);
  }
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.inventoryState, "missing-expected-runs");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-run")?.status,
    "failing"
  );
});

test("immutable scanner toggles control which evidence is required", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedImmutableConfigIndex(store, { semgrep: false, trivy: true });
  await store.upsertScannerWorkflowRun(scannerRun());
  await store.upsertScannerEvidence(evidence("trivy-summary", "trivy"));
  await store.upsertScannerEvidence(
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import")
  );
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.overallStatus, "passing");
  assert.equal(
    snapshot?.checks.some((check) => check.key.includes("semgrep")),
    false
  );
});

test("reconciliation combines security and DAST evidence from separate exact-head schedules", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedImmutableConfigIndex(store);
  const configIndex = await store.getRepositoryIndex(
    20,
    "github:20",
    "a".repeat(40)
  );
  assert.ok(configIndex);
  const configSymbol = configIndex.symbols.find(
    (symbol) => symbol.path === ".guardianbot/config.yml"
  );
  assert.ok(configSymbol);
  const config = JSON.parse(configSymbol.content) as GuardianConfig;
  config.dast = {
    allowedOrigin: "https://staging.example.com",
    openapi: "openapi.json",
    openapiSource: "repository-file",
    authenticationProfile: "control-plane://profiles/service-staging",
    sessionAssertionPath: "/api/session"
  };
  const updatedIndex = await indexRepositorySyntaxAware({
    repository: "acme/service",
    repositoryId: 20,
    repositoryScope: "github:20",
    visibility: "private",
    commitSha: "a".repeat(40),
    files: { ".guardianbot/config.yml": JSON.stringify(config) }
  });
  await store.replaceRepositoryIndex(
    20,
    updatedIndex,
    toPersistedVectorRows(updatedIndex),
    new Date("2026-07-27T11:50:00.000Z")
  );

  await store.upsertScannerWorkflowRun(scannerRun({ runId: 500 }));
  await store.upsertScannerWorkflowRun(
    scannerRun({
      runId: 501,
      startedAt: "2026-07-27T11:41:00.000Z",
      completedAt: "2026-07-27T11:46:00.000Z",
      processedAt: "2026-07-27T11:46:00.000Z"
    })
  );
  await store.upsertScannerWorkflowRun(
    scannerRun({
      runId: 502,
      startedAt: "2026-07-27T11:47:00.000Z",
      completedAt: "2026-07-27T11:55:00.000Z",
      processedAt: "2026-07-27T11:55:00.000Z"
    })
  );
  for (const record of [
    evidence("semgrep-summary", "semgrep", "success", { runId: 500 }),
    evidence("trivy-summary", "trivy", "success", { runId: 500 }),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import", "success", {
      runId: 500
    }),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import", "success", {
      runId: 500
    }),
    evidence("zap-smoke-summary", "zap-smoke", "success", {
      runId: 501,
      artifactId: 701,
      artifactType: "dast"
    }),
    evidence("defectdojo-import:ZAP Scan:smoke", "defectdojo-import", "success", {
      runId: 501,
      artifactId: 701,
      artifactType: "dast"
    }),
    evidence("zap-nightly-summary", "zap-nightly", "success", {
      runId: 502,
      artifactId: 702,
      artifactType: "dast"
    }),
    evidence("defectdojo-import:ZAP Scan:nightly", "defectdojo-import", "success", {
      runId: 502,
      artifactId: 702,
      artifactType: "dast"
    })
  ]) {
    await store.upsertScannerEvidence(record);
  }

  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });
  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.overallStatus, "passing");
  assert.equal(snapshot?.checks.find((check) => check.key === "scanner-semgrep")?.status, "passing");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-zap-smoke")?.status,
    "passing"
  );
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-zap-nightly")?.status,
    "passing"
  );
});

test("image monitoring requires deployment evidence for the exact signed digest", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedImmutableConfigIndex(store);
  const configIndex = await store.getRepositoryIndex(
    20,
    "github:20",
    "a".repeat(40)
  );
  assert.ok(configIndex);
  const configSymbol = configIndex.symbols.find(
    (symbol) => symbol.path === ".guardianbot/config.yml"
  );
  assert.ok(configSymbol);
  const config = JSON.parse(configSymbol.content) as GuardianConfig;
  config.image = {
    name: "acme/service",
    dockerfile: "Dockerfile",
    context: ".",
    platform: "linux/amd64",
    registry: "ghcr.io/acme/service",
    healthPath: "/healthz",
    sbomFormat: "cyclonedx-json",
    deployment: {
      environment: "staging",
      requireImmutableDigest: true,
      requireSignature: true,
      requireSbom: true
    }
  };
  const updatedIndex = await indexRepositorySyntaxAware({
    repository: "acme/service",
    repositoryId: 20,
    repositoryScope: "github:20",
    visibility: "private",
    commitSha: "a".repeat(40),
    files: { ".guardianbot/config.yml": JSON.stringify(config) }
  });
  await store.replaceRepositoryIndex(
    20,
    updatedIndex,
    toPersistedVectorRows(updatedIndex),
    new Date("2026-07-27T11:50:00.000Z")
  );
  await store.upsertScannerWorkflowRun(scannerRun({ runId: 500 }));
  await store.upsertScannerWorkflowRun(
    scannerRun({
      runId: 501,
      event: "push",
      startedAt: "2026-07-27T11:41:00.000Z",
      completedAt: "2026-07-27T11:50:00.000Z",
      processedAt: "2026-07-27T11:50:00.000Z"
    })
  );
  const signedDigest = `sha256:${"d".repeat(64)}`;
  for (const record of [
    evidence("semgrep-summary", "semgrep"),
    evidence("trivy-summary", "trivy"),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import"),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import"),
    evidence("image-trivy-summary", "trivy", "success", {
      artifactId: 701,
      artifactType: "image-validation"
    }),
    evidence("sbom", "sbom", "success", {
      artifactId: 701,
      artifactType: "image-validation"
    }),
    evidence("signature", "signature", "success", {
      runId: 501,
      artifactId: 702,
      artifactType: "image-promotion",
      digest: signedDigest
    }),
    evidence("deployment:staging", "deployment", "success", {
      runId: 501,
      artifactId: 702,
      artifactType: "image-promotion",
      digest: `sha256:${"e".repeat(64)}`,
      environment: "staging"
    })
  ]) {
    await store.upsertScannerEvidence(record);
  }
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  let snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(
    snapshot?.checks.find((check) => check.key === "image-signature")?.status,
    "passing"
  );
  assert.equal(
    snapshot?.checks.find((check) => check.key === "image-deployment")?.status,
    "failing"
  );

  await store.upsertScannerEvidence(
    evidence("deployment:staging", "deployment", "success", {
      runId: 501,
      artifactId: 702,
      artifactType: "image-promotion",
      digest: signedDigest,
      environment: "staging"
    })
  );
  await monitoring.reconcileOnce();
  snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(
    snapshot?.checks.find((check) => check.key === "image-deployment")?.status,
    "passing"
  );
  assert.equal(snapshot?.overallStatus, "passing");
  const weekly = await store.getMonitoringWeeklyReport("v1:2026-07-27");
  assert.equal(weekly?.report.monitoring.protectedDigests, 1);
  assert.equal(weekly?.report.monitoring.completeEvidenceDigests, 1);
  assert.equal(weekly?.report.monitoring.missingEvidenceDigests, 0);
});

test("DAST monitoring requires the signed deployed digest and environment", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository());
  await seedImmutableConfigIndex(store);
  const configIndex = await store.getRepositoryIndex(
    20,
    "github:20",
    "a".repeat(40)
  );
  assert.ok(configIndex);
  const configSymbol = configIndex.symbols.find(
    (symbol) => symbol.path === ".guardianbot/config.yml"
  );
  assert.ok(configSymbol);
  const config = JSON.parse(configSymbol.content) as GuardianConfig;
  config.image = {
    name: "acme/service",
    dockerfile: "Dockerfile",
    context: ".",
    platform: "linux/amd64",
    registry: "ghcr.io/acme/service",
    healthPath: "/healthz",
    sbomFormat: "cyclonedx-json",
    deployment: {
      environment: "staging",
      requireImmutableDigest: true,
      requireSignature: true,
      requireSbom: true
    }
  };
  config.dast = {
    allowedOrigin: "https://staging.example.com",
    openapi: "openapi.json",
    openapiSource: "repository-file",
    authenticationProfile: "control-plane://profiles/service-staging",
    sessionAssertionPath: "/api/session"
  };
  const updatedIndex = await indexRepositorySyntaxAware({
    repository: "acme/service",
    repositoryId: 20,
    repositoryScope: "github:20",
    visibility: "private",
    commitSha: "a".repeat(40),
    files: { ".guardianbot/config.yml": JSON.stringify(config) }
  });
  await store.replaceRepositoryIndex(
    20,
    updatedIndex,
    toPersistedVectorRows(updatedIndex),
    new Date("2026-07-27T11:50:00.000Z")
  );
  for (const run of [
    scannerRun({ runId: 500 }),
    scannerRun({ runId: 501, event: "push" }),
    scannerRun({ runId: 502 }),
    scannerRun({ runId: 503 })
  ]) {
    await store.upsertScannerWorkflowRun(run);
  }
  const signedDigest = `sha256:${"d".repeat(64)}`;
  const wrongDigest = `sha256:${"e".repeat(64)}`;
  const requiredEvidence = [
    evidence("semgrep-summary", "semgrep"),
    evidence("trivy-summary", "trivy"),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import"),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import"),
    evidence("image-trivy-summary", "trivy", "success", {
      artifactId: 701,
      artifactType: "image-validation"
    }),
    evidence("sbom", "sbom", "success", {
      artifactId: 701,
      artifactType: "image-validation"
    }),
    evidence("signature", "signature", "success", {
      runId: 501,
      artifactId: 702,
      artifactType: "image-promotion",
      digest: signedDigest
    }),
    evidence("deployment:staging", "deployment", "success", {
      runId: 501,
      artifactId: 702,
      artifactType: "image-promotion",
      digest: signedDigest,
      environment: "staging"
    })
  ];
  const dastEvidence = (digest: string) => [
    evidence("zap-smoke-summary", "zap-smoke", "success", {
      runId: 502,
      artifactId: 703,
      artifactType: "dast",
      digest,
      environment: "staging"
    }),
    evidence("defectdojo-import:ZAP Scan:smoke", "defectdojo-import", "success", {
      runId: 502,
      artifactId: 703,
      artifactType: "dast",
      digest,
      environment: "staging"
    }),
    evidence("zap-nightly-summary", "zap-nightly", "success", {
      runId: 503,
      artifactId: 704,
      artifactType: "dast",
      digest,
      environment: "staging"
    }),
    evidence("defectdojo-import:ZAP Scan:nightly", "defectdojo-import", "success", {
      runId: 503,
      artifactId: 704,
      artifactType: "dast",
      digest,
      environment: "staging"
    })
  ];
  for (const record of [...requiredEvidence, ...dastEvidence(wrongDigest)]) {
    await store.upsertScannerEvidence(record);
  }
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });
  await monitoring.reconcileOnce();
  let snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-zap-smoke")?.status,
    "failing"
  );
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-zap-nightly")?.status,
    "failing"
  );

  for (const record of dastEvidence(signedDigest)) {
    await store.upsertScannerEvidence(record);
  }
  await monitoring.reconcileOnce();
  snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-zap-smoke")?.status,
    "passing"
  );
  assert.equal(
    snapshot?.checks.find((check) => check.key === "scanner-zap-nightly")?.status,
    "passing"
  );
  assert.equal(snapshot?.overallStatus, "passing");
});

test("missing immutable configuration is explicit and cannot produce a healthy snapshot", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository({ scannerState: "not-configured" }));
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.inventoryState, "misconfigured");
  assert.equal(snapshot?.overallStatus, "failing");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "config-observability")?.status,
    "failing"
  );
});

test("enforcement never assumes an unpersisted baseline is ready", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository({ scannerState: "enforced" }));
  await seedImmutableConfigIndex(store, { mode: "enforce" });
  await store.upsertScannerWorkflowRun(scannerRun());
  for (const record of [
    evidence("semgrep-summary", "semgrep"),
    evidence("trivy-summary", "trivy"),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import"),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import")
  ]) {
    await store.upsertScannerEvidence(record);
  }
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.inventoryState, "misconfigured");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "baseline-readiness")?.status,
    "failing"
  );
});

test("enforcement accepts a valid non-empty baseline from the exact immutable index", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository({ scannerState: "enforced" }));
  await seedImmutableConfigIndex(
    store,
    { mode: "enforce" },
    JSON.stringify({ fingerprints: ["c".repeat(64)] })
  );
  await store.upsertScannerWorkflowRun(scannerRun());
  for (const record of [
    evidence("semgrep-summary", "semgrep"),
    evidence("trivy-summary", "trivy"),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import"),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import")
  ]) {
    await store.upsertScannerEvidence(record);
  }
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.inventoryState, "enforced");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "baseline-readiness")?.status,
    "passing"
  );
});

test("enforcement rejects an invalid baseline from the exact immutable index", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(repository({ scannerState: "enforced" }));
  await seedImmutableConfigIndex(
    store,
    { mode: "enforce" },
    JSON.stringify({ fingerprints: ["not-a-fingerprint"] })
  );
  await store.upsertScannerWorkflowRun(scannerRun());
  for (const record of [
    evidence("semgrep-summary", "semgrep"),
    evidence("trivy-summary", "trivy"),
    evidence("defectdojo-import:Semgrep JSON Report", "defectdojo-import"),
    evidence("defectdojo-import:Trivy Scan", "defectdojo-import")
  ]) {
    await store.upsertScannerEvidence(record);
  }
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await monitoring.reconcileOnce();
  const snapshot = await store.getLatestMonitoringSnapshot(20);
  assert.equal(snapshot?.inventoryState, "misconfigured");
  assert.equal(
    snapshot?.checks.find((check) => check.key === "baseline-readiness")?.status,
    "failing"
  );
});

test("alerts are resolved when a repository leaves the active inventory", async () => {
  const store = new MemoryStore();
  await seedConfiguredRepository(store);
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });
  await monitoring.reconcileOnce();
  assert.equal((await store.listActiveMonitoringAlerts(20)).length, 2);

  await store.setRepositoryState(20, "suspended");
  const result = await monitoring.reconcileOnce();
  assert.equal(result.repositoriesEvaluated, 0);
  assert.deepEqual(await store.listActiveMonitoringAlerts(20), []);
});

test("failed reconciliation releases the singleton lock and retains only a bounded error kind", async () => {
  const store = new FailingInventoryStore();
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 15 * 60_000,
    clock: { now: () => new Date(INITIAL_NOW) }
  });

  await assert.rejects(() => monitoring.reconcileOnce(), /database failure/);
  assert.equal(monitoring.getState().failuresTotal, 1);
  assert.equal(monitoring.getState().lastErrorKind, "Error");
  assert.equal(JSON.stringify(monitoring.getState()).includes("secret"), false);
  const lock = await store.acquireMonitoringLock();
  assert.ok(lock);
  await lock.release();
});

test("scheduler start and stop abort the interval wait without leaving work running", async () => {
  const store = new MemoryStore();
  let sleepEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    sleepEntered = resolve;
  });
  const monitoring = new MonitoringService(store, {
    enabled: true,
    intervalMs: 60_000,
    clock: { now: () => new Date(INITIAL_NOW) },
    sleep: async (_milliseconds, signal) => {
      sleepEntered();
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });

  monitoring.start();
  await entered;
  assert.equal(monitoring.ready(), true);
  await monitoring.stop();
  assert.equal(monitoring.getState().started, false);
  assert.equal(monitoring.getState().running, false);
});

test("repository vector batch placeholders cover every value in both storage modes", () => {
  const vectors: PersistedVectorRow[] = [
    {
      storageKey: "one",
      repositoryScope: "installation:10:repository:20",
      commitSha: "a".repeat(40),
      visibility: "private",
      providerId: "local-test",
      dimensions: 2,
      recordType: "symbol",
      recordId: "symbol:one",
      path: "src/one.ts",
      vector: [0.1, 0.2]
    },
    {
      storageKey: "two",
      repositoryScope: "installation:10:repository:20",
      commitSha: "a".repeat(40),
      visibility: "private",
      providerId: "local-test",
      dimensions: 2,
      recordType: "history",
      recordId: "history:two",
      vector: [0.3, 0.4]
    }
  ];

  const fallback = buildRepositoryIndexVectorBatchStatement(20, vectors, false);
  assert.ok(fallback);
  assert.equal(fallback.values.length, 22);
  assert.match(fallback.text, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11\),\(\$12/);
  assert.equal(maxPlaceholder(fallback.text), fallback.values.length);

  const pgvector = buildRepositoryIndexVectorBatchStatement(20, vectors, true);
  assert.ok(pgvector);
  assert.equal(pgvector.values.length, 24);
  assert.match(pgvector.text, /\$12::vector\),\(\$13/);
  assert.match(pgvector.text, /\$24::vector\)/);
  assert.equal(maxPlaceholder(pgvector.text), pgvector.values.length);
});

function maxPlaceholder(query: string): number {
  return Math.max(
    ...[...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  );
}
