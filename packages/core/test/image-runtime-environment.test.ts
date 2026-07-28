import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(
  repositoryRoot,
  ".github/workflows/reusable-image.yml"
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8")) as {
  jobs: {
    "validate-image": {
      steps: Array<{ name?: string; run?: string }>;
    };
  };
};
const dependencyStep = workflow.jobs["validate-image"].steps.find(
  (step) => step.name === "Start disposable dependencies"
);

assert.equal(typeof dependencyStep?.run, "string");

const parserStart = dependencyStep.run.indexOf(
  "install -m 600 /dev/null guardianbot-runtime.env"
);
const parserEnd = dependencyStep.run.indexOf(
  "IFS=',' read -ra ephemeral_keys"
);

assert.ok(parserStart >= 0);
assert.ok(parserEnd > parserStart);

const runtimeEnvironmentParser = [
  "set -euo pipefail",
  dependencyStep.run.slice(parserStart, parserEnd)
].join("\n");

function parseRuntimeEnvironment(input: string): {
  status: number | null;
  stderr: string;
  stdout: string;
  contents: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "guardianbot-runtime-env-"));
  try {
    const result = spawnSync("bash", ["-c", runtimeEnvironmentParser], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        INPUT_RUNTIME_ENV: input
      }
    });
    const environmentPath = join(directory, "guardianbot-runtime.env");
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      contents:
        result.status === 0 ? readFileSync(environmentPath, "utf8") : ""
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("image runtime environment treats generated comment placeholders as empty", () => {
  const result = parseRuntimeEnvironment(
    "# No runtime environment values configured."
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.contents, "");
});

test("image runtime environment ignores comments but preserves valid entries", () => {
  const result = parseRuntimeEnvironment(
    [
      "  # Repository-specific values follow.",
      "DATABASE_HOST=guardianbot-postgres",
      "",
      "\t# Another comment.",
      "FEATURE_FLAG=true"
    ].join("\n")
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.contents,
    "DATABASE_HOST=guardianbot-postgres\nFEATURE_FLAG=true\n"
  );
});

test("image runtime environment rejects malformed non-comment entries", () => {
  for (const malformed of [
    "lowercase=value",
    "NOT_AN_ASSIGNMENT",
    " LEADING_SPACE=value"
  ]) {
    const result = parseRuntimeEnvironment(malformed);
    assert.notEqual(result.status, 0, malformed);
    assert.match(`${result.stdout}${result.stderr}`, /Invalid runtime environment key/);
  }
});
