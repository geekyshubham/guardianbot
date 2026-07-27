import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleAdapter } from "../src/adapters/openai-compatible.js";
import { OpenAIResponsesAdapter } from "../src/adapters/openai-responses.js";
import { strictModelOutputSchema } from "../src/strict-schema.js";
import type { ResolvedBinding, ResolvedRoute } from "../src/types.js";
import { sampleRequest, sampleResult } from "./helpers.js";

function binding(adapter: ResolvedBinding["adapter"]): ResolvedBinding {
  return {
    alias: adapter,
    adapter,
    baseUrl: "https://example.test/",
    apiKey: "secret",
    allowedClassifications: ["public", "private"],
    timeoutMs: 30000,
    maxInputCharacters: 100000,
    maxOutputTokens: 4000,
    retention: "none",
    usageReporting: adapter === "openai-responses",
    profileModels: {
      "routine-review": "model-routine",
      "high-risk-review": "model-risk",
      "benchmark-review": "model-bench",
      "fallback-review": "model-fallback"
    },
    profileReasoningEfforts: {
      "routine-review": "medium",
      "high-risk-review": "medium",
      "benchmark-review": "medium",
      "fallback-review": "medium"
    }
  };
}

function route(bound: ResolvedBinding): ResolvedRoute {
  return {
    profile: "routine-review",
    binding: bound,
    timeoutMs: 30000,
    maxInputCharacters: 100000,
    maxOutputTokens: 4000,
    reasoningEffort: "medium"
  };
}

test("OpenAI Responses adapter sends strict schema request and excludes tool_choice", async () => {
  const request = sampleRequest();
  let capturedBody: unknown;
  const adapter = new OpenAIResponsesAdapter(binding("openai-responses"), {
    responseBodyBytes: 100000,
    startupProbeTimeoutMs: 5000,
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      const result = sampleResult(request, {
        backend: {
          backendId: "ignored",
          modelId: "ignored",
          latencyMs: 0
        },
        summary: {
          ...sampleResult(request).summary,
          mermaidDiagram: undefined
        },
        findings: sampleResult(request).findings.map((finding) => ({
          ...finding,
          suggestion: undefined,
          relatedTests: [],
          scannerFingerprints: []
        }))
      });
      const modelOutput = {
        summary: {
          ...result.summary,
          mermaidDiagram: null
        },
        findings: result.findings.map((finding) => ({
          ...finding,
          suggestion: null,
          relatedTests: [],
          scannerFingerprints: []
        })),
        requirements: result.requirements,
        testGaps: result.testGaps,
        suggestedReviewers: result.suggestedReviewers
      };
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(modelOutput) }]
            }
          ],
          usage: {
            input_tokens: 111,
            output_tokens: 222
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const result = await adapter.review({ request, route: route(binding("openai-responses")) });
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, []);
  assert.equal("tool_choice" in body, false);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  const format = ((body.text as Record<string, unknown>).format ?? {}) as Record<string, unknown>;
  assert.equal(format.type, "json_schema");
  assert.equal(format.name, "guardian_review_v1");
  assert.equal(format.strict, true);
  assert.deepEqual(format.schema, strictModelOutputSchema);
  assert.equal(result.result.backend.backendId, "openai-responses");
  assert.equal(result.result.backend.modelId, "model-routine");
  assert.equal(result.result.backend.inputUnits, 111);
  assert.equal(result.result.backend.outputUnits, 222);
  const prompt = JSON.stringify(body.input);
  assert.equal(prompt.includes("example"), false);
  assert.equal(prompt.includes("developer"), false);
});

test("OpenAI Responses adapter rejects multiple structured text outputs", async () => {
  const request = sampleRequest();
  const adapter = new OpenAIResponsesAdapter(binding("openai-responses"), {
    responseBodyBytes: 100000,
    startupProbeTimeoutMs: 5000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "{}" },
                { type: "output_text", text: "{}" }
              ]
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  });

  await assert.rejects(
    () => adapter.review({ request, route: route(binding("openai-responses")) }),
    /exactly one structured text output/
  );
});

test("OpenAI-compatible adapter fails closed when probe cannot prove strict output support", async () => {
  const compatible = new OpenAICompatibleAdapter(binding("openai-compatible"), {
    responseBodyBytes: 100000,
    startupProbeTimeoutMs: 5000,
    fetchImpl: async () =>
      new Response(JSON.stringify({ status: "completed", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });

  await assert.rejects(
    () => compatible.probe({ route: route(binding("openai-compatible")) }),
    /strict structured-output probe/
  );
});

test("OpenAI-compatible probe honors startupProbeTimeoutMs", async () => {
  const compatible = new OpenAICompatibleAdapter(binding("openai-compatible"), {
    responseBodyBytes: 100000,
    startupProbeTimeoutMs: 25,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Timed out", "TimeoutError")),
          { once: true }
        );
      })
  });
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      compatible.probe({
        route: {
          ...route(binding("openai-compatible")),
          timeoutMs: 60_000
        }
      }),
    /strict structured-output probe/
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("strict model-output schema requires every object property and forbids extras", () => {
  const visit = (schema: Record<string, unknown>) => {
    if (schema.type === "object") {
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(
        [...(schema.required as string[])].sort(),
        Object.keys(properties).sort()
      );
      for (const child of Object.values(properties)) {
        if (child && typeof child === "object") visit(child);
      }
    }
    if (schema.type === "array" && schema.items && typeof schema.items === "object") {
      visit(schema.items as Record<string, unknown>);
    }
  };

  visit(strictModelOutputSchema as unknown as Record<string, unknown>);
});
