import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(
  repositoryRoot,
  ".github/workflows/reusable-security.yml"
);

function trivyStep(): string {
  const workflow = readFileSync(workflowPath, "utf8");
  const stepStart = workflow.indexOf(
    "- name: Trivy filesystem, dependencies, configuration, licenses, and secrets"
  );
  const stepEnd = workflow.indexOf(
    "\n      - name: Evaluate new-finding policy",
    stepStart
  );
  assert.ok(stepStart >= 0 && stepEnd > stepStart);
  return workflow.slice(stepStart, stepEnd);
}

function sanitizerScript(step: string): string {
  const heredocStart = step.indexOf("<<'NODE'\n");
  const heredocEnd = step.indexOf("\n          NODE", heredocStart);
  assert.ok(heredocStart >= 0 && heredocEnd > heredocStart);
  return step
    .slice(heredocStart + "<<'NODE'\n".length, heredocEnd)
    .split("\n")
    .map((line) => {
      if (!line) return line;
      assert.match(line, /^ {10}/);
      return line.slice(10);
    })
    .join("\n");
}

test("Trivy sanitizer accepts verified zero-result filesystem reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "guardianbot-trivy-empty-"));
  const sanitizer = sanitizerScript(trivyStep());
  const fixtures: Array<{
    name: string;
    report: Record<string, unknown>;
  }> = [
    {
      name: "docs-only",
      report: {
        SchemaVersion: 2,
        ArtifactName: "/workspace",
        ArtifactType: "filesystem",
        Results: null
      }
    },
    {
      name: "ruby-tap",
      report: {
        SchemaVersion: 2,
        ArtifactName: "/workspace",
        ArtifactType: "filesystem"
      }
    }
  ];

  try {
    for (const fixture of fixtures) {
      const inputPath = join(directory, `${fixture.name}.raw.json`);
      const outputPath = join(directory, `${fixture.name}.json`);
      writeFileSync(inputPath, JSON.stringify(fixture.report));
      const result = spawnSync(
        process.execPath,
        ["-", inputPath, outputPath],
        {
          encoding: "utf8",
          input: sanitizer
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), {
        SchemaVersion: 2,
        ArtifactName: "/workspace",
        ArtifactType: "filesystem",
        Results: [],
        scanner_error: false
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Trivy sanitizer rejects malformed reports and preserves scanner failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "guardianbot-trivy-invalid-"));
  const step = trivyStep();
  const sanitizer = sanitizerScript(step);
  const malformedFixtures: Array<{
    name: string;
    raw: string;
  }> = [
    {
      name: "invalid-json",
      raw: "{"
    },
    {
      name: "missing-artifact",
      raw: JSON.stringify({
        SchemaVersion: 2,
        ArtifactType: "filesystem",
        Results: null
      })
    },
    {
      name: "invalid-results-type",
      raw: JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "/workspace",
        ArtifactType: "filesystem",
        Results: {}
      })
    }
  ];

  try {
    for (const fixture of malformedFixtures) {
      const inputPath = join(directory, `${fixture.name}.raw.json`);
      const outputPath = join(directory, `${fixture.name}.json`);
      writeFileSync(inputPath, fixture.raw);
      const result = spawnSync(
        process.execPath,
        ["-", inputPath, outputPath],
        {
          encoding: "utf8",
          input: sanitizer
        }
      );
      assert.notEqual(result.status, 0, fixture.name);
      assert.throws(() => readFileSync(outputPath, "utf8"));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(step.match(/\{"scanner_error":true\}/g)?.length, 2);
});
