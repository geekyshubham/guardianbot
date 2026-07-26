import assert from "node:assert/strict";
import test from "node:test";
import { callerWorkflowMatches, parseRepository } from "../src/index.js";

test("repository parser accepts one owner and repository", () => {
  assert.deepEqual(parseRepository("Geekyshubham/guardianbot"), {
    owner: "Geekyshubham",
    repo: "guardianbot"
  });
  assert.throws(() => parseRepository("guardianbot"));
});

test("caller drift comparison tolerates only line-ending and final-newline differences", () => {
  assert.equal(callerWorkflowMatches("name: GuardianBot\r\n", "name: GuardianBot\n"), true);
  assert.equal(
    callerWorkflowMatches(
      "runtime-env: |\n  NODE_ENV=production\n",
      "runtime-env: |\n  NODE_ENV=development\n"
    ),
    false
  );
});
