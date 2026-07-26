import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectRepository,
  evaluateGate,
  generateCallerWorkflow,
  generateGuardianConfig,
  indexRepository,
  normalizeSemgrep,
  normalizeTrivy,
  retrieveContext,
  scoreChangeRisk,
  validateGuardianConfig,
  verifyWebhookSignature
} from "../src/index.js";
import { createHmac } from "node:crypto";

const snapshot = {
  owner: "Geekyshubham",
  name: "service",
  defaultBranch: "main",
  visibility: "public" as const,
  files: [
    "package.json",
    "package-lock.json",
    "Dockerfile",
    "src/auth.ts",
    "tests/auth.test.ts",
    ".github/CODEOWNERS",
    "openapi.json"
  ],
  languages: { TypeScript: 1000 },
  fileContents: {
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}",
    Dockerfile: "HEALTHCHECK CMD curl http://localhost/health"
  }
};

test("detects a reusable repository configuration", () => {
  const detection = detectRepository(snapshot);
  assert.deepEqual(detection.packageManagers, ["npm"]);
  assert.equal(detection.dockerfiles[0], "Dockerfile");
  const config = generateGuardianConfig(snapshot, detection, "a".repeat(40));
  assert.deepEqual(validateGuardianConfig(config), []);
  assert.equal(config.scanners.mode, "report-only");
  assert.ok(config.image);
});

test("generates an immutable reusable workflow caller", () => {
  const workflow = generateCallerWorkflow({
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main"
  });
  assert.match(workflow, new RegExp(`@${"b".repeat(40)}`));
  assert.match(workflow, /reusable-security\.yml/);
});

test("generates ephemeral runtime key references without repository-side values", () => {
  const workflow = generateCallerWorkflow({
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main",
    image: {
      dockerfile: "Dockerfile",
      context: ".",
      platform: "linux/amd64",
      registry: "ghcr.io/geekyshubham/service",
      healthPath: "/health",
      sbomFormat: "cyclonedx-json",
      ephemeralEnvironment: ["APPLICATION_SMOKE_SECRET"]
    }
  });
  assert.match(workflow, /ephemeral-env-keys: "APPLICATION_SMOKE_SECRET"/);
  assert.doesNotMatch(workflow, /APPLICATION_SMOKE_SECRET=/);
});

test("normalizes and gates deterministic findings", () => {
  const semgrep = normalizeSemgrep({
    results: [
      {
        check_id: "auth.rule",
        path: "src/auth.ts",
        start: { line: 4 },
        extra: { severity: "ERROR", message: "Missing check" }
      }
    ]
  });
  const trivy = normalizeTrivy({
    Results: [
      {
        Target: "package-lock.json",
        Vulnerabilities: [
          {
            VulnerabilityID: "CVE-1",
            PkgName: "dep",
            InstalledVersion: "1",
            FixedVersion: "2",
            Severity: "HIGH",
            Title: "Dependency issue"
          }
        ]
      }
    ]
  });
  const decision = evaluateGate({
    findings: [...semgrep, ...trivy],
    baselineFingerprints: new Set(),
    mode: "enforce"
  });
  assert.equal(decision.conclusion, "failure");
  assert.equal(decision.blockers.length, 2);
});

test("indexes symbols and retrieves local context", () => {
  const index = indexRepository({
    repository: "Geekyshubham/service",
    commitSha: "c".repeat(40),
    files: {
      "src/auth.ts": "export function authorize(user) {\n return user.role === 'admin';\n}",
      "src/data.ts": "export function loadData() {\n return db.query('select 1');\n}"
    }
  });
  assert.equal(index.symbols.length, 2);
  assert.equal(retrieveContext(index, "admin role authorization", 1)[0]?.name, "authorize");
});

test("scores security-sensitive changes as high risk", () => {
  const risk = scoreChangeRisk(
    [{ path: "src/auth/permissions.ts", additions: 30, deletions: 2 }],
    false
  );
  assert.equal(risk.highRisk, true);
});

test("verifies GitHub webhook HMAC", () => {
  const body = Buffer.from('{"ok":true}');
  const secret = "secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, "sha256=bad", secret), false);
});
