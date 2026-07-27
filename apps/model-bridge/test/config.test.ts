import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuntimeCapabilities, loadConfig, resolveRoutes } from "../src/config.js";
import { writeFixtureFile } from "./helpers.js";

test("loads config from JSON and applies default OpenAI model mapping", () => {
  const fixtureFile = writeFixtureFile({});
  const config = loadConfig({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        primary: {
          adapter: "openai-responses",
          apiKey: "test-key",
          allowedClassifications: ["public", "private"]
        },
        fixtures: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public", "private"]
        }
      },
      routes: {
        "routine-review": {
          binding: "primary",
          fallbackBinding: "fixtures"
        },
        "high-risk-review": {
          binding: "primary"
        }
      }
    }),
    GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-token"
  } as NodeJS.ProcessEnv);

  const routes = resolveRoutes(config);
  assert.equal(routes[0]?.binding.profileModels["routine-review"], "gpt-5.6-terra");
  assert.equal(routes[0]?.binding.retention, "bounded");
  assert.equal(routes[0]?.fallbackBinding?.alias, "fixtures");
});

test("requires an explicit verified ZDR assertion before OpenAI advertises no retention", () => {
  const baseConfig = {
    protocolVersion: "guardian.review.v1",
    bindings: {
      primary: {
        adapter: "openai-responses",
        apiKey: "test-key",
        allowedClassifications: ["public"],
        retention: "none"
      }
    },
    routes: {
      "routine-review": {
        binding: "primary"
      }
    }
  };

  assert.throws(
    () =>
      loadConfig({
        GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify(baseConfig),
        GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-token"
      } as NodeJS.ProcessEnv),
    /zeroDataRetentionVerified/
  );

  const verified = loadConfig({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      ...baseConfig,
      bindings: {
        primary: {
          ...baseConfig.bindings.primary,
          zeroDataRetentionVerified: true
        }
      }
    }),
    GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-token"
  } as NodeJS.ProcessEnv);

  assert.equal(resolveRoutes(verified)[0]?.binding.retention, "none");
});

test("rejects mixed capability classification sets across routes", () => {
  const fixtureFile = writeFixtureFile({});
  const config = loadConfig({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        publicOnly: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public"]
        },
        privateOnly: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["private"]
        }
      },
      routes: {
        "routine-review": {
          binding: "publicOnly"
        },
        "high-risk-review": {
          binding: "privateOnly"
        }
      }
    })
  } as NodeJS.ProcessEnv);

  assert.throws(() => buildRuntimeCapabilities(resolveRoutes(config)));
});

test("rejects fallback routes when fallback classifications are not a superset", () => {
  const fixtureFile = writeFixtureFile({});
  const config = loadConfig({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        primary: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public", "private"]
        },
        fallback: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public"]
        }
      },
      routes: {
        "routine-review": {
          binding: "primary",
          fallbackBinding: "fallback"
        }
      }
    })
  } as NodeJS.ProcessEnv);

  assert.throws(() => resolveRoutes(config), /must allow every primary classification/);
});

test("requires auth token for non-loopback bindings and enforces transport policy", () => {
  const fixtureFile = writeFixtureFile({});
  assert.throws(
    () =>
      loadConfig({
        GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
          protocolVersion: "guardian.review.v1",
          bindings: {
            primary: {
              adapter: "openai-compatible",
              baseUrl: "https://10.0.0.5:8443",
              allowedClassifications: ["public"],
              retention: "none"
            }
          },
          routes: {
            "routine-review": {
              binding: "primary"
            }
          }
        }),
        HOST: "127.0.0.1"
      } as NodeJS.ProcessEnv),
    /GUARDIAN_MODEL_BRIDGE_TOKEN is required/
  );

  assert.throws(
    () =>
      loadConfig({
        GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
          protocolVersion: "guardian.review.v1",
          bindings: {
            primary: {
              adapter: "openai-compatible",
              baseUrl: "http://10.0.0.5:11434",
              allowedClassifications: ["public"],
              retention: "none"
            }
          },
          routes: {
            "routine-review": {
              binding: "primary"
            }
          }
        }),
        HOST: "127.0.0.1",
        GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-token"
      } as NodeJS.ProcessEnv),
    /must use HTTPS unless allowInsecureHttpForLocalDev/
  );

  const accepted = loadConfig({
    GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
      protocolVersion: "guardian.review.v1",
      bindings: {
        primary: {
          adapter: "openai-compatible",
          baseUrl: "http://10.0.0.5:11434",
          allowInsecureHttpForLocalDev: true,
          allowedClassifications: ["public"],
          retention: "none"
        },
        fixtures: {
          adapter: "fixture-provider",
          fixtureFile,
          allowedClassifications: ["public"]
        }
      },
      routes: {
        "routine-review": {
          binding: "primary"
        }
      }
    }),
    HOST: "127.0.0.1",
    GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-token"
  } as NodeJS.ProcessEnv);
  assert.equal(accepted.authRequired, true);

  assert.throws(
    () =>
      loadConfig({
        GUARDIAN_MODEL_BRIDGE_CONFIG_JSON: JSON.stringify({
          protocolVersion: "guardian.review.v1",
          bindings: {
            primary: {
              adapter: "openai-responses",
              baseUrl: "https://api.openai.com",
              allowInsecureHttpForLocalDev: true,
              apiKey: "provider-key",
              allowedClassifications: ["public"]
            }
          },
          routes: {
            "routine-review": {
              binding: "primary"
            }
          }
        }),
        HOST: "127.0.0.1",
        GUARDIAN_MODEL_BRIDGE_TOKEN: "bridge-token"
      } as NodeJS.ProcessEnv),
    /not supported for openai-responses/
  );
});
