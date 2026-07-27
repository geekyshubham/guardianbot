import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github.js";

test("GitHub client refuses cross-origin requests before sending its token", async () => {
  let called = false;
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () => {
      called = true;
      return new Response("{}");
    }
  );

  await assert.rejects(
    () => client.request("GET", "https://attacker.example/steal"),
    /configured origin/
  );
  assert.equal(called, false);
});

test("GitHub client prevents callers from overriding installation authorization", async () => {
  let authorization: string | null = null;
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );

  const result = await client.request<{ ok: boolean }>(
    "GET",
    "/repos/example/repository",
    undefined,
    { authorization: "Bearer attacker-controlled" }
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(authorization, "Bearer installation-token");
});

test("GitHub client accepts HTTP only for loopback development", () => {
  assert.doesNotThrow(() => new GitHubClient("token", "http://127.0.0.1:3000"));
  assert.throws(
    () => new GitHubClient("token", "http://api.github.test"),
    /HTTPS/
  );
});
