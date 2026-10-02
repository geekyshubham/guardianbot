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
    ".github/workflows/reusable-image-rescan.yml",
    ".github/workflows/reusable-dast.yml",
    ".github/workflows/reusable-release-gate.yml"
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

test("reusable workflows retry only transient GitHub OIDC failures", () => {
  const workflows = new Map([
    [".github/workflows/reusable-security.yml", 1],
    [".github/workflows/reusable-image.yml", 2],
    [".github/workflows/reusable-image-rescan.yml", 2],
    [".github/workflows/reusable-dast.yml", 2],
    [".github/workflows/reusable-release-gate.yml", 1]
  ]);

  for (const [path, expectedRequests] of workflows) {
    const workflow = repositoryFile(path);
    assert.equal(
      workflow.match(/const fetchGithubOidc = async/g)?.length,
      expectedRequests
    );
    assert.equal(
      workflow.match(/const oidcResponse = await fetchGithubOidc/g)?.length,
      expectedRequests
    );
    assert.doesNotMatch(workflow, /const oidcResponse = await fetch\(/);
    assert.match(workflow, /response\.status !== 429 && response\.status < 500/);
    assert.match(workflow, /attempt <= 4/);
    assert.match(workflow, /500 \* \(2 \*\* \(attempt - 1\)\)/);
  }
});

test("release gate workflow verifies the exact signer and fails closed on any non-pass", () => {
  const workflow = repositoryFile(".github/workflows/reusable-release-gate.yml");
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch'\n/);
  assert.match(workflow, /environment: guardianbot-release-gate\n/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /contents: write|packages: write|id-token: read/);
  assert.match(workflow, /sigstore\/cosign-installer@398d4b0eeef1380460a10c8013a76f728fb906ac/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  for (const line of workflow.split("\n").filter((entry) => /uses: /.test(entry))) {
    assert.match(line, /@[a-f0-9]{40}$/, `action must be pinned to a full SHA: ${line}`);
  }
  assert.match(
    workflow,
    /`\/\.github\/workflows\/reusable-image\.yml@\$\{imageWorkflowSha\}`/
  );
  assert.match(
    workflow,
    /cosign verify --output json "\$image_ref" \\\n\s+--certificate-identity "\$certificate_identity" \\\n\s+--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com"/
  );
  assert.doesNotMatch(workflow, /--certificate-identity-regexp/);
  assert.match(workflow, /\.critical\.image\["docker-manifest-digest"\] == \$digest/);
  // cosign may emit one JSON document per signature; flatten before checking.
  assert.match(
    workflow,
    /--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com" \\\n\s+\| jq -s '\[\.\[\] \| if type == "array" then \.\[\] else \. end\]' \\\n\s+> "\$verification"/
  );
  assert.match(workflow, /set -euo pipefail/);
  assert.match(workflow, /oidcUrl\.searchParams\.set\("audience", "guardianbot-release-gate"\)/);
  assert.match(workflow, /new URL\("\/release\/gate", evidenceEndpoint\)/);
  assert.match(workflow, /if \(gateResponse\.status !== 200\)/);
  assert.match(workflow, /decision\.candidate\.digest !== request\.imageDigest/);
  assert.match(workflow, /if \(decision\.decision !== "pass"\) \{\n\s+throw new Error/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /path: guardianbot-release-gate\//);
  for (const line of workflow.split("\n").filter((entry) => entry.includes("${{ inputs."))) {
    assert.match(
      line,
      /^\s+INPUT_[A-Z0-9_]+:\s+\$\{\{ inputs\.[A-Za-z0-9-]+ \}\}$/,
      `workflow input must enter a shell step only through an environment assignment: ${line}`
    );
  }
  for (const line of workflow.split("\n").filter((entry) => entry.includes("${{"))) {
    assert.doesNotMatch(
      line,
      /^\s+(?:run:|node|cosign|jq|printf|docker)/,
      `expressions must not be interpolated into scripts: ${line}`
    );
  }
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
  assert.match(
    workflow,
    /for attempt in \$\(seq 1 60\); do\n\s+curl --fail --silent "http:\/\/127\.0\.0\.1:\$\{INPUT_CONTAINER_PORT\}\$\{INPUT_READINESS_PATH\}" && break/
  );
  assert.match(
    workflow,
    /if \[ "\$critical_count" -ne 0 \] && \[ "\$INPUT_POLICY_MODE" = "enforce" \]/
  );
  assert.match(workflow, /scanner_error.*exit 1/s);
  assert.match(workflow, /advisory\|report-only\|enforce/);
  assert.match(workflow, /enforce-only\|verified-default-branch/);
  assert.match(
    workflow,
    /promotion-mode: \{ required: false, type: string, default: "enforce-only" \}/
  );
  assert.match(workflow, /id: policy/);
  assert.match(
    workflow,
    /promotion-eligible: \$\{\{ steps\.policy\.outputs\.promotion-eligible \}\}/
  );
  assert.match(
    workflow,
    /promotion-authorized: \$\{\{ steps\.policy\.outputs\.promotion-authorized \}\}/
  );
  assert.match(workflow, /echo "promotion-eligible=\$\{promotion_eligible\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    workflow,
    /echo "promotion-authorized=\$\{promotion_authorized\}" >> "\$GITHUB_OUTPUT"/
  );
  assert.match(
    workflow,
    /if \[ "\$scanner_error" != "true" \] && \[ "\$critical_count" -eq 0 \]/
  );
  assert.match(
    workflow,
    /select\(\(\.Severity \/\/ ""\) \| ascii_upcase == "CRITICAL"\)/
  );
  assert.equal(
    workflow.match(
      /select\(\(\.Severity \/\/ ""\) \| ascii_upcase == "CRITICAL"\)/g
    )?.length,
    2
  );
  assert.doesNotMatch(workflow, /select\(\.Severity == "CRITICAL"\)/);
  assert.match(
    workflow,
    /\[ "\$INPUT_POLICY_MODE" = "enforce" \] \|\|/
  );
  assert.match(
    workflow,
    /\[ "\$INPUT_POLICY_MODE" = "report-only" \] &&\s+\[ "\$INPUT_PROMOTION_MODE" = "verified-default-branch" \]/
  );
  assert.match(
    workflow,
    /if: >-\n\s+inputs\.push &&\n\s+steps\.policy\.outputs\.promotion-eligible == 'true' &&\n\s+steps\.policy\.outputs\.promotion-authorized == 'true'/
  );
  assert.match(
    workflow,
    /needs\.validate-image\.outputs\.promotion-eligible == 'true' &&\n\s+needs\.validate-image\.outputs\.promotion-authorized == 'true'/
  );
  assert.match(workflow, /- name: Recheck Critical-clean policy evidence/);
  assert.match(
    workflow,
    /jq -e 'type == "object"' guardianbot-image-evidence\/policy\.json/
  );
  assert.match(
    workflow,
    /jq -e 'type == "object"' guardianbot-image-evidence\/trivy-image\.json/
  );
  assert.match(
    workflow,
    /policy criticalFindings must be exactly 0/
  );
  assert.match(
    workflow,
    /recomputed Critical count is not clean/
  );
  const recheckAt = workflow.indexOf(
    "- name: Recheck Critical-clean policy evidence"
  );
  const authAt = workflow.indexOf("- name: Authenticate GHCR");
  assert.ok(recheckAt >= 0);
  assert.ok(authAt > recheckAt);
  assert.match(
    workflow,
    /\.promotionExpected = \$promotionExpected/
  );
});

test("generated image callers always pass promotion-mode and default omitted config to enforce-only", async () => {
  const { generateCallerWorkflow } = await import("../src/workflow.js");
  const image = {
    dockerfile: "Dockerfile",
    context: ".",
    platform: "linux/amd64" as const,
    registry: "ghcr.io/example/service",
    healthPath: "/health",
    sbomFormat: "cyclonedx-json" as const
  };
  const omitted = generateCallerWorkflow({
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main",
    scannerMode: "report-only",
    image
  });
  assert.match(omitted, /promotion-mode: "enforce-only"/);
  assert.match(omitted, /push: false/);

  const verified = generateCallerWorkflow({
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main",
    scannerMode: "report-only",
    image: {
      ...image,
      deployment: {
        environment: "staging",
        requireImmutableDigest: true,
        requireSignature: true,
        requireSbom: true,
        promotionMode: "verified-default-branch"
      }
    }
  });
  assert.match(verified, /promotion-mode: "verified-default-branch"/);
  assert.match(
    verified,
    /push: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/
  );

  const enforce = generateCallerWorkflow({
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main",
    scannerMode: "enforce",
    image: {
      ...image,
      deployment: {
        environment: "staging",
        requireImmutableDigest: true,
        requireSignature: true,
        requireSbom: true,
        promotionMode: "enforce-only"
      }
    }
  });
  assert.match(enforce, /promotion-mode: "enforce-only"/);
  assert.match(
    enforce,
    /push: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/
  );
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
  assert.ok(
    dast.includes(
      'docker run --rm --user zap --cidfile "$zap_cid_file" \\\n'
    )
  );
  assert.ok(dast.includes('-v "$zap_work_dir:/zap/wrk:rw" \\\n'));
  assert.doesNotMatch(
    dast,
    new RegExp(
      String.raw`docker run --rm --user "\$\(id -u\):\$\(id -g\)"[\s\S]{0,200}/zap/wrk:rw`
    )
  );
  assert.match(
    dast,
    /install -m 600 "\$openapi_file" "\$zap_input_dir\/openapi-safe\.json"/
  );
  assert.ok(dast.includes('-v "$zap_input_dir:/zap/input:ro" \\\n'));
  assert.doesNotMatch(
    dast,
    /guardianbot-openapi-safe\.json:\/zap\/input\/openapi-safe\.json:ro/
  );
  assert.match(
    dast,
    /sudo chown -R --no-dereference 1000:1000 "\$zap_work_dir" "\$zap_input_dir"/
  );
  assert.match(
    dast,
    /sudo chown -R --no-dereference "\$\(id -u\):\$\(id -g\)" "\$zap_work_dir" "\$zap_input_dir"/
  );
  assert.match(
    dast,
    /if \[ -f "\$zap_report" \] && \[ ! -L "\$zap_report" \] &&\s+\[ -f "\$zap_xml_report" \] && \[ ! -L "\$zap_xml_report" \]; then/
  );
  assert.match(
    dast,
    /\[ "\$zap_size" -gt 0 \] && \[ "\$zap_size" -le 52428800 \]/
  );
  assert.match(
    dast,
    /install -m 600 "\$zap_report" guardianbot-dast-evidence\/zap\.json/
  );
  assert.match(
    dast,
    /install -m 600 "\$zap_xml_report" guardianbot-dast-evidence\/zap\.xml/
  );
  assert.doesNotMatch(
    dast,
    /-v "\$PWD\/guardianbot-dast-evidence:\/zap\/wrk:rw"/
  );
  assert.ok(
    dast.includes('"${RUNNER_TEMP}/guardianbot-zap-input/openapi-safe.json"')
  );
  assert.ok(
    dast.includes('"${RUNNER_TEMP}/guardianbot-zap-input"; do')
  );
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

test("security workflow verifies enforce readiness before scanners authorize enforce mode", () => {
  const workflow = repositoryFile(".github/workflows/reusable-security.yml");
  const scannersJob = workflow.slice(
    workflow.indexOf("scanners:"),
    workflow.indexOf("steps:")
  );
  assert.match(
    scannersJob,
    /permissions:\n\s+contents: read\n\s+actions: read\n\s+id-token: write/
  );
  assert.equal((scannersJob.match(/:\s*write/g) ?? []).length, 1);
  assert.match(scannersJob, /id-token: write/);
  assert.doesNotMatch(
    scannersJob,
    /contents:\s*write|actions:\s*write|security-events:\s*write|packages:\s*write/
  );

  const rulePackAt = workflow.indexOf("- name: Verify immutable GuardianBot rule pack");
  const enforceReadinessAt = workflow.indexOf("- name: Verify enforce readiness");
  const semgrepAt = workflow.indexOf("- name: Semgrep");
  assert.ok(rulePackAt >= 0);
  assert.ok(enforceReadinessAt > rulePackAt);
  assert.ok(semgrepAt > enforceReadinessAt);

  const enforceStep = workflow.slice(enforceReadinessAt, semgrepAt);
  assert.match(
    enforceStep,
    /if: >-\n\s+steps\.config\.outcome == 'success' &&\n\s+steps\.rule_pack\.outcome == 'success' &&\n\s+steps\.config\.outputs\.mode == 'enforce' &&\n\s+github\.event_name != 'pull_request'/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_BASELINE_PATH: \$\{\{ steps\.config\.outputs\.baseline-path \}\}/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_CONFIG_PATH: \$\{\{ inputs\.config-path \}\}/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_REPOSITORY: \$\{\{ github\.repository \}\}/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_WORKFLOW_REPOSITORY: \$\{\{ job\.workflow_repository \}\}/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_REQUIRED_CHECK_NAME: guardianbot\/security-gate \/ deterministic scanners/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_GITHUB_API_URL: \$\{\{ github\.api_url \}\}/
  );
  assert.match(
    enforceStep,
    /GUARDIANBOT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/
  );
  assert.match(enforceStep, /GUARDIANBOT_MINIMUM_OBSERVATION_DAYS: "7"/);
  assert.doesNotMatch(enforceStep, /secrets\./);
  assert.doesNotMatch(enforceStep, /continue-on-error/);
  assert.match(
    enforceStep,
    /run: node guardianbot-engine\/scripts\/verify-enforcement-readiness\.mjs/
  );
  assert.doesNotMatch(
    enforceStep,
    /GUARDIANBOT_GITHUB_TOKEN: \$\{\{ secrets\./
  );
  assert.doesNotMatch(
    enforceStep,
    /node guardianbot-engine\/scripts\/verify-enforcement-readiness\.mjs.*\$\{\{/
  );

  // Expression contract: PR, report-only, and advisory runs skip the verifier.
  assert.match(
    enforceStep,
    /github\.event_name != 'pull_request'/
  );
  assert.match(
    enforceStep,
    /steps\.config\.outputs\.mode == 'enforce'/
  );
  assert.doesNotMatch(
    enforceStep,
    /github\.event_name == 'pull_request'/
  );
  assert.doesNotMatch(
    enforceStep,
    /mode == 'report-only'|mode == 'advisory'/
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
  assert.match(
    workflow,
    /docker run --rm --interactive --user "\$\(id -u\):\$\(id -g\)" --entrypoint python3/
  );
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

test("security workflow accepts generated empty versioned baselines and rejects empty legacy baselines", () => {
  const workflow = repositoryFile(".github/workflows/reusable-security.yml");
  assert.match(workflow, /guardianbot\.baseline\.v1/);
  assert.match(workflow, /legacy baseline fingerprint set is empty/);
  assert.match(
    workflow,
    /versioned baseline generatedAt must be a canonical RFC3339 UTC instant/
  );
  assert.match(
    workflow,
    /versioned baseline source must include lowercase gateSha256, mode report-only, repository, headSha, runId, and runAttempt/
  );
  assert.match(workflow, /const repository = String\(process\.env\.GITHUB_REPOSITORY/);
  assert.match(workflow, /const headSha = String\(process\.env\.GITHUB_SHA/);
  assert.match(workflow, /const runId = Number\(process\.env\.GITHUB_RUN_ID\)/);
  assert.match(workflow, /const runAttempt = Number\(process\.env\.GITHUB_RUN_ATTEMPT\)/);
  assert.match(
    workflow,
    /repository,\s*headSha,\s*runId,\s*runAttempt,/
  );
  assert.doesNotMatch(
    workflow,
    /Baseline is empty: \$\{process\.env\.BASELINE_PATH\}/
  );
  assert.match(
    workflow,
    /if \(raw\.schemaVersion === "guardianbot\.baseline\.v1"\)/
  );
  assert.doesNotMatch(workflow, /reviewedAt/);
  assert.match(workflow, /isCanonicalUtcInstant/);
});

test("DAST profiles are bounded and preserve operational failure evidence", () => {
  const workflow = repositoryFile(".github/workflows/reusable-dast.yml");

  assert.match(
    workflow,
    /if \[ "\$scan_profile" = "authenticated-baseline" \]; then[\s\S]*zap_mode_args=\(-S\)/
  );
  assert.match(workflow, /-J zap\.json -x zap\.xml -T "\$scan_minutes"/);
  assert.doesNotMatch(workflow, /-J zap\.json -m "\$scan_minutes"/);
  assert.match(
    workflow,
    /scanner\.maxScanDurationInMins=\{os\.environ\['GUARDIANBOT_SCAN_MINUTES'\]\}/
  );
  assert.match(
    workflow,
    /scanner\.maxRuleDurationInMins=\{os\.environ\['GUARDIANBOT_SCAN_MINUTES'\]\}/
  );
  assert.match(
    workflow,
    /timeout --signal=TERM --kill-after=30s "\$\{wall_seconds\}s"/
  );
  assert.match(workflow, /124\)[\s\S]*failure_kind="wall_clock_timeout"/);
  assert.match(
    workflow,
    /status: "operational_failure",[\s\S]*failureKind: \$failureKind/
  );
  assert.match(workflow, /zap_exit=3/);
  assert.match(
    workflow,
    /EVIDENCE_FILES: scan-status\.json,zap\.json,zap\.xml/
  );
  assert.match(
    workflow,
    /DAST minutes must be an integer between 5 and 45/
  );
  assert.match(
    workflow,
    /SCAN_PROFILE === "authenticated-baseline" && minutes > 15/
  );
  assert.match(
    workflow,
    /SCAN_PROFILE === "authenticated-full" && minutes < 30/
  );
  assert.match(
    workflow,
    /authenticated-baseline DAST minutes must be at most 15/
  );
  assert.match(
    workflow,
    /authenticated-full DAST minutes must be at least 30/
  );
  assert.match(workflow, /scanProfile: contract\.scanProfile/);
  assert.match(
    workflow,
    /headSha: process\.env\.GITHUB_SHA\.toLowerCase\(\),\s*scanProfile: contract\.scanProfile/
  );
});

test("pull request policy resolution binds onboarding state to the base commit", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const workflow = repositoryFile(".github/workflows/reusable-security.yml");
  // Onboarding state must never be derived from the head-supplied input, so the
  // base lookup is pinned to the canonical location.
  assert.doesNotMatch(workflow, /\$\{base_sha\}:\$\{config_path\}/);
  assert.match(workflow, /\$\{base_sha\}:\$\{canonical_config_path\}/);

  const resolutionStart = workflow.indexOf(
    '          canonical_config_path=".guardianbot/config.yml"'
  );
  const resolutionEnd = workflow.indexOf("          docker run", resolutionStart);
  assert.ok(resolutionStart >= 0);
  assert.ok(resolutionEnd > resolutionStart);

  const configResolution = [
    "set -eo pipefail",
    workflow
      .slice(resolutionStart, resolutionEnd)
      .split("\n")
      .map((line) => {
        if (line.length === 0) return line;
        assert.match(line, /^ {10}/);
        return line.slice(10);
      })
      .join("\n"),
    'printf "%s\\n%s\\n" "$config_source" "$effective_config"'
  ].join("\n");

  const runGit = (directory: string, args: string[]): string => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  const resolveConfig = (options: {
    configPath: string;
    onboarded: boolean;
    baseSha?: string;
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "guardianbot-config-source-"));
    try {
      runGit(directory, ["init", "--quiet", "--initial-branch=main", "."]);
      runGit(directory, ["config", "user.email", "guardianbot@example.com"]);
      runGit(directory, ["config", "user.name", "GuardianBot"]);
      mkdirSync(join(directory, ".guardianbot"), { recursive: true });
      if (options.onboarded) {
        writeFileSync(
          join(directory, ".guardianbot/config.yml"),
          'schemaVersion: "1.0.0"\nscanners:\n  mode: enforce\n'
        );
      } else {
        writeFileSync(
          join(directory, ".guardianbot/placeholder.txt"),
          "not onboarded\n"
        );
      }
      runGit(directory, ["add", "--all"]);
      runGit(directory, ["commit", "--quiet", "--message", "base"]);
      const baseSha = options.baseSha ?? runGit(directory, ["rev-parse", "HEAD"]);
      // The head commit always proposes advisory mode, so a successful
      // downgrade is observable in the resolved configuration source.
      writeFileSync(
        join(directory, ".guardianbot/config.yml"),
        'schemaVersion: "1.0.0"\nscanners:\n  mode: advisory\n'
      );
      writeFileSync(
        join(directory, ".guardianbot/pr-config.yml"),
        'schemaVersion: "1.0.0"\nscanners:\n  mode: advisory\n'
      );
      mkdirSync(join(directory, "guardianbot-evidence"), { recursive: true });
      const result = spawnSync("bash", ["-c", configResolution], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          PULL_REQUEST_BASE_SHA: baseSha,
          config_path: options.configPath,
          baseline_path: ".guardianbot/baseline.json"
        }
      });
      const [configSource = "", effectiveConfig = ""] = result.stdout
        .trim()
        .split("\n");
      return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
        configSource,
        effectiveConfig
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  // An onboarded repository cannot be demoted to the first-onboarding path by
  // repointing config-path at a file absent from the base commit.
  const diverted = resolveConfig({
    configPath: ".guardianbot/pr-config.yml",
    onboarded: true
  });
  assert.notEqual(diverted.status, 0);
  assert.notEqual(diverted.configSource, "head");
  assert.match(
    diverted.stdout,
    /Onboarded repositories must pass config-path \.guardianbot\/config\.yml\./
  );

  // Legitimately onboarded callers keep resolving policy from the base blob.
  const onboarded = resolveConfig({
    configPath: ".guardianbot/config.yml",
    onboarded: true
  });
  assert.equal(onboarded.status, 0, onboarded.stdout);
  assert.equal(onboarded.configSource, "base");
  assert.equal(
    onboarded.effectiveConfig,
    "guardianbot-evidence/effective-config.yml"
  );

  // The genuine first onboarding pull request still reaches its head config,
  // where the separate mode check keeps it non-enforcing.
  const firstOnboarding = resolveConfig({
    configPath: ".guardianbot/config.yml",
    onboarded: false
  });
  assert.equal(firstOnboarding.status, 0, firstOnboarding.stdout);
  assert.equal(firstOnboarding.configSource, "head");
  assert.equal(firstOnboarding.effectiveConfig, ".guardianbot/config.yml");

  // An unreachable base commit fails closed instead of trusting head policy.
  const unresolvable = resolveConfig({
    configPath: ".guardianbot/config.yml",
    onboarded: true,
    baseSha: "0".repeat(40)
  });
  assert.notEqual(unresolvable.status, 0);
  assert.notEqual(unresolvable.configSource, "head");
  assert.match(
    unresolvable.stdout,
    /The pull request base commit is not available for policy resolution\./
  );
});

test("Semgrep policy severity comes only from verified rule metadata, never workflow interpolation", () => {
  const workflow = repositoryFile(".github/workflows/reusable-security.yml");
  const stepStart = workflow.indexOf("      - name: Evaluate new-finding policy");
  const scriptEnd = workflow.indexOf("\n          NODE\n", stepStart);
  assert.ok(stepStart >= 0 && scriptEnd > stepStart);
  const step = workflow.slice(stepStart, scriptEnd);
  // The step env is unchanged: no new expression-fed inputs reach the gate.
  const env = step.slice(step.indexOf("        env:"), step.indexOf("        shell: bash"));
  assert.deepEqual(
    env.split("\n").filter((line) => /^ {10}[A-Z_]+:/.test(line)).map((line) => line.trim().split(":")[0]),
    ["SCANNER_MODE", "BASELINE_PATH"]
  );
  const script = step.slice(step.indexOf("node <<'NODE'"));
  assert.doesNotMatch(script, /\$\{\{/);
  assert.match(script, /metadata\[SEMGREP_POLICY_SEVERITY_KEY\]/);
  // Only critical/high Semgrep findings can block, regardless of severity source.
  assert.match(script, /severitySource: policyMapped \? "policy" : "native"/);

  // Execute the extracted normalizer so mapped and unmapped behaviour is proven.
  const normalizerStart = script.indexOf("          const SEMGREP_POLICY_SEVERITY_KEY");
  const semgrepTableEnd = script.indexOf("          const trivySeverity", normalizerStart);
  const normalizeStart = script.indexOf("          const normalizeSemgrep = (report) =>");
  const normalizeEnd = script.indexOf("          const normalizeTrivy", normalizeStart);
  assert.ok(normalizerStart >= 0 && semgrepTableEnd > normalizerStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  const source = [
    script.slice(normalizerStart, semgrepTableEnd),
    script.slice(normalizeStart, normalizeEnd),
    "return normalizeSemgrep;"
  ].join("\n");
  const normalizeSemgrep = new Function(
    "asRecord",
    "fingerprintFields",
    source
  )(
    (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
    (parts: unknown[]) => ({ fingerprint: parts.join("|") })
  ) as (report: unknown) => Array<Record<string, unknown>>;
  const [mapped, unmapped, invalid] = normalizeSemgrep({
    results: [
      {
        check_id: "mapped",
        path: "a.ts",
        start: { line: 1 },
        extra: { severity: "WARNING", message: "m", metadata: { "guardianbot-severity": "high" } }
      },
      { check_id: "unmapped", path: "b.ts", start: { line: 2 }, extra: { severity: "ERROR", message: "u" } },
      {
        check_id: "invalid",
        path: "c.ts",
        start: { line: 3 },
        extra: { severity: "INFO", message: "i", metadata: { "guardianbot-severity": "blocker" } }
      }
    ]
  });
  assert.equal(mapped?.severity, "high");
  assert.equal(mapped?.severitySource, "policy");
  assert.equal(unmapped?.severity, "high");
  assert.equal(unmapped?.severitySource, "native");
  assert.equal(invalid?.severity, "info");
  assert.equal(invalid?.severitySource, "native");
  // Severity is not a fingerprint input.
  assert.equal(mapped?.fingerprint, "semgrep|mapped|a.ts|1|m");
});

test("release-branch callers keep image promotion and DAST on the default branch", async () => {
  const { generateCallerWorkflow } = await import("../src/workflow.js");
  const caller = generateCallerWorkflow({
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main",
    scannerMode: "report-only",
    releaseBranches: ["release/1.x"],
    image: {
      dockerfile: "Dockerfile",
      context: ".",
      platform: "linux/amd64",
      registry: "ghcr.io/example/service",
      healthPath: "/health",
      sbomFormat: "cyclonedx-json",
      deployment: {
        environment: "staging",
        requireImmutableDigest: true,
        requireSignature: true,
        requireSbom: true,
        promotionMode: "verified-default-branch"
      }
    },
    dast: {
      allowedOrigin: "https://staging.example.com",
      openapi: "openapi.json",
      openapiSource: "repository-file",
      authenticationProfile: "control-plane://profiles/service-staging",
      sessionAssertionPath: "/session"
    } as never
  });
  assert.match(caller, /pull_request:\n {4}types: \[[^\]]+\]\n {4}branches: \["main", "release\/1\.x"\]/);
  assert.match(caller, /push:\n {4}branches: \["main", "release\/1\.x"\]/);
  assert.match(
    caller,
    /push: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/
  );
  assert.doesNotMatch(caller, /refs\/heads\/release/);
  // DAST jobs run only on schedule or manual dispatch, never on push.
  const dastJobs = caller.slice(caller.indexOf("  guardianbot-dast-smoke:"));
  assert.doesNotMatch(dastJobs.split("\n    uses:")[0] ?? "", /'push'/);
  assert.match(caller, /guardianbot-dast-nightly:\n {4}name: guardianbot\/dast-nightly\n {4}if: github\.event_name == 'schedule'/);
  // No untrusted ref or PR data is interpolated into the generated caller.
  assert.doesNotMatch(caller, /github\.head_ref|github\.event\.pull_request/);
});

test("enforce gate blocks only policy-mapped Semgrep severity when the workflow script runs", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const workflow = repositoryFile(".github/workflows/reusable-security.yml");
  const stepStart = workflow.indexOf("      - name: Evaluate new-finding policy");
  const scriptStart = workflow.indexOf("node <<'NODE'\n", stepStart) + "node <<'NODE'\n".length;
  const scriptEnd = workflow.indexOf("\n          NODE\n", scriptStart);
  assert.ok(stepStart >= 0 && scriptEnd > scriptStart);
  const script = workflow
    .slice(scriptStart, scriptEnd)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");

  const run = (metadata: Record<string, unknown> | undefined) => {
    const directory = mkdtempSync(join(tmpdir(), "guardianbot-gate-"));
    try {
      mkdirSync(join(directory, "guardianbot-evidence"));
      writeFileSync(
        join(directory, "guardianbot-evidence", "semgrep.json"),
        JSON.stringify({
          results: [
            {
              check_id: "rule",
              path: "a.py",
              start: { line: 1 },
              extra: { severity: "ERROR", message: "m", ...(metadata ? { metadata } : {}) }
            }
          ]
        })
      );
      writeFileSync(
        join(directory, "guardianbot-evidence", "trivy.json"),
        JSON.stringify({ SchemaVersion: 2, ArtifactName: ".", ArtifactType: "filesystem", Results: [] })
      );
      writeFileSync(join(directory, "guardianbot-evidence", "suppressions.json"), "[]");
      writeFileSync(join(directory, "baseline.json"), JSON.stringify(["f".repeat(64)]));
      writeFileSync(join(directory, "gate.js"), script);
      const result = spawnSync(process.execPath, ["gate.js"], {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SCANNER_MODE: "enforce",
          BASELINE_PATH: "baseline.json",
          GITHUB_REPOSITORY: "acme/service",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_STEP_SUMMARY: join(directory, "summary.md")
        }
      });
      const gate = JSON.parse(read(join(directory, "guardianbot-evidence", "gate.json"), "utf8")) as {
        passed: boolean;
        policyFindings: Array<{ severity: string; severitySource: string }>;
      };
      return { status: result.status, gate, summary: read(join(directory, "summary.md"), "utf8") };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const mapped = run({ "guardianbot-severity": "high" });
  assert.equal(mapped.status, 1);
  assert.equal(mapped.gate.passed, false);
  assert.equal(mapped.gate.policyFindings[0]?.severitySource, "policy");

  const unmapped = run(undefined);
  assert.equal(unmapped.status, 0);
  assert.equal(unmapped.gate.passed, true);
  // Unmapped native ERROR stays visible as a High policy finding and is flagged.
  assert.equal(unmapped.gate.policyFindings[0]?.severity, "high");
  assert.equal(unmapped.gate.policyFindings[0]?.severitySource, "native");
  assert.match(unmapped.summary, /Semgrep rule `rule` has no policy severity mapping/);
  assert.match(unmapped.summary, /- ⚠️ Semgrep rule at a\.py:1 \(no policy severity mapping\)|⚠️ Semgrep rule/);

  const mappedDown = run({ "guardianbot-severity": "medium" });
  assert.equal(mappedDown.status, 0);
  assert.deepEqual(mappedDown.gate.policyFindings, []);
});

test("deployed image rescan workflow is schedule-only, read-only, and digest-bound", () => {
  const workflow = repositoryFile(".github/workflows/reusable-image-rescan.yml");
  const header = workflow.slice(0, workflow.indexOf("steps:"));
  assert.match(header, /name: deployed digest rescan/);
  assert.match(header, /if: github\.event_name == 'schedule'\n/);
  assert.match(header, /environment: guardianbot-image-rescan/);
  assert.match(
    header,
    /permissions:\n\s+contents: read\n\s+packages: read\n\s+id-token: write/
  );
  assert.doesNotMatch(workflow, /packages: write/);
  assert.doesNotMatch(workflow, /cosign (?:sign|attest) /);
  assert.doesNotMatch(workflow, /docker push/);
  assert.doesNotMatch(workflow, /docker build/);
  // Every action is pinned to a full commit SHA already used by the other reusable workflows.
  const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(uses)].sort(), [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "sigstore/cosign-installer@398d4b0eeef1380460a10c8013a76f728fb906ac"
  ]);
  // Untrusted caller inputs enter shell steps only through environment assignments.
  for (const line of workflow.split("\n").filter((entry) => entry.includes("${{ inputs."))) {
    assert.match(line, /^\s+INPUT_[A-Z0-9_]+:\s+\$\{\{ inputs\.[A-Za-z0-9-]+ \}\}$/);
  }
  for (const line of workflow.split("\n").filter((entry) => entry.includes("${{"))) {
    assert.doesNotMatch(line, /^\s+run:/, `expression interpolated into a run script: ${line}`);
  }
  assert.doesNotMatch(workflow, /docker login[^\n]*\$\{\{/);
  // The digest comes only from the control plane and is validated before use.
  assert.match(workflow, /new URL\("\/image\/rescan-target", evidenceEndpoint\)/);
  assert.match(workflow, /oidcUrl\.searchParams\.set\("audience", "guardianbot-image-rescan"\)/);
  assert.match(workflow, /oidcUrl\.searchParams\.set\("audience", "guardianbot-evidence"\)/);
  assert.match(workflow, /target\.imageReference\.toLowerCase\(\) !== `\$\{imageName\}@\$\{target\.imageDigest\}`/);
  assert.match(workflow, /reusable-image\\\.yml@\(\[a-f0-9\]\{40\}\)\$/);
  assert.doesNotMatch(workflow, /:\$\{GITHUB_SHA\}/);
  assert.doesNotMatch(workflow, /:latest/);
  // Signature and SBOM attestation are verified against the deployed identity before pulling.
  const verifyAt = workflow.indexOf("cosign verify --output json \"$image_reference\"");
  const attestationAt = workflow.indexOf(
    "cosign verify-attestation --output json --type cyclonedx \"$image_reference\""
  );
  const pullAt = workflow.indexOf("docker pull --platform linux/amd64 \"$image_reference\"");
  const trivyAt = workflow.indexOf("- name: Trivy rescan of deployed digest");
  assert.ok(verifyAt > 0 && attestationAt > verifyAt && pullAt > attestationAt && trivyAt > pullAt);
  assert.match(workflow, /--certificate-identity "\$certificate_identity"/);
  assert.match(
    workflow,
    /aquasec\/trivy:0\.70\.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e/
  );
  assert.match(workflow, /EVIDENCE_ARTIFACT_TYPE: image-rescan/);
  assert.match(
    workflow,
    /EVIDENCE_FILES: cosign-verification\.json,rescan\.json,sbom-attestation-verification\.json,sbom\.cdx\.json,trivy-image\.json/
  );
  assert.match(
    workflow,
    /name: guardianbot-image-rescan-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  // The provenance attestation script is shared verbatim with the image workflow.
  const image = repositoryFile(".github/workflows/reusable-image.yml");
  const attestScript = (source: string) => {
    const start = source.indexOf("const workflowMatch = process.env.JOB_WORKFLOW_REF.match(", source.indexOf("EVIDENCE_ARTIFACT_TYPE"));
    return source.slice(start, source.indexOf("NODE\n", start));
  };
  assert.equal(attestScript(workflow), attestScript(image.slice(image.indexOf("Attest promotion evidence provenance"))));
});

test("generated callers stay byte-identical unless image.deployment opts into the rescan", async () => {
  const { createHash } = await import("node:crypto");
  const { generateCallerWorkflow } = await import("../src/workflow.js");
  const image = {
    dockerfile: "Dockerfile",
    context: ".",
    platform: "linux/amd64" as const,
    registry: "ghcr.io/example/service",
    healthPath: "/health",
    sbomFormat: "cyclonedx-json" as const
  };
  const dast = {
    allowedOrigin: "https://staging.example.com",
    openapi: "openapi.yaml",
    authenticationProfile: "control-plane://profiles/example",
    sessionAssertionPath: "/api/me",
    excludedRoutes: ["/logout"]
  };
  const base = {
    guardianRepository: "Geekyshubham/guardianbot",
    workflowSha: "b".repeat(40),
    defaultBranch: "main"
  };
  const hash = (options: Parameters<typeof generateCallerWorkflow>[0]) =>
    createHash("sha256").update(generateCallerWorkflow(options)).digest("hex");
  // Hashes captured from the generator before the deployed-digest rescan existed.
  assert.equal(
    hash({ ...base, scannerMode: "advisory" }),
    "d10ab3f1cf0e88de7439db3b8ba5804ae9b28307a6a8b5ab47816cc8fd8c847e"
  );
  assert.equal(
    hash({ ...base, scannerMode: "report-only", image }),
    "5a16bc39ab9e0da8ebe5bef6830d0d7b33959028004f4f20972197cf5af47c69"
  );
  assert.equal(
    hash({ ...base, scannerMode: "enforce", image }),
    "ddee9456ab431464aab48ba9e180f93c8b00a4f46978b6ea4b5096a5e87ed344"
  );
  assert.equal(
    hash({ ...base, scannerMode: "report-only", dast }),
    "8607e40cfc8a9424558f9fb34ba930db18e4948018779276dd854525fcf1da8e"
  );
  assert.equal(
    hash({ ...base, scannerMode: "enforce", image, dast }),
    "8c5a22bdd25107e4e9810edfac026d556d57a75f71e4e4eff585ad6352032ee1"
  );
  for (const output of [
    generateCallerWorkflow({ ...base, scannerMode: "enforce", image, dast }),
    generateCallerWorkflow({ ...base, scannerMode: "advisory" })
  ]) {
    assert.doesNotMatch(output, /image-rescan|13 3 \* \* \*/);
  }

  const deployed = generateCallerWorkflow({
    ...base,
    scannerMode: "report-only",
    image: {
      ...image,
      deployment: {
        environment: "staging",
        requireImmutableDigest: true,
        requireSignature: true,
        requireSbom: true
      }
    }
  });
  assert.match(deployed, /    - cron: "23 2 \* \* \*"\n    - cron: "13 3 \* \* \*"\n/);
  assert.match(
    deployed,
    /  guardianbot-image-rescan:\n    name: guardianbot\/image-rescan\n/
  );
  assert.match(
    deployed,
    /if: github\.event_name == 'schedule' && github\.event\.schedule == '13 3 \* \* \*'\n    permissions:\n      contents: read\n      packages: read\n      id-token: write\n    uses: Geekyshubham\/guardianbot\/\.github\/workflows\/reusable-image-rescan\.yml@b{40}\n    with:\n      image-name: "ghcr\.io\/example\/service"\n      deployment-environment: "staging"\n/
  );
  // The existing image and security jobs still skip the rescan schedule.
  assert.equal(
    deployed.match(/github\.event_name != 'schedule' \|\| github\.event\.schedule == '23 2 \* \* \*'/g)?.length,
    2
  );
});
