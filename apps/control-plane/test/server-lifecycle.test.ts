import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const serverEntry = join(here, "../src/server.ts");
const serverSource = readFileSync(serverEntry, "utf8");

const WEBHOOK_SECRET = "test-webhook-secret";

/** The body of shutdown(), used for ordering assertions the runtime tests cannot observe. */
function shutdownBody(): string {
  const start = serverSource.indexOf("async function shutdown(");
  assert.notEqual(start, -1, "shutdown() not found");
  // Matched independently of on/once so this helper does not couple every caller to the
  // registration form that only the signal test is about.
  const end = /process\.(?:on|once)\("SIGINT"/.exec(serverSource.slice(start))?.index;
  assert.notEqual(end, undefined, "signal registration not found");
  return serverSource.slice(start, start + end!);
}

/**
 * Drops line comments so a "must not appear" assertion cannot be satisfied or defeated by
 * prose that happens to quote the call it is describing.
 */
function withoutComments(source: string): string {
  return source.replaceAll(/^\s*\/\/.*$/gm, "");
}

function numericConstant(name: string): number {
  const match = new RegExp(`const ${name} = (\\d[\\d_]*);`).exec(serverSource);
  assert.ok(match, `${name} not declared`);
  return Number(match[1]!.replaceAll("_", ""));
}

let nextPort = 41500 + Math.floor(Math.random() * 2000);

interface Booted {
  child: ChildProcess;
  port: number;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Boots the real server entrypoint in a child process so signal handling and event-loop
 * lifetime are exercised for real. In-memory store, monitoring off: the drain has nothing
 * slow in it except what a test deliberately holds open.
 */
async function bootServer(): Promise<Booted> {
  const port = nextPort++;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", serverEntry],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "not-a-real-key",
        GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
        GUARDIANBOT_EVIDENCE_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
        GUARDIANBOT_TRUSTED_WORKFLOW_SHA: "a".repeat(40),
        GUARDIANBOT_MONITORING_ENABLED: "0",
        GUARDIANBOT_ALLOW_INMEMORY_STORE: "1",
        DATABASE_URL: ""
      }
    }
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited during boot: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        await response.text();
        break;
      }
      await response.text();
    } catch {
      // Listener not up yet.
    }
    if (Date.now() > deadline) throw new Error(`server did not boot: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, port, exit };
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens a socket, writes complete webhook headers plus a prefix of the body, and leaves the
 * request hanging. This is precisely the shape closeIdleConnections() refuses to touch: the
 * request has begun, so the socket is not idle.
 */
function openStalledWebhook(port: number, body: string): {
  finish: () => void;
  response: Promise<string>;
  destroy: () => void;
} {
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  const socket = connect(port, "127.0.0.1");
  let received = "";
  const response = new Promise<string>((resolve, reject) => {
    socket.on("data", (chunk) => {
      received += String(chunk);
      if (received.includes("\r\n\r\n")) resolve(received);
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
  const ready = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const bodyBytes = Buffer.byteLength(body, "utf8");
  void ready.then(() => {
    socket.write(
      [
        "POST /webhooks/github HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "content-type: application/json",
        "x-github-event: ping",
        "x-github-delivery: stalled-delivery-1",
        `x-hub-signature-256: ${signature}`,
        `content-length: ${bodyBytes}`,
        "",
        ""
      ].join("\r\n")
    );
    // Headers are complete and one byte of body is sent; the rest is withheld.
    socket.write(body.slice(0, 1));
  });
  return {
    finish: () => {
      void ready.then(() => socket.write(body.slice(1)));
    },
    response,
    destroy: () => socket.destroy()
  };
}

test(
  "a second SIGTERM during drain is absorbed instead of terminating the process",
  { timeout: 60_000 },
  async () => {
    const { child, port, exit } = await bootServer();
    // Hold the drain open with a request that has begun but not finished.
    const stalled = openStalledWebhook(port, JSON.stringify({ zen: "hold the drain open" }));
    await sleep(500);

    child.kill("SIGTERM");
    await sleep(750);
    assert.ok(
      alive(child),
      "server should still be draining after the first SIGTERM while a request is in flight"
    );

    // With process.once the listener is gone by now, so this signal reaches Node's default
    // terminate action and kills the process mid-drain while a lease may be held.
    child.kill("SIGTERM");
    await sleep(1_500);
    assert.ok(alive(child), "second SIGTERM must be absorbed by the shuttingDown guard");
    assert.equal(child.signalCode, null, "process must not be terminated by signal");

    // Let the drain finish so the child exits on its own terms.
    stalled.finish();
    const result = await Promise.race([
      exit,
      sleep(20_000).then(() => "timeout" as const)
    ]);
    stalled.destroy();
    if (result === "timeout") {
      child.kill("SIGKILL");
      assert.fail("server did not exit after the in-flight request completed");
    }
    assert.equal(result.signal, null, "clean shutdown must not report a killing signal");
    assert.equal(result.code, 0, "clean shutdown must exit 0");
  }
);

test(
  "an in-flight webhook still receives its 202 after shutdown begins",
  { timeout: 60_000 },
  async () => {
    const { child, port, exit } = await bootServer();
    const body = JSON.stringify({ zen: "answer me before you close my socket" });
    const stalled = openStalledWebhook(port, body);
    await sleep(500);

    child.kill("SIGTERM");
    await sleep(750);
    // The connection was active when shutdown started, so closing all connections at this
    // point would destroy the socket before the handler could answer.
    stalled.finish();

    const raw = await Promise.race([
      stalled.response,
      sleep(20_000).then(() => "timeout" as const)
    ]);
    if (raw === "timeout") {
      child.kill("SIGKILL");
      assert.fail("in-flight webhook never received a response");
    }
    assert.match(
      raw,
      /^HTTP\/1\.1 202/,
      `in-flight webhook must be accepted, got: ${JSON.stringify(raw.slice(0, 120))}`
    );

    stalled.destroy();
    const result = await Promise.race([
      exit,
      sleep(20_000).then(() => "timeout" as const)
    ]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      assert.fail("server did not exit after the in-flight request completed");
    }
    assert.equal(result.code, 0);
  }
);

test(
  "an abandoned stalled request is reaped instead of holding the drain to the full budget",
  { timeout: 120_000 },
  async () => {
    const drainBudget = numericConstant("DRAIN_BUDGET_MS");
    const requestDrainBudget = numericConstant("REQUEST_DRAIN_BUDGET_MS");
    const { child, port, exit } = await bootServer();
    // Headers complete, one body byte sent, then the client goes away without ever
    // finishing. closeIdleConnections() will not touch this socket: its request has begun.
    const stalled = openStalledWebhook(port, JSON.stringify({ zen: "never finished" }));
    await sleep(500);

    const startedAt = Date.now();
    child.kill("SIGTERM");
    // Generous margin over the request drain deadline, but still far below the overall drain
    // budget, so this only passes if shutdown reaps the stalled request rather than waiting
    // out the full window. server.requestTimeout cannot do this job: server.close() clears
    // Node's connections-checking interval, so it stops being enforced during the drain.
    const budgetBound = Math.min(drainBudget, requestDrainBudget + 20_000);
    const result = await Promise.race([
      exit,
      sleep(budgetBound).then(() => "timeout" as const)
    ]);
    const elapsed = Date.now() - startedAt;
    stalled.destroy();
    if (result === "timeout") {
      child.kill("SIGKILL");
      assert.fail(
        `server still running ${elapsed}ms after SIGTERM; a stalled request must not pin ` +
          `the event loop for the full ${drainBudget}ms drain budget`
      );
    }
    assert.equal(result.signal, null, "the process must choose its own exit, not be killed");
    assert.ok(
      elapsed < drainBudget,
      `shutdown took ${elapsed}ms, which must stay under the ${drainBudget}ms budget`
    );
  }
);

test("signal handlers stay registered so the shuttingDown guard can absorb repeats", () => {
  // process.once removes the listener after the first signal, leaving Node's default
  // terminate action to kill the process mid-drain.
  assert.doesNotMatch(serverSource, /process\.once\("SIGINT"/);
  assert.doesNotMatch(serverSource, /process\.once\("SIGTERM"/);
  assert.match(serverSource, /process\.on\("SIGINT", \(\) => void shutdown\("SIGINT"\)\)/);
  assert.match(serverSource, /process\.on\("SIGTERM", \(\) => void shutdown\("SIGTERM"\)\)/);
  // The guard is what makes a repeat signal a no-op rather than a second drain.
  assert.match(shutdownBody(), /if \(shuttingDown\) return;/);
});

test("a blown drain budget forces an exit instead of running unbounded", () => {
  const body = shutdownBody();
  // process.exitCode alone cannot end a process whose event loop is still pinned by a
  // continuation that ignored the abort, and this file has no other exit path.
  assert.match(body, /if \(!drained\) \{/);
  // Bounded to the branch itself: the post-drain tail legitimately closes the store.
  const blownEnd = body.indexOf("server.closeAllConnections()");
  assert.notEqual(blownEnd, -1, "post-drain connection close not found");
  const blown = withoutComments(body.slice(body.indexOf("if (!drained) {"), blownEnd));
  assert.match(blown, /guardianbot\.shutdown_drain_budget_exceeded/);
  assert.match(blown, /process\.exit\(/);
  assert.match(blown, /\.unref\(\)/, "the force-exit timer must not itself hold the loop open");
  // The lease connection must survive a blown budget: a live handler still needs the store.
  assert.doesNotMatch(blown, /store\.close\(\)/);
});

test("the forced exit lands inside the orchestrator's stop grace", () => {
  const drainBudget = numericConstant("DRAIN_BUDGET_MS");
  const forceGrace = numericConstant("FORCE_EXIT_GRACE_MS");
  assert.ok(forceGrace > 0, "force exit must allow some grace for the drain to finish first");
  // infra/docker-compose.yml sets stop_grace_period: 130s for the control plane.
  const compose = readFileSync(join(repoRoot, "infra/docker-compose.yml"), "utf8");
  const graceMatch = /stop_grace_period:\s*(\d+)s/.exec(compose);
  assert.ok(graceMatch, "control-plane stop_grace_period not found");
  const stopGraceMs = Number(graceMatch[1]) * 1_000;
  assert.ok(
    drainBudget + forceGrace < stopGraceMs,
    `drain budget ${drainBudget}ms + force grace ${forceGrace}ms must stay under ${stopGraceMs}ms`
  );
});

test("active connections are closed after the drain, not before", () => {
  const body = shutdownBody();
  // closeIdleConnections() skips any socket whose request has begun, so on its own it lets a
  // stalled request hold the event loop past the orchestrator's stop grace.
  assert.match(body, /server\.closeAllConnections\(\);/);
  const drainRace = body.indexOf("await Promise.race([settled, budget])");
  assert.notEqual(drainRace, -1, "drain race not found");
  assert.ok(
    body.indexOf("server.closeAllConnections()") > drainRace,
    "closeAllConnections() must run after the drain so in-flight webhooks still answer"
  );
  // In-flight requests must be part of what the drain waits for.
  assert.match(body, /requestsIdle/);
  assert.match(serverSource, /inFlightRequests \+= 1;/);
});

test("server request timeouts are bounded well under the drain budget", () => {
  const drainBudget = numericConstant("DRAIN_BUDGET_MS");
  for (const name of ["REQUEST_TIMEOUT_MS", "HEADERS_TIMEOUT_MS", "KEEP_ALIVE_TIMEOUT_MS"]) {
    const value = numericConstant(name);
    assert.ok(value > 0, `${name} must be positive; 0 disables the timeout entirely`);
    assert.ok(value < drainBudget, `${name} (${value}ms) must be under ${drainBudget}ms`);
  }
  // Node's defaults (requestTimeout 300s) outlive the whole drain window, so they must be
  // overridden explicitly on the server instance.
  assert.match(serverSource, /server\.requestTimeout = REQUEST_TIMEOUT_MS;/);
  assert.match(serverSource, /server\.headersTimeout = HEADERS_TIMEOUT_MS;/);
  assert.match(serverSource, /server\.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;/);
});
