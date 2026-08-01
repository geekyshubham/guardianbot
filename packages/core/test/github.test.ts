import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient, GitHubRateLimitError } from "../src/github.js";

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

test("GitHub client surfaces a typed rate limit with the reset instant", async () => {
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () =>
      new Response("rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "120", "x-ratelimit-remaining": "0" }
      })
  );

  const sentAt = Date.now();
  await assert.rejects(
    () => client.request("GET", "/repos/example/repository"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError &&
      error.name === "GitHubRateLimitError" &&
      error.remaining === 0 &&
      error.retryAt.getTime() >= sentAt + 119_000 &&
      error.retryAt.getTime() <= sentAt + 121_000
  );
});

test("GitHub client treats an exhausted budget on 403 as a rate limit", async () => {
  const sentAt = Date.now();
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () =>
      new Response("API rate limit exceeded", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(sentAt / 1_000) + 300)
        }
      })
  );

  await assert.rejects(
    () => client.request("GET", "/repos/example/repository"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError &&
      error.retryAt.getTime() > sentAt + 200_000
  );
});

test("GitHub client keeps an unthrottled 403 a permanent failure", async () => {
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () => new Response("Resource not accessible by integration", { status: 403 })
  );

  await assert.rejects(
    () => client.request("GET", "/repos/example/repository"),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof GitHubRateLimitError) &&
      /returned 403/.test(error.message)
  );
});

test("GitHub client keeps request identifiers and response bodies out of thrown messages", async () => {
  // The pathname embeds a retained review-comment identifier and the body echoes request detail
  // back. Callers persist these messages into unbounded columns, so neither may reach the message.
  const commentId = 1234567890;
  const path = `/repos/acme/target/pulls/comments/${commentId}`;
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () =>
      new Response(
        JSON.stringify({
          message: "Not Found",
          documentation_url: "https://docs.github.test/rest",
          resource: `comment ${commentId} authored by reviewer-login`
        }),
        { status: 404 }
      )
  );

  await assert.rejects(
    () => client.request("GET", path),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const message = String(error);
      assert.doesNotMatch(message, new RegExp(String(commentId)));
      assert.doesNotMatch(message, /acme|target|reviewer-login|Not Found|documentation_url/);
      // Still diagnostic, and `returned 404` stays matchable: callers read an absent resource off it.
      assert.match(message, /returned 404/);
      assert.match(message, /GitHub GET/);
      return true;
    }
  );
});

test("GitHub client keeps identifiers out of timeout and rate-limit messages", async () => {
  const path = "/repos/acme/target/collaborators/reviewer-login/permission";
  const timedOut = new GitHubClient("token", "https://api.github.test", 5_000, async () => {
    throw new DOMException("The operation was aborted", "TimeoutError");
  });
  await assert.rejects(
    () => timedOut.request("GET", path),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /acme|target|reviewer-login|permission/);
      assert.match(String(error), /timed out/);
      return true;
    }
  );

  const transport = new GitHubClient("token", "https://api.github.test", 5_000, async () => {
    throw new Error("connect ECONNREFUSED");
  });
  await assert.rejects(
    () => transport.request("GET", path),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /acme|target|reviewer-login|permission/);
      // The transport cause is preserved for local diagnosis without entering the message.
      assert.match(String((error as Error).cause), /ECONNREFUSED/);
      return true;
    }
  );

  const throttled = new GitHubClient(
    "token",
    "https://api.github.test",
    5_000,
    async () =>
      new Response("rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "120", "x-ratelimit-remaining": "0" }
      })
  );
  await assert.rejects(
    () => throttled.request("GET", path),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /acme|target|reviewer-login|permission/);
      assert.match(String(error), /rate limited until/);
      return true;
    }
  );
});

test("GitHub client still reads an absent file as undefined from the redacted message", async () => {
  // getFile discriminates 404 by matching the stringified error, so redaction must not break it.
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () => new Response('{"message":"Not Found"}', { status: 404 })
  );

  assert.equal(await client.getFile("acme", "target", "docs/missing.md", "main"), undefined);
});

test("GitHub client bounds a hostile reset header into a sane retry window", async () => {
  const sentAt = Date.now();
  const client = new GitHubClient(
    "installation-token",
    "https://api.github.test",
    5_000,
    async () =>
      new Response("rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "999999999" }
      })
  );

  await assert.rejects(
    () => client.request("GET", "/repos/example/repository"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError &&
      error.retryAt.getTime() <= sentAt + 60 * 60_000 + 1_000
  );
});
