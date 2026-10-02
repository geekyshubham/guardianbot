import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  FINDING_TICKET_MARKER_PREFIX,
  FindingTicketError,
  createGitHubIssuesProvider,
  createInstallationIssueClientFactory,
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

const APP_IDENTITY = { id: 4242, slug: "guardianbot" };

function issueClient(
  handler: (call: IssueCall) => unknown,
  appIdentity: FindingIssueClient["appIdentity"] | null = APP_IDENTITY
): { client: FindingIssueClient; calls: IssueCall[] } {
  const calls: IssueCall[] = [];
  return {
    calls,
    client: {
      appIdentity: appIdentity ?? undefined,
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

test("a lost issue reference is recovered only from an issue this App opened", async () => {
  const marker = `<!-- ${FINDING_TICKET_MARKER_PREFIX}${FINGERPRINT} -->`;
  const markerIssues = [
    { number: 7, body: marker, user: { login: "mallory", type: "User" } },
    { number: 9, body: marker, user: { login: "other-app[bot]", type: "Bot" } },
    {
      number: 11,
      body: marker,
      user: { login: "mallory", type: "User" },
      performed_via_github_app: { id: 99, slug: "other-app" }
    },
    { number: 12, body: "no marker here", user: { login: "mallory", type: "User" } },
    { number: 13, body: marker, user: { login: "guardianbot[bot]", type: "Bot" } }
  ];
  const { client, calls } = issueClient((call) => (call.method === "GET" ? markerIssues : {}));
  const provider = createGitHubIssuesProvider({ clientFactory: async () => client, retry: NO_WAIT });
  const session = provider.session(repository());
  assert.equal(session.markerScan?.(), undefined, "no scan has run yet");
  const result = await session.sync(content(), undefined);
  assert.deepEqual(result, { ref: "13" });
  assert.equal(calls.some((call) => call.method === "POST"), false);
  assert.equal(calls.at(-1)?.path, "/repos/acme/service/issues/13");
  assert.deepEqual(session.markerScan?.(), { untrusted: 3 });

  const viaApp = issueClient((call) =>
    call.method === "GET"
      ? [{ number: 21, body: marker, user: { login: "octo", type: "User" }, performed_via_github_app: { id: 4242 } }]
      : {}
  );
  const appSession = createGitHubIssuesProvider({ clientFactory: async () => viaApp.client, retry: NO_WAIT }).session(
    repository()
  );
  assert.deepEqual(await appSession.sync(content(), undefined), { ref: "21" });
});

test("without a known App identity no marker is trusted and a new issue is opened", async () => {
  const marker = `<!-- ${FINDING_TICKET_MARKER_PREFIX}${FINGERPRINT} -->`;
  const { client, calls } = issueClient(
    (call) => {
      if (call.method === "GET") return [{ number: 13, body: marker, user: { login: "guardianbot[bot]", type: "Bot" } }];
      if (call.method === "POST") return { number: 50 };
      return {};
    },
    null
  );
  const session = createGitHubIssuesProvider({ clientFactory: async () => client, retry: NO_WAIT }).session(
    repository()
  );
  assert.deepEqual(await session.sync(content(), undefined), { ref: "50" });
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  assert.deepEqual(session.markerScan?.(), { untrusted: 1 });
});

test("the installation client verifies the App identity once and fails closed on a mismatch", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  let appId: unknown = 4242;
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/app")) return Response.json({ id: appId, slug: "guardianbot" });
    return Response.json({ token: "ghs_test" }, { status: 201 });
  }) as typeof fetch;
  const factory = createInstallationIssueClientFactory({
    appId: "4242",
    privateKey: pem,
    fetchImpl,
    apiBase: "https://api.example.test"
  });
  const client = await factory(repository());
  assert.deepEqual(client.appIdentity, { id: 4242, slug: "guardianbot" });
  await factory(repository());
  assert.equal(requests.filter((request) => request === "GET /app").length, 1, "identity is cached");

  appId = 7;
  const mismatched = createInstallationIssueClientFactory({
    appId: "4242",
    privateKey: pem,
    fetchImpl,
    apiBase: "https://api.example.test"
  });
  await assert.rejects(mismatched(repository()), (error) => {
    assert.equal(sanitizeTicketError(error), "github-issues app identity does not match GITHUB_APP_ID");
    return true;
  });
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
      assert.ok(url.includes("/rest/api/2/search/jql?"), "only the enhanced search endpoint is used");
      return Response.json({ issues: searchHits, isLast: true });
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

  const search = new URL(calls.find((call) => call.url.includes("/search/jql"))!.url);
  assert.equal(search.searchParams.get("fields"), "key");
  assert.match(String(search.searchParams.get("jql")), /^project = "SEC" AND labels = "guardianbot-finding-e{64}"/);

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

test("Jira search follows nextPageToken within a page cap", async () => {
  const tokens: Array<string | null> = [];
  let pages = 0;
  const endless = { value: false };
  const { fetchImpl } = fetchRecorder((url) => {
    if (url.includes("/search/jql")) {
      tokens.push(new URL(url).searchParams.get("nextPageToken"));
      pages += 1;
      if (endless.value) return Response.json({ issues: [], isLast: false, nextPageToken: `t${pages}` });
      return pages === 1
        ? Response.json({ issues: [], isLast: false, nextPageToken: "page-2" })
        : Response.json({ issues: [{ key: "SEC-77" }], isLast: true });
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
  assert.deepEqual(await jira.session(repository()).sync(content(), undefined), { ref: "SEC-77" });
  assert.deepEqual(tokens, [null, "page-2"]);

  endless.value = true;
  pages = 0;
  await assert.rejects(jira.session(repository()).sync(content(), undefined), (error) => {
    assert.equal(sanitizeTicketError(error), "jira search exceeded its page limit");
    return true;
  });
  assert.ok(pages <= 15, "the page cap bounds the search even across retries");
});

test("ticket endpoints must be HTTPS without embedded credentials", () => {
  assert.throws(() => parseHttpsEndpoint("http://example.test", "Endpoint"), /HTTPS/);
  assert.throws(() => parseHttpsEndpoint("https://user:pw@example.test", "Endpoint"), /without credentials/);
  assert.throws(() => parseHttpsEndpoint("nonsense", "Endpoint"), /absolute HTTPS URL/);
  assert.equal(parseHttpsEndpoint("https://example.test/a", "Endpoint").host, "example.test");
});
