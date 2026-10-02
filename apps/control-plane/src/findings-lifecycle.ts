import { parseGuardianConfig, type GuardianConfig } from "@guardianbot/core";
import { isFindingSlaBreached } from "@guardianbot/monitoring";
import type {
  FindingLifecycleRecord,
  FindingLifecycleSeverity,
  FindingLifecycleSource,
  FindingLifecycleStatus,
  FindingLifecycleStreamWatermark,
  FindingTicketState,
  RepositoryRecord,
  ScannerWorkflowRunRecord,
  Store
} from "./store.js";
import { MAX_FINDING_LIFECYCLE_RECORDS } from "./store.js";
import {
  createGitHubIssuesProvider,
  createInstallationIssueClientFactory,
  createJiraProvider,
  createSlackNotifier,
  defaultTicketRetryPolicy,
  parseHttpsEndpoint,
  sanitizeTicketError,
  type FindingTicketContent,
  type FindingTicketProvider,
  type FindingTicketRetryPolicy,
  type FindingTicketSession
} from "./ticketing.js";

/**
 * Deterministic finding lifecycle: ownership, SLA aging, and automatic tickets.
 *
 * Only accepted scanner evidence from a default-branch push or schedule run of the
 * repository itself feeds this module (DAST evidence is additionally bound to the
 * deployed digest by its validated scan status). Pull-request evidence, fork
 * evidence, and AI review findings never reach it, so nothing here can be steered
 * by untrusted head content, and nothing here ever blocks, waives, or approves.
 */

export const DEFAULT_FINDINGS_SLA_DAYS: Readonly<Partial<Record<FindingLifecycleSeverity, number>>> = {
  critical: 7,
  high: 30
};
export const MAX_FINDINGS_SLA_DAYS = 3_650;
/** Upper bound of ticket or notifier updates one pass makes for one repository. */
export const MAX_TICKET_SYNCS_PER_PASS = 100;
/** Unique findings one stream may report before the stream counts as truncated. */
export const MAX_LIFECYCLE_FINDINGS_PER_STREAM = 500;
export const UNOWNED_FINDING_OWNER = "unowned";

const DAY_MS = 24 * 60 * 60_000;
const ENVIRONMENT_REFERENCE_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,9}$/;
const JIRA_ISSUE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9 -]{0,39}$/;
const CODEOWNERS_HANDLE_PATTERN = /^@[A-Za-z0-9_.\-/]{1,100}$/;
const CODEOWNERS_CANDIDATES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const MAX_CODEOWNERS_RULES = 1_000;
const MAX_OWNER_LENGTH = 256;
const TRUNCATION_MARKER = "\n[guardianbot-truncated]";
const SLA_SEVERITIES: readonly FindingLifecycleSeverity[] = ["critical", "high", "medium", "low"];
const RISK_ACCEPTED_REASON = /^risk[\s-]?accepted\b/i;

export interface FindingsJiraSettings {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
}

export interface FindingsLifecycleOptions {
  enabled: boolean;
  /** SLA days per severity; a severity without an entry is not tracked or ticketed. */
  slaDays: Partial<Record<FindingLifecycleSeverity, number>>;
  githubIssues: boolean;
  slackWebhookUrl?: string;
  jira?: FindingsJiraSettings;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new Error(`${name} must be 0, 1, false, or true`);
}

function resolveReference(
  env: Record<string, string | undefined>,
  referenceName: string
): string | undefined {
  const reference = env[referenceName]?.trim();
  if (!reference) return undefined;
  if (!ENVIRONMENT_REFERENCE_PATTERN.test(reference)) {
    throw new Error(`${referenceName} must name an uppercase environment variable`);
  }
  const value = env[reference];
  if (!value) {
    // Only the reference name is reported, never a value.
    throw new Error(`${referenceName} references ${reference}, which is not set`);
  }
  return value;
}

export function parseFindingsSlaDays(
  value: string | undefined
): Partial<Record<FindingLifecycleSeverity, number>> {
  if (value === undefined || value.trim() === "") return { ...DEFAULT_FINDINGS_SLA_DAYS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GUARDIANBOT_FINDINGS_SLA_JSON must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GUARDIANBOT_FINDINGS_SLA_JSON must be a JSON object");
  }
  const slaDays: Partial<Record<FindingLifecycleSeverity, number>> = {};
  for (const [severity, days] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SLA_SEVERITIES.includes(severity as FindingLifecycleSeverity)) {
      throw new Error(
        "GUARDIANBOT_FINDINGS_SLA_JSON keys must be critical, high, medium, or low"
      );
    }
    if (!Number.isSafeInteger(days) || Number(days) < 1 || Number(days) > MAX_FINDINGS_SLA_DAYS) {
      throw new Error(
        `GUARDIANBOT_FINDINGS_SLA_JSON days must be integers between 1 and ${MAX_FINDINGS_SLA_DAYS}`
      );
    }
    slaDays[severity as FindingLifecycleSeverity] = Number(days);
  }
  return slaDays;
}

/**
 * Parses lifecycle configuration at boot so a bad value fails before listeners
 * start. Everything defaults off; ticketing credentials are only ever read through
 * `*_REF` indirection, mirroring the DefectDojo settings.
 */
export function findingsLifecycleOptionsFromEnvironment(
  env: Record<string, string | undefined> = process.env
): FindingsLifecycleOptions {
  const enabled = parseBoolean(
    env.GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED,
    "GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED"
  );
  const slaDays = parseFindingsSlaDays(env.GUARDIANBOT_FINDINGS_SLA_JSON);
  const githubIssues = parseBoolean(
    env.GUARDIANBOT_FINDINGS_GITHUB_ISSUES_ENABLED,
    "GUARDIANBOT_FINDINGS_GITHUB_ISSUES_ENABLED"
  );
  const slackWebhookUrl = resolveReference(env, "GUARDIANBOT_FINDINGS_SLACK_WEBHOOK_URL_REF");
  if (slackWebhookUrl) parseHttpsEndpoint(slackWebhookUrl, "Slack webhook URL");

  const jiraNames = [
    "GUARDIANBOT_FINDINGS_JIRA_BASE_URL_REF",
    "GUARDIANBOT_FINDINGS_JIRA_EMAIL_REF",
    "GUARDIANBOT_FINDINGS_JIRA_API_TOKEN_REF",
    "GUARDIANBOT_FINDINGS_JIRA_PROJECT_KEY"
  ];
  const jiraConfigured = jiraNames.filter((name) => env[name]?.trim());
  let jira: FindingsJiraSettings | undefined;
  if (jiraConfigured.length && jiraConfigured.length !== jiraNames.length) {
    throw new Error(`${jiraNames.join(", ")} must be configured together`);
  }
  if (jiraConfigured.length) {
    const projectKey = String(env.GUARDIANBOT_FINDINGS_JIRA_PROJECT_KEY).trim();
    const issueType = env.GUARDIANBOT_FINDINGS_JIRA_ISSUE_TYPE?.trim() || "Bug";
    if (!JIRA_PROJECT_KEY_PATTERN.test(projectKey)) {
      throw new Error("GUARDIANBOT_FINDINGS_JIRA_PROJECT_KEY must be an uppercase Jira project key");
    }
    if (!JIRA_ISSUE_TYPE_PATTERN.test(issueType)) {
      throw new Error("GUARDIANBOT_FINDINGS_JIRA_ISSUE_TYPE must be a plain issue type name");
    }
    const baseUrl = resolveReference(env, "GUARDIANBOT_FINDINGS_JIRA_BASE_URL_REF") as string;
    parseHttpsEndpoint(baseUrl, "Jira base URL");
    jira = {
      baseUrl,
      email: resolveReference(env, "GUARDIANBOT_FINDINGS_JIRA_EMAIL_REF") as string,
      apiToken: resolveReference(env, "GUARDIANBOT_FINDINGS_JIRA_API_TOKEN_REF") as string,
      projectKey,
      issueType
    };
  }
  if (!enabled && (githubIssues || slackWebhookUrl || jira)) {
    throw new Error(
      "finding tickets and notifiers require GUARDIANBOT_FINDINGS_LIFECYCLE_ENABLED=true"
    );
  }
  return { enabled, slaDays, githubIssues, slackWebhookUrl, jira };
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** Same glob semantics as GuardianBot's CODEOWNERS reviewer evidence. */
function pathMatchesPattern(pattern: string, path: string): boolean {
  const normalized = pattern.replace(/^\/+/, "");
  if (!normalized) return false;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  const directory = normalized.endsWith("/") ? ".*" : "";
  const prefix = normalized.includes("/") ? "^" : "(?:^|/)";
  return new RegExp(`${prefix}${escaped}${directory}$`).test(path);
}

export interface CodeOwnersRule {
  pattern: string;
  owners: string[];
}

export function parseCodeOwners(source: string): CodeOwnersRule[] {
  let text = source.replace(/\r\n/g, "\n");
  if (text.endsWith(TRUNCATION_MARKER)) {
    // A truncated index chunk may end mid-line; drop the partial last rule.
    text = text.slice(0, -TRUNCATION_MARKER.length);
    text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  }
  const rules: CodeOwnersRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const pattern = fields[0];
    const owners = fields.slice(1).filter((field) => CODEOWNERS_HANDLE_PATTERN.test(field));
    if (!pattern || !owners.length) continue;
    rules.push({ pattern, owners });
    if (rules.length >= MAX_CODEOWNERS_RULES) break;
  }
  return rules;
}

export interface FindingOwnershipContext {
  config?: GuardianConfig;
  codeOwners: CodeOwnersRule[];
}

/** Scanner paths can carry the container mount prefix; ownership matches repository paths. */
export function repositoryRelativePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const relative = path.replace(/^\/(?:src|workspace)\//, "").replace(/^\.?\/+/, "");
  return relative || undefined;
}

/**
 * Owner precedence: last matching `findings.ownership.rules` entry, then the last
 * matching CODEOWNERS rule, then `findings.ownership.serviceOwner` for findings that
 * have no repository path (image and DAST), otherwise the explicit `unowned`.
 */
export function resolveFindingOwner(
  finding: { source: FindingLifecycleSource; path?: string },
  context: FindingOwnershipContext
): string {
  const ownership = context.config?.findings?.ownership;
  const pathOwned = finding.source === "semgrep" || finding.source === "trivy";
  const path = pathOwned ? repositoryRelativePath(finding.path) : undefined;
  if (path) {
    let owner: string | undefined;
    for (const rule of ownership?.rules ?? []) {
      if (rule.paths.some((pattern) => pathMatchesPattern(pattern, path))) owner = rule.owner;
    }
    if (owner) return owner;
    let owners: string[] = [];
    for (const rule of context.codeOwners) {
      if (pathMatchesPattern(rule.pattern, path)) owners = rule.owners;
    }
    if (owners.length) {
      return [...new Set(owners)].sort().join(" ").slice(0, MAX_OWNER_LENGTH);
    }
    return UNOWNED_FINDING_OWNER;
  }
  if (!pathOwned && ownership?.serviceOwner) return ownership.serviceOwner;
  return UNOWNED_FINDING_OWNER;
}

/**
 * Reads ownership and suppression policy from the immutable index at the
 * repository's current indexed default-branch commit. Returns undefined when no
 * valid configuration is observable, so callers keep previously resolved owners
 * rather than flapping every finding to `unowned`.
 */
export async function loadFindingOwnershipContext(
  store: Store,
  repository: RepositoryRecord
): Promise<FindingOwnershipContext | undefined> {
  if (!repository.indexSha) return undefined;
  const index = await store.getRepositoryIndex(
    repository.repositoryId,
    `github:${repository.repositoryId}`,
    repository.indexSha
  );
  if (!index || index.commitSha !== repository.indexSha) return undefined;
  const configSymbol = index.symbols.find((symbol) =>
    /^\.guardianbot\/config\.ya?ml$/i.test(symbol.path)
  );
  if (!configSymbol) return undefined;
  let config: GuardianConfig;
  try {
    config = parseGuardianConfig(configSymbol.content);
  } catch {
    return undefined;
  }
  const candidates = config.repository.codeowners
    ? [config.repository.codeowners, ...CODEOWNERS_CANDIDATES]
    : CODEOWNERS_CANDIDATES;
  let codeOwners: CodeOwnersRule[] = [];
  for (const candidate of candidates) {
    const symbols = index.symbols
      .filter((symbol) => symbol.path === candidate)
      .sort((left, right) => left.line - right.line);
    if (!symbols.length) continue;
    codeOwners = parseCodeOwners(symbols.map((symbol) => symbol.content).join("\n"));
    break;
  }
  return { config, codeOwners };
}

// ---------------------------------------------------------------------------
// Observations and merge
// ---------------------------------------------------------------------------

export interface LifecycleFindingObservation {
  source: FindingLifecycleSource;
  fingerprint: string;
  ruleId: string;
  severity: FindingLifecycleSeverity;
  path?: string;
  line?: number;
}

/**
 * One scan stream's result from one accepted artifact. `complete` is false when
 * the scanner reported an error or its findings were truncated; an incomplete
 * stream can open or refresh findings but can never mark one fixed.
 */
export interface LifecycleObservation {
  stream: string;
  complete: boolean;
  findings: LifecycleFindingObservation[];
}

export function isTrustedLifecycleRun(
  run: Pick<ScannerWorkflowRunRecord, "event" | "headBranch">,
  repository: Pick<RepositoryRecord, "defaultBranch" | "repositoryState">
): boolean {
  return (
    repository.repositoryState === "active" &&
    (run.event === "push" || run.event === "schedule") &&
    run.headBranch === repository.defaultBranch
  );
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return text.length <= maximum ? text : text.slice(0, maximum);
}

function mergeObservations(observations: readonly LifecycleObservation[]): LifecycleObservation[] {
  const byStream = new Map<string, { complete: boolean; findings: Map<string, LifecycleFindingObservation> }>();
  for (const observation of observations) {
    const entry = byStream.get(observation.stream) ?? { complete: true, findings: new Map() };
    entry.complete &&= observation.complete;
    for (const finding of observation.findings) {
      if (!/^[a-f0-9]{64}$/.test(finding.fingerprint)) continue;
      if (!entry.findings.has(finding.fingerprint)) entry.findings.set(finding.fingerprint, finding);
    }
    byStream.set(observation.stream, entry);
  }
  return [...byStream.entries()].map(([stream, entry]) => {
    const findings = [...entry.findings.values()];
    return {
      stream,
      complete: entry.complete && findings.length <= MAX_LIFECYCLE_FINDINGS_PER_STREAM,
      findings: findings.slice(0, MAX_LIFECYCLE_FINDINGS_PER_STREAM)
    };
  });
}

function compareRunOrder(
  left: Pick<FindingLifecycleStreamWatermark, "runStartedAt" | "runId" | "runAttempt">,
  right: Pick<FindingLifecycleStreamWatermark, "runStartedAt" | "runId" | "runAttempt">
): number {
  return (
    (Date.parse(left.runStartedAt) || 0) - (Date.parse(right.runStartedAt) || 0) ||
    left.runId - right.runId ||
    left.runAttempt - right.runAttempt
  );
}

function activeSuppressionStatus(
  config: GuardianConfig | undefined,
  fingerprint: string,
  now: number
): FindingLifecycleStatus | undefined {
  const suppression = (config?.scanners.suppressions ?? []).find(
    (candidate) => candidate.fingerprint === fingerprint
  );
  if (!suppression) return undefined;
  const expiresAt = Date.parse(suppression.expiresAt);
  // Same semantics as the gate: an expired or unreadable expiry is not a suppression.
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  return RISK_ACCEPTED_REASON.test(suppression.reason) ? "risk-accepted" : "suppressed";
}

export function computeSlaDueAt(
  severity: FindingLifecycleSeverity,
  openedAt: string,
  slaDays: FindingsLifecycleOptions["slaDays"]
): string | undefined {
  const days = slaDays[severity];
  const opened = Date.parse(openedAt);
  if (days === undefined || Number.isNaN(opened)) return undefined;
  return new Date(opened + days * DAY_MS).toISOString();
}

function recordSignature(record: FindingLifecycleRecord): string {
  return JSON.stringify({ ...record, updatedAt: undefined });
}

export interface IngestFindingObservationsInput {
  store: Store;
  repository: RepositoryRecord;
  run: ScannerWorkflowRunRecord;
  observations: readonly LifecycleObservation[];
  options: Pick<FindingsLifecycleOptions, "enabled" | "slaDays">;
  now: Date;
}

export interface IngestFindingObservationsResult {
  ingested: boolean;
  changed: number;
  staleStreams: string[];
}

/**
 * Merges one accepted run's observations under the per-repository lifecycle lock.
 * A stream whose watermark is newer than this run is skipped, so a delayed retry
 * of an old run can neither reopen nor fix what a newer run already decided.
 */
export async function ingestFindingObservations(
  input: IngestFindingObservationsInput
): Promise<IngestFindingObservationsResult> {
  const result: IngestFindingObservationsResult = { ingested: false, changed: 0, staleStreams: [] };
  if (!input.options.enabled || !isTrustedLifecycleRun(input.run, input.repository)) return result;
  const observations = mergeObservations(input.observations);
  if (!observations.length) return result;
  const repositoryId = input.repository.repositoryId;
  const context = await loadFindingOwnershipContext(input.store, input.repository);
  const nowIso = input.now.toISOString();
  const nowMs = input.now.getTime();
  const observedAt = input.run.completedAt ?? nowIso;
  const runOrder = {
    runStartedAt: input.run.startedAt ?? input.run.completedAt ?? nowIso,
    runId: input.run.runId,
    runAttempt: input.run.runAttempt
  };
  const lock = await input.store.acquireFindingLifecycleLock(repositoryId);
  try {
    const [records, watermarks] = await Promise.all([
      input.store.listFindingLifecycle(repositoryId, MAX_FINDING_LIFECYCLE_RECORDS),
      input.store.listFindingLifecycleStreams(repositoryId)
    ]);
    const watermarkByStream = new Map(watermarks.map((watermark) => [watermark.stream, watermark]));
    const accepted = observations.filter((observation) => {
      const watermark = watermarkByStream.get(observation.stream);
      const fresh = !watermark || compareRunOrder(runOrder, watermark) >= 0;
      if (!fresh) result.staleStreams.push(observation.stream);
      return fresh;
    });
    if (!accepted.length) return result;
    const before = new Map(records.map((record) => [record.fingerprint, recordSignature(record)]));
    const byFingerprint = new Map(records.map((record) => [record.fingerprint, structuredClone(record)]));
    for (const observation of accepted) {
      const seen = new Set<string>();
      for (const finding of observation.findings) {
        seen.add(finding.fingerprint);
        let record = byFingerprint.get(finding.fingerprint);
        if (!record) {
          record = {
            repositoryId,
            fingerprint: finding.fingerprint,
            source: finding.source,
            ruleId: "",
            severity: finding.severity,
            status: "open",
            owner: UNOWNED_FINDING_OWNER,
            streams: {},
            firstSeenAt: observedAt,
            openedAt: observedAt,
            lastSeenAt: observedAt,
            lastRunId: input.run.runId,
            lastRunAttempt: input.run.runAttempt,
            tickets: {},
            updatedAt: nowIso
          };
          byFingerprint.set(finding.fingerprint, record);
        } else if (!Object.keys(record.streams).length) {
          // A fixed root cause that returns starts a new SLA episode.
          record.openedAt = observedAt;
          record.fixedAt = undefined;
        }
        record.source = finding.source;
        record.ruleId = boundedText(finding.ruleId, 256) ?? "unknown";
        record.severity = finding.severity;
        record.path = boundedText(repositoryRelativePath(finding.path) ?? finding.path, 1_024);
        record.line =
          Number.isSafeInteger(finding.line) && Number(finding.line) > 0 ? finding.line : undefined;
        record.streams[observation.stream] = observedAt;
        if (Date.parse(observedAt) >= Date.parse(record.lastSeenAt) || Number.isNaN(Date.parse(record.lastSeenAt))) {
          record.lastSeenAt = observedAt;
        }
        record.lastRunId = input.run.runId;
        record.lastRunAttempt = input.run.runAttempt;
      }
      if (!observation.complete) continue;
      for (const record of byFingerprint.values()) {
        if (record.streams[observation.stream] !== undefined && !seen.has(record.fingerprint)) {
          delete record.streams[observation.stream];
        }
      }
    }
    for (const record of byFingerprint.values()) {
      const present = Object.keys(record.streams).length > 0;
      const previousStatus = record.status;
      if (!present) {
        record.status = "fixed";
        if (previousStatus !== "fixed" || !record.fixedAt) record.fixedAt = observedAt;
      } else {
        record.status =
          activeSuppressionStatus(context?.config, record.fingerprint, nowMs) ?? "open";
        record.fixedAt = undefined;
      }
      if (context) record.owner = resolveFindingOwner(record, context);
      record.slaDueAt = computeSlaDueAt(record.severity, record.openedAt, input.options.slaDays);
    }
    const removed = retireFixedRecords(byFingerprint);
    const changed = [...byFingerprint.values()].filter(
      (record) => before.get(record.fingerprint) !== recordSignature(record)
    );
    for (const record of changed) record.updatedAt = nowIso;
    await input.store.saveFindingLifecycle(
      repositoryId,
      changed,
      accepted.map((observation) => ({
        repositoryId,
        stream: observation.stream,
        ...runOrder,
        updatedAt: nowIso
      })),
      removed
    );
    result.ingested = true;
    result.changed = changed.length + removed.length;
    return result;
  } finally {
    await lock.release();
  }
}

/** Keeps a repository within its bound by retiring the longest-fixed records first. */
function retireFixedRecords(byFingerprint: Map<string, FindingLifecycleRecord>): string[] {
  const overflow = byFingerprint.size - MAX_FINDING_LIFECYCLE_RECORDS;
  if (overflow <= 0) return [];
  const retirable = [...byFingerprint.values()]
    .filter(
      (record) =>
        record.status === "fixed" &&
        Object.values(record.tickets).every((ticket) => !ticket || ticket.state !== "open")
    )
    .sort(
      (left, right) =>
        (Date.parse(left.fixedAt ?? "") || 0) - (Date.parse(right.fixedAt ?? "") || 0) ||
        left.fingerprint.localeCompare(right.fingerprint)
    )
    .slice(0, overflow)
    .map((record) => record.fingerprint);
  for (const fingerprint of retirable) byFingerprint.delete(fingerprint);
  // Anything still over the bound is the newest open work; the newest insertions are
  // dropped rather than the store growing without limit.
  if (byFingerprint.size > MAX_FINDING_LIFECYCLE_RECORDS) {
    const newest = [...byFingerprint.values()]
      .sort((left, right) => (Date.parse(right.firstSeenAt) || 0) - (Date.parse(left.firstSeenAt) || 0))
      .slice(0, byFingerprint.size - MAX_FINDING_LIFECYCLE_RECORDS);
    for (const record of newest) byFingerprint.delete(record.fingerprint);
  }
  return retirable;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export interface FindingTicketPassResult {
  attempted: number;
  failed: number;
}

export function ticketContentFor(
  repository: RepositoryRecord,
  record: FindingLifecycleRecord,
  slaDays: FindingsLifecycleOptions["slaDays"],
  now: Date
): FindingTicketContent {
  const tracked = slaDays[record.severity] !== undefined;
  return {
    repository: repository.fullName,
    fingerprint: record.fingerprint,
    source: record.source,
    ruleId: record.ruleId,
    severity: record.severity,
    path: record.path,
    line: record.line,
    owner: record.owner,
    status: record.status,
    breached: isFindingSlaBreached(record, now.getTime()),
    firstSeenAt: record.firstSeenAt,
    openedAt: record.openedAt,
    slaDueAt: record.slaDueAt,
    fixedAt: record.fixedAt,
    state: record.status === "open" && tracked ? "open" : "closed"
  };
}

function providerApplies(
  provider: FindingTicketProvider,
  repository: RepositoryRecord,
  context: FindingOwnershipContext | undefined
): boolean {
  if (!provider.requiresRepositoryOptIn) return true;
  // GitHub issues are written into the repository itself: they need the repository's
  // own opt-in, and they are never written to public repositories, where an issue
  // would publish the location of an unfixed vulnerability.
  return repository.visibility !== "public" && context?.config?.findings?.githubIssues === true;
}

/**
 * Brings provider tickets in line with lifecycle records. Each provider failure is
 * sanitized and stored on the record (so monitoring raises `findings-ticketing`) and
 * retried on the next pass; it never fails scanner acceptance or monitoring.
 */
export async function syncFindingTickets(input: {
  store: Store;
  repository: RepositoryRecord;
  providers: readonly FindingTicketProvider[];
  slaDays: FindingsLifecycleOptions["slaDays"];
  now: Date;
  limit?: number;
}): Promise<FindingTicketPassResult> {
  const result: FindingTicketPassResult = { attempted: 0, failed: 0 };
  if (!input.providers.length) return result;
  const context = await loadFindingOwnershipContext(input.store, input.repository);
  const providers = input.providers.filter((provider) =>
    providerApplies(provider, input.repository, context)
  );
  if (!providers.length) return result;
  const limit = input.limit ?? MAX_TICKET_SYNCS_PER_PASS;
  const repositoryId = input.repository.repositoryId;
  const nowIso = input.now.toISOString();
  const lock = await input.store.acquireFindingLifecycleLock(repositoryId);
  try {
    const records = await input.store.listFindingLifecycle(repositoryId, MAX_FINDING_LIFECYCLE_RECORDS);
    const sessions = new Map<string, FindingTicketSession | Error>();
    const changed = new Map<string, FindingLifecycleRecord>();
    for (const record of records) {
      if (result.attempted >= limit) break;
      const content = ticketContentFor(input.repository, record, input.slaDays, input.now);
      for (const provider of providers) {
        if (result.attempted >= limit) break;
        const previous = record.tickets[provider.name];
        if (!previous && content.state === "closed") continue;
        const contentSha = provider.contentSha(content);
        if (previous && !previous.error && previous.contentSha === contentSha) continue;
        result.attempted += 1;
        let next: FindingTicketState;
        try {
          let session = sessions.get(provider.name);
          if (!session) {
            try {
              session = provider.session(input.repository);
            } catch (error) {
              session = error instanceof Error ? error : new Error("ticket provider failed");
            }
            sessions.set(provider.name, session);
          }
          if (session instanceof Error) throw session;
          const synced = await session.sync(content, previous);
          next = {
            ref: synced.ref ?? previous?.ref,
            state: content.state,
            contentSha,
            updatedAt: nowIso
          };
        } catch (error) {
          result.failed += 1;
          next = {
            ref: previous?.ref,
            state: previous?.state,
            contentSha: previous?.contentSha,
            error: sanitizeTicketError(error),
            updatedAt: nowIso
          };
        }
        if (next.ref === undefined) delete next.ref;
        if (next.state === undefined) delete next.state;
        if (next.contentSha === undefined) delete next.contentSha;
        const target = changed.get(record.fingerprint) ?? structuredClone(record);
        target.tickets[provider.name] = next;
        target.updatedAt = nowIso;
        changed.set(record.fingerprint, target);
      }
    }
    if (changed.size) {
      await input.store.saveFindingLifecycle(repositoryId, [...changed.values()]);
    }
    return result;
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface FindingsLifecycleRuntime {
  options: FindingsLifecycleOptions;
  providers: readonly FindingTicketProvider[];
}

export function createFindingsLifecycleRuntime(
  options: FindingsLifecycleOptions,
  dependencies: {
    appId: string;
    privateKey: string;
    fetchImpl?: typeof fetch;
    githubApiBase?: string;
    retry?: FindingTicketRetryPolicy;
  }
): FindingsLifecycleRuntime {
  if (!options.enabled) return { options, providers: [] };
  const retry = dependencies.retry ?? defaultTicketRetryPolicy();
  const providers: FindingTicketProvider[] = [];
  if (options.githubIssues) {
    providers.push(
      createGitHubIssuesProvider({
        clientFactory: createInstallationIssueClientFactory({
          appId: dependencies.appId,
          privateKey: dependencies.privateKey,
          fetchImpl: dependencies.fetchImpl,
          apiBase: dependencies.githubApiBase
        }),
        retry
      })
    );
  }
  if (options.jira) {
    providers.push(
      createJiraProvider({ ...options.jira, fetchImpl: dependencies.fetchImpl, retry })
    );
  }
  if (options.slackWebhookUrl) {
    providers.push(
      createSlackNotifier({
        webhookUrl: options.slackWebhookUrl,
        fetchImpl: dependencies.fetchImpl,
        retry
      })
    );
  }
  return { options, providers };
}

/**
 * Ingests one accepted run and then brings tickets up to date. Ticket failures are
 * recorded on the lifecycle records; only a store failure propagates, so the
 * scanner job is retried rather than the observation being silently dropped.
 */
export async function recordAcceptedRunLifecycle(input: {
  runtime: FindingsLifecycleRuntime;
  store: Store;
  repository: RepositoryRecord;
  run: ScannerWorkflowRunRecord;
  observations: readonly LifecycleObservation[];
  now: Date;
}): Promise<void> {
  const ingest = await ingestFindingObservations({
    store: input.store,
    repository: input.repository,
    run: input.run,
    observations: input.observations,
    options: input.runtime.options,
    now: input.now
  });
  if (!ingest.ingested || !input.runtime.providers.length) return;
  try {
    await syncFindingTickets({
      store: input.store,
      repository: input.repository,
      providers: input.runtime.providers,
      slaDays: input.runtime.options.slaDays,
      now: input.now
    });
  } catch {
    // The lifecycle merge is already durable; the monitoring pass retries tickets.
  }
}
