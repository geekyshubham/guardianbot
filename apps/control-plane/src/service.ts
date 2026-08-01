import {
  assertDescriptorReference,
  buildReviewBundle,
  detectRepository,
  parseGuardianConfig,
  retrievalToReviewContextCandidates,
  retrieveDurableRepositoryContext,
  scoreChangeRisk,
  stableFingerprint,
  verifyWebhookSignature,
  type GitHubClient,
  type GuardianConfig,
  type IndexChangedFile,
  type RepositoryIndexDescriptor,
  type RepositoryVisibility,
  type ReviewBundleContextCandidate
} from "@guardianbot/core";
import {
  BackendError,
  validateReviewResult,
  type BackendCapabilities,
  type DataClassification,
  type ReviewFinding,
  type ReviewProfile,
  type ReviewRequest,
  type ReviewResult
} from "@guardianbot/protocol";
import { installationClient } from "./app-auth.js";
import {
  ReviewBackendRegistry,
  type AdminBackendRegistryConfig
} from "./backend-registry.js";
import { GuardianMetrics } from "./metrics.js";
import type { RepositoryIndexService } from "./repository-index-service.js";
import {
  extractFindingMarker,
  findingMarker,
  isClosedFindingComment,
  onboardingIssue,
  renderClosedInlineFinding,
  renderInlineFinding,
  renderPlaceholder,
  renderReview,
  renderStaleReview,
  renderUnavailable,
  type FindingLifecycleSummary,
  type ReviewFileGroup
} from "./render.js";
import {
  REVIEW_FINDINGS_SCHEMA_VERSION,
  evictTerminalReviewFindings,
  reviewFindingRetentionOptionsFromEnvironment,
  type EvictReviewFindingsResult,
  type ReviewFindingLifecycleState,
  type ReviewFindingRecord,
  type ReviewFindingRetentionOptions,
  type ReviewState,
  type Store,
  type WebhookJob,
  type WebhookLeaseFence,
  type WebhookQueueCounts
} from "./store.js";

export interface ServiceOptions {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  modelBackendUrl?: string;
  modelBackendToken?: string;
  backendRegistry?: ReviewBackendRegistry;
  backendRegistryConfig?: string | AdminBackendRegistryConfig;
  backendEnvironment?: Record<string, string | undefined>;
  maxWebhookAttempts?: number;
  webhookLeaseMs?: number;
  githubClientFactory?: (event: GitHubEvent, repositoryIds?: number[]) => Promise<GitHubClientLike>;
  reviewClientFactory?: (
    profile: ReviewProfile,
    classification: DataClassification
  ) => ReviewBackend | undefined;
  scannerWorkflowRunHandler?: (run: GuardianScannerWorkflowRun) => Promise<void>;
  now?: () => Date;
  metrics?: GuardianMetrics;
  repositoryIndexService?: RepositoryIndexService;
  reviewFindingRetention?: ReviewFindingRetentionOptions;
}

export interface GuardianScannerWorkflowRun {
  repositoryId: number;
  repositoryFullName: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  conclusion: string;
  workflowPath: ".github/workflows/guardianbot.yml";
  artifactNamePrefixes: readonly [
    "guardianbot-evidence-",
    "guardianbot-image-evidence-",
    "guardianbot-dast-evidence-"
  ];
}

type GitHubEvent = Record<string, any>;

interface GitHubPullFile {
  filename: string;
  previous_filename?: string;
  patch?: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

interface GitHubPull {
  number: number;
  head: { sha: string };
  base: { sha: string; ref: string };
  title: string;
  body?: string | null;
  user: { login: string };
  draft?: boolean;
}

interface GitHubReviewComment {
  id: number;
  body: string;
  commit_id?: string;
  path?: string;
  line?: number | null;
  /** Author login, required before any comment is rewritten so reviewer text is never touched. */
  user?: { login?: string };
  /** Set on replies, which are reviewer conversation even when they quote an advisory. */
  in_reply_to_id?: number;
}

interface GitHubClientLike {
  getTree(owner: string, repo: string, ref: string): Promise<string[]>;
  getLanguages(owner: string, repo: string): Promise<Record<string, number>>;
  getFile(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | undefined>;
  createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string
  ): Promise<{ html_url: string; number: number }>;
  createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number; html_url: string }>;
  updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<{ id: number; html_url: string }>;
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T>;
}

export interface ReviewBackend {
  /** Optional signal lets shutdown cancel in-flight backend work without breaking injected fakes. */
  capabilities(signal?: AbortSignal): Promise<BackendCapabilities>;
  review(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult>;
}

interface RoutedReviewBackend {
  alias: string;
  backend: ReviewBackend;
}

interface SelectedReviewFiles {
  files: GitHubPullFile[];
  partial: boolean;
  totalFiles: number;
  totalChangedLines: number;
  omittedFiles: string[];
  omittedChangedLines: number;
}

interface LoadedRepositoryContext {
  config?: GuardianConfig;
  configSource?: string;
  codeOwnersPath?: string;
  codeOwnersSource?: string;
  scannerConfigured: boolean;
}

interface LoadedIndexReviewContext {
  candidates: ReviewBundleContextCandidate[];
  partial: boolean;
  warning?: string;
}

interface IndexedReviewContextInput {
  repositoryId: number;
  repositoryFullName: string;
  visibility: RepositoryVisibility;
  baseSha: string;
  files: GitHubPullFile[];
  query: string;
}

interface ReviewExecutionOptions {
  manual?: boolean;
  full?: boolean;
}

interface ReviewFileScope {
  files: GitHubPullFile[];
  baseSha: string;
  summary: string;
  partialReason?: string;
}

const HIGH_RISK_PATH =
  /(^|\/)(auth|security|migrations)(\/|$)|\.github\/workflows|Dockerfile|secret|tenant/i;
const REVIEW_FILE_LIMIT = 50;
const REVIEW_LINE_LIMIT = 5_000;
const INPUT_CHARACTER_LIMIT = 200_000;
const REVIEW_BUNDLE_CHARACTER_LIMIT = 180_000;
const REQUEST_ENVELOPE_RESERVE = 12_000;
const MAX_BACKEND_TIMEOUT_MS = 600_000;
const MIN_WEBHOOK_LEASE_MS = MAX_BACKEND_TIMEOUT_MS + 120_000;
const DEFAULT_WEBHOOK_LEASE_MS = 15 * 60_000;
// Bounds the credited-attempt ledger so a throttling storm cannot grow it without limit.
// Once full, attempts count normally and jobs stay able to dead-letter.
const MAX_UNCOUNTED_ATTEMPT_DELIVERIES = 10_000;
const MAX_REVIEW_COMMENT_PAGES = 20;
const DEFAULT_INLINE_LIMIT = 8;
// Bounds the closing rewrites issued per review so a pull request carrying a large terminal
// backlog cannot turn one review into an unbounded run of GitHub writes. Remaining comments are
// closed by later reviews, which converge because rewritten comments are skipped. Held above the
// default retention limit's per-review turnover so a terminal finding is closed on the pull
// request before eviction can drop the record that identifies its comment.
const MAX_CLOSED_INLINE_UPDATES = 100;
// GitHub App identities always carry this login suffix, which is what separates GuardianBot's own
// advisories from reviewer comments that merely quote one.
const BOT_LOGIN_SUFFIX = "[bot]";
const REPOSITORY_CONTEXT_LIMIT = 24;
const ONBOARDING_ISSUE_TITLE = "GuardianBot onboarding inventory";
const ONBOARDING_ISSUE_MARKER = "<!-- guardianbot-onboarding-inventory -->";
const MAX_ONBOARDING_ISSUE_PAGES = 10;

/**
 * Typed authentication failure so the HTTP edge can pick a status code without
 * substring-matching error text, and without echoing internal detail to callers.
 */
export class WebhookAuthenticationError extends Error {
  constructor(
    message: string,
    readonly reason: "delivery" | "signature",
    readonly statusCode: 400 | 401
  ) {
    super(message);
    this.name = "WebhookAuthenticationError";
  }
}

/** Raised when shutdown cancels an in-flight job so the lease is released at once. */
export class WebhookAbortedError extends Error {
  constructor() {
    super("webhook processing aborted for shutdown");
    this.name = "WebhookAbortedError";
  }
}

export class GuardianService {
  readonly metrics: GuardianMetrics;
  private readonly maxWebhookAttempts: number;
  private readonly webhookLeaseMs: number;
  private readonly now: () => Date;
  private readonly reviewFindingRetention: ReviewFindingRetentionOptions;
  private readonly backendRegistry?: ReviewBackendRegistry;
  private readonly onboardingIssuePromises = new Map<number, Promise<void>>();
  // Claims that must not count against maxWebhookAttempts: throttling and shutdown.
  private readonly uncountedAttempts = new Map<string, number>();

  constructor(private readonly options: ServiceOptions, private readonly store: Store) {
    this.metrics = options.metrics ?? new GuardianMetrics();
    this.maxWebhookAttempts = options.maxWebhookAttempts ?? 5;
    const webhookLeaseMs = options.webhookLeaseMs ?? DEFAULT_WEBHOOK_LEASE_MS;
    if (webhookLeaseMs < MIN_WEBHOOK_LEASE_MS) {
      throw new Error(
        `webhookLeaseMs must be at least ${MIN_WEBHOOK_LEASE_MS}ms to exceed the maximum backend timeout`
      );
    }
    this.webhookLeaseMs = webhookLeaseMs;
    this.now = options.now ?? (() => new Date());
    this.reviewFindingRetention = options.reviewFindingRetention ??
      reviewFindingRetentionOptionsFromEnvironment(options.backendEnvironment ?? process.env);
    this.backendRegistry = options.backendRegistry ??
      (options.backendRegistryConfig
        ? new ReviewBackendRegistry(
            options.backendRegistryConfig,
            options.backendEnvironment ?? process.env
          )
        : options.reviewClientFactory
          ? undefined
          : ReviewBackendRegistry.fromAdministrativeEnvironment(
              options.backendEnvironment ?? process.env,
              {
                endpoint: options.modelBackendUrl,
                token: options.modelBackendToken
              }
            ));
  }

  authenticate(body: string, signature: string | undefined, delivery: string): void {
    if (!delivery || delivery.length > 100) {
      this.metrics.increment("webhook_invalid_total");
      throw new WebhookAuthenticationError("invalid delivery identifier", "delivery", 400);
    }
    if (
      !signature ||
      !verifyWebhookSignature(Buffer.from(body), signature, this.options.webhookSecret)
    ) {
      this.metrics.increment("webhook_invalid_total");
      throw new WebhookAuthenticationError("invalid webhook signature", "signature", 401);
    }
    this.metrics.increment("webhook_verified_total");
  }

  async enqueue(name: string, event: GitHubEvent, delivery: string): Promise<boolean> {
    const inserted = await this.store.enqueueWebhook(delivery, name, event);
    if (inserted) this.metrics.increment("webhook_enqueued_total");
    else this.metrics.increment("webhook_duplicate_total");
    await this.refreshQueueMetricsBestEffort();
    return inserted;
  }

  async refreshQueueMetrics(now = this.now()): Promise<WebhookQueueCounts> {
    const counts = await this.store.countWebhookJobs(now);
    this.metrics.setQueueCounts(counts);
    return counts;
  }

  private async refreshQueueMetricsBestEffort(now = this.now()): Promise<void> {
    try {
      await this.refreshQueueMetrics(now);
    } catch {
      // Scrape-time store refresh remains authoritative; never fail job handling for gauges.
    }
  }

  async processNextWebhook(workerId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const job = await this.store.claimWebhook(workerId, this.webhookLeaseMs, this.now());
    if (!job) {
      await this.refreshQueueMetricsBestEffort();
      return false;
    }
    this.metrics.increment("webhook_claimed_total");
    this.metrics.setInFlight(1);
    const startedAt = this.now().getTime();
    try {
      // Await the owned handler fully — never race it against abort. Racing left handle()
      // detached after lease release, so a late backend/GitHub write could still mutate state.
      await this.handle(job.eventName, job.payload, signal, {
        deliveryId: job.deliveryId,
        leaseOwner: workerId
      });
      await this.store.completeWebhook(job.deliveryId, workerId);
      this.uncountedAttempts.delete(job.deliveryId);
      this.metrics.increment("webhook_succeeded_total");
      this.metrics.observeWebhookLatency(this.now().getTime() - startedAt);
    } catch (error) {
      await this.failClaimedWebhook(job, workerId, error);
    } finally {
      this.metrics.setInFlight(0);
      await this.refreshQueueMetricsBestEffort();
    }
    return true;
  }

  /**
   * Records a failed delivery. Throttling and shutdown carry no information about the
   * delivery itself, so neither consumes an attempt and neither can dead-letter a job.
   */
  private async failClaimedWebhook(
    job: WebhookJob,
    workerId: string,
    error: unknown
  ): Promise<void> {
    const rateLimit = rateLimitDetails(error);
    const aborted = error instanceof WebhookAbortedError;
    if (rateLimit?.remaining !== undefined) {
      this.metrics.setGitHubRateLimitRemaining(rateLimit.remaining);
    }
    if (rateLimit || aborted) {
      // Attempts are incremented when the job is claimed, so credit this claim back.
      const credited = (this.uncountedAttempts.get(job.deliveryId) ?? 0) + 1;
      if (this.uncountedAttempts.size < MAX_UNCOUNTED_ATTEMPT_DELIVERIES) {
        this.uncountedAttempts.set(job.deliveryId, credited);
      }
      await this.store.failWebhook(
        job.deliveryId,
        workerId,
        aborted ? "webhook processing aborted for shutdown" : "GitHub rate limit exceeded",
        rateLimit ? rateLimit.retryAt : this.now(),
        false
      );
      this.metrics.increment("webhook_failed_total");
      if (rateLimit) this.metrics.increment("github_rate_limited_total");
      return;
    }
    const attempt = Math.max(1, job.attempts - (this.uncountedAttempts.get(job.deliveryId) ?? 0));
    const permanentBackendFailure = error instanceof BackendError && !error.retryable;
    const deadLetter = permanentBackendFailure || attempt >= this.maxWebhookAttempts;
    const retryAt = deadLetter
      ? undefined
      : new Date(this.now().getTime() + computeBackoffMs(attempt));
    await this.store.failWebhook(
      job.deliveryId,
      workerId,
      error instanceof Error ? error.message : String(error),
      retryAt,
      deadLetter
    );
    if (deadLetter) this.uncountedAttempts.delete(job.deliveryId);
    this.metrics.increment(deadLetter ? "webhook_dead_letter_total" : "webhook_failed_total");
    if (String(error).startsWith("GitHub ")) this.metrics.increment("github_failures_total");
    if (error instanceof BackendError) this.metrics.increment("backend_failures_total");
  }

  async ready(): Promise<boolean> {
    try {
      await this.store.ping();
      return true;
    } catch {
      return false;
    }
  }

  private client(event: GitHubEvent, repositoryIds?: number[]): Promise<GitHubClientLike> {
    if (this.options.githubClientFactory) {
      return this.options.githubClientFactory(event, repositoryIds);
    }
    return installationClient(
      this.options.appId,
      this.options.privateKey,
      event.installation.id,
      repositoryIds
    ) as Promise<GitHubClient>;
  }

  private reviewClient(
    profile: ReviewProfile,
    classification: DataClassification
  ): RoutedReviewBackend | undefined {
    const factoryBackend = this.options.reviewClientFactory?.(profile, classification);
    if (factoryBackend) return { alias: "injected", backend: factoryBackend };
    const resolved = this.backendRegistry?.resolve(profile, classification);
    return resolved ? { alias: resolved.alias, backend: resolved.client } : undefined;
  }

  private async handle(
    name: string,
    event: GitHubEvent,
    signal?: AbortSignal,
    fence?: WebhookLeaseFence
  ): Promise<void> {
    // Checked before dispatch so a job claimed just as shutdown began does no work at all,
    // rather than relying on each arm to notice.
    throwIfAborted(signal);
    if (name === "installation") {
      if (event.action === "deleted") {
        await this.store.setInstallationState(event.installation.id, "removed");
        return;
      }
      if (event.action === "suspend") {
        await this.store.setInstallationState(event.installation.id, "suspended");
        return;
      }
      if (event.action === "unsuspend") {
        await this.store.setInstallationState(event.installation.id, "active");
      }
      const repositories = event.repositories ?? (event.repository ? [event.repository] : []);
      // One installation can carry hundreds of repositories, each a full discovery round trip,
      // so cancellation is checked per repository rather than only once for the batch. Stopping
      // between repositories is safe: discovery is idempotent and the job is retried whole.
      for (const repository of repositories) {
        throwIfAborted(signal);
        await this.discover(event, repository, signal);
      }
      return;
    }

    if (name === "installation_repositories") {
      for (const repository of event.repositories_removed ?? []) {
        throwIfAborted(signal);
        await this.store.setRepositoryState(repository.id, "removed");
      }
      for (const repository of event.repositories_added ?? []) {
        throwIfAborted(signal);
        await this.discover(event, repository, signal);
      }
      return;
    }

    if (name === "repository") {
      if (event.action === "deleted" || event.action === "archived") {
        await this.store.setRepositoryState(event.repository.id, "removed");
        return;
      }
      if (event.action === "unarchived") {
        await this.store.setRepositoryState(event.repository.id, "active");
      }
      if (event.repository) await this.discover(event, event.repository, signal);
      return;
    }

    if (name === "push" && event.repository && !event.deleted) {
      await this.refreshDefaultBranchIndex(event, event.repository, signal);
      return;
    }

    if (
      name === "pull_request" &&
      ["opened", "synchronize", "reopened", "ready_for_review"].includes(event.action)
    ) {
      await this.reviewPullRequest(event, {}, signal, fence);
      return;
    }

    if (name === "workflow_run" && event.action === "completed") {
      await this.handleScannerWorkflowRun(event, signal);
      return;
    }

    if (name === "pull_request_review_comment" && event.action === "created") {
      await this.captureReviewCommentFeedback(event, signal);
      return;
    }

    if (name === "issue_comment" && event.action === "created") {
      await this.command(event, signal, fence);
    }
  }

  private async discover(
    event: GitHubEvent,
    repository: any,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    const github = await this.client(event, [repository.id]);
    const repositoryDetails =
      typeof repository.default_branch === "string" &&
      repository.default_branch.length > 0 &&
      typeof repository.private === "boolean"
        ? repository
        : await github.request<any>("GET", `/repositories/${repository.id}`);
    if (
      repositoryDetails.id !== repository.id ||
      typeof repositoryDetails.full_name !== "string" ||
      repositoryDetails.full_name.toLowerCase() !== String(repository.full_name).toLowerCase() ||
      typeof repositoryDetails.default_branch !== "string" ||
      repositoryDetails.default_branch.length === 0 ||
      typeof repositoryDetails.private !== "boolean"
    ) {
      throw new Error("GitHub repository metadata did not match the installation event");
    }
    const [owner, name] = repositoryDetails.full_name.split("/");
    const files = await github.getTree(owner, name, repositoryDetails.default_branch);
    const languages = await github.getLanguages(owner, name);
    const visibility = repositoryVisibility(repositoryDetails);
    const snapshot = {
      owner,
      name,
      defaultBranch: repositoryDetails.default_branch,
      visibility: visibility === "internal" ? ("restricted" as const) : visibility,
      files,
      languages
    };
    const detection = detectRepository(snapshot);
    const existing = await this.store.getRepository(repositoryDetails.id);
    await this.store.upsertRepository({
      installationId: event.installation.id,
      repositoryId: repositoryDetails.id,
      fullName: repositoryDetails.full_name,
      visibility,
      defaultBranch: repositoryDetails.default_branch,
      indexSha: existing?.indexSha,
      indexUpdatedAt: existing?.indexUpdatedAt,
      scannerState: existing?.scannerState ?? "not-configured",
      repositoryState: "active",
      automaticReviewPaused: existing?.automaticReviewPaused ?? false
    });
    await this.ensureOnboardingIssue(
      github,
      repositoryDetails.id,
      owner,
      name,
      onboardingIssue(
        repositoryDetails.full_name,
        [...detection.languages, ...detection.packageManagers],
        detection.notes
      )
    );
    // Discovery rebuilds the whole default-branch index, which is the same unbounded work
    // the push arm cancels. The entry checkpoint above only covers the moment before the
    // GitHub round trips begin, so without the signal here the installation,
    // installation_repositories, and repository arms all remain uncancellable.
    let refresh: Awaited<
      ReturnType<RepositoryIndexService["refreshDefaultBranchIndex"]>
    > | undefined;
    try {
      refresh = await this.options.repositoryIndexService?.refreshDefaultBranchIndex({
        github,
        repositoryId: repositoryDetails.id,
        installationId: event.installation.id,
        fullName: repositoryDetails.full_name,
        defaultBranch: repositoryDetails.default_branch,
        visibility,
        signal
      });
    } catch (error) {
      // Normalised exactly as the push arm does: the index service raises the platform
      // AbortError, which failClaimedWebhook does not recognise as shutdown, so a rebuild
      // interrupted by SIGTERM would consume an attempt and could eventually dead-letter a
      // delivery that carried no fault of its own.
      if (isShutdownAbort(error, signal)) throw asWebhookAborted(error);
      throw error;
    }
    throwIfAborted(signal);
    if (refresh) {
      await this.refreshScannerStateFromConfig(
        github,
        repositoryDetails.id,
        owner,
        name,
        refresh.commitSha
      );
    }
  }

  private async ensureOnboardingIssue(
    github: GitHubClientLike,
    repositoryId: number,
    owner: string,
    repo: string,
    body: string
  ): Promise<void> {
    const pending = this.onboardingIssuePromises.get(repositoryId);
    if (pending) {
      await pending;
      return;
    }
    const operation = this.ensureOnboardingIssueWithLock(
      github,
      repositoryId,
      owner,
      repo,
      body
    );
    this.onboardingIssuePromises.set(repositoryId, operation);
    try {
      await operation;
    } finally {
      if (this.onboardingIssuePromises.get(repositoryId) === operation) {
        this.onboardingIssuePromises.delete(repositoryId);
      }
    }
  }

  private async ensureOnboardingIssueWithLock(
    github: GitHubClientLike,
    repositoryId: number,
    owner: string,
    repo: string,
    body: string
  ): Promise<void> {
    const lock = await this.store.acquireOnboardingIssueLock(repositoryId);
    try {
      await this.ensureOnboardingIssueOnce(github, owner, repo, body);
    } finally {
      await lock.release();
    }
  }

  private async ensureOnboardingIssueOnce(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    body: string
  ): Promise<void> {
    for (let page = 1; page <= MAX_ONBOARDING_ISSUE_PAGES; page += 1) {
      const issues = await github.request<Array<{
        title?: string;
        body?: string;
        pull_request?: unknown;
      }>>(
        "GET",
        `/repos/${owner}/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`
      );
      if (
        issues.some(
          (issue) =>
            !issue.pull_request &&
            (
              String(issue.title ?? "") === ONBOARDING_ISSUE_TITLE ||
              String(issue.body ?? "").includes(ONBOARDING_ISSUE_MARKER)
            )
        )
      ) {
        return;
      }
      if (issues.length < 100) break;
    }
    await github.createIssue(
      owner,
      repo,
      ONBOARDING_ISSUE_TITLE,
      `${body}\n\n${ONBOARDING_ISSUE_MARKER}`
    );
  }

  private async refreshScannerStateFromConfig(
    github: GitHubClientLike,
    repositoryId: number,
    owner: string,
    repo: string,
    commitSha: string
  ): Promise<void> {
    let configFile: { content: string; sha: string } | undefined;
    try {
      configFile = await github.getFile(
        owner,
        repo,
        ".guardianbot/config.yml",
        commitSha
      );
    } catch {
      // A transient read failure must not erase the last confirmed scanner state.
      return;
    }
    let scannerState: "not-configured" | "report-only" | "enforced" =
      "not-configured";
    if (configFile) {
      try {
        const config = parseGuardianConfig(configFile.content);
        scannerState =
          config.scanners.mode === "enforce"
            ? "enforced"
            : config.scanners.mode === "report-only"
              ? "report-only"
              : "not-configured";
      } catch {
        scannerState = "not-configured";
      }
    }
    const repository = await this.store.getRepository(repositoryId);
    if (!repository || repository.scannerState === scannerState) return;
    await this.store.upsertRepository({ ...repository, scannerState });
  }

  private async handleScannerWorkflowRun(
    event: GitHubEvent,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    const repository = await this.store.getRepository(event.repository.id);
    if (!repository || repository.repositoryState !== "active") return;
    const run = event.workflow_run;
    const workflowPath = String(run?.path ?? "").split("@", 1)[0];
    if (
      workflowPath !== ".github/workflows/guardianbot.yml" ||
      String(run?.name ?? "") !== "GuardianBot" ||
      !Number.isSafeInteger(run?.id) ||
      !Number.isSafeInteger(run?.run_attempt) ||
      !/^[a-f0-9]{40}$/.test(String(run?.head_sha ?? ""))
    ) {
      return;
    }
    await this.options.scannerWorkflowRunHandler?.({
      repositoryId: event.repository.id,
      repositoryFullName: event.repository.full_name,
      runId: run.id,
      runAttempt: run.run_attempt,
      headSha: run.head_sha,
      conclusion: String(run.conclusion ?? "unknown"),
      workflowPath: ".github/workflows/guardianbot.yml",
      artifactNamePrefixes: [
        "guardianbot-evidence-",
        "guardianbot-image-evidence-",
        "guardianbot-dast-evidence-"
      ]
    });
  }

  /**
   * Stamps a lease fence with the current time from the service clock at the moment of the write.
   * The instant cannot be captured when the job is claimed: the whole point of the fence is that a
   * long handler may outlive its lease, so expiry has to be judged against write time.
   */
  private fenceAsOf(fence?: WebhookLeaseFence): WebhookLeaseFence | undefined {
    return fence ? { ...fence, asOf: this.now().toISOString() } : undefined;
  }

  private async reviewPullRequest(
    event: GitHubEvent,
    execution: ReviewExecutionOptions = {},
    signal?: AbortSignal,
    fence?: WebhookLeaseFence
  ): Promise<void> {
    throwIfAborted(signal);
    const pull = event.pull_request as GitHubPull;

    const repositoryRecord = await this.store.getRepository(event.repository.id);
    if (repositoryRecord && repositoryRecord.repositoryState !== "active") return;
    if (!execution.manual && repositoryRecord?.automaticReviewPaused) return;

    const github = await this.client(event, [event.repository.id]);
    const [owner, repo] = event.repository.full_name.split("/");
    const currentPull = await this.getCurrentPull(github, owner, repo, pull.number);
    if (!currentPull || currentPull.head.sha !== pull.head.sha) {
      this.metrics.increment("review_stale_total");
      return;
    }

    const repositoryContext = await this.loadRepositoryContext(
      github,
      owner,
      repo,
      pull.base.sha
    );
    if (
      pull.draft &&
      !execution.manual &&
      repositoryContext.config?.review.drafts !== "automatic"
    ) {
      return;
    }
    if (!execution.manual && repositoryContext.config?.review.automatic === false) return;

    throwIfAborted(signal);
    const existing = await this.store.getReview(event.repository.id, pull.number);
    const placeholder = existing?.placeholderCommentId
      ? { id: existing.placeholderCommentId }
      : await github.createComment(owner, repo, pull.number, renderPlaceholder(pull.head.sha));
    await this.store.saveReviewHead(
      event.repository.id,
      pull.number,
      pull.head.sha,
      placeholder.id
    );
    await github.updateComment(owner, repo, placeholder.id, renderPlaceholder(pull.head.sha));

    const fileScope = await this.resolveReviewFileScope(
      github,
      owner,
      repo,
      pull,
      existing,
      repositoryContext.config?.review.incremental === true,
      execution
    );
    const selected = selectFilesForReview(fileScope.files);
    const deterministicRisk = scoreChangeRisk(
      fileScope.files.map((file) => ({
        path: file.filename,
        additions: file.additions ?? countPatchLines(file.patch ?? "", "+"),
        deletions: file.deletions ?? countPatchLines(file.patch ?? "", "-"),
        patch: file.patch
      })),
      false
    );
    const configuredHighRisk = selected.files.some((file) =>
      (repositoryContext.config?.review.highRiskPaths ?? []).some((pattern) =>
        pathMatchesPattern(pattern, file.filename)
      )
    );
    const profile: ReviewProfile =
      deterministicRisk.highRisk || configuredHighRisk
        ? "high-risk-review"
        : "routine-review";
    const indexVisibility = repositoryVisibility(event.repository);
    const classification: DataClassification =
      indexVisibility === "internal" ? "restricted" : indexVisibility;
    const routed = this.reviewClient(profile, classification);
    if (!routed) {
      throwIfAborted(signal);
      await this.publishUnavailable(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        "no-route",
        fence
      );
      return;
    }

    let capabilities: BackendCapabilities;
    try {
      throwIfAborted(signal);
      capabilities = await routed.backend.capabilities(signal);
      throwIfAborted(signal);
      this.assertCapabilities(capabilities, profile, classification);
    } catch (error) {
      // Shutdown must requeue without publishing "AI review unavailable".
      if (isShutdownAbort(error, signal)) throw asWebhookAborted(error);
      const backendError = normalizeBackendFailure(error, "capability");
      await this.publishUnavailable(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        unavailableReason(backendError),
        fence
      );
      throw backendError;
    }

    const linkedIssues = extractLinkedIssues(pull.title, pull.body ?? "");
    const codeOwners = repositoryContext.codeOwnersSource
      ? matchingCodeOwners(
          repositoryContext.codeOwnersSource,
          fileScope.files.map((file) => file.filename)
        )
      : [];
    const preTruncatedPaths: string[] = [];
    const unavailablePatchPaths: string[] = [];
    const contextCandidates: ReviewBundleContextCandidate[] = selected.files.flatMap((file) => {
      const redacted = redactUntrustedText(String(file.patch ?? ""));
      if (!redacted) {
        unavailablePatchPaths.push(file.filename);
        return [];
      }
      const content = redacted.slice(0, 30_000);
      if (content.length < redacted.length) preTruncatedPaths.push(file.filename);
      return {
        id: `diff-${stableFingerprint(["diff", file.filename]).slice(0, 20)}`,
        path: file.filename,
        kind: "diff" as const,
        content,
        priority: HIGH_RISK_PATH.test(file.filename) ? 25 : 0
      };
    });
    const pullMetadata = redactUntrustedText(
      `title: ${String(pull.title).slice(0, 1_000)}\nbody:\n${String(pull.body ?? "").slice(0, 4_000)}`
    );
    if (pullMetadata.trim()) {
      contextCandidates.push({
        id: `pull-${pull.number}`,
        path: `pull-request/${pull.number}`,
        kind: "issue",
        content: pullMetadata,
        priority: 0
      });
    }
    if (repositoryContext.configSource) {
      contextCandidates.push({
        id: "guardian-config",
        path: ".guardianbot/config.yml",
        kind: "config",
        content: redactUntrustedText(repositoryContext.configSource).slice(0, 20_000),
        priority: 10
      });
    }
    if (repositoryContext.codeOwnersSource && repositoryContext.codeOwnersPath) {
      contextCandidates.push({
        id: "codeowners",
        path: repositoryContext.codeOwnersPath,
        kind: "config",
        content: redactUntrustedText(repositoryContext.codeOwnersSource).slice(0, 20_000),
        priority: 8
      });
    }
    const indexedContext = await this.loadIndexedReviewContext({
      repositoryId: event.repository.id,
      repositoryFullName: event.repository.full_name,
      visibility: indexVisibility,
      baseSha: pull.base.sha,
      files: fileScope.files,
      query: redactUntrustedText(
        [
          pull.title,
          pull.body ?? "",
          ...selected.files.map((file) => file.filename)
        ].join("\n")
      )
    });
    contextCandidates.push(...indexedContext.candidates);

    const availableBundleCharacters = Math.min(
      REVIEW_BUNDLE_CHARACTER_LIMIT,
      capabilities.maxInputCharacters - REQUEST_ENVELOPE_RESERVE
    );
    if (availableBundleCharacters < 1_000) {
      const error = new BackendError(
        "context_limit",
        "model backend capability is too small for the minimum review envelope",
        false
      );
      await this.publishUnavailable(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        "capability",
        fence
      );
      throw error;
    }
    const bundle = buildReviewBundle({
      contexts: contextCandidates,
      scannerEvidence: [],
      rules: [],
      maxInputCharacters: availableBundleCharacters,
      maxContextChunks: REVIEW_FILE_LIMIT + 3 + REPOSITORY_CONTEXT_LIMIT
    });
    const includedContextIds = new Set(bundle.contexts.map((context) => context.id));
    const includedDiffFiles = selected.files.filter((file) =>
      includedContextIds.has(`diff-${stableFingerprint(["diff", file.filename]).slice(0, 20)}`)
    );
    const validChangedLines = includedDiffFiles.flatMap((file) =>
      addedLineRanges(file.patch ?? "").map((range) => ({
        path: file.filename,
        ...range
      }))
    );
    const maxInlineComments =
      repositoryContext.config?.review.maxInlineComments ?? DEFAULT_INLINE_LIMIT;
    const request: ReviewRequest = {
      protocolVersion: "guardian.review.v1",
      schemaVersion: "1.0.0",
      requestId: `${event.repository.id}:${pull.number}:${pull.head.sha}`,
      repository: {
        owner,
        name: repo,
        visibility: classification,
        defaultBranch: event.repository.default_branch
      },
      pullRequest: {
        number: pull.number,
        baseSha: fileScope.baseSha,
        headSha: pull.head.sha,
        title: redactUntrustedText(String(pull.title)).slice(0, 1_000),
        body: redactUntrustedText(String(pull.body ?? "")).slice(0, 4_000),
        author: pull.user.login
      },
      profile,
      promptVersion: execution.full
        ? "guardianbot-full-review-2026-07-27"
        : "guardianbot-review-2026-07-27",
      expectedContextIndexSha: bundle.manifestSha256,
      validChangedLines,
      contexts: bundle.contexts,
      scannerEvidence: bundle.scannerEvidence,
      rules: bundle.rules,
      limits: {
        maxInlineComments,
        maxInputCharacters: Math.min(
          INPUT_CHARACTER_LIMIT,
          capabilities.maxInputCharacters
        ),
        timeoutMs: Math.min(MAX_BACKEND_TIMEOUT_MS, 90_000)
      }
    };
    if (JSON.stringify(request).length > capabilities.maxInputCharacters) {
      const error = new BackendError(
        "context_limit",
        "bounded review request exceeds the backend-declared input capability",
        false
      );
      await this.publishUnavailable(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        "capability",
        fence
      );
      throw error;
    }

    let result: ReviewResult;
    try {
      throwIfAborted(signal);
      result = await routed.backend.review(request, signal);
      throwIfAborted(signal);
      validateReviewResult(result, request);
      result = {
        ...result,
        findings: canonicalizeFindingFingerprints(result.findings)
      };
    } catch (error) {
      // Shutdown must requeue without publishing "AI review unavailable".
      if (isShutdownAbort(error, signal)) throw asWebhookAborted(error);
      const backendError = normalizeBackendFailure(error, "review");
      await this.publishUnavailable(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        unavailableReason(backendError),
        fence
      );
      throw backendError;
    }

    throwIfAborted(signal);
    const latestPull = await this.getCurrentPull(github, owner, repo, pull.number);
    if (!latestPull || latestPull.head.sha !== pull.head.sha) {
      throwIfAborted(signal);
      await this.publishStale(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        latestPull?.head.sha ?? "unknown",
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        fence
      );
      return;
    }

    // Cooperative cancellation after the head re-check succeeds: stop before lifecycle
    // merge and store writes so shutdown does not persist findings for a cancelled job.
    throwIfAborted(signal);

    const selectedFindings = selectReviewFindings(result.findings, maxInlineComments);
    const evidenceBackedFindings = selectedFindings.inline;
    const now = this.now();
    const lifecycle = mergeFindingStates(
      existing,
      pull.head.sha,
      // Lifecycle state is derived from every reported finding, not the inline selection, so a
      // finding ranking below the inline cap is never mistaken for one that stopped being
      // reported and announced as resolved while the model still reports it.
      selectedFindings.lifecycle,
      now,
      this.reviewFindingRetention
    );
    const findingStates = lifecycle.findings;
    const reappeared = countReappearances(existing?.findings, findingStates);
    if (reappeared) {
      this.metrics.increment("finding_reappeared_total", reappeared);
    }
    const saved = await this.store.saveReview(
      {
        repositoryId: event.repository.id,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        reviewedHeadSha: pull.head.sha,
        placeholderCommentId: placeholder.id,
        findings: findingStates,
        findingsSchemaVersion: REVIEW_FINDINGS_SCHEMA_VERSION,
        findingsEvictedTotal: lifecycle.evicted,
        findingsLastEvictedAt: lifecycle.evicted
          ? now.toISOString()
          : existing?.findingsLastEvictedAt
      },
      pull.head.sha,
      // Head-SHA CAS cannot separate two workers replaying one delivery — both compute this same
      // head SHA — so the lease is named too. A handler whose lease lapsed mid-run commits nothing.
      this.fenceAsOf(fence)
    );
    if (!saved) {
      this.metrics.increment("review_stale_total");
      return;
    }

    const publishedComments = await this.listReviewComments(
      github,
      owner,
      repo,
      pull.number
    );
    const publishedMarkers = new Set(
      publishedComments
        // Only GuardianBot's own top-level advisories count as published: a reviewer quoting an
        // advisory carries its marker in the quote, and reading that as a published advisory
        // would silently withhold the real one.
        .filter((comment) => this.isOwnInlineAdvisory(comment))
        // A comment already rewritten to closed form must not suppress a reappearing finding:
        // that advisory reads as resolved, so a finding returning at the same fingerprint needs
        // a fresh comment rather than silent omission.
        .filter((comment) => !isClosedFindingComment(comment.body))
        .map((comment) => extractFindingMarker(comment.body))
        .filter((marker): marker is string => Boolean(marker))
    );
    const newFindings = evidenceBackedFindings.filter(
      (finding) => !publishedMarkers.has(markerDigest(finding.fingerprint))
    );
    const stillCurrent = await this.getCurrentPull(github, owner, repo, pull.number);
    if (!stillCurrent || stillCurrent.head.sha !== pull.head.sha) {
      throwIfAborted(signal);
      await this.publishStale(
        github,
        owner,
        repo,
        event.repository.id,
        pull,
        stillCurrent?.head.sha ?? "unknown",
        placeholder.id,
        existing,
        repositoryContext.scannerConfigured,
        fence
      );
      return;
    }
    throwIfAborted(signal);
    if (newFindings.length) {
      await github.request(
        "POST",
        `/repos/${owner}/${repo}/pulls/${pull.number}/reviews`,
        {
          commit_id: pull.head.sha,
          event: "COMMENT",
          body: "GuardianBot advisory review. Deterministic security checks are reported separately.",
          comments: newFindings.map((finding) => ({
            path: finding.path,
            line: finding.endLine,
            side: "RIGHT",
            ...(finding.startLine < finding.endLine
              ? { start_line: finding.startLine, start_side: "RIGHT" }
              : {}),
            body: renderInlineFinding(finding)
          }))
        }
      );
    }
    // After inline publication, stop before closing rewrites and the final summary
    // update so shutdown does not keep mutating GitHub state past a safe boundary.
    throwIfAborted(signal);
    const inlineClosed = await this.closeTerminalInlineComments(
      github,
      owner,
      repo,
      publishedComments,
      findingStates,
      pull.head.sha,
      signal
    );

    const reviewedChangedLines = includedDiffFiles.reduce(
      (sum, file) => sum + countChangedLines(file),
      0
    );
    const localPartial =
      selected.partial ||
      Boolean(fileScope.partialReason) ||
      bundle.partial ||
      indexedContext.partial ||
      preTruncatedPaths.length > 0 ||
      unavailablePatchPaths.length > 0 ||
      result.summary.partialReview;
    const finalResult: ReviewResult = {
      ...result,
      summary: {
        ...result.summary,
        riskScore: deterministicRisk.score,
        reviewEffort: deterministicRisk.effort,
        partialReview: localPartial
      },
      findings: evidenceBackedFindings
    };
    const changeGroups = groupChangedFiles(fileScope.files);
    throwIfAborted(signal);
    await github.updateComment(
      owner,
      repo,
      placeholder.id,
      renderReview(finalResult, {
        scannerConfigured: repositoryContext.scannerConfigured,
        riskScore: deterministicRisk.score,
        reviewEffort: deterministicRisk.effort,
        riskReasons: deterministicRisk.reasons,
        changeGroups,
        impactedComponents: changeGroups.map((group) => group.title),
        linkedIssues,
        codeOwners,
        lifecycle: lifecycleSummary(findingStates),
        lifecycleFindings: findingStates,
        inlinePosted: newFindings.length,
        inlineAlreadyPresent: evidenceBackedFindings.length - newFindings.length,
        inlineClosed,
        backendAlias: routed.alias,
        contextIndexSha: bundle.manifestSha256,
        reviewScope: fileScope.summary,
        partialWarning: localPartial
          ? buildPartialWarning(
              selected,
              includedDiffFiles.length,
              reviewedChangedLines,
              preTruncatedPaths,
              unavailablePatchPaths,
              bundle.dropped.length,
              result.summary.partialReview,
              fileScope.partialReason,
              indexedContext.warning
            )
          : undefined
      })
    );
  }

  private async command(
    event: GitHubEvent,
    signal?: AbortSignal,
    fence?: WebhookLeaseFence
  ): Promise<void> {
    if (!event.issue.pull_request) return;
    const text = String(event.comment.body).trim();
    const parsed = /^@guardianbot(?:\s+([a-z-]+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (!parsed) return;

    const github = await this.client(event, [event.repository.id]);
    const [owner, repo] = event.repository.full_name.split("/");
    const actor = String(event.comment.user?.login ?? "");
    const permission = await this.getActorPermission(github, owner, repo, actor);
    const command = (parsed[1] ?? "help").toLowerCase();
    const argument = String(parsed[2] ?? "").trim().slice(0, 200);
    if (!["write", "maintain", "admin"].includes(permission)) {
      this.metrics.increment("commands_rejected_total");
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        `@${actor} is not authorized to run GuardianBot commands on this repository.`
      );
      return;
    }
    if (
      (command === "pause" || command === "resume") &&
      !["maintain", "admin"].includes(permission)
    ) {
      this.metrics.increment("commands_rejected_total");
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        `@${actor} needs maintain or admin permission to change automatic advisory review state.`
      );
      return;
    }
    this.metrics.increment("commands_authorized_total");

    if (command === "help") {
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        "Commands: `review`, `full-review`, `status`, `explain <id>`, `suggest-fix <id>`, `pause`, `resume`, `help`. All AI output is advisory; no command merges code or waives deterministic scanners."
      );
      return;
    }
    if (command === "status") {
      const [repository, review] = await Promise.all([
        this.store.getRepository(event.repository.id),
        this.store.getReview(event.repository.id, event.issue.number)
      ]);
      const state =
        repository?.automaticReviewPaused
          ? "paused"
          : repository
            ? "active"
            : "not inventoried";
      const lifecycle = lifecycleSummary(review?.findings ?? []);
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        `GuardianBot advisory state: **${state}**. App lifecycle: **${repository?.repositoryState ?? "unknown"}**. Last reviewed head: \`${review?.reviewedHeadSha?.slice(0, 12) ?? "none"}\`. Findings: ${lifecycle.open} open (${lifecycle.reappeared} returned after closing), ${lifecycle.resolved} resolved, ${lifecycle.superseded} superseded. Routine route: ${this.hasReviewRoute("routine-review") ? "configured" : "unavailable"}; high-risk route: ${this.hasReviewRoute("high-risk-review") ? "configured" : "unavailable"}. Scanner state: ${repository?.scannerState ?? "unknown"}. Use \`guardianctl doctor ${event.repository.full_name}\` for deterministic workflow diagnostics.`
      );
      return;
    }
    if (command === "pause" || command === "resume") {
      const repository = await this.ensureRepositoryRecord(event);
      if (repository.repositoryState === "removed") {
        await github.createComment(
          owner,
          repo,
          event.issue.number,
          "GuardianBot cannot change review state because this repository is removed."
        );
        return;
      }
      await this.store.setAutomaticReviewPaused(
        event.repository.id,
        command === "pause"
      );
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        command === "pause"
          ? "Automatic AI advisory review is paused. Manual `review` remains available; deterministic scanners, merge protection, and existing findings are unchanged."
          : "Automatic AI advisory review is resumed. This does not merge code or waive deterministic scanner findings."
      );
      return;
    }
    if (command === "review" || command === "full-review") {
      const pull = await this.getCurrentPull(github, owner, repo, event.issue.number);
      if (!pull) {
        await github.createComment(
          owner,
          repo,
          event.issue.number,
          "GuardianBot could not load this pull request; no review was started."
        );
        return;
      }
      await this.reviewPullRequest(
        {
          ...event,
          action: "guardianbot-command",
          pull_request: pull
        },
        { manual: true, full: command === "full-review" },
        signal,
        fence
      );
      return;
    }
    if (command === "explain" || command === "suggest-fix") {
      if (!argument) {
        await github.createComment(
          owner,
          repo,
          event.issue.number,
          `Usage: \`@guardianbot ${command} <id>\`.`
        );
        return;
      }
      const comments = await this.listReviewComments(
        github,
        owner,
        repo,
        event.issue.number
      );
      const finding = comments.find((comment) =>
        commentMatchesIdentifier(comment.body, argument)
      );
      if (!finding) {
        await github.createComment(
          owner,
          repo,
          event.issue.number,
          `No published GuardianBot finding matches \`${safeInline(argument)}\`.`
        );
        return;
      }
      if (command === "explain") {
        await github.createComment(
          owner,
          repo,
          event.issue.number,
          finding.body
            .replace(/<!--\s*guardianbot-finding:[a-f0-9]{64}\s*-->\s*/i, "")
            .replace(
              /\n\nExact replacement proposed for this changed range:[\s\S]*?(?=\n\nFinding ID:)/,
              ""
            )
        );
        return;
      }
      const suggestion = /```suggestion\n([\s\S]*?)\n```/.exec(finding.body)?.[1];
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        suggestion
          ? `Exact advisory replacement for \`${safeInline(argument)}\`:\n\n\`\`\`suggestion\n${suggestion}\n\`\`\`\n\nApply only after human verification. GuardianBot did not commit, merge, or waive scanners.`
          : `Finding \`${safeInline(argument)}\` has no exact safe replacement. Follow its remediation guidance and verify the change manually.`
      );
      return;
    }

    await github.createComment(
      owner,
      repo,
      event.issue.number,
      `Unknown GuardianBot command \`${safeInline(command)}\`. Use \`@guardianbot help\`.`
    );
  }

  private hasReviewRoute(profile: ReviewProfile): boolean {
    return Boolean(this.options.reviewClientFactory) ||
      Boolean(this.backendRegistry?.hasRoute(profile));
  }

  private async ensureRepositoryRecord(event: GitHubEvent) {
    const existing = await this.store.getRepository(event.repository.id);
    if (existing) return existing;
    const record = {
      installationId: event.installation.id,
      repositoryId: event.repository.id,
      fullName: event.repository.full_name,
      visibility: repositoryVisibility(event.repository),
      defaultBranch: event.repository.default_branch,
      scannerState: "not-configured" as const,
      repositoryState: "active" as const,
      automaticReviewPaused: false
    };
    await this.store.upsertRepository(record);
    return record;
  }

  private async refreshDefaultBranchIndex(
    event: GitHubEvent,
    repository: any,
    signal?: AbortSignal
  ): Promise<void> {
    const branchRef = `refs/heads/${repository.default_branch}`;
    if (event.ref !== branchRef) return;
    throwIfAborted(signal);
    const existing = await this.store.getRepository(repository.id);
    const visibility = repositoryVisibility(repository);
    await this.store.upsertRepository({
      installationId: event.installation.id,
      repositoryId: repository.id,
      fullName: repository.full_name,
      visibility,
      defaultBranch: repository.default_branch,
      indexSha: existing?.indexSha,
      indexUpdatedAt: existing?.indexUpdatedAt,
      scannerState: existing?.scannerState ?? "not-configured",
      repositoryState: "active",
      automaticReviewPaused: existing?.automaticReviewPaused ?? false
    });
    const github = await this.client(event, [repository.id]);
    // A full rebuild is the longest unit of work in the service: a tree read plus one blob fetch
    // per indexed file. Without the signal it ran to completion after SIGTERM and published an
    // index the drain budget had already given up on.
    let refresh: Awaited<
      ReturnType<RepositoryIndexService["refreshDefaultBranchIndex"]>
    > | undefined;
    try {
      refresh = await this.options.repositoryIndexService?.refreshDefaultBranchIndex({
        github,
        repositoryId: repository.id,
        installationId: event.installation.id,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        visibility,
        signal
      });
    } catch (error) {
      // The index service signals cancellation with the platform's AbortError, which is not a
      // WebhookAbortedError. failClaimedWebhook keys retry-credit off that class, so a raw
      // AbortError would consume an attempt and could eventually dead-letter a job that was only
      // ever interrupted by shutdown. Normalised here, as the backend call sites already do.
      if (isShutdownAbort(error, signal)) throw asWebhookAborted(error);
      throw error;
    }
    throwIfAborted(signal);
    if (refresh) {
      const [owner, repo] = repository.full_name.split("/");
      await this.refreshScannerStateFromConfig(
        github,
        repository.id,
        owner,
        repo,
        refresh.commitSha
      );
    }
  }

  private async loadRepositoryContext(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    ref: string
  ): Promise<LoadedRepositoryContext> {
    const configFile = await github.getFile(owner, repo, ".guardianbot/config.yml", ref);
    let config: GuardianConfig | undefined;
    if (configFile) {
      try {
        config = parseGuardianConfig(configFile.content);
      } catch {
        config = undefined;
      }
    }
    let codeOwnersPath: string | undefined;
    let codeOwnersSource: string | undefined;
    for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      const file = await github.getFile(owner, repo, path, ref);
      if (!file) continue;
      codeOwnersPath = path;
      codeOwnersSource = file.content;
      break;
    }
    return {
      config,
      configSource: configFile?.content,
      codeOwnersPath,
      codeOwnersSource,
      scannerConfigured: Boolean(config)
    };
  }

  private async loadIndexedReviewContext(
    input: IndexedReviewContextInput
  ): Promise<LoadedIndexReviewContext> {
    const repositoryIndexService = this.options.repositoryIndexService;
    if (!repositoryIndexService) {
      return {
        candidates: [],
        partial: true,
        warning: "exact-base repository index context was unavailable because indexing is not configured"
      };
    }
    if (!/^[a-f0-9]{40}$/.test(input.baseSha)) {
      return {
        candidates: [],
        partial: true,
        warning: "exact-base repository index context was unavailable because the base SHA was invalid"
      };
    }
    try {
      // Descriptor-first: never load index_document on the production review path.
      // Identity comes from columns; candidates come from bounded durable rows/edges.
      let descriptor: RepositoryIndexDescriptor | undefined;
      try {
        descriptor = await repositoryIndexService.loadRepositoryIndexDescriptor(
          input.repositoryId,
          input.baseSha
        );
      } catch (error) {
        // Isolation vs stored-data faults must not read the same way to an operator.
        // Matched by name rather than instanceof (workspace package boundary).
        const isolated =
          error instanceof Error && error.name === "RepositoryIsolationError";
        this.metrics.increment("repository_index_durable_unavailable_total");
        return {
          candidates: [],
          partial: true,
          warning: isolated
            ? "repository index context was rejected by repository isolation checks"
            : "repository index context was rejected because its stored identity could not be read"
        };
      }
      if (!descriptor) {
        this.metrics.increment("repository_index_durable_unavailable_total");
        return {
          candidates: [],
          partial: true,
          warning: `exact-base repository index context was unavailable for ${input.baseSha.slice(0, 12)}`
        };
      }
      if (
        descriptor.repository !== input.repositoryFullName ||
        descriptor.repositoryScope !== `github:${input.repositoryId}` ||
        descriptor.visibility !== input.visibility ||
        descriptor.commitSha !== input.baseSha
      ) {
        this.metrics.increment("repository_index_durable_unavailable_total");
        return {
          candidates: [],
          partial: true,
          warning: "repository index context was rejected by repository isolation checks"
        };
      }
      try {
        // Storage key is re-derived and confirmed, never trusted as stored.
        assertDescriptorReference(descriptor, {
          repositoryScope: `github:${input.repositoryId}`,
          commitSha: input.baseSha
        });
      } catch {
        this.metrics.increment("repository_index_durable_unavailable_total");
        return {
          candidates: [],
          partial: true,
          warning: "repository index context was rejected by repository isolation checks"
        };
      }

      const embeddingProvider = repositoryIndexService.retrievalEmbeddingProvider(
        descriptor.embedding
      );
      const result = await retrieveDurableRepositoryContext({
        descriptor,
        repositoryScope: `github:${input.repositoryId}`,
        commitSha: input.baseSha,
        changes: buildIndexChanges(input.files),
        query: input.query,
        limit: REPOSITORY_CONTEXT_LIMIT,
        primaryPolicy: {
          repositoryScope: `github:${input.repositoryId}`,
          visibility: input.visibility,
          allowedRelatedRepositories: []
        },
        embeddingProvider,
        source: repositoryIndexService.durableRepositoryContextSource(input.repositoryId)
      });
      const adapted = retrievalToReviewContextCandidates(result);
      const candidates = adapted.map((candidate, contextIndex) => {
        const metadata = result.contexts[contextIndex]!;
        return {
          ...candidate,
          id: [
            "repository-index",
            metadata.repositoryScope,
            metadata.commitSha,
            metadata.id,
            metadata.contentSha256
          ].join(":"),
          content: redactUntrustedText(candidate.content).slice(0, 12_000)
        };
      });
      const warnings: string[] = [];
      if (result.scope.partial) {
        warnings.push(
          `repository index retrieval used security-sensitive clusters for ${result.scope.selectedPaths.length}/${result.scope.totalFiles} changed files`
        );
      }
      if (result.droppedContextCount > 0) {
        warnings.push(
          `repository index retrieval omitted ${result.droppedContextCount} lower-ranked context chunk(s)`
        );
      }
      if (result.warnings?.length) {
        warnings.push(...result.warnings);
      }
      const truncated = Boolean(
        result.warnings?.some((warning) => warning.includes("truncated"))
      );
      if (truncated) {
        this.metrics.increment("repository_index_durable_truncated_total");
      } else {
        this.metrics.increment("repository_index_durable_success_total");
      }
      return {
        candidates,
        partial: result.partial,
        warning: warnings.length ? warnings.join("; ") : undefined
      };
    } catch {
      this.metrics.increment("repository_index_durable_unavailable_total");
      return {
        candidates: [],
        partial: true,
        warning: "exact-base repository index context failed validation or retrieval and was omitted"
      };
    }
  }

  private async publishUnavailable(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    repositoryId: number,
    pull: GitHubPull,
    placeholderCommentId: number,
    existing: ReviewState | undefined,
    scannerConfigured: boolean,
    reason: "no-route" | "capability" | "transport" | "invalid-output",
    fence?: WebhookLeaseFence
  ): Promise<void> {
    const now = this.now();
    const lifecycle = preserveFindingStates(
      existing,
      pull.head.sha,
      now,
      this.reviewFindingRetention
    );
    const findings = lifecycle.findings;
    const saved = await this.store.saveReview(
      {
        repositoryId,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        reviewedHeadSha: existing?.reviewedHeadSha,
        placeholderCommentId,
        findings,
        findingsSchemaVersion: REVIEW_FINDINGS_SCHEMA_VERSION,
        findingsEvictedTotal: lifecycle.evicted,
        findingsLastEvictedAt: lifecycle.evicted
          ? now.toISOString()
          : existing?.findingsLastEvictedAt
      },
      pull.head.sha,
      // Fenced for the same reason as the success path: a worker whose lease was reclaimed must
      // not overwrite the review the new owner already published with an "unavailable" row.
      this.fenceAsOf(fence)
    );
    if (!saved) {
      this.metrics.increment("review_stale_total");
      return;
    }
    await github.updateComment(
      owner,
      repo,
      placeholderCommentId,
      renderUnavailable(
        pull.head.sha,
        scannerConfigured,
        lifecycleSummary(findings),
        reason
      )
    );
  }

  private async publishStale(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    repositoryId: number,
    pull: GitHubPull,
    currentHeadSha: string,
    placeholderCommentId: number,
    existing: ReviewState | undefined,
    scannerConfigured: boolean,
    fence?: WebhookLeaseFence
  ): Promise<void> {
    this.metrics.increment("review_stale_total");
    const now = this.now();
    // Output for this head never published, so every still-open finding is superseded rather
    // than resolved regardless of where the reviewed head sits.
    const lifecycle = evictTerminalReviewFindings(
      (existing?.findings ?? []).map((finding) =>
        finding.state === "open"
          ? transitionFindingState(finding, "superseded", pull.head.sha, now)
          : finding
      ),
      this.reviewFindingRetention,
      now
    );
    const findings = lifecycle.findings;
    const saved = await this.store.saveReview(
      {
        repositoryId,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        reviewedHeadSha: existing?.reviewedHeadSha,
        placeholderCommentId,
        findings,
        findingsSchemaVersion: REVIEW_FINDINGS_SCHEMA_VERSION,
        findingsEvictedTotal: lifecycle.evicted,
        findingsLastEvictedAt: lifecycle.evicted
          ? now.toISOString()
          : existing?.findingsLastEvictedAt
      },
      pull.head.sha,
      // Fenced for the same reason as the success path: a worker whose lease was reclaimed must
      // not overwrite the review the new owner already published with an "unavailable" row.
      this.fenceAsOf(fence)
    );
    if (!saved) return;
    await github.updateComment(
      owner,
      repo,
      placeholderCommentId,
      renderStaleReview(
        pull.head.sha,
        currentHeadSha,
        scannerConfigured,
        lifecycleSummary(findings)
      )
    );
  }

  private async getCurrentPull(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPull | undefined> {
    try {
      return await github.request<GitHubPull>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${pullNumber}`
      );
    } catch (error) {
      if (String(error).includes("returned 404")) return undefined;
      throw error;
    }
  }

  private async resolveReviewFileScope(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    pull: GitHubPull,
    existing: ReviewState | undefined,
    incrementalEnabled: boolean,
    execution: ReviewExecutionOptions
  ): Promise<ReviewFileScope> {
    const full = async (summary: string): Promise<ReviewFileScope> => ({
      files: await this.listPullFiles(github, owner, repo, pull.number),
      baseSha: pull.base.sha,
      summary
    });
    if (execution.full) {
      return full("full pull-request diff requested by a maintainer");
    }
    if (!incrementalEnabled) {
      return full("full pull-request diff; incremental review is disabled or unavailable");
    }
    const lastReviewedHeadSha = existing?.reviewedHeadSha;
    if (!lastReviewedHeadSha) {
      return full("full pull-request diff; no prior reviewed head exists");
    }
    if (lastReviewedHeadSha === pull.head.sha) {
      return full("full pull-request recheck; the recorded review head already matches");
    }
    if (
      !/^[a-f0-9]{40}$/.test(lastReviewedHeadSha) ||
      !/^[a-f0-9]{40}$/.test(pull.head.sha)
    ) {
      return full("full pull-request fallback; the prior comparison SHA was invalid");
    }

    try {
      const comparison = await github.request<{
        status: string;
        base_commit?: { sha: string };
        merge_base_commit?: { sha: string };
        head_commit?: { sha: string };
        files?: GitHubPullFile[];
      }>(
        "GET",
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(lastReviewedHeadSha)}...${encodeURIComponent(pull.head.sha)}?per_page=100`
      );
      const ancestryVerified =
        comparison.status === "ahead" &&
        comparison.base_commit?.sha === lastReviewedHeadSha &&
        comparison.merge_base_commit?.sha === lastReviewedHeadSha &&
        comparison.head_commit?.sha === pull.head.sha;
      if (!ancestryVerified || !Array.isArray(comparison.files)) {
        return full(
          "full pull-request fallback; GitHub did not verify the prior review head as an ancestor"
        );
      }
      return {
        files: comparison.files,
        baseSha: lastReviewedHeadSha,
        summary: `incremental diff from ${lastReviewedHeadSha.slice(0, 12)} to ${pull.head.sha.slice(0, 12)}`,
        ...(comparison.files.length >= 300
          ? {
              partialReason:
                "GitHub compare reached its 300-file response ceiling; incremental context may be incomplete"
            }
          : {})
      };
    } catch (error) {
      if (
        !/returned (404|409|422)\b/.test(String(error))
      ) {
        throw error;
      }
      return full(
        "full pull-request fallback; incremental comparison was unavailable"
      );
    }
  }

  private async listPullFiles(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullFile[]> {
    const files: GitHubPullFile[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await github.request<GitHubPullFile[]>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  private async listReviewComments(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubReviewComment[]> {
    const comments: GitHubReviewComment[] = [];
    for (let page = 1; page <= MAX_REVIEW_COMMENT_PAGES; page += 1) {
      const batch = await github.request<GitHubReviewComment[]>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100&page=${page}`
      );
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return comments;
  }

  /**
   * True only for a top-level inline comment GuardianBot itself published. A reviewer using
   * GitHub's "Quote reply" on an advisory copies the quoted body verbatim, HTML comments included,
   * so the fingerprint marker alone does not establish authorship: rewriting such a comment would
   * bury a reviewer's own words in a closed-finding block. Replies are excluded outright because
   * they are reviewer conversation, and the author must be an App identity.
   */
  private isOwnInlineAdvisory(comment: GitHubReviewComment): boolean {
    if (comment.in_reply_to_id !== undefined && comment.in_reply_to_id !== null) return false;
    return Boolean(comment.user?.login?.endsWith(BOT_LOGIN_SUFFIX));
  }

  /**
   * Rewrites published inline comments whose findings reached a terminal state, so stale
   * advisories stop accumulating on long-lived pull requests. Comments are located by the
   * existing fingerprint marker and updated in place rather than deleted, which preserves any
   * reviewer conversation hanging off them. Only GuardianBot's own top-level advisories are
   * eligible, so a reviewer quoting an advisory keeps their comment intact and does not consume
   * the rewrite budget. Already-rewritten comments are skipped, so repeated reviews of the same
   * pull request converge instead of rewriting every time.
   *
   * Per-comment failures are absorbed: a reviewer may delete a comment between listing and
   * patching, and that must not fail a review whose advisory summary is otherwise publishable.
   */
  private async closeTerminalInlineComments(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    comments: readonly GitHubReviewComment[],
    findings: readonly ReviewFindingRecord[],
    headSha: string,
    signal?: AbortSignal
  ): Promise<number> {
    const terminal = new Map(
      findings
        .filter((finding) => finding.state !== "open")
        .map((finding) => [markerDigest(finding.fingerprint), finding.state])
    );
    if (!terminal.size) return 0;
    let closed = 0;
    for (const comment of comments) {
      // Deliberately outside the try below: that catch absorbs per-comment GitHub failures, and
      // swallowing the abort here would let shutdown keep PATCHing for the rest of the loop.
      // Stopping at a comment boundary is safe because each rewrite is independent and
      // idempotent — a retry re-lists the comments and `isClosedFindingComment` skips the ones
      // already rewritten, so the remainder is completed rather than redone.
      throwIfAborted(signal);
      if (closed >= MAX_CLOSED_INLINE_UPDATES) break;
      if (!this.isOwnInlineAdvisory(comment)) continue;
      if (isClosedFindingComment(comment.body)) continue;
      const marker = extractFindingMarker(comment.body);
      const state = marker ? terminal.get(marker) : undefined;
      if (!state || state === "open") continue;
      try {
        // Inline review comments live under /pulls/comments, not the /issues/comments path the
        // shared updateComment helper targets.
        await github.request(
          "PATCH",
          `/repos/${owner}/${repo}/pulls/comments/${comment.id}`,
          { body: renderClosedInlineFinding(comment.body, state, headSha) }
        );
        closed += 1;
      } catch (error) {
        if (String(error).startsWith("GitHub ")) {
          this.metrics.increment("github_failures_total");
        }
      }
    }
    return closed;
  }

  /**
   * Fetches one inline review comment. A reviewer may delete the advisory between the reply
   * landing and this lookup, which is an ordinary race rather than a failure, so a missing comment
   * reads as absent instead of raising.
   */
  private async getReviewComment(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    commentId: number
  ): Promise<GitHubReviewComment | undefined> {
    try {
      return await github.request<GitHubReviewComment>(
        "GET",
        `/repos/${owner}/${repo}/pulls/comments/${commentId}`
      );
    } catch (error) {
      if (String(error).includes("returned 404")) return undefined;
      throw error;
    }
  }

  /**
   * Records that a human engaged with a published advisory, keyed by the advisory's own finding
   * fingerprint. Only the derived signal is retained — that an engagement happened, and when — so
   * no reviewer identity and no comment text reaches the store.
   *
   * The author gate is deliberately the inverse of the closing path's. Closure rewrites only
   * GuardianBot's own comments, because rewriting a reviewer's words would destroy them. Feedback
   * is the opposite: the interesting event is a *human* responding to a GuardianBot advisory, so a
   * bot-authored comment is skipped here and GuardianBot replying to itself never counts as
   * engagement. Both gates are needed at once, on different comments: the new comment must be
   * human-authored, and its parent must be GuardianBot's own top-level advisory.
   *
   * The fingerprint marker is read from that parent, never from the reply. `extractFindingMarker`
   * is anchored to the start of a body, and a reply — including one produced by "Quote reply" —
   * does not carry the marker there, so reading the reply would capture nothing at all.
   *
   * Every unexpected shape returns rather than throwing: this event is not subscribed on the live
   * installation, so the first real payloads will arrive only after an operator applies the
   * manifest change, and an unfamiliar field must not turn into a failed delivery.
   */
  private async captureReviewCommentFeedback(
    event: GitHubEvent,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    const comment = event.comment;
    if (!comment || typeof comment !== "object") return;
    const commentId = positiveIdentifier(comment.id);
    // Absent on a top-level comment, which is not a response to anything and is ignored before
    // any store read or GitHub call.
    const parentId = positiveIdentifier(comment.in_reply_to_id);
    const pullNumber = positiveIdentifier(event.pull_request?.number);
    const login = typeof comment.user?.login === "string" ? comment.user.login : "";
    if (!commentId || !parentId || !pullNumber || !login) return;
    if (login.endsWith(BOT_LOGIN_SUFFIX)) return;
    const repositoryId = positiveIdentifier(event.repository?.id);
    const fullName =
      typeof event.repository?.full_name === "string" ? event.repository.full_name : "";
    const [owner, repo] = fullName.split("/");
    // The installation identifier is what the client is minted from, so it is checked here rather
    // than left to fail inside the client factory on a payload missing it.
    if (!repositoryId || !owner || !repo || !positiveIdentifier(event.installation?.id)) return;
    const repository = await this.store.getRepository(repositoryId);
    if (repository && repository.repositoryState !== "active") return;
    const review = await this.store.getReview(repositoryId, pullNumber);
    if (!review?.findings.length) return;
    // Markers carry the digest of a fingerprint, so the retained findings of this repository's own
    // review are what resolve one back to a fingerprint. A marker from an unrelated advisory has
    // no entry here and is dropped.
    const fingerprintsByDigest = new Map(
      review.findings.map((finding) => [markerDigest(finding.fingerprint), finding.fingerprint])
    );
    const github = await this.client(event, [repositoryId]);
    const parent = await this.getReviewComment(github, owner, repo, parentId);
    if (!parent || typeof parent.body !== "string") return;
    if (!this.isOwnInlineAdvisory(parent)) return;
    const marker = extractFindingMarker(parent.body);
    const fingerprint = marker ? fingerprintsByDigest.get(marker) : undefined;
    if (!fingerprint) return;
    const recorded = await this.store.recordFindingFeedback({
      repositoryId,
      pullNumber,
      fingerprint,
      commentId,
      observedAt: this.now()
    });
    // Counted only on a state change, so a redelivered comment cannot inflate the signal.
    if (recorded) this.metrics.increment("finding_feedback_total");
  }

  private async getActorPermission(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    actor: string
  ): Promise<string> {
    try {
      const result = await github.request<{ permission: string }>(
        "GET",
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(actor)}/permission`
      );
      return result.permission;
    } catch (error) {
      if (String(error).includes("returned 404")) return "none";
      throw error;
    }
  }

  private assertCapabilities(
    capabilities: BackendCapabilities,
    profile: ReviewProfile,
    classification: DataClassification
  ): void {
    if (capabilities.protocolVersion !== "guardian.review.v1") {
      throw new BackendError("refusal", "backend protocol version is not supported", false);
    }
    if (!capabilities.structuredOutput) {
      throw new BackendError("refusal", "backend lacks strict structured output", false);
    }
    if (!capabilities.supportedProfiles.includes(profile)) {
      throw new BackendError("refusal", "backend does not support the routed profile", false);
    }
    if (!capabilities.supportedDataClassifications.includes(classification)) {
      throw new BackendError(
        "refusal",
        "backend does not support the repository data classification",
        false
      );
    }
    if (capabilities.maxInputCharacters < REQUEST_ENVELOPE_RESERVE + 1_000) {
      throw new BackendError("context_limit", "backend input capability is too small", false);
    }
    if (capabilities.retention === "unknown") {
      throw new BackendError("refusal", "backend retention capability is unknown", false);
    }
  }
}

function normalizeBackendFailure(
  error: unknown,
  phase: "capability" | "review"
): BackendError {
  if (error instanceof BackendError) {
    if (error.code === "invalid_output") {
      return new BackendError("invalid_output", error.message, false);
    }
    return error;
  }
  return new BackendError(
    "invalid_output",
    `${phase} response failed strict protocol validation`,
    false
  );
}

function unavailableReason(
  error: BackendError
): "capability" | "transport" | "invalid-output" {
  if (
    error.code === "timeout" ||
    error.code === "unavailable" ||
    error.code === "rate_limit"
  ) {
    return "transport";
  }
  if (error.code === "invalid_output") return "invalid-output";
  return "capability";
}

function computeBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

/**
 * Rate limits are matched by name and shape rather than class identity because the
 * error crosses a workspace package boundary, where a duplicate module instance would
 * defeat instanceof. Mirrors the existing AbortError/TimeoutError checks.
 */
function rateLimitDetails(
  error: unknown
): { retryAt: Date; remaining: number | undefined } | undefined {
  if (!(error instanceof Error) || error.name !== "GitHubRateLimitError") return undefined;
  const { retryAt, remaining } = error as { retryAt?: unknown; remaining?: unknown };
  if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime())) return undefined;
  return {
    retryAt,
    remaining: typeof remaining === "number" && Number.isFinite(remaining) ? remaining : undefined
  };
}

/** Cooperative cancellation checkpoint — never used to detach work from its lease owner. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WebhookAbortedError();
}

function isShutdownAbort(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof WebhookAbortedError) return true;
  // Once the external shutdown signal is aborted, treat any error as cancellation so
  // a wrapped/translated failure cannot become "AI review unavailable" output.
  return Boolean(signal?.aborted);
}

function asWebhookAborted(error: unknown): WebhookAbortedError {
  return error instanceof WebhookAbortedError ? error : new WebhookAbortedError();
}

/**
 * Reads a positive integer identifier out of an untrusted payload field. Webhook payloads are
 * attacker-influenced and, for an event this instance may never have received before, of unproven
 * shape, so anything that is not a usable identifier reads as absent rather than as zero or NaN.
 */
function positiveIdentifier(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function repositoryVisibility(repository: any): RepositoryVisibility {
  const visibility = String(repository?.visibility ?? "").toLowerCase();
  if (
    visibility === "public" ||
    visibility === "private" ||
    visibility === "internal"
  ) {
    return visibility;
  }
  return repository?.private ? "private" : "public";
}

function buildIndexChanges(files: GitHubPullFile[]): IndexChangedFile[] {
  const changes = new Map<string, IndexChangedFile>();
  for (const file of files) {
    const path =
      file.status === "renamed" && file.previous_filename
        ? file.previous_filename
        : file.filename;
    const additions = file.additions ?? countPatchLines(file.patch ?? "", "+");
    const deletions = file.deletions ?? countPatchLines(file.patch ?? "", "-");
    const patch = file.patch?.slice(0, 20_000);
    const existing = changes.get(path);
    if (!existing) {
      changes.set(path, { path, additions, deletions, patch });
      continue;
    }
    existing.additions = Math.min(Number.MAX_SAFE_INTEGER, existing.additions + additions);
    existing.deletions = Math.min(Number.MAX_SAFE_INTEGER, existing.deletions + deletions);
    existing.patch = [existing.patch, patch]
      .filter((value): value is string => Boolean(value))
      .join("\n")
      .slice(0, 20_000) || undefined;
  }
  return [...changes.values()];
}

function filePriority(file: GitHubPullFile): number {
  const sensitive = HIGH_RISK_PATH.test(file.filename) ? 10_000 : 0;
  const additions = file.additions ?? countPatchLines(file.patch ?? "", "+");
  const changes = file.changes ?? countChangedLines(file);
  const patchLength = file.patch?.length ?? 0;
  return sensitive + changes * 10 + additions * 5 + patchLength;
}

function countPatchLines(patch: string, prefix: "+" | "-"): number {
  return patch
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}

function countChangedLines(file: GitHubPullFile): number {
  return file.changes ??
    (file.additions ?? countPatchLines(file.patch ?? "", "+")) +
      (file.deletions ?? countPatchLines(file.patch ?? "", "-"));
}

function selectFilesForReview(files: GitHubPullFile[]): SelectedReviewFiles {
  const sorted = [...files].sort(
    (left, right) =>
      filePriority(right) - filePriority(left) ||
      left.filename.localeCompare(right.filename)
  );
  const selected: GitHubPullFile[] = [];
  const omittedFiles: string[] = [];
  let selectedLines = 0;
  let omittedLines = 0;
  for (const file of sorted) {
    const fileLines = countChangedLines(file);
    const wouldExceedLineBudget =
      selected.length > 0 &&
      selectedLines + fileLines > REVIEW_LINE_LIMIT &&
      !HIGH_RISK_PATH.test(file.filename);
    if (selected.length >= REVIEW_FILE_LIMIT || wouldExceedLineBudget) {
      omittedFiles.push(file.filename);
      omittedLines += fileLines;
      continue;
    }
    selected.push(file);
    selectedLines += fileLines;
  }
  const totalChangedLines = sorted.reduce(
    (sum, file) => sum + countChangedLines(file),
    0
  );
  return {
    files: selected,
    partial:
      omittedFiles.length > 0 ||
      sorted.length > REVIEW_FILE_LIMIT ||
      totalChangedLines > REVIEW_LINE_LIMIT,
    totalFiles: sorted.length,
    totalChangedLines,
    omittedFiles,
    omittedChangedLines: omittedLines
  };
}

export function addedLineRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let newLine = 0;
  let active: { start: number; end: number } | undefined;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      if (active) ranges.push(active);
      active = undefined;
      newLine = Number(header[1]);
      continue;
    }
    if (!newLine) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (active && active.end === newLine - 1) active.end = newLine;
      else {
        if (active) ranges.push(active);
        active = { start: newLine, end: newLine };
      }
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (active) ranges.push(active);
      active = undefined;
    } else {
      if (active) ranges.push(active);
      active = undefined;
      if (!line.startsWith("\\")) newLine += 1;
    }
  }
  if (active) ranges.push(active);
  return ranges;
}

export function redactUntrustedText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_ACCESS_KEY]")
    .replace(
      /(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /((?:api[_-]?key|secret|password|token)\s*[:=]\s*)["']?[^\s"',}]+/gi,
      "$1[REDACTED]"
    );
}

/**
 * Records a lifecycle transition. Provenance is only touched when the state actually changes, so
 * a re-render of an unchanged record neither inflates the transition count nor resets the
 * observation timestamps that eviction ages findings against.
 */
function transitionFindingState(
  finding: ReviewFindingRecord,
  state: ReviewFindingLifecycleState,
  headSha: string,
  now: Date
): ReviewFindingRecord {
  if (finding.state === state) return finding;
  return {
    ...finding,
    state,
    lastSeenHeadSha: headSha,
    lastSeenAt: now.toISOString(),
    transitions: (finding.transitions ?? 0) + 1
  };
}

/**
 * Merges a freshly reported finding into its retained provenance. Identity is refreshed from the
 * current report so presentation reflects where the finding now sits, while first-seen provenance
 * is preserved. A finding arriving `open` after a terminal state is a genuine reappearance and is
 * counted as such, which is what makes a regression after a resolved finding detectable.
 */
function observeFindingState(
  retained: ReviewFindingRecord | undefined,
  finding: ReviewFinding,
  headSha: string,
  now: Date
): ReviewFindingRecord {
  const nowIso = now.toISOString();
  const identity = {
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    category: finding.category,
    severity: finding.severity,
    title: finding.title
  };
  if (!retained) {
    return {
      fingerprint: finding.fingerprint,
      state: "open",
      firstSeenHeadSha: headSha,
      lastSeenHeadSha: headSha,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      transitions: 0,
      reappearances: 0,
      ...identity
    };
  }
  const reappeared = retained.state !== "open";
  return {
    ...retained,
    ...identity,
    fingerprint: finding.fingerprint,
    state: "open",
    // Pre-migration rows carry no first-seen provenance; this head is the earliest known sighting.
    firstSeenHeadSha: retained.firstSeenHeadSha ?? headSha,
    firstSeenAt: retained.firstSeenAt ?? nowIso,
    lastSeenHeadSha: headSha,
    lastSeenAt: nowIso,
    transitions: (retained.transitions ?? 0) + (reappeared ? 1 : 0),
    reappearances: (retained.reappearances ?? 0) + (reappeared ? 1 : 0)
  };
}

function preserveFindingStates(
  existing: ReviewState | undefined,
  headSha: string,
  now: Date,
  retention: ReviewFindingRetentionOptions
): EvictReviewFindingsResult {
  const preserved = (existing?.findings ?? []).map((finding) =>
    existing?.reviewedHeadSha !== headSha && finding.state === "open"
      ? transitionFindingState(finding, "superseded", headSha, now)
      : finding
  );
  return evictTerminalReviewFindings(preserved, retention, now);
}

function canonicalizeFindingFingerprints(
  findings: ReviewFinding[]
): ReviewFinding[] {
  const fingerprints = new Set<string>();
  return findings.map((finding) => {
    const fingerprint = stableFingerprint([
      "guardianbot-review-finding-v1",
      finding.category,
      finding.path,
      finding.startLine,
      finding.endLine,
      finding.title,
      finding.evidence
    ]);
    if (fingerprints.has(fingerprint)) {
      throw new BackendError(
        "invalid_output",
        "backend returned semantically duplicate findings",
        false
      );
    }
    fingerprints.add(fingerprint);
    return { ...finding, fingerprint };
  });
}

function mergeFindingStates(
  existing: ReviewState | undefined,
  headSha: string,
  findings: ReviewFinding[],
  now: Date,
  retention: ReviewFindingRetentionOptions
): EvictReviewFindingsResult {
  const current = new Set(findings.map((finding) => finding.fingerprint));
  const retained = new Map(
    (existing?.findings ?? []).map((finding) => [finding.fingerprint, finding])
  );
  const previous = (existing?.findings ?? [])
    .filter((finding) => !current.has(finding.fingerprint))
    .map((finding) =>
      finding.state !== "open"
        ? finding
        : transitionFindingState(
            finding,
            // A finding that vanished while the reviewed head stayed put is genuinely resolved;
            // one that vanished across a head move is merely superseded.
            existing?.reviewedHeadSha === headSha ? "resolved" : "superseded",
            headSha,
            now
          )
    );
  const merged = [
    ...previous,
    ...findings.map((finding) =>
      observeFindingState(retained.get(finding.fingerprint), finding, headSha, now)
    )
  ];
  return evictTerminalReviewFindings(merged, retention, now);
}

/**
 * Splits the reported findings into the set that drives lifecycle state and the smaller set that
 * is published inline. Both start from the same P0–P2 filter, and only the inline set is capped:
 * lifecycle state must see everything the model reported, because a finding absent from it is
 * treated as no longer reported and closed, which would tell a reviewer that a finding from this
 * very run was resolved and would rewrite its still-valid inline comment.
 */
export function selectReviewFindings(
  findings: readonly ReviewFinding[],
  maxInlineComments: number
): { lifecycle: ReviewFinding[]; inline: ReviewFinding[] } {
  const lifecycle = findings.filter(
    (finding) =>
      finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2"
  );
  return { lifecycle, inline: lifecycle.slice(0, maxInlineComments) };
}

/**
 * Counts findings that returned to `open` from a terminal state in this review. Reappearance is
 * the regression signal the retained provenance exists to expose, so it is measured at the moment
 * it happens rather than inferred later from a cumulative counter.
 */
function countReappearances(
  previous: readonly ReviewFindingRecord[] | undefined,
  merged: readonly ReviewFindingRecord[]
): number {
  const before = new Map(
    (previous ?? []).map((finding) => [finding.fingerprint, finding.reappearances ?? 0])
  );
  return merged.filter(
    (finding) =>
      finding.state === "open" &&
      (finding.reappearances ?? 0) > (before.get(finding.fingerprint) ?? 0)
  ).length;
}

function lifecycleSummary(
  findings: readonly ReviewFindingRecord[]
): FindingLifecycleSummary {
  const open = findings.filter((finding) => finding.state === "open");
  return {
    open: open.length,
    // Counted among the open findings, not alongside them: a returned finding is live advisory
    // state, and it is surfaced here so the regression is visible while it still matters rather
    // than only once the finding closes a second time.
    reappeared: open.filter((finding) => (finding.reappearances ?? 0) > 0).length,
    resolved: findings.filter((finding) => finding.state === "resolved").length,
    superseded: findings.filter((finding) => finding.state === "superseded").length,
    // Retained findings carrying engagement, counted across all states: a reviewer replying to an
    // advisory that later resolved is exactly the signal worth keeping. Left undefined when
    // nothing is recorded, so an installation not subscribed to the review-comment event renders
    // no engagement segment rather than a zero that would read as measured-and-none.
    engaged:
      findings.filter((finding) => (finding.feedbackCount ?? 0) > 0).length || undefined
  };
}

function markerDigest(fingerprint: string): string {
  return /guardianbot-finding:([a-f0-9]{64})/.exec(findingMarker(fingerprint))?.[1] ??
    stableFingerprint(["finding", fingerprint]);
}

function groupChangedFiles(files: GitHubPullFile[]): ReviewFileGroup[] {
  const groups = new Map<string, GitHubPullFile[]>();
  for (const file of [...files].sort((left, right) => left.filename.localeCompare(right.filename))) {
    const slash = file.filename.indexOf("/");
    const component = slash > 0 ? file.filename.slice(0, slash) : "repository root";
    groups.set(component, [...(groups.get(component) ?? []), file]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([title, grouped]) => {
      const statusCounts = new Map<string, number>();
      for (const file of grouped) {
        statusCounts.set(file.status, (statusCounts.get(file.status) ?? 0) + 1);
      }
      const statuses = [...statusCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");
      const paths = grouped.slice(0, 12).map((file) => file.filename);
      if (grouped.length > paths.length) {
        paths.push(`… ${grouped.length - paths.length} more file(s)`);
      }
      return {
        title,
        paths,
        summary: `${grouped.length} file(s), ${grouped.reduce((sum, file) => sum + countChangedLines(file), 0)} changed lines (${statuses})`
      };
    });
}

function extractLinkedIssues(title: string, body: string): string[] {
  const source = `${title}\n${body}`;
  const references = new Set<string>();
  for (const match of source.matchAll(/(?:^|[\s(])((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\b/g)) {
    if (match[1]) references.add(match[1]);
  }
  for (const match of source.matchAll(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\b/g
  )) {
    references.add(`${match[1]}#${match[2]}`);
  }
  return [...references].sort();
}

function pathMatchesPattern(pattern: string, path: string): boolean {
  const normalized = pattern.replace(/^\/+/, "");
  if (!normalized) return false;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  const directory = normalized.endsWith("/") ? ".*" : "";
  const prefix = normalized.includes("/") ? "^" : "(?:^|/)";
  return new RegExp(`${prefix}${escaped}${directory}$`).test(path);
}

function matchingCodeOwners(source: string, paths: string[]): string[] {
  const rules: Array<{ pattern: string; owners: string[] }> = [];
  for (const rawLine of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const pattern = fields[0];
    const owners = fields.slice(1).filter((field) => /^@[A-Za-z0-9_.\-/]+$/.test(field));
    if (!pattern || !owners.length) continue;
    rules.push({ pattern, owners });
  }
  const matched = new Set<string>();
  for (const path of paths) {
    let owners: string[] = [];
    for (const rule of rules) {
      if (pathMatchesPattern(rule.pattern, path)) owners = rule.owners;
    }
    for (const owner of owners) matched.add(owner);
  }
  return [...matched].sort();
}

function buildPartialWarning(
  selected: SelectedReviewFiles,
  reviewedFiles: number,
  reviewedChangedLines: number,
  truncatedPaths: string[],
  unavailablePatchPaths: string[],
  bundleDrops: number,
  backendPartial: boolean,
  scopePartialReason?: string,
  indexWarning?: string
): string {
  const reasons: string[] = [];
  if (scopePartialReason) reasons.push(scopePartialReason);
  if (indexWarning) reasons.push(indexWarning);
  if (
    selected.totalFiles > REVIEW_FILE_LIMIT ||
    selected.totalChangedLines > REVIEW_LINE_LIMIT
  ) {
    reasons.push(
      `scope exceeded 50 files or 5,000 changed lines; diff context covered ${reviewedFiles}/${selected.totalFiles} files and ${reviewedChangedLines}/${selected.totalChangedLines} changed lines`
    );
  } else if (selected.omittedFiles.length) {
    reasons.push(
      `diff context covered ${reviewedFiles}/${selected.totalFiles} files and ${reviewedChangedLines}/${selected.totalChangedLines} changed lines`
    );
  }
  if (truncatedPaths.length) {
    reasons.push(
      `${truncatedPaths.length} oversized patch(es) were truncated before bundling`
    );
  }
  if (unavailablePatchPaths.length) {
    reasons.push(
      `${unavailablePatchPaths.length} changed file(s) had no textual patch context`
    );
  }
  if (bundleDrops) reasons.push(`${bundleDrops} context item(s) were dropped by the deterministic bundle budget`);
  if (backendPartial) reasons.push("the backend marked its review incomplete");
  return reasons.join("; ") || "review context was incomplete";
}

function safeInline(value: string): string {
  return value.replace(/`/g, "ˋ").replace(/[\r\n\u0000]/g, " ").slice(0, 200);
}

function commentMatchesIdentifier(body: string, identifier: string): boolean {
  const normalized = identifier.toLowerCase();
  const id = /Finding ID:\s*`([^`]+)`/i.exec(body)?.[1]?.toLowerCase();
  const fingerprint = /Fingerprint:\s*`([^`]+)`/i.exec(body)?.[1]?.toLowerCase();
  return id === normalized || Boolean(fingerprint?.startsWith(normalized));
}
