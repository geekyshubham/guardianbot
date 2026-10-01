import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  MAX_SCANNER_RELEASE_BRANCHES,
  SEMGREP_NATIVE_SEVERITY,
  SEMGREP_POLICY_SEVERITIES,
  SEMGREP_POLICY_SEVERITY_KEY,
  type GuardianConfig,
  callerCoveredBranches,
  evaluateGate,
  generateCallerWorkflow,
  normalizeSemgrep,
  semgrepPolicySeverity,
  validateAgainstJsonSchema,
  validateGuardianConfig
} from "../src/index.js";

const repositoryRoot = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), "utf8");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const schema = JSON.parse(read("schemas/repository-config.v1.schema.json")) as object;

function config(scanners: Partial<GuardianConfig["scanners"]> = {}): GuardianConfig {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "a".repeat(40),
    repository: { defaultBranch: "main", releaseBranches: ["main"], languages: ["python"], relatedRepositories: [] },
    review: {
      automatic: true,
      drafts: "manual",
      incremental: true,
      maxInlineComments: 8,
      categories: ["security"],
      highRiskPaths: [],
      contextDocuments: [],
      excludedPaths: []
    },
    scanners: { mode: "report-only", semgrep: true, trivy: true, suppressions: [], ...scanners },
    image: null,
    dast: null
  };
}

const base = { guardianRepository: "Acme/guardianbot", workflowSha: "c".repeat(40), defaultBranch: "main" };
const image = {
  dockerfile: "Dockerfile",
  context: ".",
  platform: "linux/amd64" as const,
  registry: "ghcr.io/acme/service",
  healthPath: "/health",
  sbomFormat: "cyclonedx-json" as const
};
const dast = {
  allowedOrigin: "https://staging.example.com",
  openapi: "/openapi.json",
  authenticationProfile: "staging-user",
  sessionAssertionPath: "/api/session"
} as never;

test("callers without scanners.releaseBranches stay byte-identical to the previous generator", () => {
  assert.equal(
    generateCallerWorkflow({ ...base, scannerMode: "report-only" }),
    fixture("caller-workflow-report-only.yml")
  );
  assert.equal(
    generateCallerWorkflow({ ...base, scannerMode: "enforce", image, dast }),
    fixture("caller-workflow-enforce-image-dast.yml")
  );
  assert.equal(
    generateCallerWorkflow({ ...base, scannerMode: "report-only", releaseBranches: [] }),
    fixture("caller-workflow-report-only.yml")
  );
});

test("release branches add exact pull_request and push coverage without changing promotion", () => {
  const workflow = generateCallerWorkflow({
    ...base,
    scannerMode: "enforce",
    image,
    releaseBranches: ["release/1.x", "main", "release/2.x"]
  });
  assert.match(
    workflow,
    /pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]\n    branches: \["main", "release\/1\.x", "release\/2\.x"\]\n  push:\n    branches: \["main", "release\/1\.x", "release\/2\.x"\]\n/
  );
  // Image push and promotion remain bound to the default branch only.
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /refs\/heads\/release/);
  assert.deepEqual(callerCoveredBranches("main", ["main", "release/1.x"]), ["main", "release/1.x"]);
});

test("scanners.releaseBranches accepts exact branch names and rejects globs, refs, negation, and empty lists", () => {
  const valid = config({ releaseBranches: ["release/1.x", "hotfix-2026"] });
  assert.deepEqual(validateGuardianConfig(valid), []);
  assert.deepEqual(validateAgainstJsonSchema(schema, valid), []);

  for (const branch of ["release/*", "refs/heads/release", "!release", "release/**", "a b", "release..x", "release/"]) {
    const invalid = config({ releaseBranches: [branch] });
    assert.ok(validateGuardianConfig(invalid).length > 0, `config accepted ${branch}`);
  }
  for (const branch of ["release/*", "!release", "a b"]) {
    assert.ok(validateAgainstJsonSchema(schema, config({ releaseBranches: [branch] })).length > 0, `schema accepted ${branch}`);
  }
  assert.match(validateGuardianConfig(config({ releaseBranches: [] })).join("\n"), /must not be empty/);
  const tooMany = Array.from({ length: MAX_SCANNER_RELEASE_BRANCHES + 1 }, (_, index) => `release/${index}`);
  assert.match(validateGuardianConfig(config({ releaseBranches: tooMany })).join("\n"), /at most 20/);
  assert.ok(validateAgainstJsonSchema(schema, config({ releaseBranches: tooMany })).length > 0);
});

test("Semgrep policy severity overrides native severity and unmapped rules fall back visibly", () => {
  const findings = normalizeSemgrep({
    results: [
      {
        check_id: "mapped.down",
        path: "a.py",
        start: { line: 1 },
        extra: { severity: "ERROR", message: "m", metadata: { [SEMGREP_POLICY_SEVERITY_KEY]: "medium" } }
      },
      {
        check_id: "mapped.up",
        path: "b.py",
        start: { line: 2 },
        extra: { severity: "WARNING", message: "m", metadata: { [SEMGREP_POLICY_SEVERITY_KEY]: "Critical" } }
      },
      {
        check_id: "unmapped",
        path: "c.py",
        start: { line: 3 },
        extra: { severity: "ERROR", message: "m", metadata: { [SEMGREP_POLICY_SEVERITY_KEY]: "severe" } }
      }
    ]
  });
  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.severity, finding.severitySource]),
    [
      ["mapped.down", "medium", "policy"],
      ["mapped.up", "critical", "policy"],
      ["unmapped", "high", "native"]
    ]
  );
  const decision = evaluateGate({ findings, baselineFingerprints: new Set(), mode: "enforce" });
  assert.deepEqual(
    decision.blockers.map((finding) => finding.ruleId).sort(),
    ["mapped.up", "unmapped"]
  );
  assert.deepEqual(semgrepPolicySeverity({}, undefined), { severity: "medium", severitySource: "native" });
});

test("every rule in the immutable rule pack carries a valid organization severity", () => {
  const pack = parseYaml(read("rules/semgrep.yml")) as {
    rules: Array<{ id: string; metadata?: Record<string, unknown> }>;
  };
  assert.ok(pack.rules.length > 0);
  for (const rule of pack.rules) {
    const mapped = rule.metadata?.[SEMGREP_POLICY_SEVERITY_KEY];
    assert.ok(
      typeof mapped === "string" && (SEMGREP_POLICY_SEVERITIES as readonly string[]).includes(mapped),
      `${rule.id} lacks a valid ${SEMGREP_POLICY_SEVERITY_KEY}`
    );
  }
});

test("security workflow and core agree on the Semgrep severity policy", () => {
  const workflow = read(".github/workflows/reusable-security.yml");
  assert.match(
    workflow,
    new RegExp(`const SEMGREP_POLICY_SEVERITY_KEY = "${SEMGREP_POLICY_SEVERITY_KEY}";`)
  );
  assert.ok(
    workflow.includes(
      `const SEMGREP_POLICY_SEVERITIES = [${SEMGREP_POLICY_SEVERITIES.map((value) => JSON.stringify(value)).join(", ")}];`
    )
  );
  const nativeBlock = /const semgrepSeverity = \{([^}]*)\};/.exec(workflow)?.[1] ?? "";
  const workflowNative = Object.fromEntries(
    [...nativeBlock.matchAll(/([A-Z]+): "([a-z]+)"/g)].map((match) => [match[1], match[2]])
  );
  assert.deepEqual(workflowNative, SEMGREP_NATIVE_SEVERITY);
  assert.match(workflow, /severitySource: policyMapped \? "policy" : "native"/);
  assert.match(workflow, /has no policy severity mapping; native severity used/);
  // The gate still blocks only critical/high Semgrep findings.
  assert.match(
    workflow,
    /if \(finding\.source === "semgrep"\) \{\n\s+return finding\.severity === "critical" \|\| finding\.severity === "high";/
  );
});
