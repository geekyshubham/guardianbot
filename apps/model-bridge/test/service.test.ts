import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelBridgeService } from "../src/service.js";
import { sampleRequest, sampleResult, writeFixtureFile } from "./helpers.js";

async function startService(config: Record<string, unknown>) {
  return startServiceWithEnv(config);
}

async function startServiceWithEnv(
  config: Record<string, unknown>,
  environmentOverrides: Partial<NodeJS.ProcessEnv> = {}
) {
  const service = await ModelBridgeService.create({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify(config),
    HOST: "127.0.0.1",
    ...environmentOverrides
  } as NodeJS.ProcessEnv);
  const server = service.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

test("contract endpoints return health, capabilities, and canonical review output", async () => {
  const request = sampleRequest();
  const fixtureFile = writeFixtureFile({
    defaultResult: sampleResult(request)
  });
  const { server, baseUrl } = await startService({
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
  });

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const capabilities = await fetch(`${baseUrl}/v1/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.deepEqual((await capabilities.json()).supportedProfiles, ["routine-review"]);

    const review = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    assert.equal(review.status, 200);
    const body = await review.json();
    assert.equal(body.requestId, request.requestId);
    assert.equal(body.backend.backendId, "fixtures");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("capabilities and reviews require constant-time bearer auth when configured", async () => {
  const request = sampleRequest();
  const fixtureFile = writeFixtureFile({
    defaultResult: sampleResult(request)
  });
  const { server, baseUrl } = await startServiceWithEnv(
    {
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
    },
    {
      GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-secret"
    }
  );

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${baseUrl}/v1/capabilities`);
    assert.equal(unauthorized.status, 401);
    assert.equal(
      unauthorized.headers.get("www-authenticate"),
      'Bearer realm="guardian-model-bridge"'
    );

    const wrongToken = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    assert.equal(wrongToken.status, 401);

    const authorized = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: {
        authorization: "Bearer bridge-secret"
      }
    });
    assert.equal(authorized.status, 200);

    const review = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    assert.equal(review.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("service redacts upstream refusal and rejects malformed request bodies", async () => {
  const request = sampleRequest({ requestId: "req-refusal" });
  const fixtureFile = writeFixtureFile({
    defaultResult: sampleResult(sampleRequest()),
    errorsByRequestId: {
      "req-refusal": { code: "refusal" }
    }
  });
  const { server, baseUrl } = await startService({
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
  });

  try {
    const malformed = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);

    const refusal = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    assert.equal(refusal.status, 422);
    const body = await refusal.json();
    assert.equal(body.error.code, "refusal");
    assert.equal(String(body.error.message).includes("fixture"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("explicit fallback route is used only for retryable failures", async () => {
  const request = sampleRequest({ requestId: "req-timeout" });
  const primaryFixture = writeFixtureFile({
    defaultResult: sampleResult(request),
    errorsByRequestId: {
      "req-timeout": { code: "timeout" }
    }
  });
  const fallbackFixture = writeFixtureFile({
    byRequestId: {
      "req-timeout": sampleResult(request, {
        backend: {
          backendId: "fallback",
          modelId: "fallback-model",
          latencyMs: 1
        }
      })
    }
  });
  const { server, baseUrl } = await startService({
    protocolVersion: "guardian.review.v1",
    bindings: {
      primary: {
        adapter: "fixture-provider",
        fixtureFile: primaryFixture,
        allowedClassifications: ["public", "private"],
        retention: "none"
      },
      fallback: {
        adapter: "fixture-provider",
        fixtureFile: fallbackFixture,
        allowedClassifications: ["public", "private"],
        retention: "none"
      }
    },
    routes: {
      "routine-review": {
        binding: "primary",
        fallbackBinding: "fallback"
      }
    }
  });

  try {
    const review = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    assert.equal(review.status, 200);
    const body = await review.json();
    assert.equal(body.backend.backendId, "fallback");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("fallback rechecks effective binding classifications before use", async () => {
  const request = sampleRequest({ requestId: "req-timeout" });
  const primaryFixture = writeFixtureFile({
    defaultResult: sampleResult(request),
    errorsByRequestId: {
      "req-timeout": { code: "timeout" }
    }
  });
  const fallbackFixture = writeFixtureFile({
    defaultResult: sampleResult(request, {
      backend: {
        backendId: "fallback",
        modelId: "fallback-model",
        latencyMs: 1
      }
    })
  });
  const service = await ModelBridgeService.create({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        primary: {
          adapter: "fixture-provider",
          fixtureFile: primaryFixture,
          allowedClassifications: ["public", "private"],
          retention: "none"
        },
        fallback: {
          adapter: "fixture-provider",
          fixtureFile: fallbackFixture,
          allowedClassifications: ["public", "private"],
          retention: "none"
        }
      },
      routes: {
        "routine-review": {
          binding: "primary",
          fallbackBinding: "fallback"
        }
      }
    }),
    HOST: "127.0.0.1"
  } as NodeJS.ProcessEnv);
  const routeRuntime = (service as unknown as {
    routes: Map<string, { route: { fallbackBinding?: { allowedClassifications: string[] } } }>;
  }).routes.get("routine-review");
  if (!routeRuntime?.route.fallbackBinding) throw new Error("expected fallback binding");
  routeRuntime.route.fallbackBinding.allowedClassifications = ["public"];

  const server = service.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const review = await fetch(`${baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    assert.equal(review.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
