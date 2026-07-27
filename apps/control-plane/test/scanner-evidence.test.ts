import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { createScannerWorkflowRunHandler } from "../src/scanner-evidence.js";
import { MemoryStore, type RepositoryRecord } from "../src/store.js";

interface ZipEntryInput {
  name: string;
  content: Uint8Array;
  compress?: boolean;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
}

function createRepository(): RepositoryRecord {
  return {
    installationId: 1,
    repositoryId: 99,
    fullName: "Geekyshubham/guardianbot-consumer",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false
  };
}

function buildSecurityZip(overrides: Partial<Record<"semgrep" | "trivy" | "gate", unknown>> = {}) {
  return createZip([
    {
      name: "guardianbot-evidence/semgrep.json",
      content: Buffer.from(
        JSON.stringify(overrides.semgrep ?? { results: [] }),
        "utf8"
      )
    },
    {
      name: "guardianbot-evidence/trivy.json",
      content: Buffer.from(
        JSON.stringify(overrides.trivy ?? { Results: [] }),
        "utf8"
      )
    },
    {
      name: "guardianbot-evidence/gate.json",
      content: Buffer.from(
        JSON.stringify(
          overrides.gate ?? {
            conclusion: "success",
            reason: "ok",
            blockers: [],
            observed: [],
            executionFailures: []
          }
        ),
        "utf8"
      )
    }
  ]);
}

function createZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const fileName = Buffer.from(entry.name, "utf8");
    const compressed = entry.compress === false ? Buffer.from(entry.content) : deflateRawSync(entry.content);
    const compressedSize = entry.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.content.length;
    const local = Buffer.alloc(30 + fileName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.compress === false ? 0 : 8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    fileName.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + fileName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.compress === false ? 0 : 8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    fileName.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function createFetchStub(options: {
  workflowRun?: Record<string, unknown>;
  artifactPages?: Array<Array<Record<string, unknown>>>;
  zipByArtifactId?: Record<number, Buffer>;
  dojoFailure?: boolean;
}) {
  const calls: string[] = [];
  const fetchStub: typeof fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.endsWith("/app/installations/1/access_tokens")) {
      return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
    }
    if (url.includes("/actions/runs/500?") || url.endsWith("/actions/runs/500")) {
      return new Response(JSON.stringify(options.workflowRun), { status: 200 });
    }
    if (url.includes("/actions/runs/500/artifacts?")) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return new Response(
        JSON.stringify({
          total_count: (options.artifactPages ?? []).flat().length,
          artifacts: options.artifactPages?.[page - 1] ?? []
        }),
        { status: 200 }
      );
    }
    const artifactMatch = url.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (artifactMatch) {
      const artifactId = Number(artifactMatch[1]);
      const body = options.zipByArtifactId?.[artifactId];
      if (!body) return new Response("missing", { status: 404 });
      return new Response(body, { status: 200 });
    }
    if (url.startsWith("https://dojo.example/api/v2/product_types/")) {
      if (method === "GET") return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: 1, name: "GitHub Repositories" }), { status: 201 });
    }
    if (url.startsWith("https://dojo.example/api/v2/products/")) {
      if (method === "GET") return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: 2, name: "Geekyshubham/guardianbot-consumer", prod_type: 1 }), { status: 201 });
    }
    if (url.startsWith("https://dojo.example/api/v2/engagements/")) {
      if (method === "GET") return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: 3, name: "main/security", product: 2 }), { status: 201 });
    }
    if (url.startsWith("https://dojo.example/api/v2/tests/")) {
      if (method === "GET") return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: 4, engagement: 3, scan_type: "Semgrep JSON Report", title: "main/security" }), { status: 201 });
    }
    if (url.startsWith("https://dojo.example/api/v2/import-scan/")) {
      return options.dojoFailure
        ? new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
        : new Response(JSON.stringify({ test: 4 }), { status: 201 });
    }
    if (url.startsWith("https://dojo.example/api/v2/reimport-scan/")) {
      return options.dojoFailure
        ? new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
        : new Response(JSON.stringify({ test: 4 }), { status: 201 });
    }
    throw new Error(`Unhandled fetch ${method} ${url}`);
  }) as typeof fetch;
  return { fetchStub, calls };
}

function createApiClient(fetchImpl: typeof fetch) {
  return async () => ({
    async requestJson<T>(method: string, path: string): Promise<T> {
      const response = await fetchImpl(`https://api.github.com${path}`, { method });
      if (!response.ok) throw new Error(`GitHub ${method} ${path} failed`);
      return (await response.json()) as T;
    },
    async downloadArtifact(_owner: string, _repo: string, artifactId: number): Promise<string> {
      const response = await fetchImpl(
        `https://api.github.com/repos/Geekyshubham/guardianbot-consumer/actions/artifacts/${artifactId}/zip`,
        { method: "GET" }
      );
      if (!response.ok) throw new Error(`download ${artifactId} failed`);
      const tempFile = await import("node:fs/promises").then((fs) =>
        fs.mkdtemp("/tmp/guardianbot-test-").then((dir) => `${dir}/${artifactId}.zip`)
      );
      const body = Buffer.from(await response.arrayBuffer());
      await import("node:fs/promises").then((fs) => fs.writeFile(tempFile, body));
      return tempFile;
    }
  });
}

async function seedRepository(store: MemoryStore) {
  await store.upsertRepository(createRepository());
}

function trustedWorkflowRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 500,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    head_sha: "a".repeat(40),
    head_branch: "main",
    path: ".github/workflows/guardianbot.yml@refs/heads/main",
    referenced_workflows: [
      {
        path: `Geekyshubham/guardianbot/.github/workflows/reusable-security.yml@${"b".repeat(40)}`,
        sha: "b".repeat(40),
        ref: `refs/heads/main`
      }
    ],
    ...overrides
  };
}

function handlerInput() {
  return {
    repositoryId: 99,
    repositoryFullName: "Geekyshubham/guardianbot-consumer",
    runId: 500,
    runAttempt: 2,
    headSha: "a".repeat(40),
    conclusion: "success",
    workflowPath: ".github/workflows/guardianbot.yml",
    artifactNamePrefixes: [
      "guardianbot-evidence-",
      "guardianbot-image-evidence-",
      "guardianbot-dast-evidence-"
    ] as const
  };
}

test("rejects workflow runs with mutable or untrusted reusable workflow references", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun({
      referenced_workflows: [
        {
          path: "Geekyshubham/guardianbot/.github/workflows/reusable-security.yml@main",
          sha: "b".repeat(40),
          ref: "refs/heads/main"
        }
      ]
    })
  });
  const handler = createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub)
  });

  await handler(handlerInput());

  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.validationStatus, "rejected");
  assert.match(run?.validationError ?? "", /mutable ref|untrusted/i);
});

test("paginates artifact listings and skips duplicate processing after acceptance", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const trustedZip = buildSecurityZip();
  const junkArtifacts = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `junk-${index + 1}`,
    size_in_bytes: 10,
    expired: false
  }));
  const trustedArtifact = {
    id: 501,
    name: "guardianbot-evidence-500-2",
    size_in_bytes: trustedZip.length,
    expired: false,
    digest: `sha256:${createHash("sha256").update(trustedZip).digest("hex")}`
  };
  const { fetchStub, calls } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    artifactPages: [junkArtifacts, [trustedArtifact]],
    zipByArtifactId: { 501: trustedZip }
  });
  const handler = createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub)
  });

  await handler(handlerInput());
  await handler(handlerInput());

  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.validationStatus, "accepted");
  assert.equal(calls.filter((call) => call.includes("/actions/artifacts/501/zip")).length, 1);
  assert.equal(
    calls.filter((call) => call.includes("/actions/runs/500/artifacts?per_page=100&page=")).length,
    2
  );
});

test("rejects trusted artifacts when the GitHub digest does not match", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const trustedZip = buildSecurityZip();
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    artifactPages: [[{
      id: 501,
      name: "guardianbot-evidence-500-2",
      size_in_bytes: trustedZip.length,
      expired: false,
      digest: `sha256:${"0".repeat(64)}`
    }]],
    zipByArtifactId: { 501: trustedZip }
  });
  const handler = createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub)
  });

  await handler(handlerInput());

  const artifacts = [...((store as any).scannerArtifacts as Map<string, any>).values()];
  assert.equal(artifacts[0]?.validationStatus, "rejected");
  assert.match(artifacts[0]?.validationError ?? "", /digest mismatch/);
  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.validationStatus, "failed");
});

test("rejects ZIP traversal entries in trusted artifacts", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const traversalZip = createZip([
    {
      name: "../semgrep.json",
      content: Buffer.from('{"results":[]}', "utf8")
    },
    {
      name: "guardianbot-evidence/trivy.json",
      content: Buffer.from('{"Results":[]}', "utf8")
    },
    {
      name: "guardianbot-evidence/gate.json",
      content: Buffer.from('{"conclusion":"success"}', "utf8")
    }
  ]);
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    artifactPages: [[{
      id: 501,
      name: "guardianbot-evidence-500-2",
      size_in_bytes: traversalZip.length,
      expired: false,
      digest: `sha256:${createHash("sha256").update(traversalZip).digest("hex")}`
    }]],
    zipByArtifactId: { 501: traversalZip }
  });
  const handler = createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub)
  });

  await handler(handlerInput());

  const artifacts = [...((store as any).scannerArtifacts as Map<string, any>).values()];
  assert.equal(artifacts[0]?.validationStatus, "rejected");
  assert.match(artifacts[0]?.validationError ?? "", /unsafe/);
});

test("rejects oversized trusted entries before extraction", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const oversizedZip = createZip([
    {
      name: "guardianbot-evidence/semgrep.json",
      content: Buffer.from("{}", "utf8"),
      declaredUncompressedSize: 40 * 1024 * 1024
    },
    {
      name: "guardianbot-evidence/trivy.json",
      content: Buffer.from('{"Results":[]}', "utf8")
    },
    {
      name: "guardianbot-evidence/gate.json",
      content: Buffer.from('{"conclusion":"success"}', "utf8")
    }
  ]);
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    artifactPages: [[{
      id: 501,
      name: "guardianbot-evidence-500-2",
      size_in_bytes: oversizedZip.length,
      expired: false,
      digest: `sha256:${createHash("sha256").update(oversizedZip).digest("hex")}`
    }]],
    zipByArtifactId: { 501: oversizedZip }
  });
  const handler = createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub)
  });

  await handler(handlerInput());

  const artifacts = [...((store as any).scannerArtifacts as Map<string, any>).values()];
  assert.equal(artifacts[0]?.validationStatus, "rejected");
  assert.match(artifacts[0]?.validationError ?? "", /size limit/);
});

test("retries when a completed workflow run has no trusted GuardianBot artifact yet", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    artifactPages: [[{ id: 42, name: "junk", size_in_bytes: 1, expired: false }]]
  });
  const handler = createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub)
  });

  await assert.rejects(() => handler(handlerInput()), /no trusted GuardianBot artifact yet/);
});

test("persists DefectDojo import failures and raises a retryable error", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const trustedZip = buildSecurityZip();
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    artifactPages: [[{
      id: 501,
      name: "guardianbot-evidence-500-2",
      size_in_bytes: trustedZip.length,
      expired: false,
      digest: `sha256:${createHash("sha256").update(trustedZip).digest("hex")}`
    }]],
    zipByArtifactId: { 501: trustedZip },
    dojoFailure: true
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const handler = createScannerWorkflowRunHandler({
      appId: "1",
      privateKey: "private",
      store,
      fetchImpl: fetchStub,
      apiClientFactory: createApiClient(fetchStub),
      environment: {
        GUARDIANBOT_DEFECTDOJO_BASE_URL_REF: "GUARDIANBOT_DEFECTDOJO_BASE_URL",
        GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF: "GUARDIANBOT_DEFECTDOJO_API_TOKEN",
        GUARDIANBOT_DEFECTDOJO_BASE_URL: "https://dojo.example",
        GUARDIANBOT_DEFECTDOJO_API_TOKEN: "token"
      }
    });
    await assert.rejects(() => handler(handlerInput()), /DefectDojo import failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const evidence = [...((store as any).scannerEvidence as Map<string, any>).values()];
  const dojoFailure = evidence.find((entry) => entry.kind === "defectdojo-import");
  assert.equal(dojoFailure?.status, "failure");
  assert.match(dojoFailure?.details ?? "", /500|boom|failed/i);
});
