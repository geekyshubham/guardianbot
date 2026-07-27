import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import {
  computeEvidenceManifestDigest,
  createEvidenceProvenanceToken,
  type EvidenceArtifactType,
  type EvidenceManifest,
  type EvidenceProvenanceClaims
} from "../src/evidence-attestation.js";
import { createScannerWorkflowRunHandler } from "../src/scanner-evidence.js";
import { MemoryStore, type RepositoryRecord } from "../src/store.js";

const SECURITY_SHA = "b".repeat(40);
const IMAGE_SHA = "c".repeat(40);
const DAST_SHA = "d".repeat(40);
const HEAD_SHA = "a".repeat(40);
const SIGNING_SECRET = "guardianbot-test-evidence-secret-".repeat(2);
const TEST_NOW = new Date("2026-07-27T12:00:00.000Z");
const TEST_ENV = {
  GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY: "Geekyshubham/guardianbot",
  GUARDIANBOT_TRUSTED_SECURITY_WORKFLOW_SHA: SECURITY_SHA,
  GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA: IMAGE_SHA,
  GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA: DAST_SHA,
  GUARDIANBOT_EVIDENCE_SIGNING_SECRET: SIGNING_SECRET
};

interface ZipEntryInput {
  name: string;
  content: Uint8Array;
  compress?: boolean;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  centralFlags?: number;
  localFlags?: number;
  localName?: string;
}

interface FetchStubOptions {
  workflowRun?: Record<string, unknown>;
  jobs?: Array<Record<string, unknown>>;
  artifactPages?: Array<Array<Record<string, unknown>>>;
  zipByArtifactId?: Record<number, Buffer>;
  dojoFailure?: boolean;
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

function workflowForArtifactType(type: EvidenceArtifactType): {
  path: string;
  sha: string;
} {
  if (type === "security") {
    return { path: ".github/workflows/reusable-security.yml", sha: SECURITY_SHA };
  }
  if (type === "dast") {
    return { path: ".github/workflows/reusable-dast.yml", sha: DAST_SHA };
  }
  return { path: ".github/workflows/reusable-image.yml", sha: IMAGE_SHA };
}

function buildProvenanceZip(
  artifactType: EvidenceArtifactType,
  reports: Record<string, unknown | Uint8Array>,
  options: {
    manifestOverrides?: Partial<EvidenceManifest>;
    tokenOverrides?: Partial<EvidenceProvenanceClaims>;
    extraEntries?: ZipEntryInput[];
  } = {}
): Buffer {
  const workflow = workflowForArtifactType(artifactType);
  const reportEntries = Object.entries(reports)
    .map(([name, value]) => ({
      name,
      content:
        value instanceof Uint8Array
          ? value
          : Buffer.from(JSON.stringify(value), "utf8")
    }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
  const manifest: EvidenceManifest = {
    schemaVersion: "1.0.0",
    artifactType,
    repository: "geekyshubham/guardianbot-consumer",
    repositoryId: 99,
    runId: 500,
    runAttempt: 2,
    headSha: HEAD_SHA,
    workflowPath: workflow.path,
    workflowSha: workflow.sha,
    files: reportEntries.map((entry) => ({
      path: entry.name,
      sha256: createHash("sha256").update(entry.content).digest("hex"),
      size: entry.content.length
    })),
    ...options.manifestOverrides
  };
  const issuedAt = Math.floor(TEST_NOW.getTime() / 1_000) - 60;
  const claims: EvidenceProvenanceClaims = {
    version: 1,
    artifactType,
    manifestDigest: computeEvidenceManifestDigest(manifest),
    repository: manifest.repository,
    repositoryId: manifest.repositoryId,
    runId: manifest.runId,
    runAttempt: manifest.runAttempt,
    headSha: manifest.headSha,
    jobWorkflowRef:
      `geekyshubham/guardianbot/${workflow.path}@${workflow.sha}`,
    workflowPath: workflow.path,
    workflowSha: workflow.sha,
    issuedAt,
    expiresAt: issuedAt + 24 * 60 * 60,
    ...options.tokenOverrides
  };
  const prefix =
    artifactType === "security"
      ? "guardianbot-evidence"
      : artifactType === "dast"
        ? "guardianbot-dast-evidence"
        : "guardianbot-image-evidence";
  return createZip([
    ...reportEntries.map((entry) => ({
      name: `${prefix}/${entry.name}`,
      content: entry.content
    })),
    {
      name: `${prefix}/provenance-manifest.json`,
      content: Buffer.from(JSON.stringify(manifest), "utf8")
    },
    {
      name: `${prefix}/provenance-token.txt`,
      content: Buffer.from(
        createEvidenceProvenanceToken(claims, SIGNING_SECRET),
        "utf8"
      )
    },
    ...(options.extraEntries ?? [])
  ]);
}

function actualGateFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0",
    mode: "report-only",
    baselineRequired: false,
    baselineCount: 0,
    passed: true,
    failures: [],
    policyFindings: [],
    activeSuppressions: 0,
    expiredSuppressions: [],
    ...overrides
  };
}

function emptyTrivyReport(artifactType = "filesystem") {
  return {
    SchemaVersion: 2,
    ArtifactName: artifactType === "container_image"
      ? "ghcr.io/example/service:test"
      : "/workspace",
    ArtifactType: artifactType,
    Results: []
  };
}

function scannerFingerprint(parts: Array<string | number | undefined>): string {
  return createHash("sha256")
    .update(
      parts
        .map((part) => String(part ?? "").trim().toLowerCase())
        .join("\u001f")
    )
    .digest("hex");
}

function buildSecurityZip(
  overrides: Partial<Record<"semgrep" | "trivy" | "gate", unknown>> = {},
  options: Parameters<typeof buildProvenanceZip>[2] = {}
): Buffer {
  return buildProvenanceZip(
    "security",
    {
      "gate.json": overrides.gate ?? actualGateFixture(),
      "semgrep.json": overrides.semgrep ?? { results: [] },
      "trivy.json": overrides.trivy ?? emptyTrivyReport()
    },
    options
  );
}

function validImageReports(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    "build-digests.json": {
      schemaVersion: "1.0.0",
      imageId: `sha256:${"1".repeat(64)}`,
      repoTags: [`ghcr.io/example/service:${HEAD_SHA}`],
      promotionExpected: false
    },
    "policy.json": { criticalFindings: 0 },
    "sbom.cdx.json": {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      components: []
    },
    "trivy-image.json": emptyTrivyReport("container_image"),
    ...overrides
  };
}

function validPromotionReports(): Record<string, unknown> {
  const validation = validImageReports({
    "build-digests.json": {
      schemaVersion: "1.0.0",
      imageId: `sha256:${"1".repeat(64)}`,
      repoTags: [`ghcr.io/example/service:${HEAD_SHA}`],
      promotionExpected: true
    }
  });
  const digestHex = "2".repeat(64);
  const digest = `sha256:${digestHex}`;
  const identity =
    "https://github.com/Geekyshubham/guardianbot-consumer/" +
    ".github/workflows/guardianbot.yml@refs/heads/main";
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType: "https://cyclonedx.org/bom",
    subject: [{ name: "ghcr.io/example/service", digest: { sha256: digestHex } }],
    predicate: validation["sbom.cdx.json"]
  };
  const sbomBytes = Buffer.from(
    JSON.stringify(validation["sbom.cdx.json"]),
    "utf8"
  );
  return {
    ...validation,
    "cosign-verification.json": [
      {
        critical: { image: { "docker-manifest-digest": digest } },
        optional: {
          Issuer: "https://token.actions.githubusercontent.com",
          Subject: identity
        }
      }
    ],
    "promotion.json": {
      schemaVersion: "1.0.0",
      imageReference: `ghcr.io/example/service@${digest}`,
      imageDigest: digest,
      certificateIdentity: identity,
      jobWorkflowRef:
        `Geekyshubham/guardianbot/.github/workflows/reusable-image.yml@${IMAGE_SHA}`,
      sbomSha256: createHash("sha256").update(sbomBytes).digest("hex")
    },
    "sbom-attestation-verification.json": [
      { payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64") }
    ]
  };
}

function createZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const centralName = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const compressed =
      entry.compress === false
        ? Buffer.from(entry.content)
        : deflateRawSync(entry.content);
    const compressedSize = entry.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.content.length;
    const localFlags = entry.localFlags ?? entry.centralFlags ?? 0x0800;
    const centralFlags = entry.centralFlags ?? 0x0800;
    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(entry.compress === false ? 0 : 8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    localName.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + centralName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(centralFlags, 8);
    central.writeUInt16LE(entry.compress === false ? 0 : 8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralName.copy(central, 46);
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

function trustedWorkflowRun(
  overrides: Partial<Record<string, unknown>> = {},
  workflows: Array<{ path: string; sha: string }> = [
    { path: ".github/workflows/reusable-security.yml", sha: SECURITY_SHA }
  ]
) {
  return {
    id: 500,
    run_attempt: 2,
    event: "push",
    run_started_at: "2026-07-27T11:55:00.000Z",
    updated_at: "2026-07-27T12:00:00.000Z",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
    head_branch: "main",
    path: ".github/workflows/guardianbot.yml@refs/heads/main",
    repository: {
      id: 99,
      full_name: "Geekyshubham/guardianbot-consumer"
    },
    referenced_workflows: workflows.map((workflow) => ({
      path:
        `Geekyshubham/guardianbot/${workflow.path}@${workflow.sha}`,
      sha: workflow.sha,
      ref: "refs/heads/main"
    })),
    ...overrides
  };
}

function defaultSecurityJobs(): Array<Record<string, unknown>> {
  return [
    {
      name: "guardianbot-security-gate / deterministic scanners",
      status: "completed",
      conclusion: "success"
    }
  ];
}

function artifactRecord(
  id: number,
  name: string,
  zip: Buffer,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    name,
    size_in_bytes: zip.length,
    expired: false,
    digest: `sha256:${createHash("sha256").update(zip).digest("hex")}`,
    archive_download_url:
      `https://api.github.com/repos/Geekyshubham/guardianbot-consumer/actions/artifacts/${id}/zip`,
    workflow_run: {
      id: 500,
      repository_id: 99,
      head_repository_id: 99,
      head_branch: "main",
      head_sha: HEAD_SHA
    },
    ...overrides
  };
}

function createFetchStub(options: FetchStubOptions) {
  const calls: string[] = [];
  const bodies: Array<{
    url: string;
    method: string;
    body: BodyInit | null | undefined;
  }> = [];
  const fetchStub: typeof fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    bodies.push({ url, method, body: init?.body });
    if (url.endsWith("/app/installations/1/access_tokens")) {
      return new Response(JSON.stringify({ token: "installation-token" }), {
        status: 201
      });
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
    if (url.includes("/actions/runs/500/jobs?")) {
      return new Response(
        JSON.stringify({ total_count: options.jobs?.length ?? 0, jobs: options.jobs ?? [] }),
        { status: 200 }
      );
    }
    if (url.endsWith("/actions/runs/500")) {
      return new Response(JSON.stringify(options.workflowRun), { status: 200 });
    }
    const artifactMatch = url.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (artifactMatch) {
      const artifactId = Number(artifactMatch[1]);
      const body = options.zipByArtifactId?.[artifactId];
      if (!body) return new Response("missing", { status: 404 });
      return new Response(body, { status: 200 });
    }
    if (url.startsWith("https://dojo.example/api/v2/product_types/")) {
      if (method === "GET") {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 1, name: "GitHub Repositories" }),
        { status: 201 }
      );
    }
    if (url.startsWith("https://dojo.example/api/v2/products/")) {
      if (method === "GET") {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: 2,
          name: "Geekyshubham/guardianbot-consumer",
          prod_type: 1
        }),
        { status: 201 }
      );
    }
    if (url.startsWith("https://dojo.example/api/v2/engagements/")) {
      if (method === "GET") {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 3, name: "feature/security", product: 2 }),
        { status: 201 }
      );
    }
    if (url.startsWith("https://dojo.example/api/v2/tests/")) {
      if (method === "GET") {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: 4,
          engagement: 3,
          scan_type: "Semgrep JSON Report",
          title: "feature/security"
        }),
        { status: 201 }
      );
    }
    if (
      url.startsWith("https://dojo.example/api/v2/import-scan/") ||
      url.startsWith("https://dojo.example/api/v2/reimport-scan/")
    ) {
      return options.dojoFailure
        ? new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
        : new Response(JSON.stringify({ test: 4 }), { status: 201 });
    }
    throw new Error(`Unhandled fetch ${method} ${url}`);
  }) as typeof fetch;
  return { fetchStub, calls, bodies };
}

function createApiClient(fetchImpl: typeof fetch) {
  return async () => ({
    async requestJson<T>(method: string, path: string): Promise<T> {
      const response = await fetchImpl(`https://api.github.com${path}`, { method });
      if (!response.ok) throw new Error(`GitHub ${method} ${path} failed`);
      return (await response.json()) as T;
    },
    async downloadArtifact(
      _owner: string,
      _repo: string,
      artifactId: number
    ): Promise<string> {
      const response = await fetchImpl(
        `https://api.github.com/repos/Geekyshubham/guardianbot-consumer/actions/artifacts/${artifactId}/zip`,
        { method: "GET" }
      );
      if (!response.ok) throw new Error(`download ${artifactId} failed`);
      const fs = await import("node:fs/promises");
      const directory = await fs.mkdtemp("/tmp/guardianbot-test-");
      const target = `${directory}/${artifactId}.zip`;
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
      return target;
    }
  });
}

async function seedRepository(store: MemoryStore) {
  await store.upsertRepository(createRepository());
}

function handlerInput() {
  return {
    repositoryId: 99,
    repositoryFullName: "Geekyshubham/guardianbot-consumer",
    runId: 500,
    runAttempt: 2,
    headSha: HEAD_SHA,
    conclusion: "success",
    workflowPath: ".github/workflows/guardianbot.yml",
    artifactNamePrefixes: [
      "guardianbot-evidence-",
      "guardianbot-image-evidence-",
      "guardianbot-dast-evidence-"
    ] as const
  };
}

function createHandler(
  store: MemoryStore,
  fetchStub: typeof fetch,
  environment: Record<string, string | undefined> = TEST_ENV
) {
  return createScannerWorkflowRunHandler({
    appId: "1",
    privateKey: "private",
    store,
    fetchImpl: fetchStub,
    apiClientFactory: createApiClient(fetchStub),
    environment,
    now: () => TEST_NOW
  });
}

function scannerArtifacts(store: MemoryStore): any[] {
  return [...((store as any).scannerArtifacts as Map<string, any>).values()];
}

function scannerEvidence(store: MemoryStore): any[] {
  return [...((store as any).scannerEvidence as Map<string, any>).values()];
}

test("rejects workflow runs with mutable or administratively unapproved reusable references", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun({
      referenced_workflows: [
        {
          path: "Geekyshubham/guardianbot/.github/workflows/reusable-security.yml@main",
          sha: SECURITY_SHA,
          ref: "refs/heads/main"
        }
      ]
    })
  });
  await createHandler(store, fetchStub)(handlerInput());
  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.validationStatus, "rejected");
  assert.match(run?.validationError ?? "", /untrusted|mutable/i);
});

test("parses the reusable-security gate.json schema end to end", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const semgrepFinding = {
    check_id: "auth.rule",
    path: "src/auth.ts",
    start: { line: 4 },
    extra: {
      severity: "ERROR",
      message: "Authorization is bypassed",
      metadata: { impact: "Privileged access can bypass authorization" }
    }
  };
  const fingerprint = scannerFingerprint([
    "semgrep",
    semgrepFinding.check_id,
    semgrepFinding.path,
    semgrepFinding.start.line,
    semgrepFinding.extra.message
  ]);
  const zip = buildSecurityZip({
    semgrep: { results: [semgrepFinding] },
    gate: actualGateFixture({
      passed: false,
      failures: ["Semgrep auth.rule at src/auth.ts:4"],
      policyFindings: [
        { source: "semgrep", ruleId: "auth.rule", fingerprint }
      ],
      activeSuppressions: 2,
      expiredSuppressions: ["old-fingerprint"]
    })
  });
  const artifact = artifactRecord(501, "guardianbot-evidence-500-2", zip);
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    jobs: defaultSecurityJobs(),
    artifactPages: [[artifact]],
    zipByArtifactId: { 501: zip }
  });
  await createHandler(store, fetchStub)(handlerInput());
  const gate = scannerEvidence(store).find((entry) => entry.evidenceKey === "gate");
  assert.equal(gate?.status, "failure");
  assert.deepEqual(gate?.payload, {
    passed: false,
    failures: 1,
    policyFindings: 1,
    activeSuppressions: 2,
    expiredSuppressions: 1
  });
  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.validationStatus, "accepted");
  assert.equal(run?.event, "push");
  assert.equal(run?.startedAt, "2026-07-27T11:55:00.000Z");
  assert.equal(run?.completedAt, "2026-07-27T12:00:00.000Z");
});

test("rejects incomplete scanner reports and gate fingerprints that disagree", async (t) => {
  const cases = [
    {
      name: "incomplete Trivy report",
      zip: buildSecurityZip({ trivy: { Results: [] } }),
      error: /complete Trivy report/i
    },
    {
      name: "unmatched gate fingerprint",
      zip: buildSecurityZip({
        gate: actualGateFixture({
          passed: false,
          failures: ["unmatched finding"],
          policyFindings: [
            { source: "semgrep", fingerprint: "0".repeat(64) }
          ]
        })
      }),
      error: /does not agree/i
    }
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const store = new MemoryStore();
      await seedRepository(store);
      const artifactId = 540 + index;
      const { fetchStub } = createFetchStub({
        workflowRun: trustedWorkflowRun(),
        jobs: defaultSecurityJobs(),
        artifactPages: [[
          artifactRecord(
            artifactId,
            "guardianbot-evidence-500-2",
            entry.zip
          )
        ]],
        zipByArtifactId: { [artifactId]: entry.zip }
      });
      await assert.rejects(
        () => createHandler(store, fetchStub)(handlerInput()),
        entry.error
      );
    });
  }
});

test("paginates listings and skips downloads after every expected artifact is accepted", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const zip = buildSecurityZip();
  const junk = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `junk-${index + 1}`,
    size_in_bytes: 10,
    expired: false
  }));
  const trusted = artifactRecord(501, "guardianbot-evidence-500-2", zip);
  const { fetchStub, calls } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    jobs: defaultSecurityJobs(),
    artifactPages: [junk, [trusted]],
    zipByArtifactId: { 501: zip }
  });
  const handler = createHandler(store, fetchStub);
  await handler(handlerInput());
  await handler(handlerInput());
  assert.equal(
    (await store.getScannerWorkflowRun(99, 500, 2))?.validationStatus,
    "accepted"
  );
  assert.equal(
    calls.filter((call) => call.includes("/actions/artifacts/501/zip")).length,
    1
  );
  assert.equal(
    calls.filter((call) => call.includes("/artifacts?per_page=100&page=")).length,
    2
  );
});

test("requires GitHub artifact digest and workflow/repository/head metadata", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const zip = buildSecurityZip();
  const artifact = artifactRecord(501, "guardianbot-evidence-500-2", zip, {
    digest: undefined,
    workflow_run: {
      id: 500,
      repository_id: 100,
      head_repository_id: 99,
      head_branch: "other",
      head_sha: "0".repeat(40)
    }
  });
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    jobs: defaultSecurityJobs(),
    artifactPages: [[artifact]]
  });
  await assert.rejects(
    () => createHandler(store, fetchStub)(handlerInput()),
    /digest|repository|head/i
  );
  assert.equal(scannerArtifacts(store)[0]?.validationStatus, "rejected");
  assert.equal(
    (await store.getScannerWorkflowRun(99, 500, 2))?.processedAt,
    undefined
  );
});

test("rejects a provenance token whose manifest digest was forged", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const zip = buildSecurityZip(
    {},
    { tokenOverrides: { manifestDigest: `sha256:${"0".repeat(64)}` } }
  );
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun(),
    jobs: defaultSecurityJobs(),
    artifactPages: [[artifactRecord(501, "guardianbot-evidence-500-2", zip)]],
    zipByArtifactId: { 501: zip }
  });
  await assert.rejects(
    () => createHandler(store, fetchStub)(handlerInput()),
    /provenance token does not match/i
  );
});

test("rejects ZIP traversal, encrypted flags, local-name mismatches, and oversized entries", async (t) => {
  const cases: Array<{ name: string; zip: Buffer; error: RegExp }> = [
    {
      name: "traversal",
      zip: createZip([
        { name: "../semgrep.json", content: Buffer.from("{}") }
      ]),
      error: /unsafe/
    },
    {
      name: "encrypted flag",
      zip: createZip([
        {
          name: "guardianbot-evidence/gate.json",
          content: Buffer.from("{}"),
          centralFlags: 0x0801,
          localFlags: 0x0801
        }
      ]),
      error: /flags/
    },
    {
      name: "local filename",
      zip: createZip([
        {
          name: "guardianbot-evidence/gate.json",
          localName: "guardianbot-evidence/evil.json",
          content: Buffer.from("{}")
        }
      ]),
      error: /filename/
    },
    {
      name: "oversized",
      zip: createZip([
        {
          name: "guardianbot-evidence/gate.json",
          content: Buffer.from("{}"),
          declaredUncompressedSize: 20 * 1024 * 1024
        }
      ]),
      error: /size limit/
    }
  ];
  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const store = new MemoryStore();
      await seedRepository(store);
      const { fetchStub } = createFetchStub({
        workflowRun: trustedWorkflowRun(),
        jobs: defaultSecurityJobs(),
        artifactPages: [[
          artifactRecord(600 + index, "guardianbot-evidence-500-2", item.zip)
        ]],
        zipByArtifactId: { [600 + index]: item.zip }
      });
      await assert.rejects(
        () => createHandler(store, fetchStub)(handlerInput()),
        item.error
      );
    });
  }
});

test("requires exactly the evidence artifact for every non-skipped trusted reusable job", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const securityZip = buildSecurityZip();
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun({}, [
      { path: ".github/workflows/reusable-security.yml", sha: SECURITY_SHA },
      { path: ".github/workflows/reusable-image.yml", sha: IMAGE_SHA }
    ]),
    jobs: [
      ...defaultSecurityJobs(),
      {
        name: "guardianbot-image / image build, smoke, scan, SBOM",
        status: "completed",
        conclusion: "success"
      },
      {
        name: "guardianbot-image / image push, sign, attest",
        status: "completed",
        conclusion: "skipped"
      }
    ],
    artifactPages: [[
      artifactRecord(501, "guardianbot-evidence-500-2", securityZip)
    ]],
    zipByArtifactId: { 501: securityZip }
  });
  await assert.rejects(
    () => createHandler(store, fetchStub)(handlerInput()),
    /guardianbot-image-evidence/
  );
  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.validationStatus, "failed");
  assert.equal(run?.processedAt, undefined);
});

test("accepts validation evidence without promotion only when the promotion job was skipped", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const imageZip = buildProvenanceZip(
    "image-validation",
    validImageReports()
  );
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun({}, [
      { path: ".github/workflows/reusable-image.yml", sha: IMAGE_SHA }
    ]),
    jobs: [
      {
        name: "guardianbot-image / image build, smoke, scan, SBOM",
        status: "completed",
        conclusion: "success"
      },
      {
        name: "guardianbot-image / image push, sign, attest",
        status: "completed",
        conclusion: "skipped"
      }
    ],
    artifactPages: [[
      artifactRecord(510, "guardianbot-image-evidence-500-2", imageZip)
    ]],
    zipByArtifactId: { 510: imageZip }
  });
  await createHandler(store, fetchStub)(handlerInput());
  assert.equal(
    (await store.getScannerWorkflowRun(99, 500, 2))?.validationStatus,
    "accepted"
  );
});

test("keeps DAST smoke and nightly evidence as distinct trusted profiles", async (t) => {
  const cases = [
    {
      profile: "authenticated-baseline",
      minutes: 15,
      evidenceKey: "zap-smoke-summary",
      kind: "zap-smoke"
    },
    {
      profile: "authenticated-full",
      minutes: 45,
      evidenceKey: "zap-nightly-summary",
      kind: "zap-nightly"
    }
  ] as const;
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.profile, async () => {
      const store = new MemoryStore();
      await seedRepository(store);
      const zip = buildProvenanceZip("dast", {
        "scan-status.json": {
          schemaVersion: "1.0.0",
          profile: entry.profile,
          minutes: entry.minutes,
          zapExitCode: 0
        },
        "zap.json": { site: [] }
      });
      const artifactId = 515 + index;
      const { fetchStub } = createFetchStub({
        workflowRun: trustedWorkflowRun({}, [
          { path: ".github/workflows/reusable-dast.yml", sha: DAST_SHA }
        ]),
        jobs: [
          {
            name: "guardianbot-dast / authenticated staging DAST",
            status: "completed",
            conclusion: "success"
          }
        ],
        artifactPages: [[
          artifactRecord(
            artifactId,
            "guardianbot-dast-evidence-500-2",
            zip
          )
        ]],
        zipByArtifactId: { [artifactId]: zip }
      });
      await createHandler(store, fetchStub)(handlerInput());
      const summary = scannerEvidence(store).find(
        (record) => record.evidenceKey === entry.evidenceKey
      );
      assert.equal(summary?.kind, entry.kind);
      assert.equal(summary?.payload?.profile, entry.profile);
      assert.equal(summary?.payload?.minutes, entry.minutes);
    });
  }
});

test("fails image evidence on scanner_error or a policy count that disagrees with Trivy", async (t) => {
  const cases = [
    validImageReports({ "trivy-image.json": { scanner_error: true } }),
    validImageReports({ "policy.json": { criticalFindings: 1 } })
  ];
  for (const [index, reports] of cases.entries()) {
    await t.test(String(index), async () => {
      const store = new MemoryStore();
      await seedRepository(store);
      const zip = buildProvenanceZip("image-validation", reports);
      const { fetchStub } = createFetchStub({
        workflowRun: trustedWorkflowRun({}, [
          { path: ".github/workflows/reusable-image.yml", sha: IMAGE_SHA }
        ]),
        jobs: [
          {
            name: "image build, smoke, scan, SBOM",
            status: "completed",
            conclusion: "success"
          },
          {
            name: "image push, sign, attest",
            status: "completed",
            conclusion: "skipped"
          }
        ],
        artifactPages: [[
          artifactRecord(520 + index, "guardianbot-image-evidence-500-2", zip)
        ]],
        zipByArtifactId: { [520 + index]: zip }
      });
      await assert.rejects(
        () => createHandler(store, fetchStub)(handlerInput()),
        /scanner_error|critical count/i
      );
    });
  }
});

test("requires structurally valid Cosign signature and CycloneDX attestation evidence for promotion", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const validationZip = buildProvenanceZip(
    "image-validation",
    validImageReports()
  );
  const promotionZip = buildProvenanceZip(
    "image-promotion",
    validPromotionReports()
  );
  const { fetchStub } = createFetchStub({
    workflowRun: trustedWorkflowRun({}, [
      { path: ".github/workflows/reusable-image.yml", sha: IMAGE_SHA }
    ]),
    jobs: [
      {
        name: "image build, smoke, scan, SBOM",
        status: "completed",
        conclusion: "success"
      },
      {
        name: "image push, sign, attest",
        status: "completed",
        conclusion: "success"
      }
    ],
    artifactPages: [[
      artifactRecord(530, "guardianbot-image-evidence-500-2", validationZip),
      artifactRecord(531, "guardianbot-image-promotion-500-2", promotionZip)
    ]],
    zipByArtifactId: { 530: validationZip, 531: promotionZip }
  });
  await createHandler(store, fetchStub)(handlerInput());
  const signature = scannerEvidence(store).find(
    (entry) => entry.evidenceKey === "signature"
  );
  assert.equal(signature?.status, "success");
  assert.equal(signature?.payload?.signatures, 1);
  assert.equal(signature?.payload?.sbomAttestations, 1);
});

test("records exact DigitalOcean deployment evidence from a trusted promotion", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const validationZip = buildProvenanceZip(
    "image-validation",
    validImageReports()
  );
  const promotionZip = buildProvenanceZip(
    "image-promotion",
    validPromotionReports()
  );
  const github = createFetchStub({
    workflowRun: trustedWorkflowRun({}, [
      { path: ".github/workflows/reusable-image.yml", sha: IMAGE_SHA }
    ]),
    jobs: [
      {
        name: "image build, smoke, scan, SBOM",
        status: "completed",
        conclusion: "success"
      },
      {
        name: "image push, sign, attest",
        status: "completed",
        conclusion: "success"
      }
    ],
    artifactPages: [[
      artifactRecord(540, "guardianbot-image-evidence-500-2", validationZip),
      artifactRecord(541, "guardianbot-image-promotion-500-2", promotionZip)
    ]],
    zipByArtifactId: { 540: validationZip, 541: promotionZip }
  });
  const digest = `sha256:${"2".repeat(64)}`;
  const appId = "346b3b81-b8cf-4136-b706-0a7195bc9f00";
  const deploymentId = "1304cb3c-f8c9-4135-8ad5-e21ed98b1aef";
  const fetchStub: typeof fetch = (async (request, init) => {
    const url =
      request instanceof URL
        ? request
        : new URL(typeof request === "string" ? request : request.url);
    if (url.origin === "https://api.digitalocean.com") {
      return Response.json({
        app: {
          id: appId,
          spec: {
            name: "guardianbot-consumer-staging",
            services: [
              {
                name: "web",
                image: {
                  registry_type: "GHCR",
                  registry: "example",
                  repository: "service",
                  digest
                }
              }
            ]
          },
          active_deployment: {
            id: deploymentId,
            phase: "ACTIVE",
            spec: {
              name: "guardianbot-consumer-staging",
              services: [
                {
                  name: "web",
                  image: {
                    registry_type: "GHCR",
                    registry: "example",
                    repository: "service",
                    digest
                  }
                }
              ]
            }
          },
          in_progress_deployment: null
        }
      });
    }
    if (url.href === "https://staging.example.com/healthz") {
      return new Response("ok", { status: 200 });
    }
    return github.fetchStub(request, init);
  }) as typeof fetch;
  const environment = {
    ...TEST_ENV,
    DIGITALOCEAN_STAGING_TOKEN: "dop_v1_test-token-with-enough-entropy",
    GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON: JSON.stringify({
      consumer: {
        repository: "Geekyshubham/guardianbot-consumer",
        repositoryId: 99,
        appId,
        appName: "guardianbot-consumer-staging",
        serviceNames: ["web"],
        imageName: "ghcr.io/example/service",
        environment: "staging",
        origin: "https://staging.example.com",
        healthPath: "/healthz",
        apiTokenEnv: "DIGITALOCEAN_STAGING_TOKEN",
        timeoutSeconds: 60
      }
    })
  };

  await createHandler(store, fetchStub, environment)(handlerInput());
  const deployment = scannerEvidence(store).find(
    (entry) => entry.evidenceKey === "deployment:staging"
  );
  assert.equal(deployment?.status, "success");
  assert.equal(deployment?.digest, digest);
  assert.equal(deployment?.environment, "staging");
  assert.equal(deployment?.payload?.deploymentId, deploymentId);
});

test("persists DefectDojo reconciliation failure without mutating the completed GitHub gate", async () => {
  const store = new MemoryStore();
  await seedRepository(store);
  const zip = buildSecurityZip();
  const { fetchStub, bodies } = createFetchStub({
    workflowRun: trustedWorkflowRun({ head_branch: "feature" }),
    jobs: defaultSecurityJobs(),
    artifactPages: [[
      artifactRecord(501, "guardianbot-evidence-500-2", zip, {
        workflow_run: {
          id: 500,
          repository_id: 99,
          head_repository_id: 99,
          head_branch: "feature",
          head_sha: HEAD_SHA
        }
      })
    ]],
    zipByArtifactId: { 501: zip },
    dojoFailure: true
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await assert.rejects(
      () =>
        createHandler(store, fetchStub, {
          ...TEST_ENV,
          GUARDIANBOT_DEFECTDOJO_BASE_URL_REF:
            "GUARDIANBOT_DEFECTDOJO_BASE_URL",
          GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF:
            "GUARDIANBOT_DEFECTDOJO_API_TOKEN",
          GUARDIANBOT_DEFECTDOJO_BASE_URL: "https://dojo.example",
          GUARDIANBOT_DEFECTDOJO_API_TOKEN: "token"
        })(handlerInput()),
      /DefectDojo import failed/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const evidence = scannerEvidence(store);
  assert.equal(
    evidence.find((entry) => entry.kind === "defectdojo-import")?.status,
    "failure"
  );
  assert.equal(evidence.find((entry) => entry.evidenceKey === "gate")?.status, "success");
  const artifact = scannerArtifacts(store)[0];
  assert.equal(artifact?.validationStatus, "failed");
  assert.match(artifact?.validationError ?? "", /reconciliation health/i);
  const run = await store.getScannerWorkflowRun(99, 500, 2);
  assert.equal(run?.conclusion, "success");
  assert.equal(run?.validationStatus, "failed");
  assert.equal(run?.processedAt, undefined);
  const importRequest = bodies.find((entry) =>
    entry.url.includes("import-scan/")
  );
  const form = importRequest?.body as
    | { get(name: string): FormDataEntryValue | null }
    | undefined;
  assert.equal(typeof form?.get, "function");
  assert.equal(form?.get("branch_tag"), "feature");
  assert.equal(form?.get("close_old_findings"), "false");
});
