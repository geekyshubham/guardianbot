import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts"),
  "utf8"
);

/** The webhook body read, up to the first statement after the loop. */
function webhookBodyRead(): string {
  const start = serverSource.indexOf('request.url !== "/webhooks/github"');
  assert.notEqual(start, -1, "webhook route not found");
  const end = serverSource.indexOf("Buffer.concat(chunks).toString", start);
  assert.notEqual(end, -1, "webhook body concat not found");
  return serverSource.slice(start, end);
}

test("webhook body read is guarded so a client abort cannot crash the process", () => {
  const section = webhookBodyRead();
  // A bare `for await (const chunk of request)` rejects on ECONNRESET, and an
  // unhandled rejection terminates the process under Node's default policy.
  assert.match(section, /try\s*\{[\s\S]*for await \(const chunk of request\)/);
  assert.match(section, /\}\s*catch[\s\S]*\{[\s\S]*return;/);
});

test("process level handlers keep an unhandled rejection from killing the worker", () => {
  assert.match(serverSource, /process\.on\("unhandledRejection"/);
  assert.match(serverSource, /process\.on\("uncaughtException"/);
  // Both must log a bounded error kind and drain through the graceful path.
  const rejection = serverSource.slice(
    serverSource.indexOf('process.on("unhandledRejection"')
  );
  assert.match(rejection, /boundedErrorKind\(reason\)/);
  assert.match(rejection, /void shutdown\("unhandledRejection"\)/);
});

test("webhook failures answer with fixed strings and redeliverable status codes", () => {
  const handler = serverSource.slice(serverSource.indexOf('"/webhooks/github"'));
  // No internal detail may reach an unauthenticated caller.
  assert.doesNotMatch(handler, /error\.message/);
  assert.doesNotMatch(handler, /String\(error\)\.includes/);
  // Auth failures are typed rather than substring matched.
  assert.match(handler, /error instanceof WebhookAuthenticationError\s*\?\s*error\.statusCode/);
  // Store failures are ours, so GitHub must be told to redeliver.
  assert.match(handler, /writeHead\(503/);
  assert.match(handler, /webhook queue unavailable/);
  assert.match(handler, /guardianbot\.webhook_enqueue_failed/);
});

test("shutdown cancels in-flight webhook work before closing the store", () => {
  assert.match(serverSource, /const webhookAbort = new AbortController\(\)/);
  assert.match(serverSource, /processNextWebhook\(workerId, webhookAbort\.signal\)/);
  const shutdown = serverSource.slice(serverSource.indexOf("async function shutdown("));
  assert.match(shutdown, /webhookAbort\.abort\(\);/);
  assert.match(shutdown, /server\.closeIdleConnections\(\);/);
  // The worker records its lease release through the store, so the close must wait, and a
  // blown budget must leave the connection alone for a still-live handler.
  assert.match(shutdown, /if \(!drained\) \{/);
  // Comments are stripped so this "must not appear" check cannot be satisfied by prose that
  // merely describes the call being skipped.
  const blownBudget = shutdown
    .slice(shutdown.indexOf("if (!drained) {"), shutdown.indexOf("server.closeAllConnections()"))
    .replaceAll(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(blownBudget, /store\.close\(\)/);
  assert.match(shutdown, /server\.closeAllConnections\(\);\n[\s\S]*await store\.close\(\);/);
  assert.match(
    shutdown,
    /webhookAbort\.abort\(\);[\s\S]*Promise\.race\([\s\S]*store\.close\(\)/
  );
  // Cancellation is cooperative through the owned handler — never Promise.race the whole handle.
  assert.match(serverSource, /threaded into the owned handler/);
});

test("drain budget exceeds the backend review timeout", () => {
  const match = /const DRAIN_BUDGET_MS = (\d[\d_]*);/.exec(serverSource);
  assert.ok(match, "DRAIN_BUDGET_MS not declared");
  assert.ok(Number(match[1]?.replaceAll("_", "")) > 90_000);
});
