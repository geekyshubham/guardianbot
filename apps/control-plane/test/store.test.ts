import assert from "node:assert/strict";
import test from "node:test";
import { postgresPoolConfig } from "../src/store.js";

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
