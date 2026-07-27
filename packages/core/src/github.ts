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
        throw new Error(`GitHub ${method} ${url.pathname} timed out`);
      }
      throw new Error(`GitHub ${method} ${url.pathname} failed`, { cause: error });
    }
    if (!response.ok) {
      const text = (await response.text()).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000);
      throw new Error(
        `GitHub ${method} ${url.pathname} returned ${response.status}: ${text}`
      );
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
