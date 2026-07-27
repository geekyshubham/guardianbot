import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { GuardianMetrics } from "./metrics.js";
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
    const postgres = new PostgresStore(process.env.DATABASE_URL);
    await postgres.migrate();
    return postgres;
  }
  if (allowMemoryStore()) return new MemoryStore();
  throw new Error("DATABASE_URL is required outside explicit dev/test mode");
}

async function start() {
  const metrics = new GuardianMetrics();
  const store = await createStore();
  const privateKey = required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const service = new GuardianService(
    {
      appId: required("GITHUB_APP_ID"),
      privateKey,
      webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
      modelBackendUrl: process.env.GUARDIAN_MODEL_BACKEND_URL,
      modelBackendToken: process.env.GUARDIAN_MODEL_BACKEND_TOKEN,
      metrics
    },
    store
  );
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
        (await service.ready());
      response
        .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ status: ready ? "ready" : "degraded" }));
      return;
    }
    if (request.url === "/metrics") {
      response
        .writeHead(200, { "content-type": "text/plain; version=0.0.4" })
        .end(metrics.render());
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
    await Promise.race([workerPromise, delay(15_000)]);
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
