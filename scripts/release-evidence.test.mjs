import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  createReleaseManifest,
  RELEASE_ASSET_FILES,
  RELEASE_SCHEMA,
  stageReleaseAssets,
  validateReleaseInput,
  verifyReleaseAssets,
  verifyReleaseManifest
} from "./release-evidence.mjs";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "Geekyshubham/guardianbot";
const TAG = "v1.2.3-rc.1";
const REF = `refs/tags/${TAG}`;
const IDENTITY =
  `https://github.com/${REPOSITORY}/.github/workflows/release.yml@${REF}`;

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "guardianbot-release-"));
}

async function packageFixture(directory, version = "1.2.3-rc.1") {
  const packagePath = path.join(directory, "package.json");
  const workspace = path.join(directory, "packages", "fixture");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    packagePath,
    `${JSON.stringify({ version, workspaces: ["packages/fixture"] })}\n`
  );
  await writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "@guardianbot/fixture", version })}\n`
  );
  await writeFile(
    path.join(directory, "CHANGELOG.md"),
    `# Changelog\n\n## [${version}] - 2026-07-27\n`
  );
  await writeFile(
    path.join(directory, "Dockerfile"),
    `FROM node:24-alpine@sha256:${"c".repeat(64)}\n`
  );
  return packagePath;
}

function validationPaths(directory) {
  return {
    changelogPath: path.join(directory, "CHANGELOG.md"),
    dockerfilePath: path.join(directory, "Dockerfile")
  };
}

async function evidenceFixture(directory) {
  const documents = {
    "trivy-image.json": {
      SchemaVersion: 2,
      ArtifactName: "guardianbot:candidate",
      ArtifactType: "container_image",
      Results: [{ Target: "guardianbot", Vulnerabilities: null }]
    },
    "trivy-version.json": { Version: "0.70.0" },
    "sbom.cdx.json": {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: []
    },
    "github-provenance.sigstore.json": { mediaType: "application/json" },
    "github-provenance-verification.json": [{ verificationResult: {} }],
    "github-provenance-oci-verification.json": [{ verificationResult: {} }],
    "cosign-signature-verification.json": [{ critical: {} }],
    "cosign-sbom-verification.json": [{ payload: "verified" }]
  };
  for (const [name, document] of Object.entries(documents)) {
    await writeFile(path.join(directory, name), `${JSON.stringify(document)}\n`);
  }
}

test("release input requires an exact SemVer tag and matching package version", async () => {
  const directory = await temporaryDirectory();
  const packagePath = await packageFixture(directory);
  assert.deepEqual(
    await validateReleaseInput({
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      packagePath,
      ...validationPaths(directory)
    }),
    {
      tag: TAG,
      version: "1.2.3-rc.1",
      sha: SHA,
      ref: REF,
      repository: REPOSITORY
    }
  );

  await assert.rejects(
    validateReleaseInput({
      tag: "v01.2.3",
      sha: SHA,
      ref: "refs/tags/v01.2.3",
      repository: REPOSITORY,
      packagePath,
      ...validationPaths(directory)
    }),
    /invalid format/
  );
  await assert.rejects(
    validateReleaseInput({
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      packagePath: await packageFixture(directory, "1.2.4"),
      ...validationPaths(directory)
    }),
    /does not match/
  );
});

test("release input rejects a workspace left on another version", async () => {
  const directory = await temporaryDirectory();
  const packagePath = await packageFixture(directory);
  await writeFile(
    path.join(directory, "packages", "fixture", "package.json"),
    `${JSON.stringify({
      name: "@guardianbot/fixture",
      version: "1.2.2"
    })}\n`
  );
  await assert.rejects(
    validateReleaseInput({
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      packagePath,
      ...validationPaths(directory)
    }),
    /workspace .* does not match/
  );
});

test("release input requires a dated changelog section for the version", async () => {
  const directory = await temporaryDirectory();
  const packagePath = await packageFixture(directory);
  const changelogPath = path.join(directory, "CHANGELOG.md");
  await writeFile(changelogPath, "# Changelog\n\n## [Unreleased]\n");
  await assert.rejects(
    validateReleaseInput({
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      packagePath,
      changelogPath,
      dockerfilePath: path.join(directory, "Dockerfile")
    }),
    /no dated .* release heading/
  );
});

test("release input rejects mutable Dockerfile base images", async () => {
  const directory = await temporaryDirectory();
  const packagePath = await packageFixture(directory);
  const dockerfilePath = path.join(directory, "Dockerfile");
  await writeFile(dockerfilePath, "FROM node:24-alpine\n");
  await assert.rejects(
    validateReleaseInput({
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      packagePath,
      changelogPath: path.join(directory, "CHANGELOG.md"),
      dockerfilePath
    }),
    /not digest-pinned/
  );
});

test("manifest binds the exact digest to hashed release evidence", async () => {
  const directory = await temporaryDirectory();
  await evidenceFixture(directory);
  const manifest = await createReleaseManifest({
    directory,
    tag: TAG,
    sha: SHA,
    ref: REF,
    repository: REPOSITORY,
    image: "ghcr.io/geekyshubham/guardianbot",
    digest: DIGEST,
    platform: "linux/amd64",
    workflowIdentity: IDENTITY
  });

  assert.equal(manifest.schemaVersion, RELEASE_SCHEMA);
  assert.equal(
    manifest.image.reference,
    `ghcr.io/geekyshubham/guardianbot@${DIGEST}`
  );
  const manifestPath = path.join(directory, "release-manifest.json");
  const verified = await verifyReleaseManifest({
    manifestPath,
    expectedTag: TAG,
    expectedSha: SHA,
    expectedRepository: REPOSITORY,
    expectedDigest: DIGEST
  });
  assert.equal(verified.evidence.sbom.path, "sbom.cdx.json");
});

test("manifest verification rejects evidence changed after publication", async () => {
  const directory = await temporaryDirectory();
  await evidenceFixture(directory);
  await createReleaseManifest({
    directory,
    tag: TAG,
    sha: SHA,
    ref: REF,
    repository: REPOSITORY,
    image: "ghcr.io/geekyshubham/guardianbot",
    digest: DIGEST,
    platform: "linux/amd64",
    workflowIdentity: IDENTITY
  });
  await writeFile(
    path.join(directory, "sbom.cdx.json"),
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: "tampered" }]
    })}\n`
  );
  await assert.rejects(
    verifyReleaseManifest({
      manifestPath: path.join(directory, "release-manifest.json")
    }),
    /does not match/
  );
});

test("release assets use one exact checksummed allowlist", async () => {
  const directory = await temporaryDirectory();
  await evidenceFixture(directory);
  await createReleaseManifest({
    directory,
    tag: TAG,
    sha: SHA,
    ref: REF,
    repository: REPOSITORY,
    image: "ghcr.io/geekyshubham/guardianbot",
    digest: DIGEST,
    platform: "linux/amd64",
    workflowIdentity: IDENTITY
  });
  await writeFile(
    path.join(directory, "release-manifest.sigstore.json"),
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json"
    })}\n`
  );
  const assets = path.join(directory, "assets");
  await stageReleaseAssets(directory, assets);
  await verifyReleaseAssets(assets);
  assert.deepEqual((await readdir(assets)).sort(), RELEASE_ASSET_FILES);

  await writeFile(path.join(assets, "unexpected.txt"), "not signed\n");
  await assert.rejects(
    verifyReleaseAssets(assets),
    /asset set is not exactly canonical/
  );
});

test("release workflow pins every action and grants write permissions only to publish", async () => {
  const workflowPath = path.resolve(".github/workflows/release.yml");
  const source = await readFile(workflowPath, "utf8");
  const workflow = YAML.parse(source);
  const uses = [...source.matchAll(/^\s*uses:\s*(\S+)\s*(?:#.*)?$/gm)].map(
    (match) => match[1]
  );
  assert.ok(uses.length >= 4);
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/);
  }

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.verify_source.permissions, {
    contents: "read"
  });
  assert.equal(workflow.jobs.publish_image.permissions.packages, "write");
  assert.equal(workflow.jobs.publish_image.permissions["id-token"], "write");
  assert.equal(workflow.jobs.publish_image.permissions.attestations, "write");
  assert.equal(workflow.jobs.publish_image.permissions.contents, "read");
  assert.equal(workflow.jobs.publish_image.needs, "verify_source");
  assert.equal(workflow.jobs.publish_image["timeout-minutes"], 45);
  assert.deepEqual(workflow.jobs.publish_release.permissions, {
    contents: "write"
  });
  assert.equal(workflow.jobs.publish_release.needs, "publish_image");
  assert.equal(workflow.jobs.publish_release["timeout-minutes"], 15);
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*"]);
  assert.match(source, /--certificate-identity "\$\{WORKFLOW_IDENTITY\}"/);
  assert.match(
    source,
    /--bundle release-evidence\/github-provenance\.sigstore\.json/
  );
  assert.match(
    source,
    /> release-evidence\/github-provenance-oci-verification\.json/
  );
  assert.doesNotMatch(source, /certificate-identity-regexp/);
});

test("stable tags are attached only after candidate trust evidence is verified", async () => {
  const source = await readFile(
    path.resolve(".github/workflows/release.yml"),
    "utf8"
  );
  const candidate = source.indexOf(
    "- name: Push run-scoped candidate and resolve its digest"
  );
  const provenance = source.indexOf("- name: Generate GitHub build provenance");
  const signing = source.indexOf(
    "- name: Sign digest, attest SBOM, and verify exact identity"
  );
  const manifest = source.indexOf(
    "- name: Create and sign deployable release manifest"
  );
  const stable = source.indexOf("- name: Attach stable tags without overwriting");
  const release = source.indexOf(
    "- name: Create or strictly resume GitHub release record"
  );
  assert.ok(candidate > 0);
  assert.ok(candidate < provenance);
  assert.ok(provenance < signing);
  assert.ok(signing < manifest);
  assert.ok(manifest < stable);
  assert.ok(stable < release);
  assert.match(source, /--scanners vuln,misconfig,secret/);
  assert.match(source, /--image-config-scanners misconfig/);
  assert.match(source, /--signer-workflow/);
  assert.match(source, /--source-digest "\$\{RELEASE_SHA\}"/);
  assert.match(source, /--source-ref "\$\{RELEASE_REF\}"/);
  assert.match(source, /--deny-self-hosted-runners/);
  assert.match(source, /--draft(?:\s|$)/m);
  assert.match(source, /--draft=false/);
  assert.match(source, /release-assets\/\*/);
  assert.match(source, /release-evidence\.mjs verify-assets/);
  assert.match(source, /"\$\{tags\}" != "\[\\"\$\{CANDIDATE_TAG\}\\"\]"/);
});

test("every release shell block passes Bash syntax validation", async () => {
  const workflow = YAML.parse(
    await readFile(path.resolve(".github/workflows/release.yml"), "utf8")
  );
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (typeof step.run !== "string") {
        continue;
      }
      const checked = spawnSync("bash", ["-n"], {
        input: step.run,
        encoding: "utf8"
      });
      assert.equal(
        checked.status,
        0,
        `${step.name ?? "unnamed release step"}: ${checked.stderr}`
      );
    }
  }
});
