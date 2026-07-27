type CounterName =
  | "webhook_verified_total"
  | "webhook_invalid_total"
  | "webhook_duplicate_total"
  | "webhook_enqueued_total"
  | "webhook_claimed_total"
  | "webhook_succeeded_total"
  | "webhook_failed_total"
  | "webhook_dead_letter_total"
  | "review_stale_total"
  | "commands_authorized_total"
  | "commands_rejected_total"
  | "github_failures_total"
  | "backend_failures_total";

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
  private inFlight = 0;

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
      "review_stale_total",
      "commands_authorized_total",
      "commands_rejected_total",
      "github_failures_total",
      "backend_failures_total"
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

  setInFlight(inFlight: number): void {
    this.inFlight = inFlight;
  }

  render(): string {
    const lines = [
      "# TYPE guardianbot_up gauge",
      "guardianbot_up 1",
      "# TYPE guardianbot_queue_depth gauge",
      `guardianbot_queue_depth ${this.queueDepth}`,
      "# TYPE guardianbot_jobs_in_flight gauge",
      `guardianbot_jobs_in_flight ${this.inFlight}`
    ];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE guardianbot_${name} counter`);
      lines.push(`guardianbot_${name} ${value}`);
    }
    lines.push("# TYPE guardianbot_webhook_duration_ms histogram");
    let cumulative = 0;
    for (const [bucket, count] of this.latency.buckets) {
      cumulative += count;
      lines.push(`guardianbot_webhook_duration_ms_bucket{le="${bucket}"} ${cumulative}`);
    }
    lines.push(`guardianbot_webhook_duration_ms_bucket{le="+Inf"} ${this.latency.count}`);
    lines.push(`guardianbot_webhook_duration_ms_sum ${this.latency.sumMs}`);
    lines.push(`guardianbot_webhook_duration_ms_count ${this.latency.count}`);
    return `${lines.join("\n")}\n`;
  }
}
