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
  migrationCommands: string[];
  dockerfiles: string[];
  dockerfilePorts: Record<string, number[]>;
  dockerfileContexts: Record<string, string>;
  preferredDockerfile?: string;
  openapi: string[];
  codeowners?: string;
  healthPaths: string[];
  containerPorts: number[];
  dependentServices: Array<"postgres" | "redis">;
  sourcePaths: string[];
  testPaths: string[];
  generatedPaths: string[];
  vendoredPaths: string[];
  excludedPaths: string[];
  documentationOnly: boolean;
  notes: string[];
}

const SOURCE_EXTENSION =
  /\.(?:py|js|mjs|cjs|jsx|ts|mts|cts|tsx|swift|rb|go|rs|java|kt|kts|cs|php|scala|sh|bash|zsh|sql|proto|graphql|tf|vue|svelte)$/i;
const GENERATED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "deriveddata",
  "dist",
  "gen",
  "generated",
  "out",
  ".next"
]);
const VENDORED_DIRECTORIES = new Set([
  ".build",
  "carthage",
  "node_modules",
  "pods",
  "vendor"
]);
const TEST_DIRECTORIES = new Set(["__tests__", "spec", "test", "tests"]);
const SOURCE_DIRECTORIES = new Set(["app", "cmd", "lib", "pkg", "source", "sources", "src"]);
const DEFAULT_EXCLUDED_PATHS = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.build/**",
  "**/Pods/**",
  "**/Carthage/**",
  "**/*.generated.*",
  "**/*.min.js",
  "**/*.map"
];

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compare);
}

function isSafeRepositoryPath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 1_000 &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !/[\0\r\n]/.test(path) &&
    !path.split(/[\\/]/).some((segment) => segment === "..")
  );
}

function repositoryFiles(snapshot: RepositorySnapshot): string[] {
  return unique(snapshot.files.filter(isSafeRepositoryPath));
}

function has(files: readonly string[], pattern: RegExp): string[] {
  return files.filter((path) => pattern.test(path));
}

function addCommand(commands: string[], command: string | undefined): void {
  if (command && !commands.includes(command)) commands.push(command);
}

function pathSegments(path: string): string[] {
  return path.split("/");
}

function isInDirectory(path: string, directories: ReadonlySet<string>): boolean {
  return pathSegments(path)
    .slice(0, -1)
    .some((segment) => directories.has(segment.toLowerCase()));
}

function directoryGlobs(
  files: readonly string[],
  directories: ReadonlySet<string>
): string[] {
  const globs = new Set<string>();
  for (const path of files) {
    const segments = pathSegments(path);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      if (directories.has(segment.toLowerCase())) {
        globs.add(`${segments.slice(0, index + 1).join("/")}/**`);
      }
    }
  }
  return unique(globs);
}

function sourcePathGlobs(files: readonly string[]): string[] {
  const sourceFiles = files.filter(
    (path) =>
      SOURCE_EXTENSION.test(path) &&
      !isInDirectory(path, GENERATED_DIRECTORIES) &&
      !isInDirectory(path, VENDORED_DIRECTORIES) &&
      !isInDirectory(path, TEST_DIRECTORIES)
  );
  const globs = new Set(directoryGlobs(sourceFiles, SOURCE_DIRECTORIES));
  if (globs.size === 0) {
    const extensions = new Set(
      sourceFiles
        .map((path) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase())
        .filter((extension): extension is string => Boolean(extension))
    );
    for (const extension of [...extensions].sort(compare)) {
      globs.add(`**/*.${extension}`);
    }
  }
  return unique(globs);
}

function testPathGlobs(files: readonly string[]): string[] {
  const globs = new Set(directoryGlobs(files, TEST_DIRECTORIES));
  if (files.some((path) => /(?:^|\/)[^/]+\.test\.[^/]+$/i.test(path))) {
    globs.add("**/*.test.*");
  }
  if (files.some((path) => /(?:^|\/)[^/]+\.spec\.[^/]+$/i.test(path))) {
    globs.add("**/*.spec.*");
  }
  if (files.some((path) => /(?:^|\/)test_[^/]+\.py$/i.test(path))) {
    globs.add("**/test_*.py");
  }
  if (files.some((path) => /(?:^|\/)[^/]+_test\.(?:py|rb)$/i.test(path))) {
    globs.add("**/*_test.*");
  }
  return unique(globs);
}

function generatedPathGlobs(files: readonly string[]): string[] {
  const globs = new Set(directoryGlobs(files, GENERATED_DIRECTORIES));
  if (files.some((path) => /(?:^|\/)[^/]+\.generated\.[^/]+$/i.test(path))) {
    globs.add("**/*.generated.*");
  }
  return unique(globs);
}

function vendoredPathGlobs(files: readonly string[]): string[] {
  return directoryGlobs(files, VENDORED_DIRECTORIES);
}

function packageJson(
  content: string | undefined
): { packageManager?: "npm" | "pnpm" | "yarn" | "bun"; scripts: Set<string> } | undefined {
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content.replace(/^\uFEFF/, "")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const scripts = new Set<string>();
    if (record.scripts && typeof record.scripts === "object" && !Array.isArray(record.scripts)) {
      for (const [name, command] of Object.entries(record.scripts)) {
        if (typeof command === "string" && command.trim()) scripts.add(name);
      }
    }
    const managerMatch =
      typeof record.packageManager === "string"
        ? /^(npm|pnpm|yarn|bun)@/i.exec(record.packageManager.trim())
        : undefined;
    const packageManager = managerMatch?.[1]?.toLowerCase() as
      | "npm"
      | "pnpm"
      | "yarn"
      | "bun"
      | undefined;
    return { packageManager, scripts };
  } catch {
    return undefined;
  }
}

function nodeTestCommand(manager: string): string {
  return manager === "bun"
    ? "bun test"
    : manager === "pnpm"
      ? "pnpm test"
      : manager === "yarn"
        ? "yarn test"
        : "npm test";
}

function nodeBuildCommand(manager: string): string {
  return manager === "bun"
    ? "bun run build"
    : manager === "pnpm"
      ? "pnpm build"
      : manager === "yarn"
        ? "yarn build"
        : "npm run build";
}

function nodeScriptCommand(manager: string, script: string): string {
  return manager === "bun"
    ? `bun run ${script}`
    : manager === "pnpm"
      ? `pnpm run ${script}`
      : manager === "yarn"
        ? `yarn ${script}`
        : `npm run ${script}`;
}

function openApiContent(content: string): boolean {
  return /(?:^|[\r\n{,])\s*["']?(?:openapi|swagger)["']?\s*:\s*["']?(?:2|3)(?:\.\d+){0,2}/im.test(
    content
  );
}

function portsFromDockerfile(content: string): number[] {
  const variables = new Map<string, number>();
  const ports: number[] = [];
  const addPort = (value: string | undefined): void => {
    if (!value || !/^\d{1,5}$/.test(value)) return;
    const port = Number(value);
    if (port >= 1 && port <= 65_535 && !ports.includes(port)) ports.push(port);
  };

  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.replace(/\s+#.*$/, "").trim();
    const variable = /^(?:ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\s)\s*["']?(\d{1,5})/i.exec(
      line
    );
    if (variable) {
      const value = Number(variable[2]);
      if (value >= 1 && value <= 65_535) variables.set(variable[1]!, value);
    }
    const expose = /^EXPOSE\s+(.+)$/i.exec(line);
    if (!expose) continue;
    for (const rawToken of expose[1]!.split(/\s+/)) {
      const token = rawToken.replace(/^[\s"',[]+|[\s"',\]]+$/g, "");
      const numeric = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(token);
      if (numeric) {
        addPort(numeric[1]);
        continue;
      }
      const reference =
        /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-?(\d{1,5}))?\}|([A-Za-z_][A-Za-z0-9_]*))(?:\/(?:tcp|udp))?$/i.exec(
          token
        );
      if (!reference) continue;
      const variableName = reference[1] ?? reference[3];
      addPort(
        variableName && variables.has(variableName)
          ? String(variables.get(variableName))
          : reference[2]
      );
    }
  }
  return ports;
}

function repositoryDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function normalizedCopySources(content: string): string[] {
  const sources: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^COPY\s+/i.test(line) || /^COPY\s+--from(?:=|\s)/i.test(line)) continue;
    const value = line.replace(/^COPY\s+/i, "").replace(/^--[^\s]+\s+/, "").trim();
    if (value.startsWith("[")) {
      try {
        const items = JSON.parse(value) as unknown;
        if (Array.isArray(items)) {
          for (const item of items.slice(0, -1)) {
            if (typeof item === "string") sources.push(item);
          }
        }
      } catch {
        // Invalid Dockerfile JSON is left to the image build.
      }
      continue;
    }
    const items = value.split(/\s+/);
    sources.push(...items.slice(0, -1));
  }
  return sources
    .map((source) => source.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(
      (source) =>
        Boolean(source) &&
        source !== "." &&
        !source.includes("$") &&
        !source.includes("*") &&
        !/^[a-z]+:\/\//i.test(source) &&
        isSafeRepositoryPath(source)
    );
}

function repositorySourceExists(
  files: readonly string[],
  source: string,
  prefix = ""
): boolean {
  const candidate = prefix ? `${prefix}/${source}` : source;
  return files.some((path) => path === candidate || path.startsWith(`${candidate}/`));
}

function inferDockerContext(
  files: readonly string[],
  dockerfile: string,
  content: string
): string {
  const directory = repositoryDirectory(dockerfile);
  if (directory === ".") return ".";
  let repositoryMatches = 0;
  let directoryMatches = 0;
  for (const source of normalizedCopySources(content)) {
    if (repositorySourceExists(files, source)) repositoryMatches += 1;
    if (repositorySourceExists(files, source, directory)) directoryMatches += 1;
  }
  return directoryMatches > repositoryMatches ? directory : ".";
}

function validHealthPath(value: string): string | undefined {
  if (
    !/^\/(?!\/)[A-Za-z0-9_./-]+$/.test(value) ||
    value.includes("..") ||
    !/(?:^|\/)(?:healthz?|readyz?|readiness|liveness)(?:\/|$)/i.test(value)
  ) {
    return undefined;
  }
  return value;
}

function healthPathsFromContent(content: string): string[] {
  const quoted = [...content.matchAll(/["'`](\/[A-Za-z0-9_./-]+)["'`]/g)]
    .map((match) => validHealthPath(match[1]!))
    .filter((path): path is string => Boolean(path));
  const urls = [
    ...content.matchAll(/https?:\/\/[A-Za-z0-9_.:[\]-]+(\/[A-Za-z0-9_./-]+)/gi)
  ]
    .map((match) => validHealthPath(match[1]!))
    .filter((path): path is string => Boolean(path));
  return [...new Set([...quoted, ...urls])];
}

function normalizedImageNamePart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "repository";
}

function documentationPathGlobs(files: readonly string[]): string[] {
  const globs = new Set(
    directoryGlobs(files, new Set(["doc", "docs", "documentation"]))
  );
  const extensions = [
    ["md", "**/*.md"],
    ["mdx", "**/*.mdx"],
    ["rst", "**/*.rst"],
    ["adoc", "**/*.adoc"]
  ] as const;
  for (const [extension, glob] of extensions) {
    if (files.some((path) => path.toLowerCase().endsWith(`.${extension}`))) {
      globs.add(glob);
    }
  }
  return unique(globs);
}

function securitySensitivePathGlobs(
  files: readonly string[],
  dockerfiles: readonly string[]
): string[] {
  const globs = new Set<string>();
  if (files.some((path) => /(^|\/)auth(?:entication|orization)?(\/|[._-])/i.test(path))) {
    globs.add("**/*auth*");
  }
  if (files.some((path) => /(^|\/)security(\/|[._-])/i.test(path))) {
    globs.add("**/security/**");
  }
  if (files.some((path) => /(^|\/)migrations?(\/|[._-])/i.test(path))) {
    globs.add("**/migrations/**");
  }
  if (files.some((path) => /(^|\/)[^/]*(?:secret|credential)[^/]*$/i.test(path))) {
    globs.add("**/*secret*");
  }
  if (files.some((path) => /(^|\/)[^/]*tenant[^/]*$/i.test(path))) {
    globs.add("**/*tenant*");
  }
  if (files.some((path) => /^\.github\/workflows\//i.test(path))) {
    globs.add(".github/workflows/**");
  }
  if (dockerfiles.some((path) => /(^|\/)Dockerfile/i.test(path))) {
    globs.add("**/Dockerfile*");
  }
  if (dockerfiles.some((path) => /(^|\/)Containerfile/i.test(path))) {
    globs.add("**/Containerfile*");
  }
  return unique(globs);
}

function pathRules(
  snapshot: RepositorySnapshot,
  detection: DetectionResult
): NonNullable<GuardianConfig["review"]["pathRules"]> {
  const files = repositoryFiles(snapshot);
  const rules: NonNullable<GuardianConfig["review"]["pathRules"]> = [];
  if (detection.testPaths.length) {
    rules.push({
      name: "tests",
      paths: detection.testPaths,
      categories: ["testing", "logic"],
      instructions: [
        "Check that changed behavior has deterministic coverage and meaningful assertions."
      ]
    });
  }
  const documentationPaths = documentationPathGlobs(files);
  if (documentationPaths.length) {
    rules.push({
      name: "documentation",
      paths: documentationPaths,
      categories: ["contract", "maintainability"],
      instructions: [
        "Keep documented behavior, examples, and operational instructions aligned with the implementation."
      ]
    });
  }
  const securityPaths = securitySensitivePathGlobs(files, detection.dockerfiles);
  if (securityPaths.length) {
    rules.push({
      name: "security-sensitive",
      paths: securityPaths,
      categories: ["security", "logic", "reliability"],
      instructions: [
        "Review trust boundaries, authorization, secret handling, and safe failure behavior."
      ]
    });
  }
  return rules;
}

export function detectRepository(snapshot: RepositorySnapshot): DetectionResult {
  const files = repositoryFiles(snapshot);
  const fileSet = new Set(files);
  const contentEntries = Object.entries(snapshot.fileContents ?? {})
    .filter(
      (entry): entry is [string, string] =>
        fileSet.has(entry[0]) && typeof entry[1] === "string"
    )
    .sort(([left], [right]) => compare(left, right));
  const contentByPath = new Map(contentEntries);
  const languages = new Set(
    Object.keys(snapshot.languages ?? {}).map((value) => value.toLowerCase())
  );
  const packageManagers = new Set<string>();
  const lockfiles: string[] = [];
  const testCommands: string[] = [];
  const buildCommands: string[] = [];
  const migrationCommands: string[] = [];

  const pythonSource = has(files, /\.py$/i);
  const nodeSource = has(files, /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte)$/i);
  const swiftSource = has(files, /\.swift$/i);
  const rubySource = has(files, /\.rb$/i);
  if (pythonSource.length) languages.add("python");
  if (nodeSource.length) languages.add("javascript");
  if (swiftSource.length) languages.add("swift");
  if (rubySource.length) languages.add("ruby");

  const packageJsonPaths = has(files, /(^|\/)package\.json$/i);
  const nodeLocksByManager = {
    npm: has(files, /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/i),
    pnpm: has(files, /(^|\/)pnpm-lock\.ya?ml$/i),
    yarn: has(files, /(^|\/)yarn\.lock$/i),
    bun: has(files, /(^|\/)bun\.lockb?$/i)
  };
  const packageInfos = packageJsonPaths
    .map((path) => packageJson(contentByPath.get(path)))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const explicitNodeManagers = packageInfos
    .map((info) => info.packageManager)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  for (const manager of ["npm", "pnpm", "yarn", "bun"] as const) {
    if (nodeLocksByManager[manager].length) packageManagers.add(manager);
    lockfiles.push(...nodeLocksByManager[manager]);
  }
  for (const manager of explicitNodeManagers) packageManagers.add(manager);

  const nodeDetected =
    packageJsonPaths.length > 0 ||
    Object.values(nodeLocksByManager).some((paths) => paths.length > 0);
  if (nodeDetected) {
    languages.add("javascript");
    if (![...packageManagers].some((manager) => ["npm", "pnpm", "yarn", "bun"].includes(manager))) {
      packageManagers.add("npm");
    }
    const preferredNodeManager =
      explicitNodeManagers[0] ??
      (nodeLocksByManager.bun.length
        ? "bun"
        : nodeLocksByManager.pnpm.length
          ? "pnpm"
          : nodeLocksByManager.yarn.length
            ? "yarn"
            : "npm");
    const packageContentUnavailable =
      packageJsonPaths.length === 0 ||
      packageJsonPaths.every((path) => contentByPath.get(path) === undefined);
    const packageContentUnparseable =
      packageJsonPaths.some((path) => contentByPath.has(path)) && packageInfos.length === 0;
    const hasNodeScript = (name: string): boolean =>
      packageInfos.some((info) => info.scripts.has(name));

    if (packageContentUnavailable || packageContentUnparseable || hasNodeScript("test")) {
      addCommand(testCommands, nodeTestCommand(preferredNodeManager));
    }
    if (packageContentUnavailable || packageContentUnparseable || hasNodeScript("build")) {
      addCommand(buildCommands, nodeBuildCommand(preferredNodeManager));
    }
    for (const script of [
      "migrate",
      "db:migrate",
      "migration:run",
      "migrations:run",
      "prisma:migrate"
    ]) {
      if (hasNodeScript(script)) {
        addCommand(
          migrationCommands,
          nodeScriptCommand(preferredNodeManager, script)
        );
        break;
      }
    }
    if (
      !migrationCommands.length &&
      has(files, /(^|\/)prisma\/schema\.prisma$/i).length
    ) {
      addCommand(
        migrationCommands,
        preferredNodeManager === "pnpm"
          ? "pnpm exec prisma migrate deploy"
          : preferredNodeManager === "yarn"
            ? "yarn prisma migrate deploy"
            : preferredNodeManager === "bun"
              ? "bunx prisma migrate deploy"
              : "npx prisma migrate deploy"
      );
    }
  }

  const pythonLocks = has(
    files,
    /(^|\/)(?:requirements[^/]*\.(?:txt|lock)|poetry\.lock|Pipfile\.lock|uv\.lock|pdm\.lock)$/i
  );
  const pyprojectPaths = has(files, /(^|\/)pyproject\.toml$/i);
  const pythonManifestPaths = has(
    files,
    /(^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[^/]*\.(?:txt|lock))$/i
  );
  const pyprojectContent = pyprojectPaths
    .map((path) => contentByPath.get(path) ?? "")
    .join("\n");
  const hasPoetry =
    has(files, /(^|\/)poetry\.lock$/i).length > 0 ||
    /^\s*\[tool\.poetry\]/im.test(pyprojectContent);
  const hasUv =
    has(files, /(^|\/)uv\.lock$/i).length > 0 ||
    /^\s*\[tool\.uv(?:\.|\])/im.test(pyprojectContent);
  const hasPdm =
    has(files, /(^|\/)pdm\.lock$/i).length > 0 ||
    /^\s*\[tool\.pdm(?:\.|\])/im.test(pyprojectContent);
  const hasPipenv = has(files, /(^|\/)Pipfile(?:\.lock)?$/i).length > 0;
  const hasRequirements =
    has(files, /(^|\/)requirements[^/]*\.(?:txt|lock)$/i).length > 0;
  const pythonDetected =
    pythonSource.length > 0 || pythonLocks.length > 0 || pythonManifestPaths.length > 0;
  if (pythonDetected) {
    languages.add("python");
    if (hasPoetry) packageManagers.add("poetry");
    if (hasUv) packageManagers.add("uv");
    if (hasPdm) packageManagers.add("pdm");
    if (hasPipenv) packageManagers.add("pipenv");
    if (hasRequirements) packageManagers.add("pip");
    if (
      pythonManifestPaths.length &&
      !hasPoetry &&
      !hasUv &&
      !hasPdm &&
      !hasPipenv &&
      !hasRequirements
    ) {
      packageManagers.add("pip");
    }
    lockfiles.push(...pythonLocks);
    addCommand(testCommands, "python -m pytest");
    if (
      pyprojectPaths.length ||
      has(files, /(^|\/)(?:setup\.py|setup\.cfg)$/i).length
    ) {
      addCommand(buildCommands, "python -m build");
    }
    const djangoManagers = has(files, /(^|\/)manage\.py$/i).sort((left, right) => {
      const leftDepth = left.split("/").length;
      const rightDepth = right.split("/").length;
      return leftDepth - rightDepth || compare(left, right);
    });
    for (const path of djangoManagers) {
      if (/^[A-Za-z0-9._/-]+$/.test(path)) {
        addCommand(migrationCommands, `python ${path} migrate`);
      }
    }
    if (has(files, /(^|\/)alembic\.ini$/i).length) {
      addCommand(migrationCommands, "alembic upgrade head");
    }
  }

  const swiftLocks = has(files, /(^|\/)Package\.resolved$/i);
  const swiftManifests = has(files, /(^|\/)Package\.swift$/i);
  if (swiftSource.length || swiftLocks.length || swiftManifests.length) {
    languages.add("swift");
    if (swiftLocks.length || swiftManifests.length) {
      packageManagers.add("swift-package-manager");
    }
    lockfiles.push(...swiftLocks);
    if (swiftManifests.length) {
      addCommand(testCommands, "swift test");
      addCommand(buildCommands, "swift build");
    }
  }

  const rubyLocks = has(files, /(^|\/)Gemfile\.lock$/i);
  const gemfiles = has(files, /(^|\/)Gemfile$/i);
  const gemspecs = has(files, /(^|\/)[^/]+\.gemspec$/i);
  const rubyDetected =
    rubySource.length > 0 || rubyLocks.length > 0 || gemfiles.length > 0 || gemspecs.length > 0;
  if (rubyDetected) {
    languages.add("ruby");
    if (rubyLocks.length || gemfiles.length || gemspecs.length) {
      packageManagers.add("bundler");
    }
    lockfiles.push(...rubyLocks);
    const rails =
      has(files, /(^|\/)(?:bin\/rails|config\/application\.rb)$/i).length > 0 ||
      has(files, /(^|\/)db\/migrate\/[^/]+\.rb$/i).length > 0;
    const rspec =
      has(files, /(^|\/)spec\/[^/]+/i).length > 0 ||
      gemfiles.some((path) => /\brspec\b/i.test(contentByPath.get(path) ?? ""));
    addCommand(
      testCommands,
      rails
        ? "bundle exec rails test"
        : rspec
          ? "bundle exec rspec"
          : "bundle exec rake test"
    );
    const gemspec = gemspecs.find((path) => /^[A-Za-z0-9._/-]+$/.test(path));
    if (gemspec) addCommand(buildCommands, `gem build ${gemspec}`);
    if (rails) addCommand(migrationCommands, "bundle exec rails db:migrate");
  }

  const dockerfiles = has(
    files,
    /(^|\/)(?:(?:Dockerfile|Containerfile)(?:\.[^/]+)?|[^/]+\.(?:dockerfile|containerfile))$/i
  );
  const openapi = new Set(
    has(files, /(^|\/)[^/]*(?:openapi|swagger)[^/]*\.(?:json|ya?ml)$/i)
  );
  for (const [path, content] of contentEntries) {
    if (
      /\.(?:json|ya?ml)$/i.test(path) &&
      !/(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/i.test(path) &&
      openApiContent(content)
    ) {
      openapi.add(path);
    }
  }

  const dockerfileReferences = new Map<string, number>();
  for (const [path, content] of contentEntries) {
    if (!/\.github\/workflows\/|deploy|digitalocean|compose/i.test(path)) continue;
    const weight = 1 + (/deploy/i.test(path) ? 2 : 0) + (/digitalocean/i.test(path) ? 4 : 0);
    for (const dockerfile of dockerfiles) {
      const exactReference = new RegExp(
        `(?:^|[^A-Za-z0-9_./-])${escapeRegExp(dockerfile)}(?:$|[^A-Za-z0-9_./-])`,
        "m"
      );
      if (exactReference.test(content)) {
        dockerfileReferences.set(
          dockerfile,
          (dockerfileReferences.get(dockerfile) ?? 0) + weight
        );
      }
    }
  }
  const preferredDockerfile = [...dockerfileReferences.entries()]
    .sort((left, right) => right[1] - left[1] || compare(left[0], right[0]))[0]?.[0];
  const primaryDockerfile =
    preferredDockerfile ??
    dockerfiles.find((path) => path.toLowerCase() === "dockerfile") ??
    dockerfiles.find((path) => path.toLowerCase() === "containerfile") ??
    dockerfiles[0];
  const dockerfilePorts = Object.fromEntries(
    dockerfiles.map((dockerfile) => [
      dockerfile,
      portsFromDockerfile(contentByPath.get(dockerfile) ?? "")
    ])
  );
  const dockerfileContexts = Object.fromEntries(
    dockerfiles.map((dockerfile) => [
      dockerfile,
      inferDockerContext(files, dockerfile, contentByPath.get(dockerfile) ?? "")
    ])
  );
  const containerPorts = primaryDockerfile
    ? [...(dockerfilePorts[primaryDockerfile] ?? [])]
    : [];
  if (primaryDockerfile && !containerPorts.length) containerPorts.push(8000);

  const codeowners = [
    ".github/CODEOWNERS",
    "CODEOWNERS",
    "docs/CODEOWNERS"
  ].map((candidate) =>
    files.find((path) => path.toLowerCase() === candidate.toLowerCase())
  ).find((path): path is string => Boolean(path));

  const primaryHealthPaths = primaryDockerfile
    ? healthPathsFromContent(contentByPath.get(primaryDockerfile) ?? "")
    : [];
  const applicationHealthPaths = contentEntries
    .filter(
      ([path]) =>
        !/(^|\/)(?:docs?|examples?|fixtures?|node_modules|vendor|dist|build)\//i.test(path) &&
        !/^\.guardianbot\//i.test(path) &&
        (SOURCE_EXTENSION.test(path) ||
          /(?:^|\/)(?:Dockerfile|Containerfile)(?:\.[^/]*)?$/i.test(path) ||
          /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i.test(path))
    )
    .flatMap(([, content]) => healthPathsFromContent(content));
  const primaryHealthSet = new Set(primaryHealthPaths);
  const healthPaths = [...new Set([...primaryHealthPaths, ...applicationHealthPaths])].sort(
    (left, right) => {
      const score = (path: string) =>
        (primaryHealthSet.has(path) ? 100 : 0) +
        (path === "/healthz"
          ? 5
          : path === "/health"
            ? 4
            : /\/health\/ready\/?$/.test(path)
              ? 3
              : /ready/i.test(path)
                ? 2
                : 1);
      return score(right) - score(left) || compare(left, right);
    }
  );
  const imageRelatedContent = primaryDockerfile
    ? [
        contentByPath.get(primaryDockerfile) ?? "",
        ...contentEntries
          .filter(
            ([path]) =>
              /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i.test(path) ||
              /(?:^|\/)(?:deploy|deployment)[^/]*\.ya?ml$/i.test(path)
          )
          .map(([, content]) => content)
      ].join("\n")
    : "";
  const dependentServices: Array<"postgres" | "redis"> = [];
  if (/postgres|DATABASE_URL/i.test(imageRelatedContent)) dependentServices.push("postgres");
  if (/redis|REDIS_URL/i.test(imageRelatedContent)) dependentServices.push("redis");

  const sourcePaths = sourcePathGlobs(files);
  const testPaths = testPathGlobs(files);
  const generatedPaths = generatedPathGlobs(files);
  const vendoredPaths = vendoredPathGlobs(files);
  const excludedPaths = unique([
    ...DEFAULT_EXCLUDED_PATHS,
    ...generatedPaths,
    ...vendoredPaths
  ]);
  const sourceFiles = files.filter(
    (path) =>
      SOURCE_EXTENSION.test(path) &&
      !isInDirectory(path, GENERATED_DIRECTORIES) &&
      !isInDirectory(path, VENDORED_DIRECTORIES)
  );
  const projectManifests = has(
    files,
    /(^|\/)(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[^/]*\.(?:txt|lock)|Package\.swift|Gemfile|[^/]+\.gemspec)$/i
  );
  const documentationOnly =
    sourceFiles.length === 0 && projectManifests.length === 0 && dockerfiles.length === 0;
  const notes: string[] = [];
  if (!lockfiles.length) notes.push("No supported dependency lockfile detected.");
  if (!dockerfiles.length) {
    notes.push("Image scanning is not applicable until a Dockerfile or Containerfile is configured.");
  }
  if (!openapi.size) notes.push("DAST requires an OpenAPI artifact or explicit crawl profile.");
  if (!codeowners) notes.push("No CODEOWNERS file detected; reviewer suggestions will use history.");
  if (documentationOnly) {
    notes.push("No application source files were detected; scanner defaults are advisory.");
  }

  return {
    languages: [...languages].sort(),
    packageManagers: [...packageManagers].sort(),
    lockfiles: unique(lockfiles),
    testCommands,
    buildCommands,
    migrationCommands,
    dockerfiles,
    dockerfilePorts,
    dockerfileContexts,
    preferredDockerfile,
    openapi: unique(openapi),
    codeowners,
    healthPaths,
    containerPorts,
    dependentServices,
    sourcePaths,
    testPaths,
    generatedPaths,
    vendoredPaths,
    excludedPaths,
    documentationOnly,
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
  const containerPorts = primaryDockerfile
    ? detection.dockerfilePorts[primaryDockerfile] ?? []
    : [];
  const healthPath = detection.healthPaths[0] ?? "/health";

  return {
    schemaVersion: "1.0.0",
    workflowVersion: workflowSha,
    repository: {
      defaultBranch: snapshot.defaultBranch,
      releaseBranches: [snapshot.defaultBranch],
      languages: detection.languages,
      packageManagers: detection.packageManagers,
      lockfiles: detection.lockfiles,
      ...(detection.codeowners ? { codeowners: detection.codeowners } : {}),
      relatedRepositories: []
    },
    paths: {
      source: detection.sourcePaths,
      test: detection.testPaths,
      generated: detection.generatedPaths,
      vendored: detection.vendoredPaths,
      excluded: detection.excludedPaths
    },
    review: {
      automatic: true,
      drafts: "manual",
      incremental: true,
      manual: true,
      targetBranches: [snapshot.defaultBranch],
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
        "**/Containerfile*",
        "**/*secret*",
        "**/*tenant*"
      ],
      contextDocuments: [
        "README.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        detection.codeowners
      ].filter(
        (path): path is string =>
          typeof path === "string" &&
          snapshot.files.some(
            (candidate) => candidate.toLowerCase() === path.toLowerCase()
          )
      ),
      excludedPaths: detection.excludedPaths,
      pathRules: pathRules(snapshot, detection)
    },
    runner: {
      executionEnvironment: "github-hosted",
      testCommands: detection.testCommands,
      buildCommands: detection.buildCommands
    },
    scanners: {
      mode: detection.documentationOnly ? "advisory" : "report-only",
      semgrep: !detection.documentationOnly,
      trivy:
        !detection.documentationOnly &&
        (detection.lockfiles.length > 0 || detection.dockerfiles.length > 0),
      suppressions: []
    },
    image: primaryDockerfile
      ? {
          name: `${normalizedImageNamePart(snapshot.owner)}/${normalizedImageNamePart(snapshot.name)}`,
          dockerfile: primaryDockerfile,
          context: detection.dockerfileContexts[primaryDockerfile] ?? ".",
          platform: "linux/amd64",
          buildArguments: {},
          smokeProfile: detection.dependentServices.length ? "multi-service" : "http",
          registry: `ghcr.io/${snapshot.owner.toLowerCase()}/${snapshot.name.toLowerCase()}`,
          healthPath,
          readinessPath: detection.healthPaths.find((path) => /ready/i.test(path)),
          containerPort: containerPorts[0] ?? 8000,
          ports: (containerPorts.length ? containerPorts : [8000]).map(
            (containerPort, index) => ({
              name: index === 0 ? "http" : `port-${containerPort}`,
              containerPort,
              protocol: "tcp" as const
            })
          ),
          signing: {
            mode: "keyless",
            workflow: ".github/workflows/guardianbot.yml",
            ref: `refs/heads/${snapshot.defaultBranch}`
          },
          sbomFormat: "cyclonedx-json",
          sbomRetentionDays: 30,
          dependentServices: detection.dependentServices,
          migrationCommand: detection.migrationCommands[0],
          testCommand: detection.testCommands[0],
          deployment: {
            environment: "staging",
            requireImmutableDigest: true,
            requireSignature: true,
            requireSbom: true,
            promotionMode: "enforce-only"
          }
        }
      : null,
    dast: null
  };
}
