import assert from "node:assert/strict";
import test from "node:test";
import { GuardianMetrics } from "../src/metrics.js";

type HistogramBucket = {
  readonly le: string;
  readonly count: number;
};

function parseWebhookDurationBuckets(rendered: string): HistogramBucket[] {
  return [
    ...rendered.matchAll(
      /^guardianbot_webhook_duration_ms_bucket\{le="([^"]+)"\} (\d+)$/gm
    )
  ].map((match) => ({ le: match[1] ?? "", count: Number(match[2]) }));
}

test("renders webhook latency buckets as valid cumulative counts", () => {
  const metrics = new GuardianMetrics();
  for (const milliseconds of [100, 500, 3000, 30_000, 120_000]) {
    metrics.observeWebhookLatency(milliseconds);
  }

  const rendered = metrics.render();
  const buckets = parseWebhookDurationBuckets(rendered);

  assert.deepEqual(
    buckets.map((bucket) => bucket.le),
    ["250", "1000", "5000", "15000", "60000", "+Inf"]
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.count),
    [1, 2, 3, 3, 4, 5]
  );

  // Prometheus only accepts a histogram whose bucket counts never decrease as le
  // grows, which also requires +Inf to be the maximum.
  for (const [index, bucket] of buckets.entries()) {
    const previous = buckets[index - 1];
    if (!previous) continue;
    assert.ok(
      bucket.count >= previous.count,
      `le="${bucket.le}" (${bucket.count}) must not be below le="${previous.le}" (${previous.count})`
    );
  }

  const total = buckets.at(-1);
  assert.equal(total?.le, "+Inf");
  assert.equal(total?.count, 5);
  assert.match(rendered, /^guardianbot_webhook_duration_ms_count 5$/m);
  assert.match(rendered, /^guardianbot_webhook_duration_ms_sum 153600$/m);
});

test("renders an empty webhook latency histogram without observations", () => {
  const buckets = parseWebhookDurationBuckets(new GuardianMetrics().render());

  assert.deepEqual(
    buckets.map((bucket) => bucket.count),
    [0, 0, 0, 0, 0, 0]
  );
});

test("tracks GitHub rate limiting only once a budget is reported", () => {
  const metrics = new GuardianMetrics();

  let rendered = metrics.render();
  assert.match(rendered, /^guardianbot_github_rate_limited_total 0$/m);
  assert.doesNotMatch(rendered, /guardianbot_github_ratelimit_remaining/);

  metrics.increment("github_rate_limited_total");
  metrics.setGitHubRateLimitRemaining(4321);

  rendered = metrics.render();
  assert.match(rendered, /^guardianbot_github_rate_limited_total 1$/m);
  assert.match(rendered, /^# TYPE guardianbot_github_ratelimit_remaining gauge$/m);
  assert.match(rendered, /^guardianbot_github_ratelimit_remaining 4321$/m);
});

test("distinguishes an under-indexed pgvector install from a healthy one", () => {
  const metrics = new GuardianMetrics();

  // Absent is not the same claim as healthy, so nothing is emitted until the store
  // reports how retrieval is actually being served.
  let rendered = metrics.render();
  assert.doesNotMatch(rendered, /guardianbot_repository_index_storage_mode/);
  assert.doesNotMatch(rendered, /guardianbot_repository_index_ann_ready/);

  // pgvector present, ANN index absent: every retrieval read is an exact scan.
  // The storage mode alone cannot distinguish this from a healthy install, which
  // is the state a failed or skipped index build leaves behind.
  metrics.setRepositoryIndexRetrieval({
    mode: "pgvector",
    approximateIndexReady: false,
    uncoveredDurableVectorRows: 12
  });
  rendered = metrics.render();
  assert.match(rendered, /^guardianbot_repository_index_storage_mode\{mode="pgvector"\} 1$/m);
  assert.match(rendered, /^guardianbot_repository_index_ann_ready 0$/m);
  assert.match(rendered, /^guardianbot_repository_index_uncovered_vector_rows 12$/m);

  metrics.setRepositoryIndexRetrieval({
    mode: "pgvector",
    approximateIndexReady: true,
    uncoveredDurableVectorRows: 0
  });
  rendered = metrics.render();
  assert.match(rendered, /^guardianbot_repository_index_ann_ready 1$/m);
  // Zero is a measurement and must be emitted, or an alert on the series would
  // never see a healthy install report full coverage.
  assert.match(rendered, /^guardianbot_repository_index_uncovered_vector_rows 0$/m);
});

test("omits the uncovered vector row gauge when the count was never measured", () => {
  const metrics = new GuardianMetrics();

  metrics.setRepositoryIndexRetrieval({
    mode: "json-array-fallback",
    approximateIndexReady: false,
    uncoveredDurableVectorRows: null
  });
  const rendered = metrics.render();

  // Null means the count could not be taken. Rendering it as 0 would let a scraper
  // read "unmeasured" as "none outstanding", so the series is left absent while
  // the mode and readiness are still reported.
  assert.doesNotMatch(rendered, /guardianbot_repository_index_uncovered_vector_rows/);
  assert.match(rendered, /^guardianbot_repository_index_storage_mode\{mode="json-array-fallback"\} 1$/m);
  assert.match(rendered, /^guardianbot_repository_index_ann_ready 0$/m);
});

test("declares a TYPE for every series it renders, including the retrieval gauges", () => {
  const metrics = new GuardianMetrics();
  metrics.setRepositoryIndexRetrieval({
    mode: "memory",
    approximateIndexReady: false,
    uncoveredDurableVectorRows: 0
  });

  const lines = metrics.render().trimEnd().split("\n");
  const declared = new Set(
    lines
      .filter((line) => line.startsWith("# TYPE "))
      .map((line) => line.split(" ")[2] ?? "")
  );
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const name = (line.split(/[ {]/)[0] ?? "").replace(
      /_(bucket|sum|count)$/,
      ""
    );
    assert.ok(declared.has(name), `${name} is rendered without a TYPE line`);
  }
});

test("exposes reviewer engagement as a bare aggregate counter with no labels", () => {
  const metrics = new GuardianMetrics();

  // Registered from construction so an analytics query can distinguish "no engagement observed"
  // from "the review-comment event is not subscribed and nothing is being measured" by looking at
  // the surrounding capability signals rather than at a missing series.
  let rendered = metrics.render();
  assert.match(rendered, /^# TYPE guardianbot_finding_feedback_total counter$/m);
  assert.match(rendered, /^guardianbot_finding_feedback_total 0$/m);

  metrics.increment("finding_feedback_total", 3);

  rendered = metrics.render();
  assert.match(rendered, /^guardianbot_finding_feedback_total 3$/m);
  // A label on this series is what a per-reviewer or per-repository breakdown would look like,
  // and every scraper would then retain that identifier indefinitely.
  assert.doesNotMatch(rendered, /^guardianbot_finding_feedback_total\{/m);
});

test("no rendered metric label can carry a reviewer, repository, or comment identifier", () => {
  const metrics = new GuardianMetrics();
  metrics.setRepositoryIndexRetrieval({
    mode: "pgvector",
    approximateIndexReady: true,
    uncoveredDurableVectorRows: 4
  });
  metrics.increment("finding_feedback_total", 7);
  metrics.observeWebhookLatency(120);

  const labels = [
    ...metrics.render().matchAll(/^[a-z_]+\{([^}]*)\}/gm)
  ].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((pair) => pair.split("=", 2))
      .map(([name, value]) => ({
        name: (name ?? "").trim(),
        value: (value ?? "").replace(/"/g, "")
      }))
  );

  // The whole label surface is enumerated rather than pattern-matched: a future series that
  // introduced a reviewer login, repository name, or comment identifier as a label would have to
  // add a name here, which is a change no reviewer can miss.
  assert.deepEqual([...new Set(labels.map((label) => label.name))].sort(), ["le", "mode"]);
  for (const label of labels) {
    if (label.name === "le") {
      assert.match(label.value, /^(\d+|\+Inf)$/);
      continue;
    }
    // Closed union from the store, never caller text and never repository-derived.
    assert.ok(
      ["memory", "pgvector", "json-array-fallback"].includes(label.value),
      `unexpected storage mode label value ${label.value}`
    );
  }
});

test("exposes finding reappearance as a counter that starts at zero", () => {
  const metrics = new GuardianMetrics();

  // Scrapers need the series present before the first regression so an alert on it can
  // distinguish "no reappearance yet" from "counter never registered".
  let rendered = metrics.render();
  assert.match(rendered, /^# TYPE guardianbot_finding_reappeared_total counter$/m);
  assert.match(rendered, /^guardianbot_finding_reappeared_total 0$/m);

  metrics.increment("finding_reappeared_total", 2);

  rendered = metrics.render();
  assert.match(rendered, /^guardianbot_finding_reappeared_total 2$/m);
});
