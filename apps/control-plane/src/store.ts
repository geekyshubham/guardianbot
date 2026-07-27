import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { PersistedVectorRow, RepositoryIndex } from "@guardianbot/core";

export type RepositoryLifecycleState = "active" | "suspended" | "removed";
export type WebhookJobStatus = "pending" | "leased" | "succeeded" | "dead-letter";
export type RepositoryIndexStorageMode = "memory" | "pgvector" | "json-array-fallback";

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
export type ScannerArtifactValidationStatus = "accepted" | "rejected" | "failed";
export type ScannerEvidenceStatus = "success" | "failure";

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
       (repository_id, run_id, run_attempt, head_sha, head_branch, workflow_path, workflow_ref,
        workflow_sha, conclusion, status, validation_status, validation_error, referenced_workflows,
        processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (repository_id, run_id, run_attempt) DO UPDATE SET
         head_sha=excluded.head_sha,
         head_branch=excluded.head_branch,
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
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      repositoryId: Number(row.repository_id),
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      headSha: row.head_sha,
      headBranch: row.head_branch ?? undefined,
      workflowPath: row.workflow_path,
      workflowRef: row.workflow_ref ?? undefined,
      workflowSha: row.workflow_sha ?? undefined,
      conclusion: row.conclusion,
      status: row.status,
      validationStatus: row.validation_status,
      validationError: row.validation_error ?? undefined,
      referencedWorkflows: Array.isArray(row.referenced_workflows)
        ? row.referenced_workflows
        : [],
      processedAt: fromUnknownDate(row.processed_at)
    } as ScannerWorkflowRunRecord;
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
    if (!vectors.length) return;
    const values: unknown[] = [];
    const rows: string[] = [];
    const usePgvector = this.repositoryIndexStorageMode === "pgvector";
    for (const vector of vectors) {
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
      const base = values.length - 10;
      const vectorLiteralPosition = base + 11;
      if (usePgvector) {
        values.push(vectorLiteral(vector.vector));
        rows.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${vectorLiteralPosition}::vector)`
        );
      } else {
        rows.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`);
      }
    }
    const query = usePgvector
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
    await client.query(query, values);
  }
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
