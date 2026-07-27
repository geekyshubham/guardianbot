#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IMAGE_NAME = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const PLATFORM = /^linux\/amd64$/;
const WORKFLOW_IDENTITY =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/release\.yml@refs\/tags\/v/;

export const RELEASE_SCHEMA = "guardianbot.release-evidence.v1";

const EVIDENCE_FILES = Object.freeze({
  trivyScan: "trivy-image.json",
  trivyVersion: "trivy-version.json",
  sbom: "sbom.cdx.json",
  githubProvenance: "github-provenance.sigstore.json",
  githubProvenanceVerification: "github-provenance-verification.json",
  githubProvenanceOciVerification:
    "github-provenance-oci-verification.json",
  cosignSignatureVerification: "cosign-signature-verification.json",
  cosignSbomVerification: "cosign-sbom-verification.json"
});

export const RELEASE_ASSET_FILES = Object.freeze(
  [
    ...Object.values(EVIDENCE_FILES),
    "release-manifest.json",
    "release-manifest.sigstore.json",
    "checksums.sha256"
  ].sort()
);

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function assertMatch(value, expression, label) {
  if (!expression.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
}

export async function validateReleaseInput({
  tag,
  sha,
  ref,
  repository,
  packagePath = "package.json",
  changelogPath = "CHANGELOG.md",
  dockerfilePath = "Dockerfile"
}) {
  required(tag, "release tag");
  required(sha, "release commit");
  required(ref, "release ref");
  required(repository, "release repository");
  assertMatch(tag, SEMVER_TAG, "release tag");
  assertMatch(sha, COMMIT_SHA, "release commit");
  assertMatch(repository, REPOSITORY, "release repository");
  if (ref !== `refs/tags/${tag}`) {
    throw new Error("release ref must exactly match the release tag");
  }

  const packageDocument = JSON.parse(await readFile(packagePath, "utf8"));
  const version = tag.slice(1);
  if (packageDocument.version !== version) {
    throw new Error(
      `package version ${String(packageDocument.version)} does not match tag ${tag}`
    );
  }
  if (!Array.isArray(packageDocument.workspaces)) {
    throw new Error("root package must declare explicit workspace paths");
  }
  const packageDirectory = path.dirname(path.resolve(packagePath));
  for (const workspace of packageDocument.workspaces) {
    if (
      typeof workspace !== "string" ||
      workspace.length === 0 ||
      workspace.includes("*") ||
      path.isAbsolute(workspace) ||
      workspace.split(/[\\/]/u).includes("..")
    ) {
      throw new Error("release validation requires explicit workspace paths");
    }
    const workspaceDocument = JSON.parse(
      await readFile(path.join(packageDirectory, workspace, "package.json"), "utf8")
    );
    if (workspaceDocument.version !== version) {
      throw new Error(
        `workspace ${workspace} version ${String(workspaceDocument.version)} ` +
          `does not match tag ${tag}`
      );
    }
  }
  const changelog = await readFile(changelogPath, "utf8");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const releaseHeading = new RegExp(
    `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    "mu"
  );
  if (!releaseHeading.test(changelog)) {
    throw new Error(`CHANGELOG.md has no dated ${version} release heading`);
  }
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const baseImages = dockerfile
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/iu)?.[1])
    .filter(Boolean);
  if (baseImages.length === 0) {
    throw new Error("Dockerfile must declare at least one base image");
  }
  for (const baseImage of baseImages) {
    if (
      baseImage !== "scratch" &&
      !/@sha256:[0-9a-f]{64}$/u.test(baseImage)
    ) {
      throw new Error(`Dockerfile base image is not digest-pinned: ${baseImage}`);
    }
  }

  return {
    tag,
    version,
    sha,
    ref,
    repository
  };
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function describeEvidence(directory, logicalName, relativePath) {
  if (path.basename(relativePath) !== relativePath) {
    throw new Error(`${logicalName} evidence path must be a basename`);
  }
  const absolutePath = path.join(directory, relativePath);
  const details = await stat(absolutePath);
  if (!details.isFile() || details.size === 0) {
    throw new Error(`${logicalName} evidence must be a non-empty file`);
  }
  if (details.size > 128 * 1024 * 1024) {
    throw new Error(`${logicalName} evidence exceeds 128 MiB`);
  }
  JSON.parse(await readFile(absolutePath, "utf8"));
  return {
    path: relativePath,
    sha256: await sha256File(absolutePath),
    size: details.size
  };
}

function validateTrivyScan(document) {
  if (
    document.SchemaVersion !== 2 ||
    typeof document.ArtifactName !== "string" ||
    document.ArtifactName.length === 0 ||
    typeof document.ArtifactType !== "string" ||
    document.ArtifactType.length === 0 ||
    !Array.isArray(document.Results) ||
    document.Results.length === 0
  ) {
    throw new Error("Trivy evidence is not a complete image-scan document");
  }
  const criticalFindings = document.Results.flatMap((result) => [
    ...(Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : []),
    ...(Array.isArray(result.Secrets) ? result.Secrets : []),
    ...(Array.isArray(result.Misconfigurations) ? result.Misconfigurations : [])
  ]).filter((finding) => finding?.Severity === "CRITICAL");
  if (criticalFindings.length > 0) {
    throw new Error("Trivy evidence contains Critical findings");
  }
}

function validateSbom(document) {
  if (
    document.bomFormat !== "CycloneDX" ||
    typeof document.specVersion !== "string" ||
    !Array.isArray(document.components)
  ) {
    throw new Error("SBOM evidence is not a CycloneDX JSON document");
  }
}

function validateVerificationArray(document, label) {
  if (!Array.isArray(document) || document.length === 0) {
    throw new Error(`${label} must contain at least one verified statement`);
  }
}

export async function createReleaseManifest({
  directory,
  tag,
  sha,
  ref,
  repository,
  image,
  digest,
  platform,
  workflowIdentity
}) {
  required(directory, "evidence directory");
  required(tag, "release tag");
  required(sha, "release commit");
  required(ref, "release ref");
  required(repository, "release repository");
  required(image, "release image");
  required(digest, "release digest");
  required(platform, "release platform");
  required(workflowIdentity, "release workflow identity");
  assertMatch(tag, SEMVER_TAG, "release tag");
  assertMatch(sha, COMMIT_SHA, "release commit");
  assertMatch(repository, REPOSITORY, "release repository");
  assertMatch(image, IMAGE_NAME, "release image");
  assertMatch(digest, IMAGE_DIGEST, "release digest");
  assertMatch(platform, PLATFORM, "release platform");
  assertMatch(workflowIdentity, WORKFLOW_IDENTITY, "release workflow identity");
  if (ref !== `refs/tags/${tag}`) {
    throw new Error("release ref must exactly match the release tag");
  }
  if (image !== `ghcr.io/${repository.toLowerCase()}`) {
    throw new Error("release image must be the repository's canonical GHCR image");
  }
  const expectedIdentity =
    `https://github.com/${repository}/.github/workflows/release.yml@${ref}`;
  if (workflowIdentity !== expectedIdentity) {
    throw new Error("release workflow identity does not match repository and ref");
  }

  const trivyDocument = JSON.parse(
    await readFile(path.join(directory, EVIDENCE_FILES.trivyScan), "utf8")
  );
  validateTrivyScan(trivyDocument);
  const sbomDocument = JSON.parse(
    await readFile(path.join(directory, EVIDENCE_FILES.sbom), "utf8")
  );
  validateSbom(sbomDocument);
  const trivyVersion = JSON.parse(
    await readFile(path.join(directory, EVIDENCE_FILES.trivyVersion), "utf8")
  );
  if (typeof trivyVersion.Version !== "string" || trivyVersion.Version.length === 0) {
    throw new Error("Trivy version evidence is incomplete");
  }
  const githubProvenance = JSON.parse(
    await readFile(path.join(directory, EVIDENCE_FILES.githubProvenance), "utf8")
  );
  if (
    typeof githubProvenance !== "object" ||
    githubProvenance === null ||
    Array.isArray(githubProvenance) ||
    Object.keys(githubProvenance).length === 0
  ) {
    throw new Error("GitHub provenance bundle is incomplete");
  }
  validateVerificationArray(
    JSON.parse(
      await readFile(
        path.join(directory, EVIDENCE_FILES.githubProvenanceVerification),
        "utf8"
      )
    ),
    "GitHub provenance verification"
  );
  validateVerificationArray(
    JSON.parse(
      await readFile(
        path.join(directory, EVIDENCE_FILES.githubProvenanceOciVerification),
        "utf8"
      )
    ),
    "GitHub OCI provenance verification"
  );
  validateVerificationArray(
    JSON.parse(
      await readFile(
        path.join(directory, EVIDENCE_FILES.cosignSignatureVerification),
        "utf8"
      )
    ),
    "Cosign signature verification"
  );
  validateVerificationArray(
    JSON.parse(
      await readFile(
        path.join(directory, EVIDENCE_FILES.cosignSbomVerification),
        "utf8"
      )
    ),
    "Cosign SBOM verification"
  );

  const evidence = {};
  for (const [logicalName, relativePath] of Object.entries(EVIDENCE_FILES)) {
    evidence[logicalName] = await describeEvidence(
      directory,
      logicalName,
      relativePath
    );
  }

  const version = tag.slice(1);
  const manifest = {
    schemaVersion: RELEASE_SCHEMA,
    version,
    source: {
      repository,
      commit: sha,
      ref,
      tag
    },
    image: {
      name: image,
      digest,
      reference: `${image}@${digest}`,
      platform,
      tags: [`${image}:${tag}`, `${image}:sha-${sha}`]
    },
    builder: {
      workflowIdentity
    },
    evidence
  };

  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644
  });
  return manifest;
}

export async function writeReleaseChecksums(directory) {
  const entries = [];
  for (const name of RELEASE_ASSET_FILES) {
    if (name === "checksums.sha256") {
      continue;
    }
    const details = await stat(path.join(directory, name));
    if (!details.isFile() || details.size === 0) {
      throw new Error(`release asset ${name} must be a non-empty file`);
    }
    entries.push(`${await sha256File(path.join(directory, name))}  ${name}`);
  }
  await writeFile(
    path.join(directory, "checksums.sha256"),
    `${entries.join("\n")}\n`,
    { mode: 0o644 }
  );
}

export async function stageReleaseAssets(sourceDirectory, destinationDirectory) {
  await writeReleaseChecksums(sourceDirectory);
  await mkdir(destinationDirectory, { recursive: false });
  for (const name of RELEASE_ASSET_FILES) {
    await copyFile(
      path.join(sourceDirectory, name),
      path.join(destinationDirectory, name)
    );
  }
  await verifyReleaseAssets(destinationDirectory);
}

export async function verifyReleaseAssets(directory) {
  const actualNames = (
    await readdir(directory, { withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const nonFiles = (
    await readdir(directory, { withFileTypes: true })
  ).filter((entry) => !entry.isFile());
  if (
    nonFiles.length > 0 ||
    JSON.stringify(actualNames) !== JSON.stringify(RELEASE_ASSET_FILES)
  ) {
    throw new Error("release asset set is not exactly canonical");
  }

  const checksumLines = (
    await readFile(path.join(directory, "checksums.sha256"), "utf8")
  )
    .trimEnd()
    .split("\n");
  const expectedNames = RELEASE_ASSET_FILES.filter(
    (name) => name !== "checksums.sha256"
  );
  if (checksumLines.length !== expectedNames.length) {
    throw new Error("release checksum set is incomplete");
  }
  for (let index = 0; index < checksumLines.length; index += 1) {
    const expectedName = expectedNames[index];
    const match = checksumLines[index].match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u);
    if (!match || match[2] !== expectedName) {
      throw new Error("release checksum set is not canonical");
    }
    if (match[1] !== (await sha256File(path.join(directory, expectedName)))) {
      throw new Error(`release asset checksum does not match: ${expectedName}`);
    }
  }
}

export async function verifyReleaseManifest({
  manifestPath,
  expectedTag,
  expectedSha,
  expectedRepository,
  expectedDigest
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== RELEASE_SCHEMA) {
    throw new Error("release manifest schema version is not supported");
  }
  assertMatch(manifest.source?.tag ?? "", SEMVER_TAG, "manifest tag");
  assertMatch(manifest.source?.commit ?? "", COMMIT_SHA, "manifest commit");
  assertMatch(manifest.source?.repository ?? "", REPOSITORY, "manifest repository");
  assertMatch(manifest.image?.digest ?? "", IMAGE_DIGEST, "manifest digest");
  assertMatch(manifest.image?.platform ?? "", PLATFORM, "manifest platform");
  if (manifest.version !== manifest.source.tag.slice(1)) {
    throw new Error("manifest version does not match its tag");
  }
  if (manifest.source.ref !== `refs/tags/${manifest.source.tag}`) {
    throw new Error("manifest source ref does not match its tag");
  }
  if (
    manifest.image.name !==
      `ghcr.io/${manifest.source.repository.toLowerCase()}` ||
    manifest.image.reference !==
      `${manifest.image.name}@${manifest.image.digest}`
  ) {
    throw new Error("manifest canonical image reference is inconsistent");
  }
  const expectedTags = [
    `${manifest.image.name}:${manifest.source.tag}`,
    `${manifest.image.name}:sha-${manifest.source.commit}`
  ];
  if (
    !Array.isArray(manifest.image.tags) ||
    JSON.stringify(manifest.image.tags) !== JSON.stringify(expectedTags)
  ) {
    throw new Error("manifest release tags are inconsistent");
  }
  const expectedIdentity =
    `https://github.com/${manifest.source.repository}/.github/workflows/release.yml@` +
    manifest.source.ref;
  if (manifest.builder?.workflowIdentity !== expectedIdentity) {
    throw new Error("manifest workflow identity is inconsistent");
  }

  const evidenceDirectory = path.dirname(manifestPath);
  for (const [logicalName, relativePath] of Object.entries(EVIDENCE_FILES)) {
    const descriptor = manifest.evidence?.[logicalName];
    if (
      descriptor?.path !== relativePath ||
      !/^[0-9a-f]{64}$/.test(descriptor?.sha256 ?? "")
    ) {
      throw new Error(`${logicalName} evidence descriptor is invalid`);
    }
    const actual = await describeEvidence(
      evidenceDirectory,
      logicalName,
      relativePath
    );
    if (
      descriptor.sha256 !== actual.sha256 ||
      descriptor.size !== actual.size
    ) {
      throw new Error(`${logicalName} evidence does not match its descriptor`);
    }
  }

  const expectedValues = [
    ["tag", expectedTag, manifest.source.tag],
    ["commit", expectedSha, manifest.source.commit],
    ["repository", expectedRepository, manifest.source.repository],
    ["digest", expectedDigest, manifest.image.digest]
  ];
  for (const [label, expected, actual] of expectedValues) {
    if (expected && expected !== actual) {
      throw new Error(`manifest ${label} does not match the expected value`);
    }
  }
  return manifest;
}

function releaseEnvironment() {
  return {
    tag: process.env.RELEASE_TAG,
    sha: process.env.RELEASE_SHA,
    ref: process.env.RELEASE_REF,
    repository: process.env.RELEASE_REPOSITORY,
    packagePath: process.env.RELEASE_PACKAGE_PATH ?? "package.json",
    changelogPath: process.env.RELEASE_CHANGELOG_PATH ?? "CHANGELOG.md",
    dockerfilePath: process.env.RELEASE_DOCKERFILE_PATH ?? "Dockerfile"
  };
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") {
    const validated = await validateReleaseInput(releaseEnvironment());
    process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
    return;
  }
  if (command === "create-manifest") {
    const manifest = await createReleaseManifest({
      directory: process.env.RELEASE_EVIDENCE_DIRECTORY ?? "release-evidence",
      ...releaseEnvironment(),
      image: process.env.RELEASE_IMAGE,
      digest: process.env.RELEASE_DIGEST,
      platform: process.env.RELEASE_PLATFORM,
      workflowIdentity: process.env.RELEASE_WORKFLOW_IDENTITY
    });
    process.stdout.write(`${manifest.image.reference}\n`);
    return;
  }
  if (command === "verify-manifest") {
    const manifest = await verifyReleaseManifest({
      manifestPath:
        process.env.RELEASE_MANIFEST_PATH ??
        "release-evidence/release-manifest.json",
      expectedTag: process.env.RELEASE_TAG,
      expectedSha: process.env.RELEASE_SHA,
      expectedRepository: process.env.RELEASE_REPOSITORY,
      expectedDigest: process.env.RELEASE_DIGEST
    });
    process.stdout.write(`${manifest.image.reference}\n`);
    return;
  }
  if (command === "stage-assets") {
    await stageReleaseAssets(
      process.env.RELEASE_EVIDENCE_DIRECTORY ?? "release-evidence",
      process.env.RELEASE_ASSET_DIRECTORY ?? "release-assets"
    );
    process.stdout.write("release assets staged\n");
    return;
  }
  if (command === "verify-assets") {
    await verifyReleaseAssets(
      process.env.RELEASE_ASSET_DIRECTORY ?? "release-assets"
    );
    process.stdout.write("release assets verified\n");
    return;
  }
  throw new Error(
    "usage: node scripts/release-evidence.mjs " +
      "<validate|create-manifest|verify-manifest|stage-assets|verify-assets>"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
