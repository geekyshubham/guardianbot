import { createHash } from "node:crypto";
import {
  GitHubClient,
  detectRepository,
  generateCallerWorkflow,
  generateGuardianConfig,
  parseGuardianConfig,
  parseGuardianConfigDocument,
  renderOnboardingReport,
  serializeGuardianConfig,
  validateGuardianConfig,
  type DetectionResult,
  type GuardianConfig,
  type GitHubRepository,
  type RepositorySnapshot,
  type ScannerMode
} from "@guardianbot/core";

export const CONFIG_PATH = ".guardianbot/config.yml";
export const BASELINE_PATH = ".guardianbot/baseline.json";
export const ONBOARDING_REPORT_PATH = ".guardianbot/onboarding.md";
export const CALLER_WORKFLOW_PATH = ".github/workflows/guardianbot.yml";
export const CALLER_WORKFLOW_NAME = "guardianbot.yml";
export const SECURITY_GATE_PREFIX = "guardianbot/security-gate";
export const DEFAULT_SECURITY_GATE_CHECK =
  "guardianbot/security-gate / deterministic scanners";
export const DEFAULT_EXPECTED_RUN_MAX_AGE_HOURS = 36;
export const DEFAULT_REPORT_ONLY_MINIMUM_DAYS = 7;
export const BASELINE_SCHEMA_VERSION = "guardianbot.baseline.v1" as const;

const IMMUTABLE_SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT_SHA256 = /^[a-f0-9]{64}$/;
const MAX_WORKFLOW_RUN_PAGES = 10;
/** Shared page cap for Actions job and commit check-run listings (100 items/page). */
const MAX_EVIDENCE_PAGES = MAX_WORKFLOW_RUN_PAGES;
const MAX_GATE_JSON_BYTES = 1_048_576;
const MAX_POLICY_FINDINGS = 500;

/** CLI placeholder when GUARDIANBOT_WORKFLOW_SHA is unset; never a valid pin or upgrade target. */
export const PLACEHOLDER_WORKFLOW_SHA = "0".repeat(40);

export interface CommandContext {
  github: GitHubClient;
  guardianRepository: string;
  workflowSha: string;
  dryRun?: boolean;
  guardianAppSlug?: string;
  expectedRunMaxAgeHours?: number;
  reportOnlyMinimumDays?: number;
  now?: () => Date;
  overrides?: {
    dockerfile?: string;
    healthPath?: string;
    readinessPath?: string;
    imagePromotion?: "enforce-only" | "verified-default-branch";
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

function applyConfigurationOverrides(
  config: GuardianConfig,
  override: CommandContext["overrides"]
): void {
  if (!override) return;
  if (override.dockerfile) {
    if (!config.image) {
      throw new Error("Dockerfile override requires configured image coverage");
    }
    config.image.dockerfile = override.dockerfile;
  }
  if (override.healthPath) {
    if (!config.image) {
      throw new Error("health-path override requires configured image coverage");
    }
    config.image.healthPath = override.healthPath;
  }
  if (override.readinessPath) {
    if (!config.image) {
      throw new Error("readiness-path override requires configured image coverage");
    }
    config.image.readinessPath = override.readinessPath;
  }
  if (override.imagePromotion) {
    if (!config.image?.deployment) {
      throw new Error("image-promotion override requires configured image deployment");
    }
    if (
      override.imagePromotion !== "enforce-only" &&
      override.imagePromotion !== "verified-default-branch"
    ) {
      throw new Error(
        "image-promotion must be enforce-only or verified-default-branch"
      );
    }
    config.image.deployment.promotionMode = override.imagePromotion;
  }
  if (
    override.dastOrigin ||
    override.openapi ||
    override.authenticationProfile ||
    override.sessionAssertionPath
  ) {
    if (
      !override.dastOrigin ||
      !override.openapi ||
      !override.authenticationProfile ||
      !override.sessionAssertionPath
    ) {
      throw new Error("DAST overrides require origin, OpenAPI, auth profile, and session assertion");
    }
    config.dast = {
      allowedOrigin: override.dastOrigin,
      allowedOrigins: [override.dastOrigin],
      openapi: override.openapi,
      openapiSource:
        override.openapi.startsWith("/") || /^https:/i.test(override.openapi)
          ? "live-endpoint"
          : "repository-file",
      authenticationProfile: override.authenticationProfile,
      sessionAssertionPath: override.sessionAssertionPath,
      profiles: {
        deploySmoke: "authenticated-baseline",
        nightly: "authenticated-full"
      },
      excludedRoutes: []
    };
  }
}

export type DoctorCheckState =
  | "ok"
  | "missing"
  | "stale"
  | "failed"
  | "not-applicable"
  | "unobservable";

export interface DoctorCheck {
  name: string;
  code: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
  state: DoctorCheckState;
}

export interface DoctorFacts {
  scannerMode?: ScannerMode;
  appAccess: "installed" | "missing" | "suspended" | "unobservable" | "error";
  latestRunAt?: string;
  latestRunId?: number;
  latestRunHeadSha?: string;
  managedConfigurationChangedAt?: string;
  securityGateCheck?: string;
  baselineCount?: number;
  reportOnlySince?: string;
  reportOnlyAgeDays?: number;
  requiredCheckName: string;
  rulesetId?: number;
  rulesetReady: boolean;
}

export interface DoctorResult {
  status: "ready" | "advisory-only" | "misconfigured";
  enforcementReady: boolean;
  checks: DoctorCheck[];
  facts: DoctorFacts;
}

export type InventoryStatus =
  | "enforced"
  | "report-only"
  | "advisory-only"
  | "not-applicable"
  | "misconfigured"
  | "missing-expected-runs";

export interface InventoryRow {
  repository: string;
  status: InventoryStatus;
  scannerMode?: ScannerMode;
  detail: string;
}

interface WorkflowRun {
  id?: number;
  status: string;
  conclusion: string | null;
  html_url?: string;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
}

interface WorkflowRunsResult {
  workflow_runs: WorkflowRun[];
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string;
  html_url?: string;
}

interface WorkflowJob {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

interface GateEvidence {
  name: string;
  status: string;
  conclusion: string | null;
  run: WorkflowRun;
  skipped: boolean;
}

interface CommitSummary {
  sha: string;
  commit?: {
    author?: { date?: string };
    committer?: { date?: string };
  };
}

interface Ruleset {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: {
    ref_name?: {
      include?: string[];
      exclude?: string[];
    };
  };
  rules?: Array<{
    type: string;
    parameters?: {
      strict_required_status_checks_policy?: boolean;
      required_status_checks?: Array<{ context?: string }>;
    };
  }>;
}

interface RulesetInspection {
  observable: boolean;
  ready: boolean;
  ownedRulesetId?: number;
  ownedRulesetActive?: boolean;
  contexts: string[];
  detail: string;
}

interface AppAccessInspection {
  state: DoctorFacts["appAccess"];
  detail: string;
}

interface UserInstallation {
  id: number;
  app_slug?: string;
  suspended_at?: string | null;
}

interface UserInstallationInventory {
  installations: UserInstallation[];
  repositories: Map<number, Set<string>>;
}

interface DiagnosticOptions {
  allowConfiguredWorkflowSha?: boolean;
}

export interface BaselineInspection {
  ready: boolean;
  count?: number;
  detail: string;
}

export interface BaselineSourceProvenance {
  gateSha256: string;
  mode: "report-only";
  repository: string;
  headSha: string;
  runId: number;
  runAttempt: number;
}

export interface BaselineDocument {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  fingerprints: string[];
  generatedAt: string;
  source: BaselineSourceProvenance;
}

export interface BaselineResult {
  dryRun: boolean;
  changed: boolean;
  url?: string;
  baseline: BaselineDocument;
  baselineJson: string;
  fingerprintCount: number;
  clean: boolean;
  gateSha256: string;
  report: string;
}

interface RunInspection {
  runs: WorkflowRun[];
  latestCompleted?: WorkflowRun;
  check: DoctorCheck;
}

interface GateCheckInspection {
  name?: string;
  check: DoctorCheck;
  evidenceRun?: WorkflowRun;
}

const appInventoryCache = new WeakMap<
  GitHubClient,
  Map<string, Promise<UserInstallationInventory | undefined>>
>();

function makeCheck(
  code: string,
  name: string,
  ok: boolean,
  detail: string,
  options: {
    blocking?: boolean;
    state?: DoctorCheckState;
  } = {}
): DoctorCheck {
  return {
    name,
    code,
    ok,
    detail,
    blocking: options.blocking ?? true,
    state: options.state ?? (ok ? "ok" : "failed")
  };
}

function currentTime(context: CommandContext): Date {
  return context.now?.() ?? new Date();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function githubErrorStatus(error: unknown): number | undefined {
  const match = /returned\s+(\d{3})(?::|\s|$)/i.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isImmutableWorkflowSha(value: string): boolean {
  // Reject the all-zero CLI placeholder so inventory/upgrade never treat it as a pin.
  return IMMUTABLE_SHA.test(value) && value !== PLACEHOLDER_WORKFLOW_SHA;
}

export function assertImmutableWorkflowSha(value: string): void {
  if (!isImmutableWorkflowSha(value)) {
    throw new Error(
      "workflowSha must be an immutable 40-character lowercase hexadecimal commit SHA"
    );
  }
}

/**
 * When inventory has no administrative target SHA, derive the expected pin from
 * the repository's own validated config or consistent caller references.
 */
function deriveConfiguredWorkflowSha(
  guardianRepository: string,
  parsedConfig: GuardianConfig | undefined,
  workflowContent: string | undefined
): string | undefined {
  if (parsedConfig && isImmutableWorkflowSha(parsedConfig.workflowVersion)) {
    return parsedConfig.workflowVersion;
  }
  if (!workflowContent) return undefined;
  const pins = managedWorkflowPins(workflowContent, guardianRepository);
  if (
    pins.length > 0 &&
    pins.every((pin) => pin === pins[0] && isImmutableWorkflowSha(pin))
  ) {
    return pins[0];
  }
  return undefined;
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
  const manifests = files.filter((path) =>
    /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|pyproject\.toml|requirements[^/]*\.(?:txt|lock)|poetry\.lock|Pipfile(?:\.lock)?|uv\.lock|pdm\.lock|Package\.swift|Package\.resolved|Gemfile(?:\.lock)?|Rakefile|[^/]+\.gemspec|CODEOWNERS|Dockerfile(?:\.[^/]*)?|Containerfile(?:\.[^/]*)?|docker-compose[^/]*\.ya?ml)$/i.test(path)
  );
  const operational = files.filter((path) =>
    /(?:^|\/)(?:\.github\/workflows\/[^/]+|[^/]*(?:url|route|health|ready|schema|openapi|swagger|deploy|migration)[^/]*)\.(?:ya?ml|json|toml|py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|swift|rb|rake)$/i.test(path)
  );
  const documentation = files.filter((path) =>
    /(^|\/)(?:README|CONTRIBUTING|SECURITY|ARCHITECTURE)(?:\.[^/]+)?$/i.test(path)
  );
  const source = files.filter((path) =>
    /\.(?:ya?ml|json|toml|py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|swift|rb|rake|md|mdx)$/i.test(path)
  );
  const candidates = [
    ...new Set([...manifests, ...operational, ...documentation, ...source])
  ].slice(0, 220);
  const fileContents: Record<string, string> = {};
  let nextCandidate = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, Math.max(1, candidates.length)) }, async () => {
      while (true) {
        const index = nextCandidate;
        nextCandidate += 1;
        if (index >= candidates.length) return;
        const path = candidates[index]!;
        const file = await github.getFile(owner, repo, path, metadata.default_branch);
        if (file && file.content.length <= 250_000) fileContents[path] = file.content;
      }
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

function renderConfigurationCoverage(config: GuardianConfig, detection: DetectionResult): string {
  const values = (entries: string[] | undefined) =>
    entries?.length ? entries.map((entry) => `\`${entry}\``).join(", ") : "none detected";
  const imageCoverage = config.image
    ? `configured from \`${config.image.dockerfile}\` for ${config.image.platform}; GHCR, runtime smoke, CycloneDX SBOM, keyless signing, and immutable-digest promotion policy are declared`
    : "not applicable (no container definition detected)";
  const dastCoverage = config.dast
    ? `configured for the exact allowlisted origin \`${config.dast.allowedOrigin}\``
    : detection.openapi.length
      ? `available but not configured; detected OpenAPI: ${values(detection.openapi)}`
      : "not applicable until an exact staging origin and safe OpenAPI source are supplied";

  return [
    "## Generated reusable configuration",
    "",
    `- Languages: ${values(config.repository.languages)}`,
    `- Package managers: ${values(config.repository.packageManagers)}`,
    `- Lockfiles: ${values(config.repository.lockfiles)}`,
    `- Source paths: ${values(config.paths?.source)}`,
    `- Test paths: ${values(config.paths?.test)}`,
    `- Generated paths: ${values(config.paths?.generated)}`,
    `- Vendored paths: ${values(config.paths?.vendored)}`,
    `- Excluded paths: ${values(config.paths?.excluded)}`,
    `- Command execution boundary: \`${config.runner?.executionEnvironment ?? "not configured"}\``,
    `- Test commands: ${values(config.runner?.testCommands)}`,
    `- Build commands: ${values(config.runner?.buildCommands)}`,
    `- Image coverage: ${imageCoverage}`,
    `- DAST coverage: ${dastCoverage}`,
    "",
    detection.documentationOnly
      ? "This is a documentation-only repository; deterministic source scans remain advisory."
      : "Detected commands are declarations executed only by the pinned reusable workflow on GitHub-hosted or ephemeral runners.",
    "",
    "No model credentials, scanner credentials, deployment credentials, backend URLs, or shared secrets are written to this repository."
  ].join("\n");
}

export async function generateOnboarding(
  context: CommandContext,
  repository: string
): Promise<GeneratedOnboarding> {
  assertImmutableWorkflowSha(context.workflowSha);
  const snapshot = await inspectRepository(context.github, repository);
  const detection = detectRepository(snapshot);
  const override = context.overrides;
  if (override?.dockerfile) {
    if (!detection.dockerfiles.includes(override.dockerfile)) {
      throw new Error(`Requested Dockerfile was not detected: ${override.dockerfile}`);
    }
    detection.preferredDockerfile = override.dockerfile;
  }
  const configObject = generateGuardianConfig(snapshot, detection, context.workflowSha);
  applyConfigurationOverrides(configObject, {
    ...override,
    dockerfile: undefined
  });
  const configurationErrors = validateGuardianConfig(configObject);
  if (configurationErrors.length) {
    throw new Error(
      `Generated GuardianBot configuration is invalid:\n${configurationErrors.join("\n")}`
    );
  }
  const report = [
    renderOnboardingReport(repository, detection, configObject.scanners.mode).trimEnd(),
    renderConfigurationCoverage(configObject, detection)
  ].join("\n\n");
  return {
    snapshot,
    detection,
    config: serializeGuardianConfig(configObject),
    workflow: generateCallerWorkflow({
      guardianRepository: context.guardianRepository,
      workflowSha: context.workflowSha,
      defaultBranch: snapshot.defaultBranch,
      scannerMode: configObject.scanners.mode,
      image: configObject.image,
      dast: configObject.dast
    }),
    report
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
    owner,
    repo,
    CONFIG_PATH,
    branch,
    "chore(guardianbot): add repository configuration",
    generated.config
  );
  await context.github.putFile(
    owner,
    repo,
    CALLER_WORKFLOW_PATH,
    branch,
    "chore(guardianbot): add pinned security workflow",
    generated.workflow
  );
  await context.github.putFile(
    owner,
    repo,
    ONBOARDING_REPORT_PATH,
    branch,
    "docs(guardianbot): record onboarding detection",
    generated.report
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

export function callerWorkflowMatches(actual: string, expected: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/\r\n/g, "\n")
      .replace(
        /^(\s*uses:\s+)([^/\s]+\/[^/\s]+)(\/\.github\/workflows\/)/gim,
        (_match, prefix: string, repository: string, suffix: string) =>
          `${prefix}${repository.toLowerCase()}${suffix}`
      )
      .trimEnd();
  return normalize(actual) === normalize(expected);
}

function managedWorkflowPins(source: string, guardianRepository: string): string[] {
  const repository = guardianRepository.toLowerCase();
  return [...source.matchAll(/^\s*uses:\s+([^\s@]+)@([^\s#]+)\s*$/gim)]
    .filter((match) => {
      const target = match[1]!.toLowerCase();
      return (
        target.startsWith(`${repository}/.github/workflows/reusable-`) &&
        target.endsWith(".yml")
      );
    })
    .map((match) => match[2]!);
}

function isGateCheckName(value: string): boolean {
  return value === SECURITY_GATE_PREFIX || value.startsWith(`${SECURITY_GATE_PREFIX} / `);
}

function workflowRunTime(run: WorkflowRun): Date | undefined {
  const value = run.run_started_at ?? run.created_at ?? run.updated_at;
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function workflowRunIsExpected(run: WorkflowRun, defaultBranch: string): boolean {
  if (run.head_branch && run.head_branch !== defaultBranch) return false;
  return !run.event || ["push", "schedule", "workflow_dispatch"].includes(run.event);
}

function actionsRunIdFromUrl(value?: string | null): number | undefined {
  if (!value) return undefined;
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(value);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function pickSecurityGateJob(jobs: WorkflowJob[]): WorkflowJob | undefined {
  const gates = jobs.filter((job) => isGateCheckName(job.name));
  if (!gates.length) return undefined;
  const active = gates.filter((job) => job.conclusion !== "skipped");
  const pool = active.length ? active : gates;
  const nested = pool.filter((job) => job.name.includes(" / "));
  return nested[0] ?? pool[0];
}

function pickSecurityGateCheck(checks: CheckRun[]): CheckRun | undefined {
  const gates = checks.filter((check) => isGateCheckName(check.name));
  if (!gates.length) return undefined;
  const active = gates.filter((check) => check.conclusion !== "skipped");
  const pool = active.length ? active : gates;
  const nested = pool.filter((check) => check.name.includes(" / "));
  return nested[0] ?? pool[0];
}

function gateEvidenceFromJob(run: WorkflowRun, job: WorkflowJob): GateEvidence {
  return {
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    run,
    skipped: job.conclusion === "skipped"
  };
}

function gateEvidenceFromCheck(run: WorkflowRun, check: CheckRun): GateEvidence {
  return {
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    run,
    skipped: check.conclusion === "skipped"
  };
}

/** Push and manual dispatch always attempt the security gate; schedules may be DAST-only. */
function isAlwaysSecurityEvent(event?: string): boolean {
  return event === "push" || event === "workflow_dispatch";
}

async function loadWorkflowRuns(
  github: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  lowerBound?: Date
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page += 1) {
    const result = await github.request<WorkflowRunsResult>(
      "GET",
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
        CALLER_WORKFLOW_NAME
      )}/runs?branch=${encodeURIComponent(defaultBranch)}&per_page=100&page=${page}`
    );
    const batch = result.workflow_runs ?? [];
    runs.push(...batch.filter((run) => workflowRunIsExpected(run, defaultBranch)));
    if (batch.length < 100) break;
    if (lowerBound) {
      const dated = batch
        .map(workflowRunTime)
        .filter((value): value is Date => Boolean(value));
      if (dated.length && Math.min(...dated.map((value) => value.getTime())) <= lowerBound.getTime()) {
        break;
      }
    }
  }
  return runs.sort(
    (left, right) =>
      (workflowRunTime(right)?.getTime() ?? 0) - (workflowRunTime(left)?.getTime() ?? 0)
  );
}

function inspectLatestRun(
  context: CommandContext,
  runs: WorkflowRun[],
  requiredAfter?: Date,
  managedChangeError?: string
): RunInspection {
  const latestRelevant = runs[0];
  const latestCompleted = runs.find((run) => run.status === "completed");
  if (!latestRelevant) {
    return {
      runs,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        "missing expected default-branch push, schedule, or workflow-dispatch run",
        { state: "missing" }
      )
    };
  }
  if (!latestCompleted) {
    return {
      runs,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        `no completed expected run; latest is ${latestRelevant.status}`,
        { state: "failed" }
      )
    };
  }
  const completedAt = workflowRunTime(latestCompleted);
  if (!completedAt) {
    return {
      runs,
      latestCompleted,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        "latest completed run has no usable timestamp; freshness cannot be verified",
        { state: "stale" }
      )
    };
  }
  if (managedChangeError) {
    return {
      runs,
      latestCompleted,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        `managed caller/configuration change time is not observable: ${managedChangeError}`,
        { state: "failed" }
      )
    };
  }
  if (!requiredAfter) {
    return {
      runs,
      latestCompleted,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        "managed caller/configuration commit time is missing",
        { state: "missing" }
      )
    };
  }
  if (completedAt.getTime() < requiredAfter.getTime()) {
    return {
      runs,
      latestCompleted,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        `latest completed run ${completedAt.toISOString()} predates managed caller/configuration change ${requiredAfter.toISOString()}`,
        { state: "stale" }
      )
    };
  }
  const maxAgeHours =
    context.expectedRunMaxAgeHours ?? DEFAULT_EXPECTED_RUN_MAX_AGE_HOURS;
  const ageHours = (currentTime(context).getTime() - completedAt.getTime()) / 3_600_000;
  if (ageHours < -0.25) {
    return {
      runs,
      latestCompleted,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        `latest completed run timestamp is ${Math.abs(ageHours).toFixed(1)} hours in the future`,
        { state: "failed" }
      )
    };
  }
  if (ageHours > maxAgeHours) {
    return {
      runs,
      latestCompleted,
      check: makeCheck(
        "expected-run",
        "latest expected run",
        false,
        `latest completed run is ${ageHours.toFixed(1)} hours old; maximum is ${maxAgeHours}`,
        { state: "stale" }
      )
    };
  }
  const succeeded = latestCompleted.conclusion === "success";
  const newerActive =
    latestRelevant !== latestCompleted && latestRelevant.status !== "completed"
      ? `; newer run is ${latestRelevant.status}`
      : "";
  return {
    runs,
    latestCompleted,
    check: makeCheck(
      "expected-run",
      "latest expected run",
      succeeded,
      `${completedAt.toISOString()} (${ageHours.toFixed(1)} hours old), ${latestCompleted.status}/${
        latestCompleted.conclusion ?? "pending"
      }${newerActive}`,
      { state: succeeded ? "ok" : "failed" }
    )
  };
}

async function loadWorkflowJobs(
  github: GitHubClient,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowJob[]> {
  const jobs: WorkflowJob[] = [];
  for (let page = 1; page <= MAX_EVIDENCE_PAGES; page += 1) {
    const response = await github.request<{ jobs?: WorkflowJob[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`
    );
    const batch = response.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
  throw new Error(
    `workflow job listing for run ${runId} exceeded ${MAX_EVIDENCE_PAGES} pages; fail closed`
  );
}

async function loadCommitCheckRuns(
  github: GitHubClient,
  owner: string,
  repo: string,
  headSha: string
): Promise<CheckRun[]> {
  const checkRuns: CheckRun[] = [];
  for (let page = 1; page <= MAX_EVIDENCE_PAGES; page += 1) {
    const response = await github.request<{ check_runs: CheckRun[] }>(
      "GET",
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(
        headSha
      )}/check-runs?filter=all&per_page=100&page=${page}`
    );
    const batch = response.check_runs ?? [];
    checkRuns.push(...batch);
    if (batch.length < 100) return checkRuns;
  }
  throw new Error(
    `check-run listing for ${headSha.slice(0, 12)} exceeded ${MAX_EVIDENCE_PAGES} pages; fail closed`
  );
}

/**
 * Resolve security-gate evidence for a specific Actions run using job metadata
 * first, then check-run URLs that reference that run id. Same-SHA checks from
 * other runs are never accepted without that provenance.
 */
async function loadGateEvidenceForRun(
  github: GitHubClient,
  owner: string,
  repo: string,
  run: WorkflowRun
): Promise<GateEvidence | null> {
  if (!run.id) return null;

  try {
    const jobs = await loadWorkflowJobs(github, owner, repo, run.id);
    const job = pickSecurityGateJob(jobs);
    if (job) return gateEvidenceFromJob(run, job);
    // Non-empty job list without a security-gate job is definitive for this run
    // (for example DAST-only schedules that omit the skipped caller job record).
    if (jobs.length > 0) return null;
  } catch (error) {
    const status = githubErrorStatus(error);
    if (!status || ![403, 404].includes(status)) throw error;
  }

  // Fallback when jobs are unavailable or empty: associate check runs only via
  // Actions URLs that include this run id. Never accept same-SHA checks from
  // other runs without that provenance.
  if (!run.head_sha) return null;
  try {
    const checkRuns = await loadCommitCheckRuns(github, owner, repo, run.head_sha);
    const associated = checkRuns.filter(
      (check) =>
        isGateCheckName(check.name) &&
        (actionsRunIdFromUrl(check.details_url) === run.id ||
          actionsRunIdFromUrl(check.html_url) === run.id)
    );
    const gate = pickSecurityGateCheck(associated);
    if (gate) return gateEvidenceFromCheck(run, gate);
  } catch (error) {
    const status = githubErrorStatus(error);
    if (!status || ![403, 404].includes(status)) throw error;
  }

  return null;
}

async function inspectGateCheck(
  context: CommandContext,
  github: GitHubClient,
  owner: string,
  repo: string,
  runs: WorkflowRun[],
  requiredAfter?: Date,
  managedChangeError?: string
): Promise<GateCheckInspection> {
  if (managedChangeError) {
    return {
      check: makeCheck(
        "security-gate-check",
        "security gate check",
        false,
        `managed caller/configuration change time is not observable: ${managedChangeError}`,
        { state: "failed" }
      )
    };
  }
  if (!requiredAfter) {
    return {
      check: makeCheck(
        "security-gate-check",
        "security gate check",
        false,
        "managed caller/configuration commit time is missing",
        { state: "missing" }
      )
    };
  }

  const maxAgeHours =
    context.expectedRunMaxAgeHours ?? DEFAULT_EXPECTED_RUN_MAX_AGE_HOURS;
  const now = currentTime(context);
  let sawCompletedInWindow = false;
  let sawStaleQualifyingCandidate = false;

  try {
    for (const run of runs) {
      if (run.status !== "completed") continue;
      const completedAt = workflowRunTime(run);
      if (!completedAt) {
        return {
          check: makeCheck(
            "security-gate-check",
            "security gate check",
            false,
            "completed run has no usable timestamp; security-gate freshness cannot be verified",
            { state: "stale" }
          )
        };
      }
      if (completedAt.getTime() < requiredAfter.getTime()) {
        // Remaining runs are older (list is newest-first).
        break;
      }
      const ageHours = (now.getTime() - completedAt.getTime()) / 3_600_000;
      if (ageHours < -0.25) {
        return {
          check: makeCheck(
            "security-gate-check",
            "security gate check",
            false,
            `security-gate run timestamp is ${Math.abs(ageHours).toFixed(1)} hours in the future`,
            { state: "failed" }
          )
        };
      }
      if (ageHours > maxAgeHours) {
        sawStaleQualifyingCandidate = true;
        // Older runs are staler; stop scanning.
        break;
      }
      sawCompletedInWindow = true;

      const evidence = await loadGateEvidenceForRun(github, owner, repo, run);
      // Only schedules may omit or skip the gate (generated DAST-only crons).
      // Push and workflow_dispatch always attempt it; missing/skipped fails closed
      // so a newer non-security event cannot hide behind an older success.
      if (!evidence || evidence.skipped) {
        if (!isAlwaysSecurityEvent(run.event)) continue;
        if (!evidence) {
          return {
            evidenceRun: run,
            check: makeCheck(
              "security-gate-check",
              "security gate check",
              false,
              `${run.event} run ${run.id ?? "unknown"} has no ${SECURITY_GATE_PREFIX} evidence`,
              { state: "missing" }
            )
          };
        }
        return {
          name: evidence.name,
          evidenceRun: evidence.run,
          check: makeCheck(
            "security-gate-check",
            "security gate check",
            false,
            `${evidence.name}: ${evidence.status}/${evidence.conclusion ?? "pending"} (run ${
              evidence.run.id ?? "unknown"
            }); ${run.event} runs must not skip the security gate`,
            { state: "failed" }
          )
        };
      }

      // Non-skipped gate on any event (including schedule) is security evidence.
      const ok =
        evidence.status === "completed" && evidence.conclusion === "success";
      return {
        name: evidence.name,
        evidenceRun: evidence.run,
        check: makeCheck(
          "security-gate-check",
          "security gate check",
          ok,
          `${evidence.name}: ${evidence.status}/${evidence.conclusion ?? "pending"} (run ${
            evidence.run.id ?? "unknown"
          })`,
          { state: ok ? "ok" : "failed" }
        )
      };
    }
  } catch (error) {
    return {
      check: makeCheck(
        "security-gate-check",
        "security gate check",
        false,
        errorMessage(error),
        { state: githubErrorStatus(error) === 404 ? "missing" : "failed" }
      )
    };
  }

  if (sawStaleQualifyingCandidate && !sawCompletedInWindow) {
    return {
      check: makeCheck(
        "security-gate-check",
        "security gate check",
        false,
        `no ${SECURITY_GATE_PREFIX} evidence within ${maxAgeHours} hours; DAST-only or skipped gates are ignored`,
        { state: "stale" }
      )
    };
  }

  return {
    check: makeCheck(
      "security-gate-check",
      "security gate check",
      false,
      sawCompletedInWindow
        ? `no ${SECURITY_GATE_PREFIX} evidence from a qualifying security run in the freshness window; DAST-only or skipped gates are ignored`
        : `no completed expected run can supply ${SECURITY_GATE_PREFIX} evidence`,
      { state: "missing" }
    )
  };
}

async function loadUserInstallationInventory(
  github: GitHubClient,
  appSlug: string
): Promise<UserInstallationInventory | undefined> {
  let bySlug = appInventoryCache.get(github);
  if (!bySlug) {
    bySlug = new Map();
    appInventoryCache.set(github, bySlug);
  }
  const key = appSlug.toLowerCase();
  const existing = bySlug.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const installations: UserInstallation[] = [];
      for (let page = 1; ; page += 1) {
        const response = await github.request<
          { installations?: UserInstallation[] } | UserInstallation[]
        >("GET", `/user/installations?per_page=100&page=${page}`);
        const batch = Array.isArray(response) ? response : response.installations ?? [];
        installations.push(...batch.filter((installation) =>
          installation.app_slug?.toLowerCase() === key
        ));
        if (batch.length < 100) break;
      }
      const repositories = new Map<number, Set<string>>();
      for (const installation of installations) {
        const names = new Set<string>();
        for (let page = 1; ; page += 1) {
          const response = await github.request<
            { repositories?: GitHubRepository[] } | GitHubRepository[]
          >(
            "GET",
            `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`
          );
          const batch = Array.isArray(response) ? response : response.repositories ?? [];
          for (const repository of batch) names.add(repository.full_name.toLowerCase());
          if (batch.length < 100) break;
        }
        repositories.set(installation.id, names);
      }
      return { installations, repositories };
    } catch (error) {
      const status = githubErrorStatus(error);
      if (status && [401, 403, 404].includes(status)) return undefined;
      throw error;
    }
  })();
  bySlug.set(key, promise);
  return promise;
}

async function inspectAppAccess(
  context: CommandContext,
  owner: string,
  repo: string
): Promise<AppAccessInspection> {
  const appSlug =
    context.guardianAppSlug ?? parseRepository(context.guardianRepository).repo.toLowerCase();
  try {
    const inventory = await loadUserInstallationInventory(context.github, appSlug);
    if (inventory) {
      const fullName = `${owner}/${repo}`.toLowerCase();
      const installations = inventory.installations.filter((installation) =>
        inventory.repositories.get(installation.id)?.has(fullName)
      );
      if (!installations.length) {
        return {
          state: "missing",
          detail: `operator API can observe ${appSlug}, but it has no access to ${owner}/${repo}`
        };
      }
      if (installations.every((installation) => Boolean(installation.suspended_at))) {
        return {
          state: "suspended",
          detail: `GuardianBot App access is suspended for ${owner}/${repo}`
        };
      }
      return {
        state: "installed",
        detail: `GuardianBot App access observed through installation ${installations[0]!.id}`
      };
    }
    try {
      const installation = await context.github.request<{
        id: number;
        app_slug?: string;
        suspended_at?: string | null;
      }>("GET", `/repos/${owner}/${repo}/installation`);
      if (
        installation.app_slug &&
        installation.app_slug.toLowerCase() !== appSlug.toLowerCase()
      ) {
        return {
          state: "missing",
          detail: `observable repository installation belongs to ${installation.app_slug}, not ${appSlug}`
        };
      }
      if (installation.suspended_at) {
        return {
          state: "suspended",
          detail: `GuardianBot App installation ${installation.id} is suspended`
        };
      }
      return {
        state: "installed",
        detail: `GuardianBot App access observed through installation ${installation.id}`
      };
    } catch (error) {
      const status = githubErrorStatus(error);
      if (status && [401, 403, 404].includes(status)) {
        return {
          state: "unobservable",
          detail:
            "App installation access is not observable with this operator token; repository access was verified"
        };
      }
      throw error;
    }
  } catch (error) {
    return {
      state: "error",
      detail: `App access check failed: ${errorMessage(error)}`
    };
  }
}

function inspectRepositoryConfiguration(
  config: GuardianConfig,
  metadata: GitHubRepository,
  now: Date
): DoctorCheck {
  const problems: string[] = [];
  if (config.repository.defaultBranch !== metadata.default_branch) {
    problems.push(
      `configured default branch ${config.repository.defaultBranch} differs from ${metadata.default_branch}`
    );
  }
  if (!config.repository.releaseBranches.includes(metadata.default_branch)) {
    problems.push(`releaseBranches does not include ${metadata.default_branch}`);
  }
  if (
    config.review.targetBranches?.length &&
    !config.review.targetBranches.includes(metadata.default_branch)
  ) {
    problems.push(`review.targetBranches does not include ${metadata.default_branch}`);
  }
  if (
    config.paths &&
    config.review.excludedPaths &&
    config.paths.excluded.join("\0") !== config.review.excludedPaths.join("\0")
  ) {
    problems.push("paths.excluded and review.excludedPaths differ");
  }
  if (
    config.scanners.mode !== "advisory" &&
    !config.scanners.semgrep &&
    !config.scanners.trivy
  ) {
    problems.push(`${config.scanners.mode} mode has no enabled deterministic scanner`);
  }
  for (const suppression of config.scanners.suppressions ?? []) {
    const expiresAt = new Date(suppression.expiresAt);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
      problems.push(`suppression ${suppression.fingerprint} expired at ${suppression.expiresAt}`);
    }
  }
  return makeCheck(
    "repository-configuration",
    "repository configuration",
    problems.length === 0,
    problems.length
      ? problems.join("; ")
      : "default/release/review branches, paths, and scanner mode are consistent"
  );
}

async function inspectImageConfiguration(
  github: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  image: GuardianConfig["image"]
): Promise<DoctorCheck> {
  if (!image) {
    return makeCheck(
      "image-configuration",
      "image configuration",
      true,
      "not configured",
      { blocking: false, state: "not-applicable" }
    );
  }
  const problems: string[] = [];
  const validRequestPath = (value: string) => /^\/(?!\/)[^\s?#]*(?:\?[^#\s]*)?$/.test(value);
  const safeRepositoryPath = (value: string) =>
    Boolean(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((segment) => segment === "..");
  if (!safeRepositoryPath(image.dockerfile)) {
    problems.push("dockerfile must be a repository-relative path without ..");
  }
  if (image.context !== "." && !safeRepositoryPath(image.context)) {
    problems.push("context must be . or a repository-relative path without ..");
  }
  if (image.platform !== "linux/amd64") {
    problems.push(`platform ${image.platform} is unsupported; expected linux/amd64`);
  }
  if (!validRequestPath(image.healthPath)) {
    problems.push("healthPath must be an origin-relative path");
  }
  if (image.readinessPath && !validRequestPath(image.readinessPath)) {
    problems.push("readinessPath must be an origin-relative path");
  }
  if (!/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/.test(image.registry)) {
    problems.push("registry must be a lowercase GHCR repository path");
  }
  if (
    image.ports?.length &&
    image.containerPort &&
    !image.ports.some((port) => port.containerPort === image.containerPort)
  ) {
    problems.push("containerPort must be represented in image.ports");
  }
  if (image.signing) {
    if (image.signing.workflow !== CALLER_WORKFLOW_PATH) {
      problems.push(`signing workflow must be ${CALLER_WORKFLOW_PATH}`);
    }
    if (
      !image.signing.ref.startsWith("refs/heads/") &&
      !image.signing.ref.startsWith("refs/tags/")
    ) {
      problems.push("signing ref must identify an exact branch or tag");
    }
  }
  if (image.deployment) {
    if (
      !image.deployment.requireImmutableDigest ||
      !image.deployment.requireSignature ||
      !image.deployment.requireSbom
    ) {
      problems.push("deployment promotion must require digest, signature, and SBOM evidence");
    }
    if (
      image.deployment.promotionMode !== undefined &&
      image.deployment.promotionMode !== "enforce-only" &&
      image.deployment.promotionMode !== "verified-default-branch"
    ) {
      problems.push(
        "deployment promotionMode must be enforce-only or verified-default-branch"
      );
    }
  }
  if (safeRepositoryPath(image.dockerfile)) {
    try {
      const dockerfile = await github.getFile(
        owner,
        repo,
        image.dockerfile,
        defaultBranch
      );
      if (!dockerfile) problems.push(`Dockerfile not found at ${image.dockerfile}`);
    } catch (error) {
      problems.push(`Dockerfile lookup failed: ${errorMessage(error)}`);
    }
  }
  if (image.context !== "." && safeRepositoryPath(image.context)) {
    try {
      const tree = await github.getTree(owner, repo, defaultBranch);
      const normalized = image.context.replace(/\/+$/, "");
      if (
        !tree.some(
          (path) => path === normalized || path.startsWith(`${normalized}/`)
        )
      ) {
        problems.push(`build context not found at ${image.context}`);
      }
    } catch (error) {
      problems.push(`build context lookup failed: ${errorMessage(error)}`);
    }
  }
  return makeCheck(
    "image-configuration",
    "image configuration",
    problems.length === 0,
    problems.length
      ? problems.join("; ")
      : `${image.dockerfile}, ${image.registry}, ${image.healthPath}`
  );
}

function invalidRemoteHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "0.0.0.0" ||
    value.startsWith("127.") ||
    value.startsWith("169.254.")
  );
}

function inspectDastConfiguration(dast: GuardianConfig["dast"]): DoctorCheck {
  if (!dast) {
    return makeCheck(
      "dast-configuration",
      "DAST configuration",
      true,
      "not configured",
      { blocking: false, state: "not-applicable" }
    );
  }
  const problems: string[] = [];
  const validRequestPath = (value: string) => /^\/(?!\/)[^\s?#]*(?:\?[^#\s]*)?$/.test(value);
  const allowedOrigin =
    typeof dast.allowedOrigin === "string" ? dast.allowedOrigin : "";
  const allowedOrigins = Array.isArray(dast.allowedOrigins)
    ? dast.allowedOrigins.filter((value): value is string => typeof value === "string")
    : [];
  const openapi = typeof dast.openapi === "string" ? dast.openapi : "";
  const inspectOrigin = (value: string, field: string): URL | undefined => {
    try {
      const candidate = new URL(value);
      if (candidate.protocol !== "https:") problems.push(`${field} must use HTTPS`);
      if (invalidRemoteHost(candidate.hostname)) {
        problems.push(`${field} targets a local or link-local host`);
      }
      if (candidate.username || candidate.password) {
        problems.push(`${field} must not contain credentials`);
      }
      if (candidate.pathname !== "/" || candidate.search || candidate.hash) {
        problems.push(`${field} must contain only scheme, host, and optional port`);
      }
      return candidate;
    } catch {
      problems.push(`${field} must be an absolute HTTPS origin`);
      return undefined;
    }
  };
  const origin = inspectOrigin(allowedOrigin, "allowedOrigin");
  for (const [index, additionalOrigin] of allowedOrigins.entries()) {
    inspectOrigin(additionalOrigin, `allowedOrigins[${index}]`);
  }
  if (
    allowedOrigins.length &&
    !allowedOrigins.includes(allowedOrigin)
  ) {
    problems.push("allowedOrigins must include allowedOrigin");
  }
  if (!validRequestPath(dast.sessionAssertionPath)) {
    problems.push("sessionAssertionPath must be an origin-relative path");
  }
  try {
    const authenticationProfile = new URL(dast.authenticationProfile);
    if (
      authenticationProfile.protocol !== "control-plane:" ||
      authenticationProfile.hostname !== "profiles" ||
      !/^\/[A-Za-z0-9._/-]+$/.test(authenticationProfile.pathname) ||
      authenticationProfile.pathname.includes("..") ||
      authenticationProfile.username ||
      authenticationProfile.password ||
      authenticationProfile.search ||
      authenticationProfile.hash
    ) {
      problems.push("authenticationProfile must be an opaque control-plane:// reference");
    }
  } catch {
    problems.push("authenticationProfile must be an opaque control-plane:// reference");
  }
  const openapiSource =
    dast.openapiSource ??
    (openapi.startsWith("/") || /^https:/i.test(openapi)
      ? "live-endpoint"
      : "repository-file");
  if (openapiSource === "repository-file") {
    if (
      openapi.startsWith("/") ||
      openapi.split("/").includes("..") ||
      !/\.(?:json|ya?ml)$/i.test(openapi)
    ) {
      problems.push("repository OpenAPI must be a JSON or YAML repository-relative path");
    }
  } else if (origin) {
    try {
      const openapiUrl = new URL(openapi, origin);
      if (openapiUrl.protocol !== "https:") problems.push("OpenAPI must resolve to HTTPS");
      if (invalidRemoteHost(openapiUrl.hostname)) problems.push("OpenAPI targets a local or link-local host");
      if (openapiUrl.origin !== origin.origin) {
        problems.push("OpenAPI must resolve to the configured exact origin");
      }
    } catch {
      problems.push("openapi must be a valid path or HTTPS URL");
    }
  }
  if (dast.profiles) {
    const profiles = new Set([
      "baseline",
      "authenticated-baseline",
      "full",
      "authenticated-full"
    ]);
    if (!profiles.has(dast.profiles.deploySmoke)) {
      problems.push("deploy-smoke DAST profile is invalid");
    }
    if (!profiles.has(dast.profiles.nightly)) {
      problems.push("nightly DAST profile is invalid");
    }
  }
  for (const route of dast.excludedRoutes ?? []) {
    if (!validRequestPath(route)) {
      problems.push(`excluded route ${route} must be an origin-relative path`);
    }
  }
  return makeCheck(
    "dast-configuration",
    "DAST configuration",
    problems.length === 0,
    problems.length ? problems.join("; ") : "exact origin, OpenAPI, auth profile, and routes are consistent"
  );
}

/** Canonical RFC3339 UTC instant: must equal `new Date(value).toISOString()`. */
export function isCanonicalUtcInstant(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeRepositoryName(value: string): string {
  return value.trim().toLowerCase();
}

function isNormalizedRepositoryName(value: string): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateFingerprintList(fingerprints: unknown[]): BaselineInspection {
  const invalid = fingerprints.filter(
    (fingerprint) =>
      typeof fingerprint !== "string" || !FINGERPRINT_SHA256.test(fingerprint)
  );
  if (invalid.length) {
    return {
      ready: false,
      count: fingerprints.length,
      detail: `${invalid.length} baseline fingerprint(s) are not lowercase SHA-256 values`
    };
  }
  if (new Set(fingerprints as string[]).size !== fingerprints.length) {
    return {
      ready: false,
      count: fingerprints.length,
      detail: "baseline contains duplicate fingerprints"
    };
  }
  return {
    ready: true,
    count: fingerprints.length,
    detail:
      fingerprints.length === 0
        ? "0 reviewed fingerprint(s); clean repository baseline"
        : `${fingerprints.length} reviewed fingerprint(s)`
  };
}

function inspectVersionedBaseline(
  value: Record<string, unknown>
): BaselineInspection {
  if (!Array.isArray(value.fingerprints)) {
    return {
      ready: false,
      detail: "versioned baseline must include a fingerprints array"
    };
  }
  if (typeof value.generatedAt !== "string" || !isCanonicalUtcInstant(value.generatedAt)) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail:
        "versioned baseline generatedAt must be a canonical RFC3339 UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)"
    };
  }
  const source = value.source;
  if (!isObject(source)) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source must be an object"
    };
  }
  if (
    typeof source.gateSha256 !== "string" ||
    !FINGERPRINT_SHA256.test(source.gateSha256)
  ) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source.gateSha256 must be a lowercase SHA-256 digest"
    };
  }
  if (source.mode !== "report-only") {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source.mode must be report-only"
    };
  }
  if (
    typeof source.repository !== "string" ||
    !isNormalizedRepositoryName(normalizeRepositoryName(source.repository))
  ) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source.repository must be OWNER/REPO"
    };
  }
  if (typeof source.headSha !== "string" || !IMMUTABLE_SHA.test(source.headSha)) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source.headSha must be a lowercase 40-character commit SHA"
    };
  }
  if (!isPositiveSafeInteger(source.runId)) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source.runId must be a positive integer"
    };
  }
  if (!isPositiveSafeInteger(source.runAttempt)) {
    return {
      ready: false,
      count: value.fingerprints.length,
      detail: "versioned baseline source.runAttempt must be a positive integer"
    };
  }
  return validateFingerprintList(value.fingerprints);
}

export function inspectBaselineContent(source: string): BaselineInspection {
  try {
    const value = JSON.parse(source) as unknown;
    if (Array.isArray(value)) {
      if (!value.length) {
        return {
          ready: false,
          count: 0,
          detail: "legacy baseline fingerprint set is empty"
        };
      }
      return validateFingerprintList(value);
    }
    if (!isObject(value) || !Array.isArray(value.fingerprints)) {
      return {
        ready: false,
        detail: "baseline must be an array or an object with a fingerprints array"
      };
    }
    if (value.schemaVersion === BASELINE_SCHEMA_VERSION) {
      return inspectVersionedBaseline(value);
    }
    if (!value.fingerprints.length) {
      return {
        ready: false,
        count: 0,
        detail: "legacy baseline fingerprint set is empty"
      };
    }
    return validateFingerprintList(value.fingerprints);
  } catch (error) {
    return { ready: false, detail: `invalid JSON: ${errorMessage(error)}` };
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const GATE_PROVENANCE_UPGRADE_MESSAGE =
  "gate.json is missing repository/headSha/runId/runAttempt provenance; re-run the security gate with the current reusable workflow and pass that gate.json to guardianctl baseline";

export function parseGateForBaseline(gateJson: string): {
  fingerprints: string[];
  gateSha256: string;
  repository: string;
  headSha: string;
  runId: number;
  runAttempt: number;
} {
  if (Buffer.byteLength(gateJson, "utf8") > MAX_GATE_JSON_BYTES) {
    throw new Error(
      `gate.json exceeds the maximum size of ${MAX_GATE_JSON_BYTES} bytes`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(gateJson) as unknown;
  } catch (error) {
    throw new Error(`gate.json is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isObject(parsed)) {
    throw new Error("gate.json must be a GuardianBot gate object");
  }
  if (parsed.schemaVersion !== "1.0.0") {
    throw new Error("gate.json schemaVersion must be 1.0.0");
  }
  if (parsed.mode !== "report-only") {
    throw new Error("gate.json mode must be report-only");
  }
  if (parsed.passed !== true) {
    throw new Error("gate.json must have passed=true");
  }
  if (!Array.isArray(parsed.failures)) {
    throw new Error("gate.json failures must be an array");
  }
  if (parsed.failures.length !== 0) {
    throw new Error("gate.json failures must be empty");
  }
  if (!Array.isArray(parsed.policyFindings)) {
    throw new Error("gate.json policyFindings must be an array");
  }
  if (parsed.policyFindings.length > MAX_POLICY_FINDINGS) {
    throw new Error(
      `gate.json policyFindings exceeds the maximum of ${MAX_POLICY_FINDINGS}`
    );
  }
  const missingProvenance =
    parsed.repository === undefined ||
    parsed.headSha === undefined ||
    parsed.runId === undefined ||
    parsed.runAttempt === undefined;
  if (missingProvenance) {
    throw new Error(GATE_PROVENANCE_UPGRADE_MESSAGE);
  }
  if (typeof parsed.repository !== "string" || !parsed.repository.trim()) {
    throw new Error("gate.json repository must be a non-empty OWNER/REPO string");
  }
  const repository = normalizeRepositoryName(parsed.repository);
  if (!isNormalizedRepositoryName(repository)) {
    throw new Error("gate.json repository must be formatted as OWNER/REPO");
  }
  if (typeof parsed.headSha !== "string" || !IMMUTABLE_SHA.test(parsed.headSha.toLowerCase())) {
    throw new Error("gate.json headSha must be a lowercase 40-character commit SHA");
  }
  const headSha = parsed.headSha.toLowerCase();
  if (parsed.headSha !== headSha) {
    throw new Error("gate.json headSha must be a lowercase 40-character commit SHA");
  }
  if (!isPositiveSafeInteger(parsed.runId)) {
    throw new Error("gate.json runId must be a positive integer");
  }
  if (!isPositiveSafeInteger(parsed.runAttempt)) {
    throw new Error("gate.json runAttempt must be a positive integer");
  }
  const fingerprints: string[] = [];
  for (const [index, finding] of parsed.policyFindings.entries()) {
    if (!isObject(finding)) {
      throw new Error(`gate.json policyFindings[${index}] must be an object`);
    }
    if (
      typeof finding.fingerprint !== "string" ||
      !FINGERPRINT_SHA256.test(finding.fingerprint)
    ) {
      throw new Error(
        `gate.json policyFindings[${index}].fingerprint must be a lowercase SHA-256 digest`
      );
    }
    fingerprints.push(finding.fingerprint);
  }
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("gate.json policyFindings contain duplicate fingerprints");
  }
  fingerprints.sort();
  return {
    fingerprints,
    gateSha256: sha256Hex(gateJson),
    repository,
    headSha,
    runId: parsed.runId,
    runAttempt: parsed.runAttempt
  };
}

export function buildBaselineDocument(
  fingerprints: string[],
  source: {
    gateSha256: string;
    repository: string;
    headSha: string;
    runId: number;
    runAttempt: number;
  },
  generatedAt: Date
): BaselineDocument {
  if (!FINGERPRINT_SHA256.test(source.gateSha256)) {
    throw new Error("gateSha256 must be a lowercase SHA-256 digest");
  }
  const repository = normalizeRepositoryName(source.repository);
  if (!isNormalizedRepositoryName(repository)) {
    throw new Error("baseline source.repository must be formatted as OWNER/REPO");
  }
  if (!IMMUTABLE_SHA.test(source.headSha)) {
    throw new Error("baseline source.headSha must be a lowercase 40-character commit SHA");
  }
  if (!isPositiveSafeInteger(source.runId)) {
    throw new Error("baseline source.runId must be a positive integer");
  }
  if (!isPositiveSafeInteger(source.runAttempt)) {
    throw new Error("baseline source.runAttempt must be a positive integer");
  }
  const sorted = [...fingerprints].sort();
  if (sorted.some((fingerprint) => !FINGERPRINT_SHA256.test(fingerprint))) {
    throw new Error("baseline fingerprints must be lowercase SHA-256 digests");
  }
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("baseline fingerprints must be unique");
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    fingerprints: sorted,
    generatedAt: generatedAt.toISOString(),
    source: {
      gateSha256: source.gateSha256,
      mode: "report-only",
      repository,
      headSha: source.headSha,
      runId: source.runId,
      runAttempt: source.runAttempt
    }
  };
}

export function serializeBaselineDocument(document: BaselineDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function baselineAlreadyMatches(
  currentContent: string | undefined,
  document: BaselineDocument
): boolean {
  if (!currentContent) return false;
  try {
    const current = JSON.parse(currentContent) as unknown;
    if (!isObject(current) || current.schemaVersion !== BASELINE_SCHEMA_VERSION) {
      return false;
    }
    if (!Array.isArray(current.fingerprints)) return false;
    if (
      current.fingerprints.some((fingerprint) => typeof fingerprint !== "string")
    ) {
      return false;
    }
    const currentFingerprints = [...(current.fingerprints as string[])].sort();
    if (
      currentFingerprints.length !== document.fingerprints.length ||
      !currentFingerprints.every(
        (fingerprint, index) => fingerprint === document.fingerprints[index]
      )
    ) {
      return false;
    }
    const source = current.source;
    if (!isObject(source)) return false;
    return (
      source.gateSha256 === document.source.gateSha256 &&
      source.mode === document.source.mode &&
      typeof source.repository === "string" &&
      normalizeRepositoryName(source.repository) === document.source.repository &&
      source.headSha === document.source.headSha &&
      source.runId === document.source.runId &&
      source.runAttempt === document.source.runAttempt
    );
  } catch {
    return false;
  }
}

function renderBaselineReport(
  repository: string,
  document: BaselineDocument
): string {
  const clean = document.fingerprints.length === 0;
  return [
    "Opens a GuardianBot baseline draft for eventual enforcement.",
    "",
    `- Repository: \`${repository}\``,
    `- Generated at: \`${document.generatedAt}\` (generation timestamp; not human review)`,
    `- Source gate digest: \`${document.source.gateSha256}\``,
    `- Source repository: \`${document.source.repository}\``,
    `- Source head SHA: \`${document.source.headSha}\``,
    `- Source run: \`${document.source.runId}\` attempt \`${document.source.runAttempt}\``,
    `- Fingerprint count: ${document.fingerprints.length}`,
    `- Clean repository (empty baseline): ${clean ? "yes" : "no"}`,
    `- Baseline schema: \`${document.schemaVersion}\``,
    "",
    "Human review evidence is this pull request's review and merge, not generatedAt.",
    "A human must review and merge this baseline before enforcement.",
    "This PR does not change scanner mode or repository rulesets."
  ].join("\n");
}

async function inspectBaseline(
  github: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  mode?: ScannerMode
): Promise<BaselineInspection> {
  if (!mode || mode === "advisory") {
    return { ready: true, detail: "not applicable in advisory mode" };
  }
  try {
    const file = await github.getFile(owner, repo, BASELINE_PATH, defaultBranch);
    if (!file) {
      return {
        ready: false,
        detail: `${BASELINE_PATH} is required before enforcement`
      };
    }
    return inspectBaselineContent(file.content);
  } catch (error) {
    return { ready: false, detail: errorMessage(error) };
  }
}

function commitTime(commit: CommitSummary): Date | undefined {
  const value = commit.commit?.committer?.date ?? commit.commit?.author?.date;
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function reportOnlyConfigurationStart(
  github: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  currentMode: ScannerMode
): Promise<Date | undefined> {
  if (currentMode === "advisory") return undefined;
  let trackingReportOnly = currentMode === "report-only";
  let reportOnlyStart: Date | undefined;
  let finished = false;
  for (let page = 1; !finished; page += 1) {
    const commits = await github.request<CommitSummary[]>(
      "GET",
      `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
        defaultBranch
      )}&path=${encodeURIComponent(CONFIG_PATH)}&per_page=100&page=${page}`
    );
    for (const commit of commits) {
      const file = await github.getFile(owner, repo, CONFIG_PATH, commit.sha);
      let mode: ScannerMode | undefined;
      try {
        mode = file ? parseGuardianConfig(file.content).scanners.mode : undefined;
      } catch {
        mode = undefined;
      }
      if (!trackingReportOnly) {
        if (mode === "enforce") continue;
        if (mode === "report-only") {
          trackingReportOnly = true;
        } else {
          finished = true;
          break;
        }
      }
      if (trackingReportOnly) {
        if (mode !== "report-only") {
          finished = true;
          break;
        }
        reportOnlyStart = commitTime(commit) ?? reportOnlyStart;
      }
    }
    if (commits.length < 100) break;
  }
  return reportOnlyStart;
}

async function latestPathCommitTime(
  github: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  path: string
): Promise<Date | undefined> {
  const commits = await github.request<CommitSummary[]>(
    "GET",
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
      defaultBranch
    )}&path=${encodeURIComponent(path)}&per_page=1&page=1`
  );
  return commits[0] ? commitTime(commits[0]) : undefined;
}

async function inspectObservationPeriod(
  context: CommandContext,
  github: GitHubClient,
  owner: string,
  repo: string,
  mode: ScannerMode | undefined,
  configuredSince: Date | undefined,
  runs: WorkflowRun[]
): Promise<{ check: DoctorCheck; since?: Date; ageDays?: number }> {
  if (!mode || mode === "advisory") {
    return {
      check: makeCheck(
        "report-only-observation",
        "report-only observation",
        true,
        "not applicable in advisory mode",
        { blocking: false, state: "not-applicable" }
      )
    };
  }
  const blocking = mode === "enforce";
  if (!configuredSince) {
    return {
      check: makeCheck(
        "report-only-observation",
        "report-only observation",
        false,
        "report-only configuration history could not be established",
        { blocking, state: "missing" }
      )
    };
  }
  // Observation and enforcement timing start only from the first successful
  // default-branch push or workflow_dispatch after report-only config that also
  // has a present, non-skipped, completed, successful run-bound security gate.
  // Missing/skipped/failed gates do not start the clock. All schedule events
  // are excluded (including security-bearing ones) so DAST-only smokes cannot
  // start it; onboarding normally starts via the merge push that lands the
  // generated caller.
  const candidates = [...runs]
    .filter((run) => {
      const time = workflowRunTime(run);
      return (
        run.status === "completed" &&
        run.conclusion === "success" &&
        isAlwaysSecurityEvent(run.event) &&
        time &&
        time.getTime() >= configuredSince.getTime()
      );
    })
    .sort(
      (left, right) =>
        (workflowRunTime(left)?.getTime() ?? 0) - (workflowRunTime(right)?.getTime() ?? 0)
    );

  let firstQualifiedRun: WorkflowRun | undefined;
  try {
    for (const run of candidates) {
      const evidence = await loadGateEvidenceForRun(github, owner, repo, run);
      if (!evidence || evidence.skipped) continue;
      if (evidence.status === "completed" && evidence.conclusion === "success") {
        firstQualifiedRun = run;
        break;
      }
      // Failed or incomplete gate evidence: keep looking at later eligible runs.
    }
  } catch (error) {
    return {
      check: makeCheck(
        "report-only-observation",
        "report-only observation",
        false,
        `could not load security-gate evidence to start report-only observation: ${errorMessage(error)}`,
        { blocking, state: "failed" }
      )
    };
  }

  const since = firstQualifiedRun ? workflowRunTime(firstQualifiedRun) : undefined;
  if (!since) {
    return {
      check: makeCheck(
        "report-only-observation",
        "report-only observation",
        false,
        `no successful default-branch push or workflow_dispatch with a successful non-skipped security gate proves report-only operation since ${configuredSince.toISOString()} (scheduled runs do not start the clock)`,
        { blocking, state: "missing" }
      )
    };
  }
  const ageDays = (currentTime(context).getTime() - since.getTime()) / 86_400_000;
  const minimum = Math.max(
    context.reportOnlyMinimumDays ?? DEFAULT_REPORT_ONLY_MINIMUM_DAYS,
    DEFAULT_REPORT_ONLY_MINIMUM_DAYS
  );
  const ok = ageDays >= minimum;
  return {
    since,
    ageDays,
    check: makeCheck(
      "report-only-observation",
      "report-only observation",
      ok,
      `${ageDays.toFixed(2)} days since first successful report-only security run ${since.toISOString()}; minimum is ${minimum}`,
      { blocking, state: ok ? "ok" : "stale" }
    )
  };
}

function rulesetAppliesToDefaultBranch(ruleset: Ruleset, defaultBranch: string): boolean {
  const include = ruleset.conditions?.ref_name?.include;
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const branchRef = `refs/heads/${defaultBranch}`;
  const matchesDefault = (value: string) => {
    if (
      value === "~ALL" ||
      value === "~DEFAULT_BRANCH" ||
      value === defaultBranch ||
      value === branchRef
    ) {
      return true;
    }
    const pattern = value
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*");
    try {
      return new RegExp(`^${pattern}$`).test(branchRef);
    } catch {
      return false;
    }
  };
  if (exclude.some(matchesDefault)) return false;
  if (!include?.length) return true;
  return include.some(matchesDefault);
}

function rulesetContexts(ruleset: Ruleset): {
  contexts: string[];
  strict: boolean;
} {
  const rules = ruleset.rules ?? [];
  const requiredRules = rules.filter((rule) => rule.type === "required_status_checks");
  return {
    contexts: requiredRules.flatMap(
      (rule) =>
        rule.parameters?.required_status_checks
          ?.map((check) => check.context)
          .filter((value): value is string => Boolean(value)) ?? []
    ),
    strict: requiredRules.some(
      (rule) => rule.parameters?.strict_required_status_checks_policy === true
    )
  };
}

async function inspectRulesets(
  github: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  expectedCheck: string
): Promise<RulesetInspection> {
  const rulesets: Ruleset[] = [];
  let rulesetsObservable = false;
  try {
    for (let page = 1; ; page += 1) {
      const batch = await github.request<Ruleset[]>(
        "GET",
        `/repos/${owner}/${repo}/rulesets?includes_parents=true&per_page=100&page=${page}`
      );
      rulesetsObservable = true;
      rulesets.push(...batch);
      if (batch.length < 100) break;
    }
  } catch (error) {
    const status = githubErrorStatus(error);
    if (!status || ![403, 404].includes(status)) throw error;
  }

  const detailed: Ruleset[] = [];
  for (const summary of rulesets) {
    if (
      (summary.target && summary.target !== "branch") ||
      (summary.enforcement && summary.enforcement !== "active") ||
      !rulesetAppliesToDefaultBranch(summary, defaultBranch)
    ) {
      continue;
    }
    if (summary.rules) {
      detailed.push(summary);
      continue;
    }
    try {
      detailed.push(
        await github.request<Ruleset>(
          "GET",
          `/repos/${owner}/${repo}/rulesets/${summary.id}`
        )
      );
    } catch (error) {
      const status = githubErrorStatus(error);
      if (!status || ![403, 404].includes(status)) throw error;
    }
  }

  const contexts = [...new Set(detailed.flatMap((ruleset) => rulesetContexts(ruleset).contexts))];
  const readyRuleset = detailed.find((ruleset) => {
    const required = rulesetContexts(ruleset);
    return required.strict && required.contexts.includes(expectedCheck);
  });
  const owned = rulesets.find((ruleset) => ruleset.name === "GuardianBot security gate");
  const ownedActive = Boolean(
    owned &&
      (!owned.target || owned.target === "branch") &&
      owned.enforcement === "active" &&
      rulesetAppliesToDefaultBranch(owned, defaultBranch)
  );
  if (readyRuleset) {
    return {
      observable: true,
      ready: true,
      ownedRulesetId: owned?.id,
      ownedRulesetActive: ownedActive,
      contexts,
      detail: `${expectedCheck} is strict and required by ruleset ${readyRuleset.name}`
    };
  }

  let branchProtectionObservable = false;
  try {
    const protection = await github.request<{
      strict?: boolean;
      contexts?: string[];
      checks?: Array<{ context?: string }>;
    }>(
      "GET",
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(
        defaultBranch
      )}/protection/required_status_checks`
    );
    branchProtectionObservable = true;
    const classicContexts = [
      ...(protection.contexts ?? []),
      ...(protection.checks ?? [])
        .map((check) => check.context)
        .filter((value): value is string => Boolean(value))
    ];
    contexts.push(...classicContexts);
    if (protection.strict === true && classicContexts.includes(expectedCheck)) {
      return {
        observable: true,
        ready: true,
        ownedRulesetId: owned?.id,
        ownedRulesetActive: ownedActive,
        contexts: [...new Set(contexts)],
        detail: `${expectedCheck} is strict and required by branch protection`
      };
    }
  } catch (error) {
    const status = githubErrorStatus(error);
    if (!status || ![403, 404].includes(status)) throw error;
    if (status === 404) branchProtectionObservable = true;
  }

  const observable = rulesetsObservable || branchProtectionObservable;
  return {
    observable,
    ready: false,
    ownedRulesetId: owned?.id,
    ownedRulesetActive: ownedActive,
    contexts: [...new Set(contexts)],
    detail: observable
      ? contexts.length
        ? `required contexts do not include strict ${expectedCheck}: ${[
            ...new Set(contexts)
          ].join(", ")}`
        : `no strict required ${expectedCheck} rule is configured`
      : "rulesets and branch protection are not observable with this operator token"
  };
}

async function doctorInternal(
  context: CommandContext,
  repository: string,
  options: DiagnosticOptions = {}
): Promise<DoctorResult> {
  if (!options.allowConfiguredWorkflowSha) assertImmutableWorkflowSha(context.workflowSha);
  const { owner, repo } = parseRepository(repository);
  const checks: DoctorCheck[] = [];
  let metadata: GitHubRepository;
  try {
    metadata = await context.github.getRepository(owner, repo);
    checks.push(
      makeCheck(
        "repository-access",
        "repository access",
        true,
        `${metadata.full_name} default branch ${metadata.default_branch}`
      )
    );
  } catch (error) {
    checks.push(
      makeCheck(
        "repository-access",
        "repository access",
        false,
        errorMessage(error)
      )
    );
    return {
      status: "misconfigured",
      enforcementReady: false,
      checks,
      facts: {
        appAccess: "unobservable",
        requiredCheckName: DEFAULT_SECURITY_GATE_CHECK,
        rulesetReady: false
      }
    };
  }

  const [configFile, workflow, appAccess] = await Promise.all([
    context.github.getFile(owner, repo, CONFIG_PATH, metadata.default_branch),
    context.github.getFile(owner, repo, CALLER_WORKFLOW_PATH, metadata.default_branch),
    inspectAppAccess(context, owner, repo)
  ]);
  const configuredAny = Boolean(configFile || workflow);
  const configured = Boolean(configFile && workflow);
  const appOk = appAccess.state === "installed" || appAccess.state === "unobservable";
  checks.push(
    makeCheck(
      "app-access",
      "GitHub App access",
      appOk,
      appAccess.detail,
      {
        blocking: configuredAny && appAccess.state !== "unobservable",
        state:
          appAccess.state === "installed"
            ? "ok"
            : appAccess.state === "unobservable"
              ? "unobservable"
              : appAccess.state === "missing"
                ? "missing"
                : "failed"
      }
    )
  );

  let parsedConfig: GuardianConfig | undefined;
  let diagnosticDast: GuardianConfig["dast"] | undefined;
  if (!configFile) {
    checks.push(
      makeCheck("configuration", "configuration", false, "not configured", {
        state: "missing"
      })
    );
  } else {
    try {
      parsedConfig = parseGuardianConfig(configFile.content);
      checks.push(
        makeCheck(
          "configuration",
          "configuration",
          true,
          `schema ${parsedConfig.schemaVersion}, scanner mode ${parsedConfig.scanners.mode}`
        )
      );
    } catch (error) {
      checks.push(
        makeCheck("configuration", "configuration", false, errorMessage(error))
      );
      try {
        const document = parseGuardianConfigDocument(configFile.content);
        if (isObject(document) && isObject(document.dast)) {
          // A malformed configuration is never used for review or enforcement.
          // The raw DAST section is retained only to provide targeted doctor
          // diagnostics that help the operator repair it.
          diagnosticDast = document.dast as unknown as NonNullable<GuardianConfig["dast"]>;
        }
      } catch {
        diagnosticDast = undefined;
      }
    }
  }

  let effectiveWorkflowSha = context.workflowSha;
  if (options.allowConfiguredWorkflowSha && !isImmutableWorkflowSha(effectiveWorkflowSha)) {
    const derived = deriveConfiguredWorkflowSha(
      context.guardianRepository,
      parsedConfig,
      workflow?.content
    );
    if (derived) effectiveWorkflowSha = derived;
  }
  const effectiveShaValid = isImmutableWorkflowSha(effectiveWorkflowSha);
  if (parsedConfig) {
    const pinCurrent =
      effectiveShaValid && parsedConfig.workflowVersion === effectiveWorkflowSha;
    checks.push(
      makeCheck(
        "configuration-pin",
        "configuration workflow pin",
        pinCurrent,
        pinCurrent
          ? `immutable pin ${effectiveWorkflowSha}`
          : `configured ${parsedConfig.workflowVersion}; expected ${
              effectiveShaValid
                ? effectiveWorkflowSha
                : "an immutable 40-character lowercase commit SHA"
            }`
      )
    );
    checks.push(
      inspectRepositoryConfiguration(parsedConfig, metadata, currentTime(context))
    );
  }

  if (!workflow) {
    checks.push(
      makeCheck("workflow-pin", "caller workflow pin", false, "not configured", {
        state: "missing"
      })
    );
  } else {
    const pins = managedWorkflowPins(workflow.content, context.guardianRepository);
    const pinsCurrent =
      effectiveShaValid &&
      pins.length > 0 &&
      pins.every((pin) => pin === effectiveWorkflowSha && isImmutableWorkflowSha(pin));
    checks.push(
      makeCheck(
        "workflow-pin",
        "caller workflow pin",
        pinsCurrent,
        pins.length
          ? pinsCurrent
            ? `${pins.length} managed reusable workflow reference(s) pin ${effectiveWorkflowSha}`
            : `managed workflow pins differ or are mutable: ${pins.join(", ")}`
          : "no managed reusable GuardianBot workflow reference found"
      )
    );
  }

  if (workflow && parsedConfig && effectiveShaValid) {
    const expectedWorkflow = generateCallerWorkflow({
      guardianRepository: context.guardianRepository,
      workflowSha: effectiveWorkflowSha,
      defaultBranch: metadata.default_branch,
      scannerMode: parsedConfig.scanners.mode,
      image: parsedConfig.image,
      dast: parsedConfig.dast
    });
    const matches = callerWorkflowMatches(workflow.content, expectedWorkflow);
    checks.push(
      makeCheck(
        "generated-caller",
        "generated caller",
        matches,
        matches
          ? "matches declarative configuration"
          : "drift detected; run guardianctl upgrade"
      )
    );
  }

  if (parsedConfig) {
    checks.push(
      await inspectImageConfiguration(
        context.github,
        owner,
        repo,
        metadata.default_branch,
        parsedConfig.image
      )
    );
    checks.push(inspectDastConfiguration(parsedConfig.dast));
  } else if (diagnosticDast) {
    checks.push(inspectDastConfiguration(diagnosticDast));
  }

  let reportOnlyConfiguredSince: Date | undefined;
  if (parsedConfig && parsedConfig.scanners.mode !== "advisory") {
    try {
      reportOnlyConfiguredSince = await reportOnlyConfigurationStart(
        context.github,
        owner,
        repo,
        metadata.default_branch,
        parsedConfig.scanners.mode
      );
    } catch {
      reportOnlyConfiguredSince = undefined;
    }
  }

  let managedConfigurationChangedAt: Date | undefined;
  let managedChangeError: string | undefined;
  if (configFile && workflow) {
    try {
      const changedAt = await Promise.all([
        latestPathCommitTime(
          context.github,
          owner,
          repo,
          metadata.default_branch,
          CONFIG_PATH
        ),
        latestPathCommitTime(
          context.github,
          owner,
          repo,
          metadata.default_branch,
          CALLER_WORKFLOW_PATH
        )
      ]);
      const observed = changedAt.filter((value): value is Date => Boolean(value));
      if (observed.length) {
        managedConfigurationChangedAt = new Date(
          Math.max(...observed.map((value) => value.getTime()))
        );
      }
    } catch (error) {
      managedChangeError = errorMessage(error);
    }
  }

  let runInspection: RunInspection = {
    runs: [],
    check: makeCheck(
      "expected-run",
      "latest expected run",
      false,
      workflow ? "workflow run lookup did not complete" : "caller workflow is not configured",
      { state: "missing" }
    )
  };
  if (workflow) {
    try {
      const runs = await loadWorkflowRuns(
        context.github,
        owner,
        repo,
        metadata.default_branch,
        reportOnlyConfiguredSince
      );
      runInspection = inspectLatestRun(
        context,
        runs,
        managedConfigurationChangedAt,
        managedChangeError
      );
    } catch (error) {
      runInspection = {
        runs: [],
        check: makeCheck(
          "expected-run",
          "latest expected run",
          false,
          errorMessage(error),
          { state: githubErrorStatus(error) === 404 ? "missing" : "failed" }
        )
      };
    }
  }
  checks.push(runInspection.check);

  const gate = workflow
    ? await inspectGateCheck(
        context,
        context.github,
        owner,
        repo,
        runInspection.runs,
        managedConfigurationChangedAt,
        managedChangeError
      )
    : {
        check: makeCheck(
          "security-gate-check",
          "security gate check",
          false,
          "caller workflow is not configured",
          { state: "missing" as const }
        )
      };
  checks.push(gate.check);

  const baseline = await inspectBaseline(
    context.github,
    owner,
    repo,
    metadata.default_branch,
    parsedConfig?.scanners.mode
  );
  const baselineBlocking = parsedConfig?.scanners.mode === "enforce";
  checks.push(
    makeCheck(
      "baseline",
      "baseline readiness",
      baseline.ready,
      baseline.detail,
      {
        blocking: baselineBlocking,
        state: baseline.ready
          ? parsedConfig?.scanners.mode === "advisory"
            ? "not-applicable"
            : "ok"
          : "missing"
      }
    )
  );

  const observation = await inspectObservationPeriod(
    context,
    context.github,
    owner,
    repo,
    parsedConfig?.scanners.mode,
    reportOnlyConfiguredSince,
    runInspection.runs
  );
  checks.push(observation.check);

  const expectedCheck = gate.name ?? DEFAULT_SECURITY_GATE_CHECK;
  let ruleset: RulesetInspection = {
    observable: false,
    ready: false,
    contexts: [],
    detail: "caller workflow is not configured"
  };
  if (workflow) {
    try {
      ruleset = await inspectRulesets(
        context.github,
        owner,
        repo,
        metadata.default_branch,
        expectedCheck
      );
    } catch (error) {
      ruleset = {
        observable: false,
        ready: false,
        contexts: [],
        detail: errorMessage(error)
      };
    }
  }
  const rulesetRequired = parsedConfig?.scanners.mode === "enforce";
  const rulesetOk = rulesetRequired
    ? ruleset.ready
    : ruleset.ready || !ruleset.ownedRulesetActive || !ruleset.observable;
  const rulesetBlocking = rulesetRequired || Boolean(ruleset.ownedRulesetActive);
  checks.push(
    makeCheck(
      "required-check-rule",
      "required security gate rule",
      rulesetOk,
      ruleset.ready
        ? ruleset.detail
        : rulesetRequired
          ? ruleset.detail
          : ruleset.ownedRulesetActive
            ? `existing GuardianBot ruleset is not ready: ${ruleset.detail}`
            : ruleset.observable
              ? "not required until enforcement"
              : ruleset.detail,
      {
        blocking: rulesetBlocking,
        state: ruleset.ready
          ? "ok"
          : ruleset.observable
            ? rulesetBlocking
              ? "missing"
              : "not-applicable"
            : "unobservable"
      }
    )
  );

  const blockingFailures = checks.filter((check) => check.blocking && !check.ok);
  const status: DoctorResult["status"] =
    !configuredAny
      ? "advisory-only"
      : configured && !blockingFailures.length
        ? "ready"
        : "misconfigured";
  const enforcementCodes = new Set([
    "repository-access",
    "app-access",
    "configuration",
    "configuration-pin",
    "repository-configuration",
    "workflow-pin",
    "generated-caller",
    "image-configuration",
    "dast-configuration",
    "expected-run",
    "security-gate-check",
    "baseline",
    "report-only-observation"
  ]);
  if (parsedConfig?.scanners.mode === "enforce") {
    enforcementCodes.add("required-check-rule");
  }
  const enforcementReady =
    Boolean(parsedConfig && parsedConfig.scanners.mode !== "advisory") &&
    checks
      .filter((check) => enforcementCodes.has(check.code))
      .every((check) => check.ok);
  return {
    status,
    enforcementReady,
    checks,
    facts: {
      scannerMode: parsedConfig?.scanners.mode,
      appAccess: appAccess.state,
      latestRunAt: gate.evidenceRun
        ? workflowRunTime(gate.evidenceRun)?.toISOString()
        : runInspection.latestCompleted
          ? workflowRunTime(runInspection.latestCompleted)?.toISOString()
          : undefined,
      latestRunId: gate.evidenceRun?.id ?? runInspection.latestCompleted?.id,
      latestRunHeadSha:
        gate.evidenceRun?.head_sha ?? runInspection.latestCompleted?.head_sha,
      managedConfigurationChangedAt:
        managedConfigurationChangedAt?.toISOString(),
      securityGateCheck: gate.name,
      baselineCount: baseline.count,
      reportOnlySince: observation.since?.toISOString(),
      reportOnlyAgeDays: observation.ageDays,
      requiredCheckName: expectedCheck,
      rulesetId: ruleset.ownedRulesetId,
      rulesetReady: ruleset.ready
    }
  };
}

export async function doctor(
  context: CommandContext,
  repository: string
): Promise<DoctorResult> {
  return doctorInternal(context, repository);
}

function inventoryDetail(diagnosis: DoctorResult, status: InventoryStatus): string {
  if (status === "missing-expected-runs") {
    return diagnosis.checks
      .filter(
        (check) =>
          ["expected-run", "security-gate-check"].includes(check.code) && !check.ok
      )
      .map((check) => check.detail)
      .join("; ");
  }
  if (status === "misconfigured") {
    return diagnosis.checks
      .filter((check) => check.blocking && !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
  }
  if (status === "enforced") return "enforce mode with a fresh successful gate and strict required check";
  if (status === "report-only") {
    return diagnosis.enforcementReady
      ? "healthy report-only coverage; eligible for enforcement"
      : "healthy report-only coverage; enforcement prerequisites are still pending";
  }
  if (status === "advisory-only") return "App/advisory coverage without an enforced scanner gate";
  return "repository is outside active GuardianBot scanner scope";
}

function classifyInventory(
  diagnosis: DoctorResult,
  configuredAny: boolean
): InventoryStatus {
  if (!configuredAny && diagnosis.facts.appAccess === "missing") return "not-applicable";
  if (!configuredAny) return "advisory-only";
  const nonRunBlockingFailure = diagnosis.checks.some(
    (check) =>
      check.blocking &&
      !check.ok &&
      !["expected-run", "security-gate-check"].includes(check.code)
  );
  if (nonRunBlockingFailure) return "misconfigured";
  const missingExpected = diagnosis.checks.some(
    (check) =>
      ["expected-run", "security-gate-check"].includes(check.code) &&
      !check.ok &&
      ["missing", "stale"].includes(check.state)
  );
  if (missingExpected) return "missing-expected-runs";
  const failedExpected = diagnosis.checks.some(
    (check) =>
      ["expected-run", "security-gate-check"].includes(check.code) && !check.ok
  );
  if (failedExpected || diagnosis.status === "misconfigured") return "misconfigured";
  if (diagnosis.facts.scannerMode === "enforce") {
    return diagnosis.facts.rulesetReady ? "enforced" : "misconfigured";
  }
  if (diagnosis.facts.scannerMode === "report-only") return "report-only";
  return "advisory-only";
}

export async function inventory(context: CommandContext): Promise<InventoryRow[]> {
  const repositories = await context.github.listAuthenticatedRepositories();
  const rows: InventoryRow[] = [];
  for (const repository of [...repositories].sort((left, right) =>
    left.full_name.localeCompare(right.full_name)
  )) {
    if (repository.archived || repository.fork) {
      rows.push({
        repository: repository.full_name,
        status: "not-applicable",
        detail: repository.archived ? "repository is archived" : "repository is a fork"
      });
      continue;
    }
    try {
      const [config, workflow] = await Promise.all([
        context.github.getFile(
          repository.owner.login,
          repository.name,
          CONFIG_PATH,
          repository.default_branch
        ),
        context.github.getFile(
          repository.owner.login,
          repository.name,
          CALLER_WORKFLOW_PATH,
          repository.default_branch
        )
      ]);
      const diagnosis = await doctorInternal(context, repository.full_name, {
        allowConfiguredWorkflowSha: true
      });
      const status = classifyInventory(diagnosis, Boolean(config || workflow));
      rows.push({
        repository: repository.full_name,
        status,
        scannerMode: diagnosis.facts.scannerMode,
        detail: inventoryDetail(diagnosis, status)
      });
    } catch (error) {
      rows.push({
        repository: repository.full_name,
        status: "misconfigured",
        detail: errorMessage(error)
      });
    }
  }
  return rows;
}

export async function upgrade(
  context: CommandContext,
  repository: string
): Promise<{ url?: string; changed: boolean }> {
  assertImmutableWorkflowSha(context.workflowSha);
  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const configFile = await context.github.getFile(
    owner,
    repo,
    CONFIG_PATH,
    metadata.default_branch
  );
  const workflowFile = await context.github.getFile(
    owner,
    repo,
    CALLER_WORKFLOW_PATH,
    metadata.default_branch
  );
  if (!configFile || !workflowFile) throw new Error("Repository is not onboarded");
  const config = parseGuardianConfig(configFile.content);
  const originalConfig = serializeGuardianConfig(config);
  config.workflowVersion = context.workflowSha;
  applyConfigurationOverrides(config, context.overrides);
  const configurationErrors = validateGuardianConfig(config);
  if (configurationErrors.length) {
    throw new Error(
      `Updated GuardianBot configuration is invalid:\n${configurationErrors.join("\n")}`
    );
  }
  const serializedConfig = serializeGuardianConfig(config);
  const configChanged = serializedConfig !== originalConfig;
  const workflow = generateCallerWorkflow({
    guardianRepository: context.guardianRepository,
    workflowSha: context.workflowSha,
    defaultBranch: metadata.default_branch,
    scannerMode: config.scanners.mode,
    image: config.image,
    dast: config.dast
  });
  const workflowChanged = !callerWorkflowMatches(workflowFile.content, workflow);
  if (!configChanged && !workflowChanged) return { changed: false };
  if (context.dryRun) return { changed: true };
  const branch = branchName("upgrade");
  await context.github.createBranch(owner, repo, branch, metadata.default_branch);
  if (configChanged) {
    await context.github.putFile(
      owner,
      repo,
      CONFIG_PATH,
      branch,
      "chore(guardianbot): upgrade schema and workflow",
      serializedConfig,
      configFile.sha
    );
  }
  if (workflowChanged) {
    await context.github.putFile(
      owner,
      repo,
      CALLER_WORKFLOW_PATH,
      branch,
      "chore(guardianbot): regenerate pinned workflow",
      workflow,
      workflowFile.sha
    );
  }
  const changes = [
    configChanged ? "configuration pin" : undefined,
    workflowChanged ? "generated caller" : undefined
  ].filter((value): value is string => Boolean(value));
  const pull = await context.github.createPullRequest(owner, repo, {
    title: "chore: upgrade GuardianBot",
    head: branch,
    base: metadata.default_branch,
    draft: true,
    body: `Updates ${changes.join(" and ")} to the immutable GuardianBot workflow commit \`${
      context.workflowSha
    }\`.`
  });
  return { changed: true, url: pull.html_url };
}

export async function upgradeAll(
  context: CommandContext
): Promise<Array<{ repository: string; changed: boolean; url?: string; error?: string }>> {
  assertImmutableWorkflowSha(context.workflowSha);
  const repositories = await context.github.listAuthenticatedRepositories();
  const results: Array<{
    repository: string;
    changed: boolean;
    url?: string;
    error?: string;
  }> = [];
  for (const repository of [...repositories].sort((left, right) =>
    left.full_name.localeCompare(right.full_name)
  )) {
    if (repository.archived || repository.fork) continue;
    try {
      const config = await context.github.getFile(
        repository.owner.login,
        repository.name,
        CONFIG_PATH,
        repository.default_branch
      );
      if (!config) continue;
      const result = await upgrade(context, repository.full_name);
      results.push({ repository: repository.full_name, ...result });
    } catch (error) {
      results.push({
        repository: repository.full_name,
        changed: false,
        error: errorMessage(error)
      });
    }
  }
  return results;
}

export function buildSecurityGateRuleset(checkName: string): {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{
    type: "required_status_checks";
    parameters: {
      strict_required_status_checks_policy: true;
      required_status_checks: Array<{ context: string }>;
    };
  }>;
} {
  if (!isGateCheckName(checkName)) {
    throw new Error(`Refusing to require unexpected check context: ${checkName}`);
  }
  return {
    name: "GuardianBot security gate",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: checkName }]
        }
      }
    ]
  };
}

export interface EnforceResult {
  dryRun: boolean;
  changed: boolean;
  url?: string;
  ruleset: ReturnType<typeof buildSecurityGateRuleset>;
  rulesetAction: "created" | "updated" | "unchanged" | "planned-create" | "planned-update";
  configurationTransition: "report-only-to-enforce" | "already-enforced";
}

export async function baseline(
  context: CommandContext,
  repository: string,
  gateJson: string
): Promise<BaselineResult> {
  assertImmutableWorkflowSha(context.workflowSha);
  const parsedGate = parseGateForBaseline(gateJson);
  const requestedRepository = normalizeRepositoryName(repository);
  if (parsedGate.repository !== requestedRepository) {
    throw new Error(
      `gate.json repository ${parsedGate.repository} does not match requested ${requestedRepository}`
    );
  }
  const document = buildBaselineDocument(
    parsedGate.fingerprints,
    {
      gateSha256: parsedGate.gateSha256,
      repository: parsedGate.repository,
      headSha: parsedGate.headSha,
      runId: parsedGate.runId,
      runAttempt: parsedGate.runAttempt
    },
    currentTime(context)
  );
  const baselineJson = serializeBaselineDocument(document);
  const report = renderBaselineReport(repository, document);
  const resultBase = {
    baseline: document,
    baselineJson,
    fingerprintCount: document.fingerprints.length,
    clean: document.fingerprints.length === 0,
    gateSha256: document.source.gateSha256,
    report
  };

  const diagnosis = await doctorInternal(context, repository);
  if (diagnosis.facts.scannerMode !== "report-only") {
    throw new Error(
      "Cannot open a baseline PR unless the repository is in report-only scanner mode"
    );
  }
  const requiredCodes = new Set([
    "repository-access",
    "app-access",
    "configuration",
    "configuration-pin",
    "repository-configuration",
    "workflow-pin",
    "generated-caller",
    "image-configuration",
    "dast-configuration",
    "expected-run",
    "security-gate-check",
    "report-only-observation"
  ]);
  const failures = diagnosis.checks.filter(
    (check) => requiredCodes.has(check.code) && !check.ok
  );
  if (failures.length) {
    throw new Error(
      `Cannot open a baseline PR until prerequisites pass: ${failures
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")}`
    );
  }
  if (
    diagnosis.facts.latestRunId === undefined ||
    parsedGate.runId !== diagnosis.facts.latestRunId
  ) {
    throw new Error(
      `gate.json runId ${parsedGate.runId} does not match doctor latest run ${
        diagnosis.facts.latestRunId ?? "none"
      }`
    );
  }
  const latestHeadSha = diagnosis.facts.latestRunHeadSha?.toLowerCase();
  if (!latestHeadSha || parsedGate.headSha !== latestHeadSha) {
    throw new Error(
      `gate.json headSha ${parsedGate.headSha} does not match doctor latest run head ${
        latestHeadSha ?? "none"
      }`
    );
  }

  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const existing = await context.github.getFile(
    owner,
    repo,
    BASELINE_PATH,
    metadata.default_branch
  );
  if (baselineAlreadyMatches(existing?.content, document)) {
    return {
      dryRun: Boolean(context.dryRun),
      changed: false,
      ...resultBase
    };
  }
  if (context.dryRun) {
    return {
      dryRun: true,
      changed: true,
      ...resultBase
    };
  }

  const branch = branchName("baseline");
  await context.github.createBranch(owner, repo, branch, metadata.default_branch);
  await context.github.putFile(
    owner,
    repo,
    BASELINE_PATH,
    branch,
    "chore(guardianbot): add baseline for review",
    baselineJson,
    existing?.sha
  );
  const pull = await context.github.createPullRequest(owner, repo, {
    title: "chore: review GuardianBot baseline",
    head: branch,
    base: metadata.default_branch,
    draft: true,
    body: report
  });
  return {
    dryRun: false,
    changed: true,
    url: pull.html_url,
    ...resultBase
  };
}

export async function enforce(
  context: CommandContext,
  repository: string
): Promise<EnforceResult> {
  assertImmutableWorkflowSha(context.workflowSha);
  const diagnosis = await doctorInternal(context, repository);
  if (
    diagnosis.facts.scannerMode !== "report-only" &&
    diagnosis.facts.scannerMode !== "enforce"
  ) {
    throw new Error("Cannot enforce a repository that is not in report-only or enforce mode");
  }
  const requiredCodes = new Set([
    "repository-access",
    "app-access",
    "configuration",
    "configuration-pin",
    "repository-configuration",
    "workflow-pin",
    "generated-caller",
    "image-configuration",
    "dast-configuration",
    "expected-run",
    "security-gate-check",
    "baseline",
    "report-only-observation"
  ]);
  const failures = diagnosis.checks.filter(
    (check) => requiredCodes.has(check.code) && !check.ok
  );
  if (failures.length) {
    throw new Error(
      `Cannot enforce until prerequisites pass: ${failures
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")}`
    );
  }

  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const configFile = await context.github.getFile(
    owner,
    repo,
    CONFIG_PATH,
    metadata.default_branch
  );
  if (!configFile) throw new Error("Repository configuration disappeared during enforcement");
  const config = parseGuardianConfig(configFile.content);
  const transitioning = config.scanners.mode === "report-only";
  config.scanners.mode = "enforce";
  const ruleset = buildSecurityGateRuleset(diagnosis.facts.requiredCheckName);

  let rulesetAction: EnforceResult["rulesetAction"];
  if (diagnosis.facts.rulesetReady) {
    rulesetAction = "unchanged";
  } else if (context.dryRun) {
    rulesetAction = diagnosis.facts.rulesetId ? "planned-update" : "planned-create";
  } else if (diagnosis.facts.rulesetId) {
    await context.github.request(
      "PUT",
      `/repos/${owner}/${repo}/rulesets/${diagnosis.facts.rulesetId}`,
      ruleset
    );
    rulesetAction = "updated";
  } else {
    await context.github.request("POST", `/repos/${owner}/${repo}/rulesets`, ruleset);
    rulesetAction = "created";
  }

  let url: string | undefined;
  if (transitioning && !context.dryRun) {
    const branch = branchName("enforce");
    await context.github.createBranch(owner, repo, branch, metadata.default_branch);
    await context.github.putFile(
      owner,
      repo,
      CONFIG_PATH,
      branch,
      "chore(guardianbot): enable deterministic enforcement",
      serializeGuardianConfig(config),
      configFile.sha
    );
    const pull = await context.github.createPullRequest(owner, repo, {
      title: "chore: enforce GuardianBot security gate",
      head: branch,
      base: metadata.default_branch,
      draft: true,
      body: [
        "Transitions deterministic scanners from `report-only` to `enforce`.",
        "",
        `- Reviewed baseline: ${diagnosis.facts.baselineCount ?? 0} fingerprints`,
        `- Report-only observation started: ${diagnosis.facts.reportOnlySince}`,
        `- Required check: \`${diagnosis.facts.requiredCheckName}\``,
        "",
        "Pull-request checks stay report-only because they bind the base-branch configuration.",
        "Merge only after ordinary checks and human review.",
        "Immediately after merge, verify the first enforce-mode default-branch gate and revert or disable enforcement if it fails."
      ].join("\n")
    });
    url = pull.html_url;
  }
  return {
    dryRun: Boolean(context.dryRun),
    changed: transitioning || rulesetAction !== "unchanged",
    url,
    ruleset,
    rulesetAction,
    configurationTransition: transitioning
      ? "report-only-to-enforce"
      : "already-enforced"
  };
}

export interface OffboardPlan {
  removeRepositoryFiles: string[];
  retainRepositoryFiles: string[];
  retainCentralEvidence: true;
  rulesetAction:
    | "remove GuardianBot required-check rule immediately before merging the offboarding PR"
    | "no GuardianBot required-check rule was observed"
    | "verify and remove any GuardianBot required-check rule before merge; rules were not observable";
  appAccessAction:
    | "remove repository access from the GuardianBot App after the offboarding PR merges"
    | "GuardianBot App repository access was not observed"
    | "verify App repository access manually after merge; installation access was not observable";
}

export interface OffboardResult {
  url?: string;
  changed: boolean;
  plan: OffboardPlan;
}

export async function offboard(
  context: CommandContext,
  repository: string
): Promise<OffboardResult> {
  const { owner, repo } = parseRepository(repository);
  const metadata = await context.github.getRepository(owner, repo);
  const [configFile, workflowFile, onboardingEvidence, baselineEvidence, appAccess] =
    await Promise.all([
      context.github.getFile(owner, repo, CONFIG_PATH, metadata.default_branch),
      context.github.getFile(owner, repo, CALLER_WORKFLOW_PATH, metadata.default_branch),
      context.github.getFile(owner, repo, ONBOARDING_REPORT_PATH, metadata.default_branch),
      context.github.getFile(owner, repo, BASELINE_PATH, metadata.default_branch),
      inspectAppAccess(context, owner, repo)
    ]);

  if (configFile) {
    try {
      parseGuardianConfig(configFile.content);
    } catch (error) {
      throw new Error(
        `Refusing automatic offboard because ${CONFIG_PATH} is not a recognized GuardianBot configuration: ${errorMessage(
          error
        )}`
      );
    }
  }
  if (workflowFile) {
    const marker = workflowFile.content.includes("# Generated by guardianctl.");
    const managedPins = managedWorkflowPins(
      workflowFile.content,
      context.guardianRepository
    );
    if (!marker || !managedPins.length) {
      throw new Error(
        `Refusing automatic offboard because ${CALLER_WORKFLOW_PATH} is not a recognized generated GuardianBot caller`
      );
    }
  }

  let ruleset: RulesetInspection | undefined;
  try {
    ruleset = await inspectRulesets(
      context.github,
      owner,
      repo,
      metadata.default_branch,
      DEFAULT_SECURITY_GATE_CHECK
    );
  } catch {
    ruleset = undefined;
  }
  const removeRepositoryFiles = [
    configFile ? CONFIG_PATH : undefined,
    workflowFile ? CALLER_WORKFLOW_PATH : undefined
  ].filter((value): value is string => Boolean(value));
  const retainRepositoryFiles = [
    onboardingEvidence ? ONBOARDING_REPORT_PATH : undefined,
    baselineEvidence ? BASELINE_PATH : undefined
  ].filter((value): value is string => Boolean(value));
  const plan: OffboardPlan = {
    removeRepositoryFiles,
    retainRepositoryFiles,
    retainCentralEvidence: true,
    rulesetAction: ruleset?.ready || ruleset?.ownedRulesetId
      ? "remove GuardianBot required-check rule immediately before merging the offboarding PR"
      : ruleset?.observable
        ? "no GuardianBot required-check rule was observed"
        : "verify and remove any GuardianBot required-check rule before merge; rules were not observable",
    appAccessAction:
      appAccess.state === "installed" || appAccess.state === "suspended"
        ? "remove repository access from the GuardianBot App after the offboarding PR merges"
        : appAccess.state === "missing"
          ? "GuardianBot App repository access was not observed"
          : "verify App repository access manually after merge; installation access was not observable"
  };
  if (!removeRepositoryFiles.length) return { changed: false, plan };
  if (context.dryRun) return { changed: true, plan };

  const branch = branchName("offboard");
  await context.github.createBranch(owner, repo, branch, metadata.default_branch);
  for (const path of removeRepositoryFiles) {
    const file = path === CONFIG_PATH ? configFile : workflowFile;
    await context.github.deleteFile(
      owner,
      repo,
      path,
      branch,
      "chore(guardianbot): remove repository caller",
      file!.sha
    );
  }
  const pull = await context.github.createPullRequest(owner, repo, {
    title: "chore: offboard GuardianBot",
    head: branch,
    base: metadata.default_branch,
    draft: true,
    body: [
      "Removes only the repository configuration and generated caller.",
      "",
      `Retained repository evidence: ${
        retainRepositoryFiles.length ? retainRepositoryFiles.map((path) => `\`${path}\``).join(", ") : "none present"
      }.`,
      "GitHub Actions artifacts, GuardianBot control-plane records, installation events, and audit evidence are not deleted.",
      "",
      "Before merging this PR:",
      `- ${plan.rulesetAction}.`,
      "",
      "After this PR merges:",
      `- ${plan.appAccessAction}.`
    ].join("\n")
  });
  return { changed: true, url: pull.html_url, plan };
}
