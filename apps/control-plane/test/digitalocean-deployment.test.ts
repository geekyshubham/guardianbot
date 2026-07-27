import assert from "node:assert/strict";
import test from "node:test";
import {
  createDigitalOceanDeploymentService,
  DigitalOceanDeploymentError
} from "../src/digitalocean-deployment.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const APP_ID = "346b3b81-b8cf-4136-b706-0a7195bc9f00";
const DEPLOYMENT_ID = "1304cb3c-f8c9-4135-8ad5-e21ed98b1aef";
const OLD_DIGEST = `sha256:${"1".repeat(64)}`;
const NEW_DIGEST = `sha256:${"2".repeat(64)}`;

function environment(): Record<string, string> {
  return {
    DIGITALOCEAN_STAGING_TOKEN: "dop_v1_test-token-with-enough-entropy",
    GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON: JSON.stringify({
      "service-staging": {
        repository: "Geekyshubham/service",
        repositoryId: 99,
        appId: APP_ID,
        appName: "guardianbot-service-staging",
        serviceNames: ["web", "worker"],
        imageName: "ghcr.io/geekyshubham/service",
        environment: "staging",
        origin: "https://staging.example.com",
        healthPath: "/healthz",
        readinessPath: "/readyz",
        apiTokenEnv: "DIGITALOCEAN_STAGING_TOKEN",
        timeoutSeconds: 60
      }
    })
  };
}

function appDocument(
  digest: string,
  options: {
    activeDigest?: string;
    phase?: string;
    appName?: string;
  } = {}
): Record<string, unknown> {
  const spec = {
    name: options.appName ?? "guardianbot-service-staging",
    region: "blr",
    services: [
      {
        name: "web",
        image: {
          registry_type: "GHCR",
          registry: "geekyshubham",
          repository: "service",
          digest
        }
      },
      {
        name: "worker",
        image: {
          registry_type: "GHCR",
          registry: "geekyshubham",
          repository: "service",
          digest
        }
      },
      {
        name: "metrics",
        image: {
          registry_type: "DOCKER_HUB",
          registry: "library",
          repository: "prometheus",
          tag: "latest"
        }
      }
    ]
  };
  const activeDigest = options.activeDigest ?? digest;
  const activeSpec = structuredClone(spec);
  for (const service of activeSpec.services.slice(0, 2)) {
    service.image.digest = activeDigest;
  }
  return {
    app: {
      id: APP_ID,
      spec,
      active_deployment: {
        id: DEPLOYMENT_ID,
        phase: options.phase ?? "ACTIVE",
        spec: activeSpec
      },
      in_progress_deployment: null
    }
  };
}

function input() {
  return {
    repository: "Geekyshubham/service",
    repositoryId: 99,
    runId: 500,
    runAttempt: 2,
    headSha: "a".repeat(40),
    imageReference: `ghcr.io/geekyshubham/service@${NEW_DIGEST}`
  };
}

test("updates only approved App Platform services and verifies active health", async () => {
  const store = new MemoryStore();
  let appReads = 0;
  let updates = 0;
  const fetchImpl: typeof fetch = (async (request, init) => {
    const url =
      request instanceof URL
        ? request
        : new URL(typeof request === "string" ? request : request.url);
    if (url.origin === "https://api.digitalocean.com") {
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        "Bearer dop_v1_test-token-with-enough-entropy"
      );
      if (init?.method === "PUT") {
        updates += 1;
        const body = JSON.parse(String(init.body)) as {
          spec: { services: Array<Record<string, any>> };
        };
        assert.deepEqual(
          body.spec.services.slice(0, 2).map((service) => service.image),
          [
            {
              registry_type: "GHCR",
              registry: "geekyshubham",
              repository: "service",
              digest: NEW_DIGEST
            },
            {
              registry_type: "GHCR",
              registry: "geekyshubham",
              repository: "service",
              digest: NEW_DIGEST
            }
          ]
        );
        assert.equal(body.spec.services[2]?.image.tag, "latest");
        return Response.json(appDocument(NEW_DIGEST));
      }
      appReads += 1;
      return Response.json(
        appReads === 1
          ? appDocument(OLD_DIGEST)
          : appDocument(NEW_DIGEST)
      );
    }
    if (
      url.href === "https://staging.example.com/healthz" ||
      url.href === "https://staging.example.com/readyz"
    ) {
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  }) as typeof fetch;
  const service = createDigitalOceanDeploymentService({
    store,
    environment: environment(),
    fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    pollIntervalMs: 1
  });

  const result = await service.promote(input());
  assert.equal(result?.imageDigest, NEW_DIGEST);
  assert.equal(result?.deploymentId, DEPLOYMENT_ID);
  assert.equal(result?.updated, true);
  assert.equal(updates, 1);
});

test("an already active exact digest is idempotent and does not update the app", async () => {
  const store = new MemoryStore();
  let updates = 0;
  const fetchImpl: typeof fetch = (async (request, init) => {
    const url =
      request instanceof URL
        ? request
        : new URL(typeof request === "string" ? request : request.url);
    if (url.origin === "https://api.digitalocean.com") {
      if (init?.method === "PUT") updates += 1;
      return Response.json(appDocument(NEW_DIGEST));
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const service = createDigitalOceanDeploymentService({
    store,
    environment: environment(),
    fetchImpl,
    now: () => NOW
  });
  const result = await service.promote(input());
  assert.equal(result?.updated, false);
  assert.equal(updates, 0);
});

test("profile mismatches fail closed without sending an update", async () => {
  const service = createDigitalOceanDeploymentService({
    store: new MemoryStore(),
    environment: environment(),
    now: () => NOW,
    fetchImpl: (async () =>
      Response.json(
        appDocument(OLD_DIGEST, {
          appName: "unapproved-app"
        })
      )) as typeof fetch
  });
  await assert.rejects(
    () => service.promote(input()),
    (error: unknown) =>
      error instanceof DigitalOceanDeploymentError &&
      error.environment === "staging"
  );
});

test("repositories without an administrative profile are not deployed", async () => {
  const service = createDigitalOceanDeploymentService({
    store: new MemoryStore(),
    environment: {},
    fetchImpl: (async () => {
      throw new Error("must not call DigitalOcean");
    }) as typeof fetch
  });
  assert.equal(await service.promote(input()), undefined);
});
