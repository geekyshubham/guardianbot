import type { RepositoryIndexRetrievalStatus, WebhookQueueCounts } from "./store.js";

type CounterName =
  | "webhook_verified_total"
  | "webhook_invalid_total"
  | "webhook_duplicate_total"
  | "webhook_enqueued_total"
  | "webhook_claimed_total"
  | "webhook_succeeded_total"
  | "webhook_failed_total"
  | "webhook_dead_letter_total"
  | "webhook_cleanup_deleted_total"
  | "webhook_cleanup_failures_total"
  | "review_stale_total"
  // Findings that returned to open after reaching a terminal state. Alerting on a regression
  // needs the reappearance at the moment it happens, not once the finding closes again.
  | "finding_reappeared_total"
  // Human engagements observed against published advisories. Deliberately a bare aggregate with
  // no labels at all: a per-reviewer or per-repository breakdown would put an identifier into a
  // metric label, where it would be retained by every scraper indefinitely.
  | "finding_feedback_total"
  | "commands_authorized_total"
  | "commands_rejected_total"
  | "github_failures_total"
  | "github_rate_limited_total"
  | "backend_failures_total"
  // Descriptor-first durable review retrieval outcomes. No repository labels:
  // success, truncation, and unavailable/fallback are bare aggregates only.
  | "repository_index_durable_success_total"
  | "repository_index_durable_truncated_total"
  | "repository_index_durable_unavailable_total";

export class GuardianMetrics {
  private readonly counters = new Map<CounterName, number>();
  private readonly latency = {
    count: 0,
    sumMs: 0,
    buckets: new Map<number, number>([
      [250, 0],
      [1000, 0],
      [5000, 0],
      [15000, 0],
      [60000, 0]
    ])
  };
  private queueDepth = 0;
  private pendingJobs = 0;
  private leasedJobs = 0;
  private deadLetterJobs = 0;
  private inFlight = 0;
  // Stays null until GitHub reports a budget so scrapers never read an unknown
  // remaining allowance as an exhausted one.
  private githubRateLimitRemaining: number | null = null;
  // Stays null until the store reports how retrieval is actually being served, for the same
  // reason: absent is not the same claim as healthy.
  private repositoryIndexRetrieval: RepositoryIndexRetrievalStatus | null = null;

  constructor() {
    for (const name of [
      "webhook_verified_total",
      "webhook_invalid_total",
      "webhook_duplicate_total",
      "webhook_enqueued_total",
      "webhook_claimed_total",
      "webhook_succeeded_total",
      "webhook_failed_total",
      "webhook_dead_letter_total",
      "webhook_cleanup_deleted_total",
      "webhook_cleanup_failures_total",
      "review_stale_total",
      "finding_reappeared_total",
      "finding_feedback_total",
      "commands_authorized_total",
      "commands_rejected_total",
      "github_failures_total",
      "github_rate_limited_total",
      "backend_failures_total",
      "repository_index_durable_success_total",
      "repository_index_durable_truncated_total",
      "repository_index_durable_unavailable_total"
    ] as CounterName[]) {
      this.counters.set(name, 0);
    }
  }

  increment(name: CounterName, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  observeWebhookLatency(milliseconds: number): void {
    this.latency.count += 1;
    this.latency.sumMs += milliseconds;
    for (const [bucket, count] of this.latency.buckets) {
      if (milliseconds <= bucket) this.latency.buckets.set(bucket, count + 1);
    }
  }

  setQueueDepth(queueDepth: number): void {
    this.queueDepth = queueDepth;
  }

  setQueueCounts(counts: WebhookQueueCounts): void {
    this.queueDepth = counts.runnable;
    this.pendingJobs = counts.pending;
    this.leasedJobs = counts.leased;
    this.deadLetterJobs = counts.deadLetter;
  }

  setInFlight(inFlight: number): void {
    this.inFlight = inFlight;
  }

  setGitHubRateLimitRemaining(remaining: number): void {
    this.githubRateLimitRemaining = remaining;
  }

  setRepositoryIndexRetrieval(status: RepositoryIndexRetrievalStatus): void {
    this.repositoryIndexRetrieval = status;
  }

  render(): string {
    const lines = [
      "# TYPE guardianbot_up gauge",
      "guardianbot_up 1",
      "# TYPE guardianbot_queue_depth gauge",
      `guardianbot_queue_depth ${this.queueDepth}`,
      "# TYPE guardianbot_webhook_jobs_pending gauge",
      `guardianbot_webhook_jobs_pending ${this.pendingJobs}`,
      "# TYPE guardianbot_webhook_jobs_leased gauge",
      `guardianbot_webhook_jobs_leased ${this.leasedJobs}`,
      "# TYPE guardianbot_webhook_jobs_dead_letter gauge",
      `guardianbot_webhook_jobs_dead_letter ${this.deadLetterJobs}`,
      "# TYPE guardianbot_jobs_in_flight gauge",
      `guardianbot_jobs_in_flight ${this.inFlight}`
    ];
    if (this.githubRateLimitRemaining !== null) {
      lines.push("# TYPE guardianbot_github_ratelimit_remaining gauge");
      lines.push(`guardianbot_github_ratelimit_remaining ${this.githubRateLimitRemaining}`);
    }
    const retrieval = this.repositoryIndexRetrieval;
    if (retrieval !== null) {
      // The mode is a closed union, never caller text, so it is safe as a label value.
      // Emitting it beside readiness is the point: pgvector mode with the approximate
      // index absent means every read is an exact scan, and that is indistinguishable
      // from a healthy install unless both series are present.
      lines.push("# TYPE guardianbot_repository_index_storage_mode gauge");
      lines.push(`guardianbot_repository_index_storage_mode{mode="${retrieval.mode}"} 1`);
      lines.push("# TYPE guardianbot_repository_index_ann_ready gauge");
      lines.push(
        `guardianbot_repository_index_ann_ready ${retrieval.approximateIndexReady ? 1 : 0}`
      );
      if (retrieval.uncoveredDurableVectorRows !== null) {
        lines.push("# TYPE guardianbot_repository_index_uncovered_vector_rows gauge");
        lines.push(
          `guardianbot_repository_index_uncovered_vector_rows ${retrieval.uncoveredDurableVectorRows}`
        );
      }
    }
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE guardianbot_${name} counter`);
      lines.push(`guardianbot_${name} ${value}`);
    }
    lines.push("# TYPE guardianbot_webhook_duration_ms histogram");
    // observeWebhookLatency already increments every bucket at or above the observed
    // value, so the stored counts are cumulative and must be emitted verbatim.
    for (const [bucket, count] of this.latency.buckets) {
      lines.push(`guardianbot_webhook_duration_ms_bucket{le="${bucket}"} ${count}`);
    }
    lines.push(`guardianbot_webhook_duration_ms_bucket{le="+Inf"} ${this.latency.count}`);
    lines.push(`guardianbot_webhook_duration_ms_sum ${this.latency.sumMs}`);
    lines.push(`guardianbot_webhook_duration_ms_count ${this.latency.count}`);
    return `${lines.join("\n")}\n`;
  }
}
