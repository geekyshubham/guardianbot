import assert from "node:assert/strict";
import test from "node:test";
import { GuardianService, addedLineRanges, redactUntrustedText } from "../src/service.js";
import { MemoryStore } from "../src/store.js";

class FakeGitHub {
  issues: Array<{ owner: string; repo: string; title: string; body: string }> = [];
  comments: Array<{ owner: string; repo: string; issueNumber: number; body: string }> = [];
  updates: Array<{ owner: string; repo: string; commentId: number; body: string }> = [];
  currentPulls: Array<{ head: { sha: string } }> = [];
  pullFiles: Array<Array<Record<string, any>>> = [];
  permission = "write";

  constructor(private readonly options: { tree?: string[]; languages?: Record<string, number>; config?: string } = {}) {}

  async getTree(): Promise<string[]> {
    return this.options.tree ?? ["package-lock.json", "src/index.ts"];
  }

  async getLanguages(): Promise<Record<string, number>> {
    return this.options.languages ?? { TypeScript: 1 };
  }

  async getFile(_owner: string, _repo: string, path: string): Promise<{ content: string; sha: string } | undefined> {
    if (path !== ".guardianbot/config.yml" || !this.options.config) return undefined;
    return { content: this.options.config, sha: "config-sha" };
  }

  async createIssue(owner: string, repo: string, title: string, body: string) {
    this.issues.push({ owner, repo, title, body });
    return { html_url: "https://example.test/issues/1", number: this.issues.length };
  }

  async createComment(owner: string, repo: string, issueNumber: number, body: string) {
    this.comments.push({ owner, repo, issueNumber, body });
    return { id: this.comments.length, html_url: "https://example.test/comment" };
  }

  async updateComment(owner: string, repo: string, commentId: number, body: string) {
    this.updates.push({ owner, repo, commentId, body });
    return { id: commentId, html_url: "https://example.test/comment" };
  }

  async request<T>(method: string, path: string): Promise<T> {
    if (method === "GET" && /\/pulls\/\d+$/.test(path)) {
      const current = this.currentPulls.shift() ?? { head: { sha: "head-sha" } };
      return current as T;
    }
    if (method === "GET" && /\/pulls\/\d+\/files\?/.test(path)) {
      return (this.pullFiles.shift() ?? []) as T;
    }
    if (method === "GET" && path.includes("/collaborators/")) {
      return { permission: this.permission } as T;
    }
    throw new Error(`Unhandled ${method} ${path}`);
  }
}

class FakeBackend {
  constructor(private readonly resultFactory: () => Record<string, any>) {}

  async capabilities() {
    return {
      protocolVersion: "guardian.review.v1" as const,
      backendId: "fake",
      structuredOutput: true,
      maxInputCharacters: 200_000,
      supportedProfiles: ["routine-review", "high-risk-review"],
      supportedDataClassifications: ["public", "private"],
      retention: "none" as const,
      usageReporting: true
    };
  }

  async review() {
    return this.resultFactory();
  }
}

function createPullEvent(headSha = "head-sha"): Record<string, any> {
  return {
    action: "synchronize",
    installation: { id: 1 },
    repository: {
      id: 99,
      full_name: "Geekyshubham/guardianbot",
      default_branch: "main",
      private: false
    },
    pull_request: {
      number: 12,
      draft: false,
      head: { sha: headSha },
      base: { sha: "base-sha", ref: "main" },
      title: "Harden queue worker",
      body: "body",
      user: { login: "maintainer" }
    }
  };
}

function createResult(path = "src/a.ts", startLine = 10, headSha = "head-sha") {
  return {
    protocolVersion: "guardian.review.v1",
    schemaVersion: "1.0.0",
    requestId: `99:12:${headSha}`,
    reviewedHeadSha: headSha,
    contextIndexSha: "a".repeat(64),
    summary: {
      intent: "reviewed",
      changeGroups: [{ title: "group", paths: ["src/a.ts"], summary: "summary" }],
      riskScore: 10,
      reviewEffort: 2,
      impactedComponents: ["api"],
      partialReview: false
    },
    findings: [
      {
        id: "F1",
        fingerprint: "fp-1",
        category: "reliability",
        severity: "P1",
        confidence: 0.9,
        title: "Problem",
        path,
        startLine,
        endLine: startLine,
        evidence: "evidence",
        impact: "impact",
        remediation: "fix it"
      }
    ],
    requirements: [],
    testGaps: [],
    suggestedReviewers: [],
    backend: { backendId: "fake", modelId: "test", latencyMs: 12 }
  };
}

test("addedLineRanges permits only added lines", () => {
  assert.deepEqual(
    addedLineRanges("@@ -1,3 +3,4 @@\n context\n-old\n+first\n+second\n context"),
    [{ start: 4, end: 5 }]
  );
  assert.deepEqual(addedLineRanges("@@ -4 +8,0 @@\n-old"), []);
});

test("redacts common credentials from untrusted repository text", () => {
  assert.equal(
    redactUntrustedText("token=hello-this-is-secret password=hunter2"),
    "token=[REDACTED] password=[REDACTED]"
  );
});

test("enqueue is idempotent and discovery succeeds once", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub();
  const service = new GuardianService(
    {
      appId: "1",
      privateKey: "private",
      webhookSecret: "secret",
      githubClientFactory: async () => github
    },
    store
  );
  const event = {
    action: "created",
    installation: { id: 1 },
    repositories: [
      {
        id: 99,
        full_name: "Geekyshubham/guardianbot",
        default_branch: "main",
        private: false
      }
    ]
  };

  assert.equal(await service.enqueue("installation", event, "delivery-1"), true);
  assert.equal(await service.enqueue("installation", event, "delivery-1"), false);
  assert.equal(await service.processNextWebhook("worker-1"), true);
  assert.equal(await service.processNextWebhook("worker-1"), false);

  assert.equal(github.issues.length, 1);
  const repository = await store.getRepository(99);
  assert.equal(repository?.repositoryState, "active");
  const job = await store.getWebhook("delivery-1");
  assert.equal(job?.status, "succeeded");
});

test("failing jobs retry and dead-letter after the max attempt budget", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub();
  let nowMs = Date.UTC(2026, 6, 27, 0, 0, 0);
  const service = new GuardianService(
    {
      appId: "1",
      privateKey: "private",
      webhookSecret: "secret",
      githubClientFactory: async () => ({
        ...github,
        getTree: async () => {
          throw new Error("GitHub GET /tree returned 500");
        }
      }),
      now: () => new Date(nowMs),
      maxWebhookAttempts: 3
    },
    store
  );
  const event = {
    action: "created",
    installation: { id: 1 },
    repositories: [{ id: 99, full_name: "Geekyshubham/guardianbot", default_branch: "main", private: false }]
  };
  await service.enqueue("installation", event, "delivery-2");

  assert.equal(await service.processNextWebhook("worker-1"), true);
  let job = await store.getWebhook("delivery-2");
  assert.equal(job?.status, "pending");
  assert.equal(job?.attempts, 1);

  nowMs += 60_000;
  assert.equal(await service.processNextWebhook("worker-1"), true);
  job = await store.getWebhook("delivery-2");
  assert.equal(job?.status, "pending");
  assert.equal(job?.attempts, 2);

  nowMs += 120_000;
  assert.equal(await service.processNextWebhook("worker-1"), true);
  job = await store.getWebhook("delivery-2");
  assert.equal(job?.status, "dead-letter");
  assert.equal(job?.attempts, 3);
  assert.match(job?.lastError ?? "", /GitHub GET \/tree returned 500/);
});

test("stale PR heads never publish final review output", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub({
    config: `schemaVersion: 1.0.0
repository:
  defaultBranch: main
  releaseBranches: [main]
review:
  maxInlineComments: 8
  highRiskPaths: []
paths:
  include: [src/**]
  exclude: []
scanner:
  mode: report-only
  suppressions: []`
  });
  github.currentPulls = [{ head: { sha: "head-sha" } }, { head: { sha: "new-head" } }];
  github.pullFiles = [[{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +10 @@\n+line" }]];
  const service = new GuardianService(
    {
      appId: "1",
      privateKey: "private",
      webhookSecret: "secret",
      githubClientFactory: async () => github,
      reviewClientFactory: () => new FakeBackend(() => createResult())
    },
    store
  );

  await service.enqueue("pull_request", createPullEvent(), "delivery-3");
  assert.equal(await service.processNextWebhook("worker-1"), true);

  const finalBodies = github.updates.map((update) => update.body);
  assert.equal(finalBodies.some((body) => body.includes("**Problem**")), false);
  const review = await store.getReview(99, 12);
  assert.equal(review?.findings.length ?? 0, 0);
});

test("authorized commands respond and unauthorized ones are rejected", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub();
  const service = new GuardianService(
    {
      appId: "1",
      privateKey: "private",
      webhookSecret: "secret",
      githubClientFactory: async () => github
    },
    store
  );
  const baseEvent = {
    action: "created",
    installation: { id: 1 },
    repository: {
      id: 99,
      full_name: "Geekyshubham/guardianbot",
      default_branch: "main",
      private: false
    },
    issue: { number: 12, pull_request: { url: "https://example.test/pull" } },
    comment: { body: "@guardianbot status", user: { login: "reviewer" } }
  };

  await service.enqueue("issue_comment", baseEvent, "delivery-4");
  await service.processNextWebhook("worker-1");
  assert.match(github.comments.at(-1)?.body ?? "", /guardianctl doctor/);

  github.permission = "read";
  await service.enqueue("issue_comment", baseEvent, "delivery-5");
  await service.processNextWebhook("worker-1");
  assert.match(github.comments.at(-1)?.body ?? "", /not authorized/);
});

test("paginated pull files are reviewed partially with an explicit warning", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub();
  github.currentPulls = [{ head: { sha: "head-sha" } }, { head: { sha: "head-sha" } }];
  const largeBatch = Array.from({ length: 100 }, (_, index) => ({
    filename: index === 0 ? "Dockerfile" : `src/${index}.ts`,
    status: "modified",
    patch: `@@ -1 +${index + 1} @@\n+line ${index}`
  }));
  github.pullFiles = [largeBatch, [{ filename: "src/extra.ts", status: "modified", patch: "@@ -1 +1 @@\n+extra" }]];
  const service = new GuardianService(
    {
      appId: "1",
      privateKey: "private",
      webhookSecret: "secret",
      githubClientFactory: async () => github,
      reviewClientFactory: () => new FakeBackend(() => createResult("Dockerfile", 1))
    },
    store
  );

  await service.enqueue("pull_request", createPullEvent(), "delivery-6");
  await service.processNextWebhook("worker-1");

  assert.match(github.updates.at(-1)?.body ?? "", /Partial review warning/);
});
