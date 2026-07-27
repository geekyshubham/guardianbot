import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
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

function cosignSbomEnvelope({
  image = "ghcr.io/geekyshubham/guardianbot",
  digest = DIGEST,
  sbom
}) {
  return {
    payload: Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v0.1",
        subject: [
          {
            name: image,
            digest: { sha256: digest.slice("sha256:".length) }
          }
        ],
        predicateType: "https://cyclonedx.org/bom",
        predicate: sbom
      })
    ).toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ sig: "verified-by-cosign" }]
  };
}

async function evidenceFixture(
  directory,
  {
    attestedImage = "ghcr.io/geekyshubham/guardianbot",
    attestedDigest = DIGEST,
    attestedSbom
  } = {}
) {
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: []
  };
  const documents = {
    "trivy-image.json": {
      SchemaVersion: 2,
      ArtifactName: "guardianbot:candidate",
      ArtifactType: "container_image",
      Results: [{ Target: "guardianbot", Vulnerabilities: null }]
    },
    "trivy-version.json": { Version: "0.70.0" },
    "sbom.cdx.json": sbom,
    "github-provenance.sigstore.json": { mediaType: "application/json" },
    "github-provenance-verification.json": [{ verificationResult: {} }],
    "github-provenance-oci-verification.json": [{ verificationResult: {} }],
    "cosign-signature-verification.json": [{ critical: {} }],
    "cosign-sbom-verification.json": cosignSbomEnvelope({
      image: attestedImage,
      digest: attestedDigest,
      sbom: attestedSbom ?? sbom
    })
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

test("clean type checking builds every declaration dependency first", async () => {
  const packageDocument = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8")
  );
  const typecheck = packageDocument.scripts?.typecheck;
  assert.equal(typeof typecheck, "string");
  const workspaceTypecheck = typecheck.indexOf(
    "npm run typecheck --workspaces --if-present"
  );
  assert.ok(workspaceTypecheck > 0);
  for (const workspace of [
    "@guardianbot/protocol",
    "@guardianbot/core",
    "@guardianbot/defectdojo",
    "@guardianbot/monitoring"
  ]) {
    const dependencyBuild = typecheck.indexOf(
      `npm run build --workspace ${workspace}`
    );
    assert.ok(
      dependencyBuild >= 0 && dependencyBuild < workspaceTypecheck,
      `${workspace} declarations must be built before workspace type checking`
    );
  }
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

test("manifest rejects an SBOM attestation for another image digest", async () => {
  const directory = await temporaryDirectory();
  await evidenceFixture(directory, {
    attestedDigest: `sha256:${"c".repeat(64)}`
  });
  await assert.rejects(
    createReleaseManifest({
      directory,
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      image: "ghcr.io/geekyshubham/guardianbot",
      digest: DIGEST,
      platform: "linux/amd64",
      workflowIdentity: IDENTITY
    }),
    /does not bind the exact image, digest, and SBOM/
  );
});

test("manifest rejects an attested SBOM different from the release SBOM", async () => {
  const directory = await temporaryDirectory();
  await evidenceFixture(directory, {
    attestedSbom: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: "different" }]
    }
  });
  await assert.rejects(
    createReleaseManifest({
      directory,
      tag: TAG,
      sha: SHA,
      ref: REF,
      repository: REPOSITORY,
      image: "ghcr.io/geekyshubham/guardianbot",
      digest: DIGEST,
      platform: "linux/amd64",
      workflowIdentity: IDENTITY
    }),
    /does not bind the exact image, digest, and SBOM/
  );
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
  const sourceVerifier = await readFile(
    path.resolve("scripts/verify-release-source.sh"),
    "utf8"
  );
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
  const releaseCheck = workflow.jobs.verify_source.steps.find(
    (step) =>
      step.name ===
      "Run schema, contract, documentation, and package checks"
  );
  assert.match(
    releaseCheck.run,
    /DOCS_DIFF_BASE="\$\(git rev-parse "\$\{RELEASE_SHA\}\^"\)"/
  );
  assert.equal(
    source.match(/bash scripts\/verify-release-source\.sh/g)?.length,
    2
  );
  assert.match(
    sourceVerifier,
    /compare\/\$\{RELEASE_SHA\}\.\.\.\$\{default_branch_sha\}/
  );
  assert.match(sourceVerifier, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(sourceVerifier, /git\/tags\/\$\{remote_tag_object_sha\}/);
  assert.match(sourceVerifier, /defaultBranchRef/);
  assert.doesNotMatch(source, /refs\/remotes\/origin\/main/);
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

test("remote release-source verification requires an annotated exact tag", async () => {
  const directory = await temporaryDirectory();
  const fakeBin = path.join(directory, "bin");
  await mkdir(fakeBin);
  const fakeGit = path.join(fakeBin, "git");
  const fakeGh = path.join(fakeBin, "gh");
  await writeFile(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "rev-parse" && "$2" == "HEAD" ]]
printf '%s\\n' "\${FAKE_RELEASE_SHA}"
`
  );
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
arguments="$*"
if [[ "\${arguments}" == *"/git/ref/tags/"* ]]; then
  printf 'refs/tags/%s\\t%s\\t%s\\n' \
    "\${RELEASE_TAG}" "\${FAKE_REF_TYPE:-tag}" "\${FAKE_TAG_OBJECT_SHA}"
elif [[ "\${arguments}" == *"/git/tags/"* ]]; then
  printf '%s\\tcommit\\t%s\\n' "\${RELEASE_TAG}" "\${RELEASE_SHA}"
elif [[ "\${arguments}" == *"graphql"* ]]; then
  printf '%s\\t%s\\n' "\${RELEASE_DEFAULT_BRANCH}" "\${FAKE_DEFAULT_SHA}"
elif [[ "\${arguments}" == *"/compare/"* ]]; then
  printf '%s\\n' "\${FAKE_COMPARE_STATUS:-identical}"
else
  exit 2
fi
`
  );
  await chmod(fakeGit, 0o755);
  await chmod(fakeGh, 0o755);
  const releaseSha = "1".repeat(40);
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    GH_TOKEN: "test-token",
    RELEASE_DEFAULT_BRANCH: "main",
    RELEASE_REF: "refs/tags/v1.2.3",
    RELEASE_REPOSITORY: "Geekyshubham/guardianbot",
    RELEASE_SHA: releaseSha,
    RELEASE_TAG: "v1.2.3",
    FAKE_RELEASE_SHA: releaseSha,
    FAKE_TAG_OBJECT_SHA: "2".repeat(40),
    FAKE_DEFAULT_SHA: "3".repeat(40)
  };
  const verifier = path.resolve("scripts/verify-release-source.sh");
  const accepted = spawnSync("bash", [verifier], {
    encoding: "utf8",
    env: environment
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  const lightweight = spawnSync("bash", [verifier], {
    encoding: "utf8",
    env: { ...environment, FAKE_REF_TYPE: "commit" }
  });
  assert.equal(lightweight.status, 1);
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
  assert.doesNotMatch(source, /--signer-workflow/);
  assert.match(source, /--cert-identity "\$\{WORKFLOW_IDENTITY\}"/);
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
  const sourceVerifier = spawnSync(
    "bash",
    ["-n", path.resolve("scripts/verify-release-source.sh")],
    { encoding: "utf8" }
  );
  assert.equal(sourceVerifier.status, 0, sourceVerifier.stderr);
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
