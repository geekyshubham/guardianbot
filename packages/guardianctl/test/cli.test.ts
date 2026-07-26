import assert from "node:assert/strict";
import test from "node:test";
import { parseRepository } from "../src/index.js";

test("repository parser accepts one owner and repository", () => {
  assert.deepEqual(parseRepository("Geekyshubham/guardianbot"), {
    owner: "Geekyshubham",
    repo: "guardianbot"
  });
  assert.throws(() => parseRepository("guardianbot"));
});
