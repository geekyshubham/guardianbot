export interface GitHubRepository {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  visibility?: "public" | "private" | "internal";
  archived: boolean;
  fork: boolean;
}

/** Retry window bounds so a hostile or broken reset header cannot park a job forever. */
const MIN_RATE_LIMIT_RETRY_MS = 1_000;
const MAX_RATE_LIMIT_RETRY_MS = 60 * 60_000;
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

/**
 * Raised when GitHub throttles a request. Callers requeue at `retryAt` instead of
 * burning a delivery attempt, because throttling says nothing about the delivery.
 */
export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt: Date,
    readonly remaining: number | undefined
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** retry-after is either delta-seconds or an HTTP date; both are accepted. */
function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = parseNonNegativeInteger(raw);
  if (seconds !== undefined) return seconds * 1_000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at - now : undefined;
}

/**
 * Detects a throttling response. A 403 without any budget signal stays a permanent
 * failure, so authorization errors are never mistaken for rate limits.
 */
function rateLimitWindow(
  response: Response,
  now: number
): { retryAt: Date; remaining: number | undefined } | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const remaining = parseNonNegativeInteger(response.headers.get("x-ratelimit-remaining"));
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now);
  if (retryAfterMs === undefined && remaining !== 0) return undefined;
  const resetAt = parseNonNegativeInteger(response.headers.get("x-ratelimit-reset"));
  const waitMs =
    retryAfterMs ??
    (resetAt === undefined ? DEFAULT_RATE_LIMIT_RETRY_MS : resetAt * 1_000 - now);
  const bounded = Math.min(
    MAX_RATE_LIMIT_RETRY_MS,
    Math.max(MIN_RATE_LIMIT_RETRY_MS, waitMs)
  );
  return { retryAt: new Date(now + bounded), remaining };
}

/**
 * Builds the message for a failed request.
 *
 * Request paths carry identifiers — a pull-request comment id, a collaborator login, a blob SHA —
 * and a thrown message is not a local diagnostic: callers persist it into unbounded columns such
 * as `webhook_jobs.last_error`, which would smuggle a retained identifier past the bounded stores
 * that are supposed to hold it. So the message carries only the method and, for a response, the
 * status: both are fixed-vocabulary and neither identifies a repository, a person, or a comment.
 * The response body is left out for the same reason, since GitHub echoes request detail into it.
 *
 * `returned ${status}` is load-bearing text: callers discriminate an absent resource by matching
 * `returned 404` on the stringified error, so the status must stay in the message.
 */
function requestFailureMessage(method: string, detail: string): string {
  return `GitHub ${method} request ${detail}`;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const base = new URL(apiBase);
    const loopback =
      base.hostname === "localhost" ||
      base.hostname === "127.0.0.1" ||
      base.hostname === "[::1]";
    if (base.protocol !== "https:" && !(loopback && base.protocol === "http:")) {
      throw new Error("GitHub API base URL must use HTTPS outside loopback development");
    }
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 120_000
    ) {
      throw new Error("GitHub client configuration is invalid");
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const base = new URL(this.apiBase);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new Error("GitHub API request cannot leave the configured origin");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "guardianbot/0.1",
          "x-github-api-version": "2022-11-28",
          ...(extraHeaders ?? {}),
          authorization: `Bearer ${this.token}`
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === "TimeoutError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new Error(requestFailureMessage(method, "timed out"));
      }
      throw new Error(requestFailureMessage(method, "failed"), { cause: error });
    }
    if (!response.ok) {
      const throttled = rateLimitWindow(response, Date.now());
      if (throttled) {
        throw new GitHubRateLimitError(
          requestFailureMessage(
            method,
            `was rate limited until ${throttled.retryAt.toISOString()}`
          ),
          throttled.retryAt,
          throttled.remaining
        );
      }
      throw new Error(requestFailureMessage(method, `returned ${response.status}`));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request("GET", `/repos/${owner}/${repo}`);
  }

  async getTree(owner: string, repo: string, ref: string): Promise<string[]> {
    const response = await this.request<{
      tree: Array<{ path: string; type: string }>;
      truncated: boolean;
    }>("GET", `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (response.truncated) {
      throw new Error("Repository tree is truncated; onboarding requires a scoped tree walker");
    }
    return response.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
  }

  async getLanguages(owner: string, repo: string): Promise<Record<string, number>> {
    return this.request("GET", `/repos/${owner}/${repo}/languages`);
  }

  async getFile(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | undefined> {
    try {
      const result = await this.request<{ content: string; encoding: string; sha: string }>(
        "GET",
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
      );
      return {
        content:
          result.encoding === "base64"
            ? Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf8")
            : result.content,
        sha: result.sha
      };
    } catch (error) {
      if (String(error).includes("returned 404")) return undefined;
      throw error;
    }
  }

  createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string
  ): Promise<{ html_url: string; number: number }> {
    return this.request("POST", `/repos/${owner}/${repo}/issues`, { title, body });
  }

  createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    return this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      body
    });
  }

  updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    return this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      body
    });
  }

  async listAuthenticatedRepositories(): Promise<GitHubRepository[]> {
    const repositories: GitHubRepository[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request<GitHubRepository[]>(
        "GET",
        `/user/repos?affiliation=owner&per_page=100&page=${page}&sort=full_name`
      );
      repositories.push(...batch);
      if (batch.length < 100) return repositories;
    }
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string
  ): Promise<void> {
    const base = await this.request<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`
    );
    await this.request("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: base.object.sha
    });
  }

  putFile(
    owner: string,
    repo: string,
    path: string,
    branch: string,
    message: string,
    content: string,
    sha?: string
  ): Promise<{ content: { sha: string } }> {
    return this.request(
      "PUT",
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {})
      }
    );
  }

  deleteFile(
    owner: string,
    repo: string,
    path: string,
    branch: string,
    message: string,
    sha: string
  ): Promise<void> {
    return this.request(
      "DELETE",
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      { message, sha, branch }
    );
  }

  createPullRequest(
    owner: string,
    repo: string,
    input: {
      title: string;
      head: string;
      base: string;
      body: string;
      draft?: boolean;
    }
  ): Promise<{ number: number; html_url: string }> {
    return this.request("POST", `/repos/${owner}/${repo}/pulls`, input);
  }

  listWorkflowRuns(
    owner: string,
    repo: string,
    workflow: string
  ): Promise<{ workflow_runs: Array<{ status: string; conclusion: string | null; html_url: string }> }> {
    return this.request(
      "GET",
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=5`
    );
  }
}
