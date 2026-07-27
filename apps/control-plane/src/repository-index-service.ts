import {
  indexRepositorySyntaxAware,
  toPersistedVectorRows,
  type RepositoryIndex
} from "@guardianbot/core";
import type { RepositoryIndexStorageMode, Store } from "./store.js";

const SOURCE_EXTENSION_PRIORITY = new Map<string, number>([
  [".py", 20],
  [".pyi", 20],
  [".js", 20],
  [".jsx", 20],
  [".mjs", 20],
  [".cjs", 20],
  [".ts", 20],
  [".tsx", 20],
  [".mts", 20],
  [".cts", 20],
  [".swift", 20],
  [".rb", 20],
  [".rake", 20],
  [".gemspec", 20]
]);

const MAX_INDEXED_FILES = 256;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const FETCH_CONCURRENCY = 8;

export interface RepositoryIndexGitHubClient {
  getTree(owner: string, repo: string, ref: string): Promise<string[]>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface RepositoryIndexRefreshInput {
  github: RepositoryIndexGitHubClient;
  repositoryId: number;
  installationId: number;
  fullName: string;
  defaultBranch: string;
  visibility: "public" | "private" | "internal";
}

export interface RepositoryIndexRefreshResult {
  commitSha: string;
  indexedFileCount: number;
  partial: boolean;
  storageMode: RepositoryIndexStorageMode;
  skipped: {
    unsupported: number;
    tooMany: number;
    oversized: number;
    binary: number;
    missing: number;
    fetchFailed: number;
    byteBudget: number;
  };
}

interface RepositoryFileRead {
  path: string;
  status: "loaded" | "oversized" | "binary" | "missing" | "fetch-failed" | "byte-budget";
  content?: string;
  byteLength?: number;
}

interface GitHubRefResponse {
  object?: { sha?: string };
}

interface GitHubContentsResponse {
  type?: string;
  encoding?: string;
  content?: string;
  sha?: string;
  size?: number;
}

export class RepositoryIndexService {
  constructor(private readonly store: Store) {}

  async refreshDefaultBranchIndex(
    input: RepositoryIndexRefreshInput
  ): Promise<RepositoryIndexRefreshResult> {
    const [owner, repo] = splitFullName(input.fullName);
    const commitSha = await this.resolveBranchHead(
      input.github,
      owner,
      repo,
      input.defaultBranch
    );
    const repositoryScope = `github:${input.repositoryId}`;
    const existing = await this.store.getRepositoryIndex(
      input.repositoryId,
      repositoryScope,
      commitSha
    );
    const storageMode = await this.store.getRepositoryIndexStorageMode();
    if (
      existing &&
      existing.repository === input.fullName &&
      existing.repositoryScope === repositoryScope &&
      existing.visibility === input.visibility &&
      existing.commitSha === commitSha
    ) {
      await this.store.replaceRepositoryIndex(
        input.repositoryId,
        existing,
        toPersistedVectorRows(existing)
      );
      return {
        commitSha,
        indexedFileCount: existing.files.length,
        partial: false,
        storageMode,
        skipped: zeroSkips()
      };
    }

    const tree = await input.github.getTree(owner, repo, commitSha);
    const supported = tree
      .map((path) => ({ path, priority: classifyIndexCandidate(path) }))
      .filter((candidate): candidate is { path: string; priority: number } => candidate.priority !== undefined)
      .sort((left, right) =>
        left.priority !== right.priority
          ? left.priority - right.priority
          : left.path.localeCompare(right.path)
      );

    const selected = supported.slice(0, MAX_INDEXED_FILES);
    const reads = await this.readIndexedFiles(
      input.github,
      owner,
      repo,
      commitSha,
      selected.map((candidate) => candidate.path)
    );
    const files = new Map<string, string>();
    const skipped = {
      unsupported: Math.max(tree.length - supported.length, 0),
      tooMany: Math.max(supported.length - selected.length, 0),
      oversized: 0,
      binary: 0,
      missing: 0,
      fetchFailed: 0,
      byteBudget: 0
    };
    for (const read of reads) {
      if (read.status === "loaded") {
        files.set(read.path, read.content ?? "");
        continue;
      }
      skipped[skipKey(read.status)] += 1;
    }

    const index = await indexRepositorySyntaxAware({
      repository: input.fullName,
      repositoryId: input.repositoryId,
      repositoryScope,
      visibility: input.visibility,
      commitSha,
      files: Object.fromEntries(files)
    });
    await this.store.replaceRepositoryIndex(
      input.repositoryId,
      index,
      toPersistedVectorRows(index)
    );
    return {
      commitSha,
      indexedFileCount: index.files.length,
      partial:
        skipped.tooMany > 0 ||
        skipped.oversized > 0 ||
        skipped.binary > 0 ||
        skipped.missing > 0 ||
        skipped.fetchFailed > 0 ||
        skipped.byteBudget > 0,
      storageMode,
      skipped
    };
  }

  async loadExactRepositoryIndex(
    repositoryId: number,
    commitSha: string
  ): Promise<RepositoryIndex | undefined> {
    return this.store.getRepositoryIndex(repositoryId, `github:${repositoryId}`, commitSha);
  }

  private async resolveBranchHead(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    branch: string
  ): Promise<string> {
    const response = await github.request<GitHubRefResponse>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
    );
    const commitSha = String(response.object?.sha ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(commitSha)) {
      throw new Error(`default branch ${branch} did not resolve to an immutable commit SHA`);
    }
    return commitSha;
  }

  private async readIndexedFiles(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    ref: string,
    paths: readonly string[]
  ): Promise<RepositoryFileRead[]> {
    const results = new Array<RepositoryFileRead>(paths.length);
    let nextIndex = 0;
    const workerCount = Math.min(FETCH_CONCURRENCY, Math.max(paths.length, 1));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const current = nextIndex;
          nextIndex += 1;
          if (current >= paths.length) return;
          const path = paths[current]!;
          results[current] = await this.readIndexedFile(github, owner, repo, path, ref);
        }
      })
    );

    // Apply the aggregate budget after concurrent fetches, in candidate order.
    // This makes reservation atomic and deterministic instead of allowing every
    // in-flight request to observe the same stale byte count.
    let usedBytes = 0;
    return results.map((read) => {
      if (read.status !== "loaded") return read;
      const byteLength = read.byteLength ?? Buffer.byteLength(read.content ?? "", "utf8");
      if (usedBytes + byteLength > MAX_TOTAL_BYTES) {
        return { path: read.path, status: "byte-budget" };
      }
      usedBytes += byteLength;
      return read;
    });
  }

  private async readIndexedFile(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<RepositoryFileRead> {
    try {
      const response = await github.request<GitHubContentsResponse>(
        "GET",
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
      );
      if (response.type !== "file") {
        return { path, status: "missing" };
      }
      if (
        Number.isSafeInteger(response.size) &&
        Number(response.size) > MAX_FILE_BYTES
      ) {
        return { path, status: "oversized" };
      }
      const bytes = decodeContent(response);
      if (bytes.length > MAX_FILE_BYTES) {
        return { path, status: "oversized" };
      }
      if (looksBinary(bytes)) {
        return { path, status: "binary" };
      }
      const content = bytes.toString("utf8");
      return { path, status: "loaded", content, byteLength: bytes.length };
    } catch (error) {
      if (String(error).includes("returned 404")) {
        return { path, status: "missing" };
      }
      return { path, status: "fetch-failed" };
    }
  }
}

function splitFullName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) {
    throw new Error(`repository full name is invalid: ${fullName}`);
  }
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

function classifyIndexCandidate(path: string): number | undefined {
  if (/^(?:\.github\/CODEOWNERS|CODEOWNERS|docs\/CODEOWNERS)$/i.test(path)) return 0;
  if (/^\.guardianbot\/config\.ya?ml$/i.test(path)) return 1;
  if (/^\.github\/workflows\/[^/]+\.(?:ya?ml)$/i.test(path)) return 2;
  if (
    /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|docker-compose[^/]*\.(?:ya?ml))$/i.test(path)
  ) {
    return 3;
  }
  if (/(?:^|\/)(openapi|swagger|schemas?)(?:\/|[._-])/i.test(path)) return 4;

  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  if (SOURCE_EXTENSION_PRIORITY.has(extension)) return SOURCE_EXTENSION_PRIORITY.get(extension);

  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (
    /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|Gemfile(?:\.lock)?|Rakefile|Package\.swift|Podfile(?:\.lock)?)$/i.test(
      fileName
    )
  ) {
    return 5;
  }
  if (/\.(?:json|ya?ml|toml|ini|graphql|prisma)$/i.test(fileName) && /(config|schema|openapi|swagger)/i.test(path)) {
    return 6;
  }
  if (
    /\.(?:md|mdx|markdown|txt|text|rst|adoc)$/i.test(fileName) ||
    /^(?:README|SECURITY|CONTRIBUTING|CHANGELOG|LICENSE|NOTICE)(?:\.[^/]*)?$/i.test(fileName)
  ) {
    return 30;
  }
  return undefined;
}

function decodeContent(response: GitHubContentsResponse): Buffer {
  const content = typeof response.content === "string" ? response.content.replace(/\n/g, "") : "";
  if ((response.encoding ?? "base64") === "base64") {
    return Buffer.from(content, "base64");
  }
  return Buffer.from(content, "utf8");
}

function looksBinary(value: Buffer): boolean {
  for (const byte of value.values()) {
    if (byte === 0) return true;
  }
  return false;
}

function zeroSkips(): RepositoryIndexRefreshResult["skipped"] {
  return {
    unsupported: 0,
    tooMany: 0,
    oversized: 0,
    binary: 0,
    missing: 0,
    fetchFailed: 0,
    byteBudget: 0
  };
}

function skipKey(
  status: RepositoryFileRead["status"]
): keyof RepositoryIndexRefreshResult["skipped"] {
  switch (status) {
    case "oversized":
    case "binary":
    case "missing":
    case "fetch-failed":
    case "byte-budget":
      return status === "fetch-failed" ? "fetchFailed" : status === "byte-budget" ? "byteBudget" : status;
    default:
      throw new Error(`unsupported skip status ${status}`);
  }
}
