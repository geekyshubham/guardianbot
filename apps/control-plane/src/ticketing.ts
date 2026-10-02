import { createHash } from "node:crypto";
import { GitHubClient, GitHubRateLimitError } from "@guardianbot/core";
import { createAppJwt } from "./app-auth.js";
import type {
  FindingLifecycleSeverity,
  FindingLifecycleSource,
  FindingLifecycleStatus,
  FindingTicketProviderName,
  FindingTicketState,
  RepositoryRecord
} from "./store.js";

/**
 * Ticket and notifier providers for deterministic finding lifecycle records.
 *
 * Every provider runs only in the control plane with control-plane credentials.
 * Rendered content is bounded scanner metadata (source, rule, severity, location,
 * owner, lifecycle dates); scanner titles and descriptions are never copied, so a
 * secret-scanner match or a repository-controlled message cannot leak into a
 * ticket. Every failure surfaces as a sanitized `FindingTicketError` whose message
 * holds only the provider, method, and status, never a URL, token, or response body.
 */

export const FINDING_TICKET_MARKER_PREFIX = "guardianbot-finding:";
const DEFAULT_TICKET_TIMEOUT_MS = 30_000;
const DEFAULT_TICKET_MAX_ATTEMPTS = 3;
const DEFAULT_TICKET_BACKOFF_MS = 1_000;
const MAX_ISSUE_SEARCH_PAGES = 10;
const MAX_INLINE_VALUE = 200;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,9}-\d{1,10}$/;

export interface FindingTicketContent {
  repository: string;
  fingerprint: string;
  source: FindingLifecycleSource;
  ruleId: string;
  severity: FindingLifecycleSeverity;
  path?: string;
  line?: number;
  owner: string;
  status: FindingLifecycleStatus;
  breached: boolean;
  firstSeenAt: string;
  openedAt: string;
  slaDueAt?: string;
  fixedAt?: string;
  /** Desired provider state: only an `open` lifecycle record keeps its ticket open. */
  state: "open" | "closed";
}

export interface FindingTicketSyncResult {
  ref?: string;
}

export interface FindingTicketSession {
  sync(
    content: FindingTicketContent,
    previous: FindingTicketState | undefined
  ): Promise<FindingTicketSyncResult>;
}

export interface FindingTicketProvider {
  readonly name: FindingTicketProviderName;
  /** True for providers that write into the consumer repository itself. */
  readonly requiresRepositoryOptIn: boolean;
  /** Digest of exactly the fields this provider renders, so unchanged content costs no call. */
  contentSha(content: FindingTicketContent): string;
  session(repository: RepositoryRecord): FindingTicketSession;
}

export interface FindingTicketRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Sanitized ticketing failure. `kind` is fixed vocabulary plus an HTTP status. */
export class FindingTicketError extends Error {
  constructor(
    readonly kind: string,
    readonly retryable: boolean
  ) {
    super(kind);
    this.name = "FindingTicketError";
  }
}

export function defaultTicketRetryPolicy(
  overrides: Partial<FindingTicketRetryPolicy> = {}
): FindingTicketRetryPolicy {
  return {
    maxAttempts: overrides.maxAttempts ?? DEFAULT_TICKET_MAX_ATTEMPTS,
    backoffMs: overrides.backoffMs ?? DEFAULT_TICKET_BACKOFF_MS,
    sleep:
      overrides.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  };
}

/** Bounded, credential-free error text suitable for persistence and alerts. */
export function sanitizeTicketError(error: unknown): string {
  if (error instanceof FindingTicketError) return error.kind.slice(0, 128);
  return "ticket provider request failed";
}

async function withRetry<T>(
  policy: FindingTicketRetryPolicy,
  operation: () => Promise<T>
): Promise<T> {
  const attempts = Math.max(1, policy.maxAttempts);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const normalized =
        error instanceof FindingTicketError
          ? error
          : new FindingTicketError("ticket provider request failed", false);
      if (!normalized.retryable || attempt >= attempts) throw normalized;
      await policy.sleep(policy.backoffMs * 2 ** (attempt - 1));
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Single-line, bounded, markup-inert rendering of scanner-provided text. */
function inertText(value: string | number | undefined, maximum = MAX_INLINE_VALUE): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[`<>{}[\]|*_\\@]/g, "")
    .trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum)}...`;
}

function locationText(content: FindingTicketContent): string {
  if (!content.path) return "not applicable";
  return content.line ? `${inertText(content.path)}:${content.line}` : inertText(content.path);
}

function ticketTitle(content: FindingTicketContent): string {
  return `GuardianBot ${content.severity} ${content.source} finding ${inertText(content.ruleId, 80)}`;
}

function lifecycleLabel(content: FindingTicketContent): string {
  if (content.state === "closed") return content.status;
  return content.breached ? "open, past SLA" : "open";
}

function ticketFields(content: FindingTicketContent): Array<[string, string]> {
  return [
    ["Repository", inertText(content.repository)],
    ["Source", content.source],
    ["Rule", inertText(content.ruleId)],
    ["Severity", content.severity],
    ["Location", locationText(content)],
    ["Owner", inertText(content.owner)],
    ["Status", lifecycleLabel(content)],
    ["First seen", content.firstSeenAt],
    ["Current episode opened", content.openedAt],
    ["SLA due", content.slaDueAt ?? "not tracked"],
    ...(content.fixedAt ? ([["Fixed", content.fixedAt]] as Array<[string, string]>) : []),
    ["Fingerprint", content.fingerprint]
  ];
}

export function renderGitHubIssueBody(content: FindingTicketContent): string {
  const rows = ticketFields(content).map(([label, value]) => `| ${label} | \`${value}\` |`);
  return [
    `<!-- ${FINDING_TICKET_MARKER_PREFIX}${content.fingerprint} -->`,
    "GuardianBot tracks this deterministic scanner finding from trusted default-branch or deployed-digest evidence.",
    "The control plane opens, updates, and closes this issue; edits here are overwritten.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows,
    "",
    "Scanner titles and descriptions are intentionally omitted. Use the fingerprint to find the full evidence in the scanner run or DefectDojo."
  ].join("\n");
}

function statusFromGitHubError(error: unknown): number | undefined {
  const match = /returned (\d{3})\b/.exec(error instanceof Error ? error.message : "");
  return match ? Number(match[1]) : undefined;
}

function gitHubTicketError(method: string, error: unknown): FindingTicketError {
  if (error instanceof FindingTicketError) return error;
  if (error instanceof GitHubRateLimitError) {
    // Throttling is retried on the next lifecycle pass, never by spinning here.
    return new FindingTicketError(`github-issues ${method} request was rate limited`, false);
  }
  const status = statusFromGitHubError(error);
  if (status !== undefined) {
    return new FindingTicketError(
      `github-issues ${method} request returned ${status}`,
      RETRYABLE_STATUS_CODES.has(status)
    );
  }
  const message = error instanceof Error ? error.message : "";
  return new FindingTicketError(
    `github-issues ${method} request ${message.includes("timed out") ? "timed out" : "failed"}`,
    true
  );
}

export interface FindingIssueClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export type FindingIssueClientFactory = (
  repository: RepositoryRecord
) => Promise<FindingIssueClient>;

/**
 * Mints a repository-scoped installation token with only `issues: write`, so the
 * ticketing path can never read code or touch Actions.
 */
export function createInstallationIssueClientFactory(input: {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): FindingIssueClientFactory {
  const apiBase = input.apiBase ?? "https://api.github.com";
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (repository) => {
    const appClient = new GitHubClient(
      createAppJwt(input.appId, input.privateKey),
      apiBase,
      DEFAULT_TICKET_TIMEOUT_MS,
      fetchImpl
    );
    let token: string | undefined;
    try {
      const response = await appClient.request<{ token?: string }>(
        "POST",
        `/app/installations/${repository.installationId}/access_tokens`,
        {
          repository_ids: [repository.repositoryId],
          permissions: { issues: "write" }
        }
      );
      token = response?.token;
    } catch (error) {
      throw gitHubTicketError("token", error);
    }
    if (!token) throw new FindingTicketError("github-issues token response omitted token", false);
    return new GitHubClient(token, apiBase, DEFAULT_TICKET_TIMEOUT_MS, fetchImpl);
  };
}

interface GitHubIssueSummary {
  number?: number;
  body?: string | null;
  pull_request?: unknown;
  user?: { login?: string; type?: string } | null;
}

/**
 * One GitHub issue per root cause. Idempotency comes from the stored issue number,
 * then from the hidden marker on a bot-authored issue, so a lost database write or a
 * retry never opens a duplicate. Human-authored issues carrying the marker are ignored
 * so a repository user cannot make the control plane overwrite their issue.
 */
export function createGitHubIssuesProvider(input: {
  clientFactory: FindingIssueClientFactory;
  retry?: FindingTicketRetryPolicy;
}): FindingTicketProvider {
  const retry = input.retry ?? defaultTicketRetryPolicy();
  return {
    name: "github-issues",
    requiresRepositoryOptIn: true,
    contentSha: (content) =>
      digest({ provider: "github-issues", title: ticketTitle(content), body: renderGitHubIssueBody(content), state: content.state }),
    session(repository) {
      const [owner, repo] = repository.fullName.split("/");
      if (!owner || !repo) {
        throw new FindingTicketError("github-issues repository slug is invalid", false);
      }
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
      let client: Promise<FindingIssueClient> | undefined;
      let markers: Promise<Map<string, number>> | undefined;
      const call = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
        withRetry(retry, async () => {
          try {
            client ??= input.clientFactory(repository);
            return await (await client).request<T>(method, path, body);
          } catch (error) {
            if (error instanceof FindingTicketError) client = undefined;
            throw gitHubTicketError(method, error);
          }
        });
      const loadMarkers = async (): Promise<Map<string, number>> => {
        const found = new Map<string, number>();
        for (let page = 1; page <= MAX_ISSUE_SEARCH_PAGES; page += 1) {
          const issues = await call<GitHubIssueSummary[]>(
            "GET",
            `${base}?state=all&sort=created&direction=desc&per_page=100&page=${page}`
          );
          for (const issue of Array.isArray(issues) ? issues : []) {
            if (issue.pull_request || issue.user?.type !== "Bot") continue;
            const match = new RegExp(`<!-- ${FINDING_TICKET_MARKER_PREFIX}([a-f0-9]{64}) -->`).exec(
              String(issue.body ?? "")
            );
            if (match?.[1] && Number.isSafeInteger(issue.number) && !found.has(match[1])) {
              found.set(match[1], Number(issue.number));
            }
          }
          if (!Array.isArray(issues) || issues.length < 100) break;
        }
        return found;
      };
      return {
        async sync(content, previous) {
          if (!FINGERPRINT_PATTERN.test(content.fingerprint)) {
            throw new FindingTicketError("github-issues fingerprint is invalid", false);
          }
          const update = {
            title: ticketTitle(content),
            body: renderGitHubIssueBody(content),
            state: content.state
          };
          let issueNumber =
            previous?.ref && /^\d{1,12}$/.test(previous.ref) ? Number(previous.ref) : undefined;
          if (issueNumber !== undefined) {
            try {
              await call("PATCH", `${base}/${issueNumber}`, update);
              return { ref: String(issueNumber) };
            } catch (error) {
              const kind = error instanceof FindingTicketError ? error.kind : "";
              if (!/returned (404|410)$/.test(kind)) throw error;
              issueNumber = undefined;
            }
          }
          markers ??= loadMarkers();
          issueNumber = (await markers).get(content.fingerprint);
          if (issueNumber !== undefined) {
            await call("PATCH", `${base}/${issueNumber}`, update);
            return { ref: String(issueNumber) };
          }
          // Never create an issue only to close it.
          if (content.state === "closed") return {};
          const created = await call<{ number?: number }>("POST", base, {
            title: update.title,
            body: update.body
          });
          if (!Number.isSafeInteger(created?.number)) {
            throw new FindingTicketError("github-issues create response omitted the issue number", false);
          }
          (await markers).set(content.fingerprint, Number(created.number));
          return { ref: String(created.number) };
        }
      };
    }
  };
}

async function postJson(
  provider: FindingTicketProviderName,
  fetchImpl: typeof fetch,
  method: string,
  url: URL,
  headers: Record<string, string>,
  body?: unknown
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "guardianbot/0.1",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TICKET_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut =
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof Error && error.name === "AbortError");
    throw new FindingTicketError(`${provider} ${method} request ${timedOut ? "timed out" : "failed"}`, true);
  }
  if (!response.ok) {
    // The body is discarded unread: providers echo request detail into it.
    await response.body?.cancel().catch(() => undefined);
    throw new FindingTicketError(
      `${provider} ${method} request returned ${response.status}`,
      RETRYABLE_STATUS_CODES.has(response.status)
    );
  }
  return response;
}

function slackEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderSlackText(content: FindingTicketContent): string {
  const event =
    content.state === "closed"
      ? `closed (${content.status})`
      : content.breached
        ? "past SLA"
        : "opened";
  const location = content.path ? ` at ${locationText(content)}` : "";
  const due = content.slaDueAt ? `, SLA due ${content.slaDueAt}` : "";
  return slackEscape(
    `GuardianBot ${content.severity} finding ${event}: ${inertText(content.repository)} ` +
      `${content.source} ${inertText(content.ruleId)}${location}, owner ${inertText(content.owner)}${due}. ` +
      `Fingerprint ${content.fingerprint.slice(0, 16)}.`
  );
}

/**
 * Slack-compatible incoming webhook. It notifies only on lifecycle transitions
 * (opened, crossed its SLA, closed), so the digest covers just those fields.
 */
export function createSlackNotifier(input: {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  retry?: FindingTicketRetryPolicy;
}): FindingTicketProvider {
  const url = parseHttpsEndpoint(input.webhookUrl, "Slack webhook URL");
  const fetchImpl = input.fetchImpl ?? fetch;
  const retry = input.retry ?? defaultTicketRetryPolicy();
  return {
    name: "slack",
    requiresRepositoryOptIn: false,
    contentSha: (content) =>
      digest({ provider: "slack", state: content.state, status: content.status, breached: content.breached }),
    session() {
      return {
        async sync(content) {
          await withRetry(retry, async () => {
            const response = await postJson("slack", fetchImpl, "POST", url, {}, {
              text: renderSlackText(content)
            });
            await response.body?.cancel().catch(() => undefined);
          });
          return {};
        }
      };
    }
  };
}

function jiraDescription(content: FindingTicketContent): string {
  return [
    "GuardianBot tracks this deterministic scanner finding from trusted default-branch or deployed-digest evidence.",
    "",
    ...ticketFields(content).map(([label, value]) => `* ${label}: ${value}`),
    "",
    "Scanner titles and descriptions are intentionally omitted."
  ].join("\n");
}

export function jiraFindingLabel(fingerprint: string): string {
  return `guardianbot-finding-${fingerprint}`;
}

interface JiraTransition {
  id?: string;
  to?: { statusCategory?: { key?: string } };
}

/**
 * Jira REST v2. The issue key is stored as the ticket reference; a lost key is
 * recovered through the per-fingerprint label, so retries never duplicate issues.
 * Closing moves the issue through the first transition into the "done" category.
 */
export function createJiraProvider(input: {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  fetchImpl?: typeof fetch;
  retry?: FindingTicketRetryPolicy;
}): FindingTicketProvider {
  const base = parseHttpsEndpoint(input.baseUrl, "Jira base URL");
  const fetchImpl = input.fetchImpl ?? fetch;
  const retry = input.retry ?? defaultTicketRetryPolicy();
  const authorization = `Basic ${Buffer.from(`${input.email}:${input.apiToken}`).toString("base64")}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T | undefined> =>
    withRetry(retry, async () => {
      const url = new URL(path, base);
      if (url.origin !== base.origin) {
        throw new FindingTicketError("jira request cannot leave the configured origin", false);
      }
      const response = await postJson("jira", fetchImpl, method, url, { authorization }, body);
      if (response.status === 204) return undefined;
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : undefined;
    });
  const transition = async (key: string, category: "done" | "new" | "indeterminate"): Promise<boolean> => {
    const result = await call<{ transitions?: JiraTransition[] }>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`
    );
    const target = (result?.transitions ?? []).find(
      (candidate) => candidate.to?.statusCategory?.key === category && candidate.id
    );
    if (!target?.id) return false;
    await call("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: target.id }
    });
    return true;
  };
  return {
    name: "jira",
    requiresRepositoryOptIn: false,
    contentSha: (content) =>
      digest({ provider: "jira", summary: ticketTitle(content), description: jiraDescription(content), state: content.state }),
    session() {
      return {
        async sync(content, previous) {
          if (!FINGERPRINT_PATTERN.test(content.fingerprint)) {
            throw new FindingTicketError("jira fingerprint is invalid", false);
          }
          const fields = { summary: ticketTitle(content), description: jiraDescription(content) };
          let key = previous?.ref && JIRA_KEY_PATTERN.test(previous.ref) ? previous.ref : undefined;
          if (!key) {
            const jql = `project = "${input.projectKey}" AND labels = "${jiraFindingLabel(content.fingerprint)}"`;
            const found = await call<{ issues?: Array<{ key?: string }> }>(
              "GET",
              `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`
            );
            const candidate = found?.issues?.[0]?.key;
            key = candidate && JIRA_KEY_PATTERN.test(candidate) ? candidate : undefined;
          }
          if (!key) {
            if (content.state === "closed") return {};
            const created = await call<{ key?: string }>("POST", "/rest/api/2/issue", {
              fields: {
                ...fields,
                project: { key: input.projectKey },
                issuetype: { name: input.issueType },
                labels: ["guardianbot", jiraFindingLabel(content.fingerprint)]
              }
            });
            if (!created?.key || !JIRA_KEY_PATTERN.test(created.key)) {
              throw new FindingTicketError("jira create response omitted the issue key", false);
            }
            return { ref: created.key };
          }
          await call("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { fields });
          if (content.state === "closed" && previous?.state !== "closed") {
            if (!(await transition(key, "done"))) {
              throw new FindingTicketError("jira issue has no transition into the done category", false);
            }
          } else if (content.state === "open" && previous?.state === "closed") {
            // A regression reopens best effort; the updated description already says open.
            if (!(await transition(key, "new"))) await transition(key, "indeterminate");
          }
          return { ref: key };
        }
      };
    }
  };
}

export function parseHttpsEndpoint(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or fragment`);
  }
  return url;
}
