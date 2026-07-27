import assert from "node:assert/strict";
import test from "node:test";
import { metricsRequestAuthorized } from "../src/http-security.js";

test("keeps metrics closed by default", () => {
  assert.equal(metricsRequestAuthorized(undefined, undefined, false), false);
});

test("permits an explicitly trusted private metrics network", () => {
  assert.equal(metricsRequestAuthorized(undefined, undefined, true), true);
});

test("requires an exact bearer token when one is configured", () => {
  assert.equal(
    metricsRequestAuthorized("Bearer correct-token", "correct-token", false),
    true
  );
  assert.equal(
    metricsRequestAuthorized("Bearer wrong-token", "correct-token", true),
    false
  );
  assert.equal(metricsRequestAuthorized(undefined, "correct-token", true), false);
});
