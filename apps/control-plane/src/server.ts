import { createServer } from "node:http";
import { GuardianService } from "./service.js";
import { MemoryStore, PostgresStore, type Store } from "./store.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function start() {
  let store: Store;
  if (process.env.DATABASE_URL) {
    const postgres = new PostgresStore(process.env.DATABASE_URL);
    await postgres.migrate();
    store = postgres;
  } else {
    store = new MemoryStore();
  }
  const privateKey = required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const service = new GuardianService({
    appId: required("GITHUB_APP_ID"),
    privateKey,
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    modelBackendUrl: process.env.GUARDIAN_MODEL_BACKEND_URL,
    modelBackendToken: process.env.GUARDIAN_MODEL_BACKEND_TOKEN
  }, store);
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ready"}');
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" })
        .end("guardianbot_up 1\n");
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
      await service.handle(String(request.headers["x-github-event"]), JSON.parse(body));
      response.writeHead(202).end();
    } catch (error) {
      response.writeHead(String(error).includes("signature") ? 401 : 400, {
        "content-type": "application/json"
      }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
