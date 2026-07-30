import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_WEBHOOK_CLEANUP_BATCH_LIMIT,
  MemoryStore,
  WEBHOOK_QUEUE_COUNTS_SQL,
  WEBHOOK_TERMINAL_PURGE_SQL,
  postgresPoolConfig,
  webhookRetentionOptionsFromEnvironment
} from "../src/store.js";

test("keeps local PostgreSQL connection configuration unchanged without a managed CA", () => {
  const connectionString = "postgresql://guardianbot:secret@postgres:5432/guardianbot";
  const config = postgresPoolConfig(connectionString);

  assert.equal(config.connectionString, connectionString);
  assert.equal(config.ssl, undefined);
  assert.equal(config.application_name, "guardianbot-control-plane");
});

test("pins managed PostgreSQL TLS to the supplied CA and removes weaker URL modes", () => {
  const config = postgresPoolConfig(
    "postgresql://guardianbot:secret@db.example:25060/guardianbot?sslmode=no-verify&uselibpqcompat=true",
    "-----BEGIN CERTIFICATE-----\\ncertificate-data\\n-----END CERTIFICATE-----\\n"
  );

  assert.equal(
    config.connectionString,
    "postgresql://guardianbot:secret@db.example:25060/guardianbot"
  );
  assert.deepEqual(config.ssl, {
    ca: "-----BEGIN CERTIFICATE-----\ncertificate-data\n-----END CERTIFICATE-----",
    rejectUnauthorized: true
  });
});

test("rejects a non-PostgreSQL URL when a managed CA is configured", () => {
  assert.throws(
    () => postgresPoolConfig("https://db.example/guardianbot", "managed-ca"),
    /postgres or postgresql/
  );
});

test("Postgres webhook queue count SQL is parameterized and status-aware", () => {
  assert.match(WEBHOOK_QUEUE_COUNTS_SQL, /\$1/);
  assert.match(WEBHOOK_QUEUE_COUNTS_SQL, /status = 'pending'/);
  assert.match(WEBHOOK_QUEUE_COUNTS_SQL, /status = 'leased'/);
  assert.match(WEBHOOK_QUEUE_COUNTS_SQL, /status = 'dead-letter'/);
  assert.match(WEBHOOK_QUEUE_COUNTS_SQL, /available_at <= \$1/);
  assert.match(WEBHOOK_QUEUE_COUNTS_SQL, /lease_expires_at/);
  assert.doesNotMatch(WEBHOOK_QUEUE_COUNTS_SQL, /\$\{/);
});

test("Postgres terminal purge SQL is parameterized, bounded, and multi-instance safe", () => {
  assert.match(WEBHOOK_TERMINAL_PURGE_SQL, /status = 'succeeded'/);
  assert.match(WEBHOOK_TERMINAL_PURGE_SQL, /status = 'dead-letter'/);
  assert.match(WEBHOOK_TERMINAL_PURGE_SQL, /LIMIT \$3/);
  assert.match(WEBHOOK_TERMINAL_PURGE_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(WEBHOOK_TERMINAL_PURGE_SQL, /\$1/);
  assert.match(WEBHOOK_TERMINAL_PURGE_SQL, /\$2/);
  assert.doesNotMatch(WEBHOOK_TERMINAL_PURGE_SQL, /status = 'pending'/);
  assert.doesNotMatch(WEBHOOK_TERMINAL_PURGE_SQL, /status = 'leased'/);
  assert.doesNotMatch(WEBHOOK_TERMINAL_PURGE_SQL, /\$\{/);
});

test("webhook retention env uses safe defaults and rejects invalid bounds", () => {
  const defaults = webhookRetentionOptionsFromEnvironment({});
  assert.equal(defaults.succeededRetentionMs, 7 * 24 * 60 * 60_000);
  assert.equal(defaults.deadLetterRetentionMs, 30 * 24 * 60 * 60_000);
  assert.equal(defaults.cleanupIntervalMs, 60 * 60_000);
  assert.equal(defaults.batchLimit, 1000);

  assert.throws(
    () =>
      webhookRetentionOptionsFromEnvironment({
        GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS: "0"
      }),
    /GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS/
  );
  assert.throws(
    () =>
      webhookRetentionOptionsFromEnvironment({
        GUARDIANBOT_WEBHOOK_CLEANUP_BATCH_LIMIT: "10001"
      }),
    /GUARDIANBOT_WEBHOOK_CLEANUP_BATCH_LIMIT/
  );
  assert.throws(
    () =>
      webhookRetentionOptionsFromEnvironment({
        GUARDIANBOT_WEBHOOK_CLEANUP_INTERVAL_MS: "not-a-number"
      }),
    /GUARDIANBOT_WEBHOOK_CLEANUP_INTERVAL_MS/
  );
  assert.throws(
    () =>
      webhookRetentionOptionsFromEnvironment({
        GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS: String(14 * 24 * 60 * 60_000),
        GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS: String(7 * 24 * 60 * 60_000)
      }),
    /GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS must be greater than or equal to GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS/
  );
  // Equal retention remains valid.
  const equal = webhookRetentionOptionsFromEnvironment({
    GUARDIANBOT_WEBHOOK_SUCCEEDED_RETENTION_MS: String(7 * 24 * 60 * 60_000),
    GUARDIANBOT_WEBHOOK_DEAD_LETTER_RETENTION_MS: String(7 * 24 * 60 * 60_000)
  });
  assert.equal(equal.succeededRetentionMs, equal.deadLetterRetentionMs);
});

test("MemoryStore counts pending, leased, runnable, and dead-letter jobs", async () => {
  const store = new MemoryStore();
  const now = new Date("2026-07-30T12:00:00.000Z");

  assert.deepEqual(await store.countWebhookJobs(now), {
    pending: 0,
    leased: 0,
    deadLetter: 0,
    runnable: 0
  });

  assert.equal(await store.enqueueWebhook("a", "ping", { n: 1 }), true);
  assert.equal(await store.enqueueWebhook("b", "ping", { n: 2 }), true);
  assert.deepEqual(await store.countWebhookJobs(now), {
    pending: 2,
    leased: 0,
    deadLetter: 0,
    runnable: 2
  });

  const leased = await store.claimWebhook("worker-1", 60_000, now);
  assert.equal(leased?.deliveryId, "a");
  assert.deepEqual(await store.countWebhookJobs(now), {
    pending: 1,
    leased: 1,
    deadLetter: 0,
    runnable: 1
  });

  const afterLeaseExpiry = new Date(now.getTime() + 61_000);
  assert.deepEqual(await store.countWebhookJobs(afterLeaseExpiry), {
    pending: 1,
    leased: 1,
    deadLetter: 0,
    runnable: 2
  });

  await store.completeWebhook("a", "worker-1");
  assert.deepEqual(await store.countWebhookJobs(afterLeaseExpiry), {
    pending: 1,
    leased: 0,
    deadLetter: 0,
    runnable: 1
  });

  const second = await store.claimWebhook("worker-1", 60_000, afterLeaseExpiry);
  assert.equal(second?.deliveryId, "b");
  await store.failWebhook("b", "worker-1", "boom", undefined, true);
  assert.deepEqual(await store.countWebhookJobs(afterLeaseExpiry), {
    pending: 0,
    leased: 0,
    deadLetter: 1,
    runnable: 0
  });
});

test("MemoryStore purge deletes only old terminal jobs within the batch limit", async () => {
  const store = new MemoryStore();
  const now = new Date("2026-07-30T12:00:00.000Z");

  assert.equal(await store.enqueueWebhook("pending-live", "ping", {}), true);
  assert.equal(await store.enqueueWebhook("leased-live", "ping", {}), true);
  assert.equal(await store.enqueueWebhook("old-success", "ping", {}), true);
  assert.equal(await store.enqueueWebhook("recent-success", "ping", {}), true);
  assert.equal(await store.enqueueWebhook("old-dead", "ping", {}), true);
  assert.equal(await store.enqueueWebhook("recent-dead", "ping", {}), true);
  assert.equal(await store.enqueueWebhook("old-success-2", "ping", {}), true);

  await store.claimWebhook("worker-1", 60_000, now);

  const forceTerminal = async (
    deliveryId: string,
    status: "succeeded" | "dead-letter",
    updatedAt: string
  ) => {
    const job = await store.getWebhook(deliveryId);
    assert.ok(job);
    // Direct map mutation keeps production APIs free of test-only setters.
    (store as any).webhooks.set(deliveryId, {
      ...job,
      status,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      deadLetteredAt: status === "dead-letter" ? updatedAt : undefined,
      updatedAt
    });
  };

  await forceTerminal("old-success", "succeeded", "2026-07-01T00:00:00.000Z");
  await forceTerminal("old-success-2", "succeeded", "2026-07-02T00:00:00.000Z");
  await forceTerminal("recent-success", "succeeded", "2026-07-29T00:00:00.000Z");
  await forceTerminal("old-dead", "dead-letter", "2026-06-01T00:00:00.000Z");
  await forceTerminal("recent-dead", "dead-letter", "2026-07-29T00:00:00.000Z");

  const first = await store.purgeTerminalWebhookJobs({
    succeededBefore: new Date("2026-07-20T00:00:00.000Z"),
    deadLetterBefore: new Date("2026-07-10T00:00:00.000Z"),
    limit: 2
  });
  assert.equal(first.deleted, 2);
  assert.equal(await store.getWebhook("old-success"), undefined);
  assert.equal(await store.getWebhook("old-dead"), undefined);
  assert.ok(await store.getWebhook("old-success-2"));
  assert.ok(await store.getWebhook("recent-success"));
  assert.ok(await store.getWebhook("recent-dead"));
  assert.ok(await store.getWebhook("pending-live"));
  assert.ok(await store.getWebhook("leased-live"));

  const second = await store.purgeTerminalWebhookJobs({
    succeededBefore: new Date("2026-07-20T00:00:00.000Z"),
    deadLetterBefore: new Date("2026-07-10T00:00:00.000Z"),
    limit: 10
  });
  assert.equal(second.deleted, 1);
  assert.equal(await store.getWebhook("old-success-2"), undefined);
  assert.ok(await store.getWebhook("recent-success"));
  assert.ok(await store.getWebhook("recent-dead"));
  assert.ok(await store.getWebhook("pending-live"));
  assert.equal((await store.getWebhook("leased-live"))?.status, "leased");
});

test("MemoryStore purge rejects non-integer, sub-1, and over-cap limits", async () => {
  const store = new MemoryStore();
  const options = {
    succeededBefore: new Date("2026-07-20T00:00:00.000Z"),
    deadLetterBefore: new Date("2026-07-10T00:00:00.000Z")
  };
  await assert.rejects(
    () => store.purgeTerminalWebhookJobs({ ...options, limit: 0 }),
    /purge limit must be a safe integer/
  );
  await assert.rejects(
    () => store.purgeTerminalWebhookJobs({ ...options, limit: 1.5 }),
    /purge limit must be a safe integer/
  );
  await assert.rejects(
    () =>
      store.purgeTerminalWebhookJobs({
        ...options,
        limit: MAX_WEBHOOK_CLEANUP_BATCH_LIMIT + 1
      }),
    /purge limit must be a safe integer/
  );
});

test("cleanup loop source cancels sleep on shutdown and bounds error logs", () => {
  const serverSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts"),
    "utf8"
  );
  assert.match(serverSource, /const cleanupAbort = new AbortController\(\)/);
  assert.match(serverSource, /signal:\s*cleanupAbort\.signal/);
  assert.match(serverSource, /error\.name === "AbortError"/);
  assert.match(serverSource, /boundedErrorKind\(error\)/);
  // Shutdown must abort the cleanup sleep before awaiting the loop promise.
  assert.match(
    serverSource,
    /async function shutdown\([\s\S]*?cleanupAbort\.abort\(\);[\s\S]*?cleanupPromise/
  );
  assert.doesNotMatch(
    serverSource,
    /event: "guardianbot\.webhook_cleanup_failed"[\s\S]{0,120}error\.message/
  );
  assert.doesNotMatch(
    serverSource,
    /event: "guardianbot\.metrics_queue_refresh_failed"[\s\S]{0,120}error\.message/
  );
});
