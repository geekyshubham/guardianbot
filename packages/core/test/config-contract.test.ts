import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type GuardianConfig,
  parseGuardianConfig,
  serializeGuardianConfig,
  validateAgainstJsonSchema,
  validateGuardianConfig
} from "../src/index.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../../../schemas/repository-config.v1.schema.json", import.meta.url),
    "utf8"
  )
) as object;

function legacyConfig(): GuardianConfig {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "a".repeat(40),
    repository: {
      defaultBranch: "main",
      releaseBranches: ["main"],
      languages: ["python"],
      relatedRepositories: []
    },
    review: {
      automatic: true,
      drafts: "manual",
      incremental: true,
      maxInlineComments: 8,
      categories: ["security", "logic", "testing"],
      highRiskPaths: ["**/auth/**"],
      contextDocuments: ["README.md"],
      excludedPaths: ["**/vendor/**"]
    },
    scanners: {
      mode: "report-only",
      semgrep: true,
      trivy: true,
      suppressions: []
    },
    image: null,
    dast: null
  };
}

function richConfig(): GuardianConfig {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "b".repeat(40),
    repository: {
      defaultBranch: "main",
      releaseBranches: ["main", "release/1.x"],
      languages: ["python", "typescript"],
      packageManagers: ["npm", "uv"],
      lockfiles: ["package-lock.json", "uv.lock"],
      codeowners: ".github/CODEOWNERS",
      relatedRepositories: ["acme/shared-contracts"]
    },
    paths: {
      source: ["src/**", "backend/**"],
      test: ["test/**", "tests/**"],
      generated: ["src/generated/**"],
      vendored: ["vendor/**"],
      excluded: ["node_modules/**", "dist/**", "vendor/**"]
    },
    review: {
      automatic: true,
      drafts: "manual",
      incremental: true,
      manual: true,
      targetBranches: ["main", "release/1.x"],
      maxInlineComments: 12,
      categories: ["security", "logic", "reliability", "contract", "testing"],
      highRiskPaths: ["**/auth/**", ".github/workflows/**"],
      contextDocuments: ["README.md", "SECURITY.md", ".github/CODEOWNERS"],
      excludedPaths: ["node_modules/**", "dist/**", "vendor/**"],
      pathRules: [
        {
          name: "authentication",
          paths: ["**/auth/**"],
          categories: ["security", "logic", "testing"],
          instructions: ["Require negative authorization tests and tenant isolation evidence."]
        }
      ]
    },
    runner: {
      executionEnvironment: "github-hosted",
      testCommands: ["npm test", "python -m pytest"],
      buildCommands: ["npm run build"]
    },
    scanners: {
      mode: "report-only",
      semgrep: true,
      trivy: true,
      suppressions: [
        {
          fingerprint: "trivy:CVE-2099-0001:package-lock.json",
          owner: "@security",
          reason: "Compensating control verified in staging.",
          ticket: "SEC-123",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    },
    image: {
      name: "acme/service",
      dockerfile: "ops/Dockerfile",
      context: ".",
      platform: "linux/amd64",
      buildArguments: {
        BUILD_MODE: "release"
      },
      smokeProfile: "multi-service",
      registry: "ghcr.io/acme/service",
      healthPath: "/health",
      readinessPath: "/ready",
      containerPort: 8080,
      ports: [{ name: "http", containerPort: 8080, protocol: "tcp" }],
      signing: {
        mode: "keyless",
        workflow: ".github/workflows/guardianbot.yml",
        ref: "refs/heads/main"
      },
      sbomFormat: "cyclonedx-json",
      sbomRetentionDays: 30,
      dependentServices: ["postgres", "redis"],
      runtimeEnvironment: {
        APP_MODE: "staging"
      },
      ephemeralEnvironment: ["DATABASE_URL", "REDIS_URL"],
      migrationCommand: "python -m alembic upgrade head",
      testCommand: "python -m pytest",
      deployment: {
        environment: "staging",
        requireImmutableDigest: true,
        requireSignature: true,
        requireSbom: true
      }
    },
    dast: {
      allowedOrigin: "https://staging.example.com",
      allowedOrigins: ["https://staging.example.com"],
      openapi: "docs/openapi.safe.yaml",
      openapiSource: "repository-file",
      authenticationProfile: "control-plane://profiles/service-staging",
      sessionAssertionPath: "/api/session",
      profiles: {
        deploySmoke: "authenticated-baseline",
        nightly: "authenticated-full"
      },
      excludedRoutes: ["/admin/reset", "/internal"]
    }
  };
}

test("keeps schema 1.0.0 configurations backward compatible", () => {
  const config = legacyConfig();
  assert.deepEqual(validateGuardianConfig(config), []);
  assert.deepEqual(validateAgainstJsonSchema(schema, config), []);
  assert.deepEqual(parseGuardianConfig(serializeGuardianConfig(config)), config);
});

test("accepts the complete reusable repository contract", () => {
  const config = richConfig();
  assert.deepEqual(validateGuardianConfig(config), []);
  assert.deepEqual(validateAgainstJsonSchema(schema, config), []);
});

test("rejects repository secrets, backend fields, and cross-origin DAST", () => {
  const config = richConfig() as GuardianConfig & {
    modelBackendUrl?: string;
  };
  config.modelBackendUrl = "https://models.example.com";
  config.image!.buildArguments = {
    API_TOKEN: "must-not-be-stored"
  };
  config.dast!.openapi = "https://schemas.example.net/openapi.json";
  config.dast!.openapiSource = "live-endpoint";

  const implementationErrors = validateGuardianConfig(config);
  assert.ok(
    implementationErrors.some((error) => error.includes("modelBackendUrl is not supported"))
  );
  assert.ok(
    implementationErrors.some((error) => error.includes("API_TOKEN is secret-like"))
  );
  assert.ok(
    implementationErrors.some((error) => error.includes("same origin"))
  );

  const schemaErrors = validateAgainstJsonSchema(schema, config);
  assert.ok(schemaErrors.some((error) => error.includes("additional properties")));
  assert.ok(schemaErrors.some((error) => error.includes("must NOT be valid")));
});
