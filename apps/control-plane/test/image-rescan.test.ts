import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubOidcClaims } from "../src/github-oidc.js";
import {
  createImageRescanTargetService,
  ImageRescanTargetError,
  type ImageRescanRepositoryAuthorization
} from "../src/image-rescan.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const HEAD_SHA = "a".repeat(40);
const DEPLOY_HEAD_SHA = "e".repeat(40);
const IMAGE_SHA = "c".repeat(40);
const DEPLOYED_DIGEST = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "geekyshubham/service";
const REPOSITORY_ID = 99;
const CERTIFICATE_IDENTITY =
  `https://github.com/geekyshubham/guardianbot/.github/workflows/reusable-image.yml@${IMAGE_SHA}`;
const ENVIRONMENT = {
  GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY: "Geekyshubham/guardianbot",
  GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA: IMAGE_SHA
};

function oidc(overrides: Partial<GitHubOidcClaims> = {}): GitHubOidcClaims {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "guardianbot-image-rescan",
    exp: Math.floor(NOW.getTime() / 1_000) + 300,
    iat: Math.floor(NOW.getTime() / 1_000) - 30,
    repository: "Geekyshubham/service",
    repository_id: String(REPOSITORY_ID),
    run_id: "500",
    run_attempt: "1",
    sha: HEAD_SHA,
    ref: "refs/heads/main",
    ref_type: "branch",
    event_name: "schedule",
    workflow_ref:
      "Geekyshubham/service/.github/workflows/guardianbot.yml@refs/heads/main",
    workflow_sha: HEAD_SHA,
    runner_environment: "github-hosted",
    sub: "repo:Geekyshubham/service:environment:guardianbot-image-rescan",
    environment: "guardianbot-image-rescan",
    job_workflow_ref:
      `Geekyshubham/guardianbot/.github/workflows/reusable-image-rescan.yml@${IMAGE_SHA}`,
    job_workflow_sha: IMAGE_SHA,
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    runId: 500,
    runAttempt: 1,
    headSha: HEAD_SHA,
    environment: "staging",
    ...overrides
  };
}

async function seededStore(
  options: { signature?: boolean; certificateIdentity?: string } = {}
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
    headSha: DEPLOY_HEAD_SHA,
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
    runId: 400,
    runAttempt: 1,
    artifactId: 401,
    artifactName: "guardianbot-image-promotion-400-1",
    artifactType: "image-promotion",
    sizeBytes: 1,
    expired: false,
    validationStatus: "accepted"
  });
  if (options.signature !== false) {
    await store.upsertScannerEvidence({
      repositoryId: REPOSITORY_ID,
      runId: 400,
      runAttempt: 1,
      artifactId: 401,
      evidenceKey: "signature",
      kind: "signature",
      source: "cosign",
      status: "success",
      observedAt: "2026-07-26T11:45:00.000Z",
      digest: DEPLOYED_DIGEST,
      payload: {
        imageDigest: DEPLOYED_DIGEST,
        imageReference: `ghcr.io/example/service@${DEPLOYED_DIGEST}`,
        certificateIdentity: options.certificateIdentity ?? CERTIFICATE_IDENTITY
      }
    });
  }
  await store.upsertScannerEvidence({
    repositoryId: REPOSITORY_ID,
    runId: 400,
    runAttempt: 1,
    artifactId: 401,
    evidenceKey: "deployment:staging",
    kind: "deployment",
    source: "digitalocean",
    status: "success",
    observedAt: "2026-07-26T11:50:00.000Z",
    digest: DEPLOYED_DIGEST,
    environment: "staging",
    payload: { origin: "https://staging.example.com" }
  });
  return store;
}

function authorization(): ImageRescanRepositoryAuthorization {
  return { fullName: "Geekyshubham/service", defaultBranch: "main" };
}

async function service(
  claims: GitHubOidcClaims = oidc(),
  store?: MemoryStore
) {
  return createImageRescanTargetService({
    store: store ?? (await seededStore()),
    environment: ENVIRONMENT,
    now: () => NOW,
    oidcVerifier: { verify: async () => claims },
    authorizeRepository: async () => authorization()
  });
}

function rejectsWith(status: number) {
  return (error: unknown) =>
    error instanceof ImageRescanTargetError && error.statusCode === status;
}

test("returns the exact accepted deployed digest and its signing identity", async () => {
  const result = await (await service()).resolve("Bearer github-oidc", request());
  assert.deepEqual(result, {
    schemaVersion: "1.0.0",
    environment: "staging",
    imageDigest: DEPLOYED_DIGEST,
    imageReference: `ghcr.io/example/service@${DEPLOYED_DIGEST}`,
    certificateIdentity: CERTIFICATE_IDENTITY,
    deploymentRunId: 400,
    deploymentRunAttempt: 1,
    deploymentHeadSha: DEPLOY_HEAD_SHA,
    deployedAt: "2026-07-26T11:50:00.000Z"
  });
});

test("fails closed when no accepted signed deployment exists", async () => {
  await assert.rejects(
    async () =>
      (await service()).resolve("Bearer github-oidc", request({ environment: "production" })),
    rejectsWith(404)
  );
  await assert.rejects(
    async () =>
      (await service(oidc(), await seededStore({ signature: false }))).resolve(
        "Bearer github-oidc",
        request()
      ),
    rejectsWith(404)
  );
  await assert.rejects(
    async () =>
      (
        await service(
          oidc(),
          await seededStore({
            certificateIdentity:
              "https://github.com/attacker/fork/.github/workflows/reusable-image.yml@" +
              IMAGE_SHA
          })
        )
      ).resolve("Bearer github-oidc", request()),
    rejectsWith(404)
  );
});

test("accepts only scheduled default-branch runs of the approved rescan workflow", async () => {
  const rejected: Array<Partial<GitHubOidcClaims>> = [
    { event_name: "push" },
    { event_name: "workflow_dispatch" },
    { event_name: "pull_request" },
    { ref: "refs/heads/feature" },
    { runner_environment: "self-hosted" },
    { environment: "guardianbot-dast" },
    { sub: "repo:Geekyshubham/service:ref:refs/heads/main" },
    {
      workflow_ref:
        "Geekyshubham/service/.github/workflows/other.yml@refs/heads/main"
    },
    {
      job_workflow_ref:
        `Geekyshubham/guardianbot/.github/workflows/reusable-image.yml@${IMAGE_SHA}`
    },
    {
      job_workflow_ref:
        `attacker/guardianbot/.github/workflows/reusable-image-rescan.yml@${IMAGE_SHA}`
    },
    { job_workflow_sha: "f".repeat(40) },
    { run_id: "501" },
    { repository_id: "100" },
    { sha: "f".repeat(40) }
  ];
  for (const overrides of rejected) {
    await assert.rejects(
      async () => (await service(oidc(overrides))).resolve("Bearer github-oidc", request()),
      rejectsWith(401),
      JSON.stringify(overrides)
    );
  }
});

test("rejects missing bearer, malformed requests, and inactive repositories", async () => {
  const instance = await service();
  await assert.rejects(() => instance.resolve(undefined, request()), rejectsWith(401));
  await assert.rejects(
    () => instance.resolve("Bearer github-oidc", request({ imageDigest: DEPLOYED_DIGEST })),
    rejectsWith(400)
  );
  await assert.rejects(
    () => instance.resolve("Bearer github-oidc", request({ environment: "Staging!" })),
    rejectsWith(400)
  );
  await assert.rejects(
    () => instance.resolve("Bearer github-oidc", request({ schemaVersion: "2.0.0" })),
    rejectsWith(400)
  );
  const inactive = createImageRescanTargetService({
    store: await seededStore(),
    environment: ENVIRONMENT,
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => undefined
  });
  await assert.rejects(
    () => inactive.resolve("Bearer github-oidc", request()),
    rejectsWith(403)
  );
});

test("a separately pinned rescan workflow SHA replaces the image SHA default", async () => {
  const pinned = "f".repeat(40);
  const pinnedService = createImageRescanTargetService({
    store: await seededStore(),
    environment: { ...ENVIRONMENT, GUARDIANBOT_TRUSTED_IMAGE_RESCAN_WORKFLOW_SHA: pinned },
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => authorization()
  });
  await assert.rejects(
    () => pinnedService.resolve("Bearer github-oidc", request()),
    rejectsWith(401)
  );
  assert.throws(() =>
    createImageRescanTargetService({
      store: new MemoryStore(),
      environment: { GUARDIANBOT_TRUSTED_IMAGE_RESCAN_WORKFLOW_SHA: "main" },
      authorizeRepository: async () => authorization()
    })
  );
});
