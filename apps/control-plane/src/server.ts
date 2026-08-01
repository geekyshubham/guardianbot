import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEvidenceAttestationService,
  EvidenceAttestationError
} from "./evidence-attestation.js";
import {
  createDastSessionService,
  DastSessionError
} from "./dast-session.js";
import { GuardianMetrics } from "./metrics.js";
import { metricsRequestAuthorized } from "./http-security.js";
import { startImageSmokeServer } from "./image-smoke.js";
import {
  MonitoringService,
  monitoringOptionsFromEnvironment
} from "./monitoring-service.js";
import { RepositoryIndexService } from "./repository-index-service.js";
import { createScannerWorkflowRunHandler } from "./scanner-evidence.js";
import { GuardianService, WebhookAuthenticationError } from "./service.js";
import {
  MemoryStore,
  PostgresStore,
  webhookRetentionOptionsFromEnvironment,
  type Store
} from "./store.js";

// Must exceed the 90s backend review timeout so an in-flight delivery can finish, or at
// least record its lease release, before the drain window closes.
const DRAIN_BUDGET_MS = 120_000;

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
  if (process.env.GUARDIANBOT_IMAGE_SMOKE === "1") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("GUARDIANBOT_IMAGE_SMOKE requires NODE_ENV=test");
    }
    await startImageSmokeServer(Number(process.env.PORT ?? 3000));
    return;
  }
  const metrics = new GuardianMetrics();
  // Fail boot before opening listeners/workers when retention env is invalid.
  const webhookRetention = webhookRetentionOptionsFromEnvironment(process.env);
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
  const dastSession = createDastSessionService({
    store,
    environment: process.env,
    authorizeRepository: async (repositoryName, repositoryId) => {
      const repository = await store.getRepository(repositoryId);
      if (
        repository?.repositoryState !== "active" ||
        repository.fullName.toLowerCase() !== repositoryName.toLowerCase()
      ) {
        return undefined;
      }
      return {
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch
      };
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
  let cleanupPromise: Promise<void> | undefined;
  // Dedicated controller so shutdown can cancel the long cleanup sleep immediately.
  const cleanupAbort = new AbortController();
  // Separate controller so shutdown can cancel in-flight backend review work. The signal is
  // threaded into the owned handler (not raced against it), so the worker settles before the
  // lease is released and no detached review continues mutating GitHub/store.
  const webhookAbort = new AbortController();

  async function workerLoop(): Promise<void> {
    while (!shuttingDown) {
      lastWorkerPollAt = Date.now();
      const processed = await service.processNextWebhook(workerId, webhookAbort.signal);
      if (processed || shuttingDown) continue;
      try {
        await delay(1000, undefined, { signal: webhookAbort.signal });
      } catch (error) {
        // Normal on SIGTERM/SIGINT: cancel the idle poll so the worker settles promptly.
        if (error instanceof Error && error.name === "AbortError") return;
        throw error;
      }
    }
  }

  async function webhookCleanupLoop(): Promise<void> {
    while (!shuttingDown) {
      const now = Date.now();
      try {
        const result = await store.purgeTerminalWebhookJobs({
          succeededBefore: new Date(now - webhookRetention.succeededRetentionMs),
          deadLetterBefore: new Date(now - webhookRetention.deadLetterRetentionMs),
          limit: webhookRetention.batchLimit
        });
        if (result.deleted > 0) {
          metrics.increment("webhook_cleanup_deleted_total", result.deleted);
        }
      } catch (error) {
        metrics.increment("webhook_cleanup_failures_total");
        console.error(
          JSON.stringify({
            event: "guardianbot.webhook_cleanup_failed",
            error: boundedErrorKind(error)
          })
        );
      }
      try {
        await service.refreshQueueMetrics(new Date(now));
      } catch {
        // Scrape path remains fail-closed; cleanup must not crash the worker.
      }
      try {
        await delay(webhookRetention.cleanupIntervalMs, undefined, {
          signal: cleanupAbort.signal
        });
      } catch (error) {
        // Normal on SIGTERM/SIGINT: cancel the sleep so the process can exit promptly.
        if (error instanceof Error && error.name === "AbortError") return;
        throw error;
      }
    }
  }

  workerPromise = workerLoop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  cleanupPromise = webhookCleanupLoop().catch((error) => {
    // Abort during shutdown is expected; never fail the process for cleanup alone.
    if (error instanceof Error && error.name === "AbortError") return;
    console.error(
      JSON.stringify({
        event: "guardianbot.webhook_cleanup_loop_failed",
        error: boundedErrorKind(error)
      })
    );
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
      try {
        // Scrape-time store refresh is authoritative across multi-instance deploys.
        await service.refreshQueueMetrics();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "guardianbot.metrics_queue_refresh_failed",
            error: boundedErrorKind(error)
          })
        );
        response
          .writeHead(503, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "queue metrics unavailable" }));
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
    if (request.method === "POST" && request.url === "/dast/session") {
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
        const session = await dastSession.issue(
          request.headers.authorization,
          payload
        );
        response
          .writeHead(200, {
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json",
            pragma: "no-cache"
          })
          .end(JSON.stringify(session));
      } catch (error) {
        const status =
          error instanceof DastSessionError ? error.statusCode : 400;
        const failure =
          error instanceof DastSessionError
            ? error.message
            : "invalid DAST session request";
        console.warn(
          JSON.stringify({
            event: "guardianbot.dast_session_rejected",
            status,
            failure
          })
        );
        response
          .writeHead(status, {
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json",
            pragma: "no-cache"
          })
          .end(
            JSON.stringify({
              error: failure
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
    try {
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
    } catch {
      // A client abort or reset rejects the request iterator. The socket is already
      // gone, so there is nothing to answer; returning keeps the rejection from
      // escaping this async handler and terminating the process.
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    let payload: Record<string, any>;
    try {
      service.authenticate(
        body,
        request.headers["x-hub-signature-256"] as string | undefined,
        String(request.headers["x-github-delivery"] ?? "")
      );
      payload = JSON.parse(body);
    } catch (error) {
      // Fixed strings only: this caller is unauthenticated, so it learns nothing
      // beyond which of the two checks rejected it.
      const status = error instanceof WebhookAuthenticationError ? error.statusCode : 400;
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            error: status === 401 ? "invalid webhook signature" : "invalid webhook request"
          })
        );
      return;
    }
    try {
      await service.enqueue(
        String(request.headers["x-github-event"]),
        payload,
        String(request.headers["x-github-delivery"] ?? "")
      );
      response.writeHead(202).end();
    } catch (error) {
      // Our own fault, not the sender's: answer 5xx so GitHub redelivers.
      console.error(
        JSON.stringify({
          event: "guardianbot.webhook_enqueue_failed",
          error: boundedErrorKind(error)
        })
      );
      response
        .writeHead(503, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "webhook queue unavailable" }));
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "0.0.0.0");

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupAbort.abort();
    // Abort in-flight backend review work so the owned handler can settle and requeue the
    // delivery without consuming its attempt budget.
    webhookAbort.abort();
    server.close();
    server.closeIdleConnections();
    let drained = false;
    const settled = Promise.all([workerPromise, cleanupPromise, monitoring.stop()]).then(
      () => {
        drained = true;
      },
      () => {
        drained = true;
      }
    );
    // The budget timer is cancellable so a prompt drain does not hold the event loop
    // open for the remainder of the window.
    const drainAbort = new AbortController();
    const budget = delay(DRAIN_BUDGET_MS, undefined, { signal: drainAbort.signal }).catch(
      () => {}
    );
    await Promise.race([settled, budget]);
    drainAbort.abort();
    // The worker needs the store to record its lease release, so only close once it
    // has actually settled; on a blown budget the exiting process reclaims it.
    if (drained) await store.close();
    if (signal) process.exitCode = process.exitCode ?? 0;
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  // Defence in depth for the async request handlers: Node's default is to terminate on
  // an unhandled rejection, which would abandon every leased delivery mid-flight.
  process.on("unhandledRejection", (reason) => {
    console.error(
      JSON.stringify({
        event: "guardianbot.unhandled_rejection",
        error: boundedErrorKind(reason)
      })
    );
    process.exitCode = 1;
    void shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    console.error(
      JSON.stringify({
        event: "guardianbot.uncaught_exception",
        error: boundedErrorKind(error)
      })
    );
    process.exitCode = 1;
    void shutdown("uncaughtException");
  });
}

/** Bound production logs to error kind/name only — never raw driver messages. */
function boundedErrorKind(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : "UnknownError";
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
