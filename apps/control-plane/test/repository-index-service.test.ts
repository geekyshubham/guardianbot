import assert from "node:assert/strict";
import test from "node:test";
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
