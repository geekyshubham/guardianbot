import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  assertDescriptorReference,
  assertIndexReference,
  compareCallEdges,
  compareRecordRows,
  cosineSimilarity,
  normalizeCommitSha,
  normalizeRepositoryPath,
  repositoryIndexStorageKey,
  toPersistedCallEdges,
  toPersistedRecordRows
} from "@guardianbot/core";
import type {
  IndexEmbeddingMetadata,
  PersistedCallEdge,
  PersistedPathRecordRow,
  PersistedRecordRow,
  PersistedVectorRow,
  RepositoryCallEdgeQuery,
  RepositoryCallEdgeQueryResult,
  RepositoryIndex,
  RepositoryIndexDescriptor,
  RepositoryIndexVectorDelta,
  RepositoryPathRecordQuery,
  RepositoryPathRecordQueryResult,
  RepositoryRecordHydrationRequest,
  RepositoryRecordReference,
  RepositoryVectorMatch,
  RepositoryVectorQuery
} from "@guardianbot/core";
import type {
  MonitoringStatus,
  RepositoryInventoryState,
  WeeklyCoverageReport
} from "@guardianbot/monitoring";

export type RepositoryLifecycleState = "active" | "suspended" | "removed";
export type WebhookJobStatus = "pending" | "leased" | "succeeded" | "dead-letter";
export type RepositoryIndexStorageMode = "memory" | "pgvector" | "json-array-fallback";

/**
 * How retrieval is actually being served, as opposed to how it was configured.
 *
 * The storage mode alone cannot distinguish a healthy pgvector install from one
 * where the ANN index is absent and every read is an exact scan, which is exactly
 * the state a failed or skipped index build leaves behind. Reporting readiness
 * beside the mode makes under-indexing visible instead of merely slow.
 */
export interface RepositoryIndexRetrievalStatus {
  mode: RepositoryIndexStorageMode;
  /** True only when the dimensioned column and its ANN index both exist. */
  approximateIndexReady: boolean;
  /**
   * Rows with no durable vector, counted at migration time. Non-zero means those
   * rows are served by the in-memory fallback rather than the database, so a
   * persistent non-zero value is a signal, not noise. Null when not measured,
   * so a scraper never reads "unknown" as "none".
   */
  uncoveredDurableVectorRows: number | null;
}

// Fixed two-int32 namespace/key pair for the database-wide monitoring scheduler lock.
const MONITORING_LOCK_NAMESPACE = 1_196_572_738;
const MONITORING_LOCK_KEY = 1_297_046_866;
const ONBOARDING_ISSUE_LOCK_NAMESPACE = 1_196_572_739;
// Fixed two-int32 namespace/key pair serialising schema migrations across booting instances.
const MIGRATION_LOCK_NAMESPACE = 1_196_572_740;
const MIGRATION_LOCK_KEY = 1_297_046_867;
// Bounds on the migration session. `migrate()` runs inside `createStore()`, before the server
// opens a port, so every wait it performs must be finite: a peer instance holding the lock with a
// wedged session, or a slow reader queued ahead of an ACCESS EXCLUSIVE `ALTER TABLE reviews`,
// must surface as a boot failure with a named error rather than as a silent hang.
/**
 * Dimension of the ANN-indexed vector column.
 *
 * pgvector can only build an ivfflat/hnsw index on a column declared with a
 * fixed dimension, but the embedding dimension is a runtime property of the
 * configured provider, not a compile-time constant: `indexRepositorySyntaxAware`
 * defaults to `LexicalHashEmbeddingProvider`, whose default width is 96 and whose
 * constructor accepts 8-4096. So the dimension is knowable for the production
 * path and only for the production path.
 *
 * Rather than assume, the schema keeps both columns. `vector_pgvector` stays
 * undimensioned and accepts any provider's output, and `vector_ann` is the
 * dimensioned, ANN-indexed column written only when a row's own `dimensions`
 * equals this value. A provider reconfigured to another width therefore keeps
 * working through an exact scan instead of failing an insert, and re-widening the
 * ANN column later is another additive migration.
 */
const INDEXED_VECTOR_ANN_DIMENSIONS = 96;
/**
 * Row ceiling for one boot's ANN backfill. Deliberately a different number from
 * `ANN_INDEX_INLINE_BUILD_MAX_ROWS`: sharing one constant put the worst case
 * exactly on the inline-build boundary, so a saturating backfill was followed by
 * an inline index build over the whole backfilled set.
 */
const ANN_BACKFILL_MAX_ROWS = 50_000;
/**
 * Rows per backfill statement. The cap above is spent in batches of this size so
 * no single `UPDATE` has to finish inside `MIGRATION_STATEMENT_TIMEOUT_MS`, and
 * so the loop can stop as soon as a statement reports fewer rows than it asked
 * for, which is the only signal available that the predicate has been drained.
 */
const ANN_BACKFILL_BATCH_ROWS = 5_000;
/**
 * Row ceiling for building the ANN index inline during migration. `CREATE INDEX`
 * takes ACCESS EXCLUSIVE on the table, and `migrate()` runs before the port
 * opens, so building over a large live table would stall boot and block reads
 * meanwhile. An hnsw build is the expensive one in pgvector, so this ceiling sits
 * far below the backfill cap: at or above it the index is left for an operator to
 * build with `CREATE INDEX CONCURRENTLY` out of band, which is the normal path
 * for any table that is not effectively empty. Queries stay correct either way
 * because the ANN index only changes their cost, never their result.
 */
const ANN_INDEX_INLINE_BUILD_MAX_ROWS = 2_000;
const MIGRATION_LOCK_TIMEOUT_MS = 10_000;
const MIGRATION_STATEMENT_TIMEOUT_MS = 120_000;
const MIGRATION_LOCK_ATTEMPTS = 30;
const MIGRATION_LOCK_RETRY_DELAY_MS = 1_000;

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

/**
 * Lifecycle state of one content-addressed finding. `open` is the only active state; the
 * other two are terminal and are the only states eviction may ever drop. The union stays at
 * three values deliberately: a fourth would be unreadable to an instance running older code
 * mid-deploy, so a finding that returns after a terminal state is recorded through
 * `reappearances` provenance rather than through a new state value.
 */
export type ReviewFindingLifecycleState = "open" | "resolved" | "superseded";

/**
 * Durable provenance for one finding. Every field is optional because rows written before the
 * provenance migration — and rows written by an older instance mid-deploy — carry only
 * `fingerprint` and `state`. Presentation degrades to the fingerprint alone rather than failing.
 */
export interface ReviewFindingProvenance {
  /** Head SHA the finding was first observed at. */
  firstSeenHeadSha?: string;
  /** Head SHA the finding was most recently observed or re-evaluated at. */
  lastSeenHeadSha?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** Number of lifecycle state changes observed for this fingerprint. */
  transitions?: number;
  /** Number of times the finding returned to `open` after reaching a terminal state. */
  reappearances?: number;
  /** Finding identity, retained so a resolved finding renders without re-running the model. */
  path?: string;
  startLine?: number;
  endLine?: number;
  category?: string;
  severity?: string;
  title?: string;
  /**
   * Derived reviewer-engagement signal: how many human review comments have been observed
   * replying to this advisory. Deliberately a count and two timestamps rather than anything
   * about who replied or what they said — whether a human engaged, and when relative to the
   * finding's own lifecycle, is the whole analytic value, and reviewer identity and comment
   * text are not needed to obtain it.
   */
  feedbackCount?: number;
  feedbackFirstAt?: string;
  feedbackLastAt?: string;
  /**
   * Bounded ring of the review-comment identifiers already counted, newest last. A webhook
   * delivery can be retried after a mid-flight failure, so counting without this would inflate
   * the signal on redelivery. These are opaque comment identifiers, never reviewer identities,
   * and the ring is capped at `MAX_FEEDBACK_COMMENT_IDS` so the row cannot grow without bound.
   */
  feedbackCommentIds?: number[];
}

export interface ReviewFindingRecord extends ReviewFindingProvenance {
  fingerprint: string;
  state: ReviewFindingLifecycleState;
}

export interface ReviewState {
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  reviewedHeadSha?: string;
  placeholderCommentId?: number;
  findings: ReviewFindingRecord[];
  /**
   * Records which code revision last wrote the findings column, as an operator signal only. It
   * is not a guarantee about any individual finding's provenance in either direction: an older
   * instance rewriting this row leaves the column at its previous value because that instance's
   * upsert does not assign it, and a row created by `saveReviewHead` takes the column default
   * even though the writer is provenance-capable. Readers treat provenance as optional at every
   * version and revalidate each finding.
   */
  findingsSchemaVersion?: number;
  /**
   * LIFETIME TOTAL of terminal findings dropped from this record by eviction, as returned by
   * `getReview`. This is not the value `saveReview` accepts: there the same field name carries a
   * per-write DELTA. See `ReviewStateWrite.findingsEvictedTotal`.
   */
  findingsEvictedTotal?: number;
  findingsLastEvictedAt?: string;
  /**
   * LIFETIME TOTAL of human engagements recorded against this pull request's advisories, as
   * returned by `getReview`. As with `findingsEvictedTotal`, `saveReview` takes a per-write DELTA
   * in the same field name. See `ReviewStateWrite.feedbackTotal`.
   */
  feedbackTotal?: number;
}

/**
 * The shape `saveReview` accepts, which differs from the shape `getReview` returns in one
 * dangerous way: the two counters are DELTAS here and LIFETIME TOTALS there.
 *
 * Both stores add the supplied value to the stored counter rather than assigning it, because the
 * counter has to be server-authoritative — a writer that never read the row must not be able to
 * reset a total it does not know, and the head-SHA CAS does not guard against that. The cost is
 * that read and write are not symmetric, and feeding a value straight from `getReview` back into
 * `saveReview` compounds it. That is not hypothetical: it is the bug this asymmetry already caused
 * once, so the two directions are named apart here even though they are structurally identical and
 * TypeScript cannot reject the mistake for us.
 *
 * Pass the increment this write is responsible for — typically `lifecycle.evicted` — or omit the
 * field entirely. Never pass a value that was read from the store.
 */
/**
 * Binds a review write to the webhook lease that authorised it.
 *
 * The head-SHA compare-and-set alone cannot separate two workers running the *same* delivery:
 * both derive `expectedHeadSha` from the same payload, so the predicate holds for both and both
 * commit. Because the row's counters are accumulated server-side (`findings_evicted_total`,
 * `feedback_total` are incremented, not assigned), a duplicated commit inflates lifetime totals
 * rather than merely repeating itself. Naming the lease in the predicate closes that gap: a
 * worker whose lease lapsed and was reclaimed by another instance fails the fence and writes
 * nothing, so only the current lease holder can publish.
 */
export interface WebhookLeaseFence {
  deliveryId: string;
  /** Must still match `webhook_jobs.lease_owner`, and the lease must not have expired. */
  leaseOwner: string;
  /**
   * Instant the expiry is judged against, as ISO-8601. Supplied by the caller so it comes from the
   * same clock that minted the lease in `claimWebhook`; reading wall time here instead would make
   * every lease look expired under an injected test clock.
   */
  asOf?: string;
}

export interface ReviewStateWrite extends Omit<ReviewState, "findingsEvictedTotal" | "feedbackTotal"> {
  /** DELTA: terminal findings this write evicted. Added to the stored lifetime total. */
  findingsEvictedTotal?: number;
  /** DELTA: engagements this write observed. Added to the stored lifetime total. */
  feedbackTotal?: number;
}

/** Provenance-bearing findings written by this revision. */
export const REVIEW_FINDINGS_SCHEMA_VERSION = 2;

/**
 * The schema version a row carries when nothing ever assigned one: the PostgreSQL column default
 * for `findings_schema_version`, meaning "written before provenance existed, trust nothing". Both
 * stores use it so a row created by `saveReviewHead` reports the same version from either, and a
 * MemoryStore-backed test is evidence about production rather than about MemoryStore.
 */
export const REVIEW_FINDINGS_SCHEMA_VERSION_DEFAULT = 1;

/**
 * Ceiling on the per-finding ring of already-counted review-comment identifiers. The ring exists
 * only to make counting idempotent under webhook redelivery, so it needs to cover the retry
 * window rather than the whole conversation: once it rolls over, the oldest identifiers are
 * forgotten and a redelivery older than the ring could recount, which is strictly preferable to
 * letting a busy advisory thread grow the retained row without bound.
 */
export const MAX_FEEDBACK_COMMENT_IDS = 20;

const REVIEW_FINDING_STATES: readonly ReviewFindingLifecycleState[] = [
  "open",
  "resolved",
  "superseded"
];

function optionalText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\u0000/g, "").trim();
  return text ? text.slice(0, maximum) : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Normalizes one stored finding at the JSONB boundary. The column is schemaless, so a row may
 * predate the provenance migration or have been written by an older instance; a value that
 * cannot be trusted is dropped rather than surfaced to rendering as an unchecked string.
 */
export function normalizeReviewFinding(value: unknown): ReviewFindingRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const fingerprint = optionalText(raw.fingerprint, 128);
  if (!fingerprint) return undefined;
  const state = REVIEW_FINDING_STATES.find((candidate) => candidate === raw.state);
  if (!state) return undefined;
  return {
    fingerprint,
    state,
    firstSeenHeadSha: optionalText(raw.firstSeenHeadSha, 64),
    lastSeenHeadSha: optionalText(raw.lastSeenHeadSha, 64),
    firstSeenAt: optionalTimestamp(raw.firstSeenAt),
    lastSeenAt: optionalTimestamp(raw.lastSeenAt),
    transitions: optionalCount(raw.transitions),
    reappearances: optionalCount(raw.reappearances),
    path: optionalText(raw.path, 400),
    startLine: optionalCount(raw.startLine),
    endLine: optionalCount(raw.endLine),
    category: optionalText(raw.category, 64),
    severity: optionalText(raw.severity, 8),
    title: optionalText(raw.title, 300),
    ...feedbackProvenance(raw)
  };
}

/**
 * Reads the derived feedback signal, omitting it entirely when nothing was recorded. A finding no
 * human has engaged with therefore normalizes to exactly the record it did before feedback capture
 * existed, and the retained JSON does not grow a dead field on every finding — which is the common
 * case, and the only case on an installation without the review-comment event subscribed.
 *
 * The count is authoritative: the identifier ring exists only to dedupe counted comments, so
 * without a count there is nothing it could be deduping and it is dropped with the rest.
 */
function feedbackProvenance(raw: Record<string, unknown>): Partial<ReviewFindingProvenance> {
  const feedbackCount = optionalCount(raw.feedbackCount);
  if (!feedbackCount) return {};
  return {
    feedbackCount,
    feedbackFirstAt: optionalTimestamp(raw.feedbackFirstAt),
    feedbackLastAt: optionalTimestamp(raw.feedbackLastAt),
    feedbackCommentIds: optionalCommentIds(raw.feedbackCommentIds)
  };
}

/**
 * Normalizes the counted-comment ring at the JSONB boundary. The column is schemaless, so the
 * ring is re-bounded on every read rather than trusted: a row written by a future revision with
 * a larger ceiling must not be able to grow this instance's rows past the ceiling it enforces.
 */
function optionalCommentIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identifiers = value
    .filter(
      (entry): entry is number =>
        typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0
    )
    .slice(-MAX_FEEDBACK_COMMENT_IDS);
  return identifiers.length ? identifiers : undefined;
}

/**
 * One human engagement observed against a published advisory. Scoped by repository and pull
 * request, so the update can only ever touch the review record that owns the advisory: a marker
 * digest is content-addressed and therefore identical across repositories for identical findings,
 * and these predicates are what stop one repository's reviewer activity landing on another's row.
 */
export interface FindingFeedbackInput {
  repositoryId: number;
  pullNumber: number;
  fingerprint: string;
  /** Opaque review-comment identifier, retained only to make redelivery idempotent. */
  commentId: number;
  observedAt: Date;
}

export interface ApplyFindingFeedbackResult {
  findings: ReviewFindingRecord[];
  /** True only when this call moved the signal, so a caller never counts a no-op delivery. */
  recorded: boolean;
}

/**
 * Records one human engagement against the lifecycle record for `fingerprint`. Kept pure and
 * exported so the whole decision — including the idempotency and bounding rules — is testable
 * without a server.
 *
 * Nothing is recorded when the fingerprint is not retained: the finding may have been evicted, or
 * the marker may belong to another repository's advisory, and inventing a record for either would
 * report engagement against a finding this review never had. A comment identifier already in the
 * ring is likewise not recorded, so a redelivered webhook cannot inflate the count.
 */
export function applyFindingFeedback(
  findings: readonly ReviewFindingRecord[],
  fingerprint: string,
  commentId: number,
  observedAt: Date
): ApplyFindingFeedbackResult {
  const index = findings.findIndex((finding) => finding.fingerprint === fingerprint);
  if (index === -1) return { findings: findings.map((finding) => ({ ...finding })), recorded: false };
  const target = findings[index] as ReviewFindingRecord;
  const counted = target.feedbackCommentIds ?? [];
  if (counted.includes(commentId)) {
    return { findings: findings.map((finding) => ({ ...finding })), recorded: false };
  }
  const observedIso = observedAt.toISOString();
  const updated: ReviewFindingRecord = {
    ...target,
    feedbackCount: (target.feedbackCount ?? 0) + 1,
    feedbackFirstAt: target.feedbackFirstAt ?? observedIso,
    feedbackLastAt: observedIso,
    // Newest last, oldest dropped: the ring covers the redelivery window, not the conversation.
    feedbackCommentIds: [...counted, commentId].slice(-MAX_FEEDBACK_COMMENT_IDS)
  };
  return {
    findings: findings.map((finding, position) =>
      position === index ? updated : { ...finding }
    ),
    recorded: true
  };
}

export function normalizeReviewFindings(value: unknown): ReviewFindingRecord[] {
  return Array.isArray(value)
    ? value
        .map((entry) => normalizeReviewFinding(entry))
        .filter((entry): entry is ReviewFindingRecord => Boolean(entry))
    : [];
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
  updatedAt?: string;
}

/** Authoritative per-status webhook queue gauges from the shared store. */
export interface WebhookQueueCounts {
  /** Jobs with status pending (including not-yet-available retries). */
  pending: number;
  /** Jobs currently marked leased (including expired leases not yet reclaimed). */
  leased: number;
  /** Jobs in dead-letter. */
  deadLetter: number;
  /**
   * Currently runnable backlog: pending jobs with available_at <= now plus
   * leased jobs whose lease has expired (or has no expiry).
   */
  runnable: number;
}

export interface PurgeTerminalWebhookJobsOptions {
  succeededBefore: Date;
  deadLetterBefore: Date;
  limit: number;
  now?: Date;
}

export interface PurgeTerminalWebhookJobsResult {
  deleted: number;
}

/**
 * Placeholder logins substituted for a real reviewer login before a review-comment delivery is
 * persisted. `captureReviewCommentFeedback` reads the author login for exactly one bit — is this a
 * bot replying to itself, or a human? — by testing the `[bot]` suffix, so that bit is all the queue
 * needs to carry. Preserving the suffix semantics keeps the handler's decision byte-identical
 * while no reviewer identity is written to the database.
 */
const SCRUBBED_BOT_LOGIN = "scrubbed[bot]";
const SCRUBBED_HUMAN_LOGIN = "scrubbed";

/**
 * Strips personal data from a webhook payload before it is persisted.
 *
 * `webhook_jobs.payload` is a durable JSONB column, so anything left in it is retained for the
 * whole succeeded/dead-letter window — days, not the milliseconds a delivery takes to process.
 * A `pull_request_review_comment` body is raw reviewer prose and its author login is reviewer
 * identity, and the reviewer-feedback path deliberately retains neither: it keeps only a derived
 * signal. Persisting the delivery unfiltered would put both in the database anyway, behind the
 * bounded store that is supposed to be the only retention point.
 *
 * The reduction is an allowlist rather than a blacklist, so a field GitHub adds later cannot
 * silently reintroduce free text. It is deliberately scoped to this one event: `issue_comment`
 * carries the slash command in `comment.body` and authorizes it by `comment.user.login`, so those
 * fields are load-bearing there and every other event is persisted unchanged.
 *
 * The kept fields are exactly the ones `captureReviewCommentFeedback` and the dispatcher read.
 * Anything a future handler needs for this event must be added here as well, or it will not be
 * present when the job is claimed.
 */
export function scrubWebhookPayloadForRetention(
  eventName: string,
  payload: Record<string, any>
): Record<string, any> {
  if (eventName !== "pull_request_review_comment") return payload;
  const comment = payload.comment;
  const login = typeof comment?.user?.login === "string" ? comment.user.login : undefined;
  return {
    action: payload.action,
    ...(comment && typeof comment === "object"
      ? {
          comment: {
            id: comment.id,
            in_reply_to_id: comment.in_reply_to_id,
            ...(login === undefined
              ? {}
              : {
                  user: {
                    login: login.endsWith("[bot]") ? SCRUBBED_BOT_LOGIN : SCRUBBED_HUMAN_LOGIN
                  }
                })
          }
        }
      : {}),
    ...(payload.pull_request && typeof payload.pull_request === "object"
      ? { pull_request: { number: payload.pull_request.number } }
      : {}),
    ...(payload.repository && typeof payload.repository === "object"
      ? { repository: { id: payload.repository.id, full_name: payload.repository.full_name } }
      : {}),
    ...(payload.installation && typeof payload.installation === "object"
      ? { installation: { id: payload.installation.id } }
      : {})
  };
}

export const DEFAULT_WEBHOOK_SUCCEEDED_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_WEBHOOK_DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_WEBHOOK_CLEANUP_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_WEBHOOK_CLEANUP_BATCH_LIMIT = 1000;
export const MIN_WEBHOOK_RETENTION_MS = 60 * 60_000;
export const MAX_WEBHOOK_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const MIN_WEBHOOK_CLEANUP_INTERVAL_MS = 60_000;
export const MAX_WEBHOOK_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
export const MIN_WEBHOOK_CLEANUP_BATCH_LIMIT = 1;
export const MAX_WEBHOOK_CLEANUP_BATCH_LIMIT = 10_000;

export interface WebhookRetentionOptions {
  succeededRetentionMs: number;
  deadLetterRetentionMs: number;
  cleanupIntervalMs: number;
  batchLimit: number;
}

function parsePositiveBoundedInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function webhookRetentionOptionsFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): WebhookRetentionOptions {
  const options: WebhookRetentionOptions = {
    succeededRetentionMs: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS,
      "GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS",
      DEFAULT_WEBHOOK_SUCCEEDED_RETENTION_MS,
      MIN_WEBHOOK_RETENTION_MS,
      MAX_WEBHOOK_RETENTION_MS
    ),
    deadLetterRetentionMs: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS,
      "GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS",
      DEFAULT_WEBHOOK_DEAD_LETTER_RETENTION_MS,
      MIN_WEBHOOK_RETENTION_MS,
      MAX_WEBHOOK_RETENTION_MS
    ),
    cleanupIntervalMs: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_WEBHOOK_CLEANUP_INTERVAL_MS,
      "GUARDIANBOT_WEBHOOK_CLEANUP_INTERVAL_MS",
      DEFAULT_WEBHOOK_CLEANUP_INTERVAL_MS,
      MIN_WEBHOOK_CLEANUP_INTERVAL_MS,
      MAX_WEBHOOK_CLEANUP_INTERVAL_MS
    ),
    batchLimit: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_WEBHOOK_CLEANUP_BATCH_LIMIT,
      "GUARDIANBOT_WEBHOOK_CLEANUP_BATCH_LIMIT",
      DEFAULT_WEBHOOK_CLEANUP_BATCH_LIMIT,
      MIN_WEBHOOK_CLEANUP_BATCH_LIMIT,
      MAX_WEBHOOK_CLEANUP_BATCH_LIMIT
    )
  };
  if (options.deadLetterRetentionMs < options.succeededRetentionMs) {
    throw new Error(
      "GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS must be greater than or equal to GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS"
    );
  }
  return options;
}

/** Shared API guard so purge limits cannot bypass env bounds when called directly. */
export function assertWebhookPurgeLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < MIN_WEBHOOK_CLEANUP_BATCH_LIMIT ||
    limit > MAX_WEBHOOK_CLEANUP_BATCH_LIMIT
  ) {
    throw new Error(
      `purge limit must be a safe integer between ${MIN_WEBHOOK_CLEANUP_BATCH_LIMIT} and ${MAX_WEBHOOK_CLEANUP_BATCH_LIMIT}`
    );
  }
}

export const DEFAULT_REVIEW_FINDING_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const DEFAULT_REVIEW_FINDING_LIMIT = 200;
export const MIN_REVIEW_FINDING_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_REVIEW_FINDING_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const MIN_REVIEW_FINDING_LIMIT = 1;
export const MAX_REVIEW_FINDING_LIMIT = 5_000;
export const DEFAULT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const MIN_REVIEW_FINDING_ABSOLUTE_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_REVIEW_FINDING_ABSOLUTE_RETENTION_MS = 5 * 365 * 24 * 60 * 60_000;

export interface ReviewFindingRetentionOptions {
  /** Terminal findings not observed within this window become evictable. */
  retentionMs: number;
  /** Soft cap on retained findings per review record; active findings are never evicted to meet it. */
  limit: number;
  /**
   * Absolute ceiling on how long any finding is retained, open ones included, measured from when
   * it was first seen rather than last observed.
   *
   * `retentionMs` alone bounds only terminal findings, on the theory that an open finding is live
   * advisory state whose retention is justified by still being reported. That justification has a
   * floor: a pull request can stay open and unreviewed indefinitely, and the finding's engagement
   * signal — a bounded ring of review-comment identifiers, which are personal data — would be
   * retained with it for as long as the row exists. This bounds that.
   *
   * Left undefined the absolute pass is skipped entirely, so a caller that has not opted in keeps
   * the previous liveness-only behaviour. `reviewFindingRetentionOptionsFromEnvironment` always
   * supplies it, so every configured path is bounded.
   */
  absoluteRetentionMs?: number;
}

export function reviewFindingRetentionOptionsFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): ReviewFindingRetentionOptions {
  return {
    retentionMs: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_REVIEW_FINDING_RETENTION_MS,
      "GUARDIANBOT_REVIEW_FINDING_RETENTION_MS",
      DEFAULT_REVIEW_FINDING_RETENTION_MS,
      MIN_REVIEW_FINDING_RETENTION_MS,
      MAX_REVIEW_FINDING_RETENTION_MS
    ),
    limit: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_REVIEW_FINDING_LIMIT,
      "GUARDIANBOT_REVIEW_FINDING_LIMIT",
      DEFAULT_REVIEW_FINDING_LIMIT,
      MIN_REVIEW_FINDING_LIMIT,
      MAX_REVIEW_FINDING_LIMIT
    ),
    absoluteRetentionMs: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS,
      "GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS",
      DEFAULT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS,
      MIN_REVIEW_FINDING_ABSOLUTE_RETENTION_MS,
      MAX_REVIEW_FINDING_ABSOLUTE_RETENTION_MS
    )
  };
}

export interface EvictReviewFindingsResult {
  findings: ReviewFindingRecord[];
  evicted: number;
}

/**
 * Bounds a review record's retained findings. Only terminal states are ever evictable: an
 * `open` finding is live advisory state whose loss would silently re-report as a new finding
 * and would break resolved-versus-superseded discrimination on the next head, so it is
 * retained even when that holds the record above `limit`. Terminal findings are dropped
 * oldest-observed first, by age past `retentionMs` and then to bring the record back to the cap.
 *
 * `absoluteRetentionMs`, when supplied, is the one rule that does reach an open finding: liveness
 * justifies retaining live advisory state, but it is not an unbounded licence, so a finding first
 * seen longer ago than the absolute ceiling is dropped whatever its state. That pass runs before
 * anything else, because a record of nothing but open findings has no terminal work to do and must
 * still be bounded.
 */
export function evictTerminalReviewFindings(
  findings: readonly ReviewFindingRecord[],
  options: ReviewFindingRetentionOptions,
  now: Date
): EvictReviewFindingsResult {
  const observedAt = (finding: ReviewFindingRecord): number => {
    const parsed = Date.parse(finding.lastSeenAt ?? finding.firstSeenAt ?? "");
    // Provenance-free rows predate the migration; treating them as observed now keeps them
    // until the cap genuinely needs the room rather than expiring them on first sight.
    return Number.isFinite(parsed) ? parsed : now.getTime();
  };
  // Measured from first sighting, not last: the point of an absolute ceiling is that re-observing
  // a finding cannot extend it, which is exactly what `retentionMs` allows.
  const firstSeenAt = (finding: ReviewFindingRecord): number => {
    const parsed = Date.parse(finding.firstSeenAt ?? "");
    return Number.isFinite(parsed) ? parsed : now.getTime();
  };
  const dropped = new Set<ReviewFindingRecord>();
  if (options.absoluteRetentionMs !== undefined) {
    const absoluteExpiryBefore = now.getTime() - options.absoluteRetentionMs;
    for (const finding of findings) {
      if (firstSeenAt(finding) < absoluteExpiryBefore) dropped.add(finding);
    }
  }
  // Every later pass reasons about what the absolute pass left behind, so its arithmetic reflects
  // the record that will actually be retained.
  const surviving = findings.filter((finding) => !dropped.has(finding));
  const active = surviving.filter((finding) => finding.state === "open");
  const terminal = surviving.filter((finding) => finding.state !== "open");
  if (!terminal.length) {
    return dropped.size
      ? { findings: surviving, evicted: dropped.size }
      : { findings: [...findings], evicted: 0 };
  }

  const expiryBefore = now.getTime() - options.retentionMs;
  const oldestFirst = [...terminal].sort(
    (left, right) =>
      observedAt(left) - observedAt(right) || left.fingerprint.localeCompare(right.fingerprint)
  );
  for (const finding of oldestFirst) {
    if (observedAt(finding) < expiryBefore) dropped.add(finding);
  }
  let terminalDropped = oldestFirst.filter((finding) => dropped.has(finding)).length;
  // Active findings are never evictable to meet the cap, so once they alone exceed it the pass can
  // never satisfy its own break condition: it would drop every terminal finding, discarding all
  // their provenance, and still leave the record above the limit. Nothing is gained, so the pass is
  // skipped and only what the retention window already expired stays dropped. At the cap exactly
  // the limit is still reachable, so the pass runs.
  if (active.length <= options.limit) {
    for (const finding of oldestFirst) {
      if (active.length + (terminal.length - terminalDropped) <= options.limit) break;
      if (dropped.has(finding)) continue;
      dropped.add(finding);
      terminalDropped += 1;
    }
  }
  if (!dropped.size) return { findings: [...findings], evicted: 0 };
  return {
    findings: findings.filter((finding) => !dropped.has(finding)),
    evicted: dropped.size
  };
}

export const DEFAULT_INDEX_GENERATION_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_INDEX_GENERATION_SWEEP_BATCH_LIMIT = 200;
export const MIN_INDEX_GENERATION_RETENTION_MS = 60 * 60_000;
export const MAX_INDEX_GENERATION_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const MIN_INDEX_GENERATION_SWEEP_BATCH_LIMIT = 1;
export const MAX_INDEX_GENERATION_SWEEP_BATCH_LIMIT = 5_000;

/**
 * Retention for superseded index generations.
 *
 * A storage key is commit-scoped, so every refresh publishes a whole new
 * generation and nothing ever removed the old one: the table grew at roughly
 * symbols per commit times commits indexed. Carrying a second durable vector copy
 * per row plus an ANN index over it makes that growth materially more expensive,
 * so superseded generations are swept on a bound.
 */
export interface IndexGenerationRetentionOptions {
  /** Generations older than this and no longer current become sweepable. */
  retentionMs: number;
  /** Generations removed per sweep, so one run cannot lock the table open. */
  batchLimit: number;
}

export function indexGenerationRetentionOptionsFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): IndexGenerationRetentionOptions {
  return {
    retentionMs: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_INDEX_GENERATION_RETENTION_MS,
      "GUARDIANBOT_INDEX_GENERATION_RETENTION_MS",
      DEFAULT_INDEX_GENERATION_RETENTION_MS,
      MIN_INDEX_GENERATION_RETENTION_MS,
      MAX_INDEX_GENERATION_RETENTION_MS
    ),
    batchLimit: parsePositiveBoundedInteger(
      environment.GUARDIANBOT_INDEX_GENERATION_SWEEP_BATCH_LIMIT,
      "GUARDIANBOT_INDEX_GENERATION_SWEEP_BATCH_LIMIT",
      DEFAULT_INDEX_GENERATION_SWEEP_BATCH_LIMIT,
      MIN_INDEX_GENERATION_SWEEP_BATCH_LIMIT,
      MAX_INDEX_GENERATION_SWEEP_BATCH_LIMIT
    )
  };
}

export interface PurgeSupersededIndexGenerationsOptions {
  supersededBefore: Date;
  limit: number;
}

export interface PurgeSupersededIndexGenerationsResult {
  deleted: number;
}

/** Shared API guard so sweep limits cannot bypass env bounds when called directly. */
export function assertIndexGenerationSweepLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < MIN_INDEX_GENERATION_SWEEP_BATCH_LIMIT ||
    limit > MAX_INDEX_GENERATION_SWEEP_BATCH_LIMIT
  ) {
    throw new Error(
      `index generation sweep limit must be a safe integer between ${MIN_INDEX_GENERATION_SWEEP_BATCH_LIMIT} and ${MAX_INDEX_GENERATION_SWEEP_BATCH_LIMIT}`
    );
  }
}

/**
 * Parameterized superseded-generation sweep (multi-instance safe via SKIP LOCKED).
 *
 * Deletes the parent `repository_indexes` row, not the vectors directly, because
 * `repository_index_vectors.storage_key` cascades from it: pruning the parent
 * removes the whole generation, vectors and index document together, in one
 * statement.
 *
 * The generation a repository currently points at is never a candidate. The guard
 * is `index_sha IS DISTINCT FROM commit_sha`, not `<>`: a repository with a NULL
 * `index_sha` publishes no current generation, and `NULL <> commit_sha` is NULL
 * rather than true, so a plain inequality would silently protect every generation
 * of exactly those repositories.
 */
export const SUPERSEDED_INDEX_GENERATION_PURGE_SQL = `
WITH candidates AS (
  SELECT indexes.storage_key
  FROM repository_indexes AS indexes
  JOIN repositories AS owner ON owner.repository_id = indexes.repository_id
  WHERE owner.index_sha IS DISTINCT FROM indexes.commit_sha
    AND indexes.updated_at < $1
  ORDER BY indexes.updated_at ASC
  LIMIT $2
  FOR UPDATE OF indexes SKIP LOCKED
)
DELETE FROM repository_indexes AS pruned
USING candidates
WHERE pruned.storage_key = candidates.storage_key
RETURNING pruned.storage_key
`.trim();

/** Parameterized count query shared by PostgresStore (contract for tests). */
export const WEBHOOK_QUEUE_COUNTS_SQL = `
SELECT
  COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
  COUNT(*) FILTER (WHERE status = 'leased')::int AS leased,
  COUNT(*) FILTER (WHERE status = 'dead-letter')::int AS dead_letter,
  COUNT(*) FILTER (
    WHERE (
      status = 'pending'
      AND available_at <= $1
    ) OR (
      status = 'leased'
      AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
    )
  )::int AS runnable
FROM webhook_jobs
`.trim();

/** Parameterized terminal-job purge (multi-instance safe via SKIP LOCKED). */
/**
 * Locks the review record owning an advisory before its feedback is recomputed. Both the
 * repository and the pull-request predicates are load-bearing: a fingerprint marker is
 * content-addressed, so two repositories reviewing identical code carry identical markers, and
 * these predicates are the only thing that keeps one repository's reviewer activity off the
 * other's row. `FOR UPDATE` serialises concurrent deliveries against the same row so a
 * read-modify-write of the schemaless findings column cannot lose an engagement.
 */
export const REVIEW_FEEDBACK_LOCK_SQL = `
SELECT findings
FROM reviews
WHERE repository_id = $1 AND pull_number = $2
FOR UPDATE
`.trim();

/**
 * Writes back the recomputed per-finding feedback and advances the aggregate. The counter is
 * incremented server-side rather than assigned, matching `findings_evicted_total`, so the
 * lifetime total survives eviction of the per-finding records that produced it.
 */
export const REVIEW_FEEDBACK_UPDATE_SQL = `
UPDATE reviews
SET findings = $3::jsonb,
    feedback_total = reviews.feedback_total + 1,
    updated_at = now()
WHERE repository_id = $1 AND pull_number = $2
`.trim();

/**
 * Drops every retained finding for repositories that just left the installation.
 *
 * `evictTerminalReviewFindings` is the only other thing that bounds this column, and it runs only
 * while a review is being published. Once a repository is removed or the App uninstalled nothing
 * is ever published for it again, so no TTL it applies — not even an absolute one — can be reached:
 * the row simply stops being visited. The open findings and their reviewer-engagement rings would
 * be retained for as long as the database exists. Removal is therefore the eviction trigger, and
 * it is unconditional rather than aged: the justification for retaining an open finding is that it
 * is still being reported, and after removal it never will be again.
 *
 * The lifetime evicted counter is advanced by what was actually dropped, so the operator signal
 * stays truthful, and `updated_at` moves because the row genuinely changed. Rows already empty are
 * excluded so a mass uninstall does not rewrite every review row to no effect.
 */
export const REVIEW_FINDINGS_DISCARD_SQL = `
UPDATE reviews
SET findings = '[]'::jsonb,
    findings_evicted_total = reviews.findings_evicted_total + CASE
      WHEN jsonb_typeof(reviews.findings) = 'array' THEN jsonb_array_length(reviews.findings)
      ELSE 0
    END,
    findings_last_evicted_at = now(),
    updated_at = now()
WHERE repository_id = ANY($1::bigint[])
  AND reviews.findings IS NOT NULL
  AND reviews.findings <> '[]'::jsonb
`.trim();

/**
 * The same discard keyed by installation, for an uninstall or a whole-installation suspension.
 * Resolved through `repositories` in one statement rather than by listing repository ids first,
 * so a repository cannot slip between the lookup and the discard.
 */
export const REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL = `
UPDATE reviews
SET findings = '[]'::jsonb,
    findings_evicted_total = reviews.findings_evicted_total + CASE
      WHEN jsonb_typeof(reviews.findings) = 'array' THEN jsonb_array_length(reviews.findings)
      ELSE 0
    END,
    findings_last_evicted_at = now(),
    updated_at = now()
WHERE reviews.repository_id IN (
    SELECT repositories.repository_id
    FROM repositories
    WHERE repositories.installation_id = $1
  )
  AND reviews.findings IS NOT NULL
  AND reviews.findings <> '[]'::jsonb
`.trim();

export const WEBHOOK_TERMINAL_PURGE_SQL = `
WITH candidates AS (
  SELECT delivery_id
  FROM webhook_jobs
  WHERE (
    status = 'succeeded'
    AND updated_at < $1
  ) OR (
    status = 'dead-letter'
    AND COALESCE(dead_lettered_at, updated_at) < $2
  )
  ORDER BY updated_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
DELETE FROM webhook_jobs AS jobs
USING candidates
WHERE jobs.delivery_id = candidates.delivery_id
RETURNING jobs.delivery_id
`.trim();

export interface Store {
  ping(): Promise<void>;
  close(): Promise<void>;
  getRepositoryIndexStorageMode(): Promise<RepositoryIndexStorageMode>;
  getRepositoryIndexRetrievalStatus(): Promise<RepositoryIndexRetrievalStatus>;
  purgeSupersededIndexGenerations(
    options: PurgeSupersededIndexGenerationsOptions
  ): Promise<PurgeSupersededIndexGenerationsResult>;
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
  /**
   * A snapshot's identity without its content, read from columns rather than from
   * the materialised document. It is a second independent witness to the identity
   * the document also carries, so a caller holding both can compare them.
   *
   * It does not narrow the document load on its own: nothing in retrieval consumes
   * it yet.
   */
  getRepositoryIndexDescriptor(
    repositoryId: number,
    commitSha: string
  ): Promise<RepositoryIndexDescriptor | undefined>;
  /**
   * Ranked nearest-neighbour read over one repository's persisted vectors. The
   * canonical storage key derived from `request` is the isolation boundary: it
   * pins both the repository scope and the commit, so no other repository's rows
   * are reachable through this method.
   */
  queryRepositoryIndexVectors(
    repositoryId: number,
    request: RepositoryVectorQuery
  ): Promise<RepositoryVectorMatch[]>;
  /**
   * Bounded content fetch for records named by a nearest-neighbour match. It is
   * what lets retrieval build a candidate without loading the whole index
   * document, and it carries the same isolation boundary as the vector read.
   */
  hydrateRepositoryIndexRecords(
    repositoryId: number,
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedRecordRow[]>;
  /**
   * Vectors for named records of one snapshot. Call-edge reconstruction loads
   * content and vectors separately so a missing vector cannot invent content.
   */
  hydrateRepositoryIndexVectors(
    repositoryId: number,
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedVectorRow[]>;
  /**
   * Exact path-scoped record fetch with a hard limit. Used by descriptor-first
   * review retrieval so changed-path candidates do not depend on ANN recall.
   */
  queryRepositoryIndexRecordsByPath(
    repositoryId: number,
    request: RepositoryPathRecordQuery
  ): Promise<RepositoryPathRecordQueryResult>;
  /**
   * Bounded call-edge fetch for caller/callee reconstruction without the document.
   */
  queryRepositoryIndexCallEdges(
    repositoryId: number,
    request: RepositoryCallEdgeQuery
  ): Promise<RepositoryCallEdgeQueryResult>;
  /**
   * Partial publication beside `replaceRepositoryIndex`. It upserts only changed
   * records and deletes only named ones, so a large repository's unchanged rows
   * are never rewritten.
   */
  applyRepositoryIndexDelta(
    repositoryId: number,
    delta: RepositoryIndexVectorDelta,
    indexedAt?: Date
  ): Promise<void>;
  setRepositoryState(repositoryId: number, state: RepositoryLifecycleState): Promise<void>;
  setInstallationState(installationId: number, state: RepositoryLifecycleState): Promise<void>;
  setAutomaticReviewPaused(repositoryId: number, paused: boolean): Promise<void>;
  saveReviewHead(
    repositoryId: number,
    pullNumber: number,
    headSha: string,
    placeholderCommentId?: number
  ): Promise<void>;
  /**
   * Counters in `state` are per-write deltas, not lifetime totals; see `ReviewStateWrite`.
   *
   * `fence`, when supplied, additionally requires the named webhook lease to still be held and
   * unexpired. `expectedHeadSha` cannot do that job for two workers replaying one delivery, since
   * both compute the same head SHA. See `WebhookLeaseFence`.
   */
  saveReview(
    state: ReviewStateWrite,
    expectedHeadSha?: string,
    fence?: WebhookLeaseFence
  ): Promise<boolean>;
  getReview(repositoryId: number, pullNumber: number): Promise<ReviewState | undefined>;
  recordFindingFeedback(input: FindingFeedbackInput): Promise<boolean>;
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
  countWebhookJobs(now?: Date): Promise<WebhookQueueCounts>;
  purgeTerminalWebhookJobs(
    options: PurgeTerminalWebhookJobsOptions
  ): Promise<PurgeTerminalWebhookJobsResult>;
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
  acquireOnboardingIssueLock(repositoryId: number): Promise<StoreLock>;
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
  private repositoryIndexes = new Map<
    string,
    { repositoryId: number; index: RepositoryIndex; updatedAt: string }
  >();
  private repositoryIndexVectors = new Map<string, PersistedVectorRow[]>();
  private repositoryIndexRecords = new Map<string, Map<string, PersistedRecordRow>>();
  private repositoryIndexEdges = new Map<string, PersistedCallEdge[]>();
  private scannerRuns = new Map<string, ScannerWorkflowRunRecord>();
  private scannerArtifacts = new Map<string, ScannerArtifactRecord>();
  private scannerEvidence = new Map<string, ScannerEvidenceRecord>();
  private monitoringSnapshots = new Map<string, MonitoringSnapshotRecord>();
  private monitoringAlerts = new Map<string, MonitoringAlertRecord>();
  private monitoringWeeklyReports = new Map<string, MonitoringWeeklyReportRecord>();
  private dastSessionIssuances = new Map<string, DastSessionIssuanceRecord>();
  private deploymentPromotions = new Map<string, DeploymentPromotionClaim>();
  private onboardingIssueLocks = new Set<number>();
  private onboardingIssueLockWaiters = new Map<number, Array<() => void>>();
  private monitoringLockHeld = false;

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
  async getRepositoryIndexStorageMode(): Promise<RepositoryIndexStorageMode> {
    return "memory";
  }

  async getRepositoryIndexRetrievalStatus(): Promise<RepositoryIndexRetrievalStatus> {
    // In-memory retrieval always scores every candidate exactly, so there is no
    // approximate index to be ready and no row that a durable column could miss.
    return { mode: "memory", approximateIndexReady: false, uncoveredDurableVectorRows: 0 };
  }

  async purgeSupersededIndexGenerations(
    options: PurgeSupersededIndexGenerationsOptions
  ): Promise<PurgeSupersededIndexGenerationsResult> {
    assertIndexGenerationSweepLimit(options.limit);
    const supersededBeforeMs = options.supersededBefore.getTime();
    const candidates = [...this.repositoryIndexes.entries()]
      .filter(([, entry]) => {
        // The generation a repository currently points at is never swept, however
        // old it is: it is the one still being read.
        const current = this.repositories.get(entry.repositoryId)?.indexSha;
        if (current !== undefined && current === entry.index.commitSha) return false;
        const updatedMs = Date.parse(entry.updatedAt);
        return Number.isFinite(updatedMs) && updatedMs < supersededBeforeMs;
      })
      .sort(
        ([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
      )
      .slice(0, options.limit);
    for (const [storageKey] of candidates) {
      this.repositoryIndexes.delete(storageKey);
      // Mirrors the ON DELETE CASCADE from repository_indexes to its vectors,
      // per-record content rows, and call edges.
      this.repositoryIndexVectors.delete(storageKey);
      this.repositoryIndexRecords.delete(storageKey);
      this.repositoryIndexEdges.delete(storageKey);
    }
    return { deleted: candidates.length };
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
    vectors: readonly PersistedVectorRow[],
    indexedAt = new Date()
  ) {
    const repository = this.repositories.get(repositoryId);
    if (!repository) {
      throw new Error(`repository ${repositoryId} must exist before indexing`);
    }
    this.repositoryIndexes.set(index.storageKey, {
      repositoryId,
      index: structuredClone(index),
      updatedAt: indexedAt.toISOString()
    });
    this.repositoryIndexVectors.set(
      index.storageKey,
      vectors.map((row) => structuredClone(row))
    );
    this.repositoryIndexRecords.set(
      index.storageKey,
      new Map(
        toPersistedRecordRows(index).map((row) => [`${row.recordType}:${row.recordId}`, row])
      )
    );
    this.repositoryIndexEdges.set(
      index.storageKey,
      toPersistedCallEdges(index).map((edge) => structuredClone(edge))
    );
    this.repositories.set(repositoryId, {
      ...repository,
      indexSha: index.commitSha,
      indexUpdatedAt: indexedAt.toISOString()
    });
  }

  /**
   * Mirrors the durable hydration boundary: the canonical storage key pins scope
   * and commit, so a record id from another repository resolves to nothing here
   * even when both repositories hold byte-identical content.
   */
  async hydrateRepositoryIndexRecords(
    repositoryId: number,
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedRecordRow[]> {
    assertRecordHydrationRequest(request);
    if (!request.records.length) return [];
    const storageKey = repositoryIndexStorageKey(request);
    const entry = this.repositoryIndexes.get(storageKey);
    if (!entry || entry.repositoryId !== repositoryId) return [];
    const rows = this.repositoryIndexRecords.get(storageKey);
    if (!rows) return [];
    const hydrated = new Map<string, PersistedRecordRow>();
    for (const reference of request.records) {
      const recordKey = `${reference.recordType}:${reference.recordId}`;
      const row = rows.get(recordKey);
      if (row && row.storageKey === storageKey && !hydrated.has(recordKey)) {
        hydrated.set(recordKey, structuredClone(row));
      }
    }
    return [...hydrated.values()].sort(compareRecordRows);
  }

  async hydrateRepositoryIndexVectors(
    repositoryId: number,
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedVectorRow[]> {
    assertRecordHydrationRequest(request);
    if (!request.records.length) return [];
    const storageKey = repositoryIndexStorageKey(request);
    const entry = this.repositoryIndexes.get(storageKey);
    if (!entry || entry.repositoryId !== repositoryId) return [];
    const byKey = new Map(
      (this.repositoryIndexVectors.get(storageKey) ?? []).map((row) => [
        `${row.recordType}:${row.recordId}`,
        row
      ])
    );
    const hydrated = new Map<string, PersistedVectorRow>();
    for (const reference of request.records) {
      const recordKey = `${reference.recordType}:${reference.recordId}`;
      const row = byKey.get(recordKey);
      if (row && row.storageKey === storageKey && !hydrated.has(recordKey)) {
        hydrated.set(recordKey, structuredClone(row));
      }
    }
    return [...hydrated.values()].sort((left, right) => {
      if (left.recordType !== right.recordType) {
        return left.recordType < right.recordType ? -1 : 1;
      }
      return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
    });
  }

  async queryRepositoryIndexRecordsByPath(
    repositoryId: number,
    request: RepositoryPathRecordQuery
  ): Promise<RepositoryPathRecordQueryResult> {
    assertPathRecordQuery(request);
    if (!request.paths.length) return { rows: [], truncated: false };
    const storageKey = repositoryIndexStorageKey(request);
    const entry = this.repositoryIndexes.get(storageKey);
    if (!entry || entry.repositoryId !== repositoryId) return { rows: [], truncated: false };
    const pathSet = new Set(request.paths.map((path) => normalizeRepositoryPath(path)));
    const acceptedTypes = request.recordTypes ? new Set(request.recordTypes) : undefined;
    const vectors = new Map(
      (this.repositoryIndexVectors.get(storageKey) ?? []).map((row) => [
        `${row.recordType}:${row.recordId}`,
        row
      ])
    );
    const matched: PersistedPathRecordRow[] = [];
    for (const row of this.repositoryIndexRecords.get(storageKey)?.values() ?? []) {
      if (row.storageKey !== storageKey) continue;
      if (!pathSet.has(row.path)) continue;
      if (acceptedTypes && !acceptedTypes.has(row.recordType)) continue;
      const vector = vectors.get(`${row.recordType}:${row.recordId}`);
      if (!vector) continue;
      matched.push({
        ...structuredClone(row),
        vector: [...vector.vector],
        visibility: vector.visibility,
        providerId: vector.providerId,
        dimensions: vector.dimensions
      });
    }
    matched.sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      return compareRecordRows(left, right);
    });
    const truncated = matched.length > request.limit;
    return {
      rows: truncated ? matched.slice(0, request.limit) : matched,
      truncated
    };
  }

  async queryRepositoryIndexCallEdges(
    repositoryId: number,
    request: RepositoryCallEdgeQuery
  ): Promise<RepositoryCallEdgeQueryResult> {
    assertCallEdgeQuery(request);
    if (!request.symbolIds.length && !request.targetNames.length) {
      return { edges: [], truncated: false };
    }
    const storageKey = repositoryIndexStorageKey(request);
    const entry = this.repositoryIndexes.get(storageKey);
    if (!entry || entry.repositoryId !== repositoryId) return { edges: [], truncated: false };
    const symbolIds = new Set(request.symbolIds);
    const targetNames = new Set(
      request.targetNames.map((name) => name.trim().toLowerCase()).filter(Boolean)
    );
    const matched = (this.repositoryIndexEdges.get(storageKey) ?? []).filter((edge) => {
      if (edge.storageKey !== storageKey) return false;
      if (edge.callerSymbolId && symbolIds.has(edge.callerSymbolId)) return true;
      if (edge.resolvedSymbolIds.some((id) => symbolIds.has(id))) return true;
      return Boolean(edge.targetName && targetNames.has(edge.targetName));
    });
    matched.sort(compareCallEdges);
    const truncated = matched.length > request.limit;
    return {
      edges: (truncated ? matched.slice(0, request.limit) : matched).map((edge) =>
        structuredClone(edge)
      ),
      truncated
    };
  }

  async queryRepositoryIndexVectors(
    repositoryId: number,
    request: RepositoryVectorQuery
  ): Promise<RepositoryVectorMatch[]> {
    assertVectorQuery(request);
    // The canonical storage key pins scope and commit together, so a query can
    // only ever address the one repository snapshot it names.
    const storageKey = repositoryIndexStorageKey(request);
    const entry = this.repositoryIndexes.get(storageKey);
    if (!entry || entry.repositoryId !== repositoryId) return [];
    assertVectorQueryMatchesIndex(
      request,
      entry.index.embedding.providerId,
      entry.index.embedding.dimensions
    );
    const acceptedTypes = request.recordTypes ? new Set(request.recordTypes) : undefined;
    return (this.repositoryIndexVectors.get(storageKey) ?? [])
      .filter(
        (row) =>
          row.storageKey === storageKey &&
          row.dimensions === request.vector.length &&
          (!acceptedTypes || acceptedTypes.has(row.recordType))
      )
      .map((row) => ({
        row: structuredClone(row),
        score: cosineSimilarity(request.vector as number[], row.vector)
      }))
      .sort(compareVectorMatches)
      .slice(0, request.limit);
  }

  async applyRepositoryIndexDelta(
    repositoryId: number,
    delta: RepositoryIndexVectorDelta,
    indexedAt = new Date()
  ) {
    const repository = this.repositories.get(repositoryId);
    if (!repository) {
      throw new Error(`repository ${repositoryId} must exist before indexing`);
    }
    assertDeltaRowsMatchIndex(delta);
    const storageKey = delta.index.storageKey;
    this.repositoryIndexes.set(storageKey, {
      repositoryId,
      index: structuredClone(delta.index),
      updatedAt: indexedAt.toISOString()
    });
    const rows = new Map(
      (this.repositoryIndexVectors.get(storageKey) ?? []).map((row) => [
        `${row.recordType}:${row.recordId}`,
        row
      ])
    );
    for (const recordId of delta.deletedRecordIds) {
      rows.delete(`symbol:${recordId}`);
      rows.delete(`history:${recordId}`);
    }
    for (const row of delta.upserts) {
      rows.set(`${row.recordType}:${row.recordId}`, structuredClone(row));
    }
    this.repositoryIndexVectors.set(storageKey, [...rows.values()]);
    // The content rows are keyed like the vector rows, so the delta applies to
    // both in step and hydration cannot lag a published vector.
    const records = new Map(this.repositoryIndexRecords.get(storageKey) ?? []);
    for (const recordId of delta.deletedRecordIds) {
      records.delete(`symbol:${recordId}`);
      records.delete(`history:${recordId}`);
    }
    const upsertedRecordKeys = new Set(
      delta.upserts.map((row) => `${row.recordType}:${row.recordId}`)
    );
    for (const row of toPersistedRecordRows(delta.index)) {
      const recordKey = `${row.recordType}:${row.recordId}`;
      if (upsertedRecordKeys.has(recordKey) || !records.has(recordKey)) {
        records.set(recordKey, row);
      }
    }
    this.repositoryIndexRecords.set(storageKey, records);
    // Edges are commit-scoped under a new storage key, so publish the full edge
    // set for this generation rather than attempting a partial merge.
    this.repositoryIndexEdges.set(
      storageKey,
      toPersistedCallEdges(delta.index).map((edge) => structuredClone(edge))
    );
    this.repositories.set(repositoryId, {
      ...repository,
      indexSha: delta.index.commitSha,
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

  async getRepositoryIndexDescriptor(
    repositoryId: number,
    commitSha: string
  ): Promise<RepositoryIndexDescriptor | undefined> {
    const normalizedCommitSha = normalizeCommitSha(commitSha);
    for (const entry of this.repositoryIndexes.values()) {
      if (entry.repositoryId !== repositoryId || entry.index.commitSha !== normalizedCommitSha) {
        continue;
      }
      // Projected field by field rather than spread, so this mirrors the column
      // projection the PostgreSQL path performs and cannot accidentally carry the
      // document's content through in memory where the real store would not.
      const descriptor: RepositoryIndexDescriptor = {
        storageKey: entry.index.storageKey,
        repository: entry.index.repository,
        repositoryScope: entry.index.repositoryScope,
        commitSha: entry.index.commitSha,
        visibility: entry.index.visibility,
        embedding: { ...entry.index.embedding }
      };
      assertDescriptorReference(descriptor, {
        repositoryScope: descriptor.repositoryScope,
        commitSha: normalizedCommitSha
      });
      return descriptor;
    }
    return undefined;
  }

  async setRepositoryState(repositoryId: number, state: RepositoryLifecycleState) {
    if (state === "removed") this.discardRetainedFindings([repositoryId]);
    const repository = this.repositories.get(repositoryId);
    if (!repository) return;
    this.repositories.set(repositoryId, { ...repository, repositoryState: state });
  }

  async setInstallationState(installationId: number, state: RepositoryLifecycleState) {
    if (state === "removed") {
      this.discardRetainedFindings(
        [...this.repositories.values()]
          .filter((repository) => repository.installationId === installationId)
          .map((repository) => repository.repositoryId)
      );
    }
    for (const [repositoryId, repository] of this.repositories) {
      if (repository.installationId !== installationId) continue;
      this.repositories.set(repositoryId, { ...repository, repositoryState: state });
    }
  }

  /** Mirrors `REVIEW_FINDINGS_DISCARD_SQL`; see `Store.setRepositoryState` for why removal clears. */
  private discardRetainedFindings(repositoryIds: readonly number[]): void {
    const removed = new Set(repositoryIds);
    for (const [key, review] of this.reviews) {
      if (!removed.has(review.repositoryId) || !review.findings.length) continue;
      this.reviews.set(key, {
        ...review,
        findings: [],
        findingsEvictedTotal: (review.findingsEvictedTotal ?? 0) + review.findings.length,
        findingsLastEvictedAt: new Date().toISOString()
      });
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
      findings: current?.findings ?? [],
      // A row this method creates claims no provenance, matching the PostgreSQL column default the
      // equivalent insert falls back to. Without the explicit default the two stores disagree —
      // undefined here against 1 there — and a MemoryStore test stops being evidence about
      // production. An existing row keeps whatever version already wrote its findings.
      findingsSchemaVersion:
        current?.findingsSchemaVersion ?? REVIEW_FINDINGS_SCHEMA_VERSION_DEFAULT,
      findingsEvictedTotal: current?.findingsEvictedTotal,
      findingsLastEvictedAt: current?.findingsLastEvictedAt,
      feedbackTotal: current?.feedbackTotal
    });
  }

  /** True while `fence` still names the live, unexpired holder of its delivery's lease. */
  private holdsWebhookLease(fence: WebhookLeaseFence): boolean {
    const job = this.webhooks.get(fence.deliveryId);
    if (!job || job.status !== "leased" || job.leaseOwner !== fence.leaseOwner) return false;
    // A lease with no expiry is treated as already lapsed, matching claimWebhook's reclaim rule.
    if (!job.leaseExpiresAt) return false;
    const asOf = fence.asOf ? Date.parse(fence.asOf) : Date.now();
    if (!Number.isFinite(asOf)) return false;
    return new Date(job.leaseExpiresAt).getTime() > asOf;
  }

  async saveReview(
    state: ReviewStateWrite,
    expectedHeadSha?: string,
    fence?: WebhookLeaseFence
  ) {
    const key = `${state.repositoryId}:${state.pullNumber}`;
    const current = this.reviews.get(key);
    if (expectedHeadSha && current && current.headSha !== expectedHeadSha) return false;
    if (fence && !this.holdsWebhookLease(fence)) return false;
    this.reviews.set(key, {
      ...state,
      findings: normalizeReviewFindings(state.findings),
      findingsSchemaVersion: state.findingsSchemaVersion ?? REVIEW_FINDINGS_SCHEMA_VERSION,
      // `findingsEvictedTotal` is an increment on write, matching the server-authoritative
      // PostgreSQL counter, so the two implementations cannot disagree on a lifetime total.
      findingsEvictedTotal:
        (current?.findingsEvictedTotal ?? 0) + (state.findingsEvictedTotal ?? 0),
      findingsLastEvictedAt: state.findingsLastEvictedAt ?? current?.findingsLastEvictedAt,
      // Same increment semantics as `findingsEvictedTotal`, so the aggregate outlives the
      // per-finding records eviction is free to drop.
      feedbackTotal: (current?.feedbackTotal ?? 0) + (state.feedbackTotal ?? 0)
    });
    return true;
  }

  async getReview(id: number, pull: number) {
    const review = this.reviews.get(`${id}:${pull}`);
    // Findings carry nested provenance, so callers get their own copies rather than aliases
    // into the retained record.
    return review
      ? { ...review, findings: review.findings.map((finding) => ({ ...finding })) }
      : undefined;
  }

  async recordFindingFeedback(input: FindingFeedbackInput): Promise<boolean> {
    // Scoped by repository and pull number exactly as the PostgreSQL predicates are: a marker
    // digest is content-addressed, so identical findings in different repositories share one,
    // and this lookup is what keeps another repository's reviewer activity off this row.
    const key = `${input.repositoryId}:${input.pullNumber}`;
    const review = this.reviews.get(key);
    if (!review) return false;
    const applied = applyFindingFeedback(
      review.findings,
      input.fingerprint,
      input.commentId,
      input.observedAt
    );
    if (!applied.recorded) return false;
    this.reviews.set(key, {
      ...review,
      findings: applied.findings,
      feedbackTotal: (review.feedbackTotal ?? 0) + 1
    });
    return true;
  }

  async enqueueWebhook(deliveryId: string, eventName: string, payload: Record<string, any>) {
    if (this.webhooks.has(deliveryId)) return false;
    const nowIso = new Date().toISOString();
    this.webhooks.set(deliveryId, {
      deliveryId,
      eventName,
      // Scrubbed on the same boundary as PostgresStore so the two stores hand identical payloads
      // to a handler and a memory-backed test cannot pass on fields production would have dropped.
      payload: scrubWebhookPayloadForRetention(eventName, payload),
      status: "pending",
      attempts: 0,
      availableAt: new Date(0).toISOString(),
      updatedAt: nowIso
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
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      updatedAt: now.toISOString()
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
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString()
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
    const nowIso = new Date().toISOString();
    this.webhooks.set(deliveryId, {
      ...current,
      status: deadLetter ? "dead-letter" : "pending",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      availableAt: deadLetter ? current.availableAt : iso(retryAt ?? new Date()),
      lastError: error,
      deadLetteredAt: deadLetter ? nowIso : undefined,
      updatedAt: nowIso
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

  async countWebhookJobs(now = new Date()): Promise<WebhookQueueCounts> {
    const nowMs = now.getTime();
    let pending = 0;
    let leased = 0;
    let deadLetter = 0;
    let runnable = 0;
    for (const job of this.webhooks.values()) {
      if (job.status === "pending") {
        pending += 1;
        if (new Date(job.availableAt).getTime() <= nowMs) runnable += 1;
      } else if (job.status === "leased") {
        leased += 1;
        if (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= nowMs) {
          runnable += 1;
        }
      } else if (job.status === "dead-letter") {
        deadLetter += 1;
      }
    }
    return { pending, leased, deadLetter, runnable };
  }

  async purgeTerminalWebhookJobs(
    options: PurgeTerminalWebhookJobsOptions
  ): Promise<PurgeTerminalWebhookJobsResult> {
    assertWebhookPurgeLimit(options.limit);
    const limit = options.limit;
    const succeededBeforeMs = options.succeededBefore.getTime();
    const deadLetterBeforeMs = options.deadLetterBefore.getTime();
    const candidates = [...this.webhooks.values()]
      .filter((job) => {
        if (job.status === "succeeded") {
          const updatedMs = job.updatedAt ? Date.parse(job.updatedAt) : Number.NaN;
          return Number.isFinite(updatedMs) && updatedMs < succeededBeforeMs;
        }
        if (job.status === "dead-letter") {
          const terminalAt = job.deadLetteredAt ?? job.updatedAt;
          const terminalMs = terminalAt ? Date.parse(terminalAt) : Number.NaN;
          return Number.isFinite(terminalMs) && terminalMs < deadLetterBeforeMs;
        }
        return false;
      })
      .sort((left, right) => {
        const leftMs = Date.parse(left.updatedAt ?? left.availableAt);
        const rightMs = Date.parse(right.updatedAt ?? right.availableAt);
        return leftMs - rightMs;
      })
      .slice(0, limit);
    for (const job of candidates) {
      this.webhooks.delete(job.deliveryId);
    }
    return { deleted: candidates.length };
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

  async acquireOnboardingIssueLock(repositoryId: number): Promise<StoreLock> {
    if (this.onboardingIssueLocks.has(repositoryId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.onboardingIssueLockWaiters.get(repositoryId) ?? [];
        waiters.push(resolve);
        this.onboardingIssueLockWaiters.set(repositoryId, waiters);
      });
    } else {
      this.onboardingIssueLocks.add(repositoryId);
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const waiters = this.onboardingIssueLockWaiters.get(repositoryId);
        const next = waiters?.shift();
        if (waiters?.length === 0) {
          this.onboardingIssueLockWaiters.delete(repositoryId);
        }
        if (next) {
          next();
        } else {
          this.onboardingIssueLocks.delete(repositoryId);
        }
      }
    };
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

/**
 * Raised when the migration advisory lock stays held by a peer instance past the bounded retry
 * budget. `migrate()` runs before the HTTP server listens, so a boot that cannot make progress
 * must fail loudly and let the deploy surface it rather than block on an unbounded lock wait.
 */
export class MigrationLockUnavailableError extends Error {
  constructor(readonly attempts: number) {
    super(
      `PostgreSQL migration advisory lock was still held by another instance after ${attempts} attempts`
    );
    this.name = "MigrationLockUnavailableError";
  }
}

function boundedErrorKind(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : "UnknownError";
}

/**
 * Reports a migration step that degraded without failing boot.
 *
 * Every degradation reported here is a cost one: retrieval falls back to a path
 * that returns the same ranking more slowly. That makes failing boot the wrong
 * trade, but it also makes silence the wrong trade, because a fully reproducible
 * failure would otherwise be indistinguishable from a healthy migration. The
 * SQLSTATE is included when the driver supplies one: a type modifier rejected
 * during parse analysis and a denied permission call for different responses, and
 * an error name alone cannot separate them. The message itself is left out to
 * keep the bounded-error idiom used elsewhere in this app.
 */
function reportDegradedMigrationStep(step: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.warn(
    JSON.stringify({
      event: "guardianbot.migration_step_degraded",
      step,
      error: boundedErrorKind(error),
      ...(typeof code === "string" ? { sqlstate: code.slice(0, 16) } : {})
    })
  );
}

export class PostgresStore implements Store {
  private readonly pool: Pool;
  private repositoryIndexStorageMode: RepositoryIndexStorageMode = "json-array-fallback";
  // Set only when the dimensioned column and its ANN index both exist. Reads consult it before
  // using the indexed path, so an instance whose migration could not build the index still
  // answers correctly through the exact path.
  private approximateVectorIndexReady = false;
  // Rows carrying no durable vector after the backfill, or null when the count could not be
  // taken. Null and zero must stay distinguishable so a scraper never reads "unmeasured" as
  // "none outstanding".
  private uncoveredDurableVectorRows: number | null = null;
  // Retry budget for the migration lock, held on the instance so the bound can be narrowed in
  // tests without adding a test-only parameter to the production migrate() signature.
  private migrationLockAttempts = MIGRATION_LOCK_ATTEMPTS;
  private migrationLockRetryDelayMs = MIGRATION_LOCK_RETRY_DELAY_MS;

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

  async getRepositoryIndexRetrievalStatus(): Promise<RepositoryIndexRetrievalStatus> {
    return {
      mode: this.repositoryIndexStorageMode,
      approximateIndexReady: this.approximateVectorIndexReady,
      uncoveredDurableVectorRows: this.uncoveredDurableVectorRows
    };
  }

  /**
   * Prunes superseded index generations outside the migration path.
   *
   * Deliberately not part of `migrate()`: boot must not be lengthened by a sweep,
   * and a deletion that large has no business running while the port is closed.
   * Bounded per run and safe to run on every instance concurrently, as the
   * statement takes its candidates with SKIP LOCKED.
   */
  async purgeSupersededIndexGenerations(
    options: PurgeSupersededIndexGenerationsOptions
  ): Promise<PurgeSupersededIndexGenerationsResult> {
    assertIndexGenerationSweepLimit(options.limit);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ storage_key: string }>(
        SUPERSEDED_INDEX_GENERATION_PURGE_SQL,
        [options.supersededBefore, options.limit]
      );
      await client.query("COMMIT");
      return { deleted: result.rowCount ?? result.rows.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    // Concurrently booting instances must serialise rather than race: PostgreSQL still raises
    // duplicate-object errors when overlapping CREATE TABLE / CREATE INDEX IF NOT EXISTS
    // statements resolve existence at the same time. The lock is session-scoped, so it lives
    // on a dedicated connection for the whole migration, and it is acquired through a bounded
    // try-lock loop so a peer holding it with a wedged session cannot stall boot indefinitely.
    const client = await this.pool.connect();
    try {
      await this.acquireMigrationLock(client);
    } catch (error) {
      client.release(true);
      throw error;
    }

    try {
      this.repositoryIndexStorageMode = await this.detectRepositoryIndexStorageMode(client);
      await client.query(`
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
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS findings_schema_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS findings_evicted_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS findings_last_evicted_at TIMESTAMPTZ;
      -- Reviewer-feedback aggregate. Additive with a default so an older instance mid-rolling-deploy
      -- reads and rewrites the row unchanged, and so existing rows need no backfill. The per-finding
      -- feedback detail lives in the existing schemaless findings column, which needs no DDL and is
      -- already bounded by finding retention.
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS feedback_total INTEGER NOT NULL DEFAULT 0;

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
      CREATE INDEX IF NOT EXISTS webhook_jobs_terminal_cleanup_idx
        ON webhook_jobs (status, updated_at)
        WHERE status IN ('succeeded', 'dead-letter');

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

      CREATE TABLE IF NOT EXISTS repository_index_records (
        storage_key TEXT NOT NULL REFERENCES repository_indexes(storage_key) ON DELETE CASCADE,
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        repository_scope TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        summary TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (storage_key, record_type, record_id)
      );
      CREATE INDEX IF NOT EXISTS repository_index_records_scope_commit_idx
        ON repository_index_records (repository_scope, commit_sha);
      CREATE INDEX IF NOT EXISTS repository_index_records_path_idx
        ON repository_index_records (repository_id, storage_key, path);

      CREATE TABLE IF NOT EXISTS repository_index_edges (
        storage_key TEXT NOT NULL REFERENCES repository_indexes(storage_key) ON DELETE CASCADE,
        repository_id BIGINT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        repository_scope TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        target TEXT NOT NULL,
        target_name TEXT NOT NULL,
        caller_symbol_id TEXT,
        resolved_symbol_ids TEXT[] NOT NULL,
        resolution TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (storage_key, edge_id)
      );
      CREATE INDEX IF NOT EXISTS repository_index_edges_scope_commit_idx
        ON repository_index_edges (repository_scope, commit_sha);
      CREATE INDEX IF NOT EXISTS repository_index_edges_caller_idx
        ON repository_index_edges (repository_id, storage_key, caller_symbol_id);

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
        await client.query(
          "ALTER TABLE repository_index_vectors ADD COLUMN IF NOT EXISTS vector_pgvector vector"
        );
        await this.migrateApproximateVectorIndex(client);
      }
    } finally {
      let unlocked = false;
      try {
        // The client goes back to the shared pool, so the migration-only session bounds are
        // dropped first: no review query should inherit a migration's timeouts.
        await client.query("RESET lock_timeout");
        await client.query("RESET statement_timeout");
        await client.query("SELECT pg_advisory_unlock($1, $2)", [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_KEY
        ]);
        unlocked = true;
      } catch {
        // Destroying the connection ends the session and drops the lock, so an unlock failure
        // needs no rethrow here: rethrowing would mask a migration error from the block above.
      }
      if (unlocked) {
        client.release();
      } else {
        client.release(true);
      }
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
      await this.upsertRepositoryIndexDocument(client, repositoryId, index);
      // Two predicates, matching the read path exactly. The storage key alone is
      // already derived and canonical, so this is defence in depth rather than a
      // fix for a known escape: repository isolation is a security property here,
      // and it should not rest on a single predicate on the write path while the
      // read path carries two.
      await client.query(
        "DELETE FROM repository_index_vectors WHERE repository_id=$1 AND storage_key=$2",
        [repositoryId, index.storageKey]
      );
      for (let start = 0; start < vectors.length; start += 100) {
        await this.insertRepositoryIndexVectorBatch(
          client,
          repositoryId,
          vectors.slice(start, start + 100)
        );
      }
      // The per-record content rows a query hydrates from. Same two predicates,
      // same batching, and written in the same transaction as the vectors, so a
      // nearest-neighbour match can never name a row that is not yet hydratable.
      await client.query(
        "DELETE FROM repository_index_records WHERE repository_id=$1 AND storage_key=$2",
        [repositoryId, index.storageKey]
      );
      const records = toPersistedRecordRows(index);
      for (let start = 0; start < records.length; start += 100) {
        await this.insertRepositoryIndexRecordBatch(
          client,
          repositoryId,
          records.slice(start, start + 100)
        );
      }
      // Call edges for caller/callee reconstruction. Same transaction as the
      // snapshot so a durable review never sees vectors without their graph.
      await client.query(
        "DELETE FROM repository_index_edges WHERE repository_id=$1 AND storage_key=$2",
        [repositoryId, index.storageKey]
      );
      const edges = toPersistedCallEdges(index);
      for (let start = 0; start < edges.length; start += 100) {
        await this.insertRepositoryIndexEdgeBatch(
          client,
          repositoryId,
          edges.slice(start, start + 100)
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

  async getRepositoryIndexDescriptor(
    repositoryId: number,
    commitSha: string
  ): Promise<RepositoryIndexDescriptor | undefined> {
    // Normalised before it reaches the predicate so a mixed-case request matches
    // the lowercase sha the write path stored, and so the commit compared below is
    // the same one the storage key is derived from.
    const normalizedCommitSha = normalizeCommitSha(commitSha);
    const statement = buildRepositoryIndexDescriptorStatement(repositoryId, normalizedCommitSha);
    const result = await this.pool.query(statement.text, statement.values);
    const row = result.rows[0];
    if (!row) return undefined;
    const descriptor: RepositoryIndexDescriptor = {
      storageKey: row.storage_key as string,
      repository: row.full_name as string,
      repositoryScope: row.repository_scope as string,
      commitSha: row.commit_sha as string,
      visibility: row.visibility as RepositoryIndexDescriptor["visibility"],
      embedding: {
        providerId: row.embedding_provider_id as string,
        kind: parseEmbeddingKind(row.embedding_kind),
        dimensions: Number(row.embedding_dimensions)
      }
    };
    // Validated against the row's own scope, so the storage key is confirmed
    // canonical for the scope and commit the row itself claims rather than merely
    // trusted as stored. The scope is not checked here because this method takes no
    // expected scope; binding the scope to the numeric repository id is the
    // caller's boundary, and RepositoryIndexService does it.
    assertDescriptorReference(descriptor, {
      repositoryScope: descriptor.repositoryScope,
      commitSha: normalizedCommitSha
    });
    return descriptor;
  }

  async queryRepositoryIndexVectors(
    repositoryId: number,
    request: RepositoryVectorQuery
  ): Promise<RepositoryVectorMatch[]> {
    assertVectorQuery(request);
    // Derived, not caller-supplied: the canonical key binds scope and commit
    // together, so this single predicate is the repository isolation boundary.
    const storageKey = repositoryIndexStorageKey(request);
    const useApproximateIndex = await this.hasCompleteAnnCoverage(
      repositoryId,
      storageKey,
      request.vector.length
    );
    const statement = buildRepositoryIndexVectorQueryStatement(
      repositoryId,
      storageKey,
      request,
      this.repositoryIndexStorageMode,
      useApproximateIndex
    );
    const result = await this.pool.query(statement.text, statement.values);
    const matches = result.rows.map((row) => {
      const persisted = toPersistedVectorRow(row);
      // Defence in depth: a row that does not carry the requested key must never
      // be scored, whatever the server returned.
      if (persisted.storageKey !== storageKey) {
        throw new Error("repository index vector query returned a foreign storage key");
      }
      assertVectorQueryMatchesIndex(request, persisted.providerId, persisted.dimensions);
      const score =
        row.score === undefined || row.score === null
          ? cosineSimilarity(request.vector as number[], persisted.vector)
          : Number(row.score);
      return { row: persisted, score };
    });
    // pgvector already ordered by distance, but re-sorting costs nothing at this
    // size and makes the fallback path's ordering identical to the indexed path.
    return matches.sort(compareVectorMatches).slice(0, request.limit);
  }

  /**
   * Bounded content fetch for the records a nearest-neighbour query named. One
   * statement serves every record of one repository, so hydrating N matches costs
   * one round trip rather than N.
   *
   * The canonical storage key is derived here, exactly as in the vector read, and
   * re-checked on every returned row: a record id from another repository cannot
   * resolve, even when both repositories hold byte-identical content.
   */
  async hydrateRepositoryIndexRecords(
    repositoryId: number,
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedRecordRow[]> {
    assertRecordHydrationRequest(request);
    if (!request.records.length) return [];
    const storageKey = repositoryIndexStorageKey(request);
    const statement = buildRepositoryIndexRecordQueryStatement(
      repositoryId,
      storageKey,
      request.records
    );
    const result = await this.pool.query(statement.text, statement.values);
    return result.rows
      .map((row) => {
        const persisted = toPersistedRecordRow(row);
        if (
          persisted.storageKey !== storageKey ||
          persisted.repositoryScope !== request.repositoryScope
        ) {
          throw new Error("repository index record hydration returned a foreign storage key");
        }
        return persisted;
      })
      .sort(compareRecordRows);
  }

  async hydrateRepositoryIndexVectors(
    repositoryId: number,
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedVectorRow[]> {
    assertRecordHydrationRequest(request);
    if (!request.records.length) return [];
    const storageKey = repositoryIndexStorageKey(request);
    const statement = buildRepositoryIndexVectorHydrationStatement(
      repositoryId,
      storageKey,
      request.records
    );
    const result = await this.pool.query(statement.text, statement.values);
    return result.rows
      .map((row) => {
        const persisted = toPersistedVectorRow(row);
        if (
          persisted.storageKey !== storageKey ||
          persisted.repositoryScope !== request.repositoryScope
        ) {
          throw new Error("repository index vector hydration returned a foreign storage key");
        }
        return persisted;
      })
      .sort((left, right) => {
        if (left.recordType !== right.recordType) {
          return left.recordType < right.recordType ? -1 : 1;
        }
        return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
      });
  }

  async queryRepositoryIndexRecordsByPath(
    repositoryId: number,
    request: RepositoryPathRecordQuery
  ): Promise<RepositoryPathRecordQueryResult> {
    assertPathRecordQuery(request);
    if (!request.paths.length) return { rows: [], truncated: false };
    const storageKey = repositoryIndexStorageKey(request);
    const statement = buildRepositoryIndexPathRecordQueryStatement(
      repositoryId,
      storageKey,
      request
    );
    const result = await this.pool.query(statement.text, statement.values);
    const rows = result.rows.map((row) => {
      const persisted = toPersistedPathRecordRow(row);
      if (
        persisted.storageKey !== storageKey ||
        persisted.repositoryScope !== request.repositoryScope
      ) {
        throw new Error("repository index path-record query returned a foreign storage key");
      }
      return persisted;
    });
    // limit+1 fetch: drop the sentinel row and report truncation.
    const truncated = rows.length > request.limit;
    return {
      rows: truncated ? rows.slice(0, request.limit) : rows,
      truncated
    };
  }

  async queryRepositoryIndexCallEdges(
    repositoryId: number,
    request: RepositoryCallEdgeQuery
  ): Promise<RepositoryCallEdgeQueryResult> {
    assertCallEdgeQuery(request);
    if (!request.symbolIds.length && !request.targetNames.length) {
      return { edges: [], truncated: false };
    }
    const storageKey = repositoryIndexStorageKey(request);
    const statement = buildRepositoryIndexCallEdgeQueryStatement(
      repositoryId,
      storageKey,
      request
    );
    const result = await this.pool.query(statement.text, statement.values);
    const edges = result.rows.map((row) => {
      const persisted = toPersistedCallEdge(row);
      if (
        persisted.storageKey !== storageKey ||
        persisted.repositoryScope !== request.repositoryScope
      ) {
        throw new Error("repository index call-edge query returned a foreign storage key");
      }
      return persisted;
    });
    const truncated = edges.length > request.limit;
    return {
      edges: truncated ? edges.slice(0, request.limit) : edges,
      truncated
    };
  }

  async applyRepositoryIndexDelta(
    repositoryId: number,
    delta: RepositoryIndexVectorDelta,
    indexedAt = new Date()
  ) {
    assertDeltaRowsMatchIndex(delta);
    const index = delta.index;
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
      await this.upsertRepositoryIndexDocument(client, repositoryId, index);
      if (delta.deletedRecordIds.length) {
        // Scoped by repository and snapshot key, so a delete can only ever remove
        // rows belonging to the repository and commit being published.
        const statement = buildRepositoryIndexVectorDeleteStatement(
          repositoryId,
          index.storageKey,
          delta.deletedRecordIds
        );
        await client.query(statement.text, statement.values);
        const recordStatement = buildRepositoryIndexRecordDeleteStatement(
          repositoryId,
          index.storageKey,
          delta.deletedRecordIds
        );
        await client.query(recordStatement.text, recordStatement.values);
      }
      for (let start = 0; start < delta.upserts.length; start += 100) {
        await this.insertRepositoryIndexVectorBatch(
          client,
          repositoryId,
          delta.upserts.slice(start, start + 100)
        );
      }
      // Every record of the new snapshot, upserted. The storage key and each
      // record id are commit-scoped, so this publishes the new generation's rows
      // without rewriting a previous generation's.
      const records = toPersistedRecordRows(index);
      for (let start = 0; start < records.length; start += 100) {
        await this.insertRepositoryIndexRecordBatch(
          client,
          repositoryId,
          records.slice(start, start + 100)
        );
      }
      // Full edge set for the new generation. Storage key is commit-scoped, so
      // this cannot rewrite a previous generation's edges.
      await client.query(
        "DELETE FROM repository_index_edges WHERE repository_id=$1 AND storage_key=$2",
        [repositoryId, index.storageKey]
      );
      const edges = toPersistedCallEdges(index);
      for (let start = 0; start < edges.length; start += 100) {
        await this.insertRepositoryIndexEdgeBatch(
          client,
          repositoryId,
          edges.slice(start, start + 100)
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

  /**
   * Confirms every row for one snapshot carries the dimensioned ANN column
   * before the indexed path is used. During a rolling deploy an older instance
   * can still write rows without it, and the ANN query filters on that column
   * being present, so skipping this check would silently return fewer records
   * rather than failing. One indexed aggregate is cheap next to that risk.
   */
  private async hasCompleteAnnCoverage(
    repositoryId: number,
    storageKey: string,
    dimensions: number
  ): Promise<boolean> {
    if (
      this.repositoryIndexStorageMode !== "pgvector" ||
      !this.approximateVectorIndexReady ||
      dimensions !== INDEXED_VECTOR_ANN_DIMENSIONS
    ) {
      return false;
    }
    const result = await this.pool.query<{ total: number; covered: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(vector_ann)::int AS covered
       FROM repository_index_vectors
       WHERE repository_id=$1 AND storage_key=$2 AND dimensions=$3`,
      [repositoryId, storageKey, dimensions]
    );
    const row = result.rows[0];
    return Boolean(row && row.total > 0 && row.total === row.covered);
  }

  async setRepositoryState(repositoryId: number, state: RepositoryLifecycleState) {
    await this.pool.query(
      "UPDATE repositories SET repository_state=$2, updated_at=now() WHERE repository_id=$1",
      [repositoryId, state]
    );
    // After the state change, so a failure leaves findings retained rather than dropping them for
    // a repository whose removal did not actually commit.
    if (state === "removed") {
      await this.pool.query(REVIEW_FINDINGS_DISCARD_SQL, [[repositoryId]]);
    }
  }

  async setInstallationState(installationId: number, state: RepositoryLifecycleState) {
    await this.pool.query(
      "UPDATE repositories SET repository_state=$2, updated_at=now() WHERE installation_id=$1",
      [installationId, state]
    );
    if (state === "removed") {
      await this.pool.query(REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL, [installationId]);
    }
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

  async saveReview(
    state: ReviewStateWrite,
    expectedHeadSha?: string,
    fence?: WebhookLeaseFence
  ) {
    const result = await this.pool.query(
      // The lease fence gates the *source row* rather than riding on the ON CONFLICT predicate:
      // `DO UPDATE ... WHERE` filters only the update branch, so a fence expressed there would
      // still let a worker whose lease lapsed INSERT a brand-new row. Selecting the row through
      // the fence suppresses both branches, and the EXISTS probe shares this statement's snapshot
      // so the check cannot drift from the write it authorises.
      `INSERT INTO reviews (repository_id,pull_number,head_sha,reviewed_head_sha,placeholder_comment_id,findings,
        findings_schema_version,findings_evicted_total,findings_last_evicted_at,feedback_total)
       SELECT $1::bigint,$2::int,$3::text,$4::text,$5::bigint,$6::jsonb,$8::int,$9::int,
              $10::timestamptz,$11::int
       WHERE $12::text IS NULL OR EXISTS (
         SELECT 1 FROM webhook_jobs
         WHERE delivery_id=$12
           AND lease_owner=$13
           AND status='leased'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > COALESCE($14::timestamptz, now())
       )
       ON CONFLICT (repository_id,pull_number) DO UPDATE SET
       head_sha=excluded.head_sha,
       reviewed_head_sha=excluded.reviewed_head_sha,
       placeholder_comment_id=excluded.placeholder_comment_id,
       findings=excluded.findings,
       findings_schema_version=excluded.findings_schema_version,
       -- Server-authoritative lifetime counter: the caller supplies only this write's increment,
       -- so a writer that did not read the existing row cannot reset the accumulated total. The
       -- INSERT path starts from the same increment, which is the correct total for a new row.
       findings_evicted_total=reviews.findings_evicted_total + excluded.findings_evicted_total,
       findings_last_evicted_at=COALESCE(excluded.findings_last_evicted_at, reviews.findings_last_evicted_at),
       -- Same increment semantics, for the same reason plus one more: a review publishing its
       -- merged findings overwrites the schemaless column, so an engagement recorded between this
       -- writer's read and this write loses its per-finding detail. The aggregate is incremented
       -- server-side and therefore still counts it.
       feedback_total=reviews.feedback_total + excluded.feedback_total,
       updated_at=now()
       WHERE $7::text IS NULL OR reviews.head_sha=$7`,
      [
        state.repositoryId,
        state.pullNumber,
        state.headSha,
        state.reviewedHeadSha,
        state.placeholderCommentId,
        JSON.stringify(state.findings),
        expectedHeadSha ?? null,
        state.findingsSchemaVersion ?? REVIEW_FINDINGS_SCHEMA_VERSION,
        state.findingsEvictedTotal ?? 0,
        state.findingsLastEvictedAt ?? null,
        state.feedbackTotal ?? 0,
        fence?.deliveryId ?? null,
        fence?.leaseOwner ?? null,
        fence?.asOf ?? null
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
      // The JSONB column is schemaless and may predate the provenance migration, so every
      // retained finding is revalidated rather than trusted as already-typed.
      findings: normalizeReviewFindings(row.findings),
      findingsSchemaVersion: Number(
        row.findings_schema_version ?? REVIEW_FINDINGS_SCHEMA_VERSION_DEFAULT
      ),
      findingsEvictedTotal: Number(row.findings_evicted_total ?? 0),
      findingsLastEvictedAt: fromUnknownDate(row.findings_last_evicted_at),
      feedbackTotal: Number(row.feedback_total ?? 0)
    } satisfies ReviewState;
  }

  /**
   * Records one human engagement against a published advisory. The findings column is schemaless,
   * so the update is a read-modify-write and must be serialised: the row is taken `FOR UPDATE`
   * inside a transaction so two concurrent deliveries cannot each write back a copy computed from
   * the same pre-state and lose one engagement.
   *
   * Returns false when the review row or the fingerprint is absent, or when this comment was
   * already counted, so a redelivered webhook neither inflates the aggregate nor reports that it
   * captured something.
   */
  async recordFindingFeedback(input: FindingFeedbackInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(REVIEW_FEEDBACK_LOCK_SQL, [
        input.repositoryId,
        input.pullNumber
      ]);
      const row = locked.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }
      const applied = applyFindingFeedback(
        normalizeReviewFindings(row.findings),
        input.fingerprint,
        input.commentId,
        input.observedAt
      );
      if (!applied.recorded) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(REVIEW_FEEDBACK_UPDATE_SQL, [
        input.repositoryId,
        input.pullNumber,
        JSON.stringify(applied.findings)
      ]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueWebhook(deliveryId: string, eventName: string, payload: Record<string, any>) {
    const result = await this.pool.query(
      `INSERT INTO webhook_jobs (delivery_id, event_name, payload, status, attempts, available_at)
       VALUES ($1,$2,$3,'pending',0,now())
       ON CONFLICT (delivery_id) DO NOTHING`,
      // Scrubbed here rather than in the caller because this is the only point the payload becomes
      // durable: a future enqueue path cannot bypass the reduction by forgetting to call it.
      [deliveryId, eventName, JSON.stringify(scrubWebhookPayloadForRetention(eventName, payload))]
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

  async countWebhookJobs(now = new Date()): Promise<WebhookQueueCounts> {
    const result = await this.pool.query<{
      pending: number;
      leased: number;
      dead_letter: number;
      runnable: number;
    }>(WEBHOOK_QUEUE_COUNTS_SQL, [now]);
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      leased: Number(row?.leased ?? 0),
      deadLetter: Number(row?.dead_letter ?? 0),
      runnable: Number(row?.runnable ?? 0)
    };
  }

  async purgeTerminalWebhookJobs(
    options: PurgeTerminalWebhookJobsOptions
  ): Promise<PurgeTerminalWebhookJobsResult> {
    assertWebhookPurgeLimit(options.limit);
    const limit = options.limit;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ delivery_id: string }>(WEBHOOK_TERMINAL_PURGE_SQL, [
        options.succeededBefore,
        options.deadLetterBefore,
        limit
      ]);
      await client.query("COMMIT");
      return { deleted: result.rowCount ?? result.rows.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  async acquireOnboardingIssueLock(repositoryId: number): Promise<StoreLock> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new Error("repositoryId must be a positive safe integer");
    }
    const lockKey = repositoryId % 2_147_483_647;
    const client = await this.pool.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock($1, $2)",
        [ONBOARDING_ISSUE_LOCK_NAMESPACE, lockKey]
      );
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
            [ONBOARDING_ISSUE_LOCK_NAMESPACE, lockKey]
          );
          if (!result.rows[0]?.released) {
            throw new Error("PostgreSQL onboarding issue advisory lock was not held");
          }
          client.release();
        } catch (error) {
          client.release(true);
          throw error;
        }
      }
    };
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
      deadLetteredAt: fromUnknownDate(row.dead_lettered_at),
      updatedAt: fromUnknownDate(row.updated_at)
    };
  }

  /**
   * Bounds the migration session, then takes the migration lock without ever waiting on it
   * indefinitely. The session bounds are set first so every statement that follows is covered:
   * `lock_timeout` caps the ACCESS EXCLUSIVE wait each `ALTER TABLE reviews` takes behind a slow
   * reader, so a queued migration cannot block all reviews traffic, and `statement_timeout` caps
   * one wedged statement such as `CREATE EXTENSION`. `pg_try_advisory_lock` returns at once
   * instead of waiting, so a bounded retry loop around it keeps contention finite where a
   * blocking `pg_advisory_lock` would let a peer with a hung session stall boot forever, before
   * the server ever opens a port.
   */
  private async acquireMigrationLock(client: PoolClient): Promise<void> {
    // `SET` takes no bind parameters, so the session bounds go through parameterized set_config.
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      String(MIGRATION_LOCK_TIMEOUT_MS)
    ]);
    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      String(MIGRATION_STATEMENT_TIMEOUT_MS)
    ]);
    for (let attempt = 1; attempt <= this.migrationLockAttempts; attempt += 1) {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]
      );
      if (result.rows[0]?.acquired) return;
      if (attempt < this.migrationLockAttempts) {
        await delay(this.migrationLockRetryDelayMs);
      }
    }
    throw new MigrationLockUnavailableError(this.migrationLockAttempts);
  }

  /**
   * Adds the dimensioned ANN column and its index. Every step is additive and
   * runs on the caller's advisory-locked migration client.
   *
   * `ADD COLUMN ... vector(96)` is nullable with no default, so on PostgreSQL 11+
   * it is a metadata-only change that rewrites nothing and stays readable by an
   * instance running older code mid-deploy: that instance simply never writes the
   * column, and rows it writes fall back to the exact query path.
   *
   * Building the index is the expensive step and is therefore the exception, not
   * the rule. `CREATE INDEX` holds ACCESS EXCLUSIVE for its whole duration and
   * this runs before the port opens, so it is attempted only while the table is
   * small enough for the build to be trivial; at or above
   * `ANN_INDEX_INLINE_BUILD_MAX_ROWS` the index is left to an operator to build
   * with `CREATE INDEX CONCURRENTLY` out of band, which is the normal path and is
   * documented in docs/operations.md. `CONCURRENTLY` is deliberately not used
   * here: it would not remove the boot stall, since boot would still have to wait
   * out a build that takes longer than the blocking one, and a failed
   * `CONCURRENTLY` build leaves an INVALID index behind for an operator to drop.
   *
   * A failure here leaves `approximateVectorIndexReady` false rather than failing
   * boot: retrieval degrades to an exact scan, which is the same behaviour as a
   * server without pgvector. It is reported, though. This step previously
   * swallowed every error silently, which hid a fully reproducible parse failure
   * behind an apparently successful migration.
   */
  private async migrateApproximateVectorIndex(client: PoolClient): Promise<void> {
    await this.backfillDurableVectorColumn(client);
    try {
      await client.query(
        `ALTER TABLE repository_index_vectors
         ADD COLUMN IF NOT EXISTS vector_ann vector(${INDEXED_VECTOR_ANN_DIMENSIONS})`
      );
      await this.backfillApproximateVectorColumn(client);
      // `CREATE INDEX` scans the whole heap and holds ACCESS EXCLUSIVE over the whole table, so
      // the cost of the build tracks total rows and not how many carry a vector: a table of
      // millions of rows with a handful of populated vectors is exactly the case that must not
      // build inline. The probe is bounded by the ceiling itself — the subquery stops at the
      // limit — so establishing "at least this many rows exist" never costs a full count.
      const counted = await client.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM (SELECT 1 FROM repository_index_vectors LIMIT $1) AS bounded`,
        [ANN_INDEX_INLINE_BUILD_MAX_ROWS]
      );
      const rows = Number(counted.rows[0]?.total ?? 0);
      // `relname` is unique only within a namespace, so a same-named relation in any other schema
      // would satisfy an unqualified probe and invert the guard below. `to_regclass` resolves
      // through the same `search_path` `CREATE INDEX` uses, and matching `indexrelid` against
      // `indrelid` additionally proves it is an index on the intended table rather than some
      // unrelated relation that happens to share the name.
      const existing = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_index
           WHERE indexrelid = to_regclass('repository_index_vectors_ann_idx')
             AND indrelid = to_regclass('repository_index_vectors')
         ) AS exists`
      );
      if (!existing.rows[0]?.exists && rows >= ANN_INDEX_INLINE_BUILD_MAX_ROWS) {
        // At or above the inline ceiling this must not be built under a table
        // lock during boot. `>=` and a ceiling far below the backfill cap keep a
        // saturating backfill from landing on the boundary and then triggering
        // the very build the ceiling exists to avoid. The column is still
        // written and queries stay correct through the exact path.
        this.approximateVectorIndexReady = false;
        return;
      }
      await client.query(
        `CREATE INDEX IF NOT EXISTS repository_index_vectors_ann_idx
         ON repository_index_vectors
         USING hnsw (vector_ann vector_cosine_ops)`
      );
      this.approximateVectorIndexReady = true;
    } catch (error) {
      this.approximateVectorIndexReady = false;
      // pgvector was already confirmed present by detectRepositoryIndexStorageMode,
      // so reaching here is unexpected and must be visible. Retrieval still
      // answers correctly through the exact scan.
      reportDegradedMigrationStep("approximate vector index setup", error);
    }
  }

  /**
   * Fills `vector_pgvector` for rows written before that column existed.
   *
   * Rows already on a live database carry only `vector_json`, and every
   * pgvector-mode read filters on the vector column being non-null, so without
   * this those snapshots return no durable matches at all while reporting
   * success. The failure is masked rather than incorrect, because the caller
   * falls back to scoring candidates in memory, which is exactly why it would go
   * unnoticed. Backfilling is preferred over widening the read to include null
   * vector rows: an ordered nearest-neighbour scan cannot rank rows it has no
   * vector for, so that path would return an arbitrary `LIMIT` slice for
   * application scoring and could rank worse than the in-memory fallback it
   * displaces.
   *
   * `vector_json` is a JSONB array, whose text form is the same bracketed list
   * pgvector's input function parses, so the value is converted in the database
   * rather than round-tripped through the application. The spaces JSONB renders
   * after each comma are stripped first: pgvector's parser is believed to tolerate
   * them, but stripping costs one pass and removes the need to depend on that.
   */
  private async backfillDurableVectorColumn(client: PoolClient): Promise<void> {
    // Reset first: a re-migrate must not leave a stale count standing if the
    // measurement below cannot be taken this time.
    this.uncoveredDurableVectorRows = null;
    try {
      await this.runBoundedVectorBackfill((limit) =>
        client.query(
          `UPDATE repository_index_vectors
           SET vector_pgvector = replace(vector_json::text, ' ', '')::vector
           WHERE (storage_key, record_type, record_id) IN (
             SELECT storage_key, record_type, record_id
             FROM repository_index_vectors
             WHERE vector_pgvector IS NULL
             LIMIT $1
           )`,
          [limit]
        )
      );
      // Whatever the bound left behind is reported rather than assumed to be
      // zero, so a table larger than one boot's budget is visible as a number
      // instead of as unexplained fallback scoring.
      const remaining = await client.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM repository_index_vectors
         WHERE vector_pgvector IS NULL`
      );
      this.uncoveredDurableVectorRows = Number(remaining.rows[0]?.total ?? 0);
    } catch (error) {
      // Pre-existing rows stay on the in-memory fallback, which is the behaviour
      // before this column existed, so this must not fail boot. It is reported
      // because nothing else would reveal it.
      reportDegradedMigrationStep("durable vector column backfill", error);
    }
  }

  /**
   * Fills `vector_ann` from `vector_pgvector` for rows of the indexed width.
   *
   * The dimension is inlined, not bound. A pgvector type modifier is resolved
   * during parse analysis and must be a literal constant: a `$n` parameter there
   * raises `type modifiers must be simple constants or identifiers`, so the bound
   * form failed at parse time on every real server. This is not a
   * parameterization gap. A type modifier is not a value, it is a numeric module
   * constant with no user input anywhere on its path, and the value compared
   * against each row's own `dimensions` stays bound. Do not "fix" this back to a
   * placeholder.
   *
   * Convergence comes from republication, not from this step. Each boot spends at
   * most `ANN_BACKFILL_MAX_ROWS`, so a table larger than that cap is left partly
   * covered, and `hasCompleteAnnCoverage` requires a snapshot to be fully covered
   * before the indexed path is used: a partly covered snapshot is served by the
   * exact path until the next publication rewrites it in full. The loop below
   * only bounds the work per statement so no single `UPDATE` has to finish inside
   * the migration statement timeout.
   */
  private async backfillApproximateVectorColumn(client: PoolClient): Promise<void> {
    await this.runBoundedVectorBackfill((limit) =>
      client.query(
        `UPDATE repository_index_vectors
         SET vector_ann = vector_pgvector::vector(${INDEXED_VECTOR_ANN_DIMENSIONS})
         WHERE (storage_key, record_type, record_id) IN (
           SELECT storage_key, record_type, record_id
           FROM repository_index_vectors
           WHERE vector_ann IS NULL
             AND vector_pgvector IS NOT NULL
             AND dimensions = $1
           LIMIT $2
         )`,
        [INDEXED_VECTOR_ANN_DIMENSIONS, limit]
      )
    );
  }

  /**
   * Spends at most `ANN_BACKFILL_MAX_ROWS` in `ANN_BACKFILL_BATCH_ROWS` batches,
   * stopping as soon as a batch reports fewer rows than it asked for, which is
   * the only available signal that the predicate is drained. Bounding each
   * statement keeps every one of them inside the migration statement timeout.
   */
  private async runBoundedVectorBackfill(
    runBatch: (limit: number) => Promise<{ rowCount?: number | null }>
  ): Promise<void> {
    let remaining = ANN_BACKFILL_MAX_ROWS;
    while (remaining > 0) {
      const limit = Math.min(ANN_BACKFILL_BATCH_ROWS, remaining);
      const result = await runBatch(limit);
      const affected = Number(result.rowCount ?? 0);
      if (affected < limit) return;
      remaining -= affected;
    }
  }

  private async detectRepositoryIndexStorageMode(
    client: PoolClient
  ): Promise<RepositoryIndexStorageMode> {
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      // Managed PostgreSQL may deny extension creation. Fall back safely below.
    }
    try {
      const result = await client.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') AS installed"
      );
      return result.rows[0]?.installed ? "pgvector" : "json-array-fallback";
    } catch {
      return "json-array-fallback";
    }
  }

  /**
   * Shared by full replacement and partial delta publication so both write the
   * index document identically.
   */
  private async upsertRepositoryIndexDocument(
    client: PoolClient,
    repositoryId: number,
    index: RepositoryIndex
  ): Promise<void> {
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

  private async insertRepositoryIndexRecordBatch(
    client: PoolClient,
    repositoryId: number,
    records: readonly PersistedRecordRow[]
  ): Promise<void> {
    const statement = buildRepositoryIndexRecordBatchStatement(repositoryId, records);
    if (!statement) return;
    await client.query(statement.text, statement.values);
  }

  private async insertRepositoryIndexEdgeBatch(
    client: PoolClient,
    repositoryId: number,
    edges: readonly PersistedCallEdge[]
  ): Promise<void> {
    const statement = buildRepositoryIndexEdgeBatchStatement(repositoryId, edges);
    if (!statement) return;
    await client.query(statement.text, statement.values);
  }
}

/**
 * Bounds one hydration fetch. It keeps a caller from turning a bounded per-match
 * content read into an unbounded table scan by naming arbitrarily many records.
 */
function assertRecordHydrationRequest(request: RepositoryRecordHydrationRequest): void {
  if (request.records.length > 1_000) {
    throw new RangeError("record hydration is limited to 1000 records per request");
  }
  for (const record of request.records) {
    if (record.recordType !== "symbol" && record.recordType !== "history") {
      throw new Error("record hydration accepts only symbol and history records");
    }
    if (!record.recordId.trim()) {
      throw new Error("record hydration requires a non-empty record id");
    }
  }
}

function assertVectorQuery(request: RepositoryVectorQuery): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    throw new RangeError("vector query limit must be between 1 and 1000");
  }
  if (!request.providerId.trim()) {
    throw new Error("vector query must name the embedding provider that produced it");
  }
  if (
    !request.vector.length ||
    request.vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("vector query must supply a finite, non-empty vector");
  }
}

function assertPathRecordQuery(request: RepositoryPathRecordQuery): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    throw new RangeError("path record query limit must be between 1 and 1000");
  }
  if (request.paths.length > 1_000) {
    throw new RangeError("path record query is limited to 1000 paths per request");
  }
  for (const path of request.paths) {
    normalizeRepositoryPath(path);
  }
  if (request.recordTypes) {
    for (const recordType of request.recordTypes) {
      if (recordType !== "symbol" && recordType !== "history") {
        throw new Error("path record query accepts only symbol and history records");
      }
    }
  }
}

function assertCallEdgeQuery(request: RepositoryCallEdgeQuery): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    throw new RangeError("call edge query limit must be between 1 and 1000");
  }
  if (request.symbolIds.length > 1_000 || request.targetNames.length > 1_000) {
    throw new RangeError("call edge query is limited to 1000 symbol ids and target names");
  }
  for (const id of request.symbolIds) {
    if (!id.trim()) throw new Error("call edge query requires non-empty symbol ids");
  }
}

/**
 * Refuses to score a query against vectors from a different embedding space.
 * Comparing a 96-wide lexical hash to another provider's output would return
 * confident nonsense rather than an error.
 */
function assertVectorQueryMatchesIndex(
  request: RepositoryVectorQuery,
  providerId: string,
  dimensions: number
): void {
  if (request.providerId !== providerId || request.vector.length !== dimensions) {
    throw new Error("vector query is incompatible with the stored index embedding");
  }
}

function compareVectorMatches(
  left: RepositoryVectorMatch,
  right: RepositoryVectorMatch
): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftKey = `${left.row.recordType}:${left.row.recordId}`;
  const rightKey = `${right.row.recordType}:${right.row.recordId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function assertDeltaRowsMatchIndex(delta: RepositoryIndexVectorDelta): void {
  const index = delta.index;
  // The delta's own index must be self-consistent before its rows are compared
  // against it, otherwise every row could agree with a non-canonical storage key
  // and pass. The replace path gets this from toPersistedVectorRows; the delta
  // path had no equivalent, so a forged key would have reached SQL as the scope
  // predicate.
  assertIndexReference(index, index);
  const deleted = new Set(delta.deletedRecordIds);
  for (const row of delta.upserts) {
    if (deleted.has(row.recordId)) {
      throw new Error("a repository index delta cannot both upsert and delete a record");
    }
    if (
      row.storageKey !== index.storageKey ||
      row.repositoryScope !== index.repositoryScope ||
      row.commitSha !== index.commitSha ||
      row.visibility !== index.visibility ||
      row.providerId !== index.embedding.providerId ||
      row.dimensions !== index.embedding.dimensions ||
      row.vector.length !== index.embedding.dimensions ||
      row.vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("repository index delta row does not match its repository index");
    }
  }
}

function toPersistedVectorRow(row: Record<string, any>): PersistedVectorRow {
  const vector = Array.isArray(row.vector_json)
    ? (row.vector_json as number[])
    : (JSON.parse(String(row.vector_json)) as number[]);
  return {
    storageKey: row.storage_key,
    repositoryScope: row.repository_scope,
    commitSha: row.commit_sha,
    visibility: row.visibility,
    providerId: row.provider_id,
    dimensions: Number(row.dimensions),
    recordType: row.record_type,
    recordId: row.record_id,
    path: row.path ?? undefined,
    vector
  };
}

export interface RepositoryIndexVectorQueryStatement {
  text: string;
  values: unknown[];
}

/**
 * Nearest-neighbour read for one repository snapshot, fully parameterized.
 *
 * `storageKey` is the isolation predicate and is always bound, never
 * interpolated. The query vector is bound too and cast in SQL with `$n::vector`,
 * which is the one place a vector literal is easy to concatenate by mistake.
 *
 * `useApproximateIndex` selects the dimensioned, ANN-indexed column so pgvector
 * can answer through the index. It is only safe once every row for the snapshot
 * carries that column, so the caller gates it on confirmed backfill coverage;
 * otherwise the exact ordering over the undimensioned column is used, which
 * returns the same ranking at higher cost.
 */
export function buildRepositoryIndexVectorQueryStatement(
  repositoryId: number,
  storageKey: string,
  request: RepositoryVectorQuery,
  mode: RepositoryIndexStorageMode,
  useApproximateIndex: boolean
): RepositoryIndexVectorQueryStatement {
  const values: unknown[] = [repositoryId, storageKey];
  const recordTypes = request.recordTypes?.length ? [...request.recordTypes] : undefined;
  let predicate = "repository_id=$1 AND storage_key=$2 AND dimensions=";
  values.push(request.vector.length);
  predicate += `$${values.length}`;
  if (recordTypes) {
    values.push(recordTypes);
    predicate += ` AND record_type = ANY($${values.length}::text[])`;
  }

  if (mode !== "pgvector") {
    // Without pgvector there is no distance operator, so ranking happens in the
    // application. The scope predicate is unchanged, so isolation does not
    // depend on which mode is active.
    values.push(request.limit);
    return {
      text: `SELECT storage_key, repository_scope, commit_sha, visibility, provider_id, dimensions,
              record_type, record_id, path, vector_json
       FROM repository_index_vectors
       WHERE ${predicate}
       ORDER BY record_type ASC, record_id ASC
       LIMIT $${values.length}`,
      values
    };
  }

  const column = useApproximateIndex ? "vector_ann" : "vector_pgvector";
  values.push(vectorLiteral(request.vector));
  const vectorPosition = values.length;
  values.push(request.limit);
  return {
    text: `SELECT storage_key, repository_scope, commit_sha, visibility, provider_id, dimensions,
            record_type, record_id, path, vector_json,
            1 - (${column} <=> $${vectorPosition}::vector) AS score
     FROM repository_index_vectors
     WHERE ${predicate} AND ${column} IS NOT NULL
     ORDER BY ${column} <=> $${vectorPosition}::vector, record_type ASC, record_id ASC
     LIMIT $${values.length}`,
    values
  };
}

function toPersistedRecordRow(row: Record<string, any>): PersistedRecordRow {
  return {
    storageKey: row.storage_key,
    repositoryScope: row.repository_scope,
    commitSha: row.commit_sha,
    recordType: row.record_type,
    recordId: row.record_id,
    path: row.path,
    line: Number(row.line),
    endLine: Number(row.end_line),
    name: row.name,
    content: row.content,
    contentSha256: row.content_sha256,
    summary: row.summary ?? undefined
  };
}

function toPersistedPathRecordRow(row: Record<string, any>): PersistedPathRecordRow {
  const base = toPersistedRecordRow(row);
  const vector = Array.isArray(row.vector_json)
    ? (row.vector_json as number[])
    : (JSON.parse(String(row.vector_json)) as number[]);
  return {
    ...base,
    vector,
    visibility: row.visibility,
    providerId: row.provider_id,
    dimensions: Number(row.dimensions)
  };
}

function toPersistedCallEdge(row: Record<string, any>): PersistedCallEdge {
  const resolved = Array.isArray(row.resolved_symbol_ids)
    ? (row.resolved_symbol_ids as string[])
    : [];
  return {
    storageKey: row.storage_key,
    repositoryScope: row.repository_scope,
    commitSha: row.commit_sha,
    edgeId: row.edge_id,
    path: row.path,
    line: Number(row.line),
    target: row.target,
    targetName: row.target_name,
    callerSymbolId: row.caller_symbol_id ?? undefined,
    resolvedSymbolIds: resolved,
    resolution: row.resolution === "name-match" ? "name-match" : "unresolved"
  };
}

export interface RepositoryIndexRecordQueryStatement {
  text: string;
  values: unknown[];
}

/**
 * Bounded content hydration for named records of one snapshot, fully parameterized.
 *
 * Carries the same two-predicate boundary as the vector read path, so a record id
 * taken from a nearest-neighbour match can only ever resolve inside the
 * repository and snapshot it came from: two repositories holding byte-identical
 * content still hold separate rows under separate storage keys.
 *
 * The record identities are bound as two parallel text arrays matched through
 * `unnest`, so the statement text does not vary with the number of records and a
 * type/id pair cannot be satisfied by crossing between two different records.
 */
export function buildRepositoryIndexRecordQueryStatement(
  repositoryId: number,
  storageKey: string,
  records: readonly RepositoryRecordReference[]
): RepositoryIndexRecordQueryStatement {
  return {
    text: `SELECT storage_key, repository_scope, commit_sha, record_type, record_id,
            path, line, end_line, name, content, content_sha256, summary
       FROM repository_index_records
       WHERE repository_id=$1 AND storage_key=$2
         AND (record_type, record_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))
       ORDER BY record_type ASC, record_id ASC`,
    values: [
      repositoryId,
      storageKey,
      records.map((record) => record.recordType),
      records.map((record) => record.recordId)
    ]
  };
}

export interface RepositoryIndexDescriptorStatement {
  text: string;
  values: unknown[];
}

/**
 * A snapshot's identity read from columns alone, with `index_document` omitted
 * from the projection.
 *
 * Every column here is already NOT NULL on `repository_indexes` (see the DDL
 * above), so the descriptor needs no optional modelling. `content_sha256` and
 * `vector_storage` are deliberately absent: nothing in the identity contract
 * reads them, and projecting only what is consumed keeps the row narrow.
 *
 * The predicate pair is `(repository_id, commit_sha)`, which is the table's
 * PRIMARY KEY, so this is a single-row primary-key lookup. `repository_scope` is
 * deliberately *not* a predicate: filtering on it would turn a scope mismatch
 * into an empty result that reads as "no such snapshot", whereas returning the
 * row and comparing its scope lets a mismatch be raised. A silent miss and a
 * cross-repository row must not be the same observation.
 *
 * NOTE: this statement is only ever exercised against a stubbed pool in tests.
 * No live PostgreSQL exists in this environment, so its behaviour on a real
 * server is reasoned about, not verified.
 */
export function buildRepositoryIndexDescriptorStatement(
  repositoryId: number,
  commitSha: string
): RepositoryIndexDescriptorStatement {
  return {
    text: `SELECT repository_scope, commit_sha, visibility, storage_key, full_name,
            embedding_provider_id, embedding_kind, embedding_dimensions
       FROM repository_indexes
       WHERE repository_id=$1 AND commit_sha=$2`,
    values: [repositoryId, commitSha]
  };
}

/**
 * The stored embedding kind, rejected rather than cast when unrecognised.
 *
 * `embedding_kind` is a bare TEXT column, so a value outside the union is
 * representable in storage. Casting it would produce a well-typed lie that flows
 * into embedding-provider reconstruction; failing here keeps an unknown embedding
 * space from being silently treated as a known one.
 */
function parseEmbeddingKind(value: unknown): IndexEmbeddingMetadata["kind"] {
  if (value === "local-model" || value === "lexical-fallback") return value;
  throw new Error("repository index descriptor has an unrecognised embedding kind");
}

export interface RepositoryIndexRecordDeleteStatement {
  text: string;
  values: unknown[];
}

export function buildRepositoryIndexRecordDeleteStatement(
  repositoryId: number,
  storageKey: string,
  deletedRecordIds: readonly string[]
): RepositoryIndexRecordDeleteStatement {
  return {
    text: `DELETE FROM repository_index_records
       WHERE repository_id=$1 AND storage_key=$2 AND record_id = ANY($3::text[])`,
    values: [repositoryId, storageKey, [...deletedRecordIds]]
  };
}

export interface RepositoryIndexRecordBatchStatement {
  text: string;
  values: unknown[];
}

/**
 * Upserts the per-record content rows that make a query answerable without the
 * materialised document. Keyed identically to the vector rows, so one
 * nearest-neighbour match names exactly one of these.
 */
export function buildRepositoryIndexRecordBatchStatement(
  repositoryId: number,
  records: readonly PersistedRecordRow[]
): RepositoryIndexRecordBatchStatement | undefined {
  if (!records.length) return undefined;
  const values: unknown[] = [];
  const rows: string[] = [];
  for (const record of records) {
    const firstPosition = values.length + 1;
    values.push(
      record.storageKey,
      repositoryId,
      record.repositoryScope,
      record.commitSha,
      record.recordType,
      record.recordId,
      record.path,
      record.line,
      record.endLine,
      record.name,
      record.content,
      record.contentSha256,
      record.summary ?? null
    );
    rows.push(
      `(${Array.from({ length: 13 }, (_, offset) => `$${firstPosition + offset}`).join(",")})`
    );
  }
  return {
    text: `INSERT INTO repository_index_records
       (storage_key, repository_id, repository_scope, commit_sha, record_type, record_id,
        path, line, end_line, name, content, content_sha256, summary)
       VALUES ${rows.join(",")}
       ON CONFLICT (storage_key, record_type, record_id) DO UPDATE SET
         repository_id=excluded.repository_id,
         repository_scope=excluded.repository_scope,
         commit_sha=excluded.commit_sha,
         path=excluded.path,
         line=excluded.line,
         end_line=excluded.end_line,
         name=excluded.name,
         content=excluded.content,
         content_sha256=excluded.content_sha256,
         summary=excluded.summary,
         updated_at=now()`,
    values
  };
}

export interface RepositoryIndexEdgeBatchStatement {
  text: string;
  values: unknown[];
}

/**
 * Upserts call-graph edges for one snapshot. Same repository_id + storage_key
 * boundary as vector/record rows; written in the same publication transaction.
 *
 * Fail closed on duplicate `(storage_key, edge_id)` inputs: PostgreSQL rejects a
 * single INSERT whose ON CONFLICT target appears more than once. Exact-duplicate
 * collapse belongs in `toPersistedCallEdges`; this builder only enforces the
 * invariant and never silently deduplicates.
 */
export function buildRepositoryIndexEdgeBatchStatement(
  repositoryId: number,
  edges: readonly PersistedCallEdge[]
): RepositoryIndexEdgeBatchStatement | undefined {
  if (!edges.length) return undefined;
  const seenKeys = new Set<string>();
  const values: unknown[] = [];
  const rows: string[] = [];
  for (const edge of edges) {
    const compositeKey = `${edge.storageKey}\u0000${edge.edgeId}`;
    if (seenKeys.has(compositeKey)) {
      // Reject before emitting INSERT: PostgreSQL ON CONFLICT cannot target the
      // same (storage_key, edge_id) twice in one statement. No silent dedupe.
      throw new Error(
        `repository index edge batch contains duplicate ON CONFLICT target (storage_key, edge_id): storage key ${JSON.stringify(edge.storageKey)} edge id ${JSON.stringify(edge.edgeId)}`
      );
    }
    seenKeys.add(compositeKey);
    const firstPosition = values.length + 1;
    values.push(
      edge.storageKey,
      repositoryId,
      edge.repositoryScope,
      edge.commitSha,
      edge.edgeId,
      edge.path,
      edge.line,
      edge.target,
      edge.targetName,
      edge.callerSymbolId ?? null,
      edge.resolvedSymbolIds,
      edge.resolution
    );
    rows.push(
      `(${Array.from({ length: 12 }, (_, offset) => `$${firstPosition + offset}`).join(",")})`
    );
  }
  return {
    text: `INSERT INTO repository_index_edges
       (storage_key, repository_id, repository_scope, commit_sha, edge_id, path, line,
        target, target_name, caller_symbol_id, resolved_symbol_ids, resolution)
       VALUES ${rows.join(",")}
       ON CONFLICT (storage_key, edge_id) DO UPDATE SET
         repository_id=excluded.repository_id,
         repository_scope=excluded.repository_scope,
         commit_sha=excluded.commit_sha,
         path=excluded.path,
         line=excluded.line,
         target=excluded.target,
         target_name=excluded.target_name,
         caller_symbol_id=excluded.caller_symbol_id,
         resolved_symbol_ids=excluded.resolved_symbol_ids,
         resolution=excluded.resolution,
         updated_at=now()`,
    values
  };
}

export interface RepositoryIndexPathRecordQueryStatement {
  text: string;
  values: unknown[];
}

/**
 * Exact path-scoped record fetch with vector join. Fetches `limit + 1` rows so
 * truncation is observable. Predicates: repository_id + canonical storage_key.
 */
export function buildRepositoryIndexPathRecordQueryStatement(
  repositoryId: number,
  storageKey: string,
  request: RepositoryPathRecordQuery
): RepositoryIndexPathRecordQueryStatement {
  const paths = request.paths.map((path) => normalizeRepositoryPath(path));
  const values: unknown[] = [repositoryId, storageKey, paths];
  let typePredicate = "";
  if (request.recordTypes?.length) {
    values.push([...request.recordTypes]);
    typePredicate = ` AND r.record_type = ANY($${values.length}::text[])`;
  }
  values.push(request.limit + 1);
  return {
    text: `SELECT r.storage_key, r.repository_scope, r.commit_sha, r.record_type, r.record_id,
            r.path, r.line, r.end_line, r.name, r.content, r.content_sha256, r.summary,
            v.vector_json, v.visibility, v.provider_id, v.dimensions
       FROM repository_index_records AS r
       INNER JOIN repository_index_vectors AS v
         ON v.storage_key = r.storage_key
        AND v.record_type = r.record_type
        AND v.record_id = r.record_id
       WHERE r.repository_id=$1 AND r.storage_key=$2
         AND r.path = ANY($3::text[])${typePredicate}
       ORDER BY r.path ASC, r.record_type ASC, r.record_id ASC
       LIMIT $${values.length}`,
    values
  };
}

export interface RepositoryIndexCallEdgeQueryStatement {
  text: string;
  values: unknown[];
}

/**
 * Bounded call-edge fetch. Predicates: repository_id + canonical storage_key, plus
 * caller/resolved/target-name filters. Fetches `limit + 1` for truncation.
 */
export function buildRepositoryIndexCallEdgeQueryStatement(
  repositoryId: number,
  storageKey: string,
  request: RepositoryCallEdgeQuery
): RepositoryIndexCallEdgeQueryStatement {
  const symbolIds = [...request.symbolIds];
  const targetNames = request.targetNames
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return {
    text: `SELECT storage_key, repository_scope, commit_sha, edge_id, path, line, target,
            target_name, caller_symbol_id, resolved_symbol_ids, resolution
       FROM repository_index_edges
       WHERE repository_id=$1 AND storage_key=$2
         AND (
           caller_symbol_id = ANY($3::text[])
           OR resolved_symbol_ids && $3::text[]
           OR target_name = ANY($4::text[])
         )
       ORDER BY edge_id ASC
       LIMIT $5`,
    values: [repositoryId, storageKey, symbolIds, targetNames, request.limit + 1]
  };
}

export interface RepositoryIndexVectorHydrationStatement {
  text: string;
  values: unknown[];
}

/**
 * Vectors for named records of one snapshot. Same two-predicate isolation as
 * record hydration.
 */
export function buildRepositoryIndexVectorHydrationStatement(
  repositoryId: number,
  storageKey: string,
  records: readonly RepositoryRecordReference[]
): RepositoryIndexVectorHydrationStatement {
  return {
    text: `SELECT storage_key, repository_scope, commit_sha, visibility, provider_id, dimensions,
            record_type, record_id, path, vector_json
       FROM repository_index_vectors
       WHERE repository_id=$1 AND storage_key=$2
         AND (record_type, record_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))
       ORDER BY record_type ASC, record_id ASC`,
    values: [
      repositoryId,
      storageKey,
      records.map((record) => record.recordType),
      records.map((record) => record.recordId)
    ]
  };
}

export interface RepositoryIndexVectorDeleteStatement {
  text: string;
  values: unknown[];
}

/**
 * Scoped delete for the named records of one snapshot, fully parameterized.
 *
 * Carries the same two-predicate boundary as the read path: a delta delete is
 * confined to one repository and one snapshot key, so caller-supplied record ids
 * can never reach rows outside it. The ids are bound as a single text array
 * rather than expanded into placeholders, so the statement text does not vary
 * with the number of records being deleted.
 *
 * Extracted from the caller so the boundary itself is assertable without a
 * server, as the query and batch paths already are.
 */
export function buildRepositoryIndexVectorDeleteStatement(
  repositoryId: number,
  storageKey: string,
  deletedRecordIds: readonly string[]
): RepositoryIndexVectorDeleteStatement {
  return {
    text: `DELETE FROM repository_index_vectors
       WHERE repository_id=$1 AND storage_key=$2 AND record_id = ANY($3::text[])`,
    values: [repositoryId, storageKey, [...deletedRecordIds]]
  };
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
      // One bound literal feeds both vector columns. The dimensioned column is
      // written only when this row's own width matches it, so a provider
      // configured to another width still inserts cleanly with a NULL there and
      // is served by the exact query path.
      values.push(vectorLiteral(vector.vector));
      placeholders.push(`$${firstPosition + 11}::vector`);
      placeholders.push(
        vector.dimensions === INDEXED_VECTOR_ANN_DIMENSIONS &&
          vector.vector.length === INDEXED_VECTOR_ANN_DIMENSIONS
          ? `$${firstPosition + 11}::vector(${INDEXED_VECTOR_ANN_DIMENSIONS})`
          : "NULL"
      );
    }
    rows.push(`(${placeholders.join(",")})`);
  }
  const text = usePgvector
    ? `INSERT INTO repository_index_vectors
       (storage_key, repository_id, repository_scope, commit_sha, visibility, provider_id, dimensions,
        record_type, record_id, path, vector_json, vector_pgvector, vector_ann)
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
         vector_ann=excluded.vector_ann,
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
