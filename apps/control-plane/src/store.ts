import { Pool } from "pg";

export interface RepositoryRecord {
  installationId: number;
  repositoryId: number;
  fullName: string;
  visibility: string;
  defaultBranch: string;
  indexSha?: string;
  indexUpdatedAt?: string;
  scannerState: "not-configured" | "report-only" | "enforced";
}

export interface ReviewState {
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  placeholderCommentId?: number;
  findings: Array<{ fingerprint: string; state: "open" | "resolved" | "superseded" }>;
}

export interface Store {
  upsertRepository(record: RepositoryRecord): Promise<void>;
  getRepository(repositoryId: number): Promise<RepositoryRecord | undefined>;
  saveReview(state: ReviewState): Promise<void>;
  getReview(repositoryId: number, pullNumber: number): Promise<ReviewState | undefined>;
}

export class MemoryStore implements Store {
  private repositories = new Map<number, RepositoryRecord>();
  private reviews = new Map<string, ReviewState>();
  async upsertRepository(record: RepositoryRecord) { this.repositories.set(record.repositoryId, record); }
  async getRepository(id: number) { return this.repositories.get(id); }
  async saveReview(state: ReviewState) { this.reviews.set(`${state.repositoryId}:${state.pullNumber}`, state); }
  async getReview(id: number, pull: number) { return this.reviews.get(`${id}:${pull}`); }
}

export class PostgresStore implements Store {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, application_name: "guardianbot-control-plane" });
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS reviews (
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id),
        pull_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        placeholder_comment_id BIGINT,
        findings JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repository_id, pull_number)
      );
    `);
  }
  async upsertRepository(record: RepositoryRecord) {
    await this.pool.query(
      `INSERT INTO repositories
       (repository_id, installation_id, full_name, visibility, default_branch, index_sha, index_updated_at, scanner_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (repository_id) DO UPDATE SET
       installation_id=excluded.installation_id, full_name=excluded.full_name,
       visibility=excluded.visibility, default_branch=excluded.default_branch,
       index_sha=excluded.index_sha, index_updated_at=excluded.index_updated_at,
       scanner_state=excluded.scanner_state, updated_at=now()`,
      [record.repositoryId, record.installationId, record.fullName, record.visibility,
        record.defaultBranch, record.indexSha, record.indexUpdatedAt, record.scannerState]
    );
  }
  async getRepository(id: number) {
    const result = await this.pool.query("SELECT * FROM repositories WHERE repository_id=$1", [id]);
    if (!result.rows[0]) return undefined;
    const row = result.rows[0];
    return {
      repositoryId: Number(row.repository_id), installationId: Number(row.installation_id),
      fullName: row.full_name, visibility: row.visibility, defaultBranch: row.default_branch,
      indexSha: row.index_sha ?? undefined, indexUpdatedAt: row.index_updated_at?.toISOString(),
      scannerState: row.scanner_state
    } as RepositoryRecord;
  }
  async saveReview(state: ReviewState) {
    await this.pool.query(
      `INSERT INTO reviews (repository_id,pull_number,head_sha,placeholder_comment_id,findings)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (repository_id,pull_number) DO UPDATE SET
       head_sha=excluded.head_sha, placeholder_comment_id=excluded.placeholder_comment_id,
       findings=excluded.findings, updated_at=now()`,
      [state.repositoryId, state.pullNumber, state.headSha, state.placeholderCommentId, JSON.stringify(state.findings)]
    );
  }
  async getReview(id: number, pull: number) {
    const result = await this.pool.query(
      "SELECT * FROM reviews WHERE repository_id=$1 AND pull_number=$2", [id, pull]
    );
    if (!result.rows[0]) return undefined;
    const row = result.rows[0];
    return {
      repositoryId: Number(row.repository_id), pullNumber: row.pull_number,
      headSha: row.head_sha, placeholderCommentId: row.placeholder_comment_id
        ? Number(row.placeholder_comment_id) : undefined,
      findings: row.findings
    } as ReviewState;
  }
}
