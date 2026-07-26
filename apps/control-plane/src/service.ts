import {
  GitHubClient,
  detectRepository,
  parseGuardianConfig,
  verifyWebhookSignature,
  DeliveryReplayGuard
} from "@guardianbot/core";
import { createHash } from "node:crypto";
import {
  GuardianReviewClient,
  validateReviewResult,
  type ReviewRequest
} from "@guardianbot/protocol";
import { installationClient } from "./app-auth.js";
import { onboardingIssue, renderPlaceholder, renderReview } from "./render.js";
import type { Store } from "./store.js";

interface ServiceOptions {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  modelBackendUrl?: string;
  modelBackendToken?: string;
}

type GitHubEvent = Record<string, any>;

export class GuardianService {
  private readonly replay = new DeliveryReplayGuard();
  constructor(private readonly options: ServiceOptions, private readonly store: Store) {}

  authenticate(body: string, signature: string | undefined, delivery: string): void {
    if (!delivery || delivery.length > 100) throw new Error("invalid delivery identifier");
    if (!signature || !verifyWebhookSignature(Buffer.from(body), signature, this.options.webhookSecret)) {
      throw new Error("invalid webhook signature");
    }
    if (!this.replay.accept(delivery)) throw new Error("duplicate delivery");
  }

  private client(event: GitHubEvent): Promise<GitHubClient> {
    return installationClient(this.options.appId, this.options.privateKey, event.installation.id);
  }

  async handle(name: string, event: GitHubEvent): Promise<void> {
    if (name === "installation" || name === "installation_repositories" || name === "repository") {
      const repositories = event.repositories_added ?? event.repositories ??
        (event.repository ? [event.repository] : []);
      for (const repository of repositories) await this.discover(event, repository);
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
    const github = await this.client(event);
    const [owner, name] = repository.full_name.split("/");
    const files = await github.getTree(owner, name, repository.default_branch);
    const languages = await github.getLanguages(owner, name);
    const snapshot = {
      owner, name, defaultBranch: repository.default_branch,
      visibility: repository.private ? "private" as const : "public" as const,
      files, languages
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
      indexUpdatedAt: new Date().toISOString()
    });
    if (!existing) {
      await github.createIssue(owner, name, "GuardianBot onboarding inventory", onboardingIssue(
        repository.full_name, [...detection.languages, ...detection.packageManagers], detection.notes
      ));
    }
  }

  private async reviewPullRequest(event: GitHubEvent): Promise<void> {
    if (event.pull_request.draft) return;
    const github = await this.client(event);
    const [owner, repo] = event.repository.full_name.split("/");
    const pull = event.pull_request;
    const existing = await this.store.getReview(event.repository.id, pull.number);
    const placeholder = existing?.placeholderCommentId
      ? { id: existing.placeholderCommentId }
      : await github.createComment(owner, repo, pull.number, renderPlaceholder(pull.head.sha));
    const configFile = await github.getFile(owner, repo, ".guardianbot/config.yml", pull.base.ref);
    let scannerConfigured = false;
    if (configFile) {
      try { parseGuardianConfig(configFile.content); scannerConfigured = true; } catch { /* advisory continues */ }
    }
    if (!this.options.modelBackendUrl) {
      await github.updateComment(owner, repo, placeholder.id, `${renderPlaceholder(pull.head.sha)}\n\nAI review unavailable: no approved backend route.`);
      return;
    }
    const files = await github.request<Array<{ filename: string; patch?: string; status: string }>>(
      "GET", `/repos/${owner}/${repo}/pulls/${pull.number}/files?per_page=100`
    );
    const validChangedLines = files.flatMap((file) =>
      addedLineRanges(file.patch ?? "").map((range) => ({ path: file.filename, ...range }))
    );
    let remainingCharacters = 180_000;
    const contexts = files.slice(0, 100).flatMap((file, index) => {
      if (remainingCharacters <= 0) return [];
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
    const totalChangedLines = validChangedLines.reduce(
      (sum, range) => sum + range.end - range.start + 1, 0
    );
    const highRisk = files.length > 50 || totalChangedLines > 5_000 ||
      files.some((file) => /(^|\/)(auth|security|migrations)(\/|$)|\.github\/workflows|Dockerfile|secret|tenant/i.test(file.filename));
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
        number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha,
        title: pull.title, body: String(pull.body ?? "").slice(0, 4000),
        author: pull.user.login
      },
      profile: highRisk ? "high-risk-review" : "routine-review",
      promptVersion: "guardianbot-review-2026-07-27",
      validChangedLines,
      contexts,
      scannerEvidence: [],
      rules: [],
      limits: { maxInlineComments: 8, maxInputCharacters: 200_000, timeoutMs: 90_000 }
    };
    try {
      const client = new GuardianReviewClient({
        id: "administratively-configured",
        baseUrl: this.options.modelBackendUrl,
        authSecret: this.options.modelBackendToken,
        allowedClassifications: ["public", "private"],
        timeoutMs: 90_000
      });
      const capabilities = await client.capabilities();
      if (!capabilities.structuredOutput ||
          !capabilities.supportedProfiles.includes(request.profile) ||
          !capabilities.supportedDataClassifications.includes(request.repository.visibility) ||
          capabilities.maxInputCharacters < request.limits.maxInputCharacters) {
        throw new Error("model backend capability policy rejected this review");
      }
      const result = await client.review(request);
      validateReviewResult(result, request);
      await github.updateComment(owner, repo, placeholder.id, renderReview(result, scannerConfigured));
      await this.store.saveReview({
        repositoryId: event.repository.id, pullNumber: pull.number, headSha: pull.head.sha,
        placeholderCommentId: placeholder.id,
        findings: result.findings.map((finding) => ({ fingerprint: finding.fingerprint, state: "open" }))
      });
    } catch (error) {
      await github.updateComment(owner, repo, placeholder.id,
        `${renderPlaceholder(pull.head.sha)}\n\nAI review unavailable: output failed transport or strict validation.`
      );
    }
  }

  private async command(event: GitHubEvent): Promise<void> {
    if (!event.issue.pull_request) return;
    const text = String(event.comment.body).trim();
    if (!/^@guardianbot\b/i.test(text)) return;
    const github = await this.client(event);
    const [owner, repo] = event.repository.full_name.split("/");
    const command = text.replace(/^@guardianbot\s*/i, "").split(/\s+/)[0]?.toLowerCase();
    const reply = command === "help"
      ? "Commands: `review`, `full-review`, `status`, `explain <id>`, `suggest-fix <id>`, `pause`, `resume`, `help`."
      : command === "status"
        ? "GuardianBot is installed. Use `guardianctl doctor OWNER/REPOSITORY` for deterministic workflow diagnostics."
        : "Command acknowledged. Automated execution is available for `review`, `full-review`, `status`, and `help` in the PoC; other commands are recorded for the production roadmap.";
    await github.createComment(owner, repo, event.issue.number, reply);
  }
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
