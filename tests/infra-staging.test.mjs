import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = path.resolve("infra/staging");
const compose = parse(fs.readFileSync(path.join(root, "compose.yml"), "utf8"));

test("the application staging stack pins exact promoted images", () => {
  const expected = {
    caddy: "caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
    routelens:
      "ghcr.io/geekyshubham/routelens@sha256:ed954dbddadff7b27e390786f05a4e9f4af5cb817caa2e3c661ed355b9f93332",
    "routelens-postgres":
      "postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb",
    "routelens-redis":
      "redis@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2",
    astranull:
      "ghcr.io/geekyshubham/astranull@sha256:a6d675fea8fe6ee362c36227c38b1daba91a21e7fdda8fcd061c63f5bd3ebbd0",
    "astranull-postgres":
      "postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb"
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(compose.services).map(([name, service]) => [name, service.image])
    ),
    expected
  );
});

test("only Caddy is public and repository data planes stay isolated", () => {
  assert.deepEqual(compose.services.caddy.ports, ["80:80", "443:443"]);
  for (const [name, service] of Object.entries(compose.services)) {
    if (name !== "caddy") assert.equal(service.ports, undefined);
  }

  assert.equal(compose.networks.routelens.internal, true);
  assert.equal(compose.networks.astranull.internal, true);
  assert.deepEqual(compose.services.routelens.networks, ["routelens"]);
  assert.deepEqual(compose.services["routelens-postgres"].networks, ["routelens"]);
  assert.deepEqual(compose.services["routelens-redis"].networks, ["routelens"]);
  assert.deepEqual(
    new Set(compose.services.astranull.networks),
    new Set(["edge", "astranull"])
  );
  assert.deepEqual(compose.services["astranull-postgres"].networks, ["astranull"]);
  assert.deepEqual(
    new Set(compose.services.caddy.networks),
    new Set(["edge", "routelens", "astranull"])
  );
});

test("staging secrets are references generated into a root-only host file", () => {
  const example = fs.readFileSync(path.join(root, "env.example"), "utf8");
  assert.doesNotMatch(example, /ghp_|github_pat_|do[por]_v1_/i);
  assert.match(example, /ROUTELENS_POSTGRES_PASSWORD=generated/);
  assert.match(example, /ASTRANULL_SECRET_ENCRYPTION_KEY=generated/);

  const generator = fs.readFileSync(path.join(root, "scripts/generate-env.sh"), "utf8");
  assert.match(generator, /umask 077/);
  assert.match(generator, /install -m 600/);
});

test("the production control-plane gates container health on readiness", () => {
  const production = parse(fs.readFileSync(path.resolve("infra/docker-compose.yml"), "utf8"));
  const probe = production.services["control-plane"].healthcheck.test.at(-1);
  // /healthz answers 200 while the store is dead or the worker is wedged, so
  // only /readyz turns a broken dependency into an unhealthy container.
  assert.match(probe, /http:\/\/127\.0\.0\.1:3000\/readyz/);
  assert.doesNotMatch(probe, /\/healthz/);
  assert.equal(
    production.services.caddy.depends_on["control-plane"].condition,
    "service_healthy"
  );
});

test("control-plane stop grace is strictly longer than the application drain budget", () => {
  const production = parse(fs.readFileSync(path.resolve("infra/docker-compose.yml"), "utf8"));
  const serverSource = fs.readFileSync(
    path.resolve("apps/control-plane/src/server.ts"),
    "utf8"
  );
  const drainMatch = /const DRAIN_BUDGET_MS = (\d[\d_]*);/.exec(serverSource);
  assert.ok(drainMatch, "DRAIN_BUDGET_MS not declared");
  const drainMs = Number(drainMatch[1].replaceAll("_", ""));

  const grace = String(production.services["control-plane"].stop_grace_period ?? "");
  const graceMatch = /^(\d+)(ms|s|m|h)$/.exec(grace);
  assert.ok(graceMatch, `unrecognized stop_grace_period: ${grace}`);
  const amount = Number(graceMatch[1]);
  const unit = graceMatch[2];
  const graceMs =
    unit === "ms"
      ? amount
      : unit === "s"
        ? amount * 1_000
        : unit === "m"
          ? amount * 60_000
          : amount * 3_600_000;

  assert.ok(
    graceMs > drainMs,
    `stop_grace_period ${grace} (${graceMs}ms) must exceed DRAIN_BUDGET_MS (${drainMs}ms)`
  );
});

test("operator scripts pass Bash syntax validation", () => {
  for (const script of fs
    .readdirSync(path.join(root, "scripts"))
    .filter((entry) => entry.endsWith(".sh"))) {
    execFileSync("bash", ["-n", path.join(root, "scripts", script)]);
  }
});
