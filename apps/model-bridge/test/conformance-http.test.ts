import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BackendError,
  GuardianReviewClient,
  validateReviewResult
} from "@guardianbot/protocol";
import { ModelBridgeService } from "../src/service.js";
import { sampleRequest, sampleResult, writeFixtureFile } from "./helpers.js";

async function startBridge(token: string) {
  const request = sampleRequest({ requestId: "req-wire" });
  const fixtureFile = writeFixtureFile({
    defaultResult: sampleResult(request, {
      backend: {
        backendId: "fixtures",
        modelId: "fixture-model",
        latencyMs: 1
      }
    })
  });
  const service = await ModelBridgeService.create({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        fixtures: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public", "private"],
          retention: "none"
        }
      },
      routes: {
        "routine-review": {
          binding: "fixtures"
        }
      }
    }),
    HOST: "127.0.0.1",
    GUARDIAN_MODEL_BRIDGE_TOKEN: token
  } as NodeJS.ProcessEnv);
  const server = service.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return {
    request,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

function reviewClient(baseUrl: string, token: string): GuardianReviewClient {
  return new GuardianReviewClient({
    id: "fixtures",
    baseUrl,
    authSecret: token,
    allowedClassifications: ["public", "private"],
    timeoutMs: 10_000
  });
}

test("wire-path protocol client capabilities and review against loopback bridge", async () => {
  const token = "bridge-wire-secret";
  const { request, baseUrl, close } = await startBridge(token);

  try {
    const client = reviewClient(baseUrl, token);
    const capabilities = await client.capabilities();
    assert.equal(capabilities.protocolVersion, "guardian.review.v1");
    assert.equal(capabilities.structuredOutput, true);
    assert.deepEqual(capabilities.supportedProfiles, ["routine-review"]);
    assert.deepEqual(capabilities.supportedDataClassifications, ["public", "private"]);

    const result = await client.review(request);
    const validated = validateReviewResult(result, request);
    assert.equal(validated.requestId, request.requestId);
    assert.equal(validated.reviewedHeadSha, request.pullRequest.headSha);
    assert.equal(validated.backend.backendId, "fixtures");
  } finally {
    await close();
  }
});

test("wire-path protocol client rejects wrong bearer and schema-invalid requests", async () => {
  const token = "bridge-wire-secret";
  const { request, baseUrl, close } = await startBridge(token);

  try {
    const wrongClient = reviewClient(baseUrl, "wrong-token");
    await assert.rejects(
      () => wrongClient.capabilities(),
      (error: unknown) =>
        error instanceof BackendError &&
        error.code === "authentication" &&
        error.retryable === false
    );

    await assert.rejects(
      () => wrongClient.review(request),
      (error: unknown) =>
        error instanceof BackendError &&
        error.code === "authentication" &&
        error.retryable === false
    );

    const authorized = reviewClient(baseUrl, token);
    await assert.rejects(
      () =>
        authorized.review({
          protocolVersion: "guardian.review.v1",
          schemaVersion: "1.0.0",
          requestId: "req-missing-fields"
        } as typeof request),
      (error: unknown) =>
        error instanceof BackendError &&
        error.retryable === false &&
        (error.code === "refusal" || error.code === "invalid_output")
    );

    // Direct HTTP assertion: schema-invalid JSON stays non-retryable 400.
    const invalid = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: "guardian.review.v1",
        schemaVersion: "1.0.0",
        requestId: "req-missing-fields"
      })
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: {
        code: "bad_request",
        message: "Request validation failed.",
        retryable: false
      }
    });
  } finally {
    await close();
  }
});

test("wire-path schema-invalid fixture result is not 400/bad_request and does not leak detail", async () => {
  const token = "bridge-wire-secret";
  const request = sampleRequest({ requestId: "req-wire-bad-output" });
  const fixtureFile = writeFixtureFile({
    defaultResult: {
      ...sampleResult(request, {
        backend: {
          backendId: "fixtures",
          modelId: "fixture-model",
          latencyMs: 1
        }
      }),
      // Schema-invalid: findings must be an array of finding objects.
      findings: "not-findings"
    }
  });
  const service = await ModelBridgeService.create({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        fixtures: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public", "private"],
          retention: "none"
        }
      },
      routes: {
        "routine-review": {
          binding: "fixtures"
        }
      }
    }),
    HOST: "127.0.0.1",
    GUARDIAN_MODEL_BRIDGE_TOKEN: token
  } as NodeJS.ProcessEnv);
  const server = service.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );

  try {
    const response = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    assert.notEqual(response.status, 400);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, {
      error: {
        code: "invalid_output",
        message: "Model output failed bridge validation.",
        retryable: true
      }
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("not-findings"), false);
    assert.equal(serialized.includes("ProtocolValidation"), false);
    assert.equal(serialized.includes("failed schema validation"), false);

    // Protocol client maps 5xx to retryable unavailable (does not surface bridge code).
    const client = reviewClient(baseUrl, token);
    await assert.rejects(
      () => client.review(request),
      (error: unknown) =>
        error instanceof BackendError &&
        error.retryable === true &&
        error.code === "unavailable"
    );
  } finally {
    await close();
  }
});
