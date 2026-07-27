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
});
