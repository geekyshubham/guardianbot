import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  indexRepositorySyntaxAware,
  toPersistedVectorRows,
  type GuardianConfig
} from "@guardianbot/core";
import {
  DEFAULT_FINDINGS_SLA_DAYS,
  UNOWNED_FINDING_OWNER,
  computeSlaDueAt,
  findingsLifecycleOptionsFromEnvironment,
  ingestFindingObservations,
  isTrustedLifecycleRun,
  lifecycleRecordPath,
  parseCodeOwners,
  pathMatchesPattern,
  recordAcceptedRunLifecycle,
  resolveFindingOwner,
  syncFindingTickets,
  ticketContentFor,
  type LifecycleObservation
} from "../src/findings-lifecycle.js";
import {
  MemoryStore,
  type FindingLifecycleRecord,
  type RepositoryRecord,
  type ScannerWorkflowRunRecord
} from "../src/store.js";
import type {
  FindingTicketContent,
  FindingTicketProvider
} from "../src/ticketing.js";

const INDEX_SHA = "a".repeat(40);
const NOW = new Date("2026-07-27T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const OPTIONS = { enabled: true, slaDays: { ...DEFAULT_FINDINGS_SLA_DAYS } };

function fingerprint(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function repository(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    installationId: 10,
    repositoryId: 20,
    fullName: "acme/service",
    visibility: "private",
    defaultBranch: "main",
    indexSha: INDEX_SHA,
    indexUpdatedAt: "2026-07-27T11:50:00.000Z",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false,
    ...overrides
  };
}

function run(overrides: Partial<ScannerWorkflowRunRecord> = {}): ScannerWorkflowRunRecord {
  return {
    repositoryId: 20,
    runId: 500,
    runAttempt: 1,
    headSha: INDEX_SHA,
    headBranch: "main",
    event: "push",
    startedAt: "2026-07-27T11:30:00.000Z",
    completedAt: "2026-07-27T11:40:00.000Z",
    workflowPath: ".github/workflows/guardianbot.yml",
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: [],
    ...overrides
  };
}

function config(
  findings?: GuardianConfig["findings"],
  suppressions: GuardianConfig["scanners"]["suppressions"] = []
): GuardianConfig {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "b".repeat(40),
    repository: { defaultBranch: "main", releaseBranches: [], languages: ["typescript"] },
    review: {
      automatic: true,
      drafts: "skip",
      incremental: true,
      maxInlineComments: 10,
      categories: [],
      highRiskPaths: []
    },
    scanners: { mode: "report-only", semgrep: true, trivy: true, suppressions },
    image: null,
    dast: null,
    ...(findings ? { findings } : {})
  };
}

async function seed(
  store: MemoryStore,
  options: {
    config?: GuardianConfig;
    codeOwners?: string;
    repository?: Partial<RepositoryRecord>;
  } = {}
): Promise<RepositoryRecord> {
  const record = repository(options.repository);
  await store.upsertRepository(record);
  const files: Record<string, string> = {
    ".guardianbot/config.yml": JSON.stringify(options.config ?? config())
  };
  if (options.codeOwners !== undefined) files[".github/CODEOWNERS"] = options.codeOwners;
  const index = await indexRepositorySyntaxAware({
    repository: record.fullName,
    repositoryId: record.repositoryId,
    repositoryScope: `github:${record.repositoryId}`,
    visibility: "private",
    commitSha: INDEX_SHA,
    files
  });
  await store.replaceRepositoryIndex(
    record.repositoryId,
    index,
    toPersistedVectorRows(index),
    new Date("2026-07-27T11:50:00.000Z")
  );
  return record;
}

function semgrep(label: string, path = "src/app.ts", severity: "critical" | "high" | "medium" = "high") {
  return {
    source: "semgrep" as const,
    fingerprint: fingerprint(label),
    ruleId: `rule.${label}`,
    severity,
    path,
    line: 4
  };
}

function observation(
  stream: string,
  findings: LifecycleObservation["findings"],
  complete = true
): LifecycleObservation {
  return { stream, complete, findings };
}

async function ingest(
  store: MemoryStore,
  record: RepositoryRecord,
  observations: LifecycleObservation[],
  runOverrides: Partial<ScannerWorkflowRunRecord> = {},
  now = NOW
) {
  return ingestFindingObservations({
    store,
    repository: record,
    run: run(runOverrides),
    observations,
    options: OPTIONS,
    now
  });
}

async function byFingerprint(store: MemoryStore, label: string) {
  return (await store.listFindingLifecycle(20)).find(
    (record) => record.fingerprint === fingerprint(label)
  );
}

test("lifecycle environment defaults off and rejects invalid SLA or ticket settings", () => {
  const defaults = findingsLifecycleOptionsFromEnvironment({});
  assert.deepEqual(defaults, {
    enabled: false,
    slaDays: { critical: 7, high: 30 },
    githubIssues: false,
    slackWebhookUrl: undefined,
    jira: undefined
  });
  const custom = findingsLifecycleOptionsFromEnvironment({
    GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED: "true",
    GUARDIANBOT_FINDINGS_SLA_JSON: '{"critical":3,"high":14,"medium":90}'
  });
  assert.deepEqual(custom.slaDays, { critical: 3, high: 14, medium: 90 });

  for (const value of ["[]", "{\"critical\":0}", "{\"critical\":1.5}", "{\"info\":5}", "{\"high\":4000}", "not json"]) {
    assert.throws(
      () => findingsLifecycleOptionsFromEnvironment({ GUARDIANBOT_FINDINGS_SLA_JSON: value }),
      /GUARDIANBOT_FINDINGS_SLA_JSON/
    );
  }
  assert.throws(
    () => findingsLifecycleOptionsFromEnvironment({ GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED: "yes" }),
    /must be 0, 1, false, or true/
  );
  assert.throws(
    () => findingsLifecycleOptionsFromEnvironment({ GUARDIANBOT_FINDINGS_GITHUB_ISSUES_ENABLED: "1" }),
    /require GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED=true/
  );
});

test("ticket credentials are read only through references and never echoed in errors", () => {
  const secret = "https://hooks.example.test/services/T000/B000/very-secret-token";
  const enabled = { GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED: "1" };
  const options = findingsLifecycleOptionsFromEnvironment({
    ...enabled,
    GUARDIANBOT_FINDINGS_SLACK_WEBHOOK_URL_REF: "SLACK_FINDINGS_WEBHOOK",
    SLACK_FINDINGS_WEBHOOK: secret
  });
  assert.equal(options.slackWebhookUrl, secret);

  const missing = (() => {
    try {
      findingsLifecycleOptionsFromEnvironment({
        ...enabled,
        GUARDIANBOT_FINDINGS_SLACK_WEBHOOK_URL_REF: "SLACK_FINDINGS_WEBHOOK"
      });
    } catch (error) {
      return String(error);
    }
    return "";
  })();
  assert.match(missing, /references SLACK_FINDINGS_WEBHOOK, which is not set/);
  assert.throws(
    () =>
      findingsLifecycleOptionsFromEnvironment({
        ...enabled,
        GUARDIANBOT_FINDINGS_SLACK_WEBHOOK_URL_REF: "lowercase-ref"
      }),
    /must name an uppercase environment variable/
  );
  assert.throws(
    () =>
      findingsLifecycleOptionsFromEnvironment({
        ...enabled,
        GUARDIANBOT_FINDINGS_SLACK_WEBHOOK_URL_REF: "SLACK_FINDINGS_WEBHOOK",
        SLACK_FINDINGS_WEBHOOK: "http://hooks.example.test/plain"
      }),
    (error: unknown) => !String(error).includes("hooks.example.test")
  );

  assert.throws(
    () =>
      findingsLifecycleOptionsFromEnvironment({
        ...enabled,
        GUARDIANBOT_FINDINGS_JIRA_PROJECT_KEY: "SEC"
      }),
    /must be configured together/
  );
  const jira = findingsLifecycleOptionsFromEnvironment({
    ...enabled,
    GUARDIANBOT_FINDINGS_JIRA_BASE_URL_REF: "JIRA_URL",
    GUARDIANBOT_FINDINGS_JIRA_EMAIL_REF: "JIRA_EMAIL",
    GUARDIANBOT_FINDINGS_JIRA_API_TOKEN_REF: "JIRA_TOKEN",
    GUARDIANBOT_FINDINGS_JIRA_PROJECT_KEY: "SEC",
    JIRA_URL: "https://jira.example.test",
    JIRA_EMAIL: "bot@example.test",
    JIRA_TOKEN: "jira-token-value"
  }).jira;
  assert.equal(jira?.projectKey, "SEC");
  assert.equal(jira?.issueType, "Bug");
  assert.equal(jira?.apiToken, "jira-token-value");
});

test("finding lifecycle environment variables are documented", () => {
  const operations = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../docs/operations.md"),
    "utf8"
  );
  for (const name of [
    "GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED",
    "GUARDIANBOT_FINDINGS_SLA_JSON",
    "GUARDIANBOT_FINDINGS_GITHUB_ISSUES_ENABLED",
    "GUARDIANBOT_FINDINGS_SLACK_WEBHOOK_URL_REF",
    "GUARDIANBOT_FINDINGS_JIRA_BASE_URL_REF",
    "GUARDIANBOT_FINDINGS_JIRA_EMAIL_REF",
    "GUARDIANBOT_FINDINGS_JIRA_API_TOKEN_REF",
    "GUARDIANBOT_FINDINGS_JIRA_PROJECT_KEY",
    "GUARDIANBOT_FINDINGS_JIRA_ISSUE_TYPE"
  ]) {
    assert.match(operations, new RegExp(`\\| \`${name}\` \\|`), name);
  }
});

test("ownership prefers config rules, then CODEOWNERS, then the service owner, else unowned", () => {
  const codeOwners = parseCodeOwners(
    "# comment\n* @acme/platform\nsrc/auth/ @acme/security @acme/auth\nnot-a-handle owner\n"
  );
  assert.equal(codeOwners.length, 2);
  const context = {
    config: config({
      ownership: {
        serviceOwner: "@acme/sre",
        rules: [{ paths: ["src/payments/**"], owner: "@acme/payments" }]
      }
    }),
    codeOwners
  };
  assert.equal(
    resolveFindingOwner({ source: "semgrep", path: "src/payments/charge.ts" }, context),
    "@acme/payments"
  );
  assert.equal(
    resolveFindingOwner({ source: "semgrep", path: "src/auth/login.ts" }, context),
    "@acme/auth @acme/security"
  );
  assert.equal(
    resolveFindingOwner({ source: "trivy", path: "/workspace/package-lock.json" }, context),
    "@acme/platform"
  );
  assert.equal(resolveFindingOwner({ source: "trivy-image" }, context), "@acme/sre");
  assert.equal(
    resolveFindingOwner({ source: "zap", path: "https://app.example.test/login" }, context),
    "@acme/sre"
  );
  assert.equal(
    resolveFindingOwner({ source: "zap" }, { config: config(), codeOwners: [] }),
    UNOWNED_FINDING_OWNER
  );
  assert.equal(
    resolveFindingOwner({ source: "semgrep", path: "lib/x.ts" }, { codeOwners: [] }),
    UNOWNED_FINDING_OWNER
  );
  // A truncated index chunk never contributes a partial trailing rule.
  assert.deepEqual(
    parseCodeOwners("* @acme/platform\nsrc/ @acme/par\n[guardianbot-truncated]"),
    [{ pattern: "*", owners: ["@acme/platform"] }]
  );
});

test("ownership globs keep CODEOWNERS semantics and run in linear time on crafted patterns", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*", "src/a.ts", true],
    ["*.ts", "src/deep/a.ts", true],
    ["*.ts", "src/a.tsx", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/**", "src/deep/a.ts", true],
    ["/src/", "src/deep/a.ts", true],
    ["src/", "lib/src/a.ts", false],
    ["docs", "a/docs", true],
    ["a?c", "abc", true],
    ["a?c", "a/c", false],
    ["src/[x].ts", "src/[x].ts", true],
    ["src/(.*).ts", "src/a.ts", false]
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(pathMatchesPattern(pattern, path), expected, `${pattern} vs ${path}`);
  }
  const started = performance.now();
  // These patterns backtracked for seconds with the previous RegExp translation.
  assert.equal(pathMatchesPattern(`a/${"**a".repeat(8)}b`, `a/${"a".repeat(2_000)}`), false);
  assert.equal(pathMatchesPattern(`${"*a".repeat(50)}b`, "a".repeat(2_000)), false);
  const context = {
    codeOwners: parseCodeOwners(`a/${"**a".repeat(8)}b @acme/evil\n`.repeat(1_000))
  };
  assert.equal(
    resolveFindingOwner({ source: "semgrep", path: `a/${"a".repeat(500)}` }, context),
    UNOWNED_FINDING_OWNER
  );
  assert.ok(performance.now() - started < 2_000, "crafted globs must not stall the event loop");
});

test("DAST locations keep only origin and path so URI secrets never reach tickets", async () => {
  assert.equal(
    lifecycleRecordPath("zap", "https://user:pw@app.example.test/login?token=s3cret#frag"),
    "https://app.example.test/login"
  );
  assert.equal(lifecycleRecordPath("zap", "not a url?session=s3cret"), undefined);
  assert.equal(lifecycleRecordPath("semgrep", "/src/app/a.ts"), "app/a.ts");

  const store = new MemoryStore();
  const record = await seed(store);
  await ingest(store, record, [
    observation("zap:nightly:staging", [
      {
        source: "zap",
        fingerprint: fingerprint("dast"),
        ruleId: "10202",
        severity: "high",
        title: "Absence of Anti-CSRF Tokens",
        path: "https://app.example.test/account?session=s3cret&api_key=k3y"
      }
    ])
  ]);
  const stored = await byFingerprint(store, "dast");
  assert.equal(stored?.path, "https://app.example.test/account");
  const ticket = ticketContentFor(record, stored as FindingLifecycleRecord, OPTIONS.slaDays, NOW);
  assert.equal(JSON.stringify(ticket).includes("s3cret"), false);
});

test("only accepted default-branch push or schedule runs of active repositories are trusted", async () => {
  const active = repository();
  assert.equal(isTrustedLifecycleRun(run(), active), true);
  assert.equal(isTrustedLifecycleRun(run({ event: "schedule" }), active), true);
  assert.equal(isTrustedLifecycleRun(run({ event: "pull_request" }), active), false);
  assert.equal(isTrustedLifecycleRun(run({ event: "workflow_dispatch" }), active), false);
  assert.equal(isTrustedLifecycleRun(run({ headBranch: "feature" }), active), false);
  assert.equal(
    isTrustedLifecycleRun(run(), repository({ repositoryState: "suspended" })),
    false
  );

  const store = new MemoryStore();
  const record = await seed(store);
  const pr = await ingest(store, record, [observation("semgrep", [semgrep("one")])], {
    event: "pull_request",
    headBranch: "feature"
  });
  assert.equal(pr.ingested, false);
  const disabled = await ingestFindingObservations({
    store,
    repository: record,
    run: run(),
    observations: [observation("semgrep", [semgrep("one")])],
    options: { enabled: false, slaDays: OPTIONS.slaDays },
    now: NOW
  });
  assert.equal(disabled.ingested, false);
  assert.deepEqual(await store.listFindingLifecycle(20), []);
});

test("ingestion opens findings with owner and SLA, and fixes them only after a complete scan", async () => {
  const store = new MemoryStore();
  const record = await seed(store, { codeOwners: "src/ @acme/app\n" });
  const first = await ingest(store, record, [
    observation("semgrep", [semgrep("one", "src/app.ts", "critical"), semgrep("two", "lib/x.ts", "medium")])
  ]);
  assert.equal(first.ingested, true);
  const one = await byFingerprint(store, "one");
  assert.equal(one?.status, "open");
  assert.equal(one?.owner, "@acme/app");
  assert.equal(one?.firstSeenAt, "2026-07-27T11:40:00.000Z");
  assert.equal(one?.slaDueAt, new Date(Date.parse("2026-07-27T11:40:00.000Z") + 7 * DAY_MS).toISOString());
  const two = await byFingerprint(store, "two");
  assert.equal(two?.owner, UNOWNED_FINDING_OWNER);
  assert.equal(two?.slaDueAt, undefined, "medium is untracked by default");

  // An incomplete later scan (scanner error or truncation) cannot fix anything.
  await ingest(store, record, [observation("semgrep", [], false)], {
    runId: 501,
    startedAt: "2026-07-28T11:30:00.000Z",
    completedAt: "2026-07-28T11:40:00.000Z"
  });
  assert.equal((await byFingerprint(store, "one"))?.status, "open");

  // A complete scan of another stream does not fix semgrep findings either.
  await ingest(store, record, [observation("trivy-fs", [])], {
    runId: 502,
    startedAt: "2026-07-29T11:30:00.000Z",
    completedAt: "2026-07-29T11:40:00.000Z"
  });
  assert.equal((await byFingerprint(store, "one"))?.status, "open");

  await ingest(store, record, [observation("semgrep", [semgrep("two", "lib/x.ts", "medium")])], {
    runId: 503,
    startedAt: "2026-07-30T11:30:00.000Z",
    completedAt: "2026-07-30T11:40:00.000Z"
  });
  const fixed = await byFingerprint(store, "one");
  assert.equal(fixed?.status, "fixed");
  assert.equal(fixed?.fixedAt, "2026-07-30T11:40:00.000Z");
  assert.equal(fixed?.firstSeenAt, "2026-07-27T11:40:00.000Z");
  assert.equal((await byFingerprint(store, "two"))?.status, "open");
});

test("a regression after a fix reopens the finding with a new SLA episode", async () => {
  const store = new MemoryStore();
  const record = await seed(store);
  await ingest(store, record, [observation("semgrep", [semgrep("one")])]);
  await ingest(store, record, [observation("semgrep", [])], {
    runId: 501,
    startedAt: "2026-07-28T11:30:00.000Z",
    completedAt: "2026-07-28T11:40:00.000Z"
  });
  assert.equal((await byFingerprint(store, "one"))?.status, "fixed");
  await ingest(store, record, [observation("semgrep", [semgrep("one")])], {
    runId: 502,
    startedAt: "2026-08-10T11:30:00.000Z",
    completedAt: "2026-08-10T11:40:00.000Z"
  });
  const reopened = await byFingerprint(store, "one");
  assert.equal(reopened?.status, "open");
  assert.equal(reopened?.firstSeenAt, "2026-07-27T11:40:00.000Z");
  assert.equal(reopened?.openedAt, "2026-08-10T11:40:00.000Z");
  assert.equal(reopened?.fixedAt, undefined);
  assert.equal(
    reopened?.slaDueAt,
    computeSlaDueAt("high", "2026-08-10T11:40:00.000Z", OPTIONS.slaDays)
  );
});

test("a delayed older run cannot overturn a newer stream decision", async () => {
  const store = new MemoryStore();
  const record = await seed(store);
  await ingest(store, record, [observation("semgrep", [])], {
    runId: 600,
    startedAt: "2026-07-28T11:30:00.000Z",
    completedAt: "2026-07-28T11:40:00.000Z"
  });
  const stale = await ingest(store, record, [observation("semgrep", [semgrep("old")])], {
    runId: 599,
    startedAt: "2026-07-27T11:30:00.000Z"
  });
  assert.equal(stale.ingested, false);
  assert.deepEqual(stale.staleStreams, ["semgrep"]);
  assert.equal(await byFingerprint(store, "old"), undefined);
  const watermarks = await store.listFindingLifecycleStreams(20);
  assert.equal(watermarks[0]?.runId, 600);
});

test("active suppressions map to suppressed or risk-accepted and expire back to open", async () => {
  const store = new MemoryStore();
  const record = await seed(store, {
    config: config(undefined, [
      {
        fingerprint: fingerprint("suppressed"),
        owner: "@acme/app",
        reason: "false positive in test fixture",
        ticket: "SEC-1",
        expiresAt: "2026-12-31T00:00:00.000Z"
      },
      {
        fingerprint: fingerprint("accepted"),
        owner: "@acme/app",
        reason: "Risk accepted until the vendor ships a fix",
        ticket: "SEC-2",
        expiresAt: "2026-12-31T00:00:00.000Z"
      },
      {
        fingerprint: fingerprint("expired"),
        owner: "@acme/app",
        reason: "risk-accepted",
        ticket: "SEC-3",
        expiresAt: "2026-01-01T00:00:00.000Z"
      }
    ])
  });
  await ingest(store, record, [
    observation("semgrep", [semgrep("suppressed"), semgrep("accepted"), semgrep("expired")])
  ]);
  assert.equal((await byFingerprint(store, "suppressed"))?.status, "suppressed");
  assert.equal((await byFingerprint(store, "accepted"))?.status, "risk-accepted");
  assert.equal((await byFingerprint(store, "expired"))?.status, "open");
});

test("an unavailable index keeps existing owners instead of flapping to unowned", async () => {
  const store = new MemoryStore();
  const record = await seed(store, { codeOwners: "* @acme/app\n" });
  await ingest(store, record, [observation("semgrep", [semgrep("one")])]);
  assert.equal((await byFingerprint(store, "one"))?.owner, "@acme/app");
  await ingest(store, repository({ indexSha: "f".repeat(40) }), [observation("semgrep", [semgrep("one")])], {
    runId: 501,
    startedAt: "2026-07-28T11:30:00.000Z"
  });
  assert.equal((await byFingerprint(store, "one"))?.owner, "@acme/app");
});

function recordingProvider(
  name: FindingTicketProvider["name"],
  options: { optIn?: boolean; fail?: boolean } = {}
) {
  const calls: Array<{ content: FindingTicketContent; previousRef?: string }> = [];
  let next = 1;
  const provider: FindingTicketProvider = {
    name,
    requiresRepositoryOptIn: options.optIn ?? false,
    contentSha: (content) =>
      createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    session: () => ({
      async sync(content, previous) {
        calls.push({ content, previousRef: previous?.ref });
        if (options.fail) throw new Error("https://user:secret@tickets.example.test exploded");
        return { ref: previous?.ref ?? String(next++) };
      }
    })
  };
  return { provider, calls };
}

test("ticket sync is idempotent, closes fixed findings, and stores sanitized failures", async () => {
  const store = new MemoryStore();
  const record = await seed(store);
  await ingest(store, record, [
    observation("semgrep", [semgrep("one"), semgrep("medium", "src/m.ts", "medium")])
  ]);
  const { provider, calls } = recordingProvider("jira");
  await syncFindingTickets({ store, repository: record, providers: [provider], slaDays: OPTIONS.slaDays, now: NOW });
  // Untracked severities are never ticketed.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.content.state, "open");
  assert.equal((await byFingerprint(store, "one"))?.tickets.jira?.ref, "1");

  await syncFindingTickets({ store, repository: record, providers: [provider], slaDays: OPTIONS.slaDays, now: NOW });
  assert.equal(calls.length, 1, "unchanged content makes no provider call");

  await ingest(store, record, [observation("semgrep", [])], {
    runId: 501,
    startedAt: "2026-07-28T11:30:00.000Z"
  });
  await syncFindingTickets({ store, repository: record, providers: [provider], slaDays: OPTIONS.slaDays, now: NOW });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.content.state, "closed");
  assert.equal(calls[1]?.previousRef, "1");
  assert.equal((await byFingerprint(store, "one"))?.tickets.jira?.state, "closed");

  const failing = new MemoryStore();
  const failingRecord = await seed(failing);
  await ingest(failing, failingRecord, [observation("semgrep", [semgrep("one")])]);
  const broken = recordingProvider("slack", { fail: true });
  const result = await syncFindingTickets({
    store: failing,
    repository: failingRecord,
    providers: [broken.provider],
    slaDays: OPTIONS.slaDays,
    now: NOW
  });
  assert.deepEqual(result, { attempted: 1, failed: 1 });
  const stored = (await failing.listFindingLifecycle(20))[0];
  assert.equal(stored?.tickets.slack?.error, "ticket provider request failed");
  assert.equal(JSON.stringify(stored).includes("secret"), false);
  // A stored error is retried on the next pass even though the content is unchanged.
  await syncFindingTickets({
    store: failing,
    repository: failingRecord,
    providers: [broken.provider],
    slaDays: OPTIONS.slaDays,
    now: NOW
  });
  assert.equal(broken.calls.length, 2);
});

test("repository-writing ticket providers need the repository opt-in and never touch public repositories", async () => {
  for (const [githubIssues, visibility, expected] of [
    [true, "private", 1],
    [false, "private", 0],
    [true, "public", 0]
  ] as const) {
    const store = new MemoryStore();
    const record = await seed(store, {
      config: config({ githubIssues }),
      repository: { visibility }
    });
    await ingest(store, record, [observation("semgrep", [semgrep("one")])]);
    const { provider, calls } = recordingProvider("github-issues", { optIn: true });
    await syncFindingTickets({ store, repository: record, providers: [provider], slaDays: OPTIONS.slaDays, now: NOW });
    assert.equal(calls.length, expected, `${githubIssues} ${visibility}`);
  }
});

test("ticket content reports breach and closes non-open or untracked findings", () => {
  const base: FindingLifecycleRecord = {
    repositoryId: 20,
    fingerprint: fingerprint("one"),
    source: "semgrep",
    ruleId: "rule.one",
    severity: "critical",
    path: "src/app.ts",
    line: 4,
    status: "open",
    owner: "@acme/app",
    streams: { semgrep: "2026-07-01T00:00:00.000Z" },
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    openedAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    slaDueAt: "2026-07-08T00:00:00.000Z",
    lastRunId: 1,
    lastRunAttempt: 1,
    tickets: {},
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  const content = ticketContentFor(repository(), base, OPTIONS.slaDays, NOW);
  assert.equal(content.breached, true);
  assert.equal(content.state, "open");
  assert.equal(
    ticketContentFor(repository(), { ...base, status: "risk-accepted" }, OPTIONS.slaDays, NOW).state,
    "closed"
  );
  assert.equal(
    ticketContentFor(repository(), { ...base, severity: "low", slaDueAt: undefined }, OPTIONS.slaDays, NOW).state,
    "closed"
  );
});

test("recording an accepted run swallows ticket failures but keeps the merge", async () => {
  const store = new MemoryStore();
  const record = await seed(store);
  const broken = recordingProvider("slack", { fail: true });
  await recordAcceptedRunLifecycle({
    runtime: { options: { ...OPTIONS, githubIssues: false }, providers: [broken.provider] },
    store,
    repository: record,
    run: run(),
    observations: [observation("semgrep", [semgrep("one")])],
    now: NOW
  });
  const stored = await byFingerprint(store, "one");
  assert.equal(stored?.status, "open");
  assert.equal(stored?.tickets.slack?.error, "ticket provider request failed");
});
