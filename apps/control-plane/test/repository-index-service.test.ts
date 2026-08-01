import assert from "node:assert/strict";
import test from "node:test";
import {
  RepositoryIsolationError,
  lexicalFeatureVector,
  type RepositoryIndex
} from "@guardianbot/core";
import { RepositoryIndexService } from "../src/repository-index-service.js";
import { MemoryStore, type RepositoryRecord } from "../src/store.js";

const defaultRepository: RepositoryRecord = {
  installationId: 1,
  repositoryId: 42,
  fullName: "Acme/Widget",
  visibility: "private",
  defaultBranch: "main",
  scannerState: "not-configured",
  repositoryState: "active",
  automaticReviewPaused: false
};

class FakeGitHub {
  treeRefs: string[] = [];
  requestPaths: string[] = [];

  constructor(
    private refSha: string,
    private readonly tree: string[],
    private readonly contents: Record<string, { size?: number; content: Buffer } | "missing" | "error">,
    private readonly delays: Record<string, number> = {}
  ) {}

  setRefSha(refSha: string): void {
    this.refSha = refSha;
  }

  async getTree(_owner: string, _repo: string, ref: string): Promise<string[]> {
    this.treeRefs.push(ref);
    return this.tree;
  }

  async request<T>(method: string, path: string): Promise<T> {
    this.requestPaths.push(`${method} ${path}`);
    if (method === "GET" && /\/git\/ref\/heads\//.test(path)) {
      return { object: { sha: this.refSha } } as T;
    }
    if (method === "GET" && path.includes("/contents/")) {
      const encodedPath = path.split("/contents/")[1]?.split("?")[0];
      const repositoryPath = decodeURIComponent(encodedPath ?? "");
      const delay = this.delays[repositoryPath] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const entry = this.contents[repositoryPath];
      if (!entry || entry === "missing") {
        throw new Error(`GitHub GET ${path} returned 404: missing`);
      }
      if (entry === "error") {
        throw new Error(`GitHub GET ${path} returned 500: boom`);
      }
      return {
        type: "file",
        encoding: "base64",
        size: entry.size ?? entry.content.length,
        sha: `${repositoryPath}-sha`,
        content: entry.content.toString("base64")
      } as T;
    }
    throw new Error(`Unhandled ${method} ${path}`);
  }
}

class FailingReplaceStore extends MemoryStore {
  constructor(private readonly failedCommitSha: string) {
    super();
  }

  override async replaceRepositoryIndex(...args: Parameters<MemoryStore["replaceRepositoryIndex"]>) {
    const [, index] = args;
    if (index.commitSha === this.failedCommitSha) {
      throw new Error("simulated persistence failure");
    }
    return super.replaceRepositoryIndex(...args);
  }
}

test("refresh resolves the default branch to an immutable commit and persists the exact index", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const github = new FakeGitHub("a".repeat(40), [
    "src/auth.ts",
    ".guardianbot/config.yml",
    ".guardianbot/baseline.json"
  ], {
    "src/auth.ts": {
      content: Buffer.from("export function authorize(user) { return user.role === 'admin'; }\n")
    },
    ".guardianbot/config.yml": {
      content: Buffer.from("review:\n  incremental: true\n")
    },
    ".guardianbot/baseline.json": {
      content: Buffer.from('{"schemaVersion":"1.0.0","fingerprints":[]}\n')
    }
  });

  const service = new RepositoryIndexService(store);
  const result = await service.refreshDefaultBranchIndex({
    github,
    repositoryId: defaultRepository.repositoryId,
    installationId: defaultRepository.installationId,
    fullName: defaultRepository.fullName,
    defaultBranch: defaultRepository.defaultBranch,
    visibility: "private"
  });

  assert.equal(result.commitSha, "a".repeat(40));
  assert.equal(result.partial, false);
  assert.deepEqual(github.treeRefs, ["a".repeat(40)]);
  const repository = await store.getRepository(defaultRepository.repositoryId);
  assert.equal(repository?.indexSha, "a".repeat(40));
  const index = await store.getRepositoryIndex(
    defaultRepository.repositoryId,
    "github:42",
    "a".repeat(40)
  );
  assert.ok(index);
  assert.equal(index?.repositoryScope, "github:42");
  assert.ok(index?.files.some((file) => file.path === "src/auth.ts"));
  assert.ok(index?.files.some((file) => file.path === ".guardianbot/baseline.json"));
});

test("refresh is repository-isolated and idempotent for an already persisted commit", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  await store.upsertRepository({
    ...defaultRepository,
    repositoryId: 43,
    fullName: "Acme/Other"
  });
  const github = new FakeGitHub("b".repeat(40), ["src/a.ts"], {
    "src/a.ts": { content: Buffer.from("export function a() { return 1; }\n") }
  });
  const service = new RepositoryIndexService(store);

  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });
  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 43,
    installationId: 1,
    fullName: "Acme/Other",
    defaultBranch: "main",
    visibility: "private"
  });
  const treeCallsAfterFirstPass = github.treeRefs.length;

  const second = await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });

  assert.equal(second.commitSha, "b".repeat(40));
  assert.equal(github.treeRefs.length, treeCallsAfterFirstPass);
  const firstIndex = await store.getRepositoryIndex(42, "github:42", "b".repeat(40));
  const secondIndex = await store.getRepositoryIndex(43, "github:43", "b".repeat(40));
  assert.equal(firstIndex?.repository, "Acme/Widget");
  assert.equal(secondIndex?.repository, "Acme/Other");
});

test("cached indexes are reused only when repository identity and visibility still match", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const github = new FakeGitHub("9".repeat(40), ["src/a.ts"], {
    "src/a.ts": { content: Buffer.from("export function a() { return 1; }\n") }
  });
  const service = new RepositoryIndexService(store);

  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });
  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Renamed",
    defaultBranch: "main",
    visibility: "private"
  });
  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Renamed",
    defaultBranch: "main",
    visibility: "public"
  });
  const requestsAfterRebuilds = github.treeRefs.length;
  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Renamed",
    defaultBranch: "main",
    visibility: "public"
  });

  assert.equal(requestsAfterRebuilds, 3);
  assert.equal(github.treeRefs.length, requestsAfterRebuilds);
  const index = await store.getRepositoryIndex(42, "github:42", "9".repeat(40));
  assert.equal(index?.repository, "Acme/Renamed");
  assert.equal(index?.visibility, "public");
});

test("indexes extended source, nested container, and documentation candidates without treating unrelated files as partial", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const paths = [
    "README.md",
    "docs/guide.rst",
    "typings/model.pyi",
    "scripts/entry.mjs",
    "scripts/legacy.cjs",
    "src/module.mts",
    "src/common.cts",
    "tasks/build.rake",
    "pkg/widget.gemspec",
    "Gemfile",
    "Rakefile",
    "ops/api/Dockerfile.runtime",
    "assets/logo.png"
  ];
  const contents = Object.fromEntries(
    paths
      .filter((path) => path !== "assets/logo.png")
      .map((path) => [
        path,
        { content: Buffer.from(`# indexed ${path}\nexport const value = true;\n`) }
      ])
  );
  const github = new FakeGitHub("8".repeat(40), paths, contents);

  const result = await new RepositoryIndexService(store).refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });

  assert.equal(result.partial, false);
  assert.equal(result.skipped.unsupported, 1);
  assert.equal(result.indexedFileCount, 12);
  const index = await store.getRepositoryIndex(42, "github:42", "8".repeat(40));
  assert.ok(index?.files.some((file) => file.path === "README.md"));
  assert.ok(index?.files.some((file) => file.path === "ops/api/Dockerfile.runtime"));
  assert.ok(index?.symbols.some((symbol) => symbol.path === "docs/guide.rst"));
});

test("refresh skips oversized, binary, and over-limit files without mixing successful content", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const normalFiles = Object.fromEntries(
    Array.from({ length: 254 }, (_, index) => [
      `src/file-${String(index).padStart(3, "0")}.ts`,
      { content: Buffer.from(`export const value${index} = ${index};\n`) }
    ])
  );
  const github = new FakeGitHub(
    "c".repeat(40),
    [
      "src/000-binary.ts",
      "src/001-huge.ts",
      ...Object.keys(normalFiles),
      "src/zzz-omitted-1.ts",
      "src/zzz-omitted-2.ts"
    ],
    {
      "src/000-binary.ts": { content: Buffer.from([0, 1, 2, 3]) },
      "src/001-huge.ts": {
        size: 300_000,
        content: Buffer.from("x".repeat(300_000))
      },
      ...normalFiles,
      "src/zzz-omitted-1.ts": { content: Buffer.from("export const omitted1 = true;\n") },
      "src/zzz-omitted-2.ts": { content: Buffer.from("export const omitted2 = true;\n") }
    }
  );

  const service = new RepositoryIndexService(store);
  const result = await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });

  assert.equal(result.partial, true);
  assert.equal(result.skipped.binary, 1);
  assert.equal(result.skipped.oversized, 1);
  assert.equal(result.skipped.tooMany, 2);
  assert.equal(result.indexedFileCount, 254);
  const index = await store.getRepositoryIndex(42, "github:42", "c".repeat(40));
  assert.ok(index);
  assert.equal(index?.files.length, 254);
  assert.ok(index?.files.every((file) => file.path.startsWith("src/file-")));
});

test("concurrent reads reserve the aggregate byte budget deterministically", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const paths = Array.from(
    { length: 20 },
    (_, index) => `docs/${String(index).padStart(2, "0")}.md`
  );
  const contents = Object.fromEntries(
    paths.map((path, index) => [
      path,
      {
        content: Buffer.from(
          `${path}\n${String(index).padStart(2, "0")}${"x".repeat(240 * 1024 - path.length - 4)}`
        )
      }
    ])
  );
  const delays = Object.fromEntries(
    paths.map((path, index) => [path, paths.length - index])
  );
  const github = new FakeGitHub("7".repeat(40), paths, contents, delays);

  const result = await new RepositoryIndexService(store).refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });

  assert.equal(result.partial, true);
  assert.equal(result.skipped.byteBudget, 3);
  assert.equal(result.indexedFileCount, 17);
  const index = await store.getRepositoryIndex(42, "github:42", "7".repeat(40));
  assert.deepEqual(
    index?.files.map((file) => file.path),
    paths.slice(0, 17)
  );
});

test("refresh rejects malformed branch resolution before indexing", async () => {
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const github = new FakeGitHub("not-a-commit", ["src/auth.ts"], {
    "src/auth.ts": { content: Buffer.from("export const ok = true;\n") }
  });

  await assert.rejects(
    new RepositoryIndexService(store).refreshDefaultBranchIndex({
      github,
      repositoryId: 42,
      installationId: 1,
      fullName: "Acme/Widget",
      defaultBranch: "main",
      visibility: "private"
    }),
    /immutable commit SHA/
  );
  assert.deepEqual(github.treeRefs, []);
});

test("failed persistence leaves the prior repository index and repository pointer intact", async () => {
  const firstSha = "d".repeat(40);
  const secondSha = "e".repeat(40);
  const store = new FailingReplaceStore(secondSha);
  await store.upsertRepository(defaultRepository);
  const github = new FakeGitHub(firstSha, ["src/auth.ts"], {
    "src/auth.ts": { content: Buffer.from("export const allow = true;\n") }
  });
  const service = new RepositoryIndexService(store);

  await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });
  github.setRefSha(secondSha);

  await assert.rejects(
    service.refreshDefaultBranchIndex({
      github,
      repositoryId: 42,
      installationId: 1,
      fullName: "Acme/Widget",
      defaultBranch: "main",
      visibility: "private"
    }),
    /simulated persistence failure/
  );

  const repository = await store.getRepository(42);
  assert.equal(repository?.indexSha, firstSha);
  assert.ok(await store.getRepositoryIndex(42, "github:42", firstSha));
  assert.equal(await store.getRepositoryIndex(42, "github:42", secondSha), undefined);
});

/** One stubbed `base...head` comparison, including the status the API reports. */
interface CompareStub {
  files: { filename: string; previous_filename?: string }[];
  /** Defaults to the forward-advance case that permits an incremental refresh. */
  status?: string;
}

/** GitHub fake that serves a real recursive tree with blob SHAs, plus compare. */
class FakeTreeGitHub {
  blobReads: string[] = [];
  contentReads: string[] = [];
  comparePaths: string[] = [];
  treeReads: string[] = [];

  constructor(
    private refSha: string,
    private trees: Record<string, Record<string, string>>,
    private compares: Record<string, CompareStub> = {}
  ) {}

  setRefSha(refSha: string): void {
    this.refSha = refSha;
  }

  async getTree(): Promise<string[]> {
    throw new Error("path-only tree listing must not be used when the tree API is available");
  }

  async request<T>(method: string, path: string): Promise<T> {
    if (/\/git\/ref\/heads\//.test(path)) {
      return { object: { sha: this.refSha } } as T;
    }
    const treeMatch = path.match(/\/git\/trees\/([^?]+)/);
    if (treeMatch) {
      const ref = decodeURIComponent(treeMatch[1]!);
      this.treeReads.push(ref);
      const files = this.trees[ref];
      if (!files) throw new Error(`GitHub GET ${path} returned 404: no tree`);
      return {
        truncated: false,
        tree: Object.entries(files).map(([filePath, content]) => ({
          path: filePath,
          type: "blob",
          sha: blobSha(ref, filePath),
          size: Buffer.byteLength(content, "utf8")
        }))
      } as T;
    }
    const blobMatch = path.match(/\/git\/blobs\/([^?]+)/);
    if (blobMatch) {
      const sha = decodeURIComponent(blobMatch[1]!);
      this.blobReads.push(sha);
      for (const [ref, files] of Object.entries(this.trees)) {
        for (const [filePath, content] of Object.entries(files)) {
          if (blobSha(ref, filePath) === sha) {
            return {
              encoding: "base64",
              size: Buffer.byteLength(content, "utf8"),
              content: Buffer.from(content, "utf8").toString("base64")
            } as T;
          }
        }
      }
      throw new Error(`GitHub GET ${path} returned 404: no blob`);
    }
    const compareMatch = path.match(/\/compare\/([^.]+)\.\.\.(.+)$/);
    if (compareMatch) {
      const key = `${decodeURIComponent(compareMatch[1]!)}...${decodeURIComponent(compareMatch[2]!)}`;
      this.comparePaths.push(key);
      const stub = this.compares[key];
      if (!stub) throw new Error(`GitHub GET ${path} returned 404: no comparison`);
      return {
        files: stub.files,
        status: stub.status ?? "ahead",
        total_commits: stub.files.length
      } as T;
    }
    if (path.includes("/contents/")) {
      this.contentReads.push(path);
      throw new Error(`GitHub GET ${path} returned 404: contents read not expected`);
    }
    throw new Error(`Unhandled ${method} ${path}`);
  }
}

function blobSha(ref: string, path: string): string {
  return `blob-${ref.slice(0, 4)}-${path.replace(/[^a-z0-9]/gi, "-")}`;
}

test("incremental refresh re-reads only changed paths and carries the rest forward", async () => {
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  const baseFiles = {
    "src/keep.ts": "export function keep() { return 1; }\n",
    "src/change.ts": "export function change() { return 2; }\n",
    "src/drop.ts": "export function drop() { return 3; }\n"
  };
  const headFiles = {
    "src/keep.ts": baseFiles["src/keep.ts"],
    "src/change.ts": "export function change() { return 22; }\n"
  };
  const github = new FakeTreeGitHub(
    baseSha,
    { [baseSha]: baseFiles, [headSha]: headFiles },
    {
      [`${baseSha}...${headSha}`]: {
        files: [{ filename: "src/change.ts" }, { filename: "src/drop.ts" }]
      }
    }
  );
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const service = new RepositoryIndexService(store);
  const input = {
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private" as const
  };

  const first = await service.refreshDefaultBranchIndex(input);
  assert.equal(first.mode, "full");
  assert.equal(github.blobReads.length, 3);
  // Files are fetched by immutable blob id, never through GET /contents.
  assert.deepEqual(github.contentReads, []);

  github.setRefSha(headSha);
  github.blobReads.length = 0;
  const second = await service.refreshDefaultBranchIndex(input);

  assert.equal(second.mode, "incremental");
  assert.deepEqual(github.comparePaths, [`${baseSha}...${headSha}`]);
  // Only the changed file is re-read; the unchanged one is carried forward.
  assert.deepEqual(github.blobReads, [blobSha(headSha, "src/change.ts")]);
  // The unchanged symbol's embedding is reused rather than recomputed.
  assert.ok(second.reusedRecordCount > 0);

  const index = await store.getRepositoryIndex(42, "github:42", headSha);
  assert.deepEqual(
    index?.files.map((file) => file.path),
    ["src/change.ts", "src/keep.ts"]
  );
  // The removed path leaves no symbol behind.
  assert.ok(!index?.symbols.some((symbol) => symbol.path === "src/drop.ts"));
  assert.ok(index?.symbols.some((symbol) => symbol.content.includes("return 22")));
  assert.ok(index?.symbols.every((symbol) => symbol.commitSha === headSha));
  const repository = await store.getRepository(42);
  assert.equal(repository?.indexSha, headSha);

  // The incremental result must equal a full rebuild of the same head.
  const rebuiltStore = new MemoryStore();
  await rebuiltStore.upsertRepository(defaultRepository);
  const rebuiltGithub = new FakeTreeGitHub(headSha, { [headSha]: headFiles });
  await new RepositoryIndexService(rebuiltStore).refreshDefaultBranchIndex({
    ...input,
    github: rebuiltGithub
  });
  const rebuilt = await rebuiltStore.getRepositoryIndex(42, "github:42", headSha);
  assert.equal(index?.contentSha256, rebuilt?.contentSha256);
});

test("refresh falls back to a full rebuild when the comparison is unavailable", async () => {
  const baseSha = "3".repeat(40);
  const headSha = "4".repeat(40);
  const files = { "src/a.ts": "export function a() { return 1; }\n" };
  // No compare entry is registered, so the comparison request fails.
  const github = new FakeTreeGitHub(baseSha, {
    [baseSha]: files,
    [headSha]: { "src/a.ts": "export function a() { return 2; }\n" }
  });
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const service = new RepositoryIndexService(store);
  const input = {
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private" as const
  };

  await service.refreshDefaultBranchIndex(input);
  github.setRefSha(headSha);
  const second = await service.refreshDefaultBranchIndex(input);

  // A missing delta degrades to existing behaviour rather than under-indexing.
  assert.equal(second.mode, "full");
  const index = await store.getRepositoryIndex(42, "github:42", headSha);
  assert.ok(index?.symbols.some((symbol) => symbol.content.includes("return 2")));
});

test("a compare response at the file page cap rebuilds fully instead of carrying stale content forward", async () => {
  const baseSha = "a1".repeat(20);
  const headSha = "a2".repeat(20);
  const github = new FakeTreeGitHub(
    baseSha,
    {
      [baseSha]: {
        "src/stale.ts": "export function stale() { return 1; }\n",
        "src/keep.ts": "export function keep() { return 0; }\n"
      },
      [headSha]: {
        "src/stale.ts": "export function stale() { return 999; }\n",
        "src/keep.ts": "export function keep() { return 0; }\n"
      }
    },
    {
      // The comparison is truncated at GitHub's 300-entry page cap, so the one
      // path that actually changed is absent from it. None of the 300 reported
      // entries is an indexing candidate, so the incremental file cap does not
      // reject this plan either: only the page-cap guard can.
      [`${baseSha}...${headSha}`]: {
        files: Array.from({ length: 300 }, (_, index) => ({
          filename: `assets/blob-${String(index).padStart(3, "0")}.bin`
        }))
      }
    }
  );
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  const service = new RepositoryIndexService(store);
  const input = {
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private" as const
  };

  await service.refreshDefaultBranchIndex(input);
  github.setRefSha(headSha);
  const second = await service.refreshDefaultBranchIndex(input);

  // The comparison was consulted, then rejected for being possibly truncated.
  assert.deepEqual(github.comparePaths, [`${baseSha}...${headSha}`]);
  assert.equal(second.mode, "full");
  const index = await store.getRepositoryIndex(42, "github:42", headSha);
  // The changed path the comparison omitted must be published at its head
  // content, never carried forward from the previous head.
  assert.ok(index?.symbols.some((symbol) => symbol.content.includes("return 999")));
  assert.equal(
    index?.symbols.some((symbol) => symbol.content.includes("return 1;")),
    false
  );
});

test("a comparison that is not a forward advance rebuilds fully instead of publishing rewritten-away content", async () => {
  for (const status of ["diverged", "behind", "identical"]) {
    const baseSha = "b1".repeat(20);
    const headSha = "b2".repeat(20);
    const github = new FakeTreeGitHub(
      baseSha,
      {
        [baseSha]: {
          "src/rewritten.ts": "export function rewritten() { return 1; }\n",
          "src/keep.ts": "export function keep() { return 0; }\n"
        },
        [headSha]: {
          "src/rewritten.ts": "export function rewritten() { return 777; }\n",
          "src/keep.ts": "export function keep() { return 0; }\n"
        }
      },
      {
        // The three-dot comparison reports the diff from the merge base, so a
        // path whose base content came from a dropped commit is missing from it
        // even though the tree at head disagrees with the previous index.
        [`${baseSha}...${headSha}`]: { files: [], status }
      }
    );
    const store = new MemoryStore();
    await store.upsertRepository(defaultRepository);
    const service = new RepositoryIndexService(store);
    const input = {
      github,
      repositoryId: 42,
      installationId: 1,
      fullName: "Acme/Widget",
      defaultBranch: "main",
      visibility: "private" as const
    };

    await service.refreshDefaultBranchIndex(input);
    github.setRefSha(headSha);
    const second = await service.refreshDefaultBranchIndex(input);

    assert.deepEqual(github.comparePaths, [`${baseSha}...${headSha}`], status);
    assert.equal(second.mode, "full", status);
    const index = await store.getRepositoryIndex(42, "github:42", headSha);
    // A published index exists under the new head's storage key, and it agrees
    // with the tree at head rather than with the rewritten-away base content.
    assert.ok(
      index?.symbols.some((symbol) => symbol.content.includes("return 777")),
      status
    );
    assert.equal(
      index?.symbols.some((symbol) => symbol.content.includes("return 1;")),
      false,
      status
    );
  }
});

test("indexing caps are constructor policy and surface a truncation ratio", async () => {
  const commitSha = "5".repeat(40);
  const files = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `src/file-${String(index).padStart(2, "0")}.ts`,
      `export const value${index} = ${index};\n`
    ])
  );
  const github = new FakeTreeGitHub(commitSha, { [commitSha]: files });
  const store = new MemoryStore();
  await store.upsertRepository(defaultRepository);
  // The cap is policy, so it is set per service instance rather than being fixed.
  const service = new RepositoryIndexService(store, { maxIndexedFiles: 4 });

  const result = await service.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });

  assert.equal(result.indexedFileCount, 4);
  assert.equal(result.skipped.tooMany, 6);
  assert.equal(result.partial, true);
  // Under-indexing is visible as a ratio, not just as a boolean.
  assert.equal(result.coverage.candidateFileCount, 10);
  assert.equal(result.coverage.indexedFileCount, 4);
  assert.equal(result.coverage.truncationRatio, 0.6);
  assert.equal(result.coverage.fileCapReached, true);

  const uncapped = new RepositoryIndexService(store);
  const full = await uncapped.refreshDefaultBranchIndex({
    github,
    repositoryId: 42,
    installationId: 1,
    fullName: "Acme/Widget",
    defaultBranch: "main",
    visibility: "private"
  });
  assert.equal(full.coverage.truncationRatio, 0);
  assert.equal(full.coverage.fileCapReached, false);
});

test("rejects a non-positive indexing cap rather than silently indexing nothing", () => {
  assert.throws(
    () => new RepositoryIndexService(new MemoryStore(), { maxIndexedFiles: 0 }),
    /maxIndexedFiles must be a positive integer/
  );
});

/** A store that answers a correctly-scoped read with another repository's rows. */
class ForeignRowStore extends MemoryStore {
  constructor(private readonly foreignScope: string) {
    super();
  }

  override async queryRepositoryIndexVectors(
    ...args: Parameters<MemoryStore["queryRepositoryIndexVectors"]>
  ) {
    const matches = await super.queryRepositoryIndexVectors(...args);
    return matches.map((match) => ({
      ...match,
      row: { ...match.row, repositoryScope: this.foreignScope }
    }));
  }

  override async hydrateRepositoryIndexRecords(
    ...args: Parameters<MemoryStore["hydrateRepositoryIndexRecords"]>
  ) {
    const rows = await super.hydrateRepositoryIndexRecords(...args);
    return rows.map((row) => ({ ...row, repositoryScope: this.foreignScope }));
  }

  override async getRepositoryIndexDescriptor(
    ...args: Parameters<MemoryStore["getRepositoryIndexDescriptor"]>
  ) {
    const descriptor = await super.getRepositoryIndexDescriptor(...args);
    return descriptor ? { ...descriptor, repositoryScope: this.foreignScope } : undefined;
  }
}

async function publishIndex(
  store: MemoryStore,
  repositoryId = defaultRepository.repositoryId
): Promise<RepositoryIndex> {
  await store.upsertRepository({ ...defaultRepository, repositoryId });
  const github = new FakeGitHub("d".repeat(40), ["src/auth.ts"], {
    "src/auth.ts": {
      content: Buffer.from("export function authorize(user) { return user.role === 'admin'; }\n")
    }
  });
  const service = new RepositoryIndexService(store);
  await service.refreshDefaultBranchIndex({
    github,
    repositoryId,
    installationId: defaultRepository.installationId,
    fullName: defaultRepository.fullName,
    defaultBranch: defaultRepository.defaultBranch,
    visibility: "private"
  });
  const index = await store.getRepositoryIndex(
    repositoryId,
    `github:${repositoryId}`,
    "d".repeat(40)
  );
  assert.ok(index);
  return index;
}

test("the durable ranker adapter binds one repository and re-checks what the store returned", async () => {
  const store = new MemoryStore();
  const index = await publishIndex(store);
  const service = new RepositoryIndexService(store);
  const ranker = service.repositoryVectorRanker(defaultRepository.repositoryId);
  const vector = lexicalFeatureVector("authorize admin", index.embedding.dimensions);

  // The adapter closes over the numeric repository id, which is the whole reason it
  // exists: Store.queryRepositoryIndexVectors leads with that id and
  // RepositoryVectorRanker.query has nowhere to put it.
  const matches = await ranker.query({
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    providerId: index.embedding.providerId,
    vector,
    limit: 50
  });
  assert.ok(matches.length > 0);
  assert.ok(matches.every((match) => match.row.repositoryScope === index.repositoryScope));
  assert.ok(matches.every((match) => match.row.commitSha === index.commitSha));

  const hydrated = await ranker.hydrateRecords!({
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    records: matches.map((match) => ({
      recordType: match.row.recordType,
      recordId: match.row.recordId
    }))
  });
  assert.ok(hydrated.length > 0);
  assert.ok(hydrated.every((row) => row.repositoryScope === index.repositoryScope));

  // A request naming a repository this ranker was not bound to is refused rather
  // than forwarded, so a bound id and a requested scope can never disagree.
  const otherScope = `github:${defaultRepository.repositoryId + 1}`;
  await assert.rejects(
    ranker.query({
      repositoryScope: otherScope,
      commitSha: index.commitSha,
      providerId: index.embedding.providerId,
      vector,
      limit: 50
    }),
    RepositoryIsolationError
  );
  await assert.rejects(
    ranker.hydrateRecords!({
      repositoryScope: otherScope,
      commitSha: index.commitSha,
      records: [{ recordType: "symbol", recordId: "any" }]
    }),
    RepositoryIsolationError
  );
});

test("the durable ranker adapter rejects a foreign row instead of ranking it", async () => {
  // The store is asked correctly and still answers with another repository's scope.
  // Retrieval re-checks rows against the loaded document, but that check cannot see
  // a document that is itself the wrong repository's; this one compares against the
  // numeric id the caller actually asked about.
  const foreignScope = `github:${defaultRepository.repositoryId + 1}`;
  const store = new ForeignRowStore(foreignScope);
  const index = await publishIndex(store);
  const service = new RepositoryIndexService(store);
  const ranker = service.repositoryVectorRanker(defaultRepository.repositoryId);
  const vector = lexicalFeatureVector("authorize admin", index.embedding.dimensions);

  await assert.rejects(
    ranker.query({
      repositoryScope: index.repositoryScope,
      commitSha: index.commitSha,
      providerId: index.embedding.providerId,
      vector,
      limit: 50
    }),
    RepositoryIsolationError
  );
  await assert.rejects(
    ranker.hydrateRecords!({
      repositoryScope: index.repositoryScope,
      commitSha: index.commitSha,
      records: index.symbols.map((symbol) => ({
        recordType: "symbol" as const,
        recordId: symbol.id
      }))
    }),
    RepositoryIsolationError
  );
});

test("the index descriptor load answers identity without the materialised document", async () => {
  const store = new MemoryStore();
  const index = await publishIndex(store);
  const service = new RepositoryIndexService(store);

  const descriptor = await service.loadRepositoryIndexDescriptor(
    defaultRepository.repositoryId,
    index.commitSha
  );
  assert.ok(descriptor);

  // Sourced from columns rather than from index_document, and it must agree with the
  // document field for field. That agreement is what makes the two usable as
  // independent witnesses to one identity; if they could disagree for a normally
  // published snapshot, comparing them would prove nothing.
  assert.equal(descriptor.storageKey, index.storageKey);
  assert.equal(descriptor.repository, index.repository);
  assert.equal(descriptor.repositoryScope, index.repositoryScope);
  assert.equal(descriptor.commitSha, index.commitSha);
  assert.equal(descriptor.visibility, index.visibility);
  assert.deepEqual(descriptor.embedding, index.embedding);

  // A commit nobody published is absent rather than an error, matching the sibling read.
  assert.equal(
    await service.loadRepositoryIndexDescriptor(
      defaultRepository.repositoryId,
      "1".repeat(40)
    ),
    undefined
  );
});

test("the index descriptor load rejects a foreign row instead of returning its identity", async () => {
  // The descriptor is meant to be a trustworthy identity source for an isolation
  // check, so a row carrying another repository's scope must raise rather than be
  // returned. Were it returned, a later comparison against it would authorize the
  // wrong repository's visibility.
  const foreignScope = `github:${defaultRepository.repositoryId + 1}`;
  const store = new ForeignRowStore(foreignScope);
  const index = await publishIndex(store);
  const service = new RepositoryIndexService(store);

  await assert.rejects(
    service.loadRepositoryIndexDescriptor(defaultRepository.repositoryId, index.commitSha),
    RepositoryIsolationError
  );
});

test("the retrieval embedding provider reconstructs the stored space or declines", async () => {
  const store = new MemoryStore();
  const index = await publishIndex(store);
  const service = new RepositoryIndexService(store);

  // Without this, retrieval holds no query vector and ignores the ranker entirely,
  // so the durable path would be wired and still dormant.
  const provider = service.retrievalEmbeddingProvider(index);
  assert.ok(provider);
  assert.equal(provider.id, index.embedding.providerId);
  assert.equal(provider.dimensions, index.embedding.dimensions);

  // A different embedding space is declined rather than approximated: comparing a
  // lexical hash to another provider's output returns confident nonsense.
  assert.equal(
    service.retrievalEmbeddingProvider({
      ...index,
      embedding: { ...index.embedding, kind: "local-model" }
    }),
    undefined
  );
  assert.equal(
    service.retrievalEmbeddingProvider({
      ...index,
      embedding: { ...index.embedding, providerId: "some-other-provider-v1" }
    }),
    undefined
  );
  assert.equal(
    service.retrievalEmbeddingProvider({
      ...index,
      embedding: { ...index.embedding, dimensions: 4 }
    }),
    undefined
  );
});
