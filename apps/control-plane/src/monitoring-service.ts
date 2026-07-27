import { setTimeout as delay } from "node:timers/promises";
import {
  parseGuardianConfig,
  type GuardianConfig
} from "@guardianbot/core";
import {
  evaluateRepositoryMonitoring,
  type EvidenceKind,
  type EvidenceRequirement,
  type MonitoringCheckResult,
  type MonitoringClock,
  type ObservedWorkflowRun,
  type RepositoryMonitoringSnapshot,
  systemClock,
  worstMonitoringStatus
} from "@guardianbot/monitoring";
import type {
  MonitoringAlertInput,
  MonitoringRepositoryInventory,
  MonitoringSnapshotRecord,
  PersistedMonitoringCheck,
  ScannerWorkflowRunRecord,
  Store
} from "./store.js";

export const DEFAULT_MONITORING_INTERVAL_MS = 15 * 60_000;
export const MIN_MONITORING_INTERVAL_MS = 60_000;
export const MAX_MONITORING_INTERVAL_MS = 24 * 60 * 60_000;

const DEFAULT_INDEX_WARN_AFTER_MS = 6 * 60 * 60_000;
const DEFAULT_INDEX_FAIL_AFTER_MS = 24 * 60 * 60_000;
const DEFAULT_SCANNER_MAX_AGE_MS = 36 * 60 * 60_000;
const DEFAULT_EVIDENCE_MAX_AGE_MS = 36 * 60 * 60_000;
const MAX_READINESS_STALENESS_MS = 24 * 60 * 60_000;
const MIN_READINESS_STALENESS_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES_FOR_READINESS = 3;
const EXPECTED_SCANNER_WORKFLOW = ".github/workflows/guardianbot.yml";
const WORKFLOW_EVENTS = new Set([
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch"
]);
const SEMGREP_EVIDENCE_KEY = "semgrep-summary";
const TRIVY_EVIDENCE_KEY = "trivy-summary";
const SEMGREP_IMPORT_EVIDENCE_KEY = "defectdojo-import:Semgrep JSON Report";
const TRIVY_IMPORT_EVIDENCE_KEY = "defectdojo-import:Trivy Scan";
const IMAGE_TRIVY_EVIDENCE_KEY = "image-trivy-summary";
const SBOM_EVIDENCE_KEY = "sbom";
const SIGNATURE_EVIDENCE_KEY = "signature";
const ZAP_EVIDENCE_KEY = "zap-summary";
const ZAP_IMPORT_EVIDENCE_KEY = "defectdojo-import:ZAP Scan";
const SUPPRESSION_NOTIFY_BEFORE_MS = 7 * 24 * 60 * 60_000;
const MONITORED_EVIDENCE_KEYS = new Set([
  SEMGREP_EVIDENCE_KEY,
  TRIVY_EVIDENCE_KEY,
  SEMGREP_IMPORT_EVIDENCE_KEY,
  TRIVY_IMPORT_EVIDENCE_KEY,
  IMAGE_TRIVY_EVIDENCE_KEY,
  SBOM_EVIDENCE_KEY,
  SIGNATURE_EVIDENCE_KEY,
  ZAP_EVIDENCE_KEY,
  ZAP_IMPORT_EVIDENCE_KEY
]);
const SUPPORTED_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "semgrep",
  "trivy",
  "zap-smoke",
  "zap-nightly",
  "defectdojo-import",
  "sbom",
  "signature",
  "deployment"
]);

export interface MonitoringServiceOptions {
  enabled: boolean;
  intervalMs: number;
  clock?: MonitoringClock;
  indexWarnAfterMs?: number;
  indexFailAfterMs?: number;
  scannerMaxAgeMs?: number;
  evidenceMaxAgeMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  logger?: Pick<Console, "error">;
}

export interface MonitoringServiceState {
  enabled: boolean;
  started: boolean;
  running: boolean;
  lastAttemptAt?: string;
  lastCycleAt?: string;
  lastSuccessAt?: string;
  lastErrorKind?: string;
  lastDurationMs: number;
  consecutiveFailures: number;
  runsTotal: number;
  successesTotal: number;
  failuresTotal: number;
  lockSkippedTotal: number;
  repositoriesEvaluated: number;
  failingRepositories: number;
  warningRepositories: number;
  activeAlerts: number;
}

export interface MonitoringRunResult {
  acquired: boolean;
  repositoriesEvaluated: number;
  failingRepositories: number;
  warningRepositories: number;
  activeAlerts: number;
}

export function monitoringOptionsFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): MonitoringServiceOptions {
  const enabledValue = environment.GUARDIANBOT_MONITORING_ENABLED;
  let enabled: boolean;
  if (enabledValue === undefined || enabledValue.trim() === "") {
    enabled = environment.NODE_ENV !== "test";
  } else if (["1", "true"].includes(enabledValue.trim().toLowerCase())) {
    enabled = true;
  } else if (["0", "false"].includes(enabledValue.trim().toLowerCase())) {
    enabled = false;
  } else {
    throw new Error("GUARDIANBOT_MONITORING_ENABLED must be 0, 1, false, or true");
  }

  const intervalValue = environment.GUARDIANBOT_MONITORING_INTERVAL_MS;
  const intervalMs =
    intervalValue === undefined || intervalValue.trim() === ""
      ? DEFAULT_MONITORING_INTERVAL_MS
      : Number(intervalValue);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_MONITORING_INTERVAL_MS ||
    intervalMs > MAX_MONITORING_INTERVAL_MS
  ) {
    throw new Error(
      `GUARDIANBOT_MONITORING_INTERVAL_MS must be an integer between ${MIN_MONITORING_INTERVAL_MS} and ${MAX_MONITORING_INTERVAL_MS}`
    );
  }
  return { enabled, intervalMs };
}

export class MonitoringService {
  private readonly clock: MonitoringClock;
  private readonly indexWarnAfterMs: number;
  private readonly indexFailAfterMs: number;
  private readonly scannerMaxAgeMs: number;
  private readonly evidenceMaxAgeMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly logger: Pick<Console, "error">;
  private readonly state: MonitoringServiceState;
  private stopping = false;
  private abortController?: AbortController;
  private loopPromise?: Promise<void>;
  private inFlight?: Promise<MonitoringRunResult>;

  constructor(
    private readonly store: Store,
    private readonly options: MonitoringServiceOptions
  ) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("monitoring interval must be positive");
    }
    this.clock = options.clock ?? systemClock;
    this.indexWarnAfterMs = positive(
      options.indexWarnAfterMs ?? DEFAULT_INDEX_WARN_AFTER_MS,
      "index warning threshold"
    );
    this.indexFailAfterMs = positive(
      options.indexFailAfterMs ?? DEFAULT_INDEX_FAIL_AFTER_MS,
      "index failure threshold"
    );
    if (this.indexFailAfterMs <= this.indexWarnAfterMs) {
      throw new Error("index failure threshold must exceed the warning threshold");
    }
    this.scannerMaxAgeMs = positive(
      options.scannerMaxAgeMs ?? DEFAULT_SCANNER_MAX_AGE_MS,
      "scanner freshness threshold"
    );
    this.evidenceMaxAgeMs = positive(
      options.evidenceMaxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS,
      "evidence freshness threshold"
    );
    this.sleep = options.sleep ?? abortableDelay;
    this.logger = options.logger ?? console;
    this.state = {
      enabled: options.enabled,
      started: false,
      running: false,
      lastDurationMs: 0,
      consecutiveFailures: 0,
      runsTotal: 0,
      successesTotal: 0,
      failuresTotal: 0,
      lockSkippedTotal: 0,
      repositoriesEvaluated: 0,
      failingRepositories: 0,
      warningRepositories: 0,
      activeAlerts: 0
    };
  }

  start(): void {
    if (this.state.started) return;
    this.state.started = true;
    if (!this.options.enabled) return;
    this.stopping = false;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  async stop(): Promise<void> {
    if (!this.state.started) return;
    this.stopping = true;
    this.abortController?.abort();
    await this.loopPromise;
    this.loopPromise = undefined;
    this.abortController = undefined;
    this.state.started = false;
    this.state.running = false;
  }

  async reconcileOnce(): Promise<MonitoringRunResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.performReconciliation();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  getState(): MonitoringServiceState {
    return { ...this.state };
  }

  ready(): boolean {
    if (!this.options.enabled) return true;
    if (!this.state.started || this.state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_FOR_READINESS) {
      return false;
    }
    if (this.state.running && !this.state.lastCycleAt) return true;
    if (!this.state.lastCycleAt) return false;
    const lastCycleAt = Date.parse(this.state.lastCycleAt);
    if (Number.isNaN(lastCycleAt)) return false;
    const staleAfterMs = Math.min(
      MAX_READINESS_STALENESS_MS,
      Math.max(MIN_READINESS_STALENESS_MS, this.options.intervalMs * 3)
    );
    return this.clock.now().getTime() - lastCycleAt <= staleAfterMs;
  }

  renderMetrics(): string {
    const lastCycleSeconds = this.state.lastCycleAt
      ? Math.floor(Date.parse(this.state.lastCycleAt) / 1000)
      : 0;
    const lastSuccessSeconds = this.state.lastSuccessAt
      ? Math.floor(Date.parse(this.state.lastSuccessAt) / 1000)
      : 0;
    return `${[
      "# TYPE guardianbot_monitoring_enabled gauge",
      `guardianbot_monitoring_enabled ${this.options.enabled ? 1 : 0}`,
      "# TYPE guardianbot_monitoring_scheduler_started gauge",
      `guardianbot_monitoring_scheduler_started ${this.state.started ? 1 : 0}`,
      "# TYPE guardianbot_monitoring_reconciliation_in_progress gauge",
      `guardianbot_monitoring_reconciliation_in_progress ${this.state.running ? 1 : 0}`,
      "# TYPE guardianbot_monitoring_last_cycle_timestamp_seconds gauge",
      `guardianbot_monitoring_last_cycle_timestamp_seconds ${lastCycleSeconds}`,
      "# TYPE guardianbot_monitoring_last_success_timestamp_seconds gauge",
      `guardianbot_monitoring_last_success_timestamp_seconds ${lastSuccessSeconds}`,
      "# TYPE guardianbot_monitoring_last_duration_ms gauge",
      `guardianbot_monitoring_last_duration_ms ${this.state.lastDurationMs}`,
      "# TYPE guardianbot_monitoring_consecutive_failures gauge",
      `guardianbot_monitoring_consecutive_failures ${this.state.consecutiveFailures}`,
      "# TYPE guardianbot_monitoring_runs_total counter",
      `guardianbot_monitoring_runs_total ${this.state.runsTotal}`,
      "# TYPE guardianbot_monitoring_successes_total counter",
      `guardianbot_monitoring_successes_total ${this.state.successesTotal}`,
      "# TYPE guardianbot_monitoring_failures_total counter",
      `guardianbot_monitoring_failures_total ${this.state.failuresTotal}`,
      "# TYPE guardianbot_monitoring_lock_skipped_total counter",
      `guardianbot_monitoring_lock_skipped_total ${this.state.lockSkippedTotal}`,
      "# TYPE guardianbot_monitoring_repositories gauge",
      `guardianbot_monitoring_repositories ${this.state.repositoriesEvaluated}`,
      "# TYPE guardianbot_monitoring_failing_repositories gauge",
      `guardianbot_monitoring_failing_repositories ${this.state.failingRepositories}`,
      "# TYPE guardianbot_monitoring_warning_repositories gauge",
      `guardianbot_monitoring_warning_repositories ${this.state.warningRepositories}`,
      "# TYPE guardianbot_monitoring_active_alerts gauge",
      `guardianbot_monitoring_active_alerts ${this.state.activeAlerts}`
    ].join("\n")}\n`;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!this.stopping) {
      const startedAt = this.clock.now().getTime();
      try {
        await this.reconcileOnce();
      } catch (error) {
        this.logger.error(
          `GuardianBot monitoring reconciliation failed (${boundedErrorKind(error)})`
        );
      }
      if (this.stopping) break;
      const elapsedMs = Math.max(0, this.clock.now().getTime() - startedAt);
      await this.sleep(Math.max(0, this.options.intervalMs - elapsedMs), signal);
    }
  }

  private async performReconciliation(): Promise<MonitoringRunResult> {
    const startedAt = this.clock.now();
    this.state.lastAttemptAt = startedAt.toISOString();
    if (!this.options.enabled) return emptyRunResult(false);
    this.state.runsTotal += 1;

    let lock;
    try {
      lock = await this.store.acquireMonitoringLock();
    } catch (error) {
      this.recordFailure(error, startedAt);
      throw error;
    }
    if (!lock) {
      const completedAt = this.clock.now();
      this.state.lockSkippedTotal += 1;
      this.state.consecutiveFailures = 0;
      this.state.lastErrorKind = undefined;
      this.state.lastCycleAt = completedAt.toISOString();
      this.state.lastDurationMs = elapsed(startedAt, completedAt);
      return emptyRunResult(false);
    }

    this.state.running = true;
    let result: MonitoringRunResult | undefined;
    let failure: unknown;
    try {
      const observedAt = this.clock.now();
      const runClock: MonitoringClock = {
        now: () => new Date(observedAt.getTime())
      };
      const inventory = await this.store.listMonitoringRepositoryInventory();
      await this.store.resolveMonitoringAlertsForInactiveRepositories(observedAt);
      let failingRepositories = 0;
      let warningRepositories = 0;
      let activeAlerts = 0;
      for (const item of inventory) {
        const snapshot = evaluateInventoryItem(
          item,
          {
            indexWarnAfterMs: this.indexWarnAfterMs,
            indexFailAfterMs: this.indexFailAfterMs,
            scannerMaxAgeMs: this.scannerMaxAgeMs,
            evidenceMaxAgeMs: this.evidenceMaxAgeMs
          },
          runClock
        );
        if (snapshot.overallStatus === "failing") failingRepositories += 1;
        if (snapshot.overallStatus === "warning") warningRepositories += 1;
        const persisted = toPersistedSnapshot(
          item.repository.repositoryId,
          snapshot,
          observedAt,
          this.options.intervalMs
        );
        const alerts = activeAlertsFor(snapshot.checks);
        activeAlerts += alerts.length;
        await this.store.saveMonitoringSnapshot(persisted, alerts);
      }
      result = {
        acquired: true,
        repositoriesEvaluated: inventory.length,
        failingRepositories,
        warningRepositories,
        activeAlerts
      };
    } catch (error) {
      failure = error;
    }
    try {
      await lock.release();
    } catch (error) {
      failure ??= error;
    }
    this.state.running = false;

    if (failure) {
      this.recordFailure(failure, startedAt);
      throw failure;
    }
    const completedAt = this.clock.now();
    this.state.lastCycleAt = completedAt.toISOString();
    this.state.lastSuccessAt = completedAt.toISOString();
    this.state.lastDurationMs = elapsed(startedAt, completedAt);
    this.state.lastErrorKind = undefined;
    this.state.consecutiveFailures = 0;
    this.state.successesTotal += 1;
    this.state.repositoriesEvaluated = result?.repositoriesEvaluated ?? 0;
    this.state.failingRepositories = result?.failingRepositories ?? 0;
    this.state.warningRepositories = result?.warningRepositories ?? 0;
    this.state.activeAlerts = result?.activeAlerts ?? 0;
    return result ?? emptyRunResult(true);
  }

  private recordFailure(error: unknown, startedAt: Date): void {
    const completedAt = this.clock.now();
    this.state.running = false;
    this.state.lastCycleAt = completedAt.toISOString();
    this.state.lastDurationMs = elapsed(startedAt, completedAt);
    this.state.lastErrorKind = boundedErrorKind(error);
    this.state.consecutiveFailures += 1;
    this.state.failuresTotal += 1;
  }
}

interface ReconciliationThresholds {
  indexWarnAfterMs: number;
  indexFailAfterMs: number;
  scannerMaxAgeMs: number;
  evidenceMaxAgeMs: number;
}

function evaluateInventoryItem(
  item: MonitoringRepositoryInventory,
  thresholds: ReconciliationThresholds,
  clock: MonitoringClock
): RepositoryMonitoringSnapshot {
  const configuration = readIndexedConfiguration(item);
  const config = configuration.config;
  const scheduledRun = item.latestScannerRuns.find((run) => run.event === "schedule");
  const observedRuns = item.latestScannerRuns
    .map(toObservedWorkflowRun)
    .filter((run): run is ObservedWorkflowRun => Boolean(run));
  const newestObservableRun = [...item.latestScannerRuns]
    .filter((run) => run.startedAt || run.completedAt)
    .sort(compareWorkflowRunsNewestFirst)[0];
  const relevantEvidence =
    scheduledRun && item.index?.commitSha === scheduledRun.headSha
    ? item.latestScannerEvidence.filter(
        (evidence) =>
          evidence.runId === scheduledRun.runId &&
          evidence.runAttempt === scheduledRun.runAttempt
      )
    : [];
  const evidenceRequirements = config
    ? buildEvidenceRequirements(config, thresholds.evidenceMaxAgeMs)
    : [];
  const supplementaryChecks: MonitoringCheckResult[] = [configuration.check];
  let baselineReady: boolean | undefined;
  if (config?.scanners.mode === "enforce") {
    baselineReady = false;
    supplementaryChecks.push({
      key: "baseline-readiness",
      status: "failing",
      summary: "Enforcement baseline readiness is not persisted for this immutable config"
    });
  }
  if (config?.image) {
    const imageSummary = relevantEvidence.find(
      (evidence) => evidence.evidenceKey === IMAGE_TRIVY_EVIDENCE_KEY
    );
    const imageDigest = imageDigestFromEvidence(imageSummary);
    supplementaryChecks.push({
      key: "image-digest-observability",
      status: imageDigest ? "passing" : "failing",
      summary: imageDigest
        ? "Immutable image build digest is observable for the scheduled run"
        : "Immutable image build digest is not observable for the scheduled run"
    });
    supplementaryChecks.push({
      key: "image-deployment-scope",
      status: "warning",
      summary: "Image deployment environment is not persisted; deployment drift is unobservable"
    });
  }

  const scannerConfigured = Boolean(
    config &&
      (config.scanners.semgrep ||
        config.scanners.trivy ||
        config.image ||
        config.dast)
  );
  const base = evaluateRepositoryMonitoring(
    {
      repository: {
        key: item.repository.fullName,
        reviewEnabled: Boolean(config?.review.automatic) && !item.repository.automaticReviewPaused,
        configValid: Boolean(config),
        scannerMode: config?.scanners.mode ?? "advisory",
        deterministicApplicable: scannerConfigured,
        baselineReady
      },
      expectedRuns: config
        ? {
            expected: [
              {
                key: "scanner-run",
                workflow: EXPECTED_SCANNER_WORKFLOW,
                event: "schedule",
                branch: item.repository.defaultBranch,
                required: true,
                maxAgeMs: thresholds.scannerMaxAgeMs,
                description: "Persisted default-branch GuardianBot scanner run"
              }
            ],
            observed: observedRuns
          }
        : undefined,
      index: {
        indexedAt: item.repository.indexUpdatedAt,
        warnAfterMs: thresholds.indexWarnAfterMs,
        failAfterMs: thresholds.indexFailAfterMs,
        expectedCommitSha: newestObservableRun?.headSha,
        indexedCommitSha: item.repository.indexSha
      },
      evidence: evidenceRequirements.length
        ? {
            requirements: evidenceRequirements,
            observed: relevantEvidence
              .filter(
                (evidence) =>
                  MONITORED_EVIDENCE_KEYS.has(evidence.evidenceKey) &&
                  isEvidenceKind(evidence.kind)
              )
              .map((evidence) => ({
                kind: evidence.kind as EvidenceKind,
                observedAt: evidence.observedAt,
                status: evidence.status,
                digest: evidenceMatchKey(
                  evidence.artifactType ?? "unknown",
                  evidence.evidenceKey
                ),
                environment: evidence.environment,
                details: evidence.details
              }))
          }
        : undefined,
      suppressions: config
        ? {
            records: config.scanners.suppressions ?? [],
            notifyBeforeMs: SUPPRESSION_NOTIFY_BEFORE_MS
          }
        : undefined
    },
    clock
  );
  const checks = [...base.checks, ...supplementaryChecks];
  return {
    ...base,
    checks,
    overallStatus: worstMonitoringStatus(checks.map((check) => check.status))
  };
}

function toObservedWorkflowRun(
  run: ScannerWorkflowRunRecord
): ObservedWorkflowRun | undefined {
  if (
    !run.event ||
    !WORKFLOW_EVENTS.has(run.event) ||
    !run.startedAt ||
    Number.isNaN(Date.parse(run.startedAt)) ||
    !["queued", "in_progress", "completed"].includes(run.status)
  ) {
    return undefined;
  }
  if (
    run.status === "completed" &&
    (!run.completedAt || Number.isNaN(Date.parse(run.completedAt)))
  ) {
    return undefined;
  }
  const status = run.status as ObservedWorkflowRun["status"];
  const acceptedConclusions = new Set([
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped"
  ]);
  const conclusion =
    run.validationStatus === "accepted" && acceptedConclusions.has(run.conclusion)
      ? (run.conclusion as ObservedWorkflowRun["conclusion"])
      : "failure";
  return {
    workflow: run.workflowPath,
    event: run.event,
    branch: run.headBranch,
    startedAt: run.startedAt,
    completedAt: status === "completed" ? run.completedAt : undefined,
    status,
    conclusion: status === "completed" ? conclusion : undefined
  };
}

interface IndexedConfigurationObservation {
  config?: GuardianConfig;
  check: MonitoringCheckResult;
}

function readIndexedConfiguration(
  item: MonitoringRepositoryInventory
): IndexedConfigurationObservation {
  if (
    !item.index ||
    !item.repository.indexSha ||
    item.index.commitSha !== item.repository.indexSha
  ) {
    return {
      check: {
        key: "config-observability",
        status: "failing",
        summary: "Immutable GuardianBot configuration is not available in the current index"
      }
    };
  }
  const configSymbol = item.index.symbols.find((symbol) =>
    /^\.guardianbot\/config\.ya?ml$/i.test(symbol.path)
  );
  if (!configSymbol) {
    return {
      check: {
        key: "config-observability",
        status: "failing",
        summary: "Current repository index does not contain GuardianBot configuration"
      }
    };
  }
  try {
    const config = parseGuardianConfig(configSymbol.content);
    const expectedScannerState =
      config.scanners.mode === "enforce"
        ? "enforced"
        : config.scanners.mode === "report-only"
          ? "report-only"
          : "not-configured";
    if (
      config.repository.defaultBranch !== item.repository.defaultBranch ||
      expectedScannerState !== item.repository.scannerState
    ) {
      throw new Error("indexed configuration does not match repository inventory");
    }
    return {
      config,
      check: {
        key: "config-observability",
        status: "passing",
        summary: "Immutable GuardianBot configuration is observable in the current index"
      }
    };
  } catch {
    return {
      check: {
        key: "config-observability",
        status: "failing",
        summary: "Indexed GuardianBot configuration is invalid or inconsistent"
      }
    };
  }
}

function buildEvidenceRequirements(
  config: GuardianConfig,
  maxAgeMs: number
): EvidenceRequirement[] {
  const requirements: EvidenceRequirement[] = [];
  const add = (
    key: string,
    kind: EvidenceKind,
    artifactType: string,
    evidenceKey: string,
    label: string
  ) => {
    requirements.push({
      key,
      kind,
      required: true,
      maxAgeMs,
      digest: evidenceMatchKey(artifactType, evidenceKey),
      label
    });
  };
  if (config.scanners.semgrep) {
    add("scanner-semgrep", "semgrep", "security", SEMGREP_EVIDENCE_KEY, "Semgrep");
    add(
      "scanner-semgrep-import",
      "defectdojo-import",
      "security",
      SEMGREP_IMPORT_EVIDENCE_KEY,
      "Semgrep DefectDojo import"
    );
  }
  if (config.scanners.trivy) {
    add("scanner-trivy", "trivy", "security", TRIVY_EVIDENCE_KEY, "Trivy");
    add(
      "scanner-trivy-import",
      "defectdojo-import",
      "security",
      TRIVY_IMPORT_EVIDENCE_KEY,
      "Trivy DefectDojo import"
    );
  }
  if (config.image) {
    add(
      "image-trivy",
      "trivy",
      "image-validation",
      IMAGE_TRIVY_EVIDENCE_KEY,
      "Image scan"
    );
    add("image-sbom", "sbom", "image-validation", SBOM_EVIDENCE_KEY, "Image SBOM");
  }
  if (config.dast) {
    add("scanner-zap", "zap-nightly", "dast", ZAP_EVIDENCE_KEY, "ZAP");
    add(
      "scanner-zap-import",
      "defectdojo-import",
      "dast",
      ZAP_IMPORT_EVIDENCE_KEY,
      "ZAP DefectDojo import"
    );
  }
  return requirements;
}

function evidenceMatchKey(artifactType: string, evidenceKey: string): string {
  return `${artifactType}:${evidenceKey}`;
}

function compareWorkflowRunsNewestFirst(
  left: ScannerWorkflowRunRecord,
  right: ScannerWorkflowRunRecord
): number {
  return workflowRunTimestamp(right) - workflowRunTimestamp(left);
}

function workflowRunTimestamp(run: ScannerWorkflowRunRecord): number {
  const parsed = Date.parse(run.completedAt ?? run.startedAt ?? "");
  return Number.isNaN(parsed) ? -1 : parsed;
}

function imageDigestFromEvidence(
  evidence: MonitoringRepositoryInventory["latestScannerEvidence"][number] | undefined
): string | undefined {
  const payloadDigest =
    evidence?.payload && typeof evidence.payload.imageId === "string"
      ? evidence.payload.imageId
      : undefined;
  const digest = evidence?.digest ?? payloadDigest;
  return digest && /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : undefined;
}

function toPersistedSnapshot(
  repositoryId: number,
  snapshot: RepositoryMonitoringSnapshot,
  observedAt: Date,
  intervalMs: number
): MonitoringSnapshotRecord {
  return {
    repositoryId,
    snapshotKey: `v1:${Math.floor(observedAt.getTime() / intervalMs)}`,
    observedAt: observedAt.toISOString(),
    inventoryState: snapshot.inventoryState,
    overallStatus: snapshot.overallStatus,
    checks: snapshot.checks.map(sanitizeCheck)
  };
}

function sanitizeCheck(check: MonitoringCheckResult): PersistedMonitoringCheck {
  return {
    key: check.key.slice(0, 128),
    status: check.status,
    summary: check.summary.slice(0, 512),
    observedAt: check.observedAt,
    ageMs: check.ageMs
  };
}

function activeAlertsFor(checks: readonly MonitoringCheckResult[]): MonitoringAlertInput[] {
  const alerts = new Map<string, MonitoringAlertInput>();
  for (const check of checks) {
    if (check.status !== "warning" && check.status !== "failing") continue;
    const alertKey = check.key.slice(0, 128);
    alerts.set(alertKey, {
      alertKey,
      severity: check.status,
      summary: check.summary.slice(0, 512)
    });
  }
  return [...alerts.values()].sort((left, right) => left.alertKey.localeCompare(right.alertKey));
}

function isEvidenceKind(kind: string): kind is EvidenceKind {
  return SUPPORTED_EVIDENCE_KINDS.has(kind as EvidenceKind);
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function boundedErrorKind(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : "UnknownError";
}

function elapsed(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function emptyRunResult(acquired: boolean): MonitoringRunResult {
  return {
    acquired,
    repositoriesEvaluated: 0,
    failingRepositories: 0,
    warningRepositories: 0,
    activeAlerts: 0
  };
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  }
}
