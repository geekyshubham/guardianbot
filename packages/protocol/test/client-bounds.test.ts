import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { GuardianReviewClient } from "../src/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): GuardianReviewClient {
  return new GuardianReviewClient({
    id: "bridge",
    baseUrl: "https://bridge.example.test",
    allowedClassifications: ["public"],
    timeoutMs: 10_000
  });
}

test("capabilities rejects an oversized declared response before parsing", async () => {
  globalThis.fetch = async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-length": String(128 * 1024 + 1) }
    });

  await assert.rejects(
    () => client().capabilities(),
    /response exceeded the size limit/
  );
});

test("capabilities accepts a bounded valid response", async () => {
  globalThis.fetch = async () =>
    Response.json({
      protocolVersion: "guardian.review.v1",
      backendId: "bridge",
      structuredOutput: true,
      maxInputCharacters: 100_000,
      supportedProfiles: ["routine-review"],
      supportedDataClassifications: ["public"],
      retention: "none",
      usageReporting: true
    });

  assert.equal((await client().capabilities()).backendId, "bridge");
});

test("review preserves a non-retryable oversized-response failure", async () => {
  globalThis.fetch = async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) }
    });

  const request = {
    protocolVersion: "guardian.review.v1" as const,
    schemaVersion: "1.0.0" as const,
    requestId: "req-bounds",
    repository: { id: "1", fullName: "Acme/Widget", classification: "public" as const },
    pullRequest: {
      number: 1,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      author: "alice",
      title: "Bound response"
    },
    profile: "routine-review" as const,
    promptVersion: "1",
    validChangedLines: [],
    contexts: [],
    scannerEvidence: [],
    rules: [],
    limits: { maxInlineComments: 1, maxInputCharacters: 10_000, timeoutMs: 10_000 }
  };

  await assert.rejects(
    () => client().review(request),
    (error: unknown) =>
      error instanceof Error &&
      "retryable" in error &&
      error.retryable === false &&
      /response exceeded the size limit/.test(error.message)
  );
});
