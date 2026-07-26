import {
  GitHubClient,
  detectRepository,
  generateCallerWorkflow,
  generateGuardianConfig,
  parseGuardianConfig,
  renderOnboardingReport,
  serializeGuardianConfig,
  type DetectionResult,
  type RepositorySnapshot
} from "@guardianbot/core";

export interface CommandContext {
  github: GitHubClient;
  guardianRepository: string;
  workflowSha: string;
  dryRun?: boolean;
  overrides?: {
    dockerfile?: string;
    healthPath?: string;
    readinessPath?: string;
    dastOrigin?: string;
    openapi?: string;
    authenticationProfile?: string;
    sessionAssertionPath?: string;
  };
}

export interface GeneratedOnboarding {
  snapshot: RepositorySnapshot;
  detection: DetectionResult;
  config: string;
  workflow: string;
  report: string;
}

export function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!match) throw new Error("Repository must be formatted as OWNER/REPOSITORY");
  return { owner: match[1]!, repo: match[2]! };
}

export async function inspectRepository(
  github: GitHubClient,
  repository: string
): Promise<RepositorySnapshot> {
  const { owner, repo } = parseRepository(repository);
  const metadata = await github.getRepository(owner, repo);
  const files = await github.getTree(owner, repo, metadata.default_branch);
  const languages = await github.getLanguages(owner, repo);
  const contextual = files.filter((path) =>
    /(^|\/)(package\.json|pyproject\.toml|Gemfile|Package\.swift|docker-compose[^/]*\.ya?ml|Dockerfile(?:\.[^/]*)?|.*(?:url|route|health|ready|schema|openapi|swagger|deploy|workflow).*\.(?:ya?ml|json|py|ts|js))$/i.test(path)
  );
  const source = files.filter((path) => /\.(ya?ml|json|py|ts|js)$/i.test(path));
  const candidates = [...new Set([...contextual, ...source])].slice(0, 140);
  const fileContents: Record<string, string> = {};
  await Promise.all(
    candidates.map(async (path) => {
      const file = await github.getFile(owner, repo, path, metadata.default_branch);
      if (file && file.content.length <= 250_000) fileContents[path] = file.content;
    })
  );
  return {
    owner,
    name: repo,
    defaultBranch: metadata.default_branch,
    visibility: metadata.private ? "private" : "public",
    files,
    languages,
    fileContents
  };
}

export async function generateOnboarding(
  context: CommandContext,
  repository: string
): Promise<GeneratedOnboarding> {
  const snapshot = await inspectRepository(context.github, repository);
  const detection = detectRepository(snapshot);
  const configObject = generateGuardianConfig(snapshot, detection, context.workflowSha);
  const override = context.overrides;
  if (override?.dockerfile && configObject.image) {
    if (!detection.dockerfiles.includes(override.dockerfile)) {
      throw new Error(`Requested Dockerfile was not detected: ${override.dockerfile}`);
    }
    configObject.image.dockerfile = override.dockerfile;
  }
  if (override?.healthPath && configObject.image) configObject.image.healthPath = override.healthPath;
  if (override?.readinessPath && configObject.image) configObject.image.readinessPath = override.readinessPath;
  if (override?.dastOrigin || override?.openapi || override?.authenticationProfile ||
      override?.sessionAssertionPath) {
    if (!override.dastOrigin || !override.openapi || !override.authenticationProfile ||
        !override.sessionAssertionPath) {
      throw new Error("DAST overrides require origin, OpenAPI, auth profile, and session assertion");
    }
    configObject.dast = {
      allowedOrigin: override.dastOrigin,
      openapi: override.openapi,
      authenticationProfile: override.authenticationProfile,
      sessionAssertionPath: override.sessionAssertionPath,
      excludedRoutes: []
    };
  }
  return {
    snapshot,
    detection,
    config: serializeGuardianConfig(configObject),
    workflow: generateCallerWorkflow({
      guardianRepository: context.guardianRepository,
      workflowSha: context.workflowSha,
      defaultBranch: snapshot.defaultBranch
    }),
    report: renderOnboardingReport(repository, detection)
  };
}

function branchName(prefix: string): string {
  return `guardianbot/${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export async function onboard(
  context: CommandContext,
  repository: string
): Promise<{ url?: string; generated: GeneratedOnboarding }> {
  const generated = await generateOnboarding(context, repository);
  if (context.dryRun) return { generated };
  const { owner, repo } = parseRepository(repository);
  const branch = branchName("onboard");
  await context.github.createBranch(owner, repo, branch, generated.snapshot.defaultBranch);
  await context.github.putFile(
    owner, repo, ".guardianbot/config.yml", branch,
    "chore(guardianbot): add repository configuration", generated.config
  );
  await context.github.putFile(
    owner, repo, ".github/workflows/guardianbot.yml", branch,
    "chore(guardianbot): add pinned security workflow", generated.workflow
  );
  await context.github.putFile(
    owner, repo, ".guardianbot/onboarding.md", branch,
    "docs(guardianbot): record onboarding detection", generated.report
  );
  const pull = await context.github.createPullRequest(owner, repo, {
    title: "chore: onboard GuardianBot security review",
    head: branch,
    base: generated.snapshot.defaultBranch,
    draft: true,
    body: generated.report
  });
  return { url: pull.html_url, generated };
}

export interface DoctorResult {
  status: "ready" | "advisory-only" | "misconfigured";
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function doctor(
  context: CommandContext,
  repository: string
): Promise<DoctorResult> {
  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const configFile = await context.github.getFile(owner, repo, ".guardianbot/config.yml", metadata.default_branch);
  const workflow = await context.github.getFile(owner, repo, ".github/workflows/guardianbot.yml", metadata.default_branch);
  const checks: DoctorResult["checks"] = [];
  if (!configFile) {
    checks.push({ name: "configuration", ok: false, detail: "not configured" });
  } else {
    try {
      const config = parseGuardianConfig(configFile.content);
      checks.push({ name: "configuration", ok: true, detail: `schema ${config.schemaVersion}` });
    } catch (error) {
      checks.push({ name: "configuration", ok: false, detail: String(error) });
    }
  }
  checks.push({
    name: "workflow",
    ok: Boolean(workflow?.content.includes(`@${context.workflowSha}`)),
    detail: workflow ? (workflow.content.includes(`@${context.workflowSha}`) ? "pin current" : "pin differs") : "not configured"
  });
  if (workflow) {
    try {
      const runs = await context.github.listWorkflowRuns(owner, repo, "guardianbot.yml");
      const latest = runs.workflow_runs[0];
      checks.push({
        name: "latest run",
        ok: Boolean(latest && latest.conclusion === "success"),
        detail: latest ? `${latest.status}/${latest.conclusion ?? "pending"}` : "missing expected run"
      });
    } catch (error) {
      checks.push({ name: "latest run", ok: false, detail: String(error) });
    }
  }
  const configured = Boolean(configFile && workflow);
  return {
    status: checks.every((check) => check.ok) ? "ready" : configured ? "misconfigured" : "advisory-only",
    checks
  };
}

export async function inventory(context: CommandContext) {
  const repositories = await context.github.listAuthenticatedRepositories();
  const rows = [];
  for (const repository of repositories) {
    if (repository.archived || repository.fork) continue;
    const config = await context.github.getFile(
      repository.owner.login, repository.name, ".guardianbot/config.yml", repository.default_branch
    );
    const workflow = await context.github.getFile(
      repository.owner.login, repository.name, ".github/workflows/guardianbot.yml", repository.default_branch
    );
    rows.push({
      repository: repository.full_name,
      status: config && workflow ? "report-only" : "advisory-only"
    });
  }
  return rows;
}

export async function upgrade(
  context: CommandContext,
  repository: string
): Promise<{ url?: string; changed: boolean }> {
  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const configFile = await context.github.getFile(owner, repo, ".guardianbot/config.yml", metadata.default_branch);
  const workflowFile = await context.github.getFile(owner, repo, ".github/workflows/guardianbot.yml", metadata.default_branch);
  if (!configFile || !workflowFile) throw new Error("Repository is not onboarded");
  if (workflowFile.content.includes(`@${context.workflowSha}`)) return { changed: false };
  const config = parseGuardianConfig(configFile.content);
  config.workflowVersion = context.workflowSha;
  const workflow = generateCallerWorkflow({
    guardianRepository: context.guardianRepository,
    workflowSha: context.workflowSha,
    defaultBranch: metadata.default_branch
  });
  if (context.dryRun) return { changed: true };
  const branch = branchName("upgrade");
  await context.github.createBranch(owner, repo, branch, metadata.default_branch);
  await context.github.putFile(owner, repo, ".guardianbot/config.yml", branch, "chore(guardianbot): upgrade schema and workflow", serializeGuardianConfig(config), configFile.sha);
  await context.github.putFile(owner, repo, ".github/workflows/guardianbot.yml", branch, "chore(guardianbot): upgrade pinned workflow", workflow, workflowFile.sha);
  const pull = await context.github.createPullRequest(owner, repo, {
    title: "chore: upgrade GuardianBot",
    head: branch,
    base: metadata.default_branch,
    draft: true,
    body: `Updates the immutable GuardianBot workflow pin to \`${context.workflowSha}\`.`
  });
  return { changed: true, url: pull.html_url };
}

export async function upgradeAll(
  context: CommandContext
): Promise<Array<{ repository: string; changed: boolean; url?: string; error?: string }>> {
  const repositories = await context.github.listAuthenticatedRepositories();
  const results: Array<{ repository: string; changed: boolean; url?: string; error?: string }> = [];
  for (const repository of repositories) {
    if (repository.archived || repository.fork) continue;
    const config = await context.github.getFile(
      repository.owner.login,
      repository.name,
      ".guardianbot/config.yml",
      repository.default_branch
    );
    if (!config) continue;
    try {
      const result = await upgrade(context, repository.full_name);
      results.push({ repository: repository.full_name, ...result });
    } catch (error) {
      results.push({
        repository: repository.full_name,
        changed: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

export async function enforce(
  context: CommandContext,
  repository: string
): Promise<{ dryRun: boolean; ruleset: unknown }> {
  const diagnosis = await doctor(context, repository);
  if (diagnosis.status !== "ready") throw new Error("Cannot enforce until guardianctl doctor is ready");
  const { owner, repo } = parseRepository(repository);
  const body = {
    name: "GuardianBot security gate",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "guardianbot/security-gate" }]
      }
    }]
  };
  if (!context.dryRun) await context.github.request("POST", `/repos/${owner}/${repo}/rulesets`, body);
  return { dryRun: Boolean(context.dryRun), ruleset: body };
}

export async function offboard(
  context: CommandContext,
  repository: string
): Promise<{ url?: string; changed: boolean }> {
  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const paths = [".guardianbot/config.yml", ".guardianbot/onboarding.md", ".github/workflows/guardianbot.yml"];
  const files = (await Promise.all(paths.map((path) => context.github.getFile(owner, repo, path, metadata.default_branch))))
    .map((file, index) => ({ file, path: paths[index]! })).filter((entry) => entry.file);
  if (!files.length) return { changed: false };
  if (context.dryRun) return { changed: true };
  const branch = branchName("offboard");
  await context.github.createBranch(owner, repo, branch, metadata.default_branch);
  for (const entry of files) {
    await context.github.deleteFile(owner, repo, entry.path, branch, "chore(guardianbot): remove repository caller", entry.file!.sha);
  }
  const pull = await context.github.createPullRequest(owner, repo, {
    title: "chore: offboard GuardianBot",
    head: branch,
    base: metadata.default_branch,
    draft: true,
    body: "Removes repository-side GuardianBot callers. Retained audit evidence is not deleted."
  });
  return { changed: true, url: pull.html_url };
}
