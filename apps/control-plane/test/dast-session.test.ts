import assert from "node:assert/strict";
import test from "node:test";
import {
  createDastSessionService,
  DastSessionError,
  type DastSessionRepositoryAuthorization
} from "../src/dast-session.js";
import type { GitHubOidcClaims } from "../src/github-oidc.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const HEAD_SHA = "a".repeat(40);
const DAST_SHA = "d".repeat(40);
const DEPLOYED_DIGEST = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "geekyshubham/service";
const REPOSITORY_ID = 99;

function oidc(overrides: Partial<GitHubOidcClaims> = {}): GitHubOidcClaims {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "guardianbot-dast-session",
    exp: Math.floor(NOW.getTime() / 1_000) + 300,
    iat: Math.floor(NOW.getTime() / 1_000) - 30,
    repository: "Geekyshubham/service",
    repository_id: String(REPOSITORY_ID),
    run_id: "500",
    run_attempt: "2",
    sha: HEAD_SHA,
    ref: "refs/heads/main",
    ref_type: "branch",
    event_name: "schedule",
    workflow_ref:
      "Geekyshubham/service/.github/workflows/guardianbot.yml@refs/heads/main",
    workflow_sha: HEAD_SHA,
    runner_environment: "github-hosted",
    sub: "repo:Geekyshubham/service:environment:guardianbot-dast",
    environment: "guardianbot-dast",
    job_workflow_ref:
      `Geekyshubham/guardianbot/.github/workflows/reusable-dast.yml@${DAST_SHA}`,
    job_workflow_sha: DAST_SHA,
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    profileRef: "control-plane://profiles/service-staging",
    origin: "https://staging.example.com",
    sessionAssertionPath: "/api/session",
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    runId: 500,
    runAttempt: 2,
    headSha: HEAD_SHA,
    ...overrides
  };
}

function exchangeEnvironment(): Record<string, string> {
  return {
    GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY: "Geekyshubham/guardianbot",
    GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA: DAST_SHA,
    DAST_EXCHANGE_TOKEN: "exchange-secret-value",
    GUARDIANBOT_DAST_PROFILES_JSON: JSON.stringify({
      "service-staging": {
        mode: "exchange",
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        origin: "https://staging.example.com",
        deploymentEnvironment: "staging",
        sessionAssertionPath: "/api/session",
        headerName: "Cookie",
        ttlSeconds: 300,
        exchangeUrl: "https://staging.example.com/_guardianbot/dast-session",
        exchangeCredentialEnv: "DAST_EXCHANGE_TOKEN"
      }
    })
  };
}

async function seededStore(): Promise<MemoryStore> {
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
    headSha: HEAD_SHA,
    headBranch: "main",
    event: "push",
    startedAt: "2026-07-27T11:30:00.000Z",
    completedAt: "2026-07-27T11:45:00.000Z",
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
  await store.upsertScannerEvidence({
    repositoryId: REPOSITORY_ID,
    runId: 400,
    runAttempt: 1,
    artifactId: 401,
    artifactType: "image-promotion",
    evidenceKey: "deployment:staging",
    kind: "deployment",
    source: "digitalocean",
    status: "success",
    observedAt: "2026-07-27T11:45:00.000Z",
    digest: DEPLOYED_DIGEST,
    environment: "staging",
    payload: { origin: "https://staging.example.com" }
  });
  return store;
}

function repositoryAuthorization(): DastSessionRepositoryAuthorization {
  return { fullName: "Geekyshubham/service", defaultBranch: "main" };
}

test("exchanges and returns one run-scoped session exactly once", async () => {
  const store = await seededStore();
  let exchangeCalls = 0;
  const service = createDastSessionService({
    store,
    environment: exchangeEnvironment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async (_url, init) => {
      exchangeCalls += 1;
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        "Bearer exchange-secret-value"
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.deploymentEnvironment, "staging");
      assert.equal(body.deployedDigest, DEPLOYED_DIGEST);
      return Response.json({
        schemaVersion: "1.0.0",
        credential: "session=short-lived",
        expiresAt: new Date(NOW.getTime() + 240_000).toISOString()
      });
    }) as typeof fetch
  });

  const result = await service.issue("Bearer github-oidc", request());
  assert.deepEqual(result, {
    schemaVersion: "1.0.0",
    origin: "https://staging.example.com",
    deploymentEnvironment: "staging",
    deployedDigest: DEPLOYED_DIGEST,
    sessionAssertionPath: "/api/session",
    headerName: "Cookie",
    headerValue: "session=short-lived",
    expiresAt: new Date(NOW.getTime() + 240_000).toISOString(),
    assurance: "target-exchanged"
  });
  assert.equal(exchangeCalls, 1);
  await assert.rejects(
    () => service.issue("Bearer github-oidc", request()),
    (error: unknown) =>
      error instanceof DastSessionError && error.statusCode === 409
  );
  assert.equal(exchangeCalls, 1);
});

test("accepts a full-TTL credential minted after exchange network latency", async () => {
  const store = await seededStore();
  const responseReceivedAt = new Date(NOW.getTime() + 5_000);
  const expiresAt = new Date(responseReceivedAt.getTime() + 300_000);
  let clockReads = 0;
  const service = createDastSessionService({
    store,
    environment: exchangeEnvironment(),
    now: () => {
      clockReads += 1;
      return clockReads === 1 ? NOW : responseReceivedAt;
    },
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async () =>
      Response.json({
        schemaVersion: "1.0.0",
        credential: "session=full-ttl",
        expiresAt: expiresAt.toISOString()
      })) as typeof fetch
  });

  const result = await service.issue("Bearer github-oidc", request());
  assert.equal(result.headerValue, "session=full-ttl");
  assert.equal(result.expiresAt, expiresAt.toISOString());
  assert.equal(clockReads, 2);
});

test("rejects repository input or workflow identity that differs from the profile", async () => {
  const service = createDastSessionService({
    store: await seededStore(),
    environment: exchangeEnvironment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async () => {
      throw new Error("must not exchange");
    }) as typeof fetch
  });

  await assert.rejects(
    () =>
      service.issue(
        "Bearer github-oidc",
        request({ origin: "https://other.example.com" })
      ),
    (error: unknown) =>
      error instanceof DastSessionError && error.statusCode === 403
  );

  const wrongWorkflow = createDastSessionService({
    store: await seededStore(),
    environment: exchangeEnvironment(),
    now: () => NOW,
    oidcVerifier: {
      verify: async () => oidc({ job_workflow_sha: "e".repeat(40) })
    },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async () => {
      throw new Error("must not exchange");
    }) as typeof fetch
  });
  await assert.rejects(
    () => wrongWorkflow.issue("Bearer github-oidc", request()),
    (error: unknown) =>
      error instanceof DastSessionError && error.statusCode === 401
  );
});

test("rejects DAST before credential exchange unless exact-head deployment evidence exists", async () => {
  const store = await seededStore();
  await store.upsertScannerWorkflowRun({
    repositoryId: REPOSITORY_ID,
    runId: 400,
    runAttempt: 1,
    headSha: "c".repeat(40),
    headBranch: "main",
    event: "push",
    workflowPath: ".github/workflows/guardianbot.yml",
    conclusion: "success",
    status: "completed",
    validationStatus: "accepted",
    referencedWorkflows: []
  });
  let exchangeCalls = 0;
  const service = createDastSessionService({
    store,
    environment: exchangeEnvironment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async () => {
      exchangeCalls += 1;
      throw new Error("must not exchange");
    }) as typeof fetch
  });
  await assert.rejects(
    () => service.issue("Bearer github-oidc", request()),
    (error: unknown) =>
      error instanceof DastSessionError && error.statusCode === 403
  );
  assert.equal(exchangeCalls, 0);
});

test("rejects push-triggered DAST even when deployment evidence exists", async () => {
  const service = createDastSessionService({
    store: await seededStore(),
    environment: exchangeEnvironment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc({ event_name: "push" }) },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async () => {
      throw new Error("must not exchange");
    }) as typeof fetch
  });
  await assert.rejects(
    () => service.issue("Bearer github-oidc", request()),
    (error: unknown) =>
      error instanceof DastSessionError && error.statusCode === 401
  );
});

test("releases a failed exchange lease so the same attempt can retry", async () => {
  const store = await seededStore();
  let fail = true;
  const service = createDastSessionService({
    store,
    environment: exchangeEnvironment(),
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => repositoryAuthorization(),
    fetchImpl: (async () => {
      if (fail) {
        fail = false;
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        schemaVersion: "1.0.0",
        credential: "session=retried",
        expiresAt: new Date(NOW.getTime() + 120_000).toISOString()
      });
    }) as typeof fetch
  });

  await assert.rejects(
    () => service.issue("Bearer github-oidc", request()),
    (error: unknown) =>
      error instanceof DastSessionError && error.statusCode === 502
  );
  assert.equal(
    (await service.issue("Bearer github-oidc", request())).headerValue,
    "session=retried"
  );
});

test("static credentials are explicit PoC-only and report lower assurance", async () => {
  const baseProfile = {
    mode: "static",
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    origin: "https://staging.example.com",
    deploymentEnvironment: "staging",
    sessionAssertionPath: "/api/session",
    headerName: "Authorization",
    ttlSeconds: 300,
    credentialEnv: "DAST_STATIC_TOKEN",
    credentialExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    pocStaticCredential: true
  };
  assert.throws(
    () =>
      createDastSessionService({
        store: new MemoryStore(),
        environment: {
          GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA: DAST_SHA,
          DAST_STATIC_TOKEN: "Bearer poc-session",
          GUARDIANBOT_DAST_PROFILES_JSON: JSON.stringify({
            "service-staging": baseProfile
          })
        },
        authorizeRepository: async () => repositoryAuthorization()
      }),
    /PoC-only authorization/
  );

  const service = createDastSessionService({
    store: await seededStore(),
    environment: {
      GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA: DAST_SHA,
      GUARDIANBOT_ALLOW_POC_STATIC_DAST: "1",
      DAST_STATIC_TOKEN: "Bearer poc-session",
      GUARDIANBOT_DAST_PROFILES_JSON: JSON.stringify({
        "service-staging": baseProfile
      })
    },
    now: () => NOW,
    oidcVerifier: { verify: async () => oidc() },
    authorizeRepository: async () => repositoryAuthorization()
  });
  const result = await service.issue("Bearer github-oidc", request());
  assert.equal(result.assurance, "poc-static");
  assert.equal(result.headerValue, "Bearer poc-session");
  assert.equal(result.expiresAt, new Date(NOW.getTime() + 300_000).toISOString());
});
