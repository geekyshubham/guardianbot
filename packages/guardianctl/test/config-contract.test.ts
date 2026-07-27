import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubClient,
  parseGuardianConfig,
  type GitHubRepository
} from "@guardianbot/core";
import {
  generateOnboarding,
  type CommandContext
} from "../src/index.js";

const WORKFLOW_SHA = "a".repeat(40);

function repositoryClient(): {
  github: GitHubClient;
  requested: Set<string>;
} {
  const files = [
    "README.md",
    ".github/CODEOWNERS",
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    "uv.lock",
    "Package.swift",
    "Package.resolved",
    "Gemfile",
    "Gemfile.lock",
    "Containerfile",
    "src/server.ts",
    "Sources/Library/Library.swift",
    "lib/service.rb",
    "tests/test_service.py",
    "docs/openapi.safe.yaml"
  ];
  const contents = new Map<string, string>([
    ["README.md", "# Service\n"],
    [".github/CODEOWNERS", "* @acme/security\n"],
    [
      "package.json",
      JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: { test: "node --test", build: "tsc -p tsconfig.json" }
      })
    ],
    ["package-lock.json", "{}"],
    ["pyproject.toml", "[project]\nname = \"service\"\n"],
    ["uv.lock", "version = 1\n"],
    ["Package.swift", "// swift-tools-version: 6.0\n"],
    ["Package.resolved", "{}"],
    ["Gemfile", "source \"https://rubygems.org\"\n"],
    ["Gemfile.lock", "GEM\n"],
    ["Containerfile", "FROM node:22-alpine\nEXPOSE 8080\n"],
    ["src/server.ts", "app.get('/health', handler)\n"],
    ["Sources/Library/Library.swift", "public struct Library {}\n"],
    ["lib/service.rb", "class Service; end\n"],
    ["tests/test_service.py", "def test_service(): pass\n"],
    ["docs/openapi.safe.yaml", "openapi: 3.1.0\ninfo:\n  title: Service\n  version: 1.0.0\npaths: {}\n"]
  ]);
  const requested = new Set<string>();
  const metadata: GitHubRepository = {
    full_name: "acme/service",
    name: "service",
    owner: { login: "acme" },
    default_branch: "main",
    private: true,
    archived: false,
    fork: false
  };
  const github = {
    async getRepository() {
      return metadata;
    },
    async getTree() {
      return files;
    },
    async getLanguages() {
      return { TypeScript: 500, Python: 300, Swift: 200, Ruby: 100 };
    },
    async getFile(_owner: string, _repo: string, path: string) {
      requested.add(path);
      const content = contents.get(path);
      return content === undefined ? undefined : { content, sha: "f".repeat(40) };
    }
  } as unknown as GitHubClient;
  return { github, requested };
}

test("onboarding generates the complete reusable contract and explains coverage", async () => {
  const { github, requested } = repositoryClient();
  const context: CommandContext = {
    github,
    guardianRepository: "acme/guardianbot",
    workflowSha: WORKFLOW_SHA,
    dryRun: true,
    overrides: {
      dastOrigin: "https://staging.example.com",
      openapi: "docs/openapi.safe.yaml",
      authenticationProfile: "control-plane://profiles/service-staging",
      sessionAssertionPath: "/api/session"
    }
  };

  const generated = await generateOnboarding(context, "acme/service");
  const config = parseGuardianConfig(generated.config);

  assert.deepEqual(config.repository.packageManagers, [
    "bundler",
    "npm",
    "swift-package-manager",
    "uv"
  ]);
  assert.deepEqual(config.repository.lockfiles, [
    "Gemfile.lock",
    "Package.resolved",
    "package-lock.json",
    "uv.lock"
  ]);
  assert.equal(config.repository.codeowners, ".github/CODEOWNERS");
  assert.ok(config.paths?.source.length);
  assert.ok(config.paths?.test.length);
  assert.deepEqual(config.review.targetBranches, ["main"]);
  assert.equal(config.review.manual, true);
  assert.equal(config.runner?.executionEnvironment, "github-hosted");
  assert.ok(config.runner?.testCommands.includes("npm test"));
  assert.equal(config.image?.dockerfile, "Containerfile");
  assert.equal(config.image?.containerPort, 8080);
  assert.equal(config.image?.signing?.mode, "keyless");
  assert.equal(config.image?.deployment?.requireImmutableDigest, true);
  assert.deepEqual(config.dast?.allowedOrigins, ["https://staging.example.com"]);
  assert.equal(config.dast?.openapiSource, "repository-file");
  assert.equal(config.dast?.profiles?.deploySmoke, "authenticated-baseline");
  assert.equal(config.dast?.profiles?.nightly, "authenticated-full");

  for (const expected of [
    ".github/CODEOWNERS",
    "Package.swift",
    "Gemfile.lock",
    "Containerfile",
    "docs/openapi.safe.yaml",
    "README.md"
  ]) {
    assert.ok(requested.has(expected), `expected repository inspection to read ${expected}`);
  }
  assert.match(generated.report, /Generated reusable configuration/);
  assert.match(generated.report, /Commands are declarations|Detected commands are declarations/);
  assert.match(generated.report, /No model credentials.*backend URLs.*shared secrets/);
  assert.match(generated.workflow, new RegExp(`@${WORKFLOW_SHA}`));
});
