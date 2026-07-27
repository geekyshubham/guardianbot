import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReviewBackendRegistry,
  parseAdminBackendRegistry
} from "../src/backend-registry.js";

test("administrative registry permits only authenticated explicit private HTTP", () => {
  const registry = new ReviewBackendRegistry(
    {
      protocolVersion: "guardian.review.v1",
      backends: {
        bridge: {
          endpoint: "http://model-bridge:3001",
          tokenEnv: "BRIDGE_TOKEN",
          allowedClassifications: ["public", "private"],
          allowPrivateHttp: true
        }
      },
      routes: {
        "routine-review": "bridge",
        "high-risk-review": "bridge"
      }
    },
    { BRIDGE_TOKEN: "deployment-owned-bearer-token" }
  );

  assert.equal(registry.resolve("routine-review", "private")?.alias, "bridge");
});

test("private HTTP remains fail-closed without its flag, token, or private host", () => {
  const base = {
    protocolVersion: "guardian.review.v1" as const,
    routes: { "routine-review": "bridge" as const }
  };

  assert.throws(
    () =>
      parseAdminBackendRegistry({
        ...base,
        backends: {
          bridge: {
            endpoint: "http://model-bridge:3001",
            allowedClassifications: ["public"]
          }
        }
      }),
    /must use HTTPS/
  );

  assert.throws(
    () =>
      parseAdminBackendRegistry({
        ...base,
        backends: {
          bridge: {
            endpoint: "http://model-bridge:3001",
            allowedClassifications: ["public"],
            allowPrivateHttp: true
          }
        }
      }),
    /requires a bearer token/
  );

  assert.throws(
    () =>
      parseAdminBackendRegistry({
        ...base,
        backends: {
          bridge: {
            endpoint: "http://review.example.com:3001",
            token: "deployment-owned-bearer-token",
            allowedClassifications: ["public"],
            allowPrivateHttp: true
          }
        }
      }),
    /must use HTTPS/
  );
});
