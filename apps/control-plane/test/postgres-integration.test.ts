/**
 * Opt-in parity suite against a real PostgreSQL server.
 *
 * Every scenario runs the same writes against a MemoryStore and a PostgresStore and then compares
 * what the two read back, including ordering and tie-breaks. The MemoryStore is what most of the
 * test suite runs against, so any divergence found here means those tests were evidence about the
 * in-memory model rather than about production.
 *
 * The suite runs only when GUARDIANBOT_TEST_DATABASE_URL is set. Each scenario gets its own
 * throwaway schema, runs the real `PostgresStore.migrate()` inside it, and drops it afterwards, so
 * the suite never reads or writes the `public` schema of the database it is pointed at.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { indexRepository, toPersistedVectorRows } from "@guardianbot/core";
import {
  MemoryStore,
  PostgresStore,
  type FindingLifecycleRecord,
  type FindingLifecycleStreamWatermark,
  type RepositoryRecord,
  type ScannerEvidenceRecord,
  type ScannerWorkflowEvent,
  type Store
} from "../src/store.js";

const databaseUrl = process.env.GUARDIANBOT_TEST_DATABASE_URL?.trim() ?? "";
if (!databaseUrl && process.env.GUARDIANBOT_TEST_DATABASE_REQUIRED === "1") {
  // CI sets the flag so a lost or renamed URL fails the job instead of skipping every test.
  throw new Error("GUARDIANBOT_TEST_DATABASE_REQUIRED=1 but GUARDIANBOT_TEST_DATABASE_URL is not set");
}
const skip = databaseUrl
  ? false
  : "GUARDIANBOT_TEST_DATABASE_URL is not set; the real-PostgreSQL parity suite is opt-in";

const SCHEMA_PATTERN = /^gb_it_[a-f0-9]{12}$/;

/** Points the store's pool at one schema through the libpq `options` startup parameter. */
function schemaScopedUrl(base: string, schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error("unexpected test schema name");
  const url = new URL(base);
  const existing = url.search ? `${url.search.slice(1)}&` : "";
  url.search = `${existing}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  return url.toString();
}

/** JSON round trip, so an absent key and a key holding `undefined` compare equal. */
function normalize<T>(value: T): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * Runs `scenario` once against a MemoryStore and once against a freshly migrated PostgresStore in
 * an isolated schema, asserts both produced identical observations, and returns them.
 */
async function parity(scenario: (store: Store) => Promise<unknown>): Promise<any> {
  const schema = `gb_it_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scopedUrl = schemaScopedUrl(databaseUrl, schema);
  const postgres = new PostgresStore(scopedUrl);
  try {
    // Fail closed before writing anything: a store that silently fell back to `public` would
    // write into whatever database the variable names.
    const probe = new Pool({ connectionString: scopedUrl, max: 1 });
    try {
      const current = await probe.query<{ schema: string }>("SELECT current_schema() AS schema");
      assert.equal(current.rows[0]?.schema, schema);
    } finally {
      await probe.end();
    }
    await postgres.migrate();
    const memoryObserved = normalize(await scenario(new MemoryStore()));
    const postgresObserved = normalize(await scenario(postgres));
    assert.deepEqual(postgresObserved, memoryObserved);
    return memoryObserved;
  } finally {
    await postgres.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

function repository(
  repositoryId: number,
  overrides: Partial<RepositoryRecord> = {}
): RepositoryRecord {
  return {
    installationId: 1,
    repositoryId,
    fullName: `acme/repo-${repositoryId}`,
    visibility: "private",
    defaultBranch: "main",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false,
    ...overrides
  };
}

interface RunSeed {
  repositoryId: number;
  runId: number;
  runAttempt?: number;
  headSha?: string;
  headBranch?: string;
  event?: ScannerWorkflowEvent;
  startedAt?: string;
  completedAt?: string;
  processedAt?: string;
  artifactType: string;
  artifactId?: number;
}

function artifactIdFor(seed: Pick<RunSeed, "runId" | "runAttempt" | "artifactId">): number {
  return seed.artifactId ?? seed.runId * 10 + (seed.runAttempt ?? 1);
}

async function seedRun(store: Store, seed: RunSeed): Promise<void> {
  const runAttempt = seed.runAttempt ?? 1;
  await store.upsertScannerWorkflowRun({
    repositoryId: seed.repositoryId,
    runId: seed.runId,
    runAttempt,
    headSha: seed.headSha ?? "a".repeat(40),
    headBranch: seed.headBranch ?? "main",
    event: seed.event ?? "push",
    startedAt: seed.startedAt,
    completedAt: seed.completedAt,
    processedAt: seed.processedAt,
    workflowPath: ".github/workflows/guardianbot.yml",
    workflowRef: "refs/heads/main",
    workflowSha: "b".repeat(40),
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: [{ path: ".github/workflows/reusable-image.yml", sha: "c".repeat(40) }]
  });
  await store.upsertScannerArtifact({
    repositoryId: seed.repositoryId,
    runId: seed.runId,
    runAttempt,
    artifactId: artifactIdFor(seed),
    artifactName: `guardianbot-${seed.artifactType}-${seed.runId}-${runAttempt}`,
    artifactType: seed.artifactType,
    sizeBytes: 64,
    expired: false,
    digest: `sha256:${"d".repeat(64)}`,
    validationStatus: "accepted",
    processedAt: "2026-07-27T09:00:00.000Z"
  });
}

async function seedEvidence(
  store: Store,
  seed: Pick<RunSeed, "repositoryId" | "runId" | "runAttempt" | "artifactId"> &
    Omit<ScannerEvidenceRecord, "repositoryId" | "runId" | "runAttempt" | "artifactId">
): Promise<void> {
  const { repositoryId, runId, runAttempt, artifactId, ...rest } = seed;
  await store.upsertScannerEvidence({
    repositoryId,
    runId,
    runAttempt: runAttempt ?? 1,
    artifactId: artifactIdFor({ runId, runAttempt, artifactId }),
    ...rest
  });
}

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const certificateIdentity =
  "https://github.com/acme/guardianbot/.github/workflows/reusable-image.yml@" + "c".repeat(40);

test("parity: monitoring inventory keeps default-branch runs and evidence in one order", { skip }, async () => {
  const observed = await parity(async (store) => {
    await store.upsertRepository(repository(10));
    await store.upsertRepository(repository(11, { defaultBranch: "trunk" }));
    await store.upsertRepository(repository(12, { repositoryState: "suspended" }));
    const index = indexRepository({
      repository: "acme/repo-10",
      repositoryId: 10,
      commitSha: "e".repeat(40),
      files: { "src/app.ts": "export function handler(input) { return input.id; }" }
    });
    await store.replaceRepositoryIndex(
      10,
      index,
      toPersistedVectorRows(index),
      new Date("2026-07-27T08:00:00.000Z")
    );

    const tied = "2026-07-27T10:00:00.000Z";
    // Two runs share a completion time, and run 101 has two attempts, so only the run id and
    // attempt tie-breaks can order them.
    await seedRun(store, { repositoryId: 10, runId: 100, completedAt: tied, artifactType: "image-promotion" });
    await seedRun(store, { repositoryId: 10, runId: 101, completedAt: tied, artifactType: "image-promotion" });
    await seedRun(store, {
      repositoryId: 10,
      runId: 101,
      runAttempt: 2,
      completedAt: tied,
      artifactType: "image-promotion"
    });
    // A newer release-branch push must never appear in default-branch monitoring.
    await seedRun(store, {
      repositoryId: 10,
      runId: 102,
      headBranch: "release/1",
      completedAt: "2026-07-27T12:00:00.000Z",
      artifactType: "image-promotion"
    });
    await seedRun(store, {
      repositoryId: 10,
      runId: 103,
      event: "schedule",
      startedAt: "2026-07-27T11:00:00.000Z",
      artifactType: "image-rescan"
    });
    // A run carrying no timestamp at all is ranked oldest, never by when the row was written.
    await seedRun(store, { repositoryId: 10, runId: 104, artifactType: "sast" });
    await seedRun(store, {
      repositoryId: 10,
      runId: 105,
      processedAt: "2026-07-26T10:00:00.000Z",
      artifactType: "sast"
    });
    await seedRun(store, {
      repositoryId: 11,
      runId: 200,
      headBranch: "trunk",
      completedAt: tied,
      artifactType: "sast"
    });
    await seedRun(store, {
      repositoryId: 11,
      runId: 201,
      headBranch: "main",
      completedAt: "2026-07-27T12:00:00.000Z",
      artifactType: "sast"
    });
    await seedRun(store, { repositoryId: 12, runId: 300, completedAt: tied, artifactType: "sast" });

    const signature = (runId: number, runAttempt = 1) =>
      seedEvidence(store, {
        repositoryId: 10,
        runId,
        runAttempt,
        evidenceKey: "signature",
        kind: "signature",
        source: "cosign",
        status: "success",
        observedAt: tied,
        digest: digest(String(runId % 10)),
        payload: { imageDigest: digest(String(runId % 10)), certificateIdentity }
      });
    // Inserted newest-last, so a write-time tie-break would pick a different row than the ids.
    await signature(101, 2);
    await signature(101);
    await signature(100);
    await signature(102);
    for (const runId of [101, 100]) {
      await seedEvidence(store, {
        repositoryId: 10,
        runId,
        evidenceKey: "deployment:staging",
        kind: "deployment",
        source: "digitalocean",
        status: "success",
        observedAt: "2026-07-27T10:05:00.000Z",
        digest: digest(String(runId % 10)),
        environment: "staging",
        payload: { origin: "https://staging.example.com" }
      });
    }
    // Several keys from one run share an observation time; their relative order must be fixed.
    for (const evidenceKey of ["sbom", "image-trivy-summary", "image-sbom-diff"]) {
      await seedEvidence(store, {
        repositoryId: 10,
        runId: 101,
        runAttempt: 2,
        evidenceKey,
        kind: evidenceKey === "sbom" ? "sbom" : "trivy",
        source: "trivy",
        status: "success",
        observedAt: tied,
        payload: { criticalFindings: 0 }
      });
    }
    await seedEvidence(store, {
      repositoryId: 10,
      runId: 103,
      evidenceKey: "image-rescan:staging",
      kind: "image-rescan",
      source: "trivy",
      status: "success",
      observedAt: "2026-07-27T11:05:00.000Z",
      digest: digest("1"),
      environment: "staging"
    });
    // Per-finding rows are lifecycle input, not monitoring evidence.
    await seedEvidence(store, {
      repositoryId: 10,
      runId: 100,
      evidenceKey: "finding:semgrep:1",
      kind: "finding",
      source: "semgrep",
      status: "failure",
      observedAt: "2026-07-27T13:00:00.000Z",
      fingerprint: "f".repeat(64),
      path: "src/app.ts",
      line: 3
    });
    for (const runId of [104, 105]) {
      await seedEvidence(store, {
        repositoryId: 10,
        runId,
        evidenceKey: "semgrep-summary",
        kind: "semgrep",
        source: "semgrep",
        status: "success",
        observedAt: "2026-07-26T10:00:00.000Z",
        details: `run ${runId}`
      });
    }
    for (const runId of [200, 201]) {
      await seedEvidence(store, {
        repositoryId: 11,
        runId,
        evidenceKey: "semgrep-summary",
        kind: "semgrep",
        source: "semgrep",
        status: "success",
        observedAt: "2026-07-27T10:00:00.000Z"
      });
    }
    return store.listMonitoringRepositoryInventory();
  });

  assert.deepEqual(
    observed.map((item: any) => item.repository.repositoryId),
    [10, 11]
  );
  const [primary, trunk] = observed;
  assert.equal(primary.index?.commitSha, "e".repeat(40));
  assert.deepEqual(
    primary.latestScannerRuns.map((run: any) => `${run.runId}/${run.runAttempt}`),
    ["103/1", "101/2", "101/1", "100/1", "105/1", "104/1"]
  );
  assert.deepEqual(
    primary.latestScannerEvidence.map(
      (evidence: any) => `${evidence.evidenceKey}@${evidence.runId}/${evidence.runAttempt}`
    ),
    [
      "image-rescan:staging@103/1",
      "deployment:staging@101/1",
      "image-sbom-diff@101/2",
      "image-trivy-summary@101/2",
      "sbom@101/2",
      "signature@101/2",
      "semgrep-summary@105/1"
    ]
  );
  assert.deepEqual(
    trunk.latestScannerRuns.map((run: any) => run.runId),
    [200]
  );
});

async function seedDeployment(
  store: Store,
  options: {
    repositoryId: number;
    runId: number;
    headSha: string;
    imageDigest: string;
    observedAt: string;
    signatureDigest?: string | null;
    event?: ScannerWorkflowEvent;
  }
): Promise<void> {
  await seedRun(store, {
    repositoryId: options.repositoryId,
    runId: options.runId,
    headSha: options.headSha,
    event: options.event,
    completedAt: options.observedAt,
    artifactType: "image-promotion"
  });
  if (options.signatureDigest !== null) {
    await seedEvidence(store, {
      repositoryId: options.repositoryId,
      runId: options.runId,
      evidenceKey: "signature",
      kind: "signature",
      source: "cosign",
      status: "success",
      observedAt: options.observedAt,
      digest: options.signatureDigest ?? options.imageDigest,
      payload: {
        imageDigest: options.signatureDigest ?? options.imageDigest,
        imageReference: `ghcr.io/acme/service@${options.imageDigest}`,
        certificateIdentity
      }
    });
  }
  await seedEvidence(store, {
    repositoryId: options.repositoryId,
    runId: options.runId,
    evidenceKey: "deployment:staging",
    kind: "deployment",
    source: "digitalocean",
    status: "success",
    observedAt: options.observedAt,
    digest: options.imageDigest,
    environment: "staging",
    payload: { origin: "https://staging.example.com" }
  });
}

test("parity: latest deployed image evidence picks one newest deployment", { skip }, async () => {
  const observed = await parity(async (store) => {
    for (const repositoryId of [77, 78, 79, 80]) await store.upsertRepository(repository(repositoryId));
    // Newest wins.
    await seedDeployment(store, {
      repositoryId: 77,
      runId: 100,
      headSha: "a".repeat(40),
      imageDigest: digest("1"),
      observedAt: "2026-07-26T10:00:00.000Z"
    });
    await seedDeployment(store, {
      repositoryId: 77,
      runId: 200,
      headSha: "b".repeat(40),
      imageDigest: digest("2"),
      observedAt: "2026-07-27T10:00:00.000Z"
    });
    // Equal observation times, the higher run inserted first: the run id decides, not write order.
    await seedDeployment(store, {
      repositoryId: 78,
      runId: 301,
      headSha: "c".repeat(40),
      imageDigest: digest("3"),
      observedAt: "2026-07-27T10:00:00.000Z"
    });
    await seedDeployment(store, {
      repositoryId: 78,
      runId: 300,
      headSha: "d".repeat(40),
      imageDigest: digest("4"),
      observedAt: "2026-07-27T10:00:00.000Z"
    });
    // The newest deployment has no matching signature: nothing, never the older digest.
    await seedDeployment(store, {
      repositoryId: 79,
      runId: 400,
      headSha: "a".repeat(40),
      imageDigest: digest("5"),
      observedAt: "2026-07-26T10:00:00.000Z"
    });
    await seedDeployment(store, {
      repositoryId: 79,
      runId: 401,
      headSha: "b".repeat(40),
      imageDigest: digest("6"),
      observedAt: "2026-07-27T10:00:00.000Z",
      signatureDigest: digest("7")
    });
    // A newer schedule-event row is not a promotion.
    await seedDeployment(store, {
      repositoryId: 80,
      runId: 500,
      headSha: "a".repeat(40),
      imageDigest: digest("8"),
      observedAt: "2026-07-26T10:00:00.000Z"
    });
    await seedDeployment(store, {
      repositoryId: 80,
      runId: 501,
      headSha: "b".repeat(40),
      imageDigest: digest("9"),
      observedAt: "2026-07-27T10:00:00.000Z",
      event: "schedule"
    });
    return {
      newest: await store.getLatestDeployedImageEvidence(77, "staging", "main"),
      tied: await store.getLatestDeployedImageEvidence(78, "staging", "main"),
      unbound: await store.getLatestDeployedImageEvidence(79, "staging", "main"),
      schedule: await store.getLatestDeployedImageEvidence(80, "staging", "main"),
      otherBranch: await store.getLatestDeployedImageEvidence(77, "staging", "release/1"),
      otherEnvironment: await store.getLatestDeployedImageEvidence(77, "production", "main"),
      successful: await store.getSuccessfulDeploymentEvidence(78, "staging", "d".repeat(40), "main")
    };
  });

  assert.equal(observed.newest?.imageDigest, digest("2"));
  assert.equal(observed.newest?.imageReference, `ghcr.io/acme/service@${digest("2")}`);
  assert.equal(observed.tied?.runId, 301);
  assert.equal(observed.unbound, undefined);
  assert.equal(observed.schedule?.runId, 500);
  assert.equal(observed.otherBranch, undefined);
  assert.equal(observed.otherEnvironment, undefined);
  assert.equal(observed.successful?.runId, 300);
});

test("parity: release image evidence binds signature, scan and SBOM from one artifact", { skip }, async () => {
  const observed = await parity(async (store) => {
    await store.upsertRepository(repository(30));
    const headSha = "a".repeat(40);
    const sibling = async (
      runId: number,
      evidenceKey: string,
      kind: string,
      source: string,
      payload?: Record<string, unknown>
    ) =>
      seedEvidence(store, {
        repositoryId: 30,
        runId,
        evidenceKey,
        kind,
        source,
        status: "success",
        observedAt: "2026-07-27T10:01:00.000Z",
        payload
      });
    const cases: Array<[number, string, unknown]> = [
      [600, digest("1"), 0],
      [601, digest("2"), 7],
      [602, digest("3"), "3"],
      [603, digest("4"), 2.5],
      [604, digest("5"), -1]
    ];
    for (const [runId, imageDigest, criticalFindings] of cases) {
      await seedDeployment(store, {
        repositoryId: 30,
        runId,
        headSha,
        imageDigest,
        observedAt: "2026-07-27T10:00:00.000Z"
      });
      await sibling(runId, "image-trivy-summary", "trivy", "trivy", { criticalFindings });
      await sibling(runId, "sbom", "sbom", "trivy");
    }
    // Siblings from the wrong scanner are not evidence for this digest.
    await seedDeployment(store, {
      repositoryId: 30,
      runId: 610,
      headSha,
      imageDigest: digest("6"),
      observedAt: "2026-07-27T10:00:00.000Z"
    });
    await sibling(610, "image-trivy-summary", "trivy", "grype", { criticalFindings: 0 });
    await sibling(610, "sbom", "spdx", "trivy");
    // Two promotions of one digest at the same instant, the lower run inserted last.
    for (const runId of [621, 620]) {
      await seedDeployment(store, {
        repositoryId: 30,
        runId,
        headSha,
        imageDigest: digest("7"),
        observedAt: "2026-07-27T10:00:00.000Z"
      });
    }
    await sibling(620, "sbom", "sbom", "trivy");
    const lookup = (imageDigest: string, sha = headSha, branch = "main") =>
      store.getReleaseImageEvidence(30, sha, imageDigest, branch);
    return {
      clean: await lookup(digest("1")),
      critical: await lookup(digest("2")),
      stringCount: await lookup(digest("3")),
      fractional: await lookup(digest("4")),
      negative: await lookup(digest("5")),
      wrongScanner: await lookup(digest("6")),
      tied: await lookup(digest("7")),
      wrongHead: await lookup(digest("1"), "b".repeat(40)),
      wrongBranch: await lookup(digest("1"), headSha, "release/1"),
      unknown: await lookup(digest("8"))
    };
  });

  assert.equal(observed.clean?.imageScan?.criticalFindings, 0);
  assert.equal(observed.clean?.sbom?.status, "success");
  assert.equal(observed.critical?.imageScan?.criticalFindings, 7);
  assert.equal(observed.stringCount?.imageScan?.criticalFindings, -1);
  assert.equal(observed.fractional?.imageScan?.criticalFindings, -1);
  assert.equal(observed.negative?.imageScan?.criticalFindings, -1);
  assert.equal(observed.wrongScanner?.imageScan, undefined);
  assert.equal(observed.wrongScanner?.sbom, undefined);
  assert.equal(observed.tied?.runId, 621);
  assert.equal(observed.tied?.sbom, undefined);
  assert.equal(observed.wrongHead, undefined);
  assert.equal(observed.wrongBranch, undefined);
  assert.equal(observed.unknown, undefined);
});

test("parity: release DAST evidence is bound to digest and environment", { skip }, async () => {
  const observed = await parity(async (store) => {
    await store.upsertRepository(repository(40));
    const summary = async (
      runId: number,
      evidenceKey: string,
      options: {
        imageDigest?: string;
        environment?: string;
        observedAt?: string;
        status?: "success" | "failure";
        source?: string;
        artifactType?: string;
        headBranch?: string;
      } = {}
    ) => {
      await seedRun(store, {
        repositoryId: 40,
        runId,
        event: "schedule",
        headBranch: options.headBranch,
        completedAt: options.observedAt ?? "2026-07-27T10:00:00.000Z",
        artifactType: options.artifactType ?? "dast"
      });
      await seedEvidence(store, {
        repositoryId: 40,
        runId,
        evidenceKey,
        kind: "dast",
        source: options.source ?? "zap",
        status: options.status ?? "success",
        observedAt: options.observedAt ?? "2026-07-27T10:00:00.000Z",
        digest: options.imageDigest ?? digest("1"),
        environment: options.environment ?? "staging"
      });
    };
    await summary(700, "zap-smoke-summary", { observedAt: "2026-07-26T10:00:00.000Z" });
    // Smoke and nightly summaries at the same instant: the higher run decides.
    await summary(702, "zap-nightly-summary", { status: "failure" });
    await summary(701, "zap-smoke-summary");
    await summary(703, "zap-nightly-summary", {
      observedAt: "2026-07-28T10:00:00.000Z",
      environment: "production"
    });
    await summary(704, "zap-nightly-summary", {
      observedAt: "2026-07-28T10:00:00.000Z",
      headBranch: "release/1"
    });
    await summary(705, "zap-nightly-summary", {
      observedAt: "2026-07-28T10:00:00.000Z",
      artifactType: "sast"
    });
    await summary(706, "zap-full-summary", { observedAt: "2026-07-28T10:00:00.000Z" });
    await summary(707, "zap-nightly-summary", {
      observedAt: "2026-07-28T10:00:00.000Z",
      source: "burp"
    });
    return {
      staging: await store.getReleaseDastEvidence(40, digest("1"), "staging", "main"),
      production: await store.getReleaseDastEvidence(40, digest("1"), "production", "main"),
      otherDigest: await store.getReleaseDastEvidence(40, digest("2"), "staging", "main")
    };
  });

  assert.equal(observed.staging?.runId, 702);
  assert.equal(observed.staging?.status, "failure");
  assert.equal(observed.production?.runId, 703);
  assert.equal(observed.otherDigest, undefined);
});

function lifecycleRecord(overrides: Partial<FindingLifecycleRecord> = {}): FindingLifecycleRecord {
  return {
    repositoryId: 20,
    fingerprint: "f".repeat(64),
    source: "semgrep",
    ruleId: "rule.one",
    severity: "high",
    path: "src/app.ts",
    line: 4,
    status: "open",
    owner: "@acme/app",
    streams: { semgrep: "2026-07-27T11:40:00.000Z" },
    firstSeenAt: "2026-07-27T11:40:00.000Z",
    openedAt: "2026-07-27T11:40:00.000Z",
    lastSeenAt: "2026-07-27T11:40:00.000Z",
    slaDueAt: "2026-08-26T11:40:00.000Z",
    lastRunId: 500,
    lastRunAttempt: 1,
    tickets: {},
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides
  };
}

function watermark(
  stream: string,
  overrides: Partial<FindingLifecycleStreamWatermark> = {}
): FindingLifecycleStreamWatermark {
  return {
    repositoryId: 20,
    stream,
    runStartedAt: "2026-07-27T11:30:00.000Z",
    runId: 500,
    runAttempt: 1,
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides
  };
}

test("parity: finding lifecycle saves, orders, removes and isolates records", { skip }, async () => {
  const observed = await parity(async (store) => {
    await store.upsertRepository(repository(20));
    await store.upsertRepository(repository(21));
    const fingerprint = (fill: string) => fill.repeat(64);
    const records = [
      lifecycleRecord({ fingerprint: fingerprint("3"), firstSeenAt: "2026-07-25T00:00:00.000Z" }),
      // Same first-seen instant as the next one, so only the fingerprint orders them.
      lifecycleRecord({ fingerprint: fingerprint("b"), firstSeenAt: "2026-07-26T00:00:00.000Z" }),
      lifecycleRecord({ fingerprint: fingerprint("a"), firstSeenAt: "2026-07-26T00:00:00.000Z" }),
      lifecycleRecord({
        fingerprint: fingerprint("1"),
        status: "fixed",
        firstSeenAt: "2026-07-01T00:00:00.000Z",
        fixedAt: "2026-07-20T00:00:00.000Z",
        slaDueAt: undefined,
        path: undefined,
        line: undefined
      }),
      lifecycleRecord({
        fingerprint: fingerprint("2"),
        source: "zap",
        status: "risk-accepted",
        severity: "medium",
        streams: { "zap:nightly:staging": "2026-07-27T11:40:00.000Z" },
        tickets: {
          "github-issues": {
            ref: "42",
            state: "open",
            contentSha: "9".repeat(64),
            updatedAt: "2026-07-27T12:00:00.000Z"
          }
        }
      })
    ];
    await store.saveFindingLifecycle(20, records, [
      watermark("trivy-image"),
      watermark("semgrep"),
      watermark("zap:smoke:staging"),
      watermark("zap:nightly:staging"),
      watermark("trivy"),
      watermark("Trivy-legacy")
    ]);
    await store.saveFindingLifecycle(
      21,
      [lifecycleRecord({ repositoryId: 21, fingerprint: fingerprint("3") })],
      [watermark("semgrep", { repositoryId: 21, runId: 900 })]
    );
    const initial = await store.listFindingLifecycle(20);
    const bounded = await store.listFindingLifecycle(20, 2);
    const streams = await store.listFindingLifecycleStreams(20);

    // An upsert replaces the record and advances one watermark; a removal retires another record.
    await store.saveFindingLifecycle(
      20,
      [
        lifecycleRecord({
          fingerprint: fingerprint("a"),
          status: "fixed",
          fixedAt: "2026-07-28T00:00:00.000Z",
          firstSeenAt: "2026-07-26T00:00:00.000Z",
          streams: {}
        })
      ],
      [watermark("semgrep", { runId: 501, runStartedAt: "2026-07-28T00:00:00.000Z" })],
      [fingerprint("1")]
    );
    let rejected = false;
    try {
      await store.saveFindingLifecycle(20, [lifecycleRecord({ repositoryId: 21 })]);
    } catch {
      rejected = true;
    }
    return {
      initial,
      bounded,
      streams,
      updated: await store.listFindingLifecycle(20),
      updatedStreams: await store.listFindingLifecycleStreams(20),
      isolated: await store.listFindingLifecycle(21),
      isolatedStreams: await store.listFindingLifecycleStreams(21),
      empty: await store.listFindingLifecycle(22),
      rejected
    };
  });

  assert.deepEqual(
    observed.initial.map((record: any) => `${record.status}:${record.fingerprint[0]}`),
    ["open:3", "open:a", "open:b", "fixed:1", "risk-accepted:2"]
  );
  assert.equal(observed.bounded.length, 2);
  assert.deepEqual(
    observed.streams.map((entry: any) => entry.stream),
    ["Trivy-legacy", "semgrep", "trivy", "trivy-image", "zap:nightly:staging", "zap:smoke:staging"]
  );
  assert.deepEqual(
    observed.updated.map((record: any) => `${record.status}:${record.fingerprint[0]}`),
    ["open:3", "open:b", "fixed:a", "risk-accepted:2"]
  );
  assert.equal(
    observed.updatedStreams.find((entry: any) => entry.stream === "semgrep")?.runId,
    501
  );
  assert.equal(observed.isolated.length, 1);
  assert.equal(observed.isolatedStreams[0]?.runId, 900);
  assert.deepEqual(observed.empty, []);
  assert.equal(observed.rejected, true);
});

test("parity: finding lifecycle lock serialises holders for one repository", { skip }, async () => {
  const observed = await parity(async (store) => {
    await store.upsertRepository(repository(20));
    await store.upsertRepository(repository(21));
    const events: string[] = [];
    const first = await store.acquireFindingLifecycleLock(20);
    events.push("first-acquired");
    // Another repository is never blocked by this one's lock.
    const other = await store.acquireFindingLifecycleLock(21);
    events.push("other-acquired");
    await other.release();
    const second = store.acquireFindingLifecycleLock(20).then((lock) => {
      events.push("second-acquired");
      return lock;
    });
    await delay(150);
    events.push("first-releasing");
    await first.release();
    // A second release of the same handle is a no-op rather than releasing another holder.
    await first.release();
    const secondLock = await second;
    await secondLock.release();
    const third = await store.acquireFindingLifecycleLock(20);
    events.push("third-acquired");
    await third.release();
    return events;
  });

  assert.deepEqual(observed, [
    "first-acquired",
    "other-acquired",
    "first-releasing",
    "second-acquired",
    "third-acquired"
  ]);
});

test("parity: review state, feedback, outcomes and activity round trip", { skip }, async () => {
  const observed = await parity(async (store) => {
    await store.upsertRepository(repository(50));
    await store.upsertRepository(repository(51));
    const head = "a".repeat(40);
    const finding = (fingerprint: string) => ({
      fingerprint,
      state: "open" as const,
      firstSeenHeadSha: head,
      lastSeenHeadSha: head,
      firstSeenAt: "2026-07-27T10:00:00.000Z",
      lastSeenAt: "2026-07-27T10:00:00.000Z",
      transitions: 0,
      reappearances: 0,
      path: "src/app.ts",
      startLine: 3,
      endLine: 5,
      category: "authorization",
      severity: "high",
      title: "Missing authorization check"
    });

    await store.saveReviewHead(50, 1, head, 9001);
    const headOnly = await store.getReview(50, 1);
    const saved = await store.saveReview(
      {
        repositoryId: 50,
        pullNumber: 1,
        headSha: head,
        reviewedHeadSha: head,
        placeholderCommentId: 9001,
        findings: [finding("fp-1"), finding("fp-2"), finding("fp-3")],
        findingsEvictedTotal: 2,
        findingsLastEvictedAt: "2026-07-27T10:00:00.000Z",
        feedbackTotal: 0
      },
      head
    );
    const casRejected = await store.saveReview(
      { repositoryId: 50, pullNumber: 1, headSha: "b".repeat(40), findings: [] },
      "c".repeat(40)
    );
    const unfencedLease = await store.saveReview(
      { repositoryId: 50, pullNumber: 1, headSha: head, findings: [] },
      undefined,
      { deliveryId: "missing-delivery", leaseOwner: "worker-1", asOf: "2026-07-27T10:00:00.000Z" }
    );
    await store.enqueueWebhook("delivery-1", "pull_request", { action: "synchronize" });
    const claimedAt = new Date(Date.now() + 1_000);
    await store.claimWebhook("worker-1", 60_000, claimedAt);
    const fenced = await store.saveReview(
      {
        repositoryId: 50,
        pullNumber: 1,
        headSha: head,
        reviewedHeadSha: head,
        placeholderCommentId: 9001,
        findings: [finding("fp-1"), finding("fp-2"), finding("fp-3")],
        findingsEvictedTotal: 1
      },
      head,
      { deliveryId: "delivery-1", leaseOwner: "worker-1", asOf: claimedAt.toISOString() }
    );
    const wrongOwner = await store.saveReview(
      { repositoryId: 50, pullNumber: 1, headSha: head, findings: [] },
      head,
      { deliveryId: "delivery-1", leaseOwner: "worker-2", asOf: claimedAt.toISOString() }
    );

    const feedback = (fingerprint: string, commentId: number, repositoryId = 50, pullNumber = 1) =>
      store.recordFindingFeedback({
        repositoryId,
        pullNumber,
        fingerprint,
        commentId,
        observedAt: new Date("2026-07-27T11:00:00.000Z")
      });
    const feedbackResults = [
      await feedback("fp-1", 100),
      await feedback("fp-1", 100),
      await feedback("fp-1", 101),
      await feedback("fp-missing", 102),
      await feedback("fp-1", 103, 51)
    ];
    const outcomeResults = [
      await store.recordFindingOutcome({
        repositoryId: 50,
        pullNumber: 1,
        outcome: "dismissed",
        fingerprint: "fp-2",
        observedAt: new Date("2026-07-27T12:00:00.000Z")
      }),
      await store.recordFindingOutcome({
        repositoryId: 50,
        pullNumber: 1,
        outcome: "dismissed",
        fingerprint: "fp-2",
        observedAt: new Date("2026-07-27T12:30:00.000Z")
      }),
      await store.recordFindingOutcome({
        repositoryId: 50,
        pullNumber: 1,
        outcome: "ignored",
        observedAt: new Date("2026-07-27T13:00:00.000Z")
      }),
      await store.recordFindingOutcome({
        repositoryId: 50,
        pullNumber: 99,
        outcome: "ignored",
        observedAt: new Date("2026-07-27T13:00:00.000Z")
      })
    ];

    // Activity is ordered by the most recent write, not by pull number: written 3, then 2, then
    // pull 1 is touched again by feedback, so a bounded page keeps the freshest rows.
    for (const pullNumber of [3, 2]) {
      await store.saveReview({
        repositoryId: 50,
        pullNumber,
        headSha: head,
        reviewedHeadSha: head,
        findings: [finding(`fp-pr-${pullNumber}`)]
      });
    }
    await feedback("fp-3", 104);
    await store.saveReview({
      repositoryId: 51,
      pullNumber: 1,
      headSha: head,
      findings: [finding("fp-other")]
    });
    const since = new Date("2020-01-01T00:00:00.000Z");
    return {
      headOnly,
      saved,
      casRejected,
      unfencedLease,
      fenced,
      wrongOwner,
      feedbackResults,
      outcomeResults,
      review: await store.getReview(50, 1),
      missing: await store.getReview(50, 404),
      activity: await store.listReviewActivity(50, since),
      boundedActivity: await store.listReviewActivity(50, since, 2),
      otherActivity: await store.listReviewActivity(51, since)
    };
  });

  assert.equal(observed.headOnly?.findingsSchemaVersion, 1);
  assert.equal(observed.saved, true);
  assert.equal(observed.casRejected, false);
  assert.equal(observed.unfencedLease, false);
  assert.equal(observed.fenced, true);
  assert.equal(observed.wrongOwner, false);
  assert.deepEqual(observed.feedbackResults, [true, false, true, false, false]);
  assert.deepEqual(observed.outcomeResults, [1, 0, 2, 0]);
  assert.equal(observed.review?.findingsEvictedTotal, 3);
  assert.equal(observed.review?.feedbackTotal, 3);
  assert.equal(observed.review?.findingsSchemaVersion, 2);
  assert.equal(observed.missing, undefined);
  assert.deepEqual(
    observed.activity.reviews.map((review: any) => review.pullNumber),
    [1, 2, 3]
  );
  assert.equal(observed.activity.truncated, false);
  assert.deepEqual(
    observed.boundedActivity.reviews.map((review: any) => review.pullNumber),
    [1, 2]
  );
  assert.equal(observed.boundedActivity.truncated, true);
  assert.deepEqual(
    observed.otherActivity.reviews.map((review: any) => review.pullNumber),
    [1]
  );
});
