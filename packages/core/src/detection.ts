import type { GuardianConfig } from "./config.js";

export interface RepositorySnapshot {
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: "public" | "private" | "restricted";
  files: string[];
  languages?: Record<string, number>;
  fileContents?: Record<string, string>;
}

export interface DetectionResult {
  languages: string[];
  packageManagers: string[];
  lockfiles: string[];
  testCommands: string[];
  buildCommands: string[];
  dockerfiles: string[];
  preferredDockerfile?: string;
  openapi: string[];
  codeowners?: string;
  healthPaths: string[];
  dependentServices: Array<"postgres" | "redis">;
  documentationOnly: boolean;
  notes: string[];
}

function has(snapshot: RepositorySnapshot, pattern: RegExp): string[] {
  return snapshot.files.filter((path) => pattern.test(path));
}

export function detectRepository(snapshot: RepositorySnapshot): DetectionResult {
  const languages = new Set(
    Object.keys(snapshot.languages ?? {}).map((value) => value.toLowerCase())
  );
  const packageManagers = new Set<string>();
  const lockfiles: string[] = [];
  const testCommands: string[] = [];
  const buildCommands: string[] = [];

  const packageLocks = has(snapshot, /(^|\/)package-lock\.json$/);
  const pnpmLocks = has(snapshot, /(^|\/)pnpm-lock\.yaml$/);
  const yarnLocks = has(snapshot, /(^|\/)yarn\.lock$/);
  if (packageLocks.length || pnpmLocks.length || yarnLocks.length) {
    languages.add("javascript");
    packageManagers.add(pnpmLocks.length ? "pnpm" : yarnLocks.length ? "yarn" : "npm");
    lockfiles.push(...packageLocks, ...pnpmLocks, ...yarnLocks);
    const command = pnpmLocks.length ? "pnpm test" : yarnLocks.length ? "yarn test" : "npm test";
    testCommands.push(command);
    buildCommands.push(pnpmLocks.length ? "pnpm build" : yarnLocks.length ? "yarn build" : "npm run build");
  }

  const pythonLocks = has(
    snapshot,
    /(^|\/)(requirements[^/]*\.txt|requirements[^/]*\.lock|poetry\.lock|Pipfile\.lock|uv\.lock)$/
  );
  if (pythonLocks.length || has(snapshot, /(^|\/)pyproject\.toml$/).length) {
    languages.add("python");
    packageManagers.add(
      has(snapshot, /(^|\/)poetry\.lock$/).length ? "poetry" : "pip"
    );
    lockfiles.push(...pythonLocks);
    testCommands.push("python -m pytest");
  }

  const swiftLocks = has(snapshot, /(^|\/)Package\.resolved$/);
  if (swiftLocks.length || has(snapshot, /(^|\/)Package\.swift$/).length) {
    languages.add("swift");
    packageManagers.add("swift-package-manager");
    lockfiles.push(...swiftLocks);
    testCommands.push("swift test");
    buildCommands.push("swift build");
  }

  const rubyLocks = has(snapshot, /(^|\/)Gemfile\.lock$/);
  if (rubyLocks.length || has(snapshot, /(^|\/).*\.gemspec$/).length) {
    languages.add("ruby");
    packageManagers.add("bundler");
    lockfiles.push(...rubyLocks);
    testCommands.push("bundle exec rake test");
  }

  const dockerfiles = has(snapshot, /(^|\/)Dockerfile(?:\.[^/]+)?$/i);
  const openapi = has(snapshot, /(^|\/)[^/]*(openapi|swagger)[^/]*\.(json|ya?ml)$/i);
  const dockerfileReferences = new Map<string, number>();
  for (const [path, content] of Object.entries(snapshot.fileContents ?? {})) {
    if (!/\.github\/workflows\/|deploy|digitalocean|compose/i.test(path)) continue;
    const weight = 1 + (/deploy/i.test(path) ? 2 : 0) + (/digitalocean/i.test(path) ? 4 : 0);
    for (const dockerfile of dockerfiles) {
      if (content.includes(dockerfile)) {
        dockerfileReferences.set(
          dockerfile,
          (dockerfileReferences.get(dockerfile) ?? 0) + weight
        );
      }
    }
  }
  const preferredDockerfile = [...dockerfileReferences.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  const codeowners = snapshot.files.find((path) =>
    /(^|\/)(CODEOWNERS)$/.test(path)
  );
  const joined = Object.values(snapshot.fileContents ?? {}).join("\n");
  const extractedHealthPaths = [...joined.matchAll(
    /["'`](\/?[A-Za-z0-9_./-]*(?:health|ready)[A-Za-z0-9_./-]*\/?)["'`]/gi
  )].map((match) => match[1]!.startsWith("/") ? match[1]! : `/${match[1]}`);
  const healthPaths = [...new Set([
    ...extractedHealthPaths,
    ...["/health", "/ready", "/api/v1/health/"].filter((path) => joined.includes(path))
  ])].sort((left, right) => {
    const score = (path: string) => path === "/api/v1/health/" ? 3 :
      path === "/health" ? 2 : path === "/ready" ? 1 : 0;
    return score(right) - score(left);
  });
  const dependentServices: Array<"postgres" | "redis"> = [];
  if (/postgres|DATABASE_URL/i.test(joined)) dependentServices.push("postgres");
  if (/redis|REDIS_URL/i.test(joined)) dependentServices.push("redis");

  const sourceFiles = has(
    snapshot,
    /\.(py|js|mjs|cjs|ts|tsx|jsx|swift|rb|go|rs|java|kt|cs|php)$/
  );
  const notes: string[] = [];
  if (!lockfiles.length) notes.push("No supported dependency lockfile detected.");
  if (!dockerfiles.length) notes.push("Image scanning is not applicable until a Dockerfile is configured.");
  if (!openapi.length) notes.push("DAST requires an OpenAPI artifact or explicit crawl profile.");
  if (!codeowners) notes.push("No CODEOWNERS file detected; reviewer suggestions will use history.");

  return {
    languages: [...languages].sort(),
    packageManagers: [...packageManagers].sort(),
    lockfiles: [...new Set(lockfiles)].sort(),
    testCommands: [...new Set(testCommands)],
    buildCommands: [...new Set(buildCommands)],
    dockerfiles,
    preferredDockerfile,
    openapi,
    codeowners,
    healthPaths,
    dependentServices,
    documentationOnly: sourceFiles.length === 0,
    notes
  };
}

export function generateGuardianConfig(
  snapshot: RepositorySnapshot,
  detection: DetectionResult,
  workflowSha: string
): GuardianConfig {
  const primaryDockerfile =
    detection.preferredDockerfile ??
    detection.dockerfiles.find((path) => path === "Dockerfile") ??
    detection.dockerfiles[0];
  const healthPath = detection.healthPaths[0] ?? "/health";

  return {
    schemaVersion: "1.0.0",
    workflowVersion: workflowSha,
    repository: {
      defaultBranch: snapshot.defaultBranch,
      releaseBranches: [snapshot.defaultBranch],
      languages: detection.languages,
      relatedRepositories: []
    },
    review: {
      automatic: true,
      drafts: "manual",
      incremental: true,
      maxInlineComments: 8,
      categories: [
        "security",
        "logic",
        "reliability",
        "concurrency",
        "performance",
        "contract",
        "testing"
      ],
      highRiskPaths: [
        "**/auth/**",
        "**/security/**",
        "**/migrations/**",
        ".github/workflows/**",
        "**/Dockerfile*",
        "**/*secret*",
        "**/*tenant*"
      ],
      contextDocuments: [
        "README.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        detection.codeowners ?? ".github/CODEOWNERS"
      ],
      excludedPaths: [
        "**/node_modules/**",
        "**/vendor/**",
        "**/dist/**",
        "**/build/**",
        "**/*.min.js"
      ]
    },
    scanners: {
      mode: detection.documentationOnly ? "advisory" : "report-only",
      semgrep: !detection.documentationOnly,
      trivy: detection.lockfiles.length > 0,
      suppressions: []
    },
    image: primaryDockerfile
      ? {
          dockerfile: primaryDockerfile,
          context: ".",
          platform: "linux/amd64",
          registry: `ghcr.io/${snapshot.owner.toLowerCase()}/${snapshot.name.toLowerCase()}`,
          healthPath,
          readinessPath: detection.healthPaths.includes("/ready") ? "/ready" : undefined,
          containerPort: 8000,
          sbomFormat: "cyclonedx-json",
          dependentServices: detection.dependentServices
        }
      : null,
    dast: null
  };
}
