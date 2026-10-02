import assert from "node:assert/strict";
import test from "node:test";
import {
  FINDING_TICKET_MARKER_PREFIX,
  FindingTicketError,
  createGitHubIssuesProvider,
  createJiraProvider,
  createSlackNotifier,
  defaultTicketRetryPolicy,
  jiraFindingLabel,
  parseHttpsEndpoint,
  renderGitHubIssueBody,
  renderSlackText,
  sanitizeTicketError,
  type FindingIssueClient,
  type FindingTicketContent
} from "../src/ticketing.js";
import type { RepositoryRecord } from "../src/store.js";

const FINGERPRINT = "e".repeat(64);
const NO_WAIT = defaultTicketRetryPolicy({ backoffMs: 0, sleep: async () => undefined });

function repository(): RepositoryRecord {
  return {
    installationId: 10,
    repositoryId: 20,
    fullName: "acme/service",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false
  };
}

function content(overrides: Partial<FindingTicketContent> = {}): FindingTicketContent {
  return {
    repository: "acme/service",
    fingerprint: FINGERPRINT,
    source: "semgrep",
    ruleId: "rule.auth`<script>`",
    severity: "critical",
    path: "src/auth.ts",
    line: 4,
    owner: "@acme/security",
    status: "open",
    breached: false,
    firstSeenAt: "2026-07-20T00:00:00.000Z",
    openedAt: "2026-07-20T00:00:00.000Z",
    slaDueAt: "2026-07-27T00:00:00.000Z",
    state: "open",
    ...overrides
  };
}

interface IssueCall {
  method: string;
  path: string;
  body?: any;
}

function issueClient(
  handler: (call: IssueCall) => unknown
): { client: FindingIssueClient; calls: IssueCall[] } {
  const calls: IssueCall[] = [];
  return {
    calls,
    client: {
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const call = { method, path, body };
        calls.push(call);
        return handler(call) as T;
      }
    }
  };
}

test("the GitHub issue body carries the hidden marker and only bounded inert metadata", () => {
  const body = renderGitHubIssueBody(content({ ruleId: "x".repeat(400) }));
  assert.ok(body.startsWith(`<!-- ${FINDING_TICKET_MARKER_PREFIX}${FINGERPRINT} -->`));
  assert.match(body, /\| Owner \| `acme\/security` \|/);
  assert.match(body, /x{200}\.\.\./);
  assert.equal(body.includes("x".repeat(201)), false);
  const markup = renderGitHubIssueBody(content());
  assert.equal(markup.includes("<script>"), false);
  assert.equal(/rule\.auth`/.test(markup), false);
});

test("GitHub issues are created once, updated by number, and closed without duplicates", async () => {
  let created = 0;
  const { client, calls } = issueClient((call) => {
    if (call.method === "GET") return [];
    if (call.method === "POST") {
      created += 1;
      return { number: 41 };
    }
    return {};
  });
  const provider = createGitHubIssuesProvider({ clientFactory: async () => client, retry: NO_WAIT });
  const session = provider.session(repository());
  const opened = await session.sync(content(), undefined);
  assert.deepEqual(opened, { ref: "41" });
  assert.equal(created, 1);
  assert.equal(calls.find((call) => call.method === "POST")?.path, "/repos/acme/service/issues");

  const closed = await session.sync(content({ status: "fixed", state: "closed" }), {
    ref: "41",
    state: "open",
    updatedAt: "2026-07-27T00:00:00.000Z"
  });
  assert.deepEqual(closed, { ref: "41" });
  const patch = calls.at(-1);
  assert.equal(patch?.method, "PATCH");
  assert.equal(patch?.path, "/repos/acme/service/issues/41");
  assert.equal(patch?.body.state, "closed");
  assert.equal(created, 1);
});

test("a lost issue reference is recovered from the bot-authored marker, never a human issue", async () => {
  const marker = `<!-- ${FINDING_TICKET_MARKER_PREFIX}${FINGERPRINT} -->`;
  const { client, calls } = issueClient((call) => {
    if (call.method === "GET") {
      return [
        { number: 7, body: marker, user: { type: "User" } },
        { number: 9, body: marker, user: { type: "Bot" } }
      ];
    }
    return {};
  });
  const provider = createGitHubIssuesProvider({ clientFactory: async () => client, retry: NO_WAIT });
  const result = await provider.session(repository()).sync(content(), undefined);
  assert.deepEqual(result, { ref: "9" });
  assert.equal(calls.some((call) => call.method === "POST"), false);
  assert.equal(calls.at(-1)?.path, "/repos/acme/service/issues/9");
});

test("a deleted issue falls back to the marker search, and a closed finding is never created", async () => {
  const { client, calls } = issueClient((call) => {
    if (call.method === "PATCH") throw new Error("GitHub PATCH request returned 404");
    if (call.method === "GET") return [];
    return { number: 3 };
  });
  const provider = createGitHubIssuesProvider({ clientFactory: async () => client, retry: NO_WAIT });
  const result = await provider
    .session(repository())
    .sync(content({ state: "closed", status: "fixed" }), {
      ref: "12",
      state: "open",
      updatedAt: "2026-07-27T00:00:00.000Z"
    });
  assert.deepEqual(result, {});
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("GitHub failures are retried when transient and surface only sanitized kinds", async () => {
  let attempts = 0;
  const { client } = issueClient(() => {
    attempts += 1;
    throw new Error("GitHub GET request returned 503 https://x-access-token:ghs_secret@github");
  });
  const provider = createGitHubIssuesProvider({ clientFactory: async () => client, retry: NO_WAIT });
  await assert.rejects(provider.session(repository()).sync(content(), undefined), (error) => {
    assert.ok(error instanceof FindingTicketError);
    assert.equal(sanitizeTicketError(error), "github-issues GET request returned 503");
    return true;
  });
  assert.equal(attempts, 3);

  attempts = 0;
  const forbidden = issueClient(() => {
    attempts += 1;
    throw new Error("GitHub GET request returned 403");
  });
  const strict = createGitHubIssuesProvider({
    clientFactory: async () => forbidden.client,
    retry: NO_WAIT
  });
  await assert.rejects(strict.session(repository()).sync(content(), undefined));
  assert.equal(attempts, 1, "permanent failures are not retried");
  assert.equal(sanitizeTicketError(new Error("token=abc")), "ticket provider request failed");
});

function fetchRecorder(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body?: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>
    });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("the Slack notifier posts bounded text and only re-notifies on transitions", async () => {
  const { fetchImpl, calls } = fetchRecorder(() => new Response("ok", { status: 200 }));
  const notifier = createSlackNotifier({
    webhookUrl: "https://hooks.example.test/services/secret-path",
    fetchImpl,
    retry: NO_WAIT
  });
  await notifier.session(repository()).sync(content({ breached: true }), undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.body.text, /past SLA/);
  assert.equal(calls[0]?.body.text.includes("<script>"), false);
  assert.equal(
    notifier.contentSha(content({ owner: "@acme/a" })),
    notifier.contentSha(content({ owner: "@acme/b" })),
    "owner changes alone do not notify"
  );
  assert.notEqual(
    notifier.contentSha(content()),
    notifier.contentSha(content({ breached: true }))
  );
  assert.match(renderSlackText(content({ state: "closed", status: "fixed" })), /closed \(fixed\)/);

  const failing = fetchRecorder(() => new Response("echo secret-path", { status: 500 }));
  const broken = createSlackNotifier({
    webhookUrl: "https://hooks.example.test/services/secret-path",
    fetchImpl: failing.fetchImpl,
    retry: NO_WAIT
  });
  await assert.rejects(broken.session(repository()).sync(content(), undefined), (error) => {
    assert.equal(sanitizeTicketError(error), "slack POST request returned 500");
    return true;
  });
  assert.equal(failing.calls.length, 3);
});

test("Jira issues are found by label, created once, and transitioned to done on close", async () => {
  let searchHits: Array<{ key: string }> = [];
  const { fetchImpl, calls } = fetchRecorder((url, init) => {
    const method = init.method ?? "GET";
    if (url.includes("/rest/api/2/search")) {
      return Response.json({ issues: searchHits });
    }
    if (method === "POST" && url.endsWith("/rest/api/2/issue")) {
      return Response.json({ key: "SEC-12" }, { status: 201 });
    }
    if (method === "GET" && url.includes("/transitions")) {
      return Response.json({
        transitions: [
          { id: "11", to: { statusCategory: { key: "indeterminate" } } },
          { id: "31", to: { statusCategory: { key: "done" } } }
        ]
      });
    }
    return new Response(null, { status: 204 });
  });
  const jira = createJiraProvider({
    baseUrl: "https://jira.example.test",
    email: "bot@example.test",
    apiToken: "jira-token",
    projectKey: "SEC",
    issueType: "Bug",
    fetchImpl,
    retry: NO_WAIT
  });
  const session = jira.session(repository());
  assert.deepEqual(await session.sync(content(), undefined), { ref: "SEC-12" });
  const create = calls.find((call) => call.method === "POST");
  assert.deepEqual(create?.body.fields.labels, ["guardianbot", jiraFindingLabel(FINGERPRINT)]);
  assert.match(String(create?.headers.authorization), /^Basic /);

  searchHits = [{ key: "SEC-12" }];
  calls.length = 0;
  assert.deepEqual(await session.sync(content(), undefined), { ref: "SEC-12" });
  assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith("/issue")), false);

  calls.length = 0;
  await session.sync(content({ state: "closed", status: "fixed" }), {
    ref: "SEC-12",
    state: "open",
    updatedAt: "2026-07-27T00:00:00.000Z"
  });
  const transition = calls.find((call) => call.method === "POST" && call.url.endsWith("/transitions"));
  assert.deepEqual(transition?.body, { transition: { id: "31" } });
});

test("ticket endpoints must be HTTPS without embedded credentials", () => {
  assert.throws(() => parseHttpsEndpoint("http://example.test", "Endpoint"), /HTTPS/);
  assert.throws(() => parseHttpsEndpoint("https://user:pw@example.test", "Endpoint"), /without credentials/);
  assert.throws(() => parseHttpsEndpoint("nonsense", "Endpoint"), /absolute HTTPS URL/);
  assert.equal(parseHttpsEndpoint("https://example.test/a", "Endpoint").host, "example.test");
});
