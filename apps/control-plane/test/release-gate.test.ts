import assert from "node:assert/strict";
import test from "node:test";
import type { DefectDojoReleaseFindings } from "@guardianbot/defectdojo";
import type { GitHubOidcClaims } from "../src/github-oidc.js";
import {
  createReleaseGateEvaluator,
  createReleaseGateService,
  ReleaseGateError,
  type ReleaseGateDefectDojoReader
} from "../src/release-gate.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "c".repeat(40);
const GATE_SHA = "9".repeat(40);
const IMAGE_SHA = "f".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"e".repeat(64)}`;
const REPOSITORY = "geekyshubham/service";
const REPOSITORY_ID = 99;
const IDENTITY =
  `https://github.com/geekyshubham/guardianbot/.github/workflows/reusable-image.yml@${IMAGE_SHA}`;

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY: "Geekyshubham/guardianbot",
    GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA: GATE_SHA,
    GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA: IMAGE_SHA,
    ...overrides
  };
}

function oidc(overrides: Partial<GitHubOidcClaims> = {}): GitHubOidcClaims {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "guardianbot-release-gate",
    exp: Math.floor(NOW.getTime() / 1_000) + 300,
    iat: Math.floor(NOW.getTime() / 1_000) - 30,
    repository: "Geekyshubham/service",
    repository_id: String(REPOSITORY_ID),
    run_id: "700",
    run_attempt: "1",
    sha: HEAD_SHA,
    ref: "refs/heads/main",
    ref_type: "branch",
    event_name: "workflow_dispatch",
    workflow_ref: "Geekyshubham/service/.github/workflows/guardianbot.yml@refs/heads/main",
    workflow_sha: HEAD_SHA,
    runner_environment: "github-hosted",
    sub: "repo:Geekyshubham/service:environment:guardianbot-release-gate",
    environment: "guardianbot-release-gate",
    job_workflow_ref:
      `Geekyshubham/guardianbot/.github/workflows/reusable-release-gate.yml@${GATE_SHA}`,
    job_workflow_sha: GATE_SHA,
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    runId: 700,
    runAttempt: 1,
    headSha: HEAD_SHA,
    imageDigest: DIGEST,
    environment: "staging",
    ...overrides
  };
}

function testTags(profile: string, extra: string[] = []): string[] {
  return [
    `guardianbot:repo-id:${REPOSITORY_ID}`,
    `guardianbot:commit:${HEAD_SHA}`,
    `guardianbot:profile:${profile}`,
    ...extra
  ];
}

function dojoResult(
  findings: DefectDojoReleaseFindings["findings"] = []
): DefectDojoReleaseFindings {
  return {
    product: { id: 7, name: "Geekyshubham/service" },
    engagements: [
      { id: 10, name: "main/security", product: 7 },
      { id: 11, name: "main/image", product: 7 },
      { id: 12, name: "main/dast", product: 7 }
    ],
    tests: [
      { id: 1, engagement: 10, scan_type: "Semgrep JSON Report", tags: testTags("security") },
      { id: 2, engagement: 11, scan_type: "Trivy Scan", tags: testTags("image") },
      {
        id: 3,
        engagement: 12,
        scan_type: "ZAP Scan",
        tags: testTags("dast", [`guardianbot:image:${DIGEST}`, "guardianbot:env:staging"])
      }
    ],
    findings,
    acceptedFindings: []
  };
}

async function seededStore(
  options: {
    headSha?: string;
    event?: "push" | "pull_request";
    artifactStatus?: "accepted" | "rejected";
    certificateIdentity?: string;
    criticalFindings?: unknown;
    withSbom?: boolean;
  } = {}
): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 1,
    repositoryId: REPOSITORY_ID,
    fullName: "Geekyshubham/service",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "report-only",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  await store.upsertScannerWorkflowRun({
    repositoryId: REPOSITORY_ID,
    runId: 400,
    runAttempt: 1,
    headSha: options.headSha ?? HEAD_SHA,
    headBranch: "main",
    event: options.event ?? "push",
    workflowPath: ".github/workflows/guardianbot.yml",
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: []
  });
  await store.upsertScannerArtifact({
    repositoryId: REPOSITORY_ID,
    runId: 400,
    runAttempt: 1,
    artifactId: 401,
    artifactName: "guardianbot-image-promotion-400-1",
    artifactType: "image-promotion",
    sizeBytes: 1,
    expired: false,
    validationStatus: options.artifactStatus ?? "accepted"
  });
  const base = { repositoryId: REPOSITORY_ID, runId: 400, runAttempt: 1, artifactId: 401 };
  await store.upsertScannerEvidence({
    ...base,
    evidenceKey: "image-trivy-summary",
    kind: "trivy",
    source: "trivy",
    status: "success",
    observedAt: "2026-08-01T11:00:00.000Z",
    payload: { criticalFindings: options.criticalFindings ?? 0 }
  });
  if (options.withSbom !== false) {
    await store.upsertScannerEvidence({
      ...base,
      evidenceKey: "sbom",
      kind: "sbom",
      source: "trivy",
      status: "success",
      observedAt: "2026-08-01T11:00:00.000Z"
    });
  }
  await store.upsertScannerEvidence({
    ...base,
    evidenceKey: "signature",
    kind: "signature",
    source: "cosign",
    status: "success",
    observedAt: "2026-08-01T11:01:00.000Z",
    digest: DIGEST,
    payload: {
      imageDigest: DIGEST,
      imageReference: `ghcr.io/geekyshubham/service@${DIGEST}`,
      certificateIdentity: options.certificateIdentity ?? IDENTITY,
      signatures: 1,
      sbomAttestations: 1
    }
  });
  return store;
}

function service(
  store: MemoryStore,
  options: {
    claims?: GitHubOidcClaims;
    reader?: ReleaseGateDefectDojoReader;
    env?: Record<string, string | undefined>;
  } = {}
) {
  return createReleaseGateService({
    store,
    environment: options.env ?? environment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => options.claims ?? oidc() },
    defectDojoReader: options.reader ?? (async () => dojoResult()),
    authorizeRepository: async () => ({ fullName: "Geekyshubham/service", defaultBranch: "main" }),
    fetchImpl: (async () => {
      throw new Error("must not call the network");
    }) as typeof fetch
  });
}

test("passes an exact signed, Critical-clean digest with an in-scope DefectDojo import", async () => {
  const calls: unknown[] = [];
  const decision = await service(await seededStore(), {
    reader: async (input) => {
      calls.push(input);
      return dojoResult();
    }
  }).check("Bearer token", request());
  assert.equal(decision.decision, "pass");
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.expectedCertificateIdentity, IDENTITY);
  assert.deepEqual(
    decision.evidence.map((entry) => entry.ref),
    [
      "evidence://400/1/401/signature",
      "evidence://400/1/401/image-trivy-summary",
      "evidence://400/1/401/sbom",
      "defectdojo://products/7"
    ]
  );
  assert.deepEqual(calls, [
    {
      productName: "Geekyshubham/service",
      engagementNames: ["main/security", "main/image", "main/dast"],
      verifiedOnly: true
    }
  ]);
});

test("fails an unsigned digest, wrong commit, or rejected promotion artifact", async () => {
  const otherDigest = await service(await seededStore()).check(
    "Bearer token",
    request({ imageDigest: OTHER_DIGEST })
  );
  assert.deepEqual(otherDigest.blockers.map((entry) => entry.code), [
    "unsigned-digest",
    "image-scan-missing",
    "sbom-missing"
  ]);
  for (const store of [
    await seededStore({ headSha: OTHER_SHA }),
    await seededStore({ event: "pull_request" }),
    await seededStore({ artifactStatus: "rejected" })
  ]) {
    const decision = await service(store).check("Bearer token", request());
    assert.equal(decision.decision, "fail");
    assert.equal(decision.blockers[0]?.code, "unsigned-digest");
  }
});

test("fails the wrong signer, a malformed Critical count, and a missing SBOM", async () => {
  const wrong = await service(
    await seededStore({ certificateIdentity: IDENTITY.replace(IMAGE_SHA, OTHER_SHA) })
  ).check("Bearer token", request());
  assert.deepEqual(wrong.blockers.map((entry) => entry.code), ["wrong-signer"]);
  const malformed = await service(await seededStore({ criticalFindings: "0" })).check(
    "Bearer token",
    request()
  );
  assert.deepEqual(malformed.blockers.map((entry) => entry.code), ["image-scan-critical"]);
  const noSbom = await service(await seededStore({ withSbom: false })).check(
    "Bearer token",
    request()
  );
  assert.deepEqual(noSbom.blockers.map((entry) => entry.code), ["sbom-missing"]);
});

test("blocks an active Critical finding and fails closed when DefectDojo is unavailable", async () => {
  const blocked = await service(await seededStore(), {
    reader: async () =>
      dojoResult([
        { id: 500, test: 2, severity: "Critical", active: true, verified: true }
      ])
  }).check("Bearer token", request());
  assert.equal(blocked.decision, "fail");
  assert.equal(blocked.blockers[0]?.findingId, 500);

  const failing = await service(await seededStore(), {
    reader: async () => {
      throw new Error("https://dojo.internal/api secret detail");
    }
  }).check("Bearer token", request());
  assert.deepEqual(failing.blockers.map((entry) => entry.code), ["gate-unavailable"]);
  assert.doesNotMatch(JSON.stringify(failing), /dojo\.internal|secret detail/);

  const noProduct = await service(await seededStore(), {
    reader: async () => ({ ...dojoResult(), product: null })
  }).check("Bearer token", request());
  assert.deepEqual(noProduct.blockers.map((entry) => entry.code), ["gate-unavailable"]);

  const unconfigured = await createReleaseGateService({
    store: await seededStore(),
    environment: environment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => ({ fullName: "Geekyshubham/service", defaultBranch: "main" })
  }).check("Bearer token", request());
  assert.deepEqual(unconfigured.blockers.map((entry) => entry.code), ["gate-unavailable"]);
});

test("rejects tokens whose OIDC identity does not match the release-gate contract", async () => {
  const store = await seededStore();
  const cases: Partial<GitHubOidcClaims>[] = [
    { repository: "Geekyshubham/other" },
    { repository_id: "100" },
    { run_id: "701" },
    { run_attempt: "2" },
    { sha: OTHER_SHA },
    { workflow_sha: OTHER_SHA },
    { ref: "refs/heads/feature" },
    { event_name: "pull_request" },
    { event_name: "push" },
    { runner_environment: "self-hosted" },
    { workflow_ref: "Geekyshubham/service/.github/workflows/other.yml@refs/heads/main" },
    {
      job_workflow_ref:
        `Geekyshubham/guardianbot/.github/workflows/reusable-dast.yml@${GATE_SHA}`
    },
    {
      job_workflow_ref:
        `Attacker/guardianbot/.github/workflows/reusable-release-gate.yml@${GATE_SHA}`
    },
    {
      job_workflow_ref:
        `Geekyshubham/guardianbot/.github/workflows/reusable-release-gate.yml@${OTHER_SHA}`,
      job_workflow_sha: OTHER_SHA
    },
    { environment: "guardianbot-dast" },
    { sub: "repo:Geekyshubham/service:ref:refs/heads/main" }
  ];
  for (const overrides of cases) {
    await assert.rejects(
      () => service(store, { claims: oidc(overrides) }).check("Bearer token", request()),
      (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 401,
      JSON.stringify(overrides)
    );
  }
});

test("rejects malformed requests, missing bearer, inactive repositories, and missing config", async () => {
  const store = await seededStore();
  await assert.rejects(
    () => service(store).check(undefined, request()),
    (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 401
  );
  for (const bad of [
    request({ imageDigest: "latest" }),
    request({ environment: "Prod!" }),
    request({ headSha: "abc" }),
    request({ aiApproval: true }),
    request({ schemaVersion: "2.0.0" })
  ]) {
    await assert.rejects(
      () => service(store).check("Bearer token", bad),
      (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 400
    );
  }
  await assert.rejects(
    () =>
      createReleaseGateService({
        store,
        environment: environment(),
        now: () => NOW,
        oidcVerifier: { verify: async () => oidc() },
        authorizeRepository: async () => undefined
      }).check("Bearer token", request()),
    (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 403
  );
  await assert.rejects(
    () =>
      service(store, {
        env: { GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA: IMAGE_SHA }
      }).check("Bearer token", request()),
    (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 503
  );
  await assert.rejects(
    () =>
      service(store, {
        env: environment({ GUARDIANBOT_RELEASE_GATE_POLICY_JSON: '{"blockingSeverities":[]}' })
      }).check("Bearer token", request()),
    (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 503
  );
});

test("the gate reads deployed-digest coverage, the candidate freeze, and commit summaries from the store", async () => {
  const store = await seededStore();
  const lookups: unknown[][] = [];
  const rescan = (digest: string, environmentName: string, frozen: boolean) => ({
    repositoryId: REPOSITORY_ID,
    runId: 600,
    runAttempt: 1,
    artifactId: 601,
    imageDigest: digest,
    environment: environmentName,
    observedAt: "2026-08-01T03:00:00.000Z",
    criticalFindings: frozen ? 1 : 0,
    frozen,
    artifactAccepted: true
  });
  let deployed: string | undefined = OTHER_DIGEST;
  let candidateFrozen = false;
  store.getLatestDeployedImageEvidence = (async (...args: unknown[]) => {
    lookups.push(["deployed", ...args]);
    return deployed ? ({ imageDigest: deployed } as never) : undefined;
  }) as MemoryStore["getLatestDeployedImageEvidence"];
  store.getLatestImageRescanEvidence = (async (...args: unknown[]) => {
    lookups.push(["rescan", ...args]);
    const [, digest, , environmentName] = args as [number, string, string, string | undefined];
    if (digest === DIGEST) return candidateFrozen ? rescan(DIGEST, "production", true) : undefined;
    return environmentName === "staging" ? rescan(digest, "staging", true) : undefined;
  }) as MemoryStore["getLatestImageRescanEvidence"];
  const env = environment({
    GUARDIANBOT_RELEASE_GATE_POLICY_JSON: JSON.stringify({
      requiredEvidence: ["signature", "image-scan", "sbom", "deployed-rescan"]
    })
  });

  // The deployed digest is frozen, but it has fresh coverage, and replacing it is the fix path.
  const covered = await service(store, { env }).check("Bearer token", request());
  assert.equal(covered.decision, "pass");
  assert.equal(
    covered.evidence.find((entry) => entry.kind === "deployed-rescan")?.ref,
    "evidence://600/1/601/image-rescan:staging"
  );
  assert.deepEqual(lookups, [
    ["rescan", REPOSITORY_ID, DIGEST, "main"],
    ["deployed", REPOSITORY_ID, "staging", "main"],
    ["rescan", REPOSITORY_ID, OTHER_DIGEST, "main", "staging"]
  ]);

  // Without the coverage requirement, the deployed digest is never looked up.
  lookups.length = 0;
  assert.equal((await service(store).check("Bearer token", request())).decision, "pass");
  assert.deepEqual(lookups, [["rescan", REPOSITORY_ID, DIGEST, "main"]]);

  // A deployed digest without a rescan blocks; nothing deployed yet does not.
  store.getLatestImageRescanEvidence = (async () => undefined) as MemoryStore["getLatestImageRescanEvidence"];
  assert.deepEqual(
    (await service(store, { env }).check("Bearer token", request())).blockers.map((entry) => entry.code),
    ["deployed-rescan-missing"]
  );
  deployed = undefined;
  assert.equal((await service(store, { env }).check("Bearer token", request())).decision, "pass");

  // The candidate's own freeze blocks under every policy.
  candidateFrozen = true;
  store.getLatestImageRescanEvidence = (async (_id: number, digest: string) =>
    digest === DIGEST ? rescan(DIGEST, "production", true) : undefined) as MemoryStore["getLatestImageRescanEvidence"];
  assert.deepEqual(
    (await service(store).check("Bearer token", request())).blockers.map((entry) => entry.code),
    ["promotion-frozen"]
  );

  // A store failure is unavailable, never a pass.
  store.getLatestImageRescanEvidence = (async () => {
    throw new Error("database unavailable");
  }) as MemoryStore["getLatestImageRescanEvidence"];
  await assert.rejects(
    () => service(store).check("Bearer token", request()),
    (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 503
  );
});

test("a clean commit summary passes a candidate whose SAST Test was reimported for a newer commit", async () => {
  const store = await seededStore();
  const stale = dojoResult();
  stale.tests[0] = {
    ...stale.tests[0]!,
    tags: testTags("security").map((tag) =>
      tag === `guardianbot:commit:${HEAD_SHA}` ? `guardianbot:commit:${OTHER_SHA}` : tag
    )
  };
  const reader = async () => stale;
  assert.deepEqual(
    (await service(store, { reader }).check("Bearer token", request())).blockers.map((entry) => [
      entry.code,
      entry.source
    ]),
    [["defectdojo-scope-missing", "sast"]]
  );
  await store.upsertScannerWorkflowRun({
    repositoryId: REPOSITORY_ID,
    runId: 410,
    runAttempt: 1,
    headSha: HEAD_SHA,
    headBranch: "main",
    event: "push",
    workflowPath: ".github/workflows/guardianbot.yml",
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: []
  });
  await store.upsertScannerArtifact({
    repositoryId: REPOSITORY_ID,
    runId: 410,
    runAttempt: 1,
    artifactId: 411,
    artifactName: "guardianbot-evidence-410-1",
    artifactType: "security",
    sizeBytes: 1,
    expired: false,
    validationStatus: "accepted"
  });
  const clean = { critical: 0, high: 2, medium: 0, low: 0, info: 0 };
  for (const kind of ["semgrep", "trivy"] as const) {
    await store.upsertScannerEvidence({
      repositoryId: REPOSITORY_ID,
      runId: 410,
      runAttempt: 1,
      artifactId: 411,
      evidenceKey: `${kind}-summary`,
      kind,
      source: kind,
      status: "success",
      observedAt: "2026-08-01T10:00:00.000Z",
      payload: { ...clean, releaseSeverities: clean }
    });
  }
  const passed = await service(store, { reader }).check("Bearer token", request());
  assert.equal(passed.decision, "pass");
  assert.equal(
    passed.evidence.find((entry) => entry.kind === "commit-scan")?.ref,
    "evidence://410/1/411/semgrep-summary"
  );
  // The same summary does not prove a policy that blocks High.
  const strict = environment({ GUARDIANBOT_RELEASE_GATE_POLICY_JSON: '{"blockHigh":true}' });
  assert.equal(
    (await service(store, { reader, env: strict }).check("Bearer token", request())).decision,
    "fail"
  );
});

test("evaluator configuration errors surface as unavailable, not pass", async () => {
  const evaluator = createReleaseGateEvaluator({
    store: new MemoryStore(),
    environment: {},
    now: () => NOW
  });
  await assert.rejects(
    () =>
      evaluator.evaluate({
        candidate: {
          repository: REPOSITORY,
          repositoryId: REPOSITORY_ID,
          commit: HEAD_SHA,
          digest: DIGEST,
          environment: "staging"
        },
        productName: "Geekyshubham/service",
        defaultBranch: "main",
        evidence: {}
      }),
    (error: unknown) => error instanceof ReleaseGateError && error.statusCode === 503
  );
});
