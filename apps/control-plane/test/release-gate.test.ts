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

const TEST_TAGS = [
  `guardianbot:repo-id:${REPOSITORY_ID}`,
  `guardianbot:commit:${HEAD_SHA}`,
  "guardianbot:profile:image"
];

function dojoResult(
  findings: DefectDojoReleaseFindings["findings"] = []
): DefectDojoReleaseFindings {
  return {
    product: { id: 7, name: "Geekyshubham/service" },
    engagements: [{ id: 11, name: "main/image", product: 7 }],
    tests: [{ id: 2, engagement: 11, scan_type: "Trivy Scan", tags: TEST_TAGS }],
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

test("requires a deployed-digest DAST rescan only when policy asks for it", async () => {
  const store = await seededStore();
  const env = environment({
    GUARDIANBOT_RELEASE_GATE_POLICY_JSON: JSON.stringify({
      requiredEvidence: ["signature", "image-scan", "sbom", "deployed-rescan"]
    })
  });
  const missing = await service(store, { env }).check("Bearer token", request());
  assert.deepEqual(missing.blockers.map((entry) => entry.code), ["deployed-rescan-missing"]);

  await store.upsertScannerWorkflowRun({
    repositoryId: REPOSITORY_ID,
    runId: 600,
    runAttempt: 1,
    headSha: HEAD_SHA,
    headBranch: "main",
    event: "schedule",
    workflowPath: ".github/workflows/guardianbot.yml",
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: []
  });
  await store.upsertScannerArtifact({
    repositoryId: REPOSITORY_ID,
    runId: 600,
    runAttempt: 1,
    artifactId: 601,
    artifactName: "guardianbot-dast-evidence-600-1",
    artifactType: "dast",
    sizeBytes: 1,
    expired: false,
    validationStatus: "accepted"
  });
  for (const [environmentName, digest] of [
    ["production", DIGEST],
    ["staging", OTHER_DIGEST]
  ] as const) {
    await store.upsertScannerEvidence({
      repositoryId: REPOSITORY_ID,
      runId: 600,
      runAttempt: 1,
      artifactId: 601,
      evidenceKey: `zap-nightly-summary`,
      kind: "zap-nightly",
      source: "zap",
      status: "success",
      observedAt: "2026-08-01T11:30:00.000Z",
      digest,
      environment: environmentName
    });
    const stillMissing = await service(store, { env }).check("Bearer token", request());
    assert.deepEqual(stillMissing.blockers.map((entry) => entry.code), [
      "deployed-rescan-missing"
    ]);
  }
  await store.upsertScannerEvidence({
    repositoryId: REPOSITORY_ID,
    runId: 600,
    runAttempt: 1,
    artifactId: 601,
    evidenceKey: "zap-smoke-summary",
    kind: "zap-smoke",
    source: "zap",
    status: "success",
    observedAt: "2026-08-01T11:40:00.000Z",
    digest: DIGEST,
    environment: "staging"
  });
  const passed = await service(store, { env }).check("Bearer token", request());
  assert.equal(passed.decision, "pass");
  assert.equal(
    passed.evidence.find((entry) => entry.kind === "deployed-rescan")?.ref,
    "evidence://600/1/601/zap-smoke-summary"
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
