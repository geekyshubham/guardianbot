import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FixtureProviderAdapter } from "../src/adapters/fixture-provider.js";
import type { ResolvedBinding, ResolvedRoute } from "../src/types.js";
import { sampleRequest } from "./helpers.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(packageRoot, "fixtures", "live-conformance.json");
const dockerfilePath = join(packageRoot, "..", "..", "Dockerfile");

function fixtureBinding(): ResolvedBinding {
  return {
    alias: "live-fixture",
    adapter: "fixture-provider",
    allowedClassifications: ["public", "private"],
    timeoutMs: 30_000,
    maxInputCharacters: 100_000,
    maxOutputTokens: 4_000,
    retention: "bounded",
    usageReporting: false,
    profileModels: {
      "routine-review": "fixture-conformance",
      "high-risk-review": "fixture-conformance",
      "benchmark-review": "fixture-conformance",
      "fallback-review": "fixture-conformance"
    },
    profileReasoningEfforts: {
      "routine-review": "medium",
      "high-risk-review": "medium",
      "benchmark-review": "medium",
      "fallback-review": "medium"
    },
    fixtureFile: fixturePath
  };
}

function fixtureRoute(binding: ResolvedBinding): ResolvedRoute {
  return {
    profile: "benchmark-review",
    binding,
    timeoutMs: 30_000,
    maxInputCharacters: 100_000,
    maxOutputTokens: 4_000,
    reasoningEffort: "medium"
  };
}

test("packaged live-conformance fixture validates with no findings", async () => {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    capabilities?: {
      structuredOutput?: boolean;
      retention?: string;
      usageReporting?: boolean;
    };
    defaultResult?: { findings?: unknown[] };
  };

  assert.equal(raw.capabilities?.structuredOutput, true);
  assert.equal(raw.capabilities?.retention, "bounded");
  assert.equal(raw.capabilities?.usageReporting, false);
  assert.deepEqual(raw.defaultResult?.findings, []);

  const serialized = JSON.stringify(raw);
  assert.equal(/sk-[a-zA-Z0-9]|api[_-]?key|secret|token|password|credential/i.test(serialized), false);
  assert.equal(/openai|anthropic|gemini|azure|bedrock/i.test(serialized), false);

  const request = sampleRequest({
    requestId: "req-live-conformance",
    profile: "benchmark-review",
    validChangedLines: [{ path: "README.md", start: 1, end: 20 }],
    contexts: [
      {
        id: "ctx-readme",
        path: "README.md",
        kind: "diff",
        content: "# Project\n\nDeterministic conformance fixture path.\n",
        sha256: "e".repeat(64)
      }
    ]
  });

  const binding = fixtureBinding();
  const adapter = new FixtureProviderAdapter(binding, {
    responseBodyBytes: 100_000,
    startupProbeTimeoutMs: 5_000
  });
  const { result } = await adapter.review({
    request,
    route: fixtureRoute(binding)
  });

  assert.equal(result.requestId, request.requestId);
  assert.equal(result.reviewedHeadSha, request.pullRequest.headSha);
  assert.equal(result.contextIndexSha, request.expectedContextIndexSha);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.requirements, []);
  assert.deepEqual(result.testGaps, []);
  assert.deepEqual(result.suggestedReviewers, []);
  assert.equal(result.summary.riskScore, 0);
  assert.equal(result.summary.reviewEffort, 1);
  assert.equal(result.summary.partialReview, false);
  assert.equal("mermaidDiagram" in result.summary, false);
  assert.equal(result.backend.backendId, "live-fixture");
  assert.equal(result.backend.modelId, "fixture-conformance");
});

test("Dockerfile packages model-bridge fixtures into the runtime image", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/apps\/model-bridge\/fixtures \.\/apps\/model-bridge\/fixtures/
  );
});
