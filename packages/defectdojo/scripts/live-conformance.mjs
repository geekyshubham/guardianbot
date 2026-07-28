#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DefectDojoClient,
  buildDefectDojoTags,
  resolveDefectDojoConfig
} from "../dist/index.js";

const CONFIRMATION = "guardianbot-defectdojo-live-conformance";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(SCRIPT_DIR, "../fixtures/semgrep-empty.json");

function usage() {
  process.stdout.write(`Usage:
  npm run conformance:live --workspace @guardianbot/defectdojo -- \\
    --run-id YYYYMMDDTHHMMSSZ \\
    --confirm ${CONFIRMATION}

Required environment:
  GUARDIANBOT_DEFECTDOJO_BASE_URL_REF
  GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF
  the two variables named by those references

This command creates one isolated conformance engagement, imports a non-secret
empty Semgrep fixture, and reimports it into the same DefectDojo test. It never
prints the API token.
`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument !== "--run-id" && argument !== "--confirm") {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value`);
    }
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (values.confirm !== CONFIRMATION) {
    throw new Error(`Refusing live mutation without --confirm ${CONFIRMATION}`);
  }
  if (!RUN_ID_PATTERN.test(values["run-id"] ?? "")) {
    throw new Error("--run-id must contain only letters, digits, dot, underscore, or hyphen");
  }
  return { runId: values["run-id"] };
}

function conformanceDates(now) {
  const end = new Date(now);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return {
    targetStart: now.toISOString().slice(0, 10),
    targetEnd: end.toISOString().slice(0, 10)
  };
}

async function main() {
  const { runId } = parseArguments(process.argv.slice(2));
  const baseUrlRef = process.env.GUARDIANBOT_DEFECTDOJO_BASE_URL_REF;
  const apiTokenRef = process.env.GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF;
  if (!baseUrlRef || !apiTokenRef) {
    throw new Error(
      "GUARDIANBOT_DEFECTDOJO_BASE_URL_REF and " +
      "GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF are required"
    );
  }

  const config = resolveDefectDojoConfig(process.env, {
    baseUrlRef,
    apiTokenRef,
    userAgent: "guardianbot-defectdojo-live-conformance"
  });
  const client = new DefectDojoClient(config);
  const dates = conformanceDates(new Date());
  const engagementName = `conformance/${runId}`;
  const testTitle = `${engagementName}/semgrep`;
  const tags = buildDefectDojoTags({
    repositoryId: 1,
    repositorySlug: "guardianbot/defectdojo-conformance",
    visibility: "private",
    commitSha: "0000000000000000000000000000000000000000",
    workflowRunId: runId,
    branch: "conformance",
    profile: "security",
    scanType: "Semgrep JSON Report",
    customTags: ["guardianbot:conformance"]
  });
  const context = await client.ensureImportContext({
    productType: {
      name: "GitHub Repositories",
      description: "Repositories whose scanner evidence is managed by GuardianBot"
    },
    product: {
      name: "guardianbot/defectdojo-conformance",
      description: "Non-production GuardianBot DefectDojo API conformance evidence",
      tags: ["guardianbot:conformance"]
    },
    engagement: {
      name: engagementName,
      status: "In Progress",
      targetStart: dates.targetStart,
      targetEnd: dates.targetEnd,
      branchTag: "conformance",
      buildId: runId,
      tags
    },
    test: {
      scanType: "Semgrep JSON Report",
      title: testTitle,
      branchTag: "conformance",
      buildId: runId,
      tags
    }
  });
  if (Array.isArray(context)) {
    throw new Error("Live conformance cannot run with DefectDojo dry-run mode");
  }
  if (context.test) {
    throw new Error(
      `Conformance test already exists for run ID ${runId}; choose a new --run-id`
    );
  }

  const fixture = new Uint8Array(await readFile(FIXTURE_PATH));
  const first = await client.importScan({
    scanType: "Semgrep JSON Report",
    testTitle,
    fileName: "semgrep-empty.json",
    contentType: "application/json",
    report: fixture,
    engagementId: context.engagement.id,
    metadata: {
      branchTag: "conformance",
      buildId: runId,
      closeOldFindings: false,
      active: true,
      verified: true,
      tags
    }
  });
  if ("dryRun" in first || first.mode !== "import" || !Number.isSafeInteger(first.testId)) {
    throw new Error("DefectDojo import-scan did not return a valid new test ID");
  }

  const second = await client.importScan({
    scanType: "Semgrep JSON Report",
    testTitle,
    fileName: "semgrep-empty.json",
    contentType: "application/json",
    report: fixture,
    engagementId: context.engagement.id,
    existingTestId: first.testId,
    metadata: {
      branchTag: "conformance",
      buildId: runId,
      closeOldFindings: true,
      active: true,
      verified: true,
      tags
    }
  });
  if (
    "dryRun" in second ||
    second.mode !== "reimport" ||
    second.testId !== first.testId
  ) {
    throw new Error("DefectDojo reimport-scan did not preserve the imported test ID");
  }

  process.stdout.write(
    `DefectDojo live conformance passed for test ${first.testId}: import then reimport.\n`
  );
}

main().catch((error) => {
  process.stderr.write(
    `DefectDojo live conformance failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
