import { Pool } from "pg";

export type RepositoryLifecycleState = "active" | "suspended" | "removed";
export type WebhookJobStatus = "pending" | "leased" | "succeeded" | "dead-letter";

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
}

export interface ReviewState {
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  placeholderCommentId?: number;
  findings: Array<{ fingerprint: string; state: "open" | "resolved" | "superseded" }>;
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
  upsertRepository(record: RepositoryRecord): Promise<void>;
  getRepository(repositoryId: number): Promise<RepositoryRecord | undefined>;
  setRepositoryState(repositoryId: number, state: RepositoryLifecycleState): Promise<void>;
  setInstallationState(installationId: number, state: RepositoryLifecycleState): Promise<void>;
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

  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async upsertRepository(record: RepositoryRecord) {
    this.repositories.set(record.repositoryId, { ...record });
  }

  async getRepository(id: number) {
    const repository = this.repositories.get(id);
    return repository ? { ...repository } : undefined;
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
}

export class PostgresStore implements Store {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, application_name: "guardianbot-control-plane" });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE repositories ADD COLUMN IF NOT EXISTS repository_state TEXT NOT NULL DEFAULT 'active';

      CREATE TABLE IF NOT EXISTS reviews (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id),
        pull_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        placeholder_comment_id BIGINT,
        findings JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, pull_number)
      );

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
    `);
  }

  async upsertRepository(record: RepositoryRecord) {
    await this.pool.query(
      `INSERT INTO repositories
       (repository_id, installation_id, full_name, visibility, default_branch, index_sha, index_updated_at, scanner_state, repository_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (repository_id) DO UPDATE SET
       installation_id=excluded.installation_id, full_name=excluded.full_name,
       visibility=excluded.visibility, default_branch=excluded.default_branch,
       index_sha=excluded.index_sha, index_updated_at=excluded.index_updated_at,
       scanner_state=excluded.scanner_state, repository_state=excluded.repository_state, updated_at=now()`,
      [
        record.repositoryId,
        record.installationId,
        record.fullName,
        record.visibility,
        record.defaultBranch,
        record.indexSha,
        record.indexUpdatedAt,
        record.scannerState,
        record.repositoryState
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
      repositoryState: row.repository_state
    } as RepositoryRecord;
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

  async saveReviewHead(
    repositoryId: number,
    pullNumber: number,
    headSha: string,
    placeholderCommentId?: number
  ) {
    await this.pool.query(
      `INSERT INTO reviews (repository_id,pull_number,head_sha,placeholder_comment_id,findings)
       VALUES ($1,$2,$3,$4,'[]'::jsonb)
       ON CONFLICT (repository_id,pull_number) DO UPDATE SET
       head_sha=excluded.head_sha,
       placeholder_comment_id=COALESCE(excluded.placeholder_comment_id, reviews.placeholder_comment_id),
       updated_at=now()`,
      [repositoryId, pullNumber, headSha, placeholderCommentId]
    );
  }

  async saveReview(state: ReviewState, expectedHeadSha?: string) {
    const result = await this.pool.query(
      `INSERT INTO reviews (repository_id,pull_number,head_sha,placeholder_comment_id,findings)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (repository_id,pull_number) DO UPDATE SET
       head_sha=excluded.head_sha,
       placeholder_comment_id=excluded.placeholder_comment_id,
       findings=excluded.findings,
       updated_at=now()
       WHERE $6::text IS NULL OR reviews.head_sha=$6`,
      [
        state.repositoryId,
        state.pullNumber,
        state.headSha,
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
}
