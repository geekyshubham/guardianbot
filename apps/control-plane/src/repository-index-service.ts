import {
  buildRepositoryIndexIncremental,
  indexRepositorySyntaxAware,
  LexicalHashEmbeddingProvider,
  RepositoryIsolationError,
  toPersistedVectorRows,
  type PersistedRecordRow,
  type PersistedVectorRow,
  type RepositoryIndex,
  type RepositoryRecordHydrationRequest,
  type RepositoryVectorMatch,
  type RepositoryVectorQuery,
  type RepositoryVectorRanker
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

/**
 * Indexing caps are policy, not physics, so they are constructor options rather
 * than module constants. The defaults are the historical values.
 */
export interface RepositoryIndexServiceOptions {
  maxIndexedFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  fetchConcurrency?: number;
  /** Files re-fetched in one incremental refresh before falling back to a full rebuild. */
  maxIncrementalFiles?: number;
}

/**
 * GitHub caps `files` on the compare endpoint at 300 entries and paginates the
 * remainder. A response sitting at the cap may therefore omit changed paths, and
 * an omitted path is indistinguishable from an unchanged one, so it would be
 * carried forward from the prior head with stale content. A commit range that
 * broad is not worth an incremental refresh, so it takes the full-rebuild path.
 */
const COMPARE_FILE_PAGE_LIMIT = 300;

const DEFAULT_INDEX_LIMITS = {
  maxIndexedFiles: 256,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  fetchConcurrency: 8,
  maxIncrementalFiles: 256
} as const;

export interface RepositoryIndexGitHubClient {
  getTree(owner: string, repo: string, ref: string): Promise<string[]>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

interface GitHubTreeEntry {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GitHubTreeResponse {
  tree?: GitHubTreeEntry[];
  truncated?: boolean;
}

interface GitHubBlobResponse {
  encoding?: string;
  content?: string;
  size?: number;
}

interface GitHubCompareFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
}

interface GitHubCompareResponse {
  files?: GitHubCompareFile[];
  status?: string;
  total_commits?: number;
}

/** One blob from the recursive tree, carrying the SHA needed for a git blob read. */
interface RepositoryTreeBlob {
  path: string;
  sha?: string;
  size?: number;
}

/** A tree blob that classified as indexable, with its selection priority. */
interface IndexCandidate extends RepositoryTreeBlob {
  priority: number;
}

/**
 * How much of the repository the published index actually covers. `partial` alone
 * cannot distinguish a repository that lost one unreadable file from one that was
 * truncated to a fraction of its source, so the ratio is reported explicitly.
 */
export interface RepositoryIndexCoverage {
  /** Indexable candidates discovered in the tree. */
  candidateFileCount: number;
  /** Candidates actually present in the published index. */
  indexedFileCount: number;
  /** Candidates dropped by the file cap or a byte budget, as a 0-1 ratio. */
  truncationRatio: number;
  /** True when any candidate was dropped by the file cap specifically. */
  fileCapReached: boolean;
}

export interface RepositoryIndexRefreshInput {
  github: RepositoryIndexGitHubClient;
  repositoryId: number;
  installationId: number;
  fullName: string;
  defaultBranch: string;
  visibility: "public" | "private" | "internal";
  /**
   * Cancels a rebuild that shutdown no longer has budget for. Checked between GitHub round trips
   * and immediately before each store write, so a cancelled refresh never publishes a partial
   * index. Raises the platform `AbortError`; the caller normalises it.
   */
  signal?: AbortSignal;
}

/** Whether the published index was rebuilt wholesale or advanced from a prior head. */
export type RepositoryIndexRefreshMode = "full" | "incremental";

interface IncrementalRefreshPlan {
  previous: RepositoryIndex;
  baseSha: string;
  /** Paths whose content must be re-read at the new head. */
  changedPaths: Set<string>;
  /** Paths the new head selects for indexing. */
  selectedPaths: Set<string>;
  embeddingProvider: LexicalHashEmbeddingProvider;
}

export interface RepositoryIndexRefreshResult {
  commitSha: string;
  indexedFileCount: number;
  partial: boolean;
  storageMode: RepositoryIndexStorageMode;
  mode: RepositoryIndexRefreshMode;
  coverage: RepositoryIndexCoverage;
  /** Records whose embedding was reused from the prior head instead of recomputed. */
  reusedRecordCount: number;
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
  private readonly limits: Required<RepositoryIndexServiceOptions>;

  constructor(
    private readonly store: Store,
    options: RepositoryIndexServiceOptions = {}
  ) {
    this.limits = {
      maxIndexedFiles: positiveLimit(
        options.maxIndexedFiles,
        DEFAULT_INDEX_LIMITS.maxIndexedFiles,
        "maxIndexedFiles"
      ),
      maxFileBytes: positiveLimit(
        options.maxFileBytes,
        DEFAULT_INDEX_LIMITS.maxFileBytes,
        "maxFileBytes"
      ),
      maxTotalBytes: positiveLimit(
        options.maxTotalBytes,
        DEFAULT_INDEX_LIMITS.maxTotalBytes,
        "maxTotalBytes"
      ),
      fetchConcurrency: positiveLimit(
        options.fetchConcurrency,
        DEFAULT_INDEX_LIMITS.fetchConcurrency,
        "fetchConcurrency"
      ),
      maxIncrementalFiles: positiveLimit(
        options.maxIncrementalFiles,
        DEFAULT_INDEX_LIMITS.maxIncrementalFiles,
        "maxIncrementalFiles"
      )
    };
  }

  async refreshDefaultBranchIndex(
    input: RepositoryIndexRefreshInput
  ): Promise<RepositoryIndexRefreshResult> {
    input.signal?.throwIfAborted();
    const [owner, repo] = splitFullName(input.fullName);
    const commitSha = await this.resolveBranchHead(
      input.github,
      owner,
      repo,
      input.defaultBranch
    );
    input.signal?.throwIfAborted();
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
      input.signal?.throwIfAborted();
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
        mode: "full",
        coverage: {
          candidateFileCount: existing.files.length,
          indexedFileCount: existing.files.length,
          truncationRatio: 0,
          fileCapReached: false
        },
        reusedRecordCount: existing.symbols.length + existing.history.length,
        skipped: zeroSkips()
      };
    }

    const tree = await this.readTree(input.github, owner, repo, commitSha);
    input.signal?.throwIfAborted();
    const supported = tree.blobs
      .flatMap((entry): IndexCandidate[] => {
        const priority = classifyIndexCandidate(entry.path);
        return priority === undefined ? [] : [{ ...entry, priority }];
      })
      .sort((left, right) =>
        left.priority !== right.priority
          ? left.priority - right.priority
          : left.path.localeCompare(right.path)
      );

    const selected = supported.slice(0, this.limits.maxIndexedFiles);
    const skipped = {
      unsupported: Math.max(tree.blobCount - supported.length, 0),
      tooMany: Math.max(supported.length - selected.length, 0),
      oversized: 0,
      binary: 0,
      missing: 0,
      fetchFailed: 0,
      byteBudget: 0
    };

    const delta = await this.planIncrementalRefresh(
      input,
      owner,
      repo,
      repositoryScope,
      commitSha,
      selected
    );
    const readTargets = delta
      ? selected.filter((candidate) => delta.changedPaths.has(candidate.path))
      : selected;
    const reads = await this.readIndexedFiles(
      input.github,
      owner,
      repo,
      commitSha,
      readTargets,
      input.signal
    );
    const files = new Map<string, string>();
    for (const read of reads) {
      if (read.status === "loaded") {
        files.set(read.path, read.content ?? "");
        continue;
      }
      skipped[skipKey(read.status)] += 1;
    }

    let index: RepositoryIndex;
    let mode: RepositoryIndexRefreshMode;
    let reusedRecordCount = 0;
    if (delta) {
      const built = await buildRepositoryIndexIncremental(
        {
          previous: delta.previous,
          changedFiles: Object.fromEntries(files),
          // Paths the previous head indexed that this head no longer selects,
          // whether deleted upstream or displaced by the file cap.
          removedPaths: delta.previous.files
            .map((file) => file.path)
            .filter(
              (path) =>
                !files.has(path) &&
                (delta.changedPaths.has(path) || !delta.selectedPaths.has(path))
            ),
          repository: input.fullName,
          repositoryId: input.repositoryId,
          repositoryScope,
          visibility: input.visibility,
          commitSha
        },
        { embeddingProvider: delta.embeddingProvider }
      );
      index = built.index;
      mode = "incremental";
      reusedRecordCount = built.reusedRecordCount;
    } else {
      index = await indexRepositorySyntaxAware({
        repository: input.fullName,
        repositoryId: input.repositoryId,
        repositoryScope,
        visibility: input.visibility,
        commitSha,
        files: Object.fromEntries(files)
      });
      mode = "full";
    }

    const vectors = toPersistedVectorRows(index);
    // Republishing one commit is the only case where prior rows can exist under
    // this storage key, so it is the only case with rows to delete. A new head
    // gets a new storage key and every record id is commit-scoped, so nothing is
    // ever silently carried across commits.
    const removedRecordIds = existing
      ? recordIdsRemovedFrom(existing, vectors)
      : [];
    // Last checkpoint before the index becomes visible. Everything above is pure computation over
    // already-fetched content, so aborting here costs only work-in-progress; aborting after would
    // leave a published index the drain budget never accounted for.
    input.signal?.throwIfAborted();
    if (existing && removedRecordIds.length) {
      await this.store.applyRepositoryIndexDelta(input.repositoryId, {
        index,
        upserts: vectors,
        deletedRecordIds: removedRecordIds
      });
    } else {
      await this.store.replaceRepositoryIndex(input.repositoryId, index, vectors);
    }
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
      mode,
      coverage: {
        candidateFileCount: supported.length,
        indexedFileCount: index.files.length,
        truncationRatio: truncationRatio(supported.length, index.files.length),
        fileCapReached: skipped.tooMany > 0
      },
      reusedRecordCount,
      skipped
    };
  }

  /**
   * Decides whether this refresh can be served incrementally, and from which
   * base. It returns undefined whenever a full rebuild is the safer choice, so
   * every failure mode here degrades to existing behaviour rather than to a
   * partially indexed repository.
   */
  private async planIncrementalRefresh(
    input: RepositoryIndexRefreshInput,
    owner: string,
    repo: string,
    repositoryScope: string,
    commitSha: string,
    selected: readonly IndexCandidate[]
  ): Promise<IncrementalRefreshPlan | undefined> {
    const repository = await this.store.getRepository(input.repositoryId);
    const baseSha = repository?.indexSha;
    if (!baseSha || baseSha === commitSha || !/^[a-f0-9]{7,40}$/.test(baseSha)) {
      return undefined;
    }
    const previous = await this.store.getRepositoryIndex(
      input.repositoryId,
      repositoryScope,
      baseSha
    );
    // Identity must be unchanged: a rename, a visibility change, or a different
    // embedding space all invalidate carried-forward records.
    if (
      !previous ||
      previous.repositoryScope !== repositoryScope ||
      previous.repository !== input.fullName ||
      previous.visibility !== input.visibility ||
      previous.embedding.kind !== "lexical-fallback"
    ) {
      return undefined;
    }
    const embeddingProvider = new LexicalHashEmbeddingProvider(
      previous.embedding.dimensions
    );
    if (embeddingProvider.id !== previous.embedding.providerId) {
      return undefined;
    }

    let compared: GitHubCompareResponse;
    try {
      compared = await input.github.request<GitHubCompareResponse>(
        "GET",
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(commitSha)}`
      );
    } catch {
      return undefined;
    }
    const files = compared.files;
    if (!Array.isArray(files)) return undefined;
    // `base...head` reports the diff from the merge base to head, not from base
    // to head, so only an "ahead" comparison names every path that differs
    // between the indexed base and this head. On "diverged" the dropped commits'
    // content is baked into `previous` while being absent from `files`, and
    // "behind" is not a forward advance at all; carrying rows forward in either
    // case would publish content the tree at head does not contain. "identical"
    // cannot be a no-op either: this refresh only reaches here with a base that
    // differs from the head, and storage keys are commit-scoped, so the new head
    // still needs an index published under its own key for callers to read.
    if (compared.status !== "ahead") return undefined;
    // A file list at the page cap may be missing changed paths entirely, and an
    // omitted path is indistinguishable from an unchanged one, so it would be
    // carried forward stale rather than re-read.
    if (files.length >= COMPARE_FILE_PAGE_LIMIT) return undefined;
    const changedPaths = new Set<string>();
    for (const file of files) {
      // A rename changes two paths: the new one is re-read, and the old one is
      // dropped because it is absent from the new head's selected set.
      for (const name of [file.filename, file.previous_filename]) {
        if (typeof name === "string" && name) changedPaths.add(name);
      }
    }
    const selectedPaths = new Set(selected.map((candidate) => candidate.path));
    // Any newly selected path absent from the previous index must be read even if
    // the compare did not name it, which is what happens when the file cap admits
    // a file that was previously displaced.
    const previousPaths = new Set(previous.files.map((file) => file.path));
    for (const path of selectedPaths) {
      if (!previousPaths.has(path)) changedPaths.add(path);
    }
    const readCount = [...changedPaths].filter((path) => selectedPaths.has(path)).length;
    if (readCount > this.limits.maxIncrementalFiles) return undefined;
    return { previous, baseSha, changedPaths, selectedPaths, embeddingProvider };
  }

  /**
   * Reads the recursive git tree, keeping each blob's SHA and size so files can
   * be fetched by immutable blob id instead of by path and ref.
   */
  private async readTree(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    commitSha: string
  ): Promise<{ blobs: RepositoryTreeBlob[]; blobCount: number }> {
    let response: GitHubTreeResponse | undefined;
    try {
      response = await github.request<GitHubTreeResponse>(
        "GET",
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`
      );
    } catch (error) {
      if (String(error).includes("truncated")) throw error;
      response = undefined;
    }
    if (response?.truncated) {
      throw new Error("Repository tree is truncated; indexing requires a scoped tree walker");
    }
    const blobs = (response?.tree ?? []).filter(
      (entry): entry is GitHubTreeEntry & { path: string } =>
        entry.type === "blob" && typeof entry.path === "string" && entry.path.length > 0
    );
    if (blobs.length) {
      return {
        blobs: blobs.map((entry) => ({
          path: entry.path,
          sha: typeof entry.sha === "string" && entry.sha ? entry.sha : undefined,
          size: Number.isSafeInteger(entry.size) ? entry.size : undefined
        })),
        blobCount: blobs.length
      };
    }
    // A client that exposes only a path listing still works: without blob SHAs
    // each file is read through GET /contents instead.
    const paths = await github.getTree(owner, repo, commitSha);
    return {
      blobs: paths.map((path) => ({ path })),
      blobCount: paths.length
    };
  }

  async loadExactRepositoryIndex(
    repositoryId: number,
    commitSha: string
  ): Promise<RepositoryIndex | undefined> {
    return this.store.getRepositoryIndex(repositoryId, `github:${repositoryId}`, commitSha);
  }

  /**
   * Binds durable vector reads to one repository so retrieval can consume them.
   *
   * This adapter exists because the two sides cannot meet directly:
   * `Store.queryRepositoryIndexVectors(repositoryId, request)` leads with a numeric
   * repository id, and `RepositoryVectorRanker.query(request)` has no slot for one.
   * Closing over the id here is what makes the durable retrieval path reachable
   * from production at all rather than only from tests.
   *
   * Isolation is unchanged, not re-implemented: both store methods derive the
   * canonical storage key from the request themselves, so the scope-and-commit
   * predicate pair remains the boundary. Two checks are layered on top. The
   * outgoing request must name the scope this ranker was bound to, and every
   * returned row must carry it. Retrieval separately re-checks rows against the
   * loaded index document, but that check is blind to a document that is itself for
   * the wrong repository; this one is not, because it compares against the numeric
   * id the caller asked about rather than against the document.
   */
  repositoryVectorRanker(repositoryId: number): RepositoryVectorRanker {
    const repositoryScope = `github:${repositoryId}`;
    const assertRowScope = (row: { repositoryScope: string }, what: string): void => {
      if (row.repositoryScope !== repositoryScope) {
        throw new RepositoryIsolationError(
          `${what} returned a row outside the bound repository`
        );
      }
    };
    const assertRequestScope = (requested: string, what: string): void => {
      if (requested !== repositoryScope) {
        throw new RepositoryIsolationError(
          `${what} was asked for a repository other than the bound one`
        );
      }
    };
    return {
      query: async (request: RepositoryVectorQuery): Promise<RepositoryVectorMatch[]> => {
        assertRequestScope(request.repositoryScope, "durable vector ranking");
        const matches = await this.store.queryRepositoryIndexVectors(repositoryId, request);
        for (const match of matches) {
          assertRowScope(match.row, "durable vector ranking");
        }
        return matches;
      },
      hydrateRecords: async (
        request: RepositoryRecordHydrationRequest
      ): Promise<PersistedRecordRow[]> => {
        assertRequestScope(request.repositoryScope, "durable record hydration");
        const rows = await this.store.hydrateRepositoryIndexRecords(repositoryId, request);
        for (const row of rows) {
          assertRowScope(row, "durable record hydration");
        }
        return rows;
      }
    };
  }

  /**
   * The provider that can re-embed a review query into the same space a stored
   * index was built in, or nothing when it cannot be reconstructed.
   *
   * Retrieval only consults a ranker when it holds a query vector in the index's
   * own space, so without this the wired ranker would be dormant. The lexical
   * provider is a pure function of its dimension count, so it reconstructs exactly;
   * the id is compared rather than assumed, because a provider whose id differs is
   * by definition a different embedding space and comparing across the two would
   * return confident nonsense instead of an error.
   */
  retrievalEmbeddingProvider(
    index: RepositoryIndex
  ): LexicalHashEmbeddingProvider | undefined {
    const dimensions = index.embedding.dimensions;
    if (
      index.embedding.kind !== "lexical-fallback" ||
      !Number.isSafeInteger(dimensions) ||
      dimensions < 8 ||
      dimensions > 4_096
    ) {
      return undefined;
    }
    const provider = new LexicalHashEmbeddingProvider(dimensions);
    return provider.id === index.embedding.providerId ? provider : undefined;
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
    candidates: readonly IndexCandidate[],
    signal?: AbortSignal
  ): Promise<RepositoryFileRead[]> {
    const results = new Array<RepositoryFileRead>(candidates.length);
    let nextIndex = 0;
    const workerCount = Math.min(
      this.limits.fetchConcurrency,
      Math.max(candidates.length, 1)
    );
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          // This is the bulk of a rebuild's wall time: one fetch per indexed file. Checking per
          // iteration lets every worker stop at a file boundary, so shutdown ends the read phase
          // in one round trip rather than after the whole candidate list.
          signal?.throwIfAborted();
          const current = nextIndex;
          nextIndex += 1;
          if (current >= candidates.length) return;
          results[current] = await this.readIndexedFile(
            github,
            owner,
            repo,
            candidates[current]!,
            ref
          );
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
      if (usedBytes + byteLength > this.limits.maxTotalBytes) {
        return { path: read.path, status: "byte-budget" };
      }
      usedBytes += byteLength;
      return read;
    });
  }

  /**
   * Reads one file, preferring the git blob API. A blob is addressed by its
   * content SHA from the tree listing, so it is immutable, needs no ref
   * resolution, and cannot race a concurrent push the way a path-plus-ref read
   * can. `GET /contents` remains the fallback for a candidate the tree did not
   * give a SHA for.
   */
  private async readIndexedFile(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    candidate: IndexCandidate,
    ref: string
  ): Promise<RepositoryFileRead> {
    const path = candidate.path;
    if (
      Number.isSafeInteger(candidate.size) &&
      Number(candidate.size) > this.limits.maxFileBytes
    ) {
      // The tree already reported the blob size, so an oversized file costs no fetch.
      return { path, status: "oversized" };
    }
    try {
      const read = candidate.sha
        ? await this.readBlob(github, owner, repo, candidate.sha)
        : await this.readContents(github, owner, repo, path, ref);
      if (read === "missing") return { path, status: "missing" };
      if (read === "oversized" || read.length > this.limits.maxFileBytes) {
        return { path, status: "oversized" };
      }
      if (looksBinary(read)) {
        return { path, status: "binary" };
      }
      return {
        path,
        status: "loaded",
        content: read.toString("utf8"),
        byteLength: read.length
      };
    } catch (error) {
      if (String(error).includes("returned 404")) {
        return { path, status: "missing" };
      }
      return { path, status: "fetch-failed" };
    }
  }

  private async readBlob(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    sha: string
  ): Promise<Buffer | "missing" | "oversized"> {
    const response = await github.request<GitHubBlobResponse>(
      "GET",
      `/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`
    );
    if (
      Number.isSafeInteger(response.size) &&
      Number(response.size) > this.limits.maxFileBytes
    ) {
      return "oversized";
    }
    return decodeContent(response);
  }

  private async readContents(
    github: RepositoryIndexGitHubClient,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<Buffer | "missing" | "oversized"> {
    const response = await github.request<GitHubContentsResponse>(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
    );
    if (response.type !== "file") return "missing";
    if (
      Number.isSafeInteger(response.size) &&
      Number(response.size) > this.limits.maxFileBytes
    ) {
      return "oversized";
    }
    return decodeContent(response);
  }
}

/**
 * Fraction of indexable candidates that did not reach the published index. It is
 * the number monitoring needs to tell "one unreadable file" apart from "indexed a
 * tenth of the repository".
 */
function truncationRatio(candidateFileCount: number, indexedFileCount: number): number {
  if (candidateFileCount <= 0) return 0;
  const dropped = Math.max(candidateFileCount - indexedFileCount, 0);
  return dropped / candidateFileCount;
}

/**
 * Record ids present under a storage key before this publication but absent from
 * it. Only republishing the same commit can produce any, because a new head
 * yields a new storage key.
 */
function recordIdsRemovedFrom(
  previous: RepositoryIndex,
  vectors: readonly PersistedVectorRow[]
): string[] {
  if (previous.storageKey !== vectors[0]?.storageKey) return [];
  const retained = new Set(vectors.map((row) => row.recordId));
  return [
    ...previous.symbols.map((symbol) => symbol.id),
    ...previous.history.map((entry) => entry.id)
  ]
    .filter((recordId) => !retained.has(recordId))
    .sort();
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
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
  if (/^\.guardianbot\/baseline\.json$/i.test(path)) return 1;
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
