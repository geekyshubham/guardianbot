import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectRepository,
  generateGuardianConfig,
  validateGuardianConfig,
  type RepositorySnapshot
} from "../src/index.js";

function snapshot(
  files: string[],
  fileContents: Record<string, string> = {}
): RepositorySnapshot {
  return {
    owner: "Acme",
    name: "Payments-Service",
    defaultBranch: "main",
    visibility: "private",
    files,
    fileContents
  };
}

test("detects npm, pnpm, yarn, and bun projects, including package.json without a lockfile", () => {
  const fixtures = [
    {
      files: ["package.json"],
      contents: {
        "package.json": JSON.stringify({ scripts: { test: "node --test", build: "tsc" } })
      },
      manager: "npm",
      lockfiles: [],
      testCommand: "npm test",
      buildCommand: "npm run build"
    },
    {
      files: ["package.json", "pnpm-lock.yaml"],
      contents: {},
      manager: "pnpm",
      lockfiles: ["pnpm-lock.yaml"],
      testCommand: "pnpm test",
      buildCommand: "pnpm build"
    },
    {
      files: ["package.json", "yarn.lock"],
      contents: {},
      manager: "yarn",
      lockfiles: ["yarn.lock"],
      testCommand: "yarn test",
      buildCommand: "yarn build"
    },
    {
      files: ["package.json", "bun.lockb"],
      contents: {},
      manager: "bun",
      lockfiles: ["bun.lockb"],
      testCommand: "bun test",
      buildCommand: "bun run build"
    }
  ] as const;

  for (const fixture of fixtures) {
    const detection = detectRepository(snapshot([...fixture.files], fixture.contents));
    assert.deepEqual(detection.packageManagers, [fixture.manager]);
    assert.deepEqual(detection.lockfiles, [...fixture.lockfiles]);
    assert.ok(detection.testCommands.includes(fixture.testCommand));
    assert.ok(detection.buildCommands.includes(fixture.buildCommand));
    assert.ok(detection.languages.includes("javascript"));
    assert.equal(detection.documentationOnly, false);
  }
});

test("generates the extended reusable config from content-aware repository detection", () => {
  const repository = snapshot(
    [
      ".github/CODEOWNERS",
      ".github/workflows/deploy.yml",
      "Containerfile",
      "docs/api-contract.yaml",
      "docs/operations.md",
      "generated/client.ts",
      "package.json",
      "src/auth.ts",
      "tests/auth.test.ts",
      "vendor/legacy/index.js"
    ],
    {
      "package.json": JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: {
          test: "node --test",
          build: "tsc",
          migrate: "prisma migrate deploy"
        }
      }),
      Containerfile: [
        "FROM node:22-alpine",
        "ARG APP_PORT=8080",
        "EXPOSE ${APP_PORT}/tcp 9090",
        "HEALTHCHECK CMD wget -qO- http://localhost:8080/ready",
        "ENV DATABASE_URL=postgres://postgres@postgres/app",
        "ENV REDIS_URL=redis://redis:6379"
      ].join("\n"),
      "docs/api-contract.yaml": "openapi: 3.1.0\ninfo:\n  title: Payments\n  version: 1.0.0\n",
      ".github/workflows/deploy.yml": "dockerfile: Containerfile\n# digitalocean deploy"
    }
  );

  const detection = detectRepository(repository);
  assert.deepEqual(detection.packageManagers, ["pnpm"]);
  assert.deepEqual(detection.containerPorts, [8080, 9090]);
  assert.deepEqual(detection.dockerfilePorts, {
    Containerfile: [8080, 9090]
  });
  assert.deepEqual(detection.migrationCommands, ["pnpm run migrate"]);
  assert.deepEqual(detection.openapi, ["docs/api-contract.yaml"]);
  assert.equal(detection.codeowners, ".github/CODEOWNERS");
  assert.ok(detection.sourcePaths.includes("src/**"));
  assert.ok(detection.testPaths.includes("tests/**"));
  assert.ok(detection.generatedPaths.includes("generated/**"));
  assert.ok(detection.vendoredPaths.includes("vendor/**"));

  const config = generateGuardianConfig(repository, detection, "a".repeat(40));
  assert.deepEqual(validateGuardianConfig(config), []);
  assert.deepEqual(config.repository.packageManagers, ["pnpm"]);
  assert.deepEqual(config.repository.lockfiles, []);
  assert.equal(config.repository.codeowners, ".github/CODEOWNERS");
  assert.deepEqual(config.paths?.excluded, config.review.excludedPaths);
  assert.equal(config.scanners.trivy, true);
  assert.equal(config.review.manual, true);
  assert.deepEqual(config.review.targetBranches, ["main"]);
  assert.deepEqual(
    config.review.pathRules?.map((rule) => rule.name),
    ["tests", "documentation", "security-sensitive"]
  );
  assert.deepEqual(config.runner, {
    executionEnvironment: "github-hosted",
    testCommands: ["pnpm test"],
    buildCommands: ["pnpm build"]
  });
  assert.ok(config.image);
  assert.equal(config.image.name, "acme/payments-service");
  assert.equal(config.image.dockerfile, "Containerfile");
  assert.equal(config.image.context, ".");
  assert.equal(config.image.platform, "linux/amd64");
  assert.equal(config.image.registry, "ghcr.io/acme/payments-service");
  assert.equal(config.image.healthPath, "/ready");
  assert.equal(config.image.readinessPath, "/ready");
  assert.equal(config.image.containerPort, 8080);
  assert.deepEqual(config.image.ports, [
    { name: "http", containerPort: 8080, protocol: "tcp" },
    { name: "port-9090", containerPort: 9090, protocol: "tcp" }
  ]);
  assert.equal(config.image.smokeProfile, "multi-service");
  assert.deepEqual(config.image.dependentServices, ["postgres", "redis"]);
  assert.equal(config.image.testCommand, "pnpm test");
  assert.equal(config.image.migrationCommand, "pnpm run migrate");
  assert.deepEqual(config.image.signing, {
    mode: "keyless",
    workflow: ".github/workflows/guardianbot.yml",
    ref: "refs/heads/main"
  });
  assert.equal(config.image.sbomFormat, "cyclonedx-json");
  assert.equal(config.image.sbomRetentionDays, 30);
  assert.deepEqual(config.image.deployment, {
    environment: "staging",
    requireImmutableDigest: true,
    requireSignature: true,
    requireSbom: true,
    promotionMode: "enforce-only"
  });
  assert.equal(config.dast, null);
});

test("keeps container ports scoped to the selected Dockerfile", () => {
  const repository = snapshot(
    [
      ".github/workflows/deploy.yml",
      "Dockerfile",
      "ops/digitalocean/Dockerfile"
    ],
    {
      Dockerfile: "FROM node:22-alpine\nEXPOSE 3000\n",
      "ops/digitalocean/Dockerfile": [
        "FROM node:22-alpine",
        "ENV PORT=8080",
        "EXPOSE 8080"
      ].join("\n"),
      ".github/workflows/deploy.yml":
        "dockerfile: ops/digitalocean/Dockerfile\n# digitalocean deploy"
    }
  );

  const detection = detectRepository(repository);
  assert.equal(detection.preferredDockerfile, "ops/digitalocean/Dockerfile");
  assert.deepEqual(detection.containerPorts, [8080]);
  assert.deepEqual(detection.dockerfilePorts, {
    Dockerfile: [3000],
    "ops/digitalocean/Dockerfile": [8080]
  });

  const config = generateGuardianConfig(repository, detection, "a".repeat(40));
  assert.equal(config.image?.dockerfile, "ops/digitalocean/Dockerfile");
  assert.equal(config.image?.containerPort, 8080);
  assert.deepEqual(config.image?.ports, [
    { name: "http", containerPort: 8080, protocol: "tcp" }
  ]);
});

test("scopes image context, health routes, and dependencies to image-related evidence", () => {
  const repository = snapshot(
    [
      "README.md",
      "scripts/outreach.py",
      "web/Caddyfile",
      "web/Dockerfile",
      "web/package-lock.json",
      "web/package.json",
      "web/src/server.js"
    ],
    {
      "README.md": "Optional PostgreSQL and Redis integrations are documented here.",
      "scripts/outreach.py": "print('ALREADY_SENT')\n",
      "web/Dockerfile": [
        "FROM node:22-alpine",
        "WORKDIR /app",
        "COPY package.json package-lock.json ./",
        "COPY Caddyfile /etc/caddy/Caddyfile",
        "COPY src src",
        "EXPOSE 9119",
        "HEALTHCHECK CMD wget -qO- http://127.0.0.1:9119/healthz"
      ].join("\n"),
      "web/src/server.js": "app.get('/readyz', readiness)\n"
    }
  );

  const detection = detectRepository(repository);
  assert.deepEqual(detection.dockerfileContexts, {
    "web/Dockerfile": "web"
  });
  assert.deepEqual(detection.healthPaths, ["/healthz", "/readyz"]);
  assert.deepEqual(detection.dependentServices, []);
  assert.equal(detection.healthPaths.includes("/ALREADY_SENT"), false);

  const config = generateGuardianConfig(repository, detection, "c".repeat(40));
  assert.equal(config.image?.context, "web");
  assert.equal(config.image?.healthPath, "/healthz");
  assert.equal(config.image?.readinessPath, "/readyz");
  assert.equal(config.image?.containerPort, 9119);
  assert.deepEqual(config.image?.dependentServices, []);
});

test("detects Python, Swift, and Ruby manifests and useful migration commands", () => {
  const detection = detectRepository(
    snapshot(
      [
        "Gemfile",
        "Gemfile.lock",
        "Package.resolved",
        "Package.swift",
        "config/application.rb",
        "manage.py",
        "poetry.lock",
        "pyproject.toml",
        "src/service.py"
      ],
      {
        Gemfile: "gem 'rails'\n",
        "pyproject.toml": "[tool.poetry]\nname = \"service\"\n"
      }
    )
  );

  assert.deepEqual(detection.packageManagers, [
    "bundler",
    "poetry",
    "swift-package-manager"
  ]);
  assert.deepEqual(detection.lockfiles, [
    "Gemfile.lock",
    "Package.resolved",
    "poetry.lock"
  ]);
  assert.ok(detection.testCommands.includes("python -m pytest"));
  assert.ok(detection.testCommands.includes("swift test"));
  assert.ok(detection.testCommands.includes("bundle exec rails test"));
  assert.ok(detection.buildCommands.includes("python -m build"));
  assert.ok(detection.buildCommands.includes("swift build"));
  assert.deepEqual(detection.migrationCommands, [
    "python manage.py migrate",
    "bundle exec rails db:migrate"
  ]);
});

test("keeps documentation-only and hostile paths out of generated repository path fields", () => {
  const documentation = snapshot(
    [
      "../escape/package-lock.json",
      "/absolute/src/app.ts",
      ".github/CODEOWNERS",
      "README.md",
      "docs/architecture.mdx",
      "docs/schema.yaml"
    ],
    {
      "docs/schema.yaml": "swagger: '2.0'\ninfo:\n  title: Docs API\n  version: 1.0.0\n"
    }
  );
  const detection = detectRepository(documentation);
  assert.equal(detection.documentationOnly, true);
  assert.deepEqual(detection.sourcePaths, []);
  assert.deepEqual(detection.testPaths, []);
  assert.deepEqual(detection.openapi, ["docs/schema.yaml"]);
  assert.deepEqual(detection.lockfiles, []);
  assert.equal(detection.codeowners, ".github/CODEOWNERS");

  const emittedPaths = [
    ...detection.sourcePaths,
    ...detection.testPaths,
    ...detection.generatedPaths,
    ...detection.vendoredPaths,
    ...detection.excludedPaths,
    ...detection.lockfiles,
    ...detection.dockerfiles,
    ...detection.openapi
  ];
  assert.equal(
    emittedPaths.some(
      (path) =>
        path.startsWith("/") ||
        path.startsWith("\\") ||
        path.split(/[\\/]/).includes("..")
    ),
    false
  );

  const config = generateGuardianConfig(documentation, detection, "b".repeat(40));
  assert.deepEqual(validateGuardianConfig(config), []);
  assert.equal(config.scanners.mode, "advisory");
  assert.equal(config.scanners.semgrep, false);
  assert.equal(config.scanners.trivy, false);
  assert.equal(config.image, null);
});
