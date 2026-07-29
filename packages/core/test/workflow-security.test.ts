import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function repositoryFile(path: string): string {
  return readFileSync(`${repositoryRoot}/${path}`, "utf8");
}

test("reusable workflows resolve attestation only from the exact workflow release", () => {
  const workflows = [
    ".github/workflows/reusable-security.yml",
    ".github/workflows/reusable-image.yml",
    ".github/workflows/reusable-dast.yml"
  ].map(repositoryFile);

  for (const workflow of workflows) {
    assert.doesNotMatch(workflow, /evidence-attestation-url/);
    assert.doesNotMatch(workflow, /GUARDIANBOT_EVIDENCE_ATTESTATION_URL/);
    assert.doesNotMatch(workflow, /process\.env\.EVIDENCE_ATTESTATION_URL/);
    assert.match(workflow, /repository: \$\{\{ job\.workflow_repository \}\}/);
    assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/);
    assert.match(
      workflow,
      /checkedOutSha !== process\.env\.JOB_WORKFLOW_SHA\.toLowerCase\(\)/
    );
    assert.match(workflow, /deployments", "production\.json"/);
    assert.match(workflow, /new URL\(deployment\.evidenceAttestationUrl\)/);
    assert.match(workflow, /const readJsonLimited = async \(response, maximum\)/);
    assert.doesNotMatch(workflow, /\.json\(\)/);
  }

  const deployment = JSON.parse(
    repositoryFile("deployments/production.json")
  ) as Record<string, unknown>;
  assert.deepEqual(deployment, {
    schemaVersion: "1.0.0",
    environment: "production",
    evidenceAttestationUrl:
      "https://guardianbot-prod-sfdme.ondigitalocean.app/evidence/attest"
  });
});

test("image workflow masks generated runtime values and never dumps container logs", () => {
  const workflow = repositoryFile(".github/workflows/reusable-image.yml");
  const generatedAt = workflow.indexOf(
    'generated_value="$(openssl rand -hex 32)"'
  );
  const maskedAt = workflow.indexOf('echo "::add-mask::${generated_value}"');
  const persistedAt = workflow.indexOf(
    'printf \'%s=%s\\n\' "$key" "$generated_value"'
  );
  assert.ok(generatedAt >= 0);
  assert.ok(maskedAt > generatedAt);
  assert.ok(persistedAt > maskedAt);
  assert.doesNotMatch(workflow, /docker logs guardianbot-smoke/);
  assert.match(
    workflow,
    /certificate_identity="https:\/\/github\.com\/\$\{JOB_WORKFLOW_REF\}"/
  );
  assert.match(workflow, /set -euo pipefail/);
  assert.match(
    workflow,
    /cosign-verification\.json >\/dev\/null/
  );
  assert.match(
    workflow,
    /sbom-attestation-verification\.json >\/dev\/null/
  );
  assert.match(
    workflow,
    /shred -u guardianbot-runtime\.env 2>\/dev\/null \|\| rm -f guardianbot-runtime\.env/
  );
  assert.doesNotMatch(workflow, /aquasec\/trivy:0\.64\.1/);
  assert.match(
    workflow,
    /aquasec\/trivy:0\.70\.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e/
  );
  for (const line of workflow.split("\n").filter((entry) => entry.includes("${{ inputs."))) {
    assert.match(
      line,
      /^\s+INPUT_[A-Z0-9_]+:\s+\$\{\{ inputs\.[A-Za-z0-9-]+ \}\}$/,
      `workflow input must enter a shell step only through an environment assignment: ${line}`
    );
  }
  assert.doesNotMatch(workflow, /^\s+run:\s+\$\{\{ inputs\./m);
  assert.match(
    workflow,
    /docker run --rm --network guardianbot-smoke --env-file guardianbot-runtime\.env \\\n\s+"\$\{INPUT_IMAGE_NAME\}:\$\{GITHUB_SHA\}" sh -lc "\$INPUT_SMOKE_COMMAND"/
  );
  assert.match(
    workflow,
    /for reserved_path in guardianbot-image-evidence guardianbot-image-transfer/
  );
  assert.match(workflow, /install -d -m 700 guardianbot-image-evidence guardianbot-image-transfer/);
});

test("scanner and DAST workflows reject repository-controlled evidence paths", () => {
  const security = repositoryFile(".github/workflows/reusable-security.yml");
  const dast = repositoryFile(".github/workflows/reusable-dast.yml");
  assert.match(security, /guardianbot-evidence is a reserved workflow path/);
  assert.match(security, /install -d -m 700 guardianbot-evidence/);
  assert.match(security, /trivy_raw="guardianbot-evidence\/trivy-raw\.json"/);
  assert.match(dast, /guardianbot-dast-evidence is a reserved workflow path/);
  assert.match(dast, /fs\.mkdirSync\("guardianbot-dast-evidence", \{ mode: 0o700 \}\)/);
  assert.match(
    dast,
    /github\.event_name == 'schedule' \|\|\s+github\.event_name == 'workflow_dispatch'/
  );
  assert.doesNotMatch(
    dast.slice(0, dast.indexOf("steps:")),
    /github\.event_name (?:==|!=) 'push'/
  );
  assert.match(dast, /deploymentEnvironment/);
  assert.match(dast, /deployedDigest/);
  assert.match(dast, /\^sha256:\[a-f0-9\]\{64\}\$/);
});

test("scanner config parsing preserves the private evidence directory contract", () => {
  const workflow = repositoryFile(".github/workflows/reusable-security.yml");
  const yqImage =
    "mikefarah/yq:4.44.6@sha256:b1d117c609ba990436ad1649299e2f6c378f62cb562caf30b6f2fb6144713422";
  const yqInvocations = workflow
    .split("\n")
    .filter((line) => line.includes(yqImage));

  assert.equal(yqInvocations.length, 5);
  for (const invocation of yqInvocations) {
    assert.match(
      invocation,
      /docker run --rm --user "\$\(id -u\):\$\(id -g\)" -v "\$PWD:\/work:ro" /
    );
  }
  assert.match(
    workflow,
    /\(\.scanners\.suppressions \/\/ \[\]\) \|\s+all_c\(/
  );
  assert.doesNotMatch(
    workflow,
    /\(\.scanners\.suppressions \/\/ \[\]\) \|\s+all\(/
  );
  assert.match(
    workflow,
    /'\.workflowVersion' "\/work\/\$\{config_path\}"/
  );
  assert.doesNotMatch(
    workflow,
    /'\.workflowVersion' "\/work\/\$\{effective_config\}"/
  );
  assert.match(workflow, /id: rule_pack/);
  assert.match(
    workflow,
    /if: always\(\) && steps\.config\.outcome == 'success' && steps\.rule_pack\.outcome == 'success'/
  );
});

test("DAST OpenAPI sanitization keeps only safe, exact-origin operations", async () => {
  const { spawnSync } = await import("node:child_process");
  const {
    mkdtempSync,
    readFileSync: readLocalFile,
    rmSync,
    writeFileSync
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const workflow = repositoryFile(".github/workflows/reusable-dast.yml");
  const stepStart = workflow.indexOf(
    "- name: Prepare bounded same-origin OpenAPI"
  );
  const heredocStart = workflow.indexOf("<<'PY'\n", stepStart);
  const heredocEnd = workflow.indexOf("\n          PY", heredocStart);
  assert.ok(stepStart >= 0 && heredocStart > stepStart && heredocEnd > heredocStart);
  const sanitizer = workflow
    .slice(heredocStart + "<<'PY'\n".length, heredocEnd)
    .split("\n")
    .map((line) => {
      if (line.length === 0) return line;
      assert.match(line, /^ {10}/);
      return line.slice(10);
    })
    .join("\n");

  const directory = mkdtempSync(join(tmpdir(), "guardianbot-dast-openapi-"));
  const runSanitizer = (
    name: string,
    document: Record<string, unknown>,
    excludedRoutes: string[] = []
  ) => {
    const sourcePath = join(directory, `${name}.input.json`);
    const outputPath = join(directory, `${name}.output.json`);
    const contractPath = join(directory, `${name}.contract.json`);
    writeFileSync(sourcePath, JSON.stringify(document));
    writeFileSync(
      contractPath,
      JSON.stringify({
        origin: "https://staging.example.com",
        excludedRoutes
      })
    );
    const result = spawnSync(
      "python3",
      ["-", sourcePath, outputPath, contractPath],
      { encoding: "utf8", input: sanitizer }
    );
    return { outputPath, result };
  };

  try {
    const mixed = runSanitizer(
      "mixed",
      {
        openapi: "3.1.0",
        info: { title: "mixed operations", version: "1.0.0" },
        servers: [{ url: "/legacy-prefix" }],
        paths: {
          "/mixed": {
            summary: "Read and mutate one resource",
            servers: [{ url: "https://staging.example.com/path-override" }],
            get: {
              responses: { "200": { description: "ok" } },
              servers: [{ url: "/operation-override" }]
            },
            head: { responses: { "200": { description: "ok" } } },
            options: { responses: { "204": { description: "ok" } } },
            post: { responses: { "201": { description: "created" } } },
            put: { responses: { "200": { description: "updated" } } },
            patch: { responses: { "200": { description: "updated" } } },
            delete: { responses: { "204": { description: "deleted" } } },
            trace: { responses: { "200": { description: "trace" } } },
            connect: { responses: { "200": { description: "connected" } } }
          },
          "/unsafe-only": {
            post: { responses: { "200": { description: "mutated" } } }
          },
          "/admin": {
            get: { responses: { "200": { description: "excluded" } } }
          },
          "/admin/audit": {
            get: { responses: { "200": { description: "excluded child" } } }
          }
        },
        webhooks: {
          "/callback": {
            post: { responses: { "200": { description: "callback" } } }
          }
        }
      },
      ["/admin"]
    );
    assert.equal(mixed.result.status, 0, mixed.result.stderr);
    const sanitized = JSON.parse(
      readLocalFile(mixed.outputPath, "utf8")
    ) as {
      paths: Record<string, Record<string, unknown>>;
      servers: Array<{ url: string }>;
      webhooks?: unknown;
    };
    assert.deepEqual(Object.keys(sanitized.paths), ["/mixed"]);
    assert.deepEqual(sanitized.servers, [
      { url: "https://staging.example.com" }
    ]);
    assert.equal(sanitized.webhooks, undefined);
    assert.deepEqual(
      Object.keys(sanitized.paths["/mixed"] ?? {}).sort(),
      ["get", "head", "options", "summary"]
    );
    assert.equal(
      (sanitized.paths["/mixed"]?.get as { servers?: unknown }).servers,
      undefined
    );

    const crossOrigin = runSanitizer("cross-origin", {
      openapi: "3.1.0",
      paths: {
        "/safe": {
          get: {
            servers: [{ url: "https://attacker.example.com" }],
            responses: { "200": { description: "unsafe target" } }
          }
        }
      }
    });
    assert.notEqual(crossOrigin.result.status, 0);
    assert.match(
      crossOrigin.result.stderr,
      /OpenAPI server escapes the exact staging origin/
    );

    const unsafeOnly = runSanitizer("unsafe-only", {
      openapi: "3.1.0",
      paths: {
        "/write": {
          post: { responses: { "200": { description: "mutated" } } }
        }
      }
    });
    assert.notEqual(unsafeOnly.result.status, 0);
    assert.match(
      unsafeOnly.result.stderr,
      /OpenAPI contains no safe, non-excluded operations/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
