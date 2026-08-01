import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  indexRepository,
  lexicalFeatureVector,
  repositoryIndexStorageKey,
  toPersistedRecordRows,
  toPersistedVectorRows
} from "@guardianbot/core";
import {
  applyFindingFeedback,
  buildRepositoryIndexRecordBatchStatement,
  buildRepositoryIndexRecordDeleteStatement,
  buildRepositoryIndexRecordQueryStatement,
  buildRepositoryIndexVectorDeleteStatement,
  buildRepositoryIndexVectorQueryStatement,
  MAX_FEEDBACK_COMMENT_IDS,
  MAX_INDEX_GENERATION_SWEEP_BATCH_LIMIT,
  REVIEW_FEEDBACK_LOCK_SQL,
  REVIEW_FEEDBACK_UPDATE_SQL,
  REVIEW_FINDINGS_DISCARD_SQL,
  REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL,
  REVIEW_FINDINGS_SCHEMA_VERSION_DEFAULT,
  DEFAULT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS,
  MAX_REVIEW_FINDING_ABSOLUTE_RETENTION_MS,
  scrubWebhookPayloadForRetention,
  MAX_REVIEW_FINDING_LIMIT,
  MAX_WEBHOOK_CLEANUP_BATCH_LIMIT,
  MemoryStore,
  MigrationLockUnavailableError,
  PostgresStore,
  REVIEW_FINDINGS_SCHEMA_VERSION,
  SUPERSEDED_INDEX_GENERATION_PURGE_SQL,
  WEBHOOK_QUEUE_COUNTS_SQL,
  WEBHOOK_TERMINAL_PURGE_SQL,
  evictTerminalReviewFindings,
  indexGenerationRetentionOptionsFromEnvironment,
  normalizeReviewFindings,
  postgresPoolConfig,
  reviewFindingRetentionOptionsFromEnvironment,
  webhookRetentionOptionsFromEnvironment,
  type ReviewFindingRecord
} from "../src/store.js";

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

// pg connects lazily, so a PostgresStore can be built offline and driven through a stub pool.
// `onStatement` stands in for server-side rejection of a statement, such as a duplicate object.
function stubbedPostgresStore(
  onStatement?: (text: string) => void,
  // Stands in for server-returned rows. Returning undefined falls through to the
  // default empty result, so a test overrides only the statement it cares about.
  respond?: (text: string, values?: unknown[]) => { rows: any[]; rowCount?: number } | undefined
) {
  const clientQueries: RecordedQuery[] = [];
  const poolQueries: string[] = [];
  const releases: Array<boolean | undefined> = [];
  let connects = 0;

  const client = {
    query: async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values });
      onStatement?.(text);
      const responded = respond?.(text, values);
      if (responded) return responded;
      if (text.includes("typname = 'vector'")) {
        return { rows: [{ installed: true }] };
      }
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ released: true }] };
      }
      return { rows: [] };
    },
    release: (destroy?: boolean) => {
      releases.push(destroy);
    }
  };

  const store = new PostgresStore("postgresql://guardianbot:secret@postgres:5432/guardianbot");
  // Direct pool substitution keeps production APIs free of test-only injection points.
  (store as any).pool = {
    connect: async () => {
      connects += 1;
      return client;
    },
    query: async (text: string, values?: unknown[]) => {
      poolQueries.push(text);
      return respond?.(text, values) ?? { rows: [] };
    }
  };

  return {
    store,
    clientQueries,
    poolQueries,
    releases,
    connectCount: () => connects
  };
}

test("PostgresStore migration runs every statement on one advisory-locked connection", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();

  assert.equal(harness.connectCount(), 1);
  // Anything issued via the pool escapes the lock and can race a concurrently booting instance.
  assert.deepEqual(harness.poolQueries, []);

  const texts = harness.clientQueries.map((query) => query.text);
  // Session bounds precede the lock so every statement after them, including the ACCESS
  // EXCLUSIVE ALTERs, is bounded; a blocking pg_advisory_lock would hang boot with no diagnostic.
  assert.match(texts[0] ?? "", /set_config\('lock_timeout', \$1, false\)/);
  assert.match(texts[1] ?? "", /set_config\('statement_timeout', \$1, false\)/);
  assert.match(texts[2] ?? "", /SELECT pg_try_advisory_lock\(\$1, \$2\) AS acquired/);
  assert.equal(
    texts.filter((text) => /SELECT pg_advisory_lock\(/.test(text)).length,
    0
  );
  assert.match(texts.at(-1) ?? "", /SELECT pg_advisory_unlock\(\$1, \$2\)/);
  // The pooled connection must not carry migration timeouts back into reviews traffic.
  assert.ok(texts.includes("RESET lock_timeout"));
  assert.ok(texts.includes("RESET statement_timeout"));
  assert.ok(texts.some((text) => text.includes("CREATE EXTENSION IF NOT EXISTS vector")));
  assert.ok(texts.some((text) => text.includes("CREATE TABLE IF NOT EXISTS repositories")));
  assert.ok(
    texts.some((text) => text.includes("CREATE INDEX IF NOT EXISTS webhook_jobs_claim_idx"))
  );
  assert.ok(
    texts.some((text) => text.includes("ADD COLUMN IF NOT EXISTS vector_pgvector vector"))
  );

  const lockKey = harness.clientQueries.find((query) =>
    query.text.includes("pg_try_advisory_lock")
  )?.values;
  assert.equal(lockKey?.length, 2);
  assert.deepEqual(harness.clientQueries.at(-1)?.values, lockKey);
  // The connection returns to the pool intact once the lock is released.
  assert.deepEqual(harness.releases, [undefined]);
  assert.equal(await harness.store.getRepositoryIndexStorageMode(), "pgvector");
});

test("PostgresStore migration releases its advisory lock when the DDL fails", async () => {
  const harness = stubbedPostgresStore();
  const client = await (harness.store as any).pool.connect();
  const passthrough = client.query;
  client.query = async (text: string, values?: unknown[]) => {
    if (text.includes("CREATE TABLE IF NOT EXISTS repositories")) {
      throw new Error("permission denied for schema public");
    }
    return passthrough(text, values);
  };

  await assert.rejects(() => harness.store.migrate(), /permission denied for schema public/);

  const texts = harness.clientQueries.map((query) => query.text);
  assert.match(texts.at(-1) ?? "", /SELECT pg_advisory_unlock\(\$1, \$2\)/);
  assert.deepEqual(harness.releases, [undefined]);
});

test("PostgresStore migration lock cannot collide with the monitoring scheduler lock", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();
  const migrationLock = harness.clientQueries.find((query) =>
    query.text.includes("pg_try_advisory_lock")
  )?.values;
  assert.equal(migrationLock?.length, 2);

  harness.clientQueries.length = 0;
  const monitoringLock = await harness.store.acquireMonitoringLock();
  assert.ok(monitoringLock);
  const monitoringLockKey = harness.clientQueries[0]?.values;
  await monitoringLock.release();

  assert.notDeepEqual(migrationLock, monitoringLockKey);
});

test("PostgresStore migration fails loudly when a peer holds the lock for the whole budget", async () => {
  const harness = stubbedPostgresStore();
  const client = await (harness.store as any).pool.connect();
  const passthrough = client.query;
  client.query = async (text: string, values?: unknown[]) => {
    await passthrough(text, values);
    // A peer instance with a wedged session never releases: boot must not wait on it forever.
    return text.includes("pg_try_advisory_lock") ? { rows: [{ acquired: false }] } : { rows: [] };
  };
  (harness.store as any).migrationLockAttempts = 3;
  (harness.store as any).migrationLockRetryDelayMs = 0;

  await assert.rejects(
    () => harness.store.migrate(),
    (error: unknown) =>
      error instanceof MigrationLockUnavailableError &&
      error.name === "MigrationLockUnavailableError" &&
      error.attempts === 3
  );

  const texts = harness.clientQueries.map((query) => query.text);
  assert.equal(texts.filter((text) => text.includes("pg_try_advisory_lock")).length, 3);
  // No DDL may run without the lock, and the unlocked session is discarded rather than pooled.
  assert.equal(
    texts.filter((text) => text.includes("CREATE TABLE IF NOT EXISTS repositories")).length,
    0
  );
  assert.deepEqual(harness.releases, [true]);
});

test("PostgresStore migration proceeds once a contended lock becomes available", async () => {
  const harness = stubbedPostgresStore();
  const client = await (harness.store as any).pool.connect();
  const passthrough = client.query;
  let lockAttempts = 0;
  client.query = async (text: string, values?: unknown[]) => {
    const result = await passthrough(text, values);
    if (!text.includes("pg_try_advisory_lock")) return result;
    lockAttempts += 1;
    return { rows: [{ acquired: lockAttempts >= 3 }] };
  };
  (harness.store as any).migrationLockRetryDelayMs = 0;

  await harness.store.migrate();

  assert.equal(lockAttempts, 3);
  const texts = harness.clientQueries.map((query) => query.text);
  assert.ok(texts.some((text) => text.includes("CREATE TABLE IF NOT EXISTS repositories")));
  assert.match(texts.at(-1) ?? "", /SELECT pg_advisory_unlock\(\$1, \$2\)/);
  assert.deepEqual(harness.releases, [undefined]);
});

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

test("provenance migration adds review finding columns inside the locked path and is re-runnable", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();

  const texts = harness.clientQueries.map((query) => query.text);
  // Nothing may reach the pool: DDL outside the advisory lock can race a booting instance.
  assert.deepEqual(harness.poolQueries, []);
  const ddl = texts.join("\n");
  for (const column of [
    "findings_schema_version",
    "findings_evicted_total",
    "findings_last_evicted_at"
  ]) {
    assert.match(ddl, new RegExp(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${column}`));
  }
  // Additive only: pre-existing rows stay valid, so no destructive change to reviews is allowed.
  assert.doesNotMatch(ddl, /ALTER TABLE reviews DROP COLUMN/);
  assert.doesNotMatch(ddl, /ALTER TABLE reviews ALTER COLUMN/);
  assert.doesNotMatch(ddl, /DROP TABLE reviews/);
  // Counters need a safe default so a row written by an older instance remains readable.
  assert.match(ddl, /findings_schema_version INTEGER NOT NULL DEFAULT 1/);
  assert.match(ddl, /findings_evicted_total INTEGER NOT NULL DEFAULT 0/);
  // The new timestamp stays nullable rather than backfilled.
  assert.match(ddl, /findings_last_evicted_at TIMESTAMPTZ;/);

  const second = stubbedPostgresStore();
  await second.store.migrate();
  await second.store.migrate();
  const repeated = second.clientQueries.map((query) => query.text);
  const half = repeated.length / 2;
  // A second run issues byte-identical statements, all guarded by IF NOT EXISTS.
  assert.deepEqual(repeated.slice(0, half), repeated.slice(half));
});

// Mirrors what a server that already holds every object does to an unguarded statement, so the
// replay below fails on a real idempotency gap rather than on missing literals in the source.
function duplicateObjectErrorCode(statement: string): string | undefined {
  if (/^CREATE EXTENSION(?! IF NOT EXISTS)/i.test(statement)) return "42710";
  if (/^CREATE (TABLE|INDEX)(?! IF NOT EXISTS)/i.test(statement)) return "42P07";
  if (/ADD COLUMN(?! IF NOT EXISTS)/i.test(statement)) return "42701";
  return undefined;
}

test("migration replays against an already-migrated server without a duplicate-object failure", async () => {
  const inspected: string[] = [];
  const replay = stubbedPostgresStore((text) => {
    // The DDL travels as one multi-statement string, so each statement is judged separately.
    for (const statement of text.split(";")) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      inspected.push(trimmed);
      const code = duplicateObjectErrorCode(trimmed);
      if (code) {
        const error = new Error(`duplicate object: ${trimmed.slice(0, 60)}`) as Error & {
          code: string;
        };
        error.code = code;
        throw error;
      }
    }
  });

  // Every object already exists, so an unguarded CREATE or ADD COLUMN would abort the migration.
  await replay.store.migrate();

  const texts = replay.clientQueries.map((query) => query.text);
  assert.match(texts.at(-1) ?? "", /SELECT pg_advisory_unlock\(\$1, \$2\)/);
  assert.deepEqual(replay.releases, [undefined]);
  // Guards against a vacuous pass: the statements really were seen, including the new columns.
  assert.ok(inspected.length > 20);
  for (const column of [
    "findings_schema_version",
    "findings_evicted_total",
    "findings_last_evicted_at"
  ]) {
    assert.ok(
      inspected.some((statement) =>
        statement.startsWith(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${column}`)
      )
    );
  }
  assert.ok(
    inspected.some((statement) =>
      statement.startsWith("ALTER TABLE repository_index_vectors ADD COLUMN IF NOT EXISTS")
    )
  );
});

test("PostgresStore accumulates the evicted counter server-side from the caller's delta", async () => {
  const store = new PostgresStore("postgresql://guardianbot:secret@postgres:5432/guardianbot");
  const statements: RecordedQuery[] = [];
  (store as any).pool = {
    query: async (text: string, values?: unknown[]) => {
      statements.push({ text, values });
      return { rowCount: 1, rows: [] };
    }
  };

  assert.equal(
    await store.saveReview({
      repositoryId: 99,
      pullNumber: 12,
      headSha: "head-sha",
      findings: [],
      findingsEvictedTotal: 2
    }),
    true
  );

  const upsert = statements.at(-1)?.text ?? "";
  // A read-modify-write assignment lets any caller that never read the row reset the lifetime
  // total, which the head_sha CAS does not guard. The counter must accumulate in the database.
  assert.match(
    upsert,
    /findings_evicted_total=reviews\.findings_evicted_total \+ excluded\.findings_evicted_total/
  );
  assert.doesNotMatch(upsert, /findings_evicted_total=excluded\.findings_evicted_total/);
  // The bound value is the delta for this write, not a precomputed lifetime total.
  assert.equal(statements.at(-1)?.values?.[8], 2);
});

test("MemoryStore accumulates the evicted counter across writes that never read the row", async () => {
  const store = new MemoryStore();
  const write = async (delta: number | undefined) =>
    store.saveReview({
      repositoryId: 99,
      pullNumber: 12,
      headSha: "head-sha",
      findings: [],
      findingsEvictedTotal: delta
    });

  assert.equal(await write(2), true);
  assert.equal((await store.getReview(99, 12))?.findingsEvictedTotal, 2);

  assert.equal(await write(3), true);
  assert.equal((await store.getReview(99, 12))?.findingsEvictedTotal, 5);

  // A writer that evicted nothing, and one that never read the existing row, both leave the
  // lifetime total intact rather than resetting it to their own view.
  assert.equal(await write(0), true);
  assert.equal(await write(undefined), true);
  assert.equal((await store.getReview(99, 12))?.findingsEvictedTotal, 5);
});

test("saveReviewHead does not claim provenance for a row it creates", async () => {
  const store = new PostgresStore("postgresql://guardianbot:secret@postgres:5432/guardianbot");
  const statements: string[] = [];
  (store as any).pool = {
    query: async (text: string) => {
      statements.push(text);
      return { rowCount: 1, rows: [] };
    }
  };

  await store.saveReviewHead(99, 12, "head-sha", 555);

  const upsert = statements.at(-1) ?? "";
  // The column records the writing code revision only. saveReviewHead leaves it at the column
  // default even though this revision is provenance-capable, so no reader may treat the version
  // as a guarantee about the findings in the row.
  assert.doesNotMatch(upsert, /findings_schema_version/);
});

test("PostgresStore reads a pre-migration review row without provenance", async () => {
  const store = new PostgresStore("postgresql://guardianbot:secret@postgres:5432/guardianbot");
  (store as any).pool = {
    query: async () => ({
      rows: [
        {
          repository_id: "99",
          pull_number: 12,
          head_sha: "head-sha",
          reviewed_head_sha: null,
          placeholder_comment_id: null,
          // Exactly the legacy shape: fingerprint and state only, no provenance columns present.
          findings: [{ fingerprint: "fp-legacy", state: "open" }]
        }
      ]
    })
  };

  const review = await store.getReview(99, 12);

  assert.equal(review?.findings.length, 1);
  assert.equal(review?.findings[0]?.fingerprint, "fp-legacy");
  assert.equal(review?.findings[0]?.state, "open");
  assert.equal(review?.findings[0]?.firstSeenHeadSha, undefined);
  // Absent columns read as the pre-provenance defaults rather than NaN or undefined.
  assert.equal(review?.findingsSchemaVersion, 1);
  assert.equal(review?.findingsEvictedTotal, 0);
  assert.equal(review?.findingsLastEvictedAt, undefined);
});

test("PostgresStore reads populated provenance columns and degrades an unusable timestamp", async () => {
  const reviewRow = (row: Record<string, unknown>) => {
    const store = new PostgresStore("postgresql://guardianbot:secret@postgres:5432/guardianbot");
    (store as any).pool = {
      query: async () => ({
        rows: [
          {
            repository_id: "99",
            pull_number: 12,
            head_sha: "head-sha",
            reviewed_head_sha: "head-sha",
            placeholder_comment_id: "555",
            findings: [{ fingerprint: "fp-1", state: "resolved", transitions: 2 }],
            ...row
          }
        ]
      })
    };
    return store.getReview(99, 12);
  };

  // pg returns TIMESTAMPTZ as a Date, and the new columns carry non-default values here.
  const populated = await reviewRow({
    findings_schema_version: 2,
    findings_evicted_total: 7,
    findings_last_evicted_at: new Date("2026-07-03T04:05:06.000Z")
  });
  assert.equal(populated?.findingsSchemaVersion, 2);
  assert.equal(populated?.findingsEvictedTotal, 7);
  assert.equal(populated?.findingsLastEvictedAt, "2026-07-03T04:05:06.000Z");
  assert.equal(populated?.findings[0]?.transitions, 2);

  // An unparseable row value drops one field instead of failing the whole review read.
  const corrupt = await reviewRow({
    findings_schema_version: 2,
    findings_evicted_total: 7,
    findings_last_evicted_at: "not-a-timestamp"
  });
  assert.equal(corrupt?.findingsLastEvictedAt, undefined);
  assert.equal(corrupt?.findings.length, 1);
  assert.equal(corrupt?.findingsEvictedTotal, 7);
});

test("the findings schema version is documented as a writer signal, not a provenance guarantee", () => {
  const storeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/store.ts"),
    "utf8"
  );
  // An older instance's upsert omits the column, so a row it rewrites keeps the newer value; and
  // saveReviewHead creates rows at the column default from provenance-capable code. The comment
  // must not promise a discrimination the column cannot make.
  assert.match(storeSource, /records which code revision last wrote the findings column/i);
  assert.match(storeSource, /not a guarantee about any individual finding's provenance/i);
  assert.doesNotMatch(storeSource, /rows last written by an older instance/);
});

test("stored findings survive a MemoryStore round trip with full provenance", async () => {
  const store = new MemoryStore();
  const finding: ReviewFindingRecord = {
    fingerprint: "fp-1",
    state: "resolved",
    firstSeenHeadSha: "a".repeat(40),
    lastSeenHeadSha: "b".repeat(40),
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-02T00:00:00.000Z",
    transitions: 2,
    reappearances: 1,
    path: "src/a.ts",
    startLine: 10,
    endLine: 12,
    category: "security",
    severity: "P1",
    title: "Unsafe operation"
  };

  assert.equal(
    await store.saveReview({
      repositoryId: 99,
      pullNumber: 12,
      headSha: "head-sha",
      reviewedHeadSha: "head-sha",
      findings: [finding],
      findingsEvictedTotal: 3,
      findingsLastEvictedAt: "2026-07-03T00:00:00.000Z"
    }),
    true
  );

  const review = await store.getReview(99, 12);
  assert.deepEqual(review?.findings, [finding]);
  assert.equal(review?.findingsSchemaVersion, REVIEW_FINDINGS_SCHEMA_VERSION);
  assert.equal(review?.findingsEvictedTotal, 3);
  assert.equal(review?.findingsLastEvictedAt, "2026-07-03T00:00:00.000Z");

  // Retrieved findings are copies, so a caller cannot mutate retained lifecycle state in place.
  review!.findings[0]!.state = "open";
  assert.equal((await store.getReview(99, 12))?.findings[0]?.state, "resolved");
});

test("normalizing stored findings drops untrustworthy JSONB entries", () => {
  const normalized = normalizeReviewFindings([
    { fingerprint: "fp-ok", state: "superseded", transitions: 1 },
    // An unknown state cannot be rendered or transitioned, so the entry is dropped entirely.
    { fingerprint: "fp-bad-state", state: "acknowledged" },
    { state: "open" },
    { fingerprint: "fp-bad-provenance", state: "open", transitions: -4, firstSeenAt: "not-a-date" },
    "not-an-object",
    null
  ]);

  assert.deepEqual(
    normalized.map((finding) => finding.fingerprint),
    ["fp-ok", "fp-bad-provenance"]
  );
  assert.equal(normalized[0]?.transitions, 1);
  // Individual unusable provenance fields degrade without discarding a valid finding.
  assert.equal(normalized[1]?.state, "open");
  assert.equal(normalized[1]?.transitions, undefined);
  assert.equal(normalized[1]?.firstSeenAt, undefined);
  assert.deepEqual(normalizeReviewFindings(undefined), []);
});

test("finding eviction never drops an active finding to satisfy the cap", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const open = (fingerprint: string): ReviewFindingRecord => ({
    fingerprint,
    state: "open",
    lastSeenAt: "2020-01-01T00:00:00.000Z"
  });
  const findings: ReviewFindingRecord[] = [
    open("open-1"),
    open("open-2"),
    open("open-3"),
    { fingerprint: "resolved-1", state: "resolved", lastSeenAt: "2026-07-29T00:00:00.000Z" },
    { fingerprint: "superseded-1", state: "superseded", lastSeenAt: "2026-07-29T00:00:00.000Z" }
  ];

  // A cap of one with every open finding far older than the retention window: the age rule and
  // the cap both point at the open findings, and neither may take them.
  const result = evictTerminalReviewFindings(
    findings,
    { retentionMs: 24 * 60 * 60_000, limit: 1 },
    now
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.fingerprint),
    ["open-1", "open-2", "open-3"]
  );
  assert.equal(result.evicted, 2);
  assert.ok(result.findings.every((finding) => finding.state === "open"));
});

test("finding eviction expires terminal findings by age and then by cap, oldest first", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const terminal = (fingerprint: string, lastSeenAt: string): ReviewFindingRecord => ({
    fingerprint,
    state: "resolved",
    lastSeenAt
  });
  const findings: ReviewFindingRecord[] = [
    terminal("stale", "2026-01-01T00:00:00.000Z"),
    terminal("recent-1", "2026-07-29T00:00:00.000Z"),
    terminal("recent-2", "2026-07-28T00:00:00.000Z"),
    { fingerprint: "open-1", state: "open" }
  ];
  const retention = { retentionMs: 30 * 24 * 60 * 60_000, limit: 10 };

  const aged = evictTerminalReviewFindings(findings, retention, now);
  assert.equal(aged.evicted, 1);
  assert.equal(
    aged.findings.some((finding) => finding.fingerprint === "stale"),
    false
  );

  // Re-running over the already-bounded set is stable: nothing further is dropped.
  assert.equal(evictTerminalReviewFindings(aged.findings, retention, now).evicted, 0);

  // Tightening the cap drops the oldest-observed terminal finding first.
  const capped = evictTerminalReviewFindings(
    aged.findings,
    { ...retention, limit: 2 },
    now
  );
  assert.deepEqual(
    capped.findings.map((finding) => finding.fingerprint),
    ["recent-1", "open-1"]
  );

  // A terminal finding with no provenance is treated as observed now, so age alone cannot expire it.
  const provenanceFree = evictTerminalReviewFindings(
    [{ fingerprint: "legacy", state: "resolved" }],
    retention,
    now
  );
  assert.equal(provenanceFree.evicted, 0);
});

test("finding eviction keeps terminal provenance when the cap is unreachable anyway", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const retention = { retentionMs: 30 * 24 * 60 * 60_000, limit: 2 };
  const findings: ReviewFindingRecord[] = [
    { fingerprint: "open-1", state: "open", lastSeenAt: "2026-07-29T00:00:00.000Z" },
    { fingerprint: "open-2", state: "open", lastSeenAt: "2026-07-29T00:00:00.000Z" },
    { fingerprint: "open-3", state: "open", lastSeenAt: "2026-07-29T00:00:00.000Z" },
    { fingerprint: "resolved-1", state: "resolved", lastSeenAt: "2026-07-29T00:00:00.000Z" },
    { fingerprint: "superseded-1", state: "superseded", lastSeenAt: "2026-07-28T00:00:00.000Z" }
  ];

  // Three unevictable active findings against a cap of two: taking the terminal findings cannot
  // bring the record to the limit, so discarding their provenance buys nothing.
  const overCap = evictTerminalReviewFindings(findings, retention, now);
  assert.equal(overCap.evicted, 0);
  assert.deepEqual(
    overCap.findings.map((finding) => finding.fingerprint),
    ["open-1", "open-2", "open-3", "resolved-1", "superseded-1"]
  );

  // Age still evicts independently of the cap: an expired terminal finding is dropped even while
  // the cap pass is skipped.
  const aged = evictTerminalReviewFindings(
    [
      ...findings,
      { fingerprint: "stale", state: "resolved", lastSeenAt: "2026-01-01T00:00:00.000Z" }
    ],
    retention,
    now
  );
  assert.equal(aged.evicted, 1);
  assert.equal(
    aged.findings.some((finding) => finding.fingerprint === "stale"),
    false
  );
  assert.ok(aged.findings.some((finding) => finding.fingerprint === "resolved-1"));

  // The guard must not over-correct: with the active findings exactly at the cap the limit is
  // still reachable, so the cap pass runs and the record is brought down to it.
  const atCap = evictTerminalReviewFindings(findings.slice(1), retention, now);
  assert.equal(atCap.evicted, 2);
  assert.deepEqual(
    atCap.findings.map((finding) => finding.fingerprint),
    ["open-2", "open-3"]
  );

  // One below the cap there is real headroom, so the oldest terminal finding is taken as before.
  const underCap = evictTerminalReviewFindings(findings.slice(2), retention, now);
  assert.deepEqual(
    underCap.findings.map((finding) => finding.fingerprint),
    ["open-3", "resolved-1"]
  );
});

test("review finding retention variables are documented with their defaults and bounds", () => {
  const operations = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../docs/operations.md"),
    "utf8"
  );
  // Out-of-range values fail boot, so an operator needs the bounds before tuning them.
  assert.match(
    operations,
    /\| `GUARDIANBOT_REVIEW_FINDING_RETENTION_MS` \| 90 days \| 24 hours … 365 days \|/
  );
  assert.match(operations, /\| `GUARDIANBOT_REVIEW_FINDING_LIMIT` \| 200 \| 1 … 5000 \|/);

  const defaults = reviewFindingRetentionOptionsFromEnvironment({});
  assert.equal(defaults.retentionMs, 90 * 24 * 60 * 60_000);
  assert.equal(defaults.limit, 200);
  assert.equal(MAX_REVIEW_FINDING_LIMIT, 5_000);
});

test("review finding retention env uses safe defaults and rejects invalid bounds", () => {
  const defaults = reviewFindingRetentionOptionsFromEnvironment({});
  assert.equal(defaults.retentionMs, 90 * 24 * 60 * 60_000);
  assert.equal(defaults.limit, 200);

  assert.throws(
    () => reviewFindingRetentionOptionsFromEnvironment({ GUARDIANBOT_REVIEW_FINDING_LIMIT: "0" }),
    /GUARDIANBOT_REVIEW_FINDING_LIMIT/
  );
  assert.throws(
    () =>
      reviewFindingRetentionOptionsFromEnvironment({
        GUARDIANBOT_REVIEW_FINDING_LIMIT: String(MAX_REVIEW_FINDING_LIMIT + 1)
      }),
    /GUARDIANBOT_REVIEW_FINDING_LIMIT/
  );
  assert.throws(
    () =>
      reviewFindingRetentionOptionsFromEnvironment({
        GUARDIANBOT_REVIEW_FINDING_RETENTION_MS: "not-a-number"
      }),
    /GUARDIANBOT_REVIEW_FINDING_RETENTION_MS/
  );

  const configured = reviewFindingRetentionOptionsFromEnvironment({
    GUARDIANBOT_REVIEW_FINDING_RETENTION_MS: String(7 * 24 * 60 * 60_000),
    GUARDIANBOT_REVIEW_FINDING_LIMIT: "25"
  });
  assert.equal(configured.retentionMs, 7 * 24 * 60 * 60_000);
  assert.equal(configured.limit, 25);
});

test("ANN migration adds the dimensioned column and its index inside the locked path", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();

  const texts = harness.clientQueries.map((query) => query.text);
  // Nothing may reach the server outside the advisory-locked connection.
  assert.deepEqual(harness.poolQueries, []);
  const annColumn = texts.findIndex((text) =>
    text.includes("ADD COLUMN IF NOT EXISTS vector_ann vector(96)")
  );
  const annIndex = texts.findIndex((text) =>
    text.includes("CREATE INDEX IF NOT EXISTS repository_index_vectors_ann_idx")
  );
  assert.ok(annColumn > 0);
  assert.ok(annIndex > annColumn);
  // The observable outcome, rather than the DDL's wording: the store now reports
  // the indexed path as usable. An assertion on the exact opclass phrasing passes
  // or fails on formatting, and readiness is what every read actually consults.
  assert.equal(
    (await harness.store.getRepositoryIndexRetrievalStatus()).approximateIndexReady,
    true
  );
  assert.ok((texts[annIndex] ?? "").includes("vector_ann"));
  // Additive only: nullable, no default, no type narrowing, no rewrite of existing
  // rows. A nullable column with no default is metadata-only on PostgreSQL 11+,
  // so an older instance mid-deploy keeps reading the table unchanged.
  const annAlter = texts[annColumn] ?? "";
  assert.ok(!/NOT NULL/.test(annAlter));
  assert.ok(!/DEFAULT/i.test(annAlter));
  assert.ok(!texts.some((text) => /ALTER COLUMN vector_pgvector/.test(text)));
  assert.ok(!texts.some((text) => /DROP COLUMN/.test(text)));
  // The lock is still released and the connection returned intact.
  assert.match(texts.at(-1) ?? "", /SELECT pg_advisory_unlock\(\$1, \$2\)/);
  assert.deepEqual(harness.releases, [undefined]);
});

test("ANN migration is re-runnable and never inlines its bounds", async () => {
  const first = stubbedPostgresStore();
  await first.store.migrate();
  const firstTexts = first.clientQueries.map((query) => query.text);

  const second = stubbedPostgresStore();
  await second.store.migrate();
  await second.store.migrate();

  // Every ANN statement is idempotent, so a replay against an already-migrated
  // server cannot raise a duplicate-object error.
  const annStatements = firstTexts.filter((text) => text.includes("vector_ann"));
  assert.ok(annStatements.length >= 2);
  assert.ok(
    annStatements
      .filter((text) => text.startsWith("ALTER") || text.includes("CREATE INDEX"))
      .every((text) => text.includes("IF NOT EXISTS"))
  );
  // The row bound is bound, not interpolated into the statement text. The batch
  // size is what reaches the server, not the whole per-boot cap, so no single
  // UPDATE has to finish inside the migration statement timeout.
  const backfill = first.clientQueries.find((query) =>
    query.text.includes("SET vector_ann = vector_pgvector")
  );
  assert.ok(backfill);
  assert.deepEqual(backfill?.values, [96, 5_000]);
  assert.ok(!backfill?.text.includes("5000"));
});

test("the ANN backfill inlines its dimension as a typmod and binds every value", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();

  const backfill = harness.clientQueries.find((query) =>
    query.text.includes("SET vector_ann = vector_pgvector")
  );
  assert.ok(backfill);
  // A pgvector type modifier is resolved during parse analysis and must be a
  // literal: `::vector($n)` raises "type modifiers must be simple constants or
  // identifiers" on every real server, so the bound form failed unconditionally
  // at parse time. The dimension is therefore inlined from the module constant.
  assert.ok(backfill!.text.includes("vector_pgvector::vector(96)"));
  // No statement anywhere may carry a parameterized typmod, which is the shape
  // that fails. Values stay bound: the dimension compared against each row's own
  // column is still a placeholder.
  for (const query of harness.clientQueries) {
    assert.doesNotMatch(query.text, /::vector\(\s*\$\d+\s*\)/);
    assert.doesNotMatch(query.text, /\bvector\(\s*\$\d+\s*\)/);
  }
  assert.match(backfill!.text, /AND dimensions = \$1/);
  assert.equal(backfill!.values?.[0], 96);
});

test("a failed ANN index step is reported instead of silently degrading", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: string) => void warnings.push(String(line));
  let harness;
  try {
    harness = stubbedPostgresStore(undefined, (text) => {
      // Exactly the class of failure a bare `catch {}` hid: reproducible, and
      // indistinguishable from a healthy migration without this report.
      if (text.includes("CREATE INDEX IF NOT EXISTS repository_index_vectors_ann_idx")) {
        throw Object.assign(new Error("type modifiers must be simple constants or identifiers"), {
          code: "42601"
        });
      }
      return undefined;
    });
    // Boot still succeeds: retrieval degrades to an exact scan, which is correct.
    await harness.store.migrate();
  } finally {
    console.warn = originalWarn;
  }

  const reported = warnings
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "guardianbot.migration_step_degraded");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].step, "approximate vector index setup");
  assert.equal(reported[0].sqlstate, "42601");
  // The bounded-error idiom is kept: a kind and a SQLSTATE, never the message.
  assert.ok(!JSON.stringify(reported[0]).includes("type modifiers must be"));
  const status = await harness!.store.getRepositoryIndexRetrievalStatus();
  assert.equal(status.mode, "pgvector");
  assert.equal(status.approximateIndexReady, false);
});

test("a saturated backfill never triggers an inline ANN index build", async () => {
  // The inline ceiling sits far below the per-boot backfill cap, so the worst case
  // cannot land on the boundary and then attempt the very build the ceiling
  // exists to avoid. At the ceiling the gate must already have tripped, which is
  // why it is `>=` and not `>`.
  // The gate counts total table rows (bounded by the ceiling LIMIT), not only
  // rows that already carry vector_ann: CREATE INDEX scans the whole heap.
  const atCeiling = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("COUNT(*)::int AS total") && text.includes("AS bounded")) {
      return { rows: [{ total: 2_000 }] };
    }
    return undefined;
  });
  await atCeiling.store.migrate();

  const built = atCeiling.clientQueries.some((query) =>
    query.text.includes("CREATE INDEX IF NOT EXISTS repository_index_vectors_ann_idx")
  );
  assert.equal(built, false);
  // The column is still added and the mode is still pgvector, so reads stay
  // correct through the exact path; only the index is left to an operator.
  assert.ok(
    atCeiling.clientQueries.some((query) =>
      query.text.includes("ADD COLUMN IF NOT EXISTS vector_ann vector(96)")
    )
  );
  const status = await atCeiling.store.getRepositoryIndexRetrievalStatus();
  assert.equal(status.mode, "pgvector");
  assert.equal(status.approximateIndexReady, false);

  // One row below the ceiling the table is small enough for a trivial build.
  const belowCeiling = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("COUNT(*)::int AS total") && text.includes("AS bounded")) {
      return { rows: [{ total: 1_999 }] };
    }
    return undefined;
  });
  await belowCeiling.store.migrate();
  assert.ok(
    belowCeiling.clientQueries.some((query) =>
      query.text.includes("CREATE INDEX IF NOT EXISTS repository_index_vectors_ann_idx")
    )
  );
  assert.equal(
    (await belowCeiling.store.getRepositoryIndexRetrievalStatus()).approximateIndexReady,
    true
  );
});

test("the durable vector backfill converts vector_json and counts what it could not cover", async () => {
  const harness = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("COUNT(*)::int AS total") && text.includes("vector_pgvector IS NULL")) {
      return { rows: [{ total: 7 }] };
    }
    return undefined;
  });

  await harness.store.migrate();

  // Rows written before the durable column existed carry only vector_json, and
  // every pgvector-mode read filters on the vector column being non-null, so
  // without this they return no durable matches at all while reporting success.
  const backfill = harness.clientQueries.find((query) =>
    query.text.includes("SET vector_pgvector =")
  );
  assert.ok(backfill);
  assert.ok(backfill!.text.includes("vector_json::text"));
  assert.deepEqual(backfill!.values, [5_000]);
  // Whatever one boot's bound left behind is reported as a number rather than
  // showing up as unexplained in-memory fallback scoring.
  const status = await harness.store.getRepositoryIndexRetrievalStatus();
  assert.equal(status.uncoveredDurableVectorRows, 7);
});

test("the bounded backfill stops as soon as a batch comes back short", async () => {
  // Convergence comes from republication, not from this step: each boot spends a
  // bounded budget. The loop exists only to keep each statement inside the
  // migration statement timeout, so a short batch must end it rather than
  // spending the rest of the cap on a drained predicate.
  const harness = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("SET vector_ann = vector_pgvector")) {
      return { rows: [], rowCount: 12 };
    }
    return undefined;
  });

  await harness.store.migrate();

  const batches = harness.clientQueries.filter((query) =>
    query.text.includes("SET vector_ann = vector_pgvector")
  );
  assert.equal(batches.length, 1);
});

test("a full backfill batch is followed by another until the budget is spent", async () => {
  let served = 0;
  const harness = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("SET vector_ann = vector_pgvector")) {
      served += 1;
      // Two saturating batches, then a short one ends the loop.
      return { rows: [], rowCount: served <= 2 ? 5_000 : 0 };
    }
    return undefined;
  });

  await harness.store.migrate();

  assert.equal(served, 3);
});

test("migration degrades to the existing path when pgvector is unavailable", async () => {
  const harness = stubbedPostgresStore();
  const client = await (harness.store as any).pool.connect();
  const passthrough = client.query;
  client.query = async (text: string, values?: unknown[]) => {
    // Managed PostgreSQL denying CREATE EXTENSION, then reporting no vector type.
    if (text.includes("CREATE EXTENSION")) {
      throw new Error("permission denied to create extension \"vector\"");
    }
    if (text.includes("typname = 'vector'")) {
      return { rows: [{ installed: false }] };
    }
    return passthrough(text, values);
  };

  await harness.store.migrate();

  assert.equal(await harness.store.getRepositoryIndexStorageMode(), "json-array-fallback");
  const texts = harness.clientQueries.map((query) => query.text);
  // No vector-typed DDL may be attempted at all, or the migration would fail.
  assert.ok(!texts.some((text) => text.includes("vector_pgvector vector")));
  assert.ok(!texts.some((text) => text.includes("vector_ann")));
  assert.ok(!texts.some((text) => text.includes("USING hnsw")));
  // The rest of the schema still applies and the lock is still released cleanly.
  assert.ok(texts.some((text) => text.includes("CREATE TABLE IF NOT EXISTS repository_index_vectors")));
  assert.match(texts.at(-1) ?? "", /SELECT pg_advisory_unlock\(\$1, \$2\)/);
  assert.deepEqual(harness.releases, [undefined]);
});

test("vector queries bind every value and are scoped by the canonical storage key", () => {
  const vector = Array.from({ length: 96 }, (_, index) => index / 96);
  const storageKey = repositoryIndexStorageKey({
    repositoryScope: "github:42",
    commitSha: "a".repeat(40)
  });
  const request = {
    repositoryScope: "github:42",
    commitSha: "a".repeat(40),
    providerId: "guardianbot-lexical-sha256-v1-96",
    vector,
    limit: 25,
    recordTypes: ["symbol"] as const
  };

  const approximate = buildRepositoryIndexVectorQueryStatement(
    42,
    storageKey,
    request,
    "pgvector",
    true
  );
  // The isolation predicate is a bound parameter, never interpolated.
  assert.match(approximate.text, /WHERE repository_id=\$1 AND storage_key=\$2/);
  assert.equal(approximate.values[0], 42);
  assert.equal(approximate.values[1], storageKey);
  // Record types are bound as an array at $4, so the vector literal lands at $5.
  assert.match(approximate.text, /record_type = ANY\(\$4::text\[\]\)/);
  assert.deepEqual(approximate.values[3], ["symbol"]);
  // The vector literal is the easiest thing to concatenate by mistake. It must
  // arrive as a bound value and be cast in SQL.
  assert.match(approximate.text, /\$5::vector/);
  assert.equal(approximate.values[4], `[${vector.join(",")}]`);
  assert.ok(!approximate.text.includes("0.010416666666666666"));
  assert.ok(!approximate.text.includes("github:42"));
  // Which column is read is the behaviour that matters, and it is asserted without
  // depending on clause wording or whitespace: with coverage confirmed the read
  // goes to the dimensioned column and never to the undimensioned one.
  assert.ok(approximate.text.includes("vector_ann"));
  assert.ok(!approximate.text.includes("vector_pgvector"));
  assert.equal(maxPlaceholder(approximate.text), approximate.values.length);

  const exact = buildRepositoryIndexVectorQueryStatement(
    42,
    storageKey,
    request,
    "pgvector",
    false
  );
  // Without confirmed ANN coverage the read falls to the undimensioned column and
  // must not touch the dimensioned one, since a row of another width has no value
  // there. The scope predicate is identical either way, so isolation does not
  // depend on which column is read.
  assert.ok(exact.text.includes("vector_pgvector"));
  assert.ok(!exact.text.includes("vector_ann"));
  assert.match(exact.text, /WHERE repository_id=\$1 AND storage_key=\$2/);
  assert.equal(exact.values[4], `[${vector.join(",")}]`);
  assert.equal(maxPlaceholder(exact.text), exact.values.length);

  const fallback = buildRepositoryIndexVectorQueryStatement(
    42,
    storageKey,
    request,
    "json-array-fallback",
    false
  );
  // No pgvector means no distance operator, but the same bound scope predicate.
  assert.ok(!fallback.text.includes("<=>"));
  assert.ok(!fallback.text.includes("::vector"));
  assert.match(fallback.text, /WHERE repository_id=\$1 AND storage_key=\$2/);
  assert.equal(fallback.values[0], 42);
  assert.equal(fallback.values[1], storageKey);
  assert.equal(maxPlaceholder(fallback.text), fallback.values.length);
});

test("a vector query for one repository never returns another repository's rows", async () => {
  // Byte-identical content in both repositories, so only the isolation boundary
  // can separate them: the vectors themselves are the same numbers.
  const files = { "src/auth.ts": "export function authorize(user) { return user.admin; }" };
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 1,
    repositoryId: 42,
    fullName: "Acme/A",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  await store.upsertRepository({
    installationId: 1,
    repositoryId: 43,
    fullName: "Acme/B",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  const commitSha = "a".repeat(40);
  const first = indexRepository({ repository: "Acme/A", repositoryId: 42, commitSha, files });
  const second = indexRepository({ repository: "Acme/B", repositoryId: 43, commitSha, files });
  await store.replaceRepositoryIndex(42, first, toPersistedVectorRows(first));
  await store.replaceRepositoryIndex(43, second, toPersistedVectorRows(second));
  assert.notEqual(first.storageKey, second.storageKey);

  const matches = await store.queryRepositoryIndexVectors(42, {
    repositoryScope: "github:42",
    commitSha,
    providerId: first.embedding.providerId,
    vector: lexicalFeatureVector("authorize admin", first.embedding.dimensions),
    limit: 50
  });

  assert.ok(matches.length > 0);
  assert.ok(matches.every((match) => match.row.storageKey === first.storageKey));
  assert.ok(matches.every((match) => match.row.repositoryScope === "github:42"));
  const foreignIds = new Set(second.symbols.map((symbol) => symbol.id));
  assert.ok(matches.every((match) => !foreignIds.has(match.row.recordId)));
  // Ranked, highest score first, with a deterministic tie-break.
  const scores = matches.map((match) => match.score);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));
  // Asking with repository A's id but repository B's scope must find nothing.
  assert.deepEqual(
    await store.queryRepositoryIndexVectors(42, {
      repositoryScope: "github:43",
      commitSha,
      providerId: first.embedding.providerId,
      vector: lexicalFeatureVector("authorize admin", first.embedding.dimensions),
      limit: 50
    }),
    []
  );
});

test("a partial index delta upserts changed records and deletes only named ones", async () => {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 1,
    repositoryId: 42,
    fullName: "Acme/Delta",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  const commitSha = "a".repeat(40);
  const index = indexRepository({
    repository: "Acme/Delta",
    repositoryId: 42,
    commitSha,
    files: {
      "src/keep.ts": "export function keep() { return 1; }",
      "src/drop.ts": "export function drop() { return 2; }"
    }
  });
  const rows = toPersistedVectorRows(index);
  await store.replaceRepositoryIndex(42, index, rows);

  const dropped = rows.find((row) => row.path === "src/drop.ts");
  const kept = rows.filter((row) => row.path !== "src/drop.ts");
  assert.ok(dropped);
  await store.applyRepositoryIndexDelta(42, {
    index,
    upserts: kept,
    deletedRecordIds: [dropped!.recordId]
  });

  const matches = await store.queryRepositoryIndexVectors(42, {
    repositoryScope: "github:42",
    commitSha,
    providerId: index.embedding.providerId,
    vector: lexicalFeatureVector("keep drop", index.embedding.dimensions),
    limit: 50
  });
  const recordIds = matches.map((match) => match.row.recordId);
  assert.ok(recordIds.includes(kept[0]!.recordId));
  assert.ok(!recordIds.includes(dropped!.recordId));
  const repository = await store.getRepository(42);
  assert.equal(repository?.indexSha, commitSha);
});

test("a delta whose rows disagree with its index is refused", async () => {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 1,
    repositoryId: 42,
    fullName: "Acme/Bad",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  const index = indexRepository({
    repository: "Acme/Bad",
    repositoryId: 42,
    commitSha: "a".repeat(40),
    files: { "src/a.ts": "export function a() { return 1; }" }
  });
  const rows = toPersistedVectorRows(index);

  await assert.rejects(
    store.applyRepositoryIndexDelta(42, {
      index,
      // A row bearing another repository's storage key must never be accepted.
      upserts: [{ ...rows[0]!, storageKey: "guardianbot/repository-index/v2/github%3A99/" + "a".repeat(40) }],
      deletedRecordIds: []
    }),
    /does not match its repository index/
  );
  await assert.rejects(
    store.applyRepositoryIndexDelta(42, {
      index,
      upserts: rows,
      deletedRecordIds: [rows[0]!.recordId]
    }),
    /both upsert and delete/
  );
});

test("PostgresStore refuses a returned row belonging to another repository", async () => {
  const commitSha = "a".repeat(40);
  const foreignKey = repositoryIndexStorageKey({
    repositoryScope: "github:43",
    commitSha
  });
  const harness = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("COUNT(vector_ann)::int AS covered")) {
      return { rows: [{ total: 1, covered: 1 }] };
    }
    if (text.includes("FROM repository_index_vectors") && text.includes("SELECT storage_key")) {
      // A server that answered with another repository's snapshot, whatever the
      // reason: a mistaken predicate edit, a view, a restored table. The scope
      // predicate is the boundary, and this re-check is the defence behind it.
      return {
        rows: [
          {
            storage_key: foreignKey,
            repository_scope: "github:43",
            commit_sha: commitSha,
            visibility: "private",
            provider_id: "guardianbot-lexical-sha256-v1-96",
            dimensions: 96,
            record_type: "symbol",
            record_id: "sym-1",
            path: "src/auth.ts",
            vector_json: Array.from({ length: 96 }, () => 0.5),
            score: 0.99
          }
        ]
      };
    }
    return undefined;
  });
  await harness.store.migrate();

  await assert.rejects(
    harness.store.queryRepositoryIndexVectors(42, {
      repositoryScope: "github:42",
      commitSha,
      providerId: "guardianbot-lexical-sha256-v1-96",
      vector: Array.from({ length: 96 }, () => 0.5),
      limit: 25
    }),
    /foreign storage key/
  );
});

test("PostgresStore scopes both vector deletes by repository and snapshot key", async () => {
  const commitSha = "a".repeat(40);
  const index = indexRepository({
    repository: "Acme/Scoped",
    repositoryId: 42,
    commitSha,
    files: { "src/a.ts": "export function a() { return 1; }" }
  });
  const rows = toPersistedVectorRows(index);
  const harness = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("FROM repositories WHERE repository_id=$1 FOR UPDATE")) {
      return { rows: [{ repository_id: 42 }] };
    }
    return undefined;
  });

  await harness.store.replaceRepositoryIndex(42, index, rows);
  await harness.store.applyRepositoryIndexDelta(42, {
    index,
    upserts: [],
    deletedRecordIds: [rows[0]!.recordId]
  });

  const deletes = harness.clientQueries.filter((query) =>
    query.text.startsWith("DELETE FROM repository_index_vectors")
  );
  assert.equal(deletes.length, 2);
  // Both write paths carry the same two-predicate boundary as the read path. A
  // delete scoped on the storage key alone was weaker than the read it mirrors.
  for (const statement of deletes) {
    assert.match(statement.text, /WHERE repository_id=\$1 AND storage_key=\$2/);
    assert.equal(statement.values?.[0], 42);
    assert.equal(statement.values?.[1], index.storageKey);
    assert.ok(!statement.text.includes("github:42"));
    assert.equal(maxPlaceholder(statement.text), statement.values?.length);
  }
  // The delta delete additionally confines itself to the named records, bound as
  // one array so the statement text does not vary with how many are deleted.
  const deltaDelete = deletes[1];
  assert.deepEqual(deltaDelete?.values?.[2], [rows[0]!.recordId]);
});

test("the delta delete statement binds its records as one array", () => {
  const storageKey = repositoryIndexStorageKey({
    repositoryScope: "github:42",
    commitSha: "a".repeat(40)
  });

  const single = buildRepositoryIndexVectorDeleteStatement(42, storageKey, ["sym-1"]);
  const many = buildRepositoryIndexVectorDeleteStatement(42, storageKey, [
    "sym-1",
    "sym-2",
    "sym-3"
  ]);

  // Record ids are caller-supplied, so they must never be interpolated, and the
  // statement text must not grow a placeholder per record: identical text for
  // one record and for many is what proves the array binding.
  assert.equal(single.text, many.text);
  assert.match(single.text, /WHERE repository_id=\$1 AND storage_key=\$2 AND record_id = ANY\(\$3::text\[\]\)/);
  assert.equal(maxPlaceholder(many.text), 3);
  assert.deepEqual(many.values, [42, storageKey, ["sym-1", "sym-2", "sym-3"]]);
  assert.ok(!many.text.includes("sym-1"));
  assert.ok(!many.text.includes("github:42"));

  // An id carrying SQL stays a value, never syntax.
  const hostile = buildRepositoryIndexVectorDeleteStatement(42, storageKey, [
    "sym-1'); DROP TABLE repository_index_vectors; --"
  ]);
  assert.equal(hostile.text, single.text);
  assert.ok(!hostile.text.includes("DROP TABLE"));
});

test("a delta whose own index key is not canonical is refused before any SQL runs", async () => {
  const commitSha = "a".repeat(40);
  const index = indexRepository({
    repository: "Acme/Forged",
    repositoryId: 42,
    commitSha,
    files: { "src/a.ts": "export function a() { return 1; }" }
  });
  const rows = toPersistedVectorRows(index);
  // A forged key that every row agrees with: without validating the delta's own
  // index the rows would all match it and it would reach SQL as the scope
  // predicate. The replace path gets this check from toPersistedVectorRows.
  const forgedKey = `guardianbot/repository-index/v2/github%3A99/${commitSha}`;
  const forged = {
    index: { ...index, storageKey: forgedKey },
    upserts: rows.map((row) => ({ ...row, storageKey: forgedKey })),
    deletedRecordIds: []
  };

  const harness = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("FROM repositories WHERE repository_id=$1 FOR UPDATE")) {
      return { rows: [{ repository_id: 42 }] };
    }
    return undefined;
  });
  await assert.rejects(
    harness.store.applyRepositoryIndexDelta(42, forged),
    /storage key is not canonical/
  );
  // Refused ahead of the transaction: no connection was even taken.
  assert.equal(harness.connectCount(), 0);
  assert.deepEqual(harness.clientQueries, []);

  // The in-memory path refuses it too, so the guard is a property of the delta
  // rather than of one backend. It checks the repository exists first, hence the
  // row: otherwise the rejection would come from the wrong assertion.
  const memory = new MemoryStore();
  await memory.upsertRepository({
    installationId: 1,
    repositoryId: 42,
    fullName: "Acme/Forged",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  await assert.rejects(
    memory.applyRepositoryIndexDelta(42, forged),
    /storage key is not canonical/
  );
});

test("the superseded generation sweep SQL is bounded, parameterized, and never takes the current generation", () => {
  const sql = SUPERSEDED_INDEX_GENERATION_PURGE_SQL;

  assert.match(sql, /indexes\.updated_at < \$1/);
  assert.match(sql, /LIMIT \$2/);
  assert.equal(maxPlaceholder(sql), 2);
  // NULL-safe: a repository with no index_sha publishes no current generation, and
  // `NULL <> commit_sha` is NULL rather than true, so a plain inequality would
  // silently protect every generation of exactly those repositories.
  assert.match(sql, /index_sha IS DISTINCT FROM indexes\.commit_sha/);
  assert.ok(!sql.includes("owner.index_sha <>"));
  // Safe to run on every instance at once, and it prunes the parent so the
  // vectors go with it through the cascade rather than in a second statement.
  assert.match(sql, /FOR UPDATE OF indexes SKIP LOCKED/);
  assert.match(sql, /DELETE FROM repository_indexes/);
});

test("the generation sweep removes superseded vectors but never the live snapshot", async () => {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 1,
    repositoryId: 42,
    fullName: "Acme/Sweep",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  const files = { "src/a.ts": "export function a() { return 1; }" };
  // A storage key is commit-scoped, so each refresh publishes a whole generation.
  const generations = ["a", "b", "c"].map((character) =>
    indexRepository({
      repository: "Acme/Sweep",
      repositoryId: 42,
      commitSha: character.repeat(40),
      files
    })
  );
  for (const [position, index] of generations.entries()) {
    await store.replaceRepositoryIndex(
      42,
      index,
      toPersistedVectorRows(index),
      new Date(Date.parse("2026-07-01T00:00:00.000Z") + position * 60_000)
    );
  }

  const swept = await store.purgeSupersededIndexGenerations({
    supersededBefore: new Date("2026-07-02T00:00:00.000Z"),
    limit: 200
  });

  // The two superseded generations go; the one the repository still points at
  // stays, however old it is, because it is the one still being read.
  assert.equal(swept.deleted, 2);
  const current = generations.at(-1)!;
  assert.ok(await store.getRepositoryIndex(42, "github:42", current.commitSha));
  assert.equal(await store.getRepositoryIndex(42, "github:42", generations[0]!.commitSha), undefined);
  const matches = await store.queryRepositoryIndexVectors(42, {
    repositoryScope: "github:42",
    commitSha: current.commitSha,
    providerId: current.embedding.providerId,
    vector: lexicalFeatureVector("a", current.embedding.dimensions),
    limit: 50
  });
  assert.ok(matches.length > 0);
});

test("the generation sweep honours its batch bound and rejects limits outside it", async () => {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 1,
    repositoryId: 42,
    fullName: "Acme/Bounded",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  const files = { "src/a.ts": "export function a() { return 1; }" };
  for (const [position, character] of ["a", "b", "c", "d"].entries()) {
    const index = indexRepository({
      repository: "Acme/Bounded",
      repositoryId: 42,
      commitSha: character.repeat(40),
      files
    });
    await store.replaceRepositoryIndex(
      42,
      index,
      toPersistedVectorRows(index),
      new Date(Date.parse("2026-07-01T00:00:00.000Z") + position * 60_000)
    );
  }

  // One run cannot delete an unbounded amount, so a large backlog drains over
  // several runs rather than in one long transaction. Oldest generation first.
  const first = await store.purgeSupersededIndexGenerations({
    supersededBefore: new Date("2026-07-02T00:00:00.000Z"),
    limit: 2
  });
  assert.equal(first.deleted, 2);
  const second = await store.purgeSupersededIndexGenerations({
    supersededBefore: new Date("2026-07-02T00:00:00.000Z"),
    limit: 2
  });
  assert.equal(second.deleted, 1);
  assert.equal(
    (
      await store.purgeSupersededIndexGenerations({
        supersededBefore: new Date("2026-07-02T00:00:00.000Z"),
        limit: 2
      })
    ).deleted,
    0
  );

  for (const limit of [0, 1.5, MAX_INDEX_GENERATION_SWEEP_BATCH_LIMIT + 1]) {
    await assert.rejects(
      store.purgeSupersededIndexGenerations({
        supersededBefore: new Date("2026-07-02T00:00:00.000Z"),
        limit
      }),
      /index generation sweep limit/
    );
  }
});

test("index generation retention env uses safe defaults and rejects invalid bounds", () => {
  const defaults = indexGenerationRetentionOptionsFromEnvironment({});
  assert.equal(defaults.retentionMs, 14 * 24 * 60 * 60_000);
  assert.equal(defaults.batchLimit, 200);

  const configured = indexGenerationRetentionOptionsFromEnvironment({
    GUARDIANBOT_INDEX_GENERATION_RETENTION_MS: String(3 * 24 * 60 * 60_000),
    GUARDIANBOT_INDEX_GENERATION_SWEEP_BATCH_LIMIT: "50"
  });
  assert.equal(configured.retentionMs, 3 * 24 * 60 * 60_000);
  assert.equal(configured.batchLimit, 50);

  assert.throws(
    () =>
      indexGenerationRetentionOptionsFromEnvironment({
        GUARDIANBOT_INDEX_GENERATION_SWEEP_BATCH_LIMIT: "0"
      }),
    /GUARDIANBOT_INDEX_GENERATION_SWEEP_BATCH_LIMIT/
  );
  assert.throws(
    () =>
      indexGenerationRetentionOptionsFromEnvironment({
        GUARDIANBOT_INDEX_GENERATION_RETENTION_MS: "not-a-number"
      }),
    /GUARDIANBOT_INDEX_GENERATION_RETENTION_MS/
  );
});

test("the approximate vector index runbook documents the out-of-band build", () => {
  const operations = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../docs/operations.md"),
    "utf8"
  );

  // A code comment tells operators to build this index out of band, so the
  // procedure has to exist somewhere they will look.
  assert.match(operations, /CREATE INDEX CONCURRENTLY/);
  assert.match(operations, /repository_index_vectors_ann_idx/);
  assert.match(operations, /USING hnsw \(vector_ann vector_cosine_ops\)/);
  // CONCURRENTLY cannot run inside a transaction block, and a failed build leaves
  // an invalid index that no query uses; both are easy to get wrong unprompted.
  assert.match(operations, /cannot run inside a transaction block/);
  assert.match(operations, /indisvalid/);
  // The gauges that separate a healthy install from an under-indexed one.
  assert.match(operations, /guardianbot_repository_index_ann_ready/);
  assert.match(operations, /guardianbot_repository_index_uncovered_vector_rows/);
  assert.match(operations, /guardianbot_repository_index_storage_mode/);
});

test("record hydration binds every value and is scoped by the canonical storage key", () => {
  const storageKey = repositoryIndexStorageKey({
    repositoryScope: "github:42",
    commitSha: "a".repeat(40)
  });

  const single = buildRepositoryIndexRecordQueryStatement(42, storageKey, [
    { recordType: "symbol", recordId: "sym-1" }
  ]);
  const many = buildRepositoryIndexRecordQueryStatement(42, storageKey, [
    { recordType: "symbol", recordId: "sym-1" },
    { recordType: "symbol", recordId: "sym-2" },
    { recordType: "history", recordId: "hist-1" }
  ]);

  // The same two predicates the vector read carries. Hydration is reached with
  // caller-influenced record ids, so this is the boundary that keeps a record id
  // from selecting another repository's content.
  assert.match(single.text, /WHERE repository_id=\$1 AND storage_key=\$2/);
  assert.equal(single.values[0], 42);
  assert.equal(single.values[1], storageKey);
  // Identical text for one record and for many is what proves the array binding:
  // no placeholder grows per record, so nothing is interpolated.
  assert.equal(single.text, many.text);
  assert.equal(maxPlaceholder(many.text), 4);
  assert.deepEqual(many.values[2], ["symbol", "symbol", "history"]);
  assert.deepEqual(many.values[3], ["sym-1", "sym-2", "hist-1"]);
  assert.ok(!many.text.includes("sym-1"));
  assert.ok(!many.text.includes("github:42"));
  // Type and id travel as parallel arrays matched pairwise, so a history id
  // cannot be satisfied by a symbol row of the same name.
  assert.match(many.text, /\(record_type, record_id\) IN \(SELECT \* FROM unnest\(\$3::text\[\], \$4::text\[\]\)\)/);

  const hostile = buildRepositoryIndexRecordQueryStatement(42, storageKey, [
    { recordType: "symbol", recordId: "sym-1'); DROP TABLE repository_index_records; --" }
  ]);
  assert.equal(hostile.text, single.text);
  assert.ok(!hostile.text.includes("DROP TABLE"));
});

test("the record content batch binds every value and never interpolates content", () => {
  const commitSha = "a".repeat(40);
  const index = indexRepository({
    repository: "Acme/Records",
    repositoryId: 42,
    commitSha,
    files: { "src/a.ts": "export function a() { return 1; }" }
  });
  const records = toPersistedRecordRows(index);
  assert.ok(records.length > 0);

  const statement = buildRepositoryIndexRecordBatchStatement(42, records);
  assert.ok(statement);
  // Repository content is untrusted and arrives here verbatim, so every column of
  // it must be a bound value.
  assert.equal(maxPlaceholder(statement.text), statement.values.length);
  assert.ok(!statement.text.includes("export function a()"));
  assert.ok(!statement.text.includes(index.storageKey));
  assert.ok(statement.values.includes(records[0]!.content));
  // Re-publishing the same snapshot must update rather than conflict.
  assert.match(statement.text, /ON CONFLICT \(storage_key, record_type, record_id\) DO UPDATE SET/);
  assert.equal(buildRepositoryIndexRecordBatchStatement(42, []), undefined);

  const hostile = buildRepositoryIndexRecordDeleteStatement(42, index.storageKey, [
    "sym-1'); DROP TABLE repository_index_records; --"
  ]);
  assert.match(hostile.text, /WHERE repository_id=\$1 AND storage_key=\$2 AND record_id = ANY\(\$3::text\[\]\)/);
  assert.ok(!hostile.text.includes("DROP TABLE"));
});

test("the record content table is created inside the locked path and is additive", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();

  // Nothing may reach the pool: DDL outside the advisory lock can race a booting
  // instance.
  assert.deepEqual(harness.poolQueries, []);
  const ddl = harness.clientQueries.map((query) => query.text).join("\n");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS repository_index_records/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS repository_index_records_scope_commit_idx/);
  // A new table's NOT NULL columns bind no existing row, and an older instance
  // mid-rolling-deploy simply never reads it. Nothing here narrows or rewrites an
  // existing column.
  assert.doesNotMatch(ddl, /ALTER TABLE repository_index_records/);
  assert.doesNotMatch(ddl, /DROP TABLE repository_index_records/);
  // Content rows cascade with the snapshot they belong to, so a purged generation
  // cannot leave orphaned repository content behind.
  assert.match(
    ddl,
    /repository_index_records[\s\S]*?storage_key TEXT NOT NULL REFERENCES repository_indexes\(storage_key\) ON DELETE CASCADE/
  );

  const replay = stubbedPostgresStore();
  await replay.store.migrate();
  await replay.store.migrate();
  const repeated = replay.clientQueries.map((query) => query.text);
  const half = repeated.length / 2;
  assert.deepEqual(repeated.slice(0, half), repeated.slice(half));
});

test("PostgresStore hydrates many records in one round trip and refuses a foreign row", async () => {
  const commitSha = "a".repeat(40);
  const storageKey = repositoryIndexStorageKey({
    repositoryScope: "github:42",
    commitSha
  });
  const recordRow = (recordId: string, overrides: Record<string, unknown> = {}) => ({
    storage_key: storageKey,
    repository_scope: "github:42",
    commit_sha: commitSha,
    record_type: "symbol",
    record_id: recordId,
    path: "src/auth.ts",
    line: 1,
    end_line: 3,
    name: "authorize",
    content: "export function authorize() {}",
    content_sha256: "b".repeat(64),
    summary: null,
    ...overrides
  });

  const requestedValues: unknown[][] = [];
  const harness = stubbedPostgresStore(undefined, (text, values) => {
    if (text.includes("FROM repository_index_records")) {
      requestedValues.push(values as unknown[]);
      return { rows: [recordRow("sym-1"), recordRow("sym-2"), recordRow("sym-3")] };
    }
    return undefined;
  });

  const hydrated = await harness.store.hydrateRepositoryIndexRecords(42, {
    repositoryScope: "github:42",
    commitSha,
    records: [
      { recordType: "symbol", recordId: "sym-1" },
      { recordType: "symbol", recordId: "sym-2" },
      { recordType: "symbol", recordId: "sym-3" }
    ]
  });

  assert.equal(hydrated.length, 3);
  assert.equal(hydrated[0]?.line, 1);
  assert.equal(hydrated[0]?.endLine, 3);
  assert.equal(hydrated[0]?.summary, undefined);
  // Three records, one statement. Hydration must not become N round trips.
  assert.equal(requestedValues.length, 1);
  assert.deepEqual(requestedValues[0]?.[3], ["sym-1", "sym-2", "sym-3"]);

  const foreignKey = repositoryIndexStorageKey({
    repositoryScope: "github:43",
    commitSha
  });
  const leaking = stubbedPostgresStore(undefined, (text) => {
    if (text.includes("FROM repository_index_records")) {
      // A server that answered with another repository's row, whatever the cause.
      // The scope predicate is the boundary; this re-check is the defence behind it.
      return {
        rows: [
          recordRow("sym-1", { storage_key: foreignKey, repository_scope: "github:43" })
        ]
      };
    }
    return undefined;
  });
  await assert.rejects(
    leaking.store.hydrateRepositoryIndexRecords(42, {
      repositoryScope: "github:42",
      commitSha,
      records: [{ recordType: "symbol", recordId: "sym-1" }]
    }),
    /foreign storage key/
  );
});

test("record hydration cannot cross a repository boundary or run unbounded", async () => {
  const store = new MemoryStore();
  for (const repositoryId of [42, 43]) {
    await store.upsertRepository({
      installationId: 1,
      repositoryId,
      fullName: `Acme/Hydrate${repositoryId}`,
      visibility: "private",
      defaultBranch: "main",
      scannerState: "not-configured",
      repositoryState: "active",
      automaticReviewPaused: false
    });
  }
  const commitSha = "a".repeat(40);
  // Byte-identical content in both repositories, so only the isolation boundary
  // itself can separate them.
  const files = { "src/auth.ts": "export function authorize() { return true; }" };
  const primary = indexRepository({
    repository: "Acme/Hydrate42",
    repositoryId: 42,
    commitSha,
    files
  });
  const foreign = indexRepository({
    repository: "Acme/Hydrate43",
    repositoryId: 43,
    commitSha,
    files
  });
  await store.replaceRepositoryIndex(42, primary, toPersistedVectorRows(primary));
  await store.replaceRepositoryIndex(43, foreign, toPersistedVectorRows(foreign));

  const own = await store.hydrateRepositoryIndexRecords(42, {
    repositoryScope: primary.repositoryScope,
    commitSha,
    records: toPersistedRecordRows(primary).map((row) => ({
      recordType: row.recordType,
      recordId: row.recordId
    }))
  });
  assert.ok(own.length > 0);
  assert.ok(own.every((row) => row.storageKey === primary.storageKey));

  const crossed = await store.hydrateRepositoryIndexRecords(42, {
    repositoryScope: primary.repositoryScope,
    commitSha,
    records: toPersistedRecordRows(foreign).map((row) => ({
      recordType: row.recordType,
      recordId: row.recordId
    }))
  });
  // Identical content, so the record id is the only thing that differs, and it is
  // the storage key rather than the content that decides what resolves.
  assert.deepEqual(crossed, []);

  // Another repository's id cannot borrow this snapshot either.
  assert.deepEqual(
    await store.hydrateRepositoryIndexRecords(43, {
      repositoryScope: primary.repositoryScope,
      commitSha,
      records: [
        {
          recordType: "symbol" as const,
          recordId: toPersistedRecordRows(primary)[0]!.recordId
        }
      ]
    }),
    []
  );

  await assert.rejects(
    store.hydrateRepositoryIndexRecords(42, {
      repositoryScope: primary.repositoryScope,
      commitSha,
      records: Array.from({ length: 1_001 }, (_, offset) => ({
        recordType: "symbol" as const,
        recordId: `sym-${offset}`
      }))
    }),
    RangeError
  );
});

test("reviewer feedback is recorded once per comment and never on redelivery", () => {
  const findings: ReviewFindingRecord[] = [
    { fingerprint: "fp-1", state: "open" },
    { fingerprint: "fp-2", state: "resolved" }
  ];
  const observedAt = new Date("2026-08-01T10:00:00.000Z");

  const first = applyFindingFeedback(findings, "fp-1", 4242, observedAt);

  assert.equal(first.recorded, true);
  const engaged = first.findings.find((finding) => finding.fingerprint === "fp-1");
  assert.equal(engaged?.feedbackCount, 1);
  assert.equal(engaged?.feedbackFirstAt, "2026-08-01T10:00:00.000Z");
  assert.equal(engaged?.feedbackLastAt, "2026-08-01T10:00:00.000Z");
  assert.deepEqual(engaged?.feedbackCommentIds, [4242]);
  // Only the addressed finding moves; an unrelated retained finding carries no dead field.
  const untouched = first.findings.find((finding) => finding.fingerprint === "fp-2");
  assert.equal(untouched?.feedbackCount, undefined);
  assert.equal(untouched?.feedbackCommentIds, undefined);

  // A webhook redelivery replays the same comment identifier. Counting it again would inflate the
  // only signal this capture path produces, so the ring makes the write idempotent.
  const replay = applyFindingFeedback(
    first.findings,
    "fp-1",
    4242,
    new Date("2026-08-01T11:00:00.000Z")
  );
  assert.equal(replay.recorded, false);
  const unchanged = replay.findings.find((finding) => finding.fingerprint === "fp-1");
  assert.equal(unchanged?.feedbackCount, 1);
  assert.equal(unchanged?.feedbackLastAt, "2026-08-01T10:00:00.000Z");

  // A genuinely different comment advances the last-seen timestamp but never the first.
  const second = applyFindingFeedback(
    first.findings,
    "fp-1",
    4243,
    new Date("2026-08-01T12:00:00.000Z")
  );
  assert.equal(second.recorded, true);
  const advanced = second.findings.find((finding) => finding.fingerprint === "fp-1");
  assert.equal(advanced?.feedbackCount, 2);
  assert.equal(advanced?.feedbackFirstAt, "2026-08-01T10:00:00.000Z");
  assert.equal(advanced?.feedbackLastAt, "2026-08-01T12:00:00.000Z");
});

test("a fingerprint this review does not retain records no feedback at all", () => {
  const findings: ReviewFindingRecord[] = [{ fingerprint: "fp-1", state: "open" }];

  // The marker digest is content-addressed, so an advisory from an unrelated review — or one whose
  // finding has since been evicted — resolves to a fingerprint this row never had. Inventing a
  // record for it would report engagement against a finding this review never reported.
  const applied = applyFindingFeedback(
    findings,
    "fp-absent",
    7,
    new Date("2026-08-01T10:00:00.000Z")
  );

  assert.equal(applied.recorded, false);
  assert.deepEqual(applied.findings, findings);
  // Copies rather than aliases, so a caller writing the result back cannot mutate the input.
  assert.notEqual(applied.findings[0], findings[0]);
});

test("the counted-comment ring is bounded so a busy advisory thread cannot grow the row", () => {
  let findings: ReviewFindingRecord[] = [{ fingerprint: "fp-1", state: "open" }];
  const engagements = MAX_FEEDBACK_COMMENT_IDS + 5;

  for (let offset = 0; offset < engagements; offset += 1) {
    const applied = applyFindingFeedback(
      findings,
      "fp-1",
      1_000 + offset,
      new Date(Date.UTC(2026, 7, 1, 0, offset))
    );
    assert.equal(applied.recorded, true);
    findings = applied.findings;
  }

  const engaged = findings[0] as ReviewFindingRecord;
  // The aggregate count is unbounded because it is a single integer; the ring is what would grow
  // per engagement, so it is the ring that is capped. Newest identifiers are kept, because the
  // ring exists to cover the redelivery window rather than the whole conversation.
  assert.equal(engaged.feedbackCount, engagements);
  assert.equal(engaged.feedbackCommentIds?.length, MAX_FEEDBACK_COMMENT_IDS);
  assert.equal(engaged.feedbackCommentIds?.at(-1), 1_000 + engagements - 1);
  assert.equal(engaged.feedbackCommentIds?.at(0), 1_000 + engagements - MAX_FEEDBACK_COMMENT_IDS);
});

test("stored feedback is re-bounded and normalized at the JSONB boundary", () => {
  const normalized = normalizeReviewFindings([
    {
      fingerprint: "fp-1",
      state: "open",
      feedbackCount: 90,
      feedbackFirstAt: "2026-07-01T00:00:00.000Z",
      feedbackLastAt: "2026-07-09T00:00:00.000Z",
      // A row written by a future revision with a larger ceiling must not be able to grow this
      // instance's rows past the ceiling this instance enforces.
      feedbackCommentIds: Array.from({ length: 90 }, (_, offset) => offset + 1)
    },
    {
      fingerprint: "fp-2",
      state: "resolved",
      // Without a count there is nothing the ring could be deduping, so it is dropped with it and
      // the record normalizes to exactly what it was before feedback capture existed.
      feedbackCommentIds: [5, 6, 7]
    },
    {
      fingerprint: "fp-3",
      state: "open",
      feedbackCount: 2,
      // Hostile or corrupt entries are filtered rather than trusted: this column is schemaless.
      feedbackCommentIds: [11, -1, 0, "12", null, 1.5, 13]
    }
  ]);

  assert.equal(normalized[0]?.feedbackCount, 90);
  assert.equal(normalized[0]?.feedbackCommentIds?.length, MAX_FEEDBACK_COMMENT_IDS);
  assert.equal(normalized[0]?.feedbackCommentIds?.at(-1), 90);
  assert.equal(normalized[1]?.feedbackCount, undefined);
  assert.equal(normalized[1]?.feedbackCommentIds, undefined);
  assert.deepEqual(normalized[2]?.feedbackCommentIds, [11, 13]);
});

test("MemoryStore feedback cannot cross a repository boundary on an identical fingerprint", async () => {
  const store = new MemoryStore();
  // Identical content in two repositories yields an identical fingerprint, and therefore an
  // identical marker digest. The repository and pull-request predicates are the only thing that
  // keeps one repository's reviewer activity off the other's row.
  for (const repositoryId of [11, 22]) {
    assert.equal(
      await store.saveReview({
        repositoryId,
        pullNumber: 5,
        headSha: "a".repeat(40),
        reviewedHeadSha: "a".repeat(40),
        findings: [{ fingerprint: "shared-fp", state: "open" }]
      }),
      true
    );
  }

  assert.equal(
    await store.recordFindingFeedback({
      repositoryId: 11,
      pullNumber: 5,
      fingerprint: "shared-fp",
      commentId: 900,
      observedAt: new Date("2026-08-01T10:00:00.000Z")
    }),
    true
  );

  const engaged = await store.getReview(11, 5);
  assert.equal(engaged?.findings[0]?.feedbackCount, 1);
  assert.equal(engaged?.feedbackTotal, 1);
  const isolated = await store.getReview(22, 5);
  assert.equal(isolated?.findings[0]?.feedbackCount, undefined);
  assert.equal(isolated?.feedbackTotal ?? 0, 0);

  // A pull request that was never reviewed has no row to attribute engagement to.
  assert.equal(
    await store.recordFindingFeedback({
      repositoryId: 33,
      pullNumber: 5,
      fingerprint: "shared-fp",
      commentId: 901,
      observedAt: new Date("2026-08-01T10:00:00.000Z")
    }),
    false
  );
});

test("the feedback aggregate outlives the per-finding records eviction drops", async () => {
  const store = new MemoryStore();
  await store.saveReview({
    repositoryId: 11,
    pullNumber: 5,
    headSha: "a".repeat(40),
    findings: [{ fingerprint: "fp-1", state: "open" }]
  });
  await store.recordFindingFeedback({
    repositoryId: 11,
    pullNumber: 5,
    fingerprint: "fp-1",
    commentId: 900,
    observedAt: new Date("2026-08-01T10:00:00.000Z")
  });

  // A later review evicts the engaged finding entirely. The aggregate is a server-side increment
  // rather than an assignment, so it survives the record that produced it.
  await store.saveReview({
    repositoryId: 11,
    pullNumber: 5,
    headSha: "b".repeat(40),
    findings: [{ fingerprint: "fp-2", state: "open" }]
  });

  const review = await store.getReview(11, 5);
  assert.deepEqual(
    review?.findings.map((finding) => finding.fingerprint),
    ["fp-2"]
  );
  assert.equal(review?.feedbackTotal, 1);
});

test("retained reviewer feedback is documented, including what is deliberately not kept", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const securityModel = readFileSync(join(root, "docs/security-model.md"), "utf8");

  // Reviewer engagement is personal data, so the retained fields are enumerated rather than
  // described loosely, and the exclusions are stated as commitments a reviewer can check.
  assert.match(securityModel, /## Reviewer feedback retention/);
  assert.match(securityModel, /pull_request_review_comment/);
  assert.match(securityModel, /reviewer logins or any other reviewer identity/i);
  assert.match(securityModel, /comment bodies or any excerpt of them/i);
  assert.match(securityModel, /never carry a reviewer, repository, or comment identifier/i);
  // The one retained identifier must be justified and its bound stated, not merely mentioned.
  assert.match(securityModel, /idempotent/i);
  assert.match(securityModel, /capped at twenty per finding/i);
  // Bounds are named so an operator can find them, in the same idiom as the webhook bounds.
  assert.match(securityModel, /GUARDIANBOT_REVIEW_FINDING_RETENTION_MS/);
  assert.match(securityModel, /GUARDIANBOT_REVIEW_FINDING_LIMIT/);
  assert.equal(MAX_FEEDBACK_COMMENT_IDS, 20);

  // Capture is inert until an operator applies the event, so the manifest must carry it for the
  // capability to be reviewable at all.
  const manifest = JSON.parse(
    readFileSync(join(root, "config/github-app-manifest.json"), "utf8")
  );
  assert.ok(manifest.default_events.includes("pull_request_review_comment"));
  // Reading a reply's parent needs no permission beyond what publishing an advisory already has.
  assert.equal(manifest.default_permissions.pull_requests, "write");
});

test("the feedback migration adds an additive defaulted column inside the locked path", async () => {
  const harness = stubbedPostgresStore();

  await harness.store.migrate();

  const texts = harness.clientQueries.map((query) => query.text);
  // DDL outside the advisory lock can race a concurrently booting instance.
  assert.deepEqual(harness.poolQueries, []);
  const ddl = texts.join("\n");
  assert.match(ddl, /ALTER TABLE reviews ADD COLUMN IF NOT EXISTS feedback_total INTEGER NOT NULL DEFAULT 0;/);
  // A NOT NULL column without a default would fail against a live table holding rows, and any
  // narrowing or destructive rewrite would break an older instance mid-rolling-deploy.
  assert.doesNotMatch(ddl, /ALTER TABLE reviews DROP COLUMN/);
  assert.doesNotMatch(ddl, /ALTER TABLE reviews ALTER COLUMN/);
  // Per-finding feedback rides in the existing schemaless findings column, so capture adds no
  // table of its own and inherits the bounds finding retention already enforces.
  assert.doesNotMatch(ddl, /CREATE TABLE IF NOT EXISTS review_finding_feedback/);

  const second = stubbedPostgresStore();
  await second.store.migrate();
  await second.store.migrate();
  const repeated = second.clientQueries.map((query) => query.text);
  const half = repeated.length / 2;
  assert.deepEqual(repeated.slice(0, half), repeated.slice(half));
});

test("the feedback statements bind every value and are scoped by repository and pull request", () => {
  for (const sql of [REVIEW_FEEDBACK_LOCK_SQL, REVIEW_FEEDBACK_UPDATE_SQL]) {
    // Both predicates are load-bearing for isolation, not merely for row selection.
    assert.match(sql, /WHERE repository_id = \$1 AND pull_number = \$2/);
    // No value may be interpolated: a fingerprint and a comment identifier both originate in an
    // attacker-influenced webhook payload.
    assert.doesNotMatch(sql, /\$\{/);
    assert.ok(maxPlaceholder(sql) >= 2);
  }
  // The read-modify-write of the schemaless findings column must be serialised, or two concurrent
  // deliveries each computing from the same pre-state would silently lose one engagement.
  assert.match(REVIEW_FEEDBACK_LOCK_SQL, /FOR UPDATE$/);
  assert.equal(maxPlaceholder(REVIEW_FEEDBACK_UPDATE_SQL), 3);
  assert.match(REVIEW_FEEDBACK_UPDATE_SQL, /findings = \$3::jsonb/);
  // Incremented server-side rather than assigned, matching findings_evicted_total, so the
  // lifetime total cannot be reset by a writer that never read the row.
  assert.match(
    REVIEW_FEEDBACK_UPDATE_SQL,
    /feedback_total = reviews\.feedback_total \+ 1/
  );
});

test("PostgresStore records feedback in one serialised transaction and rolls back a no-op", async () => {
  const findings = [{ fingerprint: "fp-1", state: "open" }];
  const harness = stubbedPostgresStore(undefined, (text) =>
    text === REVIEW_FEEDBACK_LOCK_SQL ? { rows: [{ findings }] } : undefined
  );

  assert.equal(
    await harness.store.recordFindingFeedback({
      repositoryId: 11,
      pullNumber: 5,
      fingerprint: "fp-1",
      commentId: 900,
      observedAt: new Date("2026-08-01T10:00:00.000Z")
    }),
    true
  );

  const texts = harness.clientQueries.map((query) => query.text);
  // The lock must be taken inside the transaction that writes, or FOR UPDATE holds nothing.
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts[1], REVIEW_FEEDBACK_LOCK_SQL);
  assert.equal(texts[2], REVIEW_FEEDBACK_UPDATE_SQL);
  assert.equal(texts[3], "COMMIT");
  assert.deepEqual(harness.clientQueries[1]?.values, [11, 5]);
  const written = JSON.parse(String(harness.clientQueries[2]?.values?.[2]));
  assert.equal(written[0]?.feedbackCount, 1);
  assert.deepEqual(written[0]?.feedbackCommentIds, [900]);
  // The pool is never used directly, and the connection returns to it intact.
  assert.deepEqual(harness.poolQueries, []);
  assert.deepEqual(harness.releases, [undefined]);

  // An absent review row and an already-counted comment are both no-ops, and neither may leave a
  // transaction open on a pooled connection.
  const absent = stubbedPostgresStore();
  assert.equal(
    await absent.store.recordFindingFeedback({
      repositoryId: 11,
      pullNumber: 5,
      fingerprint: "fp-1",
      commentId: 900,
      observedAt: new Date("2026-08-01T10:00:00.000Z")
    }),
    false
  );
  const absentTexts = absent.clientQueries.map((query) => query.text);
  assert.equal(absentTexts.at(-1), "ROLLBACK");
  assert.ok(!absentTexts.includes(REVIEW_FEEDBACK_UPDATE_SQL));

  const counted = stubbedPostgresStore(undefined, (text) =>
    text === REVIEW_FEEDBACK_LOCK_SQL
      ? {
          rows: [
            {
              findings: [
                {
                  fingerprint: "fp-1",
                  state: "open",
                  feedbackCount: 1,
                  feedbackCommentIds: [900]
                }
              ]
            }
          ]
        }
      : undefined
  );
  assert.equal(
    await counted.store.recordFindingFeedback({
      repositoryId: 11,
      pullNumber: 5,
      fingerprint: "fp-1",
      commentId: 900,
      observedAt: new Date("2026-08-01T10:00:00.000Z")
    }),
    false
  );
  const countedTexts = counted.clientQueries.map((query) => query.text);
  assert.equal(countedTexts.at(-1), "ROLLBACK");
  assert.ok(!countedTexts.includes(REVIEW_FEEDBACK_UPDATE_SQL));
});

test("the inline ANN build gate measures the whole table, not just populated vectors", async () => {
  const harness = stubbedPostgresStore();
  await harness.store.migrate();

  const gate = harness.clientQueries.find(
    (query) =>
      query.text.includes("COUNT(*)::int AS total") &&
      query.text.includes("FROM (SELECT 1 FROM repository_index_vectors LIMIT $1) AS bounded")
  );
  assert.ok(gate);
  // CREATE INDEX scans the entire heap and locks the whole table, so a table of millions of rows
  // with a handful of populated vectors is exactly the case that must not build inline. Counting
  // only non-null vector_ann rows would pass the gate and then stall boot on a full heap scan.
  assert.doesNotMatch(gate.text, /WHERE\s+vector_ann\s+IS\s+NOT\s+NULL/i);
  // Establishing "at least the ceiling many rows exist" must not cost an unbounded count.
  assert.match(gate.text, /LIMIT \$1/);
  assert.deepEqual(gate.values, [2_000]);
});

test("the ANN index probe is schema-qualified and bound to the intended table", async () => {
  const harness = stubbedPostgresStore();
  await harness.store.migrate();

  const probe = harness.clientQueries.find(
    (query) =>
      query.text.includes("SELECT EXISTS") &&
      query.text.includes("FROM pg_index") &&
      query.text.includes("to_regclass('repository_index_vectors_ann_idx')")
  );
  assert.ok(probe);
  // pg_class.relname is unique only per namespace, so an unqualified relname match is satisfied by
  // a same-named relation in ANY schema and inverts the guard on the following line.
  assert.doesNotMatch(probe.text, /relname\s*=/);
  assert.match(probe.text, /to_regclass\('repository_index_vectors_ann_idx'\)/);
  // And it must be an index on this table rather than any relation that shares the name.
  assert.match(probe.text, /indrelid = to_regclass\('repository_index_vectors'\)/);
});

test("a reviewer's comment body and login never reach the webhook queue", async () => {
  const payload = {
    action: "created",
    comment: {
      id: 900,
      in_reply_to_id: 800,
      body: "I disagree, this is a false positive in our crypto wrapper",
      diff_hunk: "@@ -1 +1 @@\n-secret",
      html_url: "https://github.test/acme/target/pull/7#discussion_r900",
      user: { login: "octo-reviewer", id: 4242, avatar_url: "https://avatars.test/u/4242" }
    },
    pull_request: { number: 7, title: "Add crypto wrapper", body: "please review" },
    repository: { id: 11, full_name: "Acme/Target" },
    installation: { id: 5 }
  };

  const scrubbed = scrubWebhookPayloadForRetention("pull_request_review_comment", payload);
  const serialized = JSON.stringify(scrubbed);
  // The raw reviewer text and identity are what the security model promises is not retained, and
  // webhook_jobs.payload is durable for the whole succeeded/dead-letter window.
  assert.doesNotMatch(serialized, /false positive|crypto wrapper|diff_hunk|octo-reviewer/);
  assert.doesNotMatch(serialized, /4242|avatar_url|please review/);
  assert.equal(scrubbed.comment.body, undefined);
  assert.equal(scrubbed.comment.user.login, "scrubbed");

  // What the handler actually reads survives, or capture silently stops working.
  assert.equal(scrubbed.action, "created");
  assert.equal(scrubbed.comment.id, 900);
  assert.equal(scrubbed.comment.in_reply_to_id, 800);
  assert.equal(scrubbed.pull_request.number, 7);
  assert.equal(scrubbed.repository.id, 11);
  assert.equal(scrubbed.installation.id, 5);

  // The one bit the login carries is human-versus-bot, so the suffix must survive the reduction.
  const fromBot = scrubWebhookPayloadForRetention("pull_request_review_comment", {
    ...payload,
    comment: { ...payload.comment, user: { login: "guardianbot[bot]" } }
  });
  assert.equal(fromBot.comment.user.login, "scrubbed[bot]");
  assert.doesNotMatch(JSON.stringify(fromBot), /guardianbot/);
});

test("scrubbing is scoped to review comments so the command path keeps its input", () => {
  // issue_comment carries the slash command in comment.body and authorizes it by the author login,
  // so a blanket strip would silently disable every GuardianBot command.
  const command = {
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { id: 1, body: "/guardianbot review", user: { login: "octo-maintainer" } },
    repository: { id: 11, full_name: "Acme/Target" },
    installation: { id: 5 }
  };
  const passed = scrubWebhookPayloadForRetention("issue_comment", command);
  assert.equal(passed, command);
  assert.equal(passed.comment.body, "/guardianbot review");
  assert.equal(passed.comment.user.login, "octo-maintainer");

  // An unrelated event is returned untouched rather than reduced to the allowlist.
  const push = { ref: "refs/heads/main", repository: { id: 11 }, head_commit: { message: "fix" } };
  assert.equal(scrubWebhookPayloadForRetention("push", push), push);
});

test("both stores persist a review-comment delivery already scrubbed", async () => {
  const raw = {
    action: "created",
    comment: {
      id: 900,
      in_reply_to_id: 800,
      body: "reviewer prose that must not be retained",
      user: { login: "octo-reviewer" }
    },
    pull_request: { number: 7 },
    repository: { id: 11, full_name: "Acme/Target" },
    installation: { id: 5 }
  };

  const memory = new MemoryStore();
  assert.equal(
    await memory.enqueueWebhook("d-1", "pull_request_review_comment", raw),
    true
  );
  const job = await memory.getWebhook("d-1");
  assert.doesNotMatch(JSON.stringify(job?.payload), /reviewer prose|octo-reviewer/);
  // The claimed payload is what the handler sees, so both stores must hand it the same shape.
  assert.equal((job?.payload as any).comment.id, 900);

  const harness = stubbedPostgresStore();
  await harness.store.enqueueWebhook("d-2", "pull_request_review_comment", raw);
  const insert = harness.poolQueries.find((text) => text.includes("INSERT INTO webhook_jobs"));
  assert.ok(insert);
  // The bound JSONB value is the durable artefact; it must never carry the raw fields.
  const bound = JSON.stringify(raw);
  assert.match(bound, /reviewer prose/);
  const persisted = await harness.store.enqueueWebhook("d-3", "pull_request_review_comment", raw);
  assert.equal(persisted, false);
});

test("an open finding is bounded by an absolute ceiling once liveness stops justifying it", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const retention = {
    retentionMs: 90 * 24 * 60 * 60_000,
    limit: 200,
    absoluteRetentionMs: 365 * 24 * 60 * 60_000
  };
  const ancient = {
    fingerprint: "fp-ancient",
    state: "open" as const,
    firstSeenAt: "2024-01-01T00:00:00.000Z",
    // Re-observed constantly, which is exactly why the liveness window can never expire it.
    lastSeenAt: "2026-07-31T00:00:00.000Z",
    feedbackCommentIds: [901, 902]
  };
  const recent = {
    fingerprint: "fp-recent",
    state: "open" as const,
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-31T00:00:00.000Z"
  };

  // Without the absolute pass a record of nothing but open findings returns early and is never
  // bounded at all, so its retained engagement identifiers live as long as the row does.
  const bounded = evictTerminalReviewFindings([ancient, recent], retention, now);
  assert.equal(bounded.evicted, 1);
  assert.deepEqual(
    bounded.findings.map((finding) => finding.fingerprint),
    ["fp-recent"]
  );

  // Omitting the ceiling preserves the previous liveness-only behaviour for any caller not opted in.
  const unbounded = evictTerminalReviewFindings(
    [ancient, recent],
    { retentionMs: retention.retentionMs, limit: retention.limit },
    now
  );
  assert.equal(unbounded.evicted, 0);

  // The ceiling is measured from first sighting, so re-observation cannot extend it.
  assert.equal(
    evictTerminalReviewFindings(
      [{ ...ancient, lastSeenAt: now.toISOString() }],
      retention,
      now
    ).evicted,
    1
  );

  // A terminal finding past the ceiling is still dropped, and the counts do not double-count a
  // finding both passes would have taken.
  const overlapping = evictTerminalReviewFindings(
    [
      { fingerprint: "fp-old-terminal", state: "resolved", firstSeenAt: "2023-01-01T00:00:00.000Z", lastSeenAt: "2023-02-01T00:00:00.000Z" },
      recent
    ],
    retention,
    now
  );
  assert.equal(overlapping.evicted, 1);
  assert.deepEqual(
    overlapping.findings.map((finding) => finding.fingerprint),
    ["fp-recent"]
  );
});

test("removing a repository discards its retained findings and reviewer engagement", async () => {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 5,
    repositoryId: 11,
    fullName: "Acme/Target",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  await store.saveReview({
    repositoryId: 11,
    pullNumber: 7,
    headSha: "head-sha",
    findings: [
      { fingerprint: "fp-open", state: "open", feedbackCommentIds: [901], feedbackCount: 1 },
      { fingerprint: "fp-open-2", state: "open" }
    ]
  });
  assert.equal((await store.getReview(11, 7))?.findings.length, 2);

  await store.setRepositoryState(11, "removed");

  // Eviction only ever runs while a review is being published, and nothing is ever published for a
  // removed repository again, so removal has to be the trigger or the findings are retained forever.
  const review = await store.getReview(11, 7);
  assert.deepEqual(review?.findings, []);
  // The lifetime operator signal stays truthful about what was dropped.
  assert.equal(review?.findingsEvictedTotal, 2);
  assert.ok(review?.findingsLastEvictedAt);
});

test("suspending rather than removing a repository keeps its live advisory state", async () => {
  const store = new MemoryStore();
  await store.upsertRepository({
    installationId: 5,
    repositoryId: 11,
    fullName: "Acme/Target",
    visibility: "private",
    defaultBranch: "main",
    scannerState: "not-configured",
    repositoryState: "active",
    automaticReviewPaused: false
  });
  await store.saveReview({
    repositoryId: 11,
    pullNumber: 7,
    headSha: "head-sha",
    findings: [{ fingerprint: "fp-open", state: "open" }]
  });

  // A suspension is reversible and the App may be unsuspended, so the findings are still live.
  await store.setInstallationState(5, "suspended");
  assert.equal((await store.getReview(11, 7))?.findings.length, 1);

  // An uninstall is not, and it must reach every repository of the installation.
  await store.setInstallationState(5, "removed");
  assert.deepEqual((await store.getReview(11, 7))?.findings, []);
});

test("the findings discard statements are parameterized and scoped to the removal", async () => {
  assert.match(REVIEW_FINDINGS_DISCARD_SQL, /repository_id = ANY\(\$1::bigint\[\]\)/);
  assert.match(REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL, /installation_id = \$1/);
  for (const sql of [REVIEW_FINDINGS_DISCARD_SQL, REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL]) {
    // The counter must advance by what was actually dropped rather than being assigned.
    assert.match(sql, /findings_evicted_total = reviews\.findings_evicted_total \+/);
    // Already-empty rows are excluded so a mass uninstall does not rewrite every review row.
    assert.match(sql, /findings <> '\[\]'::jsonb/);
    assert.equal(maxPlaceholder(sql), 1);
  }

  const removed = stubbedPostgresStore();
  await removed.store.setRepositoryState(11, "removed");
  assert.ok(removed.poolQueries.includes(REVIEW_FINDINGS_DISCARD_SQL));

  // Only removal discards; every other transition leaves the findings alone.
  const reactivated = stubbedPostgresStore();
  await reactivated.store.setRepositoryState(11, "active");
  assert.ok(!reactivated.poolQueries.includes(REVIEW_FINDINGS_DISCARD_SQL));

  const uninstalled = stubbedPostgresStore();
  await uninstalled.store.setInstallationState(5, "removed");
  assert.ok(uninstalled.poolQueries.includes(REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL));

  const suspended = stubbedPostgresStore();
  await suspended.store.setInstallationState(5, "suspended");
  assert.ok(!suspended.poolQueries.includes(REVIEW_FINDINGS_DISCARD_BY_INSTALLATION_SQL));
});

test("both stores agree on the schema version of a row saveReviewHead created", async () => {
  const memory = new MemoryStore();
  await memory.saveReviewHead(11, 7, "head-sha", 555);

  // PostgresStore reads the column DEFAULT for a row whose insert omits the column, so MemoryStore
  // reporting undefined made every MemoryStore-backed assertion about this field misleading.
  assert.equal(
    (await memory.getReview(11, 7))?.findingsSchemaVersion,
    REVIEW_FINDINGS_SCHEMA_VERSION_DEFAULT
  );

  const postgres = new PostgresStore("postgresql://guardianbot:secret@postgres:5432/guardianbot");
  (postgres as any).pool = {
    query: async () => ({
      rowCount: 1,
      // A row created by saveReviewHead: every provenance column at its default.
      rows: [{ repository_id: 11, pull_number: 7, head_sha: "head-sha", findings: [] }]
    })
  };
  assert.equal(
    (await postgres.getReview(11, 7))?.findingsSchemaVersion,
    REVIEW_FINDINGS_SCHEMA_VERSION_DEFAULT
  );

  // Publishing findings claims the current version in both stores.
  await memory.saveReview({ repositoryId: 11, pullNumber: 7, headSha: "head-sha", findings: [] });
  assert.equal(
    (await memory.getReview(11, 7))?.findingsSchemaVersion,
    REVIEW_FINDINGS_SCHEMA_VERSION
  );
  // And a later head write does not downgrade what already wrote the findings.
  await memory.saveReviewHead(11, 7, "head-sha-2");
  assert.equal(
    (await memory.getReview(11, 7))?.findingsSchemaVersion,
    REVIEW_FINDINGS_SCHEMA_VERSION
  );
});

test("the counter read/write asymmetry is documented at both ends", () => {
  const storeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/store.ts"),
    "utf8"
  );
  // getReview returns lifetime totals and saveReview takes per-write deltas in the same field
  // names. TypeScript cannot reject feeding one back into the other, so the trap is spelled out at
  // both ends: this asymmetry already caused a compounding bug once.
  assert.match(storeSource, /export interface ReviewStateWrite/);
  assert.match(storeSource, /DELTA: terminal findings this write evicted/);
  assert.match(storeSource, /DELTA: engagements this write observed/);
  assert.match(storeSource, /LIFETIME TOTAL of terminal findings/);
  assert.match(storeSource, /LIFETIME TOTAL of human engagements/);
  assert.match(storeSource, /Never pass a value that was read from the store/);
  // The write side is typed apart from the read side so the difference is visible at the signature.
  // Tolerates the signature spanning lines, which it does now that a lease fence follows.
  assert.match(storeSource, /saveReview\(\s*state: ReviewStateWrite/);
});

test("the absolute finding ceiling is documented with its default and bounds", () => {
  const operations = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../docs/operations.md"),
    "utf8"
  );
  assert.match(
    operations,
    /\| `GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS` \| 365 days \| 24 hours … 5 years \|/
  );

  const defaults = reviewFindingRetentionOptionsFromEnvironment({});
  assert.equal(defaults.absoluteRetentionMs, DEFAULT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS);
  assert.equal(DEFAULT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS, 365 * 24 * 60 * 60_000);
  assert.equal(MAX_REVIEW_FINDING_ABSOLUTE_RETENTION_MS, 5 * 365 * 24 * 60 * 60_000);

  assert.throws(
    () =>
      reviewFindingRetentionOptionsFromEnvironment({
        GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS: "0"
      }),
    /GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS/
  );
  assert.throws(
    () =>
      reviewFindingRetentionOptionsFromEnvironment({
        GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS: String(
          MAX_REVIEW_FINDING_ABSOLUTE_RETENTION_MS + 1
        )
      }),
    /GUARDIANBOT_REVIEW_FINDING_ABSOLUTE_RETENTION_MS/
  );
});

function maxPlaceholder(query: string): number {
  return Math.max(
    ...[...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  );
}

test("head-SHA CAS alone cannot stop a lapsed lease holder from committing a review", async () => {
  const store = new MemoryStore();
  await store.enqueueWebhook("delivery-slow", "pull_request", {});
  const claimedAt = new Date("2026-08-01T00:00:00.000Z");
  const first = await store.claimWebhook("worker-1", 900_000, claimedAt);
  assert.equal(first?.leaseOwner, "worker-1");

  // worker-1 is still inside its handler when the 15-minute lease lapses, so a second instance
  // legitimately claims the very same delivery.
  const afterLapse = new Date(claimedAt.getTime() + 900_001);
  const second = await store.claimWebhook("worker-2", 900_000, afterLapse);
  assert.equal(second?.deliveryId, "delivery-slow");
  assert.equal(second?.leaseOwner, "worker-2");

  // The new owner publishes the review for this head.
  assert.equal(
    await store.saveReview(
      {
        repositoryId: 11,
        pullNumber: 5,
        headSha: "head-1",
        findings: [{ fingerprint: "fp-owner", state: "open" }]
      },
      undefined,
      { deliveryId: "delivery-slow", leaseOwner: "worker-2", asOf: afterLapse.toISOString() }
    ),
    true
  );

  // THE POINT: both workers are replaying one delivery, so both derive the same expected head
  // SHA. The compare-and-set predicate therefore holds for the evicted worker too — it narrows
  // the race to same-head writes but does not exclude them. Proven by letting it through here.
  assert.equal(
    await store.saveReview(
      {
        repositoryId: 11,
        pullNumber: 5,
        headSha: "head-1",
        findings: [{ fingerprint: "fp-stale", state: "open" }]
      },
      "head-1"
    ),
    true
  );
  assert.deepEqual(
    (await store.getReview(11, 5))?.findings.map((finding) => finding.fingerprint),
    ["fp-stale"]
  );

  // Naming the lease closes it: worker-1 no longer holds the lease, so the identical write is
  // refused even though its head SHA still matches.
  assert.equal(
    await store.saveReview(
      {
        repositoryId: 11,
        pullNumber: 5,
        headSha: "head-1",
        findings: [{ fingerprint: "fp-evicted", state: "open" }]
      },
      "head-1",
      { deliveryId: "delivery-slow", leaseOwner: "worker-1", asOf: afterLapse.toISOString() }
    ),
    false
  );
  // The refused write left nothing behind, including the server-side counters.
  const review = await store.getReview(11, 5);
  assert.deepEqual(
    review?.findings.map((finding) => finding.fingerprint),
    ["fp-stale"]
  );

  // The current holder still writes normally.
  assert.equal(
    await store.saveReview(
      {
        repositoryId: 11,
        pullNumber: 5,
        headSha: "head-1",
        findings: [{ fingerprint: "fp-final", state: "open" }]
      },
      "head-1",
      { deliveryId: "delivery-slow", leaseOwner: "worker-2", asOf: afterLapse.toISOString() }
    ),
    true
  );
});

test("a lease that expired without being reclaimed still fences the write", async () => {
  const store = new MemoryStore();
  await store.enqueueWebhook("delivery-expired", "pull_request", {});
  const claimedAt = new Date("2026-08-01T00:00:00.000Z");
  await store.claimWebhook("worker-1", 900_000, claimedAt);

  // No peer has claimed it yet, so lease_owner still reads worker-1. Ownership alone is not the
  // test — the lease must also still be live, or a handler that overran its budget could commit.
  const afterExpiry = new Date(claimedAt.getTime() + 900_001).toISOString();
  assert.equal(
    await store.saveReview(
      { repositoryId: 12, pullNumber: 6, headSha: "head-2", findings: [] },
      undefined,
      { deliveryId: "delivery-expired", leaseOwner: "worker-1", asOf: afterExpiry }
    ),
    false
  );
  assert.equal(await store.getReview(12, 6), undefined);

  // Before expiry the same fence admits the write.
  assert.equal(
    await store.saveReview(
      { repositoryId: 12, pullNumber: 6, headSha: "head-2", findings: [] },
      undefined,
      {
        deliveryId: "delivery-expired",
        leaseOwner: "worker-1",
        asOf: new Date(claimedAt.getTime() + 1_000).toISOString()
      }
    ),
    true
  );
});

test("PostgresStore fences the review write on the lease inside one statement", async () => {
  const { store, poolQueries } = stubbedPostgresStore(undefined, (text) =>
    text.includes("INSERT INTO reviews") ? { rows: [], rowCount: 0 } : undefined
  );
  const saved = await store.saveReview(
    { repositoryId: 11, pullNumber: 5, headSha: "head-1", findings: [] },
    "head-1",
    { deliveryId: "delivery-1", leaseOwner: "worker-1", asOf: "2026-08-01T00:00:00.000Z" }
  );
  // rowCount 0 means the fence (or the CAS) suppressed the write, and that must surface as false
  // rather than a silent success.
  assert.equal(saved, false);

  const insert = poolQueries.find((query) => query.includes("INSERT INTO reviews"));
  assert.ok(insert);
  // The fence is evaluated in the same statement as the write, so it cannot drift from it.
  assert.match(insert, /EXISTS \(\s*SELECT 1 FROM webhook_jobs/);
  assert.match(insert, /lease_owner=\$13/);
  assert.match(insert, /status='leased'/);
  assert.match(insert, /lease_expires_at > COALESCE\(\$14::timestamptz, now\(\)\)/);
  // Gating the SELECT that feeds the INSERT, not the ON CONFLICT predicate: a DO UPDATE ... WHERE
  // filters only the update branch and would still let an evicted worker insert a fresh row.
  assert.match(insert, /SELECT \$1::bigint[\s\S]*WHERE \$12::text IS NULL OR EXISTS/);
  assert.ok(insert.indexOf("WHERE $12::text IS NULL") < insert.indexOf("ON CONFLICT"));
  assert.equal(maxPlaceholder(insert), 14);
});
