import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  BackendError,
  GuardianReviewClient,
  ProtocolValidationError,
  REMEDIATION_VALIDATION_PROTOCOL_VERSION,
  validateRemediationValidationRequest,
  validateRemediationValidationResult,
  type RemediationValidationRequest
} from "../src/index.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const request: RemediationValidationRequest = {
  protocolVersion: REMEDIATION_VALIDATION_PROTOCOL_VERSION,
  requestId: "rv-1",
  classification: "private",
  finding: { fingerprint: "f".repeat(64), category: "security", path: "src/a.ts", startLine: 3, endLine: 3 },
  original: "  return unsafeValue;",
  replacement: "return safeValue;",
  contextBefore: "line 1\nline 2",
  contextAfter: "line 4"
};

const accept = {
  protocolVersion: REMEDIATION_VALIDATION_PROTOCOL_VERSION,
  requestId: "rv-1",
  decision: "accept",
  reasons: [],
  backend: { backendId: "validator", modelId: "m", latencyMs: 3 }
};

function client() {
  return new GuardianReviewClient({
    id: "validator",
    baseUrl: "https://validator.example.test",
    allowedClassifications: ["private"],
    timeoutMs: 5_000
  });
}

test("remediation validation request rejects unknown fields and inverted ranges", () => {
  assert.equal(validateRemediationValidationRequest(request), request);
  assert.throws(
    () => validateRemediationValidationRequest({ ...request, title: "model text" }),
    ProtocolValidationError
  );
  assert.throws(
    () =>
      validateRemediationValidationRequest({
        ...request,
        finding: { ...request.finding, startLine: 5, endLine: 4 }
      }),
    /inverted line range/
  );
});

test("remediation validation result must answer the request and match its decision", () => {
  assert.equal(validateRemediationValidationResult(accept, request).decision, "accept");
  const reject = { ...accept, decision: "reject", reasons: ["introduces-vulnerability"] };
  assert.equal(validateRemediationValidationResult(reject, request).decision, "reject");
  for (const bad of [
    { ...accept, requestId: "rv-2" },
    { ...accept, decision: "reject" },
    { ...accept, reasons: ["likely-syntax-error"] },
    { ...accept, reasons: ["free text explanation"] },
    { ...accept, decision: "approve" },
    { ...accept, explanation: "looks fine" }
  ]) {
    assert.throws(() => validateRemediationValidationResult(bad, request), ProtocolValidationError);
  }
});

test("validateRemediation posts to its own endpoint and maps malformed output to a non-retryable error", async () => {
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(String(input));
    return Response.json(accept);
  };
  assert.equal((await client().validateRemediation(request)).decision, "accept");
  assert.deepEqual(seen, ["https://validator.example.test/v1/remediation-validations"]);

  globalThis.fetch = async () => Response.json({ ...accept, decision: "maybe" });
  await assert.rejects(
    () => client().validateRemediation(request),
    (error: unknown) =>
      error instanceof BackendError && error.code === "invalid_output" && !error.retryable
  );

  globalThis.fetch = async () =>
    new Response("{}", { status: 200, headers: { "content-length": String(16 * 1024 + 1) } });
  await assert.rejects(() => client().validateRemediation(request), /size limit/);

  globalThis.fetch = async () => new Response("down", { status: 503 });
  await assert.rejects(
    () => client().validateRemediation(request),
    (error: unknown) => error instanceof BackendError && error.code === "unavailable"
  );
});
