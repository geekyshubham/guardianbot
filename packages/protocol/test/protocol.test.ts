import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  BackendError,
  GuardianReviewClient,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  validateReviewRequest,
  validateReviewResult,
  type ReviewRequest,
  type ReviewResult
} from "../src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

/** Reject with AbortError when `init.signal` aborts; a forever-pending Promise alone never does. */
function fetchPendingUntilAbort(
  onSignal?: (signal: AbortSignal | undefined) => void
): typeof fetch {
  return async (_input, init) => {
    const signal = init?.signal ?? undefined;
    onSignal?.(signal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () =>
        reject(new DOMException("The operation was aborted", "AbortError"));
      if (!signal) return;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  };
}

test("external abort reaches fetch and is distinguishable from timeout", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  globalThis.fetch = fetchPendingUntilAbort((signal) => {
    observedSignal = signal;
  });

  const client = new GuardianReviewClient({
    id: "bridge",
    baseUrl: "https://bridge.example.test",
    allowedClassifications: ["public"],
    timeoutMs: 60_000
  });

  const pending = client.capabilities(controller.signal);
  while (!observedSignal) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(observedSignal.aborted, true);

  // Timeout classification must remain distinct from external AbortError.
  globalThis.fetch = fetchPendingUntilAbort();
  const shortTimeout = new GuardianReviewClient({
    id: "bridge",
    baseUrl: "https://bridge.example.test",
    allowedClassifications: ["public"],
    timeoutMs: 20
  });
  await assert.rejects(
    () => shortTimeout.capabilities(),
    (error: unknown) => error instanceof BackendError && error.code === "timeout"
  );
});

test("external abort during stalled body read preserves AbortError", async () => {
  const controller = new AbortController();
  let bodyReading = false;
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(streamController) {
          const abort = () =>
            streamController.error(
              new DOMException("The operation was aborted", "AbortError")
            );
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
          // Stall after headers so body read begins; never enqueue or close.
          bodyReading = true;
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const client = new GuardianReviewClient({
    id: "bridge",
    baseUrl: "https://bridge.example.test",
    allowedClassifications: ["public"],
    timeoutMs: 60_000
  });

  const pending = client.review(request, controller.signal);
  while (!bodyReading) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Yield so readJsonResponseLimited is blocked in reader.read() before abort.
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof Error &&
      error.name === "AbortError" &&
      !(error instanceof BackendError)
  );
});
