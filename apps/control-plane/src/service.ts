import {
  GitHubClient,
  detectRepository,
  parseGuardianConfig,
  verifyWebhookSignature
} from "@guardianbot/core";
import {
  BackendError,
  GuardianReviewClient,
  validateReviewResult,
  type BackendCapabilities,
  type ReviewRequest,
  type ReviewResult
} from "@guardianbot/protocol";
import { createHash } from "node:crypto";
import { installationClient } from "./app-auth.js";
import { GuardianMetrics } from "./metrics.js";
import { onboardingIssue, renderPlaceholder, renderReview } from "./render.js";
import type { RepositoryLifecycleState, ReviewState, Store } from "./store.js";

interface ServiceOptions {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  modelBackendUrl?: string;
  modelBackendToken?: string;
  maxWebhookAttempts?: number;
  webhookLeaseMs?: number;
  githubClientFactory?: (event: GitHubEvent, repositoryIds?: number[]) => Promise<GitHubClientLike>;
  reviewClientFactory?: () => ReviewBackend | undefined;
  now?: () => Date;
  metrics?: GuardianMetrics;
}

type GitHubEvent = Record<string, any>;

interface GitHubPullFile {
  filename: string;
  patch?: string;
  status: string;
  additions?: number;
  changes?: number;
}

interface GitHubPull {
  number: number;
  head: { sha: string };
  base: { sha: string; ref: string };
  title: string;
  body?: string | null;
  user: { login: string };
  draft?: boolean;
}

interface GitHubClientLike {
  getTree(owner: string, repo: string, ref: string): Promise<string[]>;
  getLanguages(owner: string, repo: string): Promise<Record<string, number>>;
  getFile(owner: string, repo: string, path: string, ref: string): Promise<{ content: string; sha: string } | undefined>;
  createIssue(owner: string, repo: string, title: string, body: string): Promise<{ html_url: string; number: number }>;
  createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<{ id: number; html_url: string }>;
  updateComment(owner: string, repo: string, commentId: number, body: string): Promise<{ id: number; html_url: string }>;
  request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T>;
}

interface ReviewBackend {
  capabilities(): Promise<BackendCapabilities>;
  review(request: ReviewRequest): Promise<ReviewResult>;
}

interface SelectedReviewFiles {
  files: GitHubPullFile[];
  partial: boolean;
  totalFiles: number;
  totalChangedLines: number;
  omittedFiles: string[];
  omittedChangedLines: number;
}

const HIGH_RISK_PATH = /(^|\/)(auth|security|migrations)(\/|$)|\.github\/workflows|Dockerfile|secret|tenant/i;
const REVIEW_FILE_LIMIT = 50;
const REVIEW_LINE_LIMIT = 5_000;
const INPUT_CHARACTER_LIMIT = 200_000;

export class GuardianService {
  readonly metrics: GuardianMetrics;
  private readonly maxWebhookAttempts: number;
  private readonly webhookLeaseMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: ServiceOptions, private readonly store: Store) {
    this.metrics = options.metrics ?? new GuardianMetrics();
    this.maxWebhookAttempts = options.maxWebhookAttempts ?? 5;
    this.webhookLeaseMs = options.webhookLeaseMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
  }

  authenticate(body: string, signature: string | undefined, delivery: string): void {
    if (!delivery || delivery.length > 100) {
      this.metrics.increment("webhook_invalid_total");
      throw new Error("invalid delivery identifier");
    }
    if (!signature || !verifyWebhookSignature(Buffer.from(body), signature, this.options.webhookSecret)) {
      this.metrics.increment("webhook_invalid_total");
      throw new Error("invalid webhook signature");
    }
    this.metrics.increment("webhook_verified_total");
  }

  async enqueue(name: string, event: GitHubEvent, delivery: string): Promise<boolean> {
    const inserted = await this.store.enqueueWebhook(delivery, name, event);
    if (inserted) this.metrics.increment("webhook_enqueued_total");
    else this.metrics.increment("webhook_duplicate_total");
    return inserted;
  }

  async processNextWebhook(workerId: string): Promise<boolean> {
    const job = await this.store.claimWebhook(workerId, this.webhookLeaseMs, this.now());
    if (!job) {
      this.metrics.setQueueDepth(0);
      return false;
    }
    this.metrics.increment("webhook_claimed_total");
    this.metrics.setInFlight(1);
    const startedAt = this.now().getTime();
    try {
      await this.handle(job.eventName, job.payload);
      await this.store.completeWebhook(job.deliveryId, workerId);
      this.metrics.increment("webhook_succeeded_total");
      this.metrics.observeWebhookLatency(this.now().getTime() - startedAt);
    } catch (error) {
      const attempt = job.attempts;
      const permanentBackendFailure = error instanceof BackendError && !error.retryable;
      const deadLetter = permanentBackendFailure || attempt >= this.maxWebhookAttempts;
      const retryAt = deadLetter
        ? undefined
        : new Date(this.now().getTime() + computeBackoffMs(attempt));
      await this.store.failWebhook(
        job.deliveryId,
        workerId,
        error instanceof Error ? error.message : String(error),
        retryAt,
        deadLetter
      );
      this.metrics.increment(deadLetter ? "webhook_dead_letter_total" : "webhook_failed_total");
      if (String(error).startsWith("GitHub ")) this.metrics.increment("github_failures_total");
      if (error instanceof BackendError) this.metrics.increment("backend_failures_total");
    } finally {
      this.metrics.setInFlight(0);
    }
    return true;
  }

  async ready(): Promise<boolean> {
    try {
      await this.store.ping();
      return true;
    } catch {
      return false;
    }
  }

  private client(event: GitHubEvent, repositoryIds?: number[]): Promise<GitHubClientLike> {
    if (this.options.githubClientFactory) return this.options.githubClientFactory(event, repositoryIds);
    return installationClient(this.options.appId, this.options.privateKey, event.installation.id, repositoryIds);
  }

  private reviewClient(): ReviewBackend | undefined {
    if (this.options.reviewClientFactory) return this.options.reviewClientFactory();
    if (!this.options.modelBackendUrl) return undefined;
    return new GuardianReviewClient({
      id: "administratively-configured",
      baseUrl: this.options.modelBackendUrl,
      authSecret: this.options.modelBackendToken,
      allowedClassifications: ["public", "private"],
      timeoutMs: 90_000
    });
  }

  private async handle(name: string, event: GitHubEvent): Promise<void> {
    if (name === "installation") {
      if (event.action === "deleted") {
        await this.store.setInstallationState(event.installation.id, "removed");
        return;
      }
      if (event.action === "suspend") {
        await this.store.setInstallationState(event.installation.id, "suspended");
        return;
      }
      if (event.action === "unsuspend") {
        await this.store.setInstallationState(event.installation.id, "active");
      }
      const repositories = event.repositories ?? (event.repository ? [event.repository] : []);
      for (const repository of repositories) await this.discover(event, repository);
      return;
    }

    if (name === "installation_repositories") {
      for (const repository of event.repositories_removed ?? []) {
        await this.store.setRepositoryState(repository.id, "removed");
      }
      for (const repository of event.repositories_added ?? []) {
        await this.discover(event, repository);
      }
      return;
    }

    if (name === "repository") {
      if (event.action === "deleted" || event.action === "archived") {
        await this.store.setRepositoryState(event.repository.id, "removed");
        return;
      }
      if (event.action === "unarchived") {
        await this.store.setRepositoryState(event.repository.id, "active");
      }
      if (event.repository) {
        await this.discover(event, event.repository);
      }
      return;
    }

    if (name === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review"].includes(event.action)) {
      await this.reviewPullRequest(event);
      return;
    }

    if (name === "issue_comment" && event.action === "created") {
      await this.command(event);
    }
  }

  private async discover(event: GitHubEvent, repository: any): Promise<void> {
    const github = await this.client(event, [repository.id]);
    const [owner, name] = repository.full_name.split("/");
    const files = await github.getTree(owner, name, repository.default_branch);
    const languages = await github.getLanguages(owner, name);
    const snapshot = {
      owner,
      name,
      defaultBranch: repository.default_branch,
      visibility: repository.private ? ("private" as const) : ("public" as const),
      files,
      languages
    };
    const detection = detectRepository(snapshot);
    const existing = await this.store.getRepository(repository.id);
    await this.store.upsertRepository({
      installationId: event.installation.id,
      repositoryId: repository.id,
      fullName: repository.full_name,
      visibility: snapshot.visibility,
      defaultBranch: repository.default_branch,
      scannerState: "not-configured",
      repositoryState: "active",
      indexUpdatedAt: this.now().toISOString()
    });
    if (!existing) {
      await github.createIssue(
        owner,
        name,
        "GuardianBot onboarding inventory",
        onboardingIssue(repository.full_name, [...detection.languages, ...detection.packageManagers], detection.notes)
      );
    }
  }

  private async reviewPullRequest(event: GitHubEvent): Promise<void> {
    const pull = event.pull_request as GitHubPull;
    if (pull.draft) return;

    const github = await this.client(event, [event.repository.id]);
    const [owner, repo] = event.repository.full_name.split("/");
    const currentPull = await this.getCurrentPull(github, owner, repo, pull.number);
    if (!currentPull || currentPull.head.sha !== pull.head.sha) {
      this.metrics.increment("review_stale_total");
      return;
    }

    const existing = await this.store.getReview(event.repository.id, pull.number);
    const placeholder = existing?.placeholderCommentId
      ? { id: existing.placeholderCommentId }
      : await github.createComment(owner, repo, pull.number, renderPlaceholder(pull.head.sha));
    await this.store.saveReviewHead(event.repository.id, pull.number, pull.head.sha, placeholder.id);
    await github.updateComment(owner, repo, placeholder.id, renderPlaceholder(pull.head.sha));

    const configFile = await github.getFile(owner, repo, ".guardianbot/config.yml", pull.base.ref);
    let scannerConfigured = false;
    if (configFile) {
      try {
        parseGuardianConfig(configFile.content);
        scannerConfigured = true;
      } catch {
        scannerConfigured = false;
      }
    }

    const backend = this.reviewClient();
    if (!backend) {
      const saved = await this.store.saveReview(
        {
          repositoryId: event.repository.id,
          pullNumber: pull.number,
          headSha: pull.head.sha,
          placeholderCommentId: placeholder.id,
          findings: existing?.findings ?? []
        },
        pull.head.sha
      );
      if (saved) {
        await github.updateComment(
          owner,
          repo,
          placeholder.id,
          `${renderPlaceholder(pull.head.sha)}\n\nAI review unavailable: no approved backend route.`
        );
      }
      return;
    }

    const allFiles = await this.listPullFiles(github, owner, repo, pull.number);
    const selected = selectFilesForReview(allFiles);
    const validChangedLines = selected.files.flatMap((file) =>
      addedLineRanges(file.patch ?? "").map((range) => ({ path: file.filename, ...range }))
    );
    let remainingCharacters = 180_000;
    let localPartial = selected.partial;
    const contexts = selected.files.flatMap((file, index) => {
      if (remainingCharacters <= 0) {
        localPartial = true;
        return [];
      }
      const content = redactUntrustedText(String(file.patch ?? ""))
        .slice(0, Math.min(30_000, remainingCharacters));
      remainingCharacters -= content.length;
      if (!content) return [];
      return {
        id: `diff-${index}`,
        path: file.filename,
        kind: "diff" as const,
        content,
        sha256: createHash("sha256").update(content).digest("hex")
      };
    });
    const highRisk =
      selected.totalFiles > REVIEW_FILE_LIMIT ||
      selected.totalChangedLines > REVIEW_LINE_LIMIT ||
      selected.files.some((file) => HIGH_RISK_PATH.test(file.filename));
    const request: ReviewRequest = {
      protocolVersion: "guardian.review.v1",
      schemaVersion: "1.0.0",
      requestId: `${event.repository.id}:${pull.number}:${pull.head.sha}`,
      repository: {
        owner,
        name: repo,
        visibility: event.repository.private ? "private" : "public",
        defaultBranch: event.repository.default_branch
      },
      pullRequest: {
        number: pull.number,
        baseSha: pull.base.sha,
        headSha: pull.head.sha,
        title: pull.title,
        body: String(pull.body ?? "").slice(0, 4000),
        author: pull.user.login
      },
      profile: highRisk ? "high-risk-review" : "routine-review",
      promptVersion: "guardianbot-review-2026-07-27",
      validChangedLines,
      contexts,
      scannerEvidence: [],
      rules: [],
      limits: { maxInlineComments: 8, maxInputCharacters: INPUT_CHARACTER_LIMIT, timeoutMs: 90_000 }
    };

    try {
      const capabilities = await backend.capabilities();
      this.assertCapabilities(capabilities, request);
      const result = await backend.review(request);
      validateReviewResult(result, request);

      const latestPull = await this.getCurrentPull(github, owner, repo, pull.number);
      if (!latestPull || latestPull.head.sha !== pull.head.sha) {
        this.metrics.increment("review_stale_total");
        return;
      }

      const saved = await this.store.saveReview(
        {
          repositoryId: event.repository.id,
          pullNumber: pull.number,
          headSha: pull.head.sha,
          placeholderCommentId: placeholder.id,
          findings: result.findings.map((finding) => ({ fingerprint: finding.fingerprint, state: "open" as const }))
        },
        pull.head.sha
      );
      if (!saved) {
        this.metrics.increment("review_stale_total");
        return;
      }

      const finalResult: ReviewResult = localPartial
        ? {
            ...result,
            summary: {
              ...result.summary,
              partialReview: true
            }
          }
        : result;
      const partialSuffix = localPartial
        ? `\n\nPartial review warning: reviewed ${selected.files.length}/${selected.totalFiles} files and ${selected.totalChangedLines - selected.omittedChangedLines}/${selected.totalChangedLines} changed lines. Omitted files include ${selected.omittedFiles.slice(0, 5).map((value) => `\`${value}\``).join(", ") || "none"}.`
        : "";
      await github.updateComment(
        owner,
        repo,
        placeholder.id,
        `${renderReview(finalResult, scannerConfigured)}${partialSuffix}`
      );
    } catch (error) {
      const saved = await this.store.saveReview(
        {
          repositoryId: event.repository.id,
          pullNumber: pull.number,
          headSha: pull.head.sha,
          placeholderCommentId: placeholder.id,
          findings: existing?.findings ?? []
        },
        pull.head.sha
      );
      if (saved) {
        await github.updateComment(
          owner,
          repo,
          placeholder.id,
          `${renderPlaceholder(pull.head.sha)}\n\nAI review unavailable: output failed transport or strict validation.`
        );
      }
      if (error instanceof BackendError) throw error;
      throw new BackendError("invalid_output", "review processing failed strict validation", false);
    }
  }

  private async command(event: GitHubEvent): Promise<void> {
    if (!event.issue.pull_request) return;
    const text = String(event.comment.body).trim();
    if (!/^@guardianbot\b/i.test(text)) return;
    const github = await this.client(event, [event.repository.id]);
    const [owner, repo] = event.repository.full_name.split("/");
    const actor = String(event.comment.user?.login ?? "");
    const permission = await this.getActorPermission(github, owner, repo, actor);
    if (!["write", "maintain", "admin"].includes(permission)) {
      this.metrics.increment("commands_rejected_total");
      await github.createComment(
        owner,
        repo,
        event.issue.number,
        `@${actor} is not authorized to run GuardianBot commands on this repository.`
      );
      return;
    }
    this.metrics.increment("commands_authorized_total");
    const command = text.replace(/^@guardianbot\s*/i, "").split(/\s+/)[0]?.toLowerCase();
    const reply =
      command === "help"
        ? "Commands: `review`, `full-review`, `status`, `explain <id>`, `suggest-fix <id>`, `pause`, `resume`, `help`."
        : command === "status"
          ? "GuardianBot is installed. Use `guardianctl doctor OWNER/REPOSITORY` for deterministic workflow diagnostics."
          : "Command acknowledged. Automated execution is available for `review`, `full-review`, `status`, and `help` in the PoC; other commands are recorded for the production roadmap.";
    await github.createComment(owner, repo, event.issue.number, reply);
  }

  private async getCurrentPull(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPull | undefined> {
    try {
      return await github.request<GitHubPull>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}`);
    } catch (error) {
      if (String(error).includes("returned 404")) return undefined;
      throw error;
    }
  }

  private async listPullFiles(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullFile[]> {
    const files: GitHubPullFile[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await github.request<GitHubPullFile[]>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  private async getActorPermission(
    github: GitHubClientLike,
    owner: string,
    repo: string,
    actor: string
  ): Promise<string> {
    try {
      const result = await github.request<{ permission: string }>(
        "GET",
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(actor)}/permission`
      );
      return result.permission;
    } catch (error) {
      if (String(error).includes("returned 404")) return "none";
      throw error;
    }
  }

  private assertCapabilities(capabilities: BackendCapabilities, request: ReviewRequest): void {
    if (
      !capabilities.structuredOutput ||
      !capabilities.supportedProfiles.includes(request.profile) ||
      !capabilities.supportedDataClassifications.includes(request.repository.visibility) ||
      capabilities.maxInputCharacters < request.limits.maxInputCharacters
    ) {
      throw new Error("model backend capability policy rejected this review");
    }
  }
}

function computeBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

function filePriority(file: GitHubPullFile): number {
  const sensitive = HIGH_RISK_PATH.test(file.filename) ? 10_000 : 0;
  const additions = file.additions ?? 0;
  const changes = file.changes ?? additions;
  const patchLength = file.patch?.length ?? 0;
  return sensitive + changes * 10 + additions * 5 + patchLength;
}

function countAddedLines(file: GitHubPullFile): number {
  return addedLineRanges(file.patch ?? "").reduce((sum, range) => sum + (range.end - range.start + 1), 0);
}

function selectFilesForReview(files: GitHubPullFile[]): SelectedReviewFiles {
  const sorted = [...files].sort((left, right) => filePriority(right) - filePriority(left));
  const selected: GitHubPullFile[] = [];
  const omittedFiles: string[] = [];
  let selectedLines = 0;
  let omittedLines = 0;
  for (const file of sorted) {
    const fileLines = countAddedLines(file);
    const wouldExceedLineBudget =
      selected.length > 0 && selectedLines + fileLines > REVIEW_LINE_LIMIT && !HIGH_RISK_PATH.test(file.filename);
    if (selected.length >= REVIEW_FILE_LIMIT || wouldExceedLineBudget) {
      omittedFiles.push(file.filename);
      omittedLines += fileLines;
      continue;
    }
    selected.push(file);
    selectedLines += fileLines;
  }
  const totalChangedLines = sorted.reduce((sum, file) => sum + countAddedLines(file), 0);
  return {
    files: selected,
    partial: omittedFiles.length > 0,
    totalFiles: sorted.length,
    totalChangedLines,
    omittedFiles,
    omittedChangedLines: omittedLines
  };
}

export function addedLineRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let newLine = 0;
  let active: { start: number; end: number } | undefined;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      if (active) ranges.push(active);
      active = undefined;
      newLine = Number(header[1]);
      continue;
    }
    if (!newLine) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (active && active.end === newLine - 1) active.end = newLine;
      else {
        if (active) ranges.push(active);
        active = { start: newLine, end: newLine };
      }
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (active) ranges.push(active);
      active = undefined;
    } else {
      if (active) ranges.push(active);
      active = undefined;
      if (!line.startsWith("\\")) newLine += 1;
    }
  }
  if (active) ranges.push(active);
  return ranges;
}

export function redactUntrustedText(value: string): string {
  return value
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_ACCESS_KEY]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|secret|password|token)\s*[:=]\s*)["']?[^\s"',}]+/gi, "$1[REDACTED]");
}
