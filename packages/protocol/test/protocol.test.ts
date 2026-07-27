import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  validateReviewRequest,
  validateReviewResult,
  type ReviewRequest,
  type ReviewResult
} from "../src/index.js";

const request: ReviewRequest = {
  protocolVersion: PROTOCOL_VERSION,
  schemaVersion: "1.0.0",
  requestId: "req-1",
  repository: {
    owner: "example",
    name: "service",
    visibility: "private",
    defaultBranch: "main"
  },
  pullRequest: {
    number: 1,
    title: "Fix auth",
    body: "Fixes #2",
    baseSha: "aaaaaaa",
    headSha: "bbbbbbb",
    author: "developer"
  },
  profile: "high-risk-review",
  promptVersion: "1",
  expectedContextIndexSha: "c".repeat(64),
  validChangedLines: [{ path: "src/auth.ts", start: 10, end: 20 }],
  contexts: [
    {
      id: "auth-diff",
      path: "src/auth.ts",
      kind: "diff",
      content: "+if (!user.role) throw new Error('forbidden');",
      sha256: "d".repeat(64)
    }
  ],
  scannerEvidence: [],
  rules: [],
  limits: { maxInlineComments: 8, maxInputCharacters: 100000, timeoutMs: 30000 }
};

const result: ReviewResult = {
  protocolVersion: PROTOCOL_VERSION,
  schemaVersion: "1.0.0",
  requestId: "req-1",
  reviewedHeadSha: "bbbbbbb",
  contextIndexSha: "c".repeat(64),
  summary: {
    intent: "Fix authentication",
    changeGroups: [],
    riskScore: 80,
    reviewEffort: 3,
    impactedComponents: ["auth"],
    partialReview: false
  },
  findings: [
    {
      id: "GB-1",
      fingerprint: "auth-missing-check",
      category: "security",
      severity: "P1",
      confidence: 0.95,
      title: "Missing authorization check",
      path: "src/auth.ts",
      startLine: 12,
      endLine: 12,
      evidence: "if (!user.role) throw new Error('forbidden');",
      impact: "A normal user could access an administrative operation.",
      remediation: "Restore the role check before performing the operation."
    }
  ],
  requirements: [],
  testGaps: [],
  suggestedReviewers: [],
  backend: { backendId: "backend-a", modelId: "opaque-model", latencyMs: 200 }
};

test("validates a canonical request and result", () => {
  assert.equal(validateReviewRequest(request).requestId, "req-1");
  assert.equal(validateReviewResult(result, request).findings.length, 1);
});

test("rejects findings outside changed lines", () => {
  const invalid = structuredClone(result);
  invalid.findings[0]!.startLine = 100;
  invalid.findings[0]!.endLine = 100;
  assert.throws(
    () => validateReviewResult(invalid, request),
    ProtocolValidationError
  );
});

test("rejects mismatched context bundle hashes when the request supplies one", () => {
  const invalid = structuredClone(result);
  invalid.contextIndexSha = "d".repeat(64);
  assert.throws(
    () => validateReviewResult(invalid, request),
    ProtocolValidationError
  );
});

test("rejects findings whose evidence is not grounded in the matching file context", () => {
  const invalid = structuredClone(result);
  invalid.findings[0]!.evidence =
    "A completely unrelated database transaction is unsafe.";
  assert.throws(
    () => validateReviewResult(invalid, request),
    /does not contain evidence grounded/
  );
});

test("rejects evidence with only one coincidental token overlap", () => {
  const invalid = structuredClone(result);
  invalid.findings[0]!.evidence =
    "An unrelated unsafe database transaction could corrupt production.";
  assert.throws(
    () => validateReviewResult(invalid, request),
    /does not contain evidence grounded/
  );
});

test("rejects unknown scanner evidence references", () => {
  const invalid = structuredClone(result);
  invalid.findings[0]!.scannerFingerprints = ["missing-scanner-fingerprint"];
  assert.throws(
    () => validateReviewResult(invalid, request),
    /references unknown scanner evidence/
  );
});
