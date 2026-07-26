import assert from "node:assert/strict";
import test from "node:test";
import { addedLineRanges, redactUntrustedText } from "../src/service.js";

test("addedLineRanges permits only added lines", () => {
  assert.deepEqual(
    addedLineRanges("@@ -1,3 +3,4 @@\n context\n-old\n+first\n+second\n context"),
    [{ start: 4, end: 5 }]
  );
  assert.deepEqual(addedLineRanges("@@ -4 +8,0 @@\n-old"), []);
});

test("redacts common credentials from untrusted repository text", () => {
  assert.equal(
    redactUntrustedText("token=hello-this-is-secret password=hunter2"),
    "token=[REDACTED] password=[REDACTED]"
  );
});
