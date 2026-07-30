#!/usr/bin/env node

/**
 * Standalone enforce-mode readiness verifier.
 *
 * Prevents enforce mode from trusting branch-authored baseline fields alone by
 * re-checking the baseline provenance against the trusted GitHub API, the source
 * and observation runs' deterministic scanner jobs, gate configs, and the
 * repository ruleset. Fail closed; never log tokens, Authorization headers, or
 * API bodies.
 *
 * Contract:
 * - `source` is the current gate that supplied fingerprints (not age-gated).
 * - `observation` is an independently verified report-only gate that must be at
 *   least the configured minimum observation age (default seven days).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BASELINE_SCHEMA_VERSION = "guardianbot.baseline.v1";
export const CALLER_WORKFLOW_PATH = ".github/workflows/guardianbot.yml";
export const CALLER_WORKFLOW_NAME = "GuardianBot";
export const REUSABLE_SECURITY_WORKFLOW_PATH =
  ".github/workflows/reusable-security.yml";
export const DETERMINISTIC_SCANNER_JOB =
  "guardianbot/security-gate / deterministic scanners";
export const RULESET_NAME = "GuardianBot security gate";
export const DEFAULT_MINIMUM_OBSERVATION_DAYS = 7;

const FINGERPRINT_SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE_SHA = /^[a-f0-9]{40}$/;
const REPOSITORY_NAME = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const SAFE_REPO_PATH = /^[A-Za-z0-9._/-]+$/;
const CANONICAL_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MS_PER_DAY = 86_400_000;
const MAX_JOB_PAGES = 10;
const MAX_JOBS_TOTAL = 150;
const MAX_RULESET_PAGES = 10;
const JOBS_PER_PAGE = 100;
const RULESETS_PER_PAGE = 100;
const MAX_CONFIG_BYTES = 1_048_576;

/** Already-pinned yq image used by reusable-security.yml. */
export const YQ_IMAGE =
  "mikefarah/yq:4.44.6@sha256:b1d117c609ba990436ad1649299e2f6c378f62cb562caf30b6f2fb6144713422";

export class EnforcementReadinessError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnforcementReadinessError";
  }
}

function fail(message) {
  throw new EnforcementReadinessError(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUtcInstant(value) {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeRepositoryName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function assertSafeRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  if (value.startsWith("/") || value.includes("..") || !SAFE_REPO_PATH.test(value)) {
    fail(`${label} must be a relative allowlisted path without '..'`);
  }
  return value;
}

function assertMinimumObservationDays(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < DEFAULT_MINIMUM_OBSERVATION_DAYS) {
    fail(
      `minimum observation days must be an integer >= ${DEFAULT_MINIMUM_OBSERVATION_DAYS}`
    );
  }
  return value;
}

function parseRepository(repository, label = "repository") {
  const normalized = normalizeRepositoryName(repository);
  if (!REPOSITORY_NAME.test(normalized)) {
    fail(`${label} must be OWNER/REPO`);
  }
  const [owner, repo] = normalized.split("/");
  return { owner, repo, normalized };
}

function validateApiUrl(apiUrl) {
  if (typeof apiUrl !== "string" || !apiUrl.trim()) {
    fail("GitHub API URL is required");
  }
  let base;
  try {
    base = new URL(apiUrl);
  } catch {
    fail("GitHub API URL is invalid");
  }
  const loopback =
    base.hostname === "localhost" ||
    base.hostname === "127.0.0.1" ||
    base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(loopback && base.protocol === "http:")) {
    fail("GitHub API URL must use HTTPS outside loopback");
  }
  if (base.username || base.password || base.search || base.hash) {
    fail("GitHub API URL configuration is invalid");
  }
  return base;
}

function redactSecrets(message, token) {
  let text = String(message ?? "unknown error");
  if (token && token.length > 0 && text.includes(token)) {
    text = text.split(token).join("[redacted]");
  }
  // Never leak Authorization header material if a wrapper stringifies it.
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return text;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Date.now();
}

function parseGateIdentity(value, label, currentRepository) {
  if (!isObject(value)) {
    fail(`versioned baseline ${label} must be an object`);
  }
  if (typeof value.repository !== "string") {
    fail(`versioned baseline ${label}.repository must be OWNER/REPO`);
  }
  const repository = normalizeRepositoryName(value.repository);
  if (!REPOSITORY_NAME.test(repository)) {
    fail(`versioned baseline ${label}.repository must be OWNER/REPO`);
  }
  if (repository !== currentRepository) {
    fail(`baseline ${label}.repository does not match the current repository`);
  }
  if (typeof value.headSha !== "string" || !IMMUTABLE_SHA.test(value.headSha)) {
    fail(
      `versioned baseline ${label}.headSha must be a lowercase 40-character commit SHA`
    );
  }
  if (!isPositiveSafeInteger(value.runId)) {
    fail(`versioned baseline ${label}.runId must be a positive integer`);
  }
  if (!isPositiveSafeInteger(value.runAttempt)) {
    fail(`versioned baseline ${label}.runAttempt must be a positive integer`);
  }
  return {
    repository,
    headSha: value.headSha,
    runId: value.runId,
    runAttempt: value.runAttempt
  };
}

/**
 * Parse and authorize a baseline for enforce mode.
 * Only guardianbot.baseline.v1 is accepted; legacy arrays and versionless
 * objects are rejected for enforce authorization.
 */
export function parseEnforceBaseline(rawText, currentRepository) {
  let value;
  try {
    value = JSON.parse(rawText);
  } catch {
    fail("baseline is not valid JSON");
  }

  if (Array.isArray(value)) {
    fail("legacy baseline arrays are not authorized for enforce mode");
  }
  if (!isObject(value)) {
    fail("baseline must be a versioned object");
  }
  if (value.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    fail(
      `baseline schemaVersion must be ${BASELINE_SCHEMA_VERSION}; versionless baselines are not authorized for enforce mode`
    );
  }
  if (!Array.isArray(value.fingerprints)) {
    fail("versioned baseline must include a fingerprints array");
  }
  if (typeof value.generatedAt !== "string" || !isCanonicalUtcInstant(value.generatedAt)) {
    fail(
      "versioned baseline generatedAt must be a canonical RFC3339 UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)"
    );
  }

  const fingerprints = value.fingerprints;
  const invalid = fingerprints.filter(
    (fingerprint) => typeof fingerprint !== "string" || !FINGERPRINT_SHA256.test(fingerprint)
  );
  if (invalid.length) {
    fail("baseline fingerprints must be unique lowercase SHA-256 digests");
  }
  if (new Set(fingerprints).size !== fingerprints.length) {
    fail("baseline fingerprints must be unique lowercase SHA-256 digests");
  }

  const source = value.source;
  if (!isObject(source)) {
    fail("versioned baseline source must be an object");
  }
  if (typeof source.gateSha256 !== "string" || !FINGERPRINT_SHA256.test(source.gateSha256)) {
    fail("versioned baseline source.gateSha256 must be a lowercase SHA-256 digest");
  }
  if (source.mode !== "report-only") {
    fail("versioned baseline source.mode must be report-only");
  }

  const current = normalizeRepositoryName(currentRepository);
  const sourceIdentity = parseGateIdentity(source, "source", current);

  const observation = value.observation;
  if (!isObject(observation)) {
    fail("versioned baseline observation must be an object");
  }
  const observationIdentity = parseGateIdentity(
    observation,
    "observation",
    current
  );
  if (
    typeof observation.startedAt !== "string" ||
    !isCanonicalUtcInstant(observation.startedAt)
  ) {
    fail(
      "versioned baseline observation.startedAt must be a canonical RFC3339 UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)"
    );
  }

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    fingerprints,
    generatedAt: value.generatedAt,
    source: {
      gateSha256: source.gateSha256,
      mode: "report-only",
      repository: sourceIdentity.repository,
      headSha: sourceIdentity.headSha,
      runId: sourceIdentity.runId,
      runAttempt: sourceIdentity.runAttempt
    },
    observation: {
      repository: observationIdentity.repository,
      headSha: observationIdentity.headSha,
      runId: observationIdentity.runId,
      runAttempt: observationIdentity.runAttempt,
      startedAt: observation.startedAt
    }
  };
}

function stripWorkflowRef(workflowPath) {
  if (typeof workflowPath !== "string") return "";
  const at = workflowPath.indexOf("@");
  return (at === -1 ? workflowPath : workflowPath.slice(0, at)).trim();
}

function rulesetAppliesToDefaultBranch(ruleset, defaultBranch) {
  const include = ruleset.conditions?.ref_name?.include;
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const branchRef = `refs/heads/${defaultBranch}`;
  const matchesDefault = (value) => {
    if (
      value === "~ALL" ||
      value === "~DEFAULT_BRANCH" ||
      value === defaultBranch ||
      value === branchRef
    ) {
      return true;
    }
    const pattern = String(value)
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

function rulesetHasStrictRequiredCheck(ruleset, requiredCheckName) {
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const requiredRules = rules.filter((rule) => rule?.type === "required_status_checks");
  if (!requiredRules.length) return false;
  const strict = requiredRules.some(
    (rule) => rule.parameters?.strict_required_status_checks_policy === true
  );
  if (!strict) return false;
  const contexts = requiredRules.flatMap(
    (rule) =>
      rule.parameters?.required_status_checks
        ?.map((check) => check?.context)
        .filter((value) => typeof value === "string" && value.length > 0) ?? []
  );
  return contexts.includes(requiredCheckName);
}

async function githubGetJson({
  fetchImpl,
  apiBase,
  token,
  requestPath,
  sleep
}) {
  const url = new URL(requestPath.replace(/^\//, ""), `${apiBase.origin}${apiBase.pathname.replace(/\/?$/, "/")}`);
  if (url.origin !== apiBase.origin) {
    fail("GitHub API request cannot leave the configured origin");
  }

  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "guardianbot-enforcement-readiness",
          "x-github-api-version": "2022-11-28"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      if (attempt >= MAX_FETCH_ATTEMPTS) {
        fail(`GitHub GET ${url.pathname} failed`);
      }
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.ok) {
      try {
        // Consume body only for JSON parse; never log it.
        return await response.json();
      } catch {
        fail(`GitHub GET ${url.pathname} returned invalid JSON`);
      }
    }

    lastStatus = response.status;
    // Drain without retaining body text.
    try {
      await response.arrayBuffer();
    } catch {
      // ignore drain failures
    }

    const retryable = lastStatus === 429 || lastStatus >= 500;
    if (retryable && attempt < MAX_FETCH_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (lastStatus === 401 || lastStatus === 403) {
      fail(`GitHub GET ${url.pathname} returned ${lastStatus} (missing permissions)`);
    }
    if (lastStatus === 404) {
      fail(`GitHub GET ${url.pathname} returned 404`);
    }
    if (lastStatus === 429) {
      fail(`GitHub GET ${url.pathname} returned 429 after retries`);
    }
    fail(`GitHub GET ${url.pathname} returned ${lastStatus}`);
  }

  fail(`GitHub GET ${url.pathname} returned ${lastStatus || "error"}`);
}

async function loadAttemptJobs({
  fetchImpl,
  apiBase,
  token,
  owner,
  repo,
  runId,
  runAttempt,
  sleep
}) {
  const jobs = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const payload = await githubGetJson({
      fetchImpl,
      apiBase,
      token,
      requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/attempts/${runAttempt}/jobs?filter=all&per_page=${JOBS_PER_PAGE}&page=${page}`,
      sleep
    });
    if (!isObject(payload) || !Array.isArray(payload.jobs)) {
      fail("attempt jobs response is invalid");
    }
    const batch = payload.jobs;
    if (jobs.length + batch.length > MAX_JOBS_TOTAL) {
      fail(
        `attempt job listing exceeded ${MAX_JOBS_TOTAL} jobs; fail closed`
      );
    }
    jobs.push(...batch);
    if (batch.length < JOBS_PER_PAGE) {
      return jobs;
    }
    if (page === MAX_JOB_PAGES) {
      fail(
        `attempt job listing exceeded ${MAX_JOB_PAGES} pages; fail closed`
      );
    }
  }
  return jobs;
}

async function loadRulesets({
  fetchImpl,
  apiBase,
  token,
  owner,
  repo,
  sleep
}) {
  const rulesets = [];
  for (let page = 1; page <= MAX_RULESET_PAGES; page += 1) {
    const batch = await githubGetJson({
      fetchImpl,
      apiBase,
      token,
      requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets?includes_parents=true&per_page=${RULESETS_PER_PAGE}&page=${page}`,
      sleep
    });
    if (!Array.isArray(batch)) {
      fail("rulesets response is invalid");
    }
    rulesets.push(...batch);
    if (batch.length < RULESETS_PER_PAGE) {
      return rulesets;
    }
    if (page === MAX_RULESET_PAGES) {
      fail(`ruleset listing exceeded ${MAX_RULESET_PAGES} pages; fail closed`);
    }
  }
  return rulesets;
}

async function loadRulesetDetail({
  fetchImpl,
  apiBase,
  token,
  owner,
  repo,
  rulesetId,
  sleep
}) {
  if (!isPositiveSafeInteger(rulesetId)) {
    fail("ruleset id is invalid");
  }
  const detail = await githubGetJson({
    fetchImpl,
    apiBase,
    token,
    requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets/${rulesetId}`,
    sleep
  });
  if (!isObject(detail)) {
    fail("ruleset detail response is invalid");
  }
  return detail;
}

/**
 * CLI/default resolver: git show <head>:<configPath> + pinned yq image.
 * Returns only trusted parsed fields; never logs config contents.
 */
export async function resolveSourceConfigViaGitYq({ headSha, configPath }) {
  if (!IMMUTABLE_SHA.test(headSha)) {
    fail("source headSha is invalid");
  }
  assertSafeRepoPath(configPath, "config path");

  let yaml;
  try {
    const result = await execFileAsync("git", ["show", `${headSha}:${configPath}`], {
      encoding: "utf8",
      maxBuffer: MAX_CONFIG_BYTES,
      timeout: 30_000
    });
    yaml = result.stdout;
  } catch {
    fail("source config is unavailable at the source head");
  }

  if (Buffer.byteLength(yaml, "utf8") > MAX_CONFIG_BYTES) {
    fail("source config exceeds maximum size");
  }

  let jsonOut;
  try {
    const result = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        YQ_IMAGE,
        "-o=json",
        '{"schemaVersion":.schemaVersion,"scannersMode":.scanners.mode,"workflowVersion":.workflowVersion}',
        "-"
      ],
      {
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 60_000,
        input: yaml
      }
    );
    jsonOut = result.stdout;
  } catch {
    fail("failed to parse source config");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonOut);
  } catch {
    fail("source config parse produced invalid JSON");
  }

  return {
    schemaVersion: parsed?.schemaVersion,
    scannersMode: parsed?.scannersMode,
    workflowVersion: parsed?.workflowVersion
  };
}

function validateGateConfigFields(config, label) {
  if (!isObject(config)) {
    fail(`${label} config fields are missing`);
  }
  if (config.schemaVersion !== "1.0.0") {
    fail(`${label} config schemaVersion must be 1.0.0`);
  }
  if (config.scannersMode !== "report-only") {
    fail(`${label} config scanners.mode must be report-only`);
  }
  if (
    typeof config.workflowVersion !== "string" ||
    !IMMUTABLE_SHA.test(config.workflowVersion)
  ) {
    fail(
      `${label} config workflowVersion must be an immutable 40-character commit SHA`
    );
  }
}

function runRepositoryFullName(run) {
  const candidates = [
    run?.repository?.full_name,
    run?.head_repository?.full_name,
    run?.repository?.name && run?.repository?.owner?.login
      ? `${run.repository.owner.login}/${run.repository.name}`
      : null
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeRepositoryName(candidate);
    }
  }
  return "";
}

function runTimestamp(run) {
  const value = run?.run_started_at ?? run?.created_at;
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function sameRunAttempt(a, b) {
  return a.runId === b.runId && a.runAttempt === b.runAttempt;
}

/**
 * Verify a gate workflow run against API identity requirements shared by
 * source and observation. Does not apply observation-period age checks.
 */
function assertGateRunIdentity(run, expected, label, repository) {
  if (!isObject(run)) {
    fail(`${label} run response is invalid`);
  }
  if (run.id !== expected.runId) {
    fail(`${label} run id does not match baseline ${label}.runId`);
  }
  if (run.run_attempt !== expected.runAttempt) {
    fail(`${label} run attempt does not match baseline ${label}.runAttempt`);
  }
  const runHead = typeof run.head_sha === "string" ? run.head_sha.toLowerCase() : "";
  if (runHead !== expected.headSha) {
    fail(`${label} run head SHA does not match baseline ${label}.headSha`);
  }
  const runRepository = runRepositoryFullName(run);
  if (!runRepository || runRepository !== repository) {
    fail(`${label} run repository does not match the current repository`);
  }
  if (run.status !== "completed") {
    fail(`${label} run is not completed`);
  }
  if (run.event !== "push" && run.event !== "workflow_dispatch") {
    fail(`${label} run event must be push or workflow_dispatch`);
  }
  const workflowPath = stripWorkflowRef(run.path);
  if (workflowPath !== CALLER_WORKFLOW_PATH) {
    fail(`${label} run path must be ${CALLER_WORKFLOW_PATH}`);
  }
  if (
    typeof run.name === "string" &&
    run.name.length > 0 &&
    run.name !== CALLER_WORKFLOW_NAME
  ) {
    fail(`${label} run name must be ${CALLER_WORKFLOW_NAME} when present`);
  }
}

/**
 * Require GitHub's resolved referenced_workflows identity for reusable-security.
 * Path format: OWNER/REPO/.github/workflows/reusable-security.yml@40hexSHA
 * Repository segment is case-insensitive; path segment and SHA must match exactly.
 */
function assertReferencedReusableSecurity(
  run,
  workflowRepository,
  workflowVersion,
  label
) {
  const refs = run?.referenced_workflows;
  if (!Array.isArray(refs) || refs.length === 0) {
    fail(`${label} run referenced_workflows must be a non-empty array`);
  }

  const matches = [];
  for (const entry of refs) {
    if (!isObject(entry) || typeof entry.path !== "string") continue;
    const at = entry.path.lastIndexOf("@");
    if (at <= 0) continue;
    const left = entry.path.slice(0, at);
    const ref = entry.path.slice(at + 1);
    const slash1 = left.indexOf("/");
    if (slash1 <= 0) continue;
    const slash2 = left.indexOf("/", slash1 + 1);
    if (slash2 <= slash1 + 1) continue;
    const entryRepo = normalizeRepositoryName(left.slice(0, slash2));
    const entryPath = left.slice(slash2 + 1);
    if (
      entryRepo === workflowRepository &&
      entryPath === REUSABLE_SECURITY_WORKFLOW_PATH &&
      ref === workflowVersion
    ) {
      matches.push(entry);
    }
  }

  if (matches.length === 0) {
    fail(
      `${label} run does not reference the expected reusable-security workflow at immutable workflowVersion`
    );
  }
  if (matches.length > 1) {
    fail(
      `${label} run has duplicate reusable-security workflow references`
    );
  }

  const match = matches[0];
  if (Object.hasOwn(match, "sha") && match.sha != null) {
    if (match.sha !== workflowVersion) {
      fail(
        `${label} run referenced_workflows.sha does not match workflowVersion`
      );
    }
  }
}

function assertDeterministicScannerJob(jobs, label) {
  const deterministicJobs = jobs.filter(
    (job) => isObject(job) && job.name === DETERMINISTIC_SCANNER_JOB
  );
  if (deterministicJobs.length === 0) {
    fail(`${label} run is missing the exact job ${DETERMINISTIC_SCANNER_JOB}`);
  }
  if (deterministicJobs.length > 1) {
    fail(`${label} run has duplicate ${DETERMINISTIC_SCANNER_JOB} jobs`);
  }
  const job = deterministicJobs[0];
  if (job.conclusion === "skipped") {
    fail(`${label} deterministic scanner job was skipped`);
  }
  if (job.status !== "completed" || job.conclusion !== "success") {
    fail(`${label} deterministic scanner job is not successful and completed`);
  }
}

async function loadGateRunBundle({
  fetchImpl,
  apiBase,
  token,
  owner,
  repo,
  identity,
  sleep
}) {
  const run = await githubGetJson({
    fetchImpl,
    apiBase,
    token,
    requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
    sleep
  });
  const jobs = await loadAttemptJobs({
    fetchImpl,
    apiBase,
    token,
    owner,
    repo,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    sleep
  });
  return { run, jobs };
}

/**
 * Verify enforce-mode readiness against trusted API evidence.
 *
 * @param {object} options
 * @param {string} [options.baselinePath]
 * @param {string} [options.baselineText]
 * @param {string} options.configPath
 * @param {string} options.repository
 * @param {string} options.workflowRepository
 * @param {string} options.defaultBranch
 * @param {string} options.requiredCheckName
 * @param {string} options.githubApiUrl
 * @param {string} options.githubToken
 * @param {number} options.minimumObservationDays
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Date|number} [options.now]
 * @param {(args: {headSha: string, configPath: string}) => Promise<object>} [options.resolveSourceConfig]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export async function verifyEnforcementReadiness(options = {}) {
  const token =
    typeof options.githubToken === "string" ? options.githubToken : "";
  try {
    if (!token) {
      fail("GitHub token is required");
    }
    if (typeof options.requiredCheckName !== "string" || !options.requiredCheckName.trim()) {
      fail("required check name is required");
    }
    if (typeof options.defaultBranch !== "string" || !options.defaultBranch.trim()) {
      fail("default branch is required");
    }

    const requiredCheckName = options.requiredCheckName.trim();
    const defaultBranch = options.defaultBranch.trim();
    const configPath = assertSafeRepoPath(options.configPath, "config path");
    const minimumObservationDays = assertMinimumObservationDays(
      options.minimumObservationDays
    );
    const { owner, repo, normalized: repository } = parseRepository(
      options.repository
    );
    const { normalized: workflowRepository } = parseRepository(
      options.workflowRepository,
      "workflowRepository"
    );
    const apiBase = validateApiUrl(options.githubApiUrl);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      fail("fetch implementation is required");
    }
    const sleep = options.sleep ?? defaultSleep;
    const resolveSourceConfig =
      options.resolveSourceConfig ?? resolveSourceConfigViaGitYq;

    let baselineText = options.baselineText;
    if (baselineText === undefined) {
      const baselinePath = assertSafeRepoPath(options.baselinePath, "baseline path");
      try {
        baselineText = await readFile(baselinePath, "utf8");
      } catch {
        fail("baseline file is unreadable");
      }
    }
    if (typeof baselineText !== "string") {
      fail("baseline content is required");
    }

    const baseline = parseEnforceBaseline(baselineText, repository);
    const source = baseline.source;
    const observation = baseline.observation;

    const sourceBundle = await loadGateRunBundle({
      fetchImpl,
      apiBase,
      token,
      owner,
      repo,
      identity: source,
      sleep
    });
    assertGateRunIdentity(sourceBundle.run, source, "source", repository);
    assertDeterministicScannerJob(sourceBundle.jobs, "source");
    const sourceConfig = await resolveSourceConfig({
      headSha: source.headSha,
      configPath
    });
    validateGateConfigFields(sourceConfig, "source");
    assertReferencedReusableSecurity(
      sourceBundle.run,
      workflowRepository,
      sourceConfig.workflowVersion,
      "source"
    );

    let observationBundle;
    if (sameRunAttempt(source, observation)) {
      observationBundle = sourceBundle;
    } else {
      observationBundle = await loadGateRunBundle({
        fetchImpl,
        apiBase,
        token,
        owner,
        repo,
        identity: observation,
        sleep
      });
    }
    assertGateRunIdentity(
      observationBundle.run,
      observation,
      "observation",
      repository
    );
    assertDeterministicScannerJob(observationBundle.jobs, "observation");

    let observationConfig;
    if (
      !sameRunAttempt(source, observation) ||
      source.headSha !== observation.headSha
    ) {
      observationConfig = await resolveSourceConfig({
        headSha: observation.headSha,
        configPath
      });
      validateGateConfigFields(observationConfig, "observation");
    } else {
      // Same run/attempt (and therefore same head): reuse source config check.
      observationConfig = sourceConfig;
      validateGateConfigFields(observationConfig, "observation");
    }
    assertReferencedReusableSecurity(
      observationBundle.run,
      workflowRepository,
      observationConfig.workflowVersion,
      "observation"
    );

    const startedAt = runTimestamp(observationBundle.run);
    if (!startedAt) {
      fail("observation run timestamp is missing or invalid");
    }
    if (startedAt.toISOString() !== observation.startedAt) {
      fail(
        "observation run timestamp does not match baseline observation.startedAt"
      );
    }
    const current = nowMs(options.now);
    const ageMs = current - startedAt.getTime();
    if (ageMs < -FUTURE_SKEW_MS) {
      fail("observation run timestamp is materially in the future");
    }
    const minimumMs = minimumObservationDays * MS_PER_DAY;
    if (ageMs < minimumMs) {
      fail(
        `observation run is too recent; minimum observation is ${minimumObservationDays} days`
      );
    }
    const ageDays = ageMs / MS_PER_DAY;

    const rulesets = await loadRulesets({
      fetchImpl,
      apiBase,
      token,
      owner,
      repo,
      sleep
    });
    const named = rulesets.filter(
      (ruleset) => isObject(ruleset) && ruleset.name === RULESET_NAME
    );
    if (named.length === 0) {
      fail(`ruleset ${RULESET_NAME} is missing`);
    }
    if (named.length > 1) {
      fail(`ruleset ${RULESET_NAME} is ambiguous`);
    }

    let ruleset = named[0];
    if (ruleset.enforcement !== "active") {
      fail(`ruleset ${RULESET_NAME} is not active`);
    }
    if (ruleset.target && ruleset.target !== "branch") {
      fail(`ruleset ${RULESET_NAME} target must be branch`);
    }
    if (!rulesetAppliesToDefaultBranch(ruleset, defaultBranch)) {
      fail(`ruleset ${RULESET_NAME} does not apply to the default branch`);
    }
    if (!Array.isArray(ruleset.rules)) {
      ruleset = await loadRulesetDetail({
        fetchImpl,
        apiBase,
        token,
        owner,
        repo,
        rulesetId: ruleset.id,
        sleep
      });
      if (ruleset.name !== RULESET_NAME) {
        fail("ruleset detail name mismatch");
      }
      if (ruleset.enforcement !== "active") {
        fail(`ruleset ${RULESET_NAME} is not active`);
      }
      if (ruleset.target && ruleset.target !== "branch") {
        fail(`ruleset ${RULESET_NAME} target must be branch`);
      }
      if (!rulesetAppliesToDefaultBranch(ruleset, defaultBranch)) {
        fail(`ruleset ${RULESET_NAME} does not apply to the default branch`);
      }
    }
    if (!rulesetHasStrictRequiredCheck(ruleset, requiredCheckName)) {
      fail(
        `ruleset ${RULESET_NAME} does not require strict status check ${requiredCheckName}`
      );
    }

    return {
      sourceRunId: source.runId,
      sourceRunAttempt: source.runAttempt,
      sourceHeadSha: source.headSha,
      observationRunId: observation.runId,
      observationRunAttempt: observation.runAttempt,
      observationHeadSha: observation.headSha,
      observationStartedAt: observation.startedAt,
      ageDays,
      rulesetId: ruleset.id,
      rulesetName: RULESET_NAME,
      requiredCheckName
    };
  } catch (error) {
    if (error instanceof EnforcementReadinessError) {
      throw new EnforcementReadinessError(redactSecrets(error.message, token));
    }
    throw new EnforcementReadinessError(
      redactSecrets(
        error instanceof Error ? error.message : "enforcement readiness failed",
        token
      )
    );
  }
}

function parseMinimumDaysEnv(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    fail("GUARDIANBOT_MINIMUM_OBSERVATION_DAYS is required");
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    fail(
      `GUARDIANBOT_MINIMUM_OBSERVATION_DAYS must be an integer >= ${DEFAULT_MINIMUM_OBSERVATION_DAYS}`
    );
  }
  const days = Number(raw.trim());
  return assertMinimumObservationDays(days);
}

export async function main(env = process.env) {
  // Never print tokens or response bodies. Only concise status + summary.
  const summary = await verifyEnforcementReadiness({
    baselinePath: env.GUARDIANBOT_BASELINE_PATH,
    configPath: env.GUARDIANBOT_CONFIG_PATH,
    repository: env.GUARDIANBOT_REPOSITORY,
    workflowRepository: env.GUARDIANBOT_WORKFLOW_REPOSITORY,
    defaultBranch: env.GUARDIANBOT_DEFAULT_BRANCH,
    requiredCheckName: env.GUARDIANBOT_REQUIRED_CHECK_NAME,
    githubApiUrl: env.GUARDIANBOT_GITHUB_API_URL,
    githubToken: env.GUARDIANBOT_GITHUB_TOKEN,
    minimumObservationDays: parseMinimumDaysEnv(
      env.GUARDIANBOT_MINIMUM_OBSERVATION_DAYS
    )
  });
  process.stdout.write(
    `${JSON.stringify({
      sourceRunId: summary.sourceRunId,
      sourceRunAttempt: summary.sourceRunAttempt,
      sourceHeadSha: summary.sourceHeadSha,
      observationRunId: summary.observationRunId,
      observationRunAttempt: summary.observationRunAttempt,
      observationHeadSha: summary.observationHeadSha,
      observationStartedAt: summary.observationStartedAt,
      ageDays: Number(summary.ageDays.toFixed(4)),
      rulesetId: summary.rulesetId,
      rulesetName: summary.rulesetName,
      requiredCheckName: summary.requiredCheckName
    })}\n`
  );
  return summary;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "enforcement readiness failed";
    // Defense in depth: never echo a token if present in the environment.
    process.stderr.write(
      `${redactSecrets(message, process.env.GUARDIANBOT_GITHUB_TOKEN ?? "")}\n`
    );
    process.exitCode = 1;
  });
}
