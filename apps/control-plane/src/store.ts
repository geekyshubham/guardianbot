import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { PersistedVectorRow, RepositoryIndex } from "@guardianbot/core";
import type {
  MonitoringStatus,
  RepositoryInventoryState,
  WeeklyCoverageReport
} from "@guardianbot/monitoring";

export type RepositoryLifecycleState = "active" | "suspended" | "removed";
export type WebhookJobStatus = "pending" | "leased" | "succeeded" | "dead-letter";
export type RepositoryIndexStorageMode = "memory" | "pgvector" | "json-array-fallback";

// Fixed two-int32 namespace/key pair for the database-wide monitoring scheduler lock.
const MONITORING_LOCK_NAMESPACE = 1_196_572_738;
const MONITORING_LOCK_KEY = 1_297_046_866;

export interface RepositoryRecord {
  installationId: number;
  repositoryId: number;
  fullName: string;
  visibility: string;
  defaultBranch: string;
  indexSha?: string;
  indexUpdatedAt?: string;
  scannerState: "not-configured" | "report-only" | "enforced";
  repositoryState: RepositoryLifecycleState;
  automaticReviewPaused: boolean;
}

export interface ReviewState {
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  reviewedHeadSha?: string;
  placeholderCommentId?: number;
  findings: Array<{ fingerprint: string; state: "open" | "resolved" | "superseded" }>;
}

export type ScannerWorkflowValidationStatus = "pending" | "accepted" | "rejected" | "failed";
export type ScannerArtifactValidationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "failed";
export type ScannerEvidenceStatus = "success" | "failure";
export type ScannerWorkflowEvent =
  | "pull_request"
  | "push"
  | "schedule"
  | "workflow_dispatch";

export interface ScannerReferencedWorkflow {
  path: string;
  sha: string;
  ref?: string;
}

export interface ScannerWorkflowRunRecord {
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  headBranch?: string;
  event?: ScannerWorkflowEvent;
  startedAt?: string;
  completedAt?: string;
  workflowPath: string;
  workflowRef?: string;
  workflowSha?: string;
  conclusion: string;
  status: string;
  validationStatus: ScannerWorkflowValidationStatus;
  validationError?: string;
  referencedWorkflows: ScannerReferencedWorkflow[];
  processedAt?: string;
}

export interface ScannerArtifactRecord {
  repositoryId: number;
  runId: number;
  runAttempt: number;
  artifactId: number;
  artifactName: string;
  artifactType: string;
  sizeBytes: number;
  expired: boolean;
  digest?: string;
  validationStatus: ScannerArtifactValidationStatus;
  validationError?: string;
  processedAt?: string;
}

export interface ScannerEvidenceRecord {
  repositoryId: number;
  runId: number;
  runAttempt: number;
  artifactId: number;
  artifactType?: string;
  evidenceKey: string;
  kind: string;
  source: string;
  status: ScannerEvidenceStatus;
  observedAt: string;
  digest?: string;
  environment?: string;
  details?: string;
  fingerprint?: string;
  path?: string;
  line?: number;
  payload?: Record<string, unknown>;
}

export interface MonitoringRepositoryInventory {
  repository: RepositoryRecord;
  index?: RepositoryIndex;
  latestScannerRuns: ScannerWorkflowRunRecord[];
  latestScannerEvidence: ScannerEvidenceRecord[];
}

export interface PersistedMonitoringCheck {
  key: string;
  status: MonitoringStatus;
  summary: string;
  observedAt?: string;
  ageMs?: number;
}

export interface MonitoringSnapshotRecord {
  repositoryId: number;
  snapshotKey: string;
  observedAt: string;
  inventoryState: RepositoryInventoryState;
  overallStatus: MonitoringStatus;
  checks: PersistedMonitoringCheck[];
}

export interface MonitoringAlertInput {
  alertKey: string;
  severity: "warning" | "failing";
  summary: string;
}

export interface MonitoringAlertRecord extends MonitoringAlertInput {
  repositoryId: number;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt?: string;
}

export interface MonitoringWeeklyReportRecord {
  weekKey: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  report: WeeklyCoverageReport;
  sourceCompleteness: {
    review: "unavailable";
    scanner: "latest-reconciliation";
    monitoring: "latest-reconciliation";
    imageProtection: "latest-reconciliation";
  };
}

export interface DastSessionIssuanceClaim {
  issuanceKey: string;
  leaseId: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  profileId: string;
  origin: string;
  leasedAt: string;
  leaseExpiresAt: string;
}

interface DastSessionIssuanceRecord extends DastSessionIssuanceClaim {
  status: "leased" | "issued";
  issuedAt?: string;
  credentialExpiresAt?: string;
}

export interface DeploymentPromotionClaim {
  deploymentKey: string;
  leaseId: string;
  repositoryId: number;
  environment: string;
  imageDigest: string;
  runId: number;
  runAttempt: number;
  leasedAt: string;
  leaseExpiresAt: string;
}

export interface SuccessfulDeploymentEvidence {
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  environment: string;
  imageDigest: string;
  observedAt: string;
  origin: string;
}

export interface StoreLock {
  release(): Promise<void>;
}

export interface WebhookJob {
  deliveryId: string;
  eventName: string;
  payload: Record<string, any>;
  status: WebhookJobStatus;
  attempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  deadLetteredAt?: string;
}

export interface Store {
  ping(): Promise<void>;
  close(): Promise<void>;
  getRepositoryIndexStorageMode(): Promise<RepositoryIndexStorageMode>;
  upsertRepository(record: RepositoryRecord): Promise<void>;
  getRepository(repositoryId: number): Promise<RepositoryRecord | undefined>;
  replaceRepositoryIndex(
    repositoryId: number,
    index: RepositoryIndex,
    vectors: readonly PersistedVectorRow[],
    indexedAt?: Date
  ): Promise<void>;
  getRepositoryIndex(
    repositoryId: number,
    repositoryScope: string,
    commitSha: string
  ): Promise<RepositoryIndex | undefined>;
  setRepositoryState(repositoryId: number, state: RepositoryLifecycleState): Promise<void>;
  setInstallationState(installationId: number, state: RepositoryLifecycleState): Promise<void>;
  setAutomaticReviewPaused(repositoryId: number, paused: boolean): Promise<void>;
  saveReviewHead(
    repositoryId: number,
    pullNumber: number,
    headSha: string,
    placeholderCommentId?: number
  ): Promise<void>;
  saveReview(state: ReviewState, expectedHeadSha?: string): Promise<boolean>;
  getReview(repositoryId: number, pullNumber: number): Promise<ReviewState | undefined>;
  enqueueWebhook(deliveryId: string, eventName: string, payload: Record<string, any>): Promise<boolean>;
  claimWebhook(workerId: string, leaseMs: number, now?: Date): Promise<WebhookJob | undefined>;
  completeWebhook(deliveryId: string, workerId: string): Promise<void>;
  failWebhook(
    deliveryId: string,
    workerId: string,
    error: string,
    retryAt: Date | undefined,
    deadLetter: boolean
  ): Promise<void>;
  getWebhook(deliveryId: string): Promise<WebhookJob | undefined>;
  upsertScannerWorkflowRun(record: ScannerWorkflowRunRecord): Promise<void>;
  getScannerWorkflowRun(
    repositoryId: number,
    runId: number,
    runAttempt: number
  ): Promise<ScannerWorkflowRunRecord | undefined>;
  upsertScannerArtifact(record: ScannerArtifactRecord): Promise<void>;
  upsertScannerEvidence(record: ScannerEvidenceRecord): Promise<void>;
  listMonitoringRepositoryInventory(): Promise<MonitoringRepositoryInventory[]>;
  saveMonitoringSnapshot(
    snapshot: MonitoringSnapshotRecord,
    activeAlerts: readonly MonitoringAlertInput[]
  ): Promise<void>;
  getLatestMonitoringSnapshot(
    repositoryId: number
  ): Promise<MonitoringSnapshotRecord | undefined>;
  saveMonitoringWeeklyReport(report: MonitoringWeeklyReportRecord): Promise<void>;
  getMonitoringWeeklyReport(
    weekKey: string
  ): Promise<MonitoringWeeklyReportRecord | undefined>;
  claimDastSessionIssuance(claim: DastSessionIssuanceClaim): Promise<boolean>;
  completeDastSessionIssuance(
    issuanceKey: string,
    leaseId: string,
    issuedAt: string,
    credentialExpiresAt: string
  ): Promise<boolean>;
  releaseDastSessionIssuance(
    issuanceKey: string,
    leaseId: string
  ): Promise<boolean>;
  getSuccessfulDeploymentEvidence(
    repositoryId: number,
    environment: string,
    headSha: string,
    defaultBranch: string
  ): Promise<SuccessfulDeploymentEvidence | undefined>;
  claimDeploymentPromotion(
    claim: DeploymentPromotionClaim
  ): Promise<boolean>;
  releaseDeploymentPromotion(
    deploymentKey: string,
    leaseId: string
  ): Promise<boolean>;
  listActiveMonitoringAlerts(repositoryId?: number): Promise<MonitoringAlertRecord[]>;
  resolveMonitoringAlertsForInactiveRepositories(observedAt: Date): Promise<void>;
  acquireMonitoringLock(): Promise<StoreLock | undefined>;
}

export function postgresPoolConfig(
  connectionString: string,
  caCertificate?: string
): PoolConfig {
  const base: PoolConfig = {
    connectionString,
    max: 10,
    application_name: "guardianbot-control-plane"
  };
  if (!caCertificate?.trim()) return base;

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
  }

  // pg-connection-string gives TLS query parameters precedence over an
  // explicit Pool `ssl` object. Remove those parameters so the managed
  // database CA below cannot be weakened by `sslmode=require` or
  // `sslmode=no-verify` in a provider-generated URL.
  for (const parameter of [
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslnegotiation",
    "uselibpqcompat"
  ]) {
    parsed.searchParams.delete(parameter);
  }

  return {
    ...base,
    connectionString: parsed.toString(),
    ssl: {
      ca: caCertificate.replace(/\\n/g, "\n").trim(),
      rejectUnauthorized: true
    }
  };
}

function iso(value: Date): string {
  return value.toISOString();
}

function fromUnknownDate(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export class MemoryStore implements Store {
  private repositories = new Map<number, RepositoryRecord>();
  private reviews = new Map<string, ReviewState>();
  private webhooks = new Map<string, WebhookJob>();
  private repositoryIndexes = new Map<string, { repositoryId: number; index: RepositoryIndex }>();
  private scannerRuns = new Map<string, ScannerWorkflowRunRecord>();
  private scannerArtifacts = new Map<string, ScannerArtifactRecord>();
  private scannerEvidence = new Map<string, ScannerEvidenceRecord>();
  private monitoringSnapshots = new Map<string, MonitoringSnapshotRecord>();
  private monitoringAlerts = new Map<string, MonitoringAlertRecord>();
  private monitoringWeeklyReports = new Map<string, MonitoringWeeklyReportRecord>();
  private dastSessionIssuances = new Map<string, DastSessionIssuanceRecord>();
  private deploymentPromotions = new Map<string, DeploymentPromotionClaim>();
  private monitoringLockHeld = false;

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
  async getRepositoryIndexStorageMode(): Promise<RepositoryIndexStorageMode> {
    return "memory";
  }

  async upsertRepository(record: RepositoryRecord) {
    this.repositories.set(record.repositoryId, { ...record });
  }

  async getRepository(id: number) {
    const repository = this.repositories.get(id);
    return repository ? { ...repository } : undefined;
  }

  async replaceRepositoryIndex(
    repositoryId: number,
    index: RepositoryIndex,
    _vectors: readonly PersistedVectorRow[],
    indexedAt = new Date()
  ) {
    const repository = this.repositories.get(repositoryId);
    if (!repository) {
      throw new Error(`repository ${repositoryId} must exist before indexing`);
    }
    this.repositoryIndexes.set(index.storageKey, {
      repositoryId,
      index: structuredClone(index)
    });
    this.repositories.set(repositoryId, {
      ...repository,
      indexSha: index.commitSha,
      indexUpdatedAt: indexedAt.toISOString()
    });
  }

  async getRepositoryIndex(
    repositoryId: number,
    repositoryScope: string,
    commitSha: string
  ) {
    for (const entry of this.repositoryIndexes.values()) {
      if (
        entry.repositoryId === repositoryId &&
        entry.index.repositoryScope === repositoryScope &&
        entry.index.commitSha === commitSha
      ) {
        return structuredClone(entry.index);
      }
    }
    return undefined;
  }

  async setRepositoryState(repositoryId: number, state: RepositoryLifecycleState) {
    const repository = this.repositories.get(repositoryId);
    if (!repository) return;
    this.repositories.set(repositoryId, { ...repository, repositoryState: state });
  }

  async setInstallationState(installationId: number, state: RepositoryLifecycleState) {
    for (const [repositoryId, repository] of this.repositories) {
      if (repository.installationId !== installationId) continue;
      this.repositories.set(repositoryId, { ...repository, repositoryState: state });
    }
  }

  async setAutomaticReviewPaused(repositoryId: number, paused: boolean) {
    const repository = this.repositories.get(repositoryId);
    if (!repository) return;
    this.repositories.set(repositoryId, {
      ...repository,
      automaticReviewPaused: paused
    });
  }

  async saveReviewHead(
    repositoryId: number,
    pullNumber: number,
    headSha: string,
    placeholderCommentId?: number
  ) {
    const key = `${repositoryId}:${pullNumber}`;
    const current = this.reviews.get(key);
    this.reviews.set(key, {
      repositoryId,
      pullNumber,
      headSha,
      reviewedHeadSha: current?.reviewedHeadSha,
      placeholderCommentId: placeholderCommentId ?? current?.placeholderCommentId,
      findings: current?.findings ?? []
    });
  }

  async saveReview(state: ReviewState, expectedHeadSha?: string) {
    const key = `${state.repositoryId}:${state.pullNumber}`;
    const current = this.reviews.get(key);
    if (expectedHeadSha && current && current.headSha !== expectedHeadSha) return false;
    this.reviews.set(key, { ...state });
    return true;
  }

  async getReview(id: number, pull: number) {
    const review = this.reviews.get(`${id}:${pull}`);
    return review ? { ...review, findings: [...review.findings] } : undefined;
  }

  async enqueueWebhook(deliveryId: string, eventName: string, payload: Record<string, any>) {
    if (this.webhooks.has(deliveryId)) return false;
    this.webhooks.set(deliveryId, {
      deliveryId,
      eventName,
      payload,
      status: "pending",
      attempts: 0,
      availableAt: new Date(0).toISOString()
    });
    return true;
  }

  async claimWebhook(workerId: string, leaseMs: number, now = new Date()) {
    const eligible = [...this.webhooks.values()]
      .filter((job) =>
        (job.status === "pending" ||
          (job.status === "leased" &&
            (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now.getTime()))) &&
        new Date(job.availableAt).getTime() <= now.getTime()
      )
      .sort((left, right) => {
        const availableDiff = new Date(left.availableAt).getTime() - new Date(right.availableAt).getTime();
        if (availableDiff !== 0) return availableDiff;
        return left.deliveryId.localeCompare(right.deliveryId);
      })[0];
    if (!eligible) return undefined;
    const claimed: WebhookJob = {
      ...eligible,
      status: "leased",
      attempts: eligible.attempts + 1,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString()
    };
    this.webhooks.set(claimed.deliveryId, claimed);
    return { ...claimed, payload: { ...claimed.payload } };
  }

  async completeWebhook(deliveryId: string, workerId: string) {
    const current = this.webhooks.get(deliveryId);
    if (!current || current.leaseOwner !== workerId) return;
    this.webhooks.set(deliveryId, {
      ...current,
      status: "succeeded",
      leaseOwner: undefined,
      leaseExpiresAt: undefined
    });
  }

  async failWebhook(
    deliveryId: string,
    workerId: string,
    error: string,
    retryAt: Date | undefined,
    deadLetter: boolean
  ) {
    const current = this.webhooks.get(deliveryId);
    if (!current || current.leaseOwner !== workerId) return;
    this.webhooks.set(deliveryId, {
      ...current,
      status: deadLetter ? "dead-letter" : "pending",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      availableAt: deadLetter ? current.availableAt : iso(retryAt ?? new Date()),
      lastError: error,
      deadLetteredAt: deadLetter ? new Date().toISOString() : undefined
    });
  }

  async getWebhook(deliveryId: string) {
    const job = this.webhooks.get(deliveryId);
    return job
      ? {
          ...job,
          payload: { ...job.payload }
        }
      : undefined;
  }

  async upsertScannerWorkflowRun(record: ScannerWorkflowRunRecord) {
    this.scannerRuns.set(scannerRunKey(record.repositoryId, record.runId, record.runAttempt), {
      ...record,
      referencedWorkflows: record.referencedWorkflows.map((workflow) => ({ ...workflow }))
    });
  }

  async getScannerWorkflowRun(repositoryId: number, runId: number, runAttempt: number) {
    const record = this.scannerRuns.get(scannerRunKey(repositoryId, runId, runAttempt));
    return record
      ? {
          ...record,
          referencedWorkflows: record.referencedWorkflows.map((workflow) => ({ ...workflow }))
        }
      : undefined;
  }

  async upsertScannerArtifact(record: ScannerArtifactRecord) {
    this.scannerArtifacts.set(
      scannerArtifactKey(record.repositoryId, record.runId, record.runAttempt, record.artifactId),
      { ...record }
    );
  }

  async upsertScannerEvidence(record: ScannerEvidenceRecord) {
    this.scannerEvidence.set(
      scannerEvidenceKey(
        record.repositoryId,
        record.runId,
        record.runAttempt,
        record.artifactId,
        record.evidenceKey
      ),
      {
        ...record,
        payload: record.payload ? { ...record.payload } : undefined
      }
    );
  }

  async listMonitoringRepositoryInventory(): Promise<MonitoringRepositoryInventory[]> {
    return [...this.repositories.values()]
      .filter((repository) => repository.repositoryState === "active")
      .sort((left, right) => left.repositoryId - right.repositoryId)
      .map((repository) => {
        const latestRuns = [...this.scannerRuns.values()]
          .filter(
            (run) =>
              run.repositoryId === repository.repositoryId &&
              run.headBranch === repository.defaultBranch
          )
          .sort(compareScannerRunsNewestFirst)
          .slice(0, 256)
          .map(cloneScannerWorkflowRun);
        const evidenceByKey = new Map<string, ScannerEvidenceRecord>();
        for (const evidence of [...this.scannerEvidence.values()]
          .filter(
            (item) =>
              item.repositoryId === repository.repositoryId &&
              item.fingerprint === undefined
          )
          .sort(compareScannerEvidenceNewestFirst)) {
          const run = this.scannerRuns.get(
            scannerRunKey(evidence.repositoryId, evidence.runId, evidence.runAttempt)
          );
          const artifact = this.scannerArtifacts.get(
            scannerArtifactKey(
              evidence.repositoryId,
              evidence.runId,
              evidence.runAttempt,
              evidence.artifactId
            )
          );
          const enriched = {
            ...evidence,
            artifactType: artifact?.artifactType ?? evidence.artifactType
          };
          const key = `${run?.event ?? "unknown"}:${enriched.artifactType ?? "unknown"}:${evidence.evidenceKey}`;
          if (!evidenceByKey.has(key)) {
            evidenceByKey.set(key, cloneScannerEvidence(enriched));
          }
        }
        const index = [...this.repositoryIndexes.values()].find(
          (entry) =>
            entry.repositoryId === repository.repositoryId &&
            entry.index.commitSha === repository.indexSha
        )?.index;
        return {
          repository: { ...repository },
          index: index ? structuredClone(index) : undefined,
          latestScannerRuns: latestRuns,
          latestScannerEvidence: [...evidenceByKey.values()]
        };
      });
  }

  async saveMonitoringSnapshot(
    snapshot: MonitoringSnapshotRecord,
    activeAlerts: readonly MonitoringAlertInput[]
  ): Promise<void> {
    this.monitoringSnapshots.set(
      monitoringSnapshotKey(snapshot.repositoryId, snapshot.snapshotKey),
      cloneMonitoringSnapshot(snapshot)
    );
    const activeKeys = new Set(activeAlerts.map((alert) => alert.alertKey));
    for (const [key, alert] of this.monitoringAlerts) {
      if (
        alert.repositoryId === snapshot.repositoryId &&
        !alert.resolvedAt &&
        !activeKeys.has(alert.alertKey)
      ) {
        this.monitoringAlerts.set(key, {
          ...alert,
          lastObservedAt: snapshot.observedAt,
          resolvedAt: snapshot.observedAt
        });
      }
    }
    for (const alert of activeAlerts) {
      const key = monitoringAlertKey(snapshot.repositoryId, alert.alertKey);
      const existing = this.monitoringAlerts.get(key);
      this.monitoringAlerts.set(key, {
        repositoryId: snapshot.repositoryId,
        ...alert,
        firstObservedAt:
          !existing || existing.resolvedAt ? snapshot.observedAt : existing.firstObservedAt,
        lastObservedAt: snapshot.observedAt
      });
    }
  }

  async getLatestMonitoringSnapshot(
    repositoryId: number
  ): Promise<MonitoringSnapshotRecord | undefined> {
    const snapshot = [...this.monitoringSnapshots.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort(
        (left, right) =>
          Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
          right.snapshotKey.localeCompare(left.snapshotKey)
      )[0];
    return snapshot ? cloneMonitoringSnapshot(snapshot) : undefined;
  }

  async saveMonitoringWeeklyReport(report: MonitoringWeeklyReportRecord): Promise<void> {
    this.monitoringWeeklyReports.set(report.weekKey, cloneMonitoringWeeklyReport(report));
  }

  async getMonitoringWeeklyReport(
    weekKey: string
  ): Promise<MonitoringWeeklyReportRecord | undefined> {
    const report = this.monitoringWeeklyReports.get(weekKey);
    return report ? cloneMonitoringWeeklyReport(report) : undefined;
  }

  async claimDastSessionIssuance(
    claim: DastSessionIssuanceClaim
  ): Promise<boolean> {
    const existing = this.dastSessionIssuances.get(claim.issuanceKey);
    if (
      existing?.status === "issued" ||
      (existing?.status === "leased" &&
        Date.parse(existing.leaseExpiresAt) > Date.parse(claim.leasedAt))
    ) {
      return false;
    }
    this.dastSessionIssuances.set(claim.issuanceKey, {
      ...claim,
      status: "leased"
    });
    return true;
  }

  async completeDastSessionIssuance(
    issuanceKey: string,
    leaseId: string,
    issuedAt: string,
    credentialExpiresAt: string
  ): Promise<boolean> {
    const existing = this.dastSessionIssuances.get(issuanceKey);
    if (
      !existing ||
      existing.status !== "leased" ||
      existing.leaseId !== leaseId
    ) {
      return false;
    }
    this.dastSessionIssuances.set(issuanceKey, {
      ...existing,
      status: "issued",
      issuedAt,
      credentialExpiresAt
    });
    return true;
  }

  async releaseDastSessionIssuance(
    issuanceKey: string,
    leaseId: string
  ): Promise<boolean> {
    const existing = this.dastSessionIssuances.get(issuanceKey);
    if (
      !existing ||
      existing.status !== "leased" ||
      existing.leaseId !== leaseId
    ) {
      return false;
    }
    return this.dastSessionIssuances.delete(issuanceKey);
  }

  async getSuccessfulDeploymentEvidence(
    repositoryId: number,
    environment: string,
    headSha: string,
    defaultBranch: string
  ): Promise<SuccessfulDeploymentEvidence | undefined> {
    const candidates = [...this.scannerEvidence.values()]
      .filter(
        (evidence) =>
          evidence.repositoryId === repositoryId &&
          evidence.evidenceKey === `deployment:${environment}` &&
          evidence.kind === "deployment" &&
          evidence.source === "digitalocean" &&
          evidence.status === "success" &&
          evidence.environment === environment &&
          evidence.fingerprint === undefined &&
          typeof evidence.digest === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(evidence.digest)
      )
      .sort(compareScannerEvidenceNewestFirst);
    for (const evidence of candidates) {
      const run = this.scannerRuns.get(
        scannerRunKey(repositoryId, evidence.runId, evidence.runAttempt)
      );
      const artifact = this.scannerArtifacts.get(
        scannerArtifactKey(
          repositoryId,
          evidence.runId,
          evidence.runAttempt,
          evidence.artifactId
        )
      );
      if (
        !run ||
        run.headSha !== headSha ||
        run.headBranch !== defaultBranch ||
        run.event !== "push" ||
        run.conclusion !== "success" ||
        run.validationStatus !== "accepted" ||
        artifact?.artifactType !== "image-promotion" ||
        artifact.validationStatus !== "accepted"
      ) {
        continue;
      }
      const origin = evidence.payload?.origin;
      if (typeof origin !== "string") continue;
      return {
        repositoryId,
        runId: evidence.runId,
        runAttempt: evidence.runAttempt,
        headSha,
        environment,
        imageDigest: evidence.digest!,
        observedAt: evidence.observedAt,
        origin
      };
    }
    return undefined;
  }

  async claimDeploymentPromotion(
    claim: DeploymentPromotionClaim
  ): Promise<boolean> {
    const existing = this.deploymentPromotions.get(claim.deploymentKey);
    if (
      existing &&
      Date.parse(existing.leaseExpiresAt) > Date.parse(claim.leasedAt)
    ) {
      return false;
    }
    this.deploymentPromotions.set(claim.deploymentKey, { ...claim });
    return true;
  }

  async releaseDeploymentPromotion(
    deploymentKey: string,
    leaseId: string
  ): Promise<boolean> {
    const existing = this.deploymentPromotions.get(deploymentKey);
    if (!existing || existing.leaseId !== leaseId) return false;
    return this.deploymentPromotions.delete(deploymentKey);
  }

  async listActiveMonitoringAlerts(repositoryId?: number): Promise<MonitoringAlertRecord[]> {
    return [...this.monitoringAlerts.values()]
      .filter(
        (alert) =>
          !alert.resolvedAt &&
          (repositoryId === undefined || alert.repositoryId === repositoryId)
      )
      .sort(
        (left, right) =>
          left.repositoryId - right.repositoryId ||
          left.alertKey.localeCompare(right.alertKey)
      )
      .map((alert) => ({ ...alert }));
  }

  async resolveMonitoringAlertsForInactiveRepositories(observedAt: Date): Promise<void> {
    const timestamp = observedAt.toISOString();
    for (const [key, alert] of this.monitoringAlerts) {
      const repository = this.repositories.get(alert.repositoryId);
      if (alert.resolvedAt || repository?.repositoryState === "active") continue;
      this.monitoringAlerts.set(key, {
        ...alert,
        lastObservedAt: timestamp,
        resolvedAt: timestamp
      });
    }
  }

  async acquireMonitoringLock(): Promise<StoreLock | undefined> {
    if (this.monitoringLockHeld) return undefined;
    this.monitoringLockHeld = true;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.monitoringLockHeld = false;
      }
    };
  }
}

function timestamp(value?: string): number {
  if (!value) return -1;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -1 : parsed;
}

function compareScannerRunsNewestFirst(
  left: ScannerWorkflowRunRecord,
  right: ScannerWorkflowRunRecord
): number {
  return (
    timestamp(right.completedAt ?? right.startedAt ?? right.processedAt) -
      timestamp(left.completedAt ?? left.startedAt ?? left.processedAt) ||
    right.runId - left.runId ||
    right.runAttempt - left.runAttempt
  );
}

function compareScannerEvidenceNewestFirst(
  left: ScannerEvidenceRecord,
  right: ScannerEvidenceRecord
): number {
  return (
    timestamp(right.observedAt) - timestamp(left.observedAt) ||
    right.runId - left.runId ||
    right.runAttempt - left.runAttempt
  );
}

function cloneScannerWorkflowRun(record: ScannerWorkflowRunRecord): ScannerWorkflowRunRecord {
  return {
    ...record,
    referencedWorkflows: record.referencedWorkflows.map((workflow) => ({ ...workflow }))
  };
}

function cloneScannerEvidence(record: ScannerEvidenceRecord): ScannerEvidenceRecord {
  return {
    ...record,
    payload: record.payload ? structuredClone(record.payload) : undefined
  };
}

function cloneMonitoringSnapshot(record: MonitoringSnapshotRecord): MonitoringSnapshotRecord {
  return {
    ...record,
    checks: record.checks.map((check) => ({ ...check }))
  };
}

function cloneMonitoringWeeklyReport(
  record: MonitoringWeeklyReportRecord
): MonitoringWeeklyReportRecord {
  return structuredClone(record);
}

function monitoringSnapshotKey(repositoryId: number, snapshotKey: string): string {
  return `${repositoryId}:${snapshotKey}`;
}

function monitoringAlertKey(repositoryId: number, alertKey: string): string {
  return `${repositoryId}:${alertKey}`;
}

function scannerRunKey(repositoryId: number, runId: number, runAttempt: number): string {
  return `${repositoryId}:${runId}:${runAttempt}`;
}

function scannerArtifactKey(
  repositoryId: number,
  runId: number,
  runAttempt: number,
  artifactId: number
): string {
  return `${scannerRunKey(repositoryId, runId, runAttempt)}:${artifactId}`;
}

function scannerEvidenceKey(
  repositoryId: number,
  runId: number,
  runAttempt: number,
  artifactId: number,
  evidenceKey: string
): string {
  return `${scannerArtifactKey(repositoryId, runId, runAttempt, artifactId)}:${evidenceKey}`;
}

export class PostgresStore implements Store {
  private readonly pool: Pool;
  private repositoryIndexStorageMode: RepositoryIndexStorageMode = "json-array-fallback";

  constructor(connectionString: string, caCertificate?: string) {
    this.pool = new Pool(postgresPoolConfig(connectionString, caCertificate));
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getRepositoryIndexStorageMode(): Promise<RepositoryIndexStorageMode> {
    return this.repositoryIndexStorageMode;
  }

  async migrate(): Promise<void> {
    this.repositoryIndexStorageMode = await this.detectRepositoryIndexStorageMode();
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repositories (
        repository_id BIGINT PRIMARY KEY,
        installation_id BIGINT NOT NULL,
        full_name TEXT NOT NULL UNIQUE,
        visibility TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        index_sha TEXT,
        index_updated_at TIMESTAMPTZ,
        scanner_state TEXT NOT NULL,
        repository_state TEXT NOT NULL DEFAULT 'active',
        automatic_review_paused BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE repositories ADD COLUMN IF NOT EXISTS repository_state TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE repositories ADD COLUMN IF NOT EXISTS automatic_review_paused BOOLEAN NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS reviews (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id),
        pull_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        reviewed_head_sha TEXT,
        placeholder_comment_id BIGINT,
        findings JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, pull_number)
      );
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewed_head_sha TEXT;

      CREATE TABLE IF NOT EXISTS webhook_jobs (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        last_error TEXT,
        dead_lettered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS webhook_jobs_claim_idx
        ON webhook_jobs (status, available_at, lease_expires_at);

      CREATE TABLE IF NOT EXISTS repository_indexes (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        repository_scope TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        visibility TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        embedding_provider_id TEXT NOT NULL,
        embedding_kind TEXT NOT NULL,
        embedding_dimensions INTEGER NOT NULL,
        vector_storage TEXT NOT NULL,
        index_document JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, commit_sha)
      );
      CREATE INDEX IF NOT EXISTS repository_indexes_scope_commit_idx
        ON repository_indexes (repository_scope, commit_sha);

      CREATE TABLE IF NOT EXISTS repository_index_vectors (
        storage_key TEXT NOT NULL REFERENCES repository_indexes(storage_key) ON DELETE CASCADE,
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        repository_scope TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        visibility TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        path TEXT,
        vector_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (storage_key, record_type, record_id)
      );
      CREATE INDEX IF NOT EXISTS repository_index_vectors_scope_commit_idx
        ON repository_index_vectors (repository_scope, commit_sha);

      CREATE TABLE IF NOT EXISTS scanner_workflow_runs (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        run_id BIGINT NOT NULL,
        run_attempt INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        head_branch TEXT,
        event TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        workflow_path TEXT NOT NULL,
        workflow_ref TEXT,
        workflow_sha TEXT,
        conclusion TEXT NOT NULL,
        status TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        validation_error TEXT,
        referenced_workflows JSONB NOT NULL DEFAULT '[]',
        processed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, run_id, run_attempt)
      );
      ALTER TABLE scanner_workflow_runs ADD COLUMN IF NOT EXISTS event TEXT;
      ALTER TABLE scanner_workflow_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
      ALTER TABLE scanner_workflow_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS scanner_workflow_runs_monitoring_idx
        ON scanner_workflow_runs
          (repository_id, head_branch, event, completed_at DESC, started_at DESC);

      CREATE TABLE IF NOT EXISTS scanner_artifacts (
        repository_id BIGINT NOT NULL,
        run_id BIGINT NOT NULL,
        run_attempt INTEGER NOT NULL,
        artifact_id BIGINT NOT NULL,
        artifact_name TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        expired BOOLEAN NOT NULL,
        digest TEXT,
        validation_status TEXT NOT NULL,
        validation_error TEXT,
        processed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, run_id, run_attempt, artifact_id),
        FOREIGN KEY (repository_id, run_id, run_attempt)
          REFERENCES scanner_workflow_runs(repository_id, run_id, run_attempt)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scanner_evidence (
        repository_id BIGINT NOT NULL,
        run_id BIGINT NOT NULL,
        run_attempt INTEGER NOT NULL,
        artifact_id BIGINT NOT NULL,
        evidence_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        digest TEXT,
        environment TEXT,
        details TEXT,
        fingerprint TEXT,
        path TEXT,
        line INTEGER,
        payload JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, run_id, run_attempt, artifact_id, evidence_key),
        FOREIGN KEY (repository_id, run_id, run_attempt, artifact_id)
          REFERENCES scanner_artifacts(repository_id, run_id, run_attempt, artifact_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS scanner_evidence_kind_idx
        ON scanner_evidence (repository_id, kind, observed_at DESC);
      CREATE INDEX IF NOT EXISTS scanner_evidence_monitoring_idx
        ON scanner_evidence (repository_id, evidence_key, observed_at DESC)
        WHERE fingerprint IS NULL;

      CREATE TABLE IF NOT EXISTS monitoring_snapshots (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        snapshot_key TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        inventory_state TEXT NOT NULL,
        overall_status TEXT NOT NULL,
        checks JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, snapshot_key)
      );
      CREATE INDEX IF NOT EXISTS monitoring_snapshots_latest_idx
        ON monitoring_snapshots (repository_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS monitoring_alerts (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        alert_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        first_observed_at TIMESTAMPTZ NOT NULL,
        last_observed_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, alert_key)
      );
      CREATE INDEX IF NOT EXISTS monitoring_alerts_active_idx
        ON monitoring_alerts (active, severity, last_observed_at DESC);

      CREATE TABLE IF NOT EXISTS monitoring_weekly_reports (
        week_key TEXT PRIMARY KEY,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        report JSONB NOT NULL,
        source_completeness JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS monitoring_weekly_reports_period_idx
        ON monitoring_weekly_reports (period_start DESC);

      CREATE TABLE IF NOT EXISTS dast_session_issuances (
        issuance_key TEXT PRIMARY KEY,
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        run_id BIGINT NOT NULL,
        run_attempt INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('leased', 'issued')),
        lease_id TEXT NOT NULL,
        leased_at TIMESTAMPTZ NOT NULL,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        issued_at TIMESTAMPTZ,
        credential_expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS dast_session_issuances_repository_idx
        ON dast_session_issuances (repository_id, run_id DESC, run_attempt DESC);

      CREATE TABLE IF NOT EXISTS deployment_promotions (
        deployment_key TEXT PRIMARY KEY,
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        environment TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        run_id BIGINT NOT NULL,
        run_attempt INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        leased_at TIMESTAMPTZ NOT NULL,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS deployment_promotions_repository_idx
        ON deployment_promotions (repository_id, environment);
    `);
    if (this.repositoryIndexStorageMode === "pgvector") {
      await this.pool.query(
        "ALTER TABLE repository_index_vectors ADD COLUMN IF NOT EXISTS vector_pgvector vector"
      );
    }
  }

  async upsertRepository(record: RepositoryRecord) {
    await this.pool.query(
      `INSERT INTO repositories
       (repository_id, installation_id, full_name, visibility, default_branch, index_sha, index_updated_at, scanner_state, repository_state, automatic_review_paused)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (repository_id) DO UPDATE SET
       installation_id=excluded.installation_id, full_name=excluded.full_name,
       visibility=excluded.visibility, default_branch=excluded.default_branch,
       index_sha=excluded.index_sha, index_updated_at=excluded.index_updated_at,
       scanner_state=excluded.scanner_state, repository_state=excluded.repository_state,
       automatic_review_paused=excluded.automatic_review_paused, updated_at=now()`,
      [
        record.repositoryId,
        record.installationId,
        record.fullName,
        record.visibility,
        record.defaultBranch,
        record.indexSha,
        record.indexUpdatedAt,
        record.scannerState,
        record.repositoryState,
        record.automaticReviewPaused
      ]
    );
  }

  async getRepository(id: number) {
    const result = await this.pool.query("SELECT * FROM repositories WHERE repository_id=$1", [id]);
    if (!result.rows[0]) return undefined;
    const row = result.rows[0];
    return {
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      fullName: row.full_name,
      visibility: row.visibility,
      defaultBranch: row.default_branch,
      indexSha: row.index_sha ?? undefined,
      indexUpdatedAt: fromUnknownDate(row.index_updated_at),
      scannerState: row.scanner_state,
      repositoryState: row.repository_state,
      automaticReviewPaused: Boolean(row.automatic_review_paused)
    } as RepositoryRecord;
  }

  async replaceRepositoryIndex(
    repositoryId: number,
    index: RepositoryIndex,
    vectors: readonly PersistedVectorRow[],
    indexedAt = new Date()
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const repository = await client.query(
        "SELECT repository_id FROM repositories WHERE repository_id=$1 FOR UPDATE",
        [repositoryId]
      );
      if (!repository.rows[0]) {
        throw new Error(`repository ${repositoryId} must exist before indexing`);
      }
      await client.query(
        `INSERT INTO repository_indexes
         (repository_id, repository_scope, commit_sha, visibility, storage_key, full_name, content_sha256,
          embedding_provider_id, embedding_kind, embedding_dimensions, vector_storage, index_document)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (repository_id, commit_sha) DO UPDATE SET
           repository_scope=excluded.repository_scope,
           visibility=excluded.visibility,
           storage_key=excluded.storage_key,
           full_name=excluded.full_name,
           content_sha256=excluded.content_sha256,
           embedding_provider_id=excluded.embedding_provider_id,
           embedding_kind=excluded.embedding_kind,
           embedding_dimensions=excluded.embedding_dimensions,
           vector_storage=excluded.vector_storage,
           index_document=excluded.index_document,
           updated_at=now()`,
        [
          repositoryId,
          index.repositoryScope,
          index.commitSha,
          index.visibility,
          index.storageKey,
          index.repository,
          index.contentSha256,
          index.embedding.providerId,
          index.embedding.kind,
          index.embedding.dimensions,
          this.repositoryIndexStorageMode,
          JSON.stringify(index)
        ]
      );
      await client.query("DELETE FROM repository_index_vectors WHERE storage_key=$1", [
        index.storageKey
      ]);
      for (let start = 0; start < vectors.length; start += 100) {
        await this.insertRepositoryIndexVectorBatch(
          client,
          repositoryId,
          vectors.slice(start, start + 100)
        );
      }
      await client.query(
        `UPDATE repositories
         SET index_sha=$2, index_updated_at=$3, updated_at=now()
         WHERE repository_id=$1`,
        [repositoryId, index.commitSha, indexedAt]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRepositoryIndex(
    repositoryId: number,
    repositoryScope: string,
    commitSha: string
  ) {
    const result = await this.pool.query(
      `SELECT index_document
       FROM repository_indexes
       WHERE repository_id=$1 AND repository_scope=$2 AND commit_sha=$3`,
      [repositoryId, repositoryScope, commitSha]
    );
    const row = result.rows[0];
    return row ? (row.index_document as RepositoryIndex) : undefined;
  }

  async setRepositoryState(repositoryId: number, state: RepositoryLifecycleState) {
    await this.pool.query(
      "UPDATE repositories SET repository_state=$2, updated_at=now() WHERE repository_id=$1",
      [repositoryId, state]
    );
  }

  async setInstallationState(installationId: number, state: RepositoryLifecycleState) {
    await this.pool.query(
      "UPDATE repositories SET repository_state=$2, updated_at=now() WHERE installation_id=$1",
      [installationId, state]
    );
  }

  async setAutomaticReviewPaused(repositoryId: number, paused: boolean) {
    await this.pool.query(
      "UPDATE repositories SET automatic_review_paused=$2, updated_at=now() WHERE repository_id=$1",
      [repositoryId, paused]
    );
  }

  async saveReviewHead(
    repositoryId: number,
    pullNumber: number,
    headSha: string,
    placeholderCommentId?: number
  ) {
    await this.pool.query(
      `INSERT INTO reviews (repository_id,pull_number,head_sha,reviewed_head_sha,placeholder_comment_id,findings)
       VALUES ($1,$2,$3,NULL,$4,'[]'::jsonb)
       ON CONFLICT (repository_id,pull_number) DO UPDATE SET
       head_sha=excluded.head_sha,
       placeholder_comment_id=COALESCE(excluded.placeholder_comment_id, reviews.placeholder_comment_id),
       updated_at=now()`,
      [repositoryId, pullNumber, headSha, placeholderCommentId]
    );
  }

  async saveReview(state: ReviewState, expectedHeadSha?: string) {
    const result = await this.pool.query(
      `INSERT INTO reviews (repository_id,pull_number,head_sha,reviewed_head_sha,placeholder_comment_id,findings)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (repository_id,pull_number) DO UPDATE SET
       head_sha=excluded.head_sha,
       reviewed_head_sha=excluded.reviewed_head_sha,
       placeholder_comment_id=excluded.placeholder_comment_id,
       findings=excluded.findings,
       updated_at=now()
       WHERE $7::text IS NULL OR reviews.head_sha=$7`,
      [
        state.repositoryId,
        state.pullNumber,
        state.headSha,
        state.reviewedHeadSha,
        state.placeholderCommentId,
        JSON.stringify(state.findings),
        expectedHeadSha ?? null
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getReview(id: number, pull: number) {
    const result = await this.pool.query(
      "SELECT * FROM reviews WHERE repository_id=$1 AND pull_number=$2",
      [id, pull]
    );
    if (!result.rows[0]) return undefined;
    const row = result.rows[0];
    return {
      repositoryId: Number(row.repository_id),
      pullNumber: row.pull_number,
      headSha: row.head_sha,
      reviewedHeadSha: row.reviewed_head_sha ?? undefined,
      placeholderCommentId: row.placeholder_comment_id ? Number(row.placeholder_comment_id) : undefined,
      findings: row.findings
    } as ReviewState;
  }

  async enqueueWebhook(deliveryId: string, eventName: string, payload: Record<string, any>) {
    const result = await this.pool.query(
      `INSERT INTO webhook_jobs (delivery_id, event_name, payload, status, attempts, available_at)
       VALUES ($1,$2,$3,'pending',0,now())
       ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, eventName, JSON.stringify(payload)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimWebhook(workerId: string, leaseMs: number, now = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH candidate AS (
          SELECT delivery_id
          FROM webhook_jobs
          WHERE status IN ('pending', 'leased')
            AND available_at <= $2
            AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= $2)
          ORDER BY available_at ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE webhook_jobs AS jobs
        SET status='leased',
            attempts=jobs.attempts + 1,
            lease_owner=$1,
            lease_expires_at=$3,
            updated_at=now()
        FROM candidate
        WHERE jobs.delivery_id = candidate.delivery_id
        RETURNING jobs.*`,
        [workerId, now, new Date(now.getTime() + leaseMs)]
      );
      await client.query("COMMIT");
      return result.rows[0] ? this.toWebhookJob(result.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeWebhook(deliveryId: string, workerId: string) {
    await this.pool.query(
      `UPDATE webhook_jobs
       SET status='succeeded', lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE delivery_id=$1 AND lease_owner=$2`,
      [deliveryId, workerId]
    );
  }

  async failWebhook(
    deliveryId: string,
    workerId: string,
    error: string,
    retryAt: Date | undefined,
    deadLetter: boolean
  ) {
    await this.pool.query(
      `UPDATE webhook_jobs
       SET status=$3,
           lease_owner=NULL,
           lease_expires_at=NULL,
           available_at=COALESCE($4, available_at),
           last_error=$5,
           dead_lettered_at=CASE WHEN $6 THEN now() ELSE NULL END,
           updated_at=now()
       WHERE delivery_id=$1 AND lease_owner=$2`,
      [deliveryId, workerId, deadLetter ? "dead-letter" : "pending", retryAt ?? null, error, deadLetter]
    );
  }

  async getWebhook(deliveryId: string) {
    const result = await this.pool.query("SELECT * FROM webhook_jobs WHERE delivery_id=$1", [deliveryId]);
    return result.rows[0] ? this.toWebhookJob(result.rows[0]) : undefined;
  }

  async upsertScannerWorkflowRun(record: ScannerWorkflowRunRecord) {
    await this.pool.query(
      `INSERT INTO scanner_workflow_runs
       (repository_id, run_id, run_attempt, head_sha, head_branch, event, started_at, completed_at,
        workflow_path, workflow_ref, workflow_sha, conclusion, status, validation_status,
        validation_error, referenced_workflows, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (repository_id, run_id, run_attempt) DO UPDATE SET
         head_sha=excluded.head_sha,
         head_branch=excluded.head_branch,
         event=excluded.event,
         started_at=excluded.started_at,
         completed_at=excluded.completed_at,
         workflow_path=excluded.workflow_path,
         workflow_ref=excluded.workflow_ref,
         workflow_sha=excluded.workflow_sha,
         conclusion=excluded.conclusion,
         status=excluded.status,
         validation_status=excluded.validation_status,
         validation_error=excluded.validation_error,
         referenced_workflows=excluded.referenced_workflows,
         processed_at=excluded.processed_at,
         updated_at=now()`,
      [
        record.repositoryId,
        record.runId,
        record.runAttempt,
        record.headSha,
        record.headBranch ?? null,
        record.event ?? null,
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.workflowPath,
        record.workflowRef ?? null,
        record.workflowSha ?? null,
        record.conclusion,
        record.status,
        record.validationStatus,
        record.validationError ?? null,
        JSON.stringify(record.referencedWorkflows),
        record.processedAt ?? null
      ]
    );
  }

  async getScannerWorkflowRun(repositoryId: number, runId: number, runAttempt: number) {
    const result = await this.pool.query(
      `SELECT *
       FROM scanner_workflow_runs
       WHERE repository_id=$1 AND run_id=$2 AND run_attempt=$3`,
      [repositoryId, runId, runAttempt]
    );
    return result.rows[0] ? this.toScannerWorkflowRun(result.rows[0]) : undefined;
  }

  async upsertScannerArtifact(record: ScannerArtifactRecord) {
    await this.pool.query(
      `INSERT INTO scanner_artifacts
       (repository_id, run_id, run_attempt, artifact_id, artifact_name, artifact_type, size_bytes,
        expired, digest, validation_status, validation_error, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (repository_id, run_id, run_attempt, artifact_id) DO UPDATE SET
         artifact_name=excluded.artifact_name,
         artifact_type=excluded.artifact_type,
         size_bytes=excluded.size_bytes,
         expired=excluded.expired,
         digest=excluded.digest,
         validation_status=excluded.validation_status,
         validation_error=excluded.validation_error,
         processed_at=excluded.processed_at,
         updated_at=now()`,
      [
        record.repositoryId,
        record.runId,
        record.runAttempt,
        record.artifactId,
        record.artifactName,
        record.artifactType,
        record.sizeBytes,
        record.expired,
        record.digest ?? null,
        record.validationStatus,
        record.validationError ?? null,
        record.processedAt ?? null
      ]
    );
  }

  async upsertScannerEvidence(record: ScannerEvidenceRecord) {
    await this.pool.query(
      `INSERT INTO scanner_evidence
       (repository_id, run_id, run_attempt, artifact_id, evidence_key, kind, source, status,
        observed_at, digest, environment, details, fingerprint, path, line, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (repository_id, run_id, run_attempt, artifact_id, evidence_key) DO UPDATE SET
         kind=excluded.kind,
         source=excluded.source,
         status=excluded.status,
         observed_at=excluded.observed_at,
         digest=excluded.digest,
         environment=excluded.environment,
         details=excluded.details,
         fingerprint=excluded.fingerprint,
         path=excluded.path,
         line=excluded.line,
         payload=excluded.payload,
         updated_at=now()`,
      [
        record.repositoryId,
        record.runId,
        record.runAttempt,
        record.artifactId,
        record.evidenceKey,
        record.kind,
        record.source,
        record.status,
        record.observedAt,
        record.digest ?? null,
        record.environment ?? null,
        record.details ?? null,
        record.fingerprint ?? null,
        record.path ?? null,
        record.line ?? null,
        record.payload ? JSON.stringify(record.payload) : null
      ]
    );
  }

  async listMonitoringRepositoryInventory(): Promise<MonitoringRepositoryInventory[]> {
    const [repositoriesResult, indexesResult, runsResult, evidenceResult] = await Promise.all([
      this.pool.query(
        `SELECT *
         FROM repositories
         WHERE repository_state='active'
         ORDER BY repository_id ASC`
      ),
      this.pool.query(
        `SELECT indexes.repository_id, indexes.index_document
         FROM repository_indexes AS indexes
         JOIN repositories AS repositories
           ON repositories.repository_id=indexes.repository_id
          AND repositories.repository_state='active'
          AND repositories.index_sha=indexes.commit_sha`
      ),
      this.pool.query(
        `WITH ranked_runs AS (
           SELECT runs.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY runs.repository_id
                    ORDER BY COALESCE(
                               runs.completed_at,
                               runs.started_at,
                               runs.processed_at,
                               runs.updated_at
                             ) DESC,
                             runs.run_id DESC,
                             runs.run_attempt DESC
                  ) AS monitoring_rank
           FROM scanner_workflow_runs AS runs
           JOIN repositories AS repositories
             ON repositories.repository_id=runs.repository_id
            AND repositories.repository_state='active'
            AND runs.head_branch=repositories.default_branch
         )
         SELECT *
         FROM ranked_runs
         WHERE monitoring_rank <= 256
         ORDER BY repository_id, monitoring_rank`
      ),
      this.pool.query(
        `SELECT DISTINCT ON (
           evidence.repository_id,
           evidence.evidence_key,
           runs.event,
           artifacts.artifact_type
         )
           evidence.*,
           artifacts.artifact_type AS monitoring_artifact_type
         FROM scanner_evidence AS evidence
         JOIN scanner_workflow_runs AS runs
           ON runs.repository_id=evidence.repository_id
          AND runs.run_id=evidence.run_id
          AND runs.run_attempt=evidence.run_attempt
         JOIN scanner_artifacts AS artifacts
           ON artifacts.repository_id=evidence.repository_id
          AND artifacts.run_id=evidence.run_id
          AND artifacts.run_attempt=evidence.run_attempt
          AND artifacts.artifact_id=evidence.artifact_id
         JOIN repositories AS repositories
          ON repositories.repository_id=evidence.repository_id
          AND repositories.repository_state='active'
         WHERE evidence.fingerprint IS NULL
         ORDER BY evidence.repository_id,
                  evidence.evidence_key,
                  runs.event,
                  artifacts.artifact_type,
                  evidence.observed_at DESC,
                  evidence.updated_at DESC,
                  evidence.run_id DESC,
                  evidence.run_attempt DESC`
      )
    ]);
    const indexByRepository = new Map<number, RepositoryIndex>();
    for (const row of indexesResult.rows) {
      indexByRepository.set(
        Number(row.repository_id),
        structuredClone(row.index_document as RepositoryIndex)
      );
    }
    const runsByRepository = new Map<number, ScannerWorkflowRunRecord[]>();
    for (const row of runsResult.rows) {
      const run = this.toScannerWorkflowRun(row);
      const records = runsByRepository.get(run.repositoryId) ?? [];
      records.push(run);
      runsByRepository.set(run.repositoryId, records);
    }
    const evidenceByRepository = new Map<number, ScannerEvidenceRecord[]>();
    for (const row of evidenceResult.rows) {
      const evidence = this.toScannerEvidence(row);
      const records = evidenceByRepository.get(evidence.repositoryId) ?? [];
      records.push(evidence);
      evidenceByRepository.set(evidence.repositoryId, records);
    }
    return repositoriesResult.rows.map((row) => {
      const repository = this.toRepositoryRecord(row);
      return {
        repository,
        index: indexByRepository.get(repository.repositoryId),
        latestScannerRuns:
          runsByRepository.get(repository.repositoryId)?.map(cloneScannerWorkflowRun) ?? [],
        latestScannerEvidence:
          evidenceByRepository.get(repository.repositoryId)?.map(cloneScannerEvidence) ?? []
      };
    });
  }

  async saveMonitoringSnapshot(
    snapshot: MonitoringSnapshotRecord,
    activeAlerts: readonly MonitoringAlertInput[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO monitoring_snapshots
           (repository_id, snapshot_key, observed_at, inventory_state, overall_status, checks)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (repository_id, snapshot_key) DO UPDATE SET
           observed_at=excluded.observed_at,
           inventory_state=excluded.inventory_state,
           overall_status=excluded.overall_status,
           checks=excluded.checks,
           updated_at=now()`,
        [
          snapshot.repositoryId,
          snapshot.snapshotKey,
          snapshot.observedAt,
          snapshot.inventoryState,
          snapshot.overallStatus,
          JSON.stringify(snapshot.checks)
        ]
      );
      for (const alert of activeAlerts) {
        await client.query(
          `INSERT INTO monitoring_alerts
             (repository_id, alert_key, severity, summary, active,
              first_observed_at, last_observed_at, resolved_at)
           VALUES ($1,$2,$3,$4,true,$5,$5,NULL)
           ON CONFLICT (repository_id, alert_key) DO UPDATE SET
             severity=excluded.severity,
             summary=excluded.summary,
             active=true,
             first_observed_at=CASE
               WHEN monitoring_alerts.active THEN monitoring_alerts.first_observed_at
               ELSE excluded.first_observed_at
             END,
             last_observed_at=excluded.last_observed_at,
             resolved_at=NULL,
             updated_at=now()`,
          [
            snapshot.repositoryId,
            alert.alertKey,
            alert.severity,
            alert.summary,
            snapshot.observedAt
          ]
        );
      }
      await client.query(
        `UPDATE monitoring_alerts
         SET active=false,
             last_observed_at=$2,
             resolved_at=$2,
             updated_at=now()
         WHERE repository_id=$1
           AND active=true
           AND NOT (alert_key = ANY($3::text[]))`,
        [snapshot.repositoryId, snapshot.observedAt, activeAlerts.map((alert) => alert.alertKey)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getLatestMonitoringSnapshot(
    repositoryId: number
  ): Promise<MonitoringSnapshotRecord | undefined> {
    const result = await this.pool.query(
      `SELECT *
       FROM monitoring_snapshots
       WHERE repository_id=$1
       ORDER BY observed_at DESC, snapshot_key DESC
       LIMIT 1`,
      [repositoryId]
    );
    return result.rows[0] ? this.toMonitoringSnapshot(result.rows[0]) : undefined;
  }

  async saveMonitoringWeeklyReport(report: MonitoringWeeklyReportRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO monitoring_weekly_reports
         (week_key, period_start, period_end, generated_at, report, source_completeness)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (week_key) DO UPDATE SET
         period_start=excluded.period_start,
         period_end=excluded.period_end,
         generated_at=excluded.generated_at,
         report=excluded.report,
         source_completeness=excluded.source_completeness,
         updated_at=now()`,
      [
        report.weekKey,
        report.periodStart,
        report.periodEnd,
        report.generatedAt,
        JSON.stringify(report.report),
        JSON.stringify(report.sourceCompleteness)
      ]
    );
  }

  async getMonitoringWeeklyReport(
    weekKey: string
  ): Promise<MonitoringWeeklyReportRecord | undefined> {
    const result = await this.pool.query(
      `SELECT *
       FROM monitoring_weekly_reports
       WHERE week_key=$1`,
      [weekKey]
    );
    return result.rows[0] ? this.toMonitoringWeeklyReport(result.rows[0]) : undefined;
  }

  async claimDastSessionIssuance(
    claim: DastSessionIssuanceClaim
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO dast_session_issuances
         (issuance_key, repository_id, run_id, run_attempt, profile_id, origin,
          status, lease_id, leased_at, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'leased',$7,$8,$9)
       ON CONFLICT (issuance_key) DO UPDATE SET
         status='leased',
         lease_id=excluded.lease_id,
         leased_at=excluded.leased_at,
         lease_expires_at=excluded.lease_expires_at,
         updated_at=now()
       WHERE dast_session_issuances.status='leased'
         AND dast_session_issuances.lease_expires_at <= excluded.leased_at
       RETURNING issuance_key`,
      [
        claim.issuanceKey,
        claim.repositoryId,
        claim.runId,
        claim.runAttempt,
        claim.profileId,
        claim.origin,
        claim.leaseId,
        claim.leasedAt,
        claim.leaseExpiresAt
      ]
    );
    return result.rowCount === 1;
  }

  async completeDastSessionIssuance(
    issuanceKey: string,
    leaseId: string,
    issuedAt: string,
    credentialExpiresAt: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE dast_session_issuances
       SET status='issued',
           issued_at=$3,
           credential_expires_at=$4,
           updated_at=now()
       WHERE issuance_key=$1
         AND lease_id=$2
         AND status='leased'`,
      [issuanceKey, leaseId, issuedAt, credentialExpiresAt]
    );
    return result.rowCount === 1;
  }

  async releaseDastSessionIssuance(
    issuanceKey: string,
    leaseId: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM dast_session_issuances
       WHERE issuance_key=$1
         AND lease_id=$2
         AND status='leased'`,
      [issuanceKey, leaseId]
    );
    return result.rowCount === 1;
  }

  async getSuccessfulDeploymentEvidence(
    repositoryId: number,
    environment: string,
    headSha: string,
    defaultBranch: string
  ): Promise<SuccessfulDeploymentEvidence | undefined> {
    const result = await this.pool.query(
      `SELECT evidence.run_id,
              evidence.run_attempt,
              evidence.digest,
              evidence.observed_at,
              evidence.payload->>'origin' AS origin
       FROM scanner_evidence AS evidence
       JOIN scanner_workflow_runs AS runs
         ON runs.repository_id=evidence.repository_id
        AND runs.run_id=evidence.run_id
        AND runs.run_attempt=evidence.run_attempt
       JOIN scanner_artifacts AS artifacts
         ON artifacts.repository_id=evidence.repository_id
        AND artifacts.run_id=evidence.run_id
        AND artifacts.run_attempt=evidence.run_attempt
        AND artifacts.artifact_id=evidence.artifact_id
       WHERE evidence.repository_id=$1
         AND evidence.evidence_key=$2
         AND evidence.kind='deployment'
         AND evidence.source='digitalocean'
         AND evidence.status='success'
         AND evidence.environment=$3
         AND evidence.fingerprint IS NULL
         AND evidence.digest ~ '^sha256:[a-f0-9]{64}$'
         AND runs.head_sha=$4
         AND runs.head_branch=$5
         AND runs.event='push'
         AND runs.conclusion='success'
         AND runs.validation_status='accepted'
         AND artifacts.artifact_type='image-promotion'
         AND artifacts.validation_status='accepted'
         AND jsonb_typeof(evidence.payload)='object'
         AND jsonb_typeof(evidence.payload->'origin')='string'
       ORDER BY evidence.observed_at DESC,
                evidence.updated_at DESC,
                evidence.run_id DESC,
                evidence.run_attempt DESC
       LIMIT 1`,
      [
        repositoryId,
        `deployment:${environment}`,
        environment,
        headSha,
        defaultBranch
      ]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      repositoryId,
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      headSha,
      environment,
      imageDigest: String(row.digest),
      observedAt: new Date(row.observed_at).toISOString(),
      origin: String(row.origin)
    };
  }

  async claimDeploymentPromotion(
    claim: DeploymentPromotionClaim
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO deployment_promotions
         (deployment_key, repository_id, environment, image_digest, run_id,
          run_attempt, lease_id, leased_at, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (deployment_key) DO UPDATE SET
         repository_id=excluded.repository_id,
         environment=excluded.environment,
         image_digest=excluded.image_digest,
         run_id=excluded.run_id,
         run_attempt=excluded.run_attempt,
         lease_id=excluded.lease_id,
         leased_at=excluded.leased_at,
         lease_expires_at=excluded.lease_expires_at,
         updated_at=now()
       WHERE deployment_promotions.lease_expires_at <= excluded.leased_at
       RETURNING deployment_key`,
      [
        claim.deploymentKey,
        claim.repositoryId,
        claim.environment,
        claim.imageDigest,
        claim.runId,
        claim.runAttempt,
        claim.leaseId,
        claim.leasedAt,
        claim.leaseExpiresAt
      ]
    );
    return result.rowCount === 1;
  }

  async releaseDeploymentPromotion(
    deploymentKey: string,
    leaseId: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM deployment_promotions
       WHERE deployment_key=$1 AND lease_id=$2`,
      [deploymentKey, leaseId]
    );
    return result.rowCount === 1;
  }

  async listActiveMonitoringAlerts(repositoryId?: number): Promise<MonitoringAlertRecord[]> {
    const result =
      repositoryId === undefined
        ? await this.pool.query(
            `SELECT *
             FROM monitoring_alerts
             WHERE active=true
             ORDER BY repository_id ASC, alert_key ASC`
          )
        : await this.pool.query(
            `SELECT *
             FROM monitoring_alerts
             WHERE active=true AND repository_id=$1
             ORDER BY alert_key ASC`,
            [repositoryId]
          );
    return result.rows.map((row) => this.toMonitoringAlert(row));
  }

  async resolveMonitoringAlertsForInactiveRepositories(observedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE monitoring_alerts AS alerts
       SET active=false,
           last_observed_at=$1,
           resolved_at=$1,
           updated_at=now()
       WHERE alerts.active=true
         AND NOT EXISTS (
           SELECT 1
           FROM repositories
           WHERE repositories.repository_id=alerts.repository_id
             AND repositories.repository_state='active'
         )`,
      [observedAt]
    );
  }

  async acquireMonitoringLock(): Promise<StoreLock | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [MONITORING_LOCK_NAMESPACE, MONITORING_LOCK_KEY]
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return undefined;
      }
    } catch (error) {
      client.release(true);
      throw error;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          const result = await client.query<{ released: boolean }>(
            "SELECT pg_advisory_unlock($1, $2) AS released",
            [MONITORING_LOCK_NAMESPACE, MONITORING_LOCK_KEY]
          );
          if (!result.rows[0]?.released) {
            throw new Error("PostgreSQL monitoring advisory lock was not held");
          }
          client.release();
        } catch (error) {
          client.release(true);
          throw error;
        }
      }
    };
  }

  private toRepositoryRecord(row: Record<string, any>): RepositoryRecord {
    return {
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      fullName: String(row.full_name),
      visibility: String(row.visibility),
      defaultBranch: String(row.default_branch),
      indexSha: row.index_sha ?? undefined,
      indexUpdatedAt: fromUnknownDate(row.index_updated_at),
      scannerState: row.scanner_state,
      repositoryState: row.repository_state,
      automaticReviewPaused: Boolean(row.automatic_review_paused)
    } as RepositoryRecord;
  }

  private toScannerWorkflowRun(row: Record<string, any>): ScannerWorkflowRunRecord {
    return {
      repositoryId: Number(row.repository_id),
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      headSha: String(row.head_sha),
      headBranch: row.head_branch ?? undefined,
      event: row.event ?? undefined,
      startedAt: fromUnknownDate(row.started_at),
      completedAt: fromUnknownDate(row.completed_at),
      workflowPath: String(row.workflow_path),
      workflowRef: row.workflow_ref ?? undefined,
      workflowSha: row.workflow_sha ?? undefined,
      conclusion: String(row.conclusion),
      status: String(row.status),
      validationStatus: row.validation_status,
      validationError: row.validation_error ?? undefined,
      referencedWorkflows: Array.isArray(row.referenced_workflows)
        ? row.referenced_workflows
        : [],
      processedAt: fromUnknownDate(row.processed_at)
    } as ScannerWorkflowRunRecord;
  }

  private toScannerEvidence(row: Record<string, any>): ScannerEvidenceRecord {
    return {
      repositoryId: Number(row.repository_id),
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      artifactId: Number(row.artifact_id),
      artifactType: row.monitoring_artifact_type ?? undefined,
      evidenceKey: String(row.evidence_key),
      kind: String(row.kind),
      source: String(row.source),
      status: row.status,
      observedAt: fromUnknownDate(row.observed_at) ?? String(row.observed_at),
      digest: row.digest ?? undefined,
      environment: row.environment ?? undefined,
      details: row.details ?? undefined,
      fingerprint: row.fingerprint ?? undefined,
      path: row.path ?? undefined,
      line: row.line === null || row.line === undefined ? undefined : Number(row.line),
      payload:
        row.payload && typeof row.payload === "object"
          ? structuredClone(row.payload as Record<string, unknown>)
          : undefined
    } as ScannerEvidenceRecord;
  }

  private toMonitoringSnapshot(row: Record<string, any>): MonitoringSnapshotRecord {
    const checks = Array.isArray(row.checks) ? row.checks : [];
    return {
      repositoryId: Number(row.repository_id),
      snapshotKey: String(row.snapshot_key),
      observedAt: fromUnknownDate(row.observed_at) ?? String(row.observed_at),
      inventoryState: row.inventory_state,
      overallStatus: row.overall_status,
      checks: checks.map((check) => ({ ...check })) as PersistedMonitoringCheck[]
    };
  }

  private toMonitoringWeeklyReport(
    row: Record<string, any>
  ): MonitoringWeeklyReportRecord {
    return {
      weekKey: String(row.week_key),
      periodStart:
        fromUnknownDate(row.period_start) ?? String(row.period_start),
      periodEnd: fromUnknownDate(row.period_end) ?? String(row.period_end),
      generatedAt:
        fromUnknownDate(row.generated_at) ?? String(row.generated_at),
      report: structuredClone(row.report as WeeklyCoverageReport),
      sourceCompleteness: structuredClone(
        row.source_completeness as MonitoringWeeklyReportRecord["sourceCompleteness"]
      )
    };
  }

  private toMonitoringAlert(row: Record<string, any>): MonitoringAlertRecord {
    return {
      repositoryId: Number(row.repository_id),
      alertKey: String(row.alert_key),
      severity: row.severity,
      summary: String(row.summary),
      firstObservedAt:
        fromUnknownDate(row.first_observed_at) ?? String(row.first_observed_at),
      lastObservedAt:
        fromUnknownDate(row.last_observed_at) ?? String(row.last_observed_at),
      resolvedAt: fromUnknownDate(row.resolved_at)
    };
  }

  private toWebhookJob(row: Record<string, any>): WebhookJob {
    return {
      deliveryId: row.delivery_id,
      eventName: row.event_name,
      payload: row.payload,
      status: row.status,
      attempts: Number(row.attempts),
      availableAt: fromUnknownDate(row.available_at) ?? new Date(0).toISOString(),
      leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: fromUnknownDate(row.lease_expires_at),
      lastError: row.last_error ?? undefined,
      deadLetteredAt: fromUnknownDate(row.dead_lettered_at)
    };
  }

  private async detectRepositoryIndexStorageMode(): Promise<RepositoryIndexStorageMode> {
    try {
      await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      // Managed PostgreSQL may deny extension creation. Fall back safely below.
    }
    try {
      const result = await this.pool.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') AS installed"
      );
      return result.rows[0]?.installed ? "pgvector" : "json-array-fallback";
    } catch {
      return "json-array-fallback";
    }
  }

  private async insertRepositoryIndexVectorBatch(
    client: PoolClient,
    repositoryId: number,
    vectors: readonly PersistedVectorRow[]
  ): Promise<void> {
    const statement = buildRepositoryIndexVectorBatchStatement(
      repositoryId,
      vectors,
      this.repositoryIndexStorageMode === "pgvector"
    );
    if (!statement) return;
    await client.query(statement.text, statement.values);
  }
}

export interface RepositoryIndexVectorBatchStatement {
  text: string;
  values: unknown[];
}

export function buildRepositoryIndexVectorBatchStatement(
  repositoryId: number,
  vectors: readonly PersistedVectorRow[],
  usePgvector: boolean
): RepositoryIndexVectorBatchStatement | undefined {
  if (!vectors.length) return undefined;
  const values: unknown[] = [];
  const rows: string[] = [];
  for (const vector of vectors) {
    const firstPosition = values.length + 1;
    values.push(
      vector.storageKey,
      repositoryId,
      vector.repositoryScope,
      vector.commitSha,
      vector.visibility,
      vector.providerId,
      vector.dimensions,
      vector.recordType,
      vector.recordId,
      vector.path ?? null,
      JSON.stringify(vector.vector)
    );
    const placeholders = Array.from(
      { length: 11 },
      (_, offset) => `$${firstPosition + offset}`
    );
    if (usePgvector) {
      values.push(vectorLiteral(vector.vector));
      placeholders.push(`$${firstPosition + 11}::vector`);
    }
    rows.push(`(${placeholders.join(",")})`);
  }
  const text = usePgvector
    ? `INSERT INTO repository_index_vectors
       (storage_key, repository_id, repository_scope, commit_sha, visibility, provider_id, dimensions,
        record_type, record_id, path, vector_json, vector_pgvector)
       VALUES ${rows.join(",")}
       ON CONFLICT (storage_key, record_type, record_id) DO UPDATE SET
         repository_id=excluded.repository_id,
         repository_scope=excluded.repository_scope,
         commit_sha=excluded.commit_sha,
         visibility=excluded.visibility,
         provider_id=excluded.provider_id,
         dimensions=excluded.dimensions,
         path=excluded.path,
         vector_json=excluded.vector_json,
         vector_pgvector=excluded.vector_pgvector,
         updated_at=now()`
    : `INSERT INTO repository_index_vectors
       (storage_key, repository_id, repository_scope, commit_sha, visibility, provider_id, dimensions,
        record_type, record_id, path, vector_json)
       VALUES ${rows.join(",")}
       ON CONFLICT (storage_key, record_type, record_id) DO UPDATE SET
         repository_id=excluded.repository_id,
         repository_scope=excluded.repository_scope,
         commit_sha=excluded.commit_sha,
         visibility=excluded.visibility,
         provider_id=excluded.provider_id,
         dimensions=excluded.dimensions,
         path=excluded.path,
         vector_json=excluded.vector_json,
         updated_at=now()`;
  return { text, values };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
