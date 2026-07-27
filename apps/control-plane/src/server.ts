import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEvidenceAttestationService,
  EvidenceAttestationError
} from "./evidence-attestation.js";
import { GuardianMetrics } from "./metrics.js";
import { metricsRequestAuthorized } from "./http-security.js";
import {
  MonitoringService,
  monitoringOptionsFromEnvironment
} from "./monitoring-service.js";
import { RepositoryIndexService } from "./repository-index-service.js";
import { createScannerWorkflowRunHandler } from "./scanner-evidence.js";
import { GuardianService } from "./service.js";
import { MemoryStore, PostgresStore, type Store } from "./store.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function allowMemoryStore(): boolean {
  return process.env.NODE_ENV === "test" || process.env.GUARDIANBOT_ALLOW_INMEMORY_STORE === "1";
}

async function createStore(): Promise<Store> {
  if (process.env.DATABASE_URL) {
    const postgres = new PostgresStore(
      process.env.DATABASE_URL,
      process.env.GUARDIANBOT_DATABASE_CA_CERT
    );
    await postgres.migrate();
    return postgres;
  }
  if (allowMemoryStore()) return new MemoryStore();
  throw new Error("DATABASE_URL is required outside explicit dev/test mode");
}

async function start() {
  const metrics = new GuardianMetrics();
  const store = await createStore();
  const monitoring = new MonitoringService(
    store,
    monitoringOptionsFromEnvironment(process.env)
  );
  const privateKey = required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const evidenceAttestation = createEvidenceAttestationService({
    environment: process.env,
    authorizeRepository: async (repositoryName, repositoryId) => {
      const repository = await store.getRepository(repositoryId);
      return (
        repository?.repositoryState === "active" &&
        repository.fullName.toLowerCase() === repositoryName.toLowerCase()
      );
    }
  });
  const repositoryIndexService = new RepositoryIndexService(store);
  const service = new GuardianService(
    {
      appId: required("GITHUB_APP_ID"),
      privateKey,
      webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
      modelBackendUrl: process.env.GUARDIAN_MODEL_BACKEND_URL,
      modelBackendToken: process.env.GUARDIAN_MODEL_BACKEND_TOKEN,
      metrics,
      scannerWorkflowRunHandler: createScannerWorkflowRunHandler({
        appId: required("GITHUB_APP_ID"),
        privateKey,
        store,
        environment: process.env
      }),
      repositoryIndexService
    },
    store
  );
  monitoring.start();
  const workerId = `${process.pid}-${randomUUID()}`;
  let shuttingDown = false;
  let lastWorkerPollAt = Date.now();
  let workerPromise: Promise<void> | undefined;

  async function workerLoop(): Promise<void> {
    while (!shuttingDown) {
      lastWorkerPollAt = Date.now();
      const processed = await service.processNextWebhook(workerId);
      if (!processed) await delay(1000);
    }
  }

  workerPromise = workerLoop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (request.url === "/readyz") {
      const ready =
        !shuttingDown &&
        Date.now() - lastWorkerPollAt < 30_000 &&
        monitoring.ready() &&
        (await service.ready());
      response
        .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ status: ready ? "ready" : "degraded" }));
      return;
    }
    if (request.url === "/metrics") {
      if (
        !metricsRequestAuthorized(
          request.headers.authorization,
          process.env.GUARDIANBOT_METRICS_BEARER_TOKEN,
          process.env.GUARDIANBOT_TRUST_PRIVATE_METRICS === "1"
        )
      ) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain; version=0.0.4" })
        .end(`${metrics.render()}${monitoring.renderMetrics()}`);
      return;
    }
    if (request.method === "POST" && request.url === "/evidence/attest") {
      const mediaType = String(request.headers["content-type"] ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        response.writeHead(415).end();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      try {
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          received += buffer.length;
          if (received > 16 * 1024) {
            response.writeHead(413).end();
            request.destroy();
            return;
          }
          chunks.push(buffer);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const attestation = await evidenceAttestation.attest(
          request.headers.authorization,
          payload
        );
        response
          .writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json"
          })
          .end(JSON.stringify(attestation));
      } catch (error) {
        const status =
          error instanceof EvidenceAttestationError ? error.statusCode : 400;
        response
          .writeHead(status, {
            "cache-control": "no-store",
            "content-type": "application/json"
          })
          .end(
            JSON.stringify({
              error:
                error instanceof EvidenceAttestationError
                  ? error.message
                  : "invalid attestation request"
            })
          );
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/webhooks/github") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > 2 * 1024 * 1024) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      service.authenticate(
        body,
        request.headers["x-hub-signature-256"] as string | undefined,
        String(request.headers["x-github-delivery"] ?? "")
      );
      const payload = JSON.parse(body);
      await service.enqueue(
        String(request.headers["x-github-event"]),
        payload,
        String(request.headers["x-github-delivery"] ?? "")
      );
      response.writeHead(202).end();
    } catch (error) {
      response
        .writeHead(String(error).includes("signature") ? 401 : 400, {
          "content-type": "application/json"
        })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "0.0.0.0");

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await Promise.race([
      Promise.all([workerPromise, monitoring.stop()]),
      delay(15_000)
    ]);
    await store.close();
    if (signal) process.exitCode = process.exitCode ?? 0;
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
