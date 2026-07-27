import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import test from "node:test";
import {
  computeEvidenceManifestDigest,
  createEvidenceAttestationService,
  createEvidenceProvenanceToken,
  verifyEvidenceProvenanceToken,
  type EvidenceAttestationRequest,
  type EvidenceArtifactType,
  type EvidenceManifest,
  type EvidenceProvenanceClaims
} from "../src/evidence-attestation.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const SECURITY_SHA = "b".repeat(40);
const IMAGE_SHA = "c".repeat(40);
const DAST_SHA = "d".repeat(40);
const HEAD_SHA = "a".repeat(40);
const SIGNING_SECRET = "guardianbot-attestation-test-secret-".repeat(2);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig"
};
const ENVIRONMENT = {
  GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY: "Geekyshubham/guardianbot",
  GUARDIANBOT_TRUSTED_SECURITY_WORKFLOW_SHA: SECURITY_SHA,
  GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA: IMAGE_SHA,
  GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA: DAST_SHA,
  GUARDIANBOT_EVIDENCE_SIGNING_SECRET: SIGNING_SECRET
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function oidcToken(
  overrides: Record<string, unknown> = {},
  signingKey: KeyObject = privateKey
): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const claims = base64UrlJson({
    iss: "https://token.actions.githubusercontent.com",
    aud: "guardianbot-evidence",
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 30,
    nbf: NOW_SECONDS - 30,
    repository: "Geekyshubham/guardianbot-consumer",
    repository_id: "99",
    run_id: "500",
    run_attempt: "2",
    sha: HEAD_SHA,
    sub: "repo:Geekyshubham/guardianbot-consumer:ref:refs/heads/main",
    job_workflow_ref:
      `Geekyshubham/guardianbot/.github/workflows/reusable-security.yml@${SECURITY_SHA}`,
    job_workflow_sha: SECURITY_SHA,
    ...overrides
  });
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`, "utf8"),
    signingKey
  ).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function request(
  artifactType: EvidenceArtifactType = "security",
  overrides: Partial<EvidenceAttestationRequest> = {}
): EvidenceAttestationRequest {
  return {
    schemaVersion: "1.0.0",
    artifactType,
    manifestDigest: `sha256:${"1".repeat(64)}`,
    repository: "geekyshubham/guardianbot-consumer",
    repositoryId: 99,
    runId: 500,
    runAttempt: 2,
    headSha: HEAD_SHA,
    ...overrides
  };
}

function service() {
  let jwksRequests = 0;
  return {
    service: createEvidenceAttestationService({
      environment: ENVIRONMENT,
      now: () => NOW,
      fetchImpl: (async () => {
        jwksRequests += 1;
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      authorizeRepository: async (repository, repositoryId) =>
        repository === "geekyshubham/guardianbot-consumer" &&
        repositoryId === 99
    }),
    jwksRequests: () => jwksRequests
  };
}

test("verifies GitHub RS256 OIDC and returns a manifest-bound HMAC token", async () => {
  const instance = service();
  const response = await instance.service.attest(
    `Bearer ${oidcToken()}`,
    request()
  );
  const claims = verifyEvidenceProvenanceToken(
    response.token,
    SIGNING_SECRET,
    NOW
  );
  assert.equal(claims.artifactType, "security");
  assert.equal(claims.manifestDigest, request().manifestDigest);
  assert.equal(claims.workflowSha, SECURITY_SHA);
  assert.equal(
    claims.jobWorkflowRef,
    `geekyshubham/guardianbot/.github/workflows/reusable-security.yml@${SECURITY_SHA}`
  );
  assert.equal(instance.jwksRequests(), 1);
});

test("rejects a forged OIDC signature", async () => {
  const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    () =>
      service().service.attest(
        `Bearer ${oidcToken({}, attacker.privateKey)}`,
        request()
      ),
    /signature/i
  );
});

test("rejects expired GitHub OIDC and expired provenance tokens", async () => {
  await assert.rejects(
    () =>
      service().service.attest(
        `Bearer ${oidcToken({ exp: NOW_SECONDS - 31, iat: NOW_SECONDS - 300 })}`,
        request()
      ),
    /expired|claims/i
  );
  const claims: EvidenceProvenanceClaims = {
    version: 1,
    artifactType: "security",
    manifestDigest: request().manifestDigest,
    repository: request().repository,
    repositoryId: 99,
    runId: 500,
    runAttempt: 2,
    headSha: HEAD_SHA,
    jobWorkflowRef:
      `geekyshubham/guardianbot/.github/workflows/reusable-security.yml@${SECURITY_SHA}`,
    workflowPath: ".github/workflows/reusable-security.yml",
    workflowSha: SECURITY_SHA,
    issuedAt: NOW_SECONDS - 120,
    expiresAt: NOW_SECONDS - 1
  };
  assert.throws(
    () =>
      verifyEvidenceProvenanceToken(
        createEvidenceProvenanceToken(claims, SIGNING_SECRET),
        SIGNING_SECRET,
        NOW
      ),
    /expired/
  );
});

test("rejects the wrong reusable workflow path for an artifact type", async () => {
  await assert.rejects(
    () =>
      service().service.attest(
        `Bearer ${oidcToken({
          job_workflow_ref:
            `Geekyshubham/guardianbot/.github/workflows/reusable-image.yml@${IMAGE_SHA}`,
          job_workflow_sha: IMAGE_SHA
        })}`,
        request("security")
      ),
    /not an approved GuardianBot release/i
  );
});

test("rejects an unapproved reusable workflow SHA", async () => {
  const wrongSha = "e".repeat(40);
  await assert.rejects(
    () =>
      service().service.attest(
        `Bearer ${oidcToken({
          job_workflow_ref:
            `Geekyshubham/guardianbot/.github/workflows/reusable-security.yml@${wrongSha}`,
          job_workflow_sha: wrongSha
        })}`,
        request()
      ),
    /not an approved GuardianBot release/i
  );
});

test("binds image promotion to its protected job environment", async () => {
  const imageClaims = {
    job_workflow_ref:
      `Geekyshubham/guardianbot/.github/workflows/reusable-image.yml@${IMAGE_SHA}`,
    job_workflow_sha: IMAGE_SHA
  };
  await assert.rejects(
    () =>
      service().service.attest(
        `Bearer ${oidcToken(imageClaims)}`,
        request("image-promotion")
      ),
    /environment is not authorized/i
  );
  const response = await service().service.attest(
    `Bearer ${oidcToken({
      ...imageClaims,
      environment: "guardianbot-image-promotion",
      sub:
        "repo:Geekyshubham/guardianbot-consumer:" +
        "environment:guardianbot-image-promotion"
    })}`,
    request("image-promotion")
  );
  assert.equal(
    verifyEvidenceProvenanceToken(response.token, SIGNING_SECRET, NOW)
      .artifactType,
    "image-promotion"
  );
});

test("a token for one canonical manifest cannot authenticate a changed manifest", () => {
  const manifest: EvidenceManifest = {
    schemaVersion: "1.0.0",
    artifactType: "security",
    repository: "geekyshubham/guardianbot-consumer",
    repositoryId: 99,
    runId: 500,
    runAttempt: 2,
    headSha: HEAD_SHA,
    workflowPath: ".github/workflows/reusable-security.yml",
    workflowSha: SECURITY_SHA,
    files: [
      { path: "gate.json", sha256: "1".repeat(64), size: 10 }
    ]
  };
  const changed: EvidenceManifest = {
    ...manifest,
    files: [{ ...manifest.files[0]!, sha256: "2".repeat(64) }]
  };
  assert.notEqual(
    computeEvidenceManifestDigest(manifest),
    computeEvidenceManifestDigest(changed)
  );
});
