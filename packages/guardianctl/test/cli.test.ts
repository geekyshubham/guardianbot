import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GitHubClient,
  generateCallerWorkflow,
  parseGuardianConfig,
  serializeGuardianConfig,
  type GitHubRepository,
  type GuardianConfig
} from "@guardianbot/core";
import {
  BASELINE_PATH,
  BASELINE_SCHEMA_VERSION,
  CALLER_WORKFLOW_PATH,
  CONFIG_PATH,
  DEFAULT_SECURITY_GATE_CHECK,
  ONBOARDING_REPORT_PATH,
  PLACEHOLDER_WORKFLOW_SHA,
  baseline,
  buildBaselineDocument,
  buildSecurityGateRuleset,
  callerWorkflowMatches,
  doctor,
  enforce,
  inspectBaselineContent,
  inventory,
  offboard,
  parseGateForBaseline,
  parseRepository,
  serializeBaselineDocument,
  sha256Hex,
  upgrade,
  upgradeAll,
  type CommandContext
} from "../src/index.js";

const WORKFLOW_SHA = "a".repeat(40);
const OLD_WORKFLOW_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const OLD_HEAD_SHA = "d".repeat(40);
const FINGERPRINT = "e".repeat(64);
const NOW = new Date("2026-07-27T06:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function guardianConfig(
  mode: GuardianConfig["scanners"]["mode"] = "report-only",
  options: {
    workflowSha?: string;
    image?: GuardianConfig["image"];
    dast?: GuardianConfig["dast"];
  } = {}
): GuardianConfig {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: options.workflowSha ?? WORKFLOW_SHA,
    repository: {
      defaultBranch: "main",
      releaseBranches: ["main"],
      languages: ["typescript"],
      relatedRepositories: []
    },
    review: {
      automatic: true,
      drafts: "manual",
      incremental: true,
      maxInlineComments: 8,
      categories: ["security", "logic", "testing"],
      highRiskPaths: [".github/workflows/**"],
      contextDocuments: ["README.md"],
      excludedPaths: ["dist/**"]
    },
    scanners: {
      mode,
      semgrep: mode !== "advisory",
      trivy: mode !== "advisory",
      suppressions: []
    },
    image: options.image ?? null,
    dast: options.dast ?? null
  };
}

function workflowFor(config: GuardianConfig, workflowSha = WORKFLOW_SHA): string {
  return generateCallerWorkflow({
    guardianRepository: "Acme/guardianbot",
    workflowSha,
    defaultBranch: "main",
    scannerMode: config.scanners.mode,
    image: config.image,
    dast: config.dast
  });
}

interface MockWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string;
  head_sha: string;
  created_at: string;
  html_url: string;
}

interface MockCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string;
  html_url?: string;
}

interface MockWorkflowJob {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

interface MockRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions: {
    ref_name: { include: string[]; exclude: string[] };
  };
  rules: ReturnType<typeof buildSecurityGateRuleset>["rules"];
}

interface MockRepositoryState {
  metadata: GitHubRepository;
  files: Map<string, { content: string; sha: string }>;
  historicalFiles: Map<string, Map<string, { content: string; sha: string }>>;
  configCommits: Array<{ sha: string; date: string }>;
  workflowRuns: MockWorkflowRun[];
  checkRuns: Map<string, MockCheckRun[]>;
  runJobs: Map<number, MockWorkflowJob[]>;
  rulesets: MockRuleset[];
  branchProtection?: {
    strict: boolean;
    contexts: string[];
  };
  appAccess: boolean;
}

function repositoryMetadata(
  name: string,
  options: Partial<GitHubRepository> = {}
): GitHubRepository {
  return {
    full_name: `acme/${name}`,
    name,
    owner: { login: "acme" },
    default_branch: "main",
    private: false,
    archived: false,
    fork: false,
    ...options
  };
}

function healthyState(
  name = "service",
  options: {
    mode?: GuardianConfig["scanners"]["mode"];
    image?: GuardianConfig["image"];
    dast?: GuardianConfig["dast"];
    appAccess?: boolean;
  } = {}
): MockRepositoryState {
  const mode = options.mode ?? "report-only";
  const config = guardianConfig(mode, {
    image: options.image,
    dast: options.dast
  });
  const files = new Map<string, { content: string; sha: string }>([
    [CONFIG_PATH, { content: serializeGuardianConfig(config), sha: "config-sha" }],
    [
      CALLER_WORKFLOW_PATH,
      { content: workflowFor(config), sha: "workflow-sha" }
    ],
    [
      BASELINE_PATH,
      {
        content: JSON.stringify({ fingerprints: [FINGERPRINT] }),
        sha: "baseline-sha"
      }
    ],
    [
      ONBOARDING_REPORT_PATH,
      { content: "# GuardianBot onboarding evidence\n", sha: "onboarding-sha" }
    ]
  ]);
  const historicalFiles = new Map<
    string,
    Map<string, { content: string; sha: string }>
  >();
  const configCommits: Array<{ sha: string; date: string }> = [];
  if (mode === "enforce") {
    const enforceCommit = "1".repeat(40);
    const reportCommit = "2".repeat(40);
    configCommits.push(
      { sha: enforceCommit, date: daysAgo(1) },
      { sha: reportCommit, date: daysAgo(10) }
    );
    historicalFiles.set(
      enforceCommit,
      new Map([
        [
          CONFIG_PATH,
          { content: serializeGuardianConfig(config), sha: "config-enforce" }
        ]
      ])
    );
    historicalFiles.set(
      reportCommit,
      new Map([
        [
          CONFIG_PATH,
          {
            content: serializeGuardianConfig(guardianConfig("report-only")),
            sha: "config-report"
          }
        ]
      ])
    );
  } else {
    const reportCommit = "3".repeat(40);
    configCommits.push({ sha: reportCommit, date: daysAgo(10) });
    historicalFiles.set(
      reportCommit,
      new Map([
        [
          CONFIG_PATH,
          { content: serializeGuardianConfig(config), sha: "config-report" }
        ]
      ])
    );
  }
  // Newest is a successful DAST-only schedule (gate skipped). Security evidence
  // and baseline binding come from the fresh push (id 200 / GATE_RUN_ID).
  const workflowRuns: MockWorkflowRun[] = [
    {
      id: 300,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(1),
      html_url: "https://github.example/actions/runs/300"
    },
    {
      id: 200,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(2),
      html_url: "https://github.example/actions/runs/200"
    },
    {
      id: 100,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: OLD_HEAD_SHA,
      created_at: daysAgo(8),
      html_url: "https://github.example/actions/runs/100"
    }
  ];
  const rulesets =
    mode === "enforce"
      ? [
          {
            id: 42,
            ...buildSecurityGateRuleset(DEFAULT_SECURITY_GATE_CHECK)
          }
        ]
      : [];
  return {
    metadata: repositoryMetadata(name),
    files,
    historicalFiles,
    configCommits,
    workflowRuns,
    checkRuns: new Map([
      [
        HEAD_SHA,
        [
          {
            name: "guardianbot/security-gate",
            status: "completed",
            conclusion: "skipped",
            details_url: "https://github.example/actions/runs/300/job/1"
          },
          {
            name: DEFAULT_SECURITY_GATE_CHECK,
            status: "completed",
            conclusion: "success",
            details_url: "https://github.example/actions/runs/200/job/2"
          }
        ]
      ],
      [
        OLD_HEAD_SHA,
        [
          {
            name: DEFAULT_SECURITY_GATE_CHECK,
            status: "completed",
            conclusion: "success",
            details_url: "https://github.example/actions/runs/100/job/3"
          }
        ]
      ]
    ]),
    runJobs: new Map([
      [
        300,
        [
          {
            name: "guardianbot/security-gate",
            status: "completed",
            conclusion: "skipped"
          },
          {
            name: "guardianbot/dast-smoke",
            status: "completed",
            conclusion: "success"
          }
        ]
      ],
      [
        200,
        [
          {
            name: DEFAULT_SECURITY_GATE_CHECK,
            status: "completed",
            conclusion: "success"
          }
        ]
      ],
      [
        100,
        [
          {
            name: DEFAULT_SECURITY_GATE_CHECK,
            status: "completed",
            conclusion: "success"
          }
        ]
      ]
    ]),
    rulesets,
    appAccess: options.appAccess ?? true
  };
}

class MockGitHub {
  readonly states = new Map<string, MockRepositoryState>();
  readonly requests: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly branches: Array<{
    owner: string;
    repo: string;
    branch: string;
    base: string;
  }> = [];
  readonly writes: Array<{
    owner: string;
    repo: string;
    path: string;
    branch: string;
    content: string;
    sha?: string;
  }> = [];
  readonly deletions: Array<{
    owner: string;
    repo: string;
    path: string;
    branch: string;
    sha: string;
  }> = [];
  readonly pulls: Array<{
    owner: string;
    repo: string;
    input: {
      title: string;
      head: string;
      base: string;
      body: string;
      draft?: boolean;
    };
  }> = [];
  appObservable = false;

  add(state: MockRepositoryState): MockRepositoryState {
    this.states.set(state.metadata.full_name.toLowerCase(), state);
    return state;
  }

  private state(owner: string, repo: string): MockRepositoryState {
    const state = this.states.get(`${owner}/${repo}`.toLowerCase());
    if (!state) throw new Error(`Missing mock repository ${owner}/${repo}`);
    return state;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.state(owner, repo).metadata;
  }

  async getTree(owner: string, repo: string): Promise<string[]> {
    return [...this.state(owner, repo).files.keys()];
  }

  async getLanguages(): Promise<Record<string, number>> {
    return { TypeScript: 1000 };
  }

  async getFile(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | undefined> {
    const state = this.state(owner, repo);
    return state.historicalFiles.get(ref)?.get(path) ?? state.files.get(path);
  }

  async listAuthenticatedRepositories(): Promise<GitHubRepository[]> {
    return [...this.states.values()].map((state) => state.metadata);
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    this.requests.push({ method, path, body });
    const url = new URL(path, "https://api.github.test");
    if (url.pathname === "/user/installations") {
      if (!this.appObservable) {
        throw new Error(`GitHub GET ${path} returned 403: not observable`);
      }
      return {
        installations: [{ id: 77, app_slug: "guardianbot", suspended_at: null }]
      } as T;
    }
    if (url.pathname === "/user/installations/77/repositories") {
      return {
        repositories: [...this.states.values()]
          .filter((state) => state.appAccess)
          .map((state) => state.metadata)
      } as T;
    }
    const directInstallation =
      /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (directInstallation) {
      throw new Error(`GitHub GET ${path} returned 403: not observable`);
    }

    const workflowRuns =
      /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/guardianbot\.yml\/runs$/.exec(
        url.pathname
      );
    if (workflowRuns) {
      const state = this.state(workflowRuns[1]!, workflowRuns[2]!);
      return { workflow_runs: state.workflowRuns } as T;
    }
    const runJobs =
      /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (runJobs) {
      const state = this.state(runJobs[1]!, runJobs[2]!);
      const runId = Number(runJobs[3]);
      const all = state.runJobs.get(runId) ?? [];
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const start = (page - 1) * 100;
      return { jobs: all.slice(start, start + 100) } as T;
    }
    const checkRuns =
      /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/.exec(
        url.pathname
      );
    if (checkRuns) {
      const state = this.state(checkRuns[1]!, checkRuns[2]!);
      const all =
        state.checkRuns.get(decodeURIComponent(checkRuns[3]!)) ?? [];
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const start = (page - 1) * 100;
      return { check_runs: all.slice(start, start + 100) } as T;
    }
    const commits = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(url.pathname);
    if (
      commits &&
      [CONFIG_PATH, CALLER_WORKFLOW_PATH].includes(
        url.searchParams.get("path") ?? ""
      )
    ) {
      const state = this.state(commits[1]!, commits[2]!);
      return state.configCommits.map((commit) => ({
        sha: commit.sha,
        commit: { committer: { date: commit.date } }
      })) as T;
    }
    const rulesetList = /^\/repos\/([^/]+)\/([^/]+)\/rulesets$/.exec(
      url.pathname
    );
    if (rulesetList && method === "GET") {
      return [...this.state(rulesetList[1]!, rulesetList[2]!).rulesets] as T;
    }
    if (rulesetList && method === "POST") {
      const state = this.state(rulesetList[1]!, rulesetList[2]!);
      state.rulesets.push({ id: 900, ...(body as Omit<MockRuleset, "id">) });
      return { id: 900, ...(body as object) } as T;
    }
    const rulesetDetail =
      /^\/repos\/([^/]+)\/([^/]+)\/rulesets\/(\d+)$/.exec(url.pathname);
    if (rulesetDetail && method === "GET") {
      const state = this.state(rulesetDetail[1]!, rulesetDetail[2]!);
      const found = state.rulesets.find(
        (ruleset) => ruleset.id === Number(rulesetDetail[3])
      );
      if (!found) throw new Error(`GitHub GET ${path} returned 404: missing`);
      return found as T;
    }
    if (rulesetDetail && method === "PUT") {
      const state = this.state(rulesetDetail[1]!, rulesetDetail[2]!);
      const id = Number(rulesetDetail[3]);
      const index = state.rulesets.findIndex((ruleset) => ruleset.id === id);
      const updated = { id, ...(body as Omit<MockRuleset, "id">) };
      if (index === -1) state.rulesets.push(updated);
      else state.rulesets[index] = updated;
      return updated as T;
    }
    const protection =
      /^\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)\/protection\/required_status_checks$/.exec(
        url.pathname
      );
    if (protection) {
      const value = this.state(protection[1]!, protection[2]!).branchProtection;
      if (!value) throw new Error(`GitHub GET ${path} returned 404: missing`);
      return value as T;
    }
    throw new Error(`Unexpected mock GitHub request: ${method} ${path}`);
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    base: string
  ): Promise<void> {
    this.branches.push({ owner, repo, branch, base });
  }

  async putFile(
    owner: string,
    repo: string,
    path: string,
    branch: string,
    _message: string,
    content: string,
    sha?: string
  ): Promise<{ content: { sha: string } }> {
    this.writes.push({ owner, repo, path, branch, content, sha });
    return { content: { sha: "new-sha" } };
  }

  async deleteFile(
    owner: string,
    repo: string,
    path: string,
    branch: string,
    _message: string,
    sha: string
  ): Promise<void> {
    this.deletions.push({ owner, repo, path, branch, sha });
  }

  async createPullRequest(
    owner: string,
    repo: string,
    input: {
      title: string;
      head: string;
      base: string;
      body: string;
      draft?: boolean;
    }
  ): Promise<{ number: number; html_url: string }> {
    this.pulls.push({ owner, repo, input });
    return { number: this.pulls.length, html_url: `https://github.example/pull/${this.pulls.length}` };
  }
}

function commandContext(
  github: MockGitHub,
  overrides: Partial<CommandContext> = {}
): CommandContext {
  return {
    github: github as unknown as GitHubClient,
    guardianRepository: "Acme/guardianbot",
    workflowSha: WORKFLOW_SHA,
    now: () => NOW,
    ...overrides
  };
}

function checkByCode(
  result: Awaited<ReturnType<typeof doctor>>,
  code: string
) {
  const found = result.checks.find((check) => check.code === code);
  assert.ok(
    found,
    `missing doctor check ${code}: ${JSON.stringify(result.checks, null, 2)}`
  );
  return found;
}

test("repository parser and immutable caller comparison remain backward compatible", () => {
  assert.deepEqual(parseRepository("Geekyshubham/guardianbot"), {
    owner: "Geekyshubham",
    repo: "guardianbot"
  });
  assert.throws(() => parseRepository("guardianbot"));
  assert.equal(callerWorkflowMatches("name: GuardianBot\r\n", "name: GuardianBot\n"), true);
  assert.equal(
    callerWorkflowMatches(
      "runtime-env: |\n  NODE_ENV=production\n",
      "runtime-env: |\n  NODE_ENV=development\n"
    ),
    false
  );
  assert.equal(
    callerWorkflowMatches(
      "    uses: geekyshubham/guardianbot/.github/workflows/reusable-security.yml@abc\n",
      "    uses: Geekyshubham/GuardianBot/.github/workflows/reusable-security.yml@abc\n"
    ),
    true
  );
});

test("doctor verifies fresh runs, the real gate check, baseline, observation age, and App observability", async () => {
  const github = new MockGitHub();
  github.add(healthyState());
  github.appObservable = true;

  const result = await doctor(commandContext(github), "acme/service");

  assert.equal(result.status, "ready");
  assert.equal(result.enforcementReady, true);
  assert.equal(result.facts.appAccess, "installed");
  assert.equal(result.facts.requiredCheckName, DEFAULT_SECURITY_GATE_CHECK);
  assert.equal(result.facts.baselineCount, 1);
  assert.ok((result.facts.reportOnlyAgeDays ?? 0) >= 7);
  assert.equal(checkByCode(result, "expected-run").ok, true);
  assert.equal(checkByCode(result, "security-gate-check").ok, true);
  assert.equal(checkByCode(result, "baseline").ok, true);
  assert.equal(checkByCode(result, "report-only-observation").ok, true);
  assert.match(checkByCode(result, "app-access").detail, /installation 77/);
});

test("doctor reports observable missing App access as a configured repository failure", async () => {
  const github = new MockGitHub();
  github.add(healthyState("service", { appAccess: false }));
  github.appObservable = true;

  const result = await doctor(commandContext(github), "acme/service");

  assert.equal(result.status, "misconfigured");
  assert.equal(result.enforcementReady, false);
  assert.equal(result.facts.appAccess, "missing");
  assert.equal(checkByCode(result, "app-access").blocking, true);
  assert.match(checkByCode(result, "app-access").detail, /has no access/);
});

test("doctor catches the self-onboarding image drift and upgrade regenerates it at the same pin", async () => {
  const github = new MockGitHub();
  const image: NonNullable<GuardianConfig["image"]> = {
    dockerfile: "Dockerfile",
    context: ".",
    platform: "linux/amd64",
    registry: "ghcr.io/acme/service",
    healthPath: "/health",
    readinessPath: "/ready",
    containerPort: 8080,
    sbomFormat: "cyclonedx-json",
    dependentServices: []
  };
  const state = github.add(healthyState("service", { image }));
  state.files.set("Dockerfile", { content: "FROM scratch\n", sha: "dockerfile-sha" });
  state.files.set(CALLER_WORKFLOW_PATH, {
    content: workflowFor(guardianConfig("report-only")),
    sha: "workflow-sha"
  });

  const diagnosis = await doctor(commandContext(github), "acme/service");
  assert.equal(diagnosis.status, "misconfigured");
  assert.equal(checkByCode(diagnosis, "image-configuration").ok, true);
  assert.equal(checkByCode(diagnosis, "generated-caller").ok, false);

  const result = await upgrade(commandContext(github), "acme/service");
  assert.equal(result.changed, true);
  assert.deepEqual(github.writes.map((write) => write.path), [CALLER_WORKFLOW_PATH]);
  assert.match(github.writes[0]!.content, /guardianbot-image:/);
  assert.match(github.writes[0]!.content, new RegExp(`@${WORKFLOW_SHA}`));
});

test("doctor rejects inconsistent DAST contracts", async () => {
  const github = new MockGitHub();
  const dast: NonNullable<GuardianConfig["dast"]> = {
    allowedOrigin: "https://localhost",
    openapi: "/openapi.json",
    authenticationProfile: "repository-secret",
    sessionAssertionPath: "/api/session",
    excludedRoutes: ["admin/reset"]
  };
  github.add(healthyState("service", { dast }));

  const result = await doctor(commandContext(github), "acme/service");

  assert.equal(result.status, "misconfigured");
  const dastCheck = checkByCode(result, "dast-configuration");
  assert.equal(dastCheck.ok, false);
  assert.match(dastCheck.detail, /control-plane/);
  assert.match(dastCheck.detail, /local or link-local/);
  assert.match(dastCheck.detail, /excluded route/);
});

test("doctor verifies optional image build context and repository-relative paths", async () => {
  const github = new MockGitHub();
  const image: NonNullable<GuardianConfig["image"]> = {
    dockerfile: "ops/Dockerfile",
    context: "missing-context",
    platform: "linux/amd64",
    registry: "ghcr.io/acme/service",
    healthPath: "/health",
    sbomFormat: "cyclonedx-json"
  };
  const state = github.add(healthyState("service", { image }));
  state.files.set("ops/Dockerfile", {
    content: "FROM scratch\n",
    sha: "dockerfile-sha"
  });

  const result = await doctor(commandContext(github), "acme/service");

  assert.equal(result.status, "misconfigured");
  assert.equal(checkByCode(result, "image-configuration").ok, false);
  assert.match(
    checkByCode(result, "image-configuration").detail,
    /build context not found/
  );
});

test("inventory distinguishes stale or absent expected gate evidence", async () => {
  const staleGitHub = new MockGitHub();
  const stale = staleGitHub.add(healthyState("stale"));
  stale.workflowRuns = stale.workflowRuns.map((run) => ({
    ...run,
    created_at: daysAgo(3)
  }));
  const staleRows = await inventory(commandContext(staleGitHub));
  assert.equal(staleRows[0]!.status, "missing-expected-runs");
  assert.match(staleRows[0]!.detail, /maximum is 36|no guardianbot\/security-gate evidence within/);

  const missingGateGitHub = new MockGitHub();
  const missingGate = missingGateGitHub.add(healthyState("missing-gate"));
  missingGate.checkRuns.set(HEAD_SHA, []);
  missingGate.runJobs.set(200, []);
  missingGate.runJobs.set(300, [
    {
      name: "guardianbot/dast-smoke",
      status: "completed",
      conclusion: "success"
    }
  ]);
  const missingRows = await inventory(commandContext(missingGateGitHub));
  assert.equal(missingRows[0]!.status, "missing-expected-runs");
  assert.match(
    missingRows[0]!.detail,
    /no guardianbot\/security-gate evidence|qualifying security run/
  );
});

test("fresh runs that predate the current caller or configuration are still stale", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("changed-after-run"));
  const latestChange = "5".repeat(40);
  state.configCommits = [{ sha: latestChange, date: hoursAgo(0.5) }];
  state.historicalFiles.set(
    latestChange,
    new Map([
      [
        CONFIG_PATH,
        {
          content: state.files.get(CONFIG_PATH)!.content,
          sha: "latest-config"
        }
      ]
    ])
  );

  const result = await doctor(commandContext(github), "acme/changed-after-run");

  assert.equal(result.status, "misconfigured");
  assert.equal(checkByCode(result, "expected-run").state, "stale");
  assert.match(checkByCode(result, "expected-run").detail, /predates managed/);
});

test("doctor ignores a later DAST-only schedule with a skipped gate after a fresh push gate", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("dast-after-push"));
  // Explicit production shape: push gate success, later schedule skips the gate.
  assert.equal(state.workflowRuns[0]!.event, "schedule");
  assert.equal(state.workflowRuns[1]!.event, "push");
  assert.equal(
    state.runJobs.get(300)?.find((job) => job.name.startsWith("guardianbot/security-gate"))
      ?.conclusion,
    "skipped"
  );

  const result = await doctor(commandContext(github), "acme/dast-after-push");
  const rows = await inventory(commandContext(github));

  assert.equal(result.status, "ready");
  assert.equal(checkByCode(result, "security-gate-check").ok, true);
  assert.match(checkByCode(result, "security-gate-check").detail, /run 200/);
  assert.doesNotMatch(checkByCode(result, "security-gate-check").detail, /skipped/);
  assert.equal(result.facts.latestRunId, 200);
  assert.equal(result.facts.latestRunHeadSha, HEAD_SHA);
  assert.equal(rows[0]!.status, "report-only");
});

test("doctor fail-closes on a later qualifying security run with a failed gate", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("later-failed-gate"));
  state.workflowRuns = [
    {
      id: 400,
      status: "completed",
      conclusion: "failure",
      event: "push",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(0.5),
      html_url: "https://github.example/actions/runs/400"
    },
    ...state.workflowRuns
  ];
  state.runJobs.set(400, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "failure"
    }
  ]);
  state.checkRuns.set(HEAD_SHA, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.example/actions/runs/400/job/9"
    },
    ...(state.checkRuns.get(HEAD_SHA) ?? [])
  ]);

  const result = await doctor(commandContext(github), "acme/later-failed-gate");
  const rows = await inventory(commandContext(github));

  assert.equal(checkByCode(result, "security-gate-check").ok, false);
  assert.match(checkByCode(result, "security-gate-check").detail, /failure/);
  assert.match(checkByCode(result, "security-gate-check").detail, /run 400/);
  assert.equal(result.facts.latestRunId, 400);
  assert.equal(result.status, "misconfigured");
  assert.equal(rows[0]!.status, "misconfigured");
});

test("doctor fail-closes on a later push with no gate and cannot reuse older success", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("later-push-no-gate"));
  state.workflowRuns = [
    {
      id: 410,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(0.5),
      html_url: "https://github.example/actions/runs/410"
    },
    ...state.workflowRuns
  ];
  // Newer push has other jobs but no security-gate job or check.
  state.runJobs.set(410, [
    {
      name: "guardianbot/dast-smoke",
      status: "completed",
      conclusion: "success"
    }
  ]);

  const result = await doctor(commandContext(github), "acme/later-push-no-gate");
  const rows = await inventory(commandContext(github));

  assert.equal(checkByCode(result, "security-gate-check").ok, false);
  assert.match(
    checkByCode(result, "security-gate-check").detail,
    /push run 410 has no guardianbot\/security-gate/
  );
  assert.doesNotMatch(checkByCode(result, "security-gate-check").detail, /run 200/);
  assert.equal(result.facts.latestRunId, 410);
  assert.equal(result.status, "misconfigured");
  assert.equal(rows[0]!.status, "missing-expected-runs");
});

test("doctor fail-closes on a later push with a skipped gate and cannot reuse older success", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("later-push-skipped-gate"));
  state.workflowRuns = [
    {
      id: 420,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(0.5),
      html_url: "https://github.example/actions/runs/420"
    },
    ...state.workflowRuns
  ];
  state.runJobs.set(420, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "skipped"
    }
  ]);
  state.checkRuns.set(HEAD_SHA, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "skipped",
      details_url: "https://github.example/actions/runs/420/job/9"
    },
    ...(state.checkRuns.get(HEAD_SHA) ?? [])
  ]);

  const result = await doctor(commandContext(github), "acme/later-push-skipped-gate");
  const rows = await inventory(commandContext(github));

  assert.equal(checkByCode(result, "security-gate-check").ok, false);
  assert.match(checkByCode(result, "security-gate-check").detail, /skipped/);
  assert.match(checkByCode(result, "security-gate-check").detail, /run 420/);
  assert.match(
    checkByCode(result, "security-gate-check").detail,
    /must not skip the security gate/
  );
  assert.equal(result.facts.latestRunId, 420);
  assert.equal(result.status, "misconfigured");
  assert.equal(rows[0]!.status, "misconfigured");
});

test("doctor fail-closes on a later schedule with a non-skipped failed gate", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("later-schedule-failed-gate"));
  state.workflowRuns = [
    {
      id: 430,
      status: "completed",
      conclusion: "failure",
      event: "schedule",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(0.5),
      html_url: "https://github.example/actions/runs/430"
    },
    ...state.workflowRuns
  ];
  state.runJobs.set(430, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "failure"
    }
  ]);
  state.checkRuns.set(HEAD_SHA, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.example/actions/runs/430/job/9"
    },
    ...(state.checkRuns.get(HEAD_SHA) ?? [])
  ]);

  const result = await doctor(commandContext(github), "acme/later-schedule-failed-gate");
  const rows = await inventory(commandContext(github));

  assert.equal(checkByCode(result, "security-gate-check").ok, false);
  assert.match(checkByCode(result, "security-gate-check").detail, /failure/);
  assert.match(checkByCode(result, "security-gate-check").detail, /run 430/);
  assert.equal(result.facts.latestRunId, 430);
  assert.equal(result.status, "misconfigured");
  assert.equal(rows[0]!.status, "misconfigured");
});

test("doctor accepts a later schedule with a non-skipped successful gate", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("later-schedule-success-gate"));
  // Replace the default DAST-only newest schedule with a security-bearing one.
  state.workflowRuns = [
    {
      id: 440,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(0.5),
      html_url: "https://github.example/actions/runs/440"
    },
    state.workflowRuns.find((run) => run.id === 200)!,
    state.workflowRuns.find((run) => run.id === 100)!
  ];
  state.runJobs.set(440, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "success"
    }
  ]);
  state.checkRuns.set(HEAD_SHA, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "success",
      details_url: "https://github.example/actions/runs/440/job/1"
    }
  ]);

  const result = await doctor(commandContext(github), "acme/later-schedule-success-gate");

  assert.equal(checkByCode(result, "security-gate-check").ok, true);
  assert.match(checkByCode(result, "security-gate-check").detail, /run 440/);
  assert.equal(result.facts.latestRunId, 440);
  assert.equal(result.status, "ready");
});

test("doctor fail-closes when workflow job pagination exceeds the safe page cap", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("job-page-cap"));
  // 10 pages of 100 full-size batches without a terminal short page.
  state.runJobs.set(
    300,
    Array.from({ length: 1000 }, (_, index) => ({
      name: `filler-job-${index}`,
      status: "completed",
      conclusion: "success"
    }))
  );

  const result = await doctor(commandContext(github), "acme/job-page-cap");

  assert.equal(checkByCode(result, "security-gate-check").ok, false);
  assert.match(
    checkByCode(result, "security-gate-check").detail,
    /exceeded 10 pages|fail closed/
  );
});

test("doctor associates same-SHA duplicate gate checks to their Actions run", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("same-sha-dupes"));
  // No job metadata: association must come from check details_url run ids only.
  state.runJobs = new Map();
  state.checkRuns.set(HEAD_SHA, [
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "skipped",
      details_url: "https://github.example/acme/same-sha-dupes/actions/runs/300/job/1"
    },
    {
      name: DEFAULT_SECURITY_GATE_CHECK,
      status: "completed",
      conclusion: "success",
      details_url: "https://github.example/acme/same-sha-dupes/actions/runs/200/job/2"
    }
  ]);

  const result = await doctor(commandContext(github), "acme/same-sha-dupes");

  assert.equal(checkByCode(result, "security-gate-check").ok, true);
  assert.match(checkByCode(result, "security-gate-check").detail, /run 200/);
  assert.equal(result.facts.latestRunId, 200);
  assert.equal(result.status, "ready");
});

test("DAST-only schedules do not start report-only observation or satisfy enforcement timing", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("dast-observation"));
  // Only successful activity after config is a DAST schedule; no push/dispatch.
  state.workflowRuns = [
    {
      id: 500,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: daysAgo(10),
      html_url: "https://github.example/actions/runs/500"
    },
    {
      id: 501,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      head_branch: "main",
      head_sha: HEAD_SHA,
      created_at: hoursAgo(1),
      html_url: "https://github.example/actions/runs/501"
    }
  ];
  state.runJobs = new Map([
    [
      500,
      [
        {
          name: "guardianbot/security-gate",
          status: "completed",
          conclusion: "skipped"
        },
        {
          name: "guardianbot/dast-smoke",
          status: "completed",
          conclusion: "success"
        }
      ]
    ],
    [
      501,
      [
        {
          name: "guardianbot/security-gate",
          status: "completed",
          conclusion: "skipped"
        },
        {
          name: "guardianbot/dast-smoke",
          status: "completed",
          conclusion: "success"
        }
      ]
    ]
  ]);
  state.checkRuns.set(HEAD_SHA, [
    {
      name: "guardianbot/security-gate",
      status: "completed",
      conclusion: "skipped",
      details_url: "https://github.example/actions/runs/501/job/1"
    }
  ]);

  const result = await doctor(commandContext(github), "acme/dast-observation");

  assert.equal(checkByCode(result, "report-only-observation").ok, false);
  assert.match(
    checkByCode(result, "report-only-observation").detail,
    /scheduled runs do not start the clock|push or workflow_dispatch/
  );
  assert.equal(checkByCode(result, "security-gate-check").ok, false);
  assert.equal(result.enforcementReady, false);
});

test("doctor requires the observed gate check in enforced rulesets", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState("service", { mode: "enforce" }));
  state.rulesets = [
    {
      id: 55,
      ...buildSecurityGateRuleset("guardianbot/security-gate")
    }
  ];

  const result = await doctor(commandContext(github), "acme/service");

  assert.equal(result.status, "misconfigured");
  assert.equal(result.enforcementReady, false);
  assert.equal(checkByCode(result, "required-check-rule").ok, false);
  assert.match(
    checkByCode(result, "required-check-rule").detail,
    new RegExp(DEFAULT_SECURITY_GATE_CHECK.replace("/", "\\/"))
  );
});

test("enforce fails closed on a missing baseline or an incomplete seven-day period", async () => {
  const missingBaselineGitHub = new MockGitHub();
  const missingBaseline = missingBaselineGitHub.add(healthyState("missing-baseline"));
  missingBaseline.files.delete(BASELINE_PATH);

  await assert.rejects(
    enforce(commandContext(missingBaselineGitHub), "acme/missing-baseline"),
    /baseline readiness/
  );
  assert.equal(missingBaselineGitHub.requests.some((request) => request.method === "POST"), false);
  assert.equal(missingBaselineGitHub.writes.length, 0);

  const youngGitHub = new MockGitHub();
  const young = youngGitHub.add(healthyState("young"));
  young.configCommits = [{ sha: "4".repeat(40), date: daysAgo(6) }];
  young.historicalFiles.set(
    "4".repeat(40),
    new Map([
      [
        CONFIG_PATH,
        {
          content: serializeGuardianConfig(guardianConfig("report-only")),
          sha: "young-config"
        }
      ]
    ])
  );
  young.workflowRuns[1] = {
    ...young.workflowRuns[1]!,
    created_at: daysAgo(5)
  };

  await assert.rejects(
    enforce(
      commandContext(youngGitHub, { reportOnlyMinimumDays: 1 }),
      "acme/young"
    ),
    /report-only observation/
  );
  assert.equal(youngGitHub.writes.length, 0);
});

test("enforce creates the exact observed required check and opens a reviewed config transition", async () => {
  const github = new MockGitHub();
  github.add(healthyState());

  const result = await enforce(commandContext(github), "acme/service");

  assert.equal(result.changed, true);
  assert.equal(result.rulesetAction, "created");
  assert.equal(result.configurationTransition, "report-only-to-enforce");
  assert.equal(result.ruleset.rules[0]!.parameters.required_status_checks[0]!.context, DEFAULT_SECURITY_GATE_CHECK);
  const createRuleset = github.requests.find(
    (request) => request.method === "POST" && request.path.endsWith("/rulesets")
  );
  assert.ok(createRuleset);
  assert.deepEqual(createRuleset.body, result.ruleset);
  assert.deepEqual(github.writes.map((write) => write.path), [CONFIG_PATH]);
  assert.equal(parseGuardianConfig(github.writes[0]!.content).scanners.mode, "enforce");
  assert.equal(github.pulls.length, 1);
  assert.match(github.pulls[0]!.input.body, /Reviewed baseline: 1 fingerprints/);
  assert.match(github.pulls[0]!.input.body, new RegExp(DEFAULT_SECURITY_GATE_CHECK.replace("/", "\\/")));
});

test("enforce repairs only its named ruleset and dry-run remains side-effect free", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState());
  state.rulesets = [
    {
      id: 81,
      ...buildSecurityGateRuleset("guardianbot/security-gate")
    }
  ];

  const before = await doctor(commandContext(github), "acme/service");
  assert.equal(before.status, "misconfigured");
  assert.equal(checkByCode(before, "required-check-rule").blocking, true);

  const dryRun = await enforce(
    commandContext(github, { dryRun: true }),
    "acme/service"
  );
  assert.equal(dryRun.rulesetAction, "planned-update");
  assert.equal(github.writes.length, 0);
  assert.equal(github.pulls.length, 0);
  assert.equal(
    github.requests.some((request) => ["POST", "PUT"].includes(request.method)),
    false
  );

  const applied = await enforce(commandContext(github), "acme/service");
  assert.equal(applied.rulesetAction, "updated");
  const update = github.requests.find(
    (request) =>
      request.method === "PUT" && request.path.endsWith("/rulesets/81")
  );
  assert.ok(update);
});

test("enforce is idempotent when mode and required protection are already active", async () => {
  const github = new MockGitHub();
  github.add(healthyState("service", { mode: "enforce" }));

  const result = await enforce(commandContext(github), "acme/service");

  assert.equal(result.changed, false);
  assert.equal(result.rulesetAction, "unchanged");
  assert.equal(result.configurationTransition, "already-enforced");
  assert.equal(github.writes.length, 0);
  assert.equal(github.pulls.length, 0);
  assert.equal(
    github.requests.some((request) => ["POST", "PUT"].includes(request.method)),
    false
  );
});

const SECOND_FINGERPRINT = "f".repeat(64);
const GATE_RUN_ID = 200;
const GATE_RUN_ATTEMPT = 1;

function gateJson(options: {
  mode?: string;
  passed?: boolean;
  failures?: unknown[];
  policyFindings?: unknown[];
  schemaVersion?: string;
  repository?: string;
  headSha?: string;
  runId?: number;
  runAttempt?: number;
  omitProvenance?: boolean;
} = {}): string {
  const body: Record<string, unknown> = {
    schemaVersion: options.schemaVersion ?? "1.0.0",
    mode: options.mode ?? "report-only",
    baselineRequired: false,
    baselineCount: 0,
    passed: options.passed ?? true,
    failures: options.failures ?? [],
    policyFindings: options.policyFindings ?? [
      { fingerprint: SECOND_FINGERPRINT, source: "semgrep" },
      { fingerprint: FINGERPRINT, source: "trivy" }
    ],
    activeSuppressions: 0,
    expiredSuppressions: []
  };
  if (!options.omitProvenance) {
    body.repository = options.repository ?? "acme/service";
    body.headSha = options.headSha ?? HEAD_SHA;
    body.runId = options.runId ?? GATE_RUN_ID;
    body.runAttempt = options.runAttempt ?? GATE_RUN_ATTEMPT;
  }
  return JSON.stringify(body);
}

function versionedBaselineSource(overrides: Record<string, unknown> = {}) {
  return {
    gateSha256: "a".repeat(64),
    mode: "report-only",
    repository: "acme/service",
    headSha: HEAD_SHA,
    runId: GATE_RUN_ID,
    runAttempt: GATE_RUN_ATTEMPT,
    ...overrides
  };
}

test("parseGateForBaseline rejects malformed, failed, enforce-mode, and duplicate gates", () => {
  assert.throws(() => parseGateForBaseline("{"), /not valid JSON/);
  assert.throws(
    () => parseGateForBaseline(gateJson({ mode: "enforce" })),
    /mode must be report-only/
  );
  assert.throws(
    () => parseGateForBaseline(gateJson({ passed: false, failures: ["x"] })),
    /passed=true/
  );
  assert.throws(
    () => parseGateForBaseline(gateJson({ failures: ["still-failed"] })),
    /failures must be empty/
  );
  assert.throws(
    () =>
      parseGateForBaseline(
        gateJson({
          policyFindings: [
            { fingerprint: FINGERPRINT },
            { fingerprint: FINGERPRINT }
          ]
        })
      ),
    /duplicate fingerprints/
  );
  assert.throws(
    () =>
      parseGateForBaseline(
        gateJson({
          policyFindings: [{ fingerprint: "not-a-fingerprint" }]
        })
      ),
    /lowercase SHA-256/
  );
  assert.throws(
    () =>
      parseGateForBaseline(
        gateJson({
          policyFindings: [{ noFingerprint: true }]
        })
      ),
    /fingerprint must be a lowercase SHA-256/
  );
  assert.throws(
    () => parseGateForBaseline(gateJson({ omitProvenance: true })),
    /missing repository\/headSha\/runId\/runAttempt provenance/
  );
});

test("parseGateForBaseline sorts fingerprints and digests the exact gate input", () => {
  const source = gateJson();
  const parsed = parseGateForBaseline(source);
  assert.deepEqual(parsed.fingerprints, [FINGERPRINT, SECOND_FINGERPRINT]);
  assert.equal(parsed.gateSha256, sha256Hex(source));
  assert.equal(parsed.gateSha256.length, 64);
  assert.equal(parsed.repository, "acme/service");
  assert.equal(parsed.headSha, HEAD_SHA);
  assert.equal(parsed.runId, GATE_RUN_ID);
  assert.equal(parsed.runAttempt, GATE_RUN_ATTEMPT);
});

test("doctor and inspectBaselineContent accept generated empty versioned baselines only", async () => {
  const emptyVersioned = serializeBaselineDocument(
    buildBaselineDocument(
      [],
      {
        gateSha256: "a".repeat(64),
        repository: "acme/clean-baseline",
        headSha: HEAD_SHA,
        runId: GATE_RUN_ID,
        runAttempt: GATE_RUN_ATTEMPT
      },
      NOW
    )
  );
  assert.equal(inspectBaselineContent(emptyVersioned).ready, true);
  assert.equal(inspectBaselineContent(emptyVersioned).count, 0);
  assert.equal(inspectBaselineContent("[]").ready, false);
  assert.match(inspectBaselineContent("[]").detail, /legacy baseline fingerprint set is empty/);
  assert.equal(inspectBaselineContent(JSON.stringify({ fingerprints: [] })).ready, false);
  assert.match(
    inspectBaselineContent(JSON.stringify({ fingerprints: [] })).detail,
    /legacy baseline fingerprint set is empty/
  );
  assert.equal(
    inspectBaselineContent(
      JSON.stringify({
        schemaVersion: BASELINE_SCHEMA_VERSION,
        fingerprints: [],
        generatedAt: "2026",
        source: versionedBaselineSource()
      })
    ).ready,
    false
  );
  assert.equal(
    inspectBaselineContent(
      JSON.stringify({
        schemaVersion: BASELINE_SCHEMA_VERSION,
        fingerprints: [],
        generatedAt: "2026-07-27T06:00:00Z",
        source: versionedBaselineSource()
      })
    ).ready,
    false
  );
  assert.equal(
    inspectBaselineContent(
      JSON.stringify({
        schemaVersion: BASELINE_SCHEMA_VERSION,
        fingerprints: [],
        generatedAt: NOW.toISOString(),
        source: { gateSha256: "a".repeat(64), mode: "report-only" }
      })
    ).ready,
    false
  );

  const github = new MockGitHub();
  const state = github.add(healthyState("clean-baseline"));
  state.files.set(BASELINE_PATH, {
    content: emptyVersioned,
    sha: "empty-baseline-sha"
  });
  const result = await doctor(commandContext(github), "acme/clean-baseline");
  assert.equal(checkByCode(result, "baseline").ok, true);
  assert.equal(result.facts.baselineCount, 0);
  assert.equal(result.enforcementReady, true);
});

test("baseline opens a deterministic draft PR and stays dry-run/idempotent", async () => {
  const source = gateJson({ repository: "acme/baseline-dry" });
  const parsed = parseGateForBaseline(source);

  const dryGitHub = new MockGitHub();
  const dryState = dryGitHub.add(healthyState("baseline-dry"));
  dryState.files.delete(BASELINE_PATH);
  const dryRun = await baseline(
    commandContext(dryGitHub, { dryRun: true }),
    "acme/baseline-dry",
    source
  );
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.changed, true);
  assert.equal(dryRun.clean, false);
  assert.equal(dryRun.fingerprintCount, 2);
  assert.equal(dryRun.gateSha256, parsed.gateSha256);
  assert.deepEqual(dryRun.baseline.fingerprints, [FINGERPRINT, SECOND_FINGERPRINT]);
  assert.equal(dryRun.baseline.schemaVersion, BASELINE_SCHEMA_VERSION);
  assert.equal(dryRun.baseline.source.mode, "report-only");
  assert.equal(dryRun.baseline.source.repository, "acme/baseline-dry");
  assert.equal(dryRun.baseline.source.headSha, HEAD_SHA);
  assert.equal(dryRun.baseline.source.runId, GATE_RUN_ID);
  assert.equal(dryRun.baseline.source.runAttempt, GATE_RUN_ATTEMPT);
  assert.equal(dryRun.baseline.generatedAt, NOW.toISOString());
  assert.equal(dryGitHub.writes.length, 0);
  assert.equal(dryGitHub.pulls.length, 0);
  assert.equal(dryGitHub.branches.length, 0);

  const openSource = gateJson({ repository: "acme/baseline-open" });
  const openParsed = parseGateForBaseline(openSource);
  const github = new MockGitHub();
  const state = github.add(healthyState("baseline-open"));
  state.files.delete(BASELINE_PATH);
  const opened = await baseline(commandContext(github), "acme/baseline-open", openSource);
  assert.equal(opened.changed, true);
  assert.equal(opened.dryRun, false);
  assert.ok(opened.url);
  assert.deepEqual(github.writes.map((write) => write.path), [BASELINE_PATH]);
  assert.equal(github.writes[0]!.content, opened.baselineJson);
  assert.equal(github.pulls.length, 1);
  assert.equal(github.pulls[0]!.input.draft, true);
  assert.match(github.pulls[0]!.input.body, new RegExp(openParsed.gateSha256));
  assert.match(github.pulls[0]!.input.body, /Fingerprint count: 2/);
  assert.match(github.pulls[0]!.input.body, /Clean repository \(empty baseline\): no/);
  assert.match(github.pulls[0]!.input.body, /Source head SHA/);
  assert.match(github.pulls[0]!.input.body, /Source run/);
  assert.match(github.pulls[0]!.input.body, /human review evidence is this pull request/i);
  assert.equal(
    github.requests.some((request) => ["POST", "PUT"].includes(request.method) && request.path.includes("rulesets")),
    false
  );

  // Mock writes land on the PR branch only; seed the default branch for idempotency.
  state.files.set(BASELINE_PATH, {
    content: opened.baselineJson,
    sha: "baseline-written"
  });
  const idempotent = await baseline(
    commandContext(github),
    "acme/baseline-open",
    openSource
  );
  assert.equal(idempotent.changed, false);
  assert.equal(github.pulls.length, 1);
  assert.equal(github.writes.length, 1);
});

test("baseline rejects wrong repository, run ID, and head SHA without writes", async () => {
  const wrongRepoGitHub = new MockGitHub();
  const wrongRepo = wrongRepoGitHub.add(healthyState("baseline-bind"));
  wrongRepo.files.delete(BASELINE_PATH);
  await assert.rejects(
    baseline(
      commandContext(wrongRepoGitHub),
      "acme/baseline-bind",
      gateJson({ repository: "acme/other" })
    ),
    /does not match requested/
  );
  assert.equal(wrongRepoGitHub.writes.length, 0);
  assert.equal(wrongRepoGitHub.pulls.length, 0);

  const wrongRunGitHub = new MockGitHub();
  const wrongRun = wrongRunGitHub.add(healthyState("baseline-run"));
  wrongRun.files.delete(BASELINE_PATH);
  await assert.rejects(
    baseline(
      commandContext(wrongRunGitHub),
      "acme/baseline-run",
      gateJson({ repository: "acme/baseline-run", runId: 999 })
    ),
    /does not match doctor latest run/
  );
  assert.equal(wrongRunGitHub.writes.length, 0);
  assert.equal(wrongRunGitHub.pulls.length, 0);

  const wrongHeadGitHub = new MockGitHub();
  const wrongHead = wrongHeadGitHub.add(healthyState("baseline-head"));
  wrongHead.files.delete(BASELINE_PATH);
  await assert.rejects(
    baseline(
      commandContext(wrongHeadGitHub),
      "acme/baseline-head",
      gateJson({ repository: "acme/baseline-head", headSha: "f".repeat(40) })
    ),
    /does not match doctor latest run head/
  );
  assert.equal(wrongHeadGitHub.writes.length, 0);
  assert.equal(wrongHeadGitHub.pulls.length, 0);
});

test("baseline rejects incomplete observation, enforce mode, and malformed gates before writes", async () => {
  const source = gateJson({ repository: "acme/young-baseline" });

  const youngGitHub = new MockGitHub();
  const young = youngGitHub.add(healthyState("young-baseline"));
  young.files.delete(BASELINE_PATH);
  young.configCommits = [{ sha: "4".repeat(40), date: daysAgo(6) }];
  young.historicalFiles.set(
    "4".repeat(40),
    new Map([
      [
        CONFIG_PATH,
        {
          content: serializeGuardianConfig(guardianConfig("report-only")),
          sha: "young-config"
        }
      ]
    ])
  );
  young.workflowRuns[1] = {
    ...young.workflowRuns[1]!,
    created_at: daysAgo(5)
  };
  await assert.rejects(
    baseline(commandContext(youngGitHub), "acme/young-baseline", source),
    /report-only observation/
  );
  assert.equal(youngGitHub.writes.length, 0);
  assert.equal(youngGitHub.pulls.length, 0);

  const enforceGitHub = new MockGitHub();
  enforceGitHub.add(healthyState("already-enforce", { mode: "enforce" }));
  await assert.rejects(
    baseline(
      commandContext(enforceGitHub),
      "acme/already-enforce",
      gateJson({ repository: "acme/already-enforce" })
    ),
    /report-only scanner mode/
  );
  assert.equal(enforceGitHub.writes.length, 0);

  const malformedGitHub = new MockGitHub();
  const malformed = malformedGitHub.add(healthyState("malformed-gate"));
  malformed.files.delete(BASELINE_PATH);
  await assert.rejects(
    baseline(
      commandContext(malformedGitHub),
      "acme/malformed-gate",
      gateJson({ mode: "enforce", repository: "acme/malformed-gate" })
    ),
    /mode must be report-only/
  );
  assert.equal(malformedGitHub.writes.length, 0);
});

test("baseline opens a clean empty versioned baseline from a zero-finding gate", async () => {
  const source = gateJson({ repository: "acme/clean-gate", policyFindings: [] });
  const github = new MockGitHub();
  const state = github.add(healthyState("clean-gate"));
  state.files.delete(BASELINE_PATH);

  const result = await baseline(
    commandContext(github),
    "acme/clean-gate",
    source
  );
  assert.equal(result.clean, true);
  assert.equal(result.fingerprintCount, 0);
  assert.deepEqual(result.baseline.fingerprints, []);
  assert.equal(result.baseline.schemaVersion, BASELINE_SCHEMA_VERSION);
  assert.equal(result.baseline.source.repository, "acme/clean-gate");
  assert.equal(result.baseline.source.headSha, HEAD_SHA);
  assert.equal(result.baseline.source.runId, GATE_RUN_ID);
  assert.match(result.report, /Clean repository \(empty baseline\): yes/);
  assert.equal(inspectBaselineContent(result.baselineJson).ready, true);
  assert.equal(github.writes.length, 1);
  assert.equal(github.pulls[0]!.input.draft, true);
});

test("CLI help lists baseline and requires --from-gate", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const help = spawnSync("tsx", [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /baseline/);
  assert.match(help.stdout, /Open a draft baseline PR from a report-only gate\.json/);
  assert.doesNotMatch(help.stdout, /draft reviewed baseline/);
  assert.match(help.stdout, /--from-gate PATH/);

  const missing = spawnSync("tsx", [cliPath, "baseline", "acme/service"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIANBOT_WORKFLOW_SHA: WORKFLOW_SHA,
      GH_TOKEN: "test-token"
    }
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--from-gate PATH/);

  const directory = mkdtempSync(join(tmpdir(), "guardianctl-baseline-"));
  const gatePath = join(directory, "gate.json");
  writeFileSync(gatePath, gateJson({ mode: "enforce" }));
  const badGate = spawnSync(
    "tsx",
    [
      cliPath,
      "baseline",
      "acme/service",
      "--from-gate",
      gatePath,
      "--dry-run"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GUARDIANBOT_WORKFLOW_SHA: WORKFLOW_SHA,
        GH_TOKEN: "test-token"
      }
    }
  );
  assert.notEqual(badGate.status, 0);
  assert.match(badGate.stderr, /mode must be report-only/);
});

test("inventory classifies all production lifecycle states", async () => {
  const github = new MockGitHub();
  github.appObservable = true;

  const archived = healthyState("archived");
  archived.metadata.archived = true;
  github.add(archived);

  const advisory = healthyState("advisory");
  advisory.files.delete(CONFIG_PATH);
  advisory.files.delete(CALLER_WORKFLOW_PATH);
  advisory.files.delete(BASELINE_PATH);
  github.add(advisory);

  const notApplicable = healthyState("not-applicable", { appAccess: false });
  notApplicable.files.delete(CONFIG_PATH);
  notApplicable.files.delete(CALLER_WORKFLOW_PATH);
  notApplicable.files.delete(BASELINE_PATH);
  github.add(notApplicable);

  github.add(healthyState("report"));
  github.add(healthyState("enforced", { mode: "enforce" }));

  const partial = healthyState("partial");
  partial.files.delete(CALLER_WORKFLOW_PATH);
  github.add(partial);

  const missing = healthyState("missing-runs");
  missing.workflowRuns = [];
  github.add(missing);

  const rows = await inventory(commandContext(github));
  const statuses = Object.fromEntries(rows.map((row) => [row.repository, row.status]));

  assert.deepEqual(statuses, {
    "acme/advisory": "advisory-only",
    "acme/archived": "not-applicable",
    "acme/enforced": "enforced",
    "acme/missing-runs": "missing-expected-runs",
    "acme/not-applicable": "not-applicable",
    "acme/partial": "misconfigured",
    "acme/report": "report-only"
  });
});

test("inventory classifies healthy repos without an administrative target workflow SHA", async () => {
  const github = new MockGitHub();
  github.appObservable = true;
  github.add(healthyState("report"));
  github.add(healthyState("enforced", { mode: "enforce" }));

  const advisory = healthyState("advisory");
  advisory.files.delete(CONFIG_PATH);
  advisory.files.delete(CALLER_WORKFLOW_PATH);
  advisory.files.delete(BASELINE_PATH);
  github.add(advisory);

  const rows = await inventory(
    commandContext(github, { workflowSha: PLACEHOLDER_WORKFLOW_SHA })
  );
  const statuses = Object.fromEntries(rows.map((row) => [row.repository, row.status]));

  assert.deepEqual(statuses, {
    "acme/advisory": "advisory-only",
    "acme/enforced": "enforced",
    "acme/report": "report-only"
  });
  for (const row of rows) {
    assert.doesNotMatch(row.detail, /0000000000000000000000000000000000000000/);
  }
});

test("inventory flags config/caller pin mismatch without an administrative target SHA", async () => {
  const github = new MockGitHub();
  github.appObservable = true;
  const state = github.add(healthyState("pin-mismatch"));
  const config = guardianConfig("report-only", { workflowSha: WORKFLOW_SHA });
  state.files.set(CONFIG_PATH, {
    content: serializeGuardianConfig(config),
    sha: "config-sha"
  });
  state.files.set(CALLER_WORKFLOW_PATH, {
    content: workflowFor(config, OLD_WORKFLOW_SHA),
    sha: "workflow-sha"
  });

  const rows = await inventory(
    commandContext(github, { workflowSha: PLACEHOLDER_WORKFLOW_SHA })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "misconfigured");
  assert.match(rows[0]!.detail, /caller workflow pin|workflow pin/i);
});

test("inventory flags malformed or non-immutable workflow pins without a target SHA", async () => {
  const github = new MockGitHub();
  github.appObservable = true;

  const mutable = github.add(healthyState("mutable-pin"));
  // Write a config/caller pair that pin mutable refs instead of commit SHAs.
  mutable.files.set(CONFIG_PATH, {
    content: serializeGuardianConfig(guardianConfig()).replace(WORKFLOW_SHA, "main"),
    sha: "config-sha"
  });
  mutable.files.set(CALLER_WORKFLOW_PATH, {
    content: workflowFor(guardianConfig()).replaceAll(WORKFLOW_SHA, "main"),
    sha: "workflow-sha"
  });

  const zeroPin = github.add(healthyState("zero-pin"));
  zeroPin.files.set(CONFIG_PATH, {
    content: serializeGuardianConfig(guardianConfig()).replace(
      WORKFLOW_SHA,
      PLACEHOLDER_WORKFLOW_SHA
    ),
    sha: "config-sha"
  });
  zeroPin.files.set(CALLER_WORKFLOW_PATH, {
    content: workflowFor(guardianConfig()).replaceAll(
      WORKFLOW_SHA,
      PLACEHOLDER_WORKFLOW_SHA
    ),
    sha: "workflow-sha"
  });

  const rows = await inventory(
    commandContext(github, { workflowSha: PLACEHOLDER_WORKFLOW_SHA })
  );
  const byRepo = Object.fromEntries(rows.map((row) => [row.repository, row]));
  assert.equal(byRepo["acme/mutable-pin"]!.status, "misconfigured");
  assert.equal(byRepo["acme/zero-pin"]!.status, "misconfigured");
  assert.match(
    byRepo["acme/mutable-pin"]!.detail + byRepo["acme/zero-pin"]!.detail,
    /immutable|pin|workflow/i
  );
});

test("inventory with an explicit target SHA flags repositories behind that pin", async () => {
  const github = new MockGitHub();
  github.appObservable = true;

  github.add(healthyState("current"));

  const behind = github.add(healthyState("behind"));
  const oldConfig = guardianConfig("report-only", { workflowSha: OLD_WORKFLOW_SHA });
  behind.files.set(CONFIG_PATH, {
    content: serializeGuardianConfig(oldConfig),
    sha: "config-sha"
  });
  behind.files.set(CALLER_WORKFLOW_PATH, {
    content: workflowFor(oldConfig, OLD_WORKFLOW_SHA),
    sha: "workflow-sha"
  });

  const rows = await inventory(commandContext(github, { workflowSha: WORKFLOW_SHA }));
  const byRepo = Object.fromEntries(rows.map((row) => [row.repository, row]));

  assert.equal(byRepo["acme/current"]!.status, "report-only");
  assert.equal(byRepo["acme/behind"]!.status, "misconfigured");
  assert.match(byRepo["acme/behind"]!.detail, /pin|workflow/i);
  assert.match(byRepo["acme/behind"]!.detail, new RegExp(WORKFLOW_SHA));
});

test("upgrade requires immutable SHAs and repairs caller drift even when the pin is current", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState());
  state.files.set(CALLER_WORKFLOW_PATH, {
    content: `${workflowFor(guardianConfig())}\n# manual drift\n`,
    sha: "workflow-sha"
  });

  await assert.rejects(
    upgrade(
      commandContext(github, { workflowSha: "main" }),
      "acme/service"
    ),
    /immutable 40-character/
  );
  assert.equal(github.branches.length, 0);

  const result = await upgrade(commandContext(github), "acme/service");
  assert.equal(result.changed, true);
  assert.deepEqual(github.writes.map((write) => write.path), [CALLER_WORKFLOW_PATH]);
  assert.equal(github.writes[0]!.sha, "workflow-sha");

  const exactGitHub = new MockGitHub();
  exactGitHub.add(healthyState());
  assert.deepEqual(await upgrade(commandContext(exactGitHub), "acme/service"), {
    changed: false
  });
});

test("upgrade updates both configuration and caller when moving to a new immutable SHA", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState());
  const oldConfig = guardianConfig("report-only", {
    workflowSha: OLD_WORKFLOW_SHA
  });
  state.files.set(CONFIG_PATH, {
    content: serializeGuardianConfig(oldConfig),
    sha: "old-config-sha"
  });
  state.files.set(CALLER_WORKFLOW_PATH, {
    content: workflowFor(oldConfig, OLD_WORKFLOW_SHA),
    sha: "old-workflow-sha"
  });

  const result = await upgrade(commandContext(github), "acme/service");

  assert.equal(result.changed, true);
  assert.deepEqual(
    github.writes.map((write) => write.path).sort(),
    [CALLER_WORKFLOW_PATH, CONFIG_PATH].sort()
  );
  const configWrite = github.writes.find((write) => write.path === CONFIG_PATH)!;
  const workflowWrite = github.writes.find(
    (write) => write.path === CALLER_WORKFLOW_PATH
  )!;
  assert.equal(parseGuardianConfig(configWrite.content).workflowVersion, WORKFLOW_SHA);
  assert.match(workflowWrite.content, new RegExp(`@${WORKFLOW_SHA}`));
  assert.doesNotMatch(workflowWrite.content, new RegExp(`@${OLD_WORKFLOW_SHA}`));
});

test("upgrade enables DAST through the same public override contract as onboarding", async () => {
  const github = new MockGitHub();
  github.add(healthyState());

  const result = await upgrade(
    commandContext(github, {
      overrides: {
        dastOrigin: "https://staging.example.com",
        openapi: "/openapi.json",
        authenticationProfile: "control-plane://profiles/example-staging",
        sessionAssertionPath: "/api/protected"
      }
    }),
    "acme/service"
  );

  assert.equal(result.changed, true);
  assert.deepEqual(
    github.writes.map((write) => write.path).sort(),
    [CALLER_WORKFLOW_PATH, CONFIG_PATH].sort()
  );
  const configWrite = github.writes.find((write) => write.path === CONFIG_PATH)!;
  const updated = parseGuardianConfig(configWrite.content);
  assert.deepEqual(updated.dast, {
    allowedOrigin: "https://staging.example.com",
    allowedOrigins: ["https://staging.example.com"],
    openapi: "/openapi.json",
    openapiSource: "live-endpoint",
    authenticationProfile: "control-plane://profiles/example-staging",
    sessionAssertionPath: "/api/protected",
    profiles: {
      deploySmoke: "authenticated-baseline",
      nightly: "authenticated-full"
    },
    excludedRoutes: []
  });
  const workflowWrite = github.writes.find(
    (write) => write.path === CALLER_WORKFLOW_PATH
  )!;
  assert.match(workflowWrite.content, /guardianbot-dast-smoke:/);
  assert.match(workflowWrite.content, /guardianbot-dast-nightly:/);
});

test("upgrade rejects partial DAST override contracts without opening a branch", async () => {
  const github = new MockGitHub();
  github.add(healthyState());

  await assert.rejects(
    upgrade(
      commandContext(github, {
        overrides: {
          dastOrigin: "https://staging.example.com"
        }
      }),
      "acme/service"
    ),
    /DAST overrides require origin, OpenAPI, auth profile, and session assertion/
  );
  assert.equal(github.branches.length, 0);
  assert.equal(github.writes.length, 0);
});

test("upgrade applies verified-default-branch image promotion overrides", async () => {
  const github = new MockGitHub();
  const image: NonNullable<GuardianConfig["image"]> = {
    dockerfile: "Dockerfile",
    context: ".",
    platform: "linux/amd64",
    registry: "ghcr.io/acme/service",
    healthPath: "/health",
    sbomFormat: "cyclonedx-json",
    deployment: {
      environment: "staging",
      requireImmutableDigest: true,
      requireSignature: true,
      requireSbom: true,
      promotionMode: "enforce-only"
    }
  };
  const state = github.add(healthyState("service", { image }));
  state.files.set("Dockerfile", { content: "FROM scratch\n", sha: "dockerfile-sha" });

  const result = await upgrade(
    commandContext(github, {
      overrides: {
        imagePromotion: "verified-default-branch"
      }
    }),
    "acme/service"
  );

  assert.equal(result.changed, true);
  const configWrite = github.writes.find((write) => write.path === CONFIG_PATH)!;
  const updated = parseGuardianConfig(configWrite.content);
  assert.equal(updated.image?.deployment?.promotionMode, "verified-default-branch");
  const workflowWrite = github.writes.find(
    (write) => write.path === CALLER_WORKFLOW_PATH
  )!;
  assert.match(
    workflowWrite.content,
    /push: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/
  );
});

test("upgrade rejects image-promotion without configured image deployment", async () => {
  const github = new MockGitHub();
  github.add(healthyState());

  await assert.rejects(
    upgrade(
      commandContext(github, {
        overrides: {
          imagePromotion: "verified-default-branch"
        }
      }),
      "acme/service"
    ),
    /image-promotion override requires configured image deployment/
  );
  assert.equal(github.branches.length, 0);
  assert.equal(github.writes.length, 0);
});

test("upgrade --all consumes every GitHub repository page", async (t) => {
  const config = guardianConfig();
  const workflow = workflowFor(config);
  const requestedPages: number[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/user/repos") {
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      if (page === 1) {
        response.end(
          JSON.stringify(
            Array.from({ length: 100 }, (_, index) =>
              repositoryMetadata(`archived-${index}`, { archived: true })
            )
          )
        );
        return;
      }
      response.end(JSON.stringify([repositoryMetadata("target")]));
      return;
    }
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath === "/repos/acme/target") {
      response.end(JSON.stringify(repositoryMetadata("target")));
      return;
    }
    if (decodedPath === `/repos/acme/target/contents/${CONFIG_PATH}`) {
      response.end(
        JSON.stringify({
          content: Buffer.from(serializeGuardianConfig(config)).toString("base64"),
          encoding: "base64",
          sha: "config-sha"
        })
      );
      return;
    }
    if (decodedPath === `/repos/acme/target/contents/${CALLER_WORKFLOW_PATH}`) {
      response.end(
        JSON.stringify({
          content: Buffer.from(workflow).toString("base64"),
          encoding: "base64",
          sha: "workflow-sha"
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: `unexpected ${request.method} ${request.url}` }));
  });
  await listen(server);
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const github = new GitHubClient(
    "test-token",
    `http://127.0.0.1:${address.port}/`
  );
  const result = await upgradeAll({
    github,
    guardianRepository: "Acme/guardianbot",
    workflowSha: WORKFLOW_SHA,
    dryRun: true
  });

  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(result, [{ repository: "acme/target", changed: false }]);
});

test("offboard validates ownership, retains repository and App audit evidence, and deletes only caller/config", async () => {
  const github = new MockGitHub();
  github.appObservable = true;
  github.add(healthyState("service", { mode: "enforce" }));

  const result = await offboard(commandContext(github), "acme/service");

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.plan.removeRepositoryFiles.sort(),
    [CONFIG_PATH, CALLER_WORKFLOW_PATH].sort()
  );
  assert.deepEqual(
    result.plan.retainRepositoryFiles.sort(),
    [BASELINE_PATH, ONBOARDING_REPORT_PATH].sort()
  );
  assert.equal(result.plan.retainCentralEvidence, true);
  assert.deepEqual(
    github.deletions.map((deletion) => deletion.path).sort(),
    [CONFIG_PATH, CALLER_WORKFLOW_PATH].sort()
  );
  assert.equal(
    github.deletions.some(
      (deletion) =>
        deletion.path === BASELINE_PATH || deletion.path === ONBOARDING_REPORT_PATH
    ),
    false
  );
  assert.equal(
    github.requests.some(
      (request) =>
        request.method === "DELETE" &&
        (request.path.includes("/installation") || request.path.includes("/rulesets"))
    ),
    false
  );
  assert.match(github.pulls[0]!.input.body, /installation events, and audit evidence are not deleted/);
  assert.ok(
    github.pulls[0]!.input.body.indexOf("Before merging this PR:") <
      github.pulls[0]!.input.body.indexOf("After this PR merges:")
  );
  assert.match(
    github.pulls[0]!.input.body,
    /remove GuardianBot required-check rule immediately before merging/
  );
});

test("offboard refuses to delete an unrecognized workflow at the managed path", async () => {
  const github = new MockGitHub();
  const state = github.add(healthyState());
  state.files.set(CALLER_WORKFLOW_PATH, {
    content: "name: user-owned workflow\n",
    sha: "user-workflow"
  });

  await assert.rejects(
    offboard(commandContext(github), "acme/service"),
    /not a recognized generated GuardianBot caller/
  );
  assert.equal(github.deletions.length, 0);
  assert.equal(github.pulls.length, 0);
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}
