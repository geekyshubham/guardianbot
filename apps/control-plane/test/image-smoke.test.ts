import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createImageSmokeServer, startImageSmokeServer } from "../src/image-smoke.js";

test("image smoke server exposes only bounded liveness and readiness routes", async () => {
  const server = createImageSmokeServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    for (const path of ["/healthz", "/readyz"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok", mode: "image-smoke" });
      assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    }
    const missing = await fetch(`http://127.0.0.1:${port}/webhooks/github`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("image smoke server rejects invalid ports", async () => {
  await assert.rejects(startImageSmokeServer(0), /integer from 1 through 65535/);
  await assert.rejects(startImageSmokeServer(65_536), /integer from 1 through 65535/);
});
