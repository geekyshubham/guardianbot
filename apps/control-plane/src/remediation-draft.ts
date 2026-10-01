import { createHash } from "node:crypto";
import type { ReviewFindingRecord } from "./store.js";

/**
 * Mode C remediation drafts: the deterministic second validator.
 *
 * A draft is only ever written after every check here passes. The validator is pure and takes no
 * model input beyond the suggestion text GuardianBot itself already validated and published, so
 * its decision is reproducible from the retained finding record, the published advisory, and the
 * file at the pull request head. No second model is consulted: `guardian.review.v1` has no
 * validation operation, and adding one would change the frozen protocol, so the second validator
 * is deterministic only.
 */

/** Lines a single draft may replace or introduce. Small by design: this is a suggestion, not a refactor. */
export const MAX_DRAFT_RANGE_LINES = 50;
export const MAX_DRAFT_SUGGESTION_LINES = 200;
export const MAX_DRAFT_SUGGESTION_CHARACTERS = 8_000;
/** Ceiling on the file a draft may rewrite; the contents API stops returning content at 1 MB. */
export const MAX_DRAFT_FILE_BYTES = 512 * 1024;
export const REMEDIATION_BRANCH_PREFIX = "guardianbot/fix/";
export const REMEDIATION_DRAFT_LABEL = "guardianbot-ai-draft";

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
  "gradle.lockfile",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock"
]);

const CI_FILES = new Set([
  ".gitlab-ci.yml",
  ".travis.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "appveyor.yml",
  ".drone.yml",
  "codeowners"
]);

const CI_DIRECTORIES = [".github/", ".guardianbot/", ".circleci/", ".buildkite/", ".gitlab/", ".azure-pipelines/"];

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "psd",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "jar", "war", "class", "exe", "dll", "so", "dylib", "a", "o", "obj", "lib", "bin",
  "wasm", "pyc", "pyo", "whl", "egg",
  "mp3", "mp4", "mov", "avi", "wav", "flac", "ogg", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  "sqlite", "db", "keystore", "jks", "p12", "pfx", "der"
]);

export type RemediationRejection =
  | "invalid-path"
  | "forbidden-path"
  | "binary-file"
  | "finding-not-open"
  | "finding-dismissed"
  | "stale-head"
  | "missing-suggestion"
  | "suggestion-mismatch"
  | "invalid-range"
  | "range-not-changed"
  | "size-bound"
  | "unsupported-line-endings"
  | "no-op"
  | "out-of-range-change";

export const REMEDIATION_REJECTION_TEXT: Record<RemediationRejection, string> = {
  "invalid-path": "the finding path is not a normalized repository path",
  "forbidden-path":
    "the finding path is protected (workflow, CI, GuardianBot configuration, CODEOWNERS, or a lockfile)",
  "binary-file": "the target file is binary",
  "finding-not-open": "the finding is not open",
  "finding-dismissed": "the finding was dismissed",
  "stale-head": "the finding was not validated at the current pull request head",
  "missing-suggestion": "the finding has no exact validated suggestion",
  "suggestion-mismatch": "the published suggestion does not match the validated suggestion",
  "invalid-range": "the finding line range does not fit the file at the current head",
  "range-not-changed": "the finding range is not entirely inside lines this pull request changed",
  "size-bound": "the change exceeds the remediation draft size bounds",
  "unsupported-line-endings": "the target file uses CRLF line endings",
  "no-op": "the suggestion would not change the file",
  "out-of-range-change": "the computed change touches lines outside the finding range"
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Same normalization `exactSuggestion` applies before rendering, so digests compare like for like. */
export function normalizeSuggestion(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function isNormalizedPath(path: string): boolean {
  if (!path || path.length > 400) return false;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\u0000")) {
    return false;
  }
  return path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

/**
 * Paths a remediation draft may never write. Matched case-insensitively, because GitHub treats a
 * workflow under `.GitHub/` as inert but a reviewer should not have to reason about that.
 */
export function isForbiddenRemediationPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (CI_DIRECTORIES.some((directory) => lower.startsWith(directory))) return true;
  const base = lower.split("/").at(-1) ?? lower;
  if (LOCKFILES.has(base) || base.endsWith(".lock")) return true;
  if (CI_FILES.has(base)) return true;
  if (lower === "docs/codeowners") return true;
  return false;
}

export function isBinaryPath(path: string): boolean {
  const base = path.toLowerCase().split("/").at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && BINARY_EXTENSIONS.has(base.slice(dot + 1));
}

export interface RemediationValidationInput {
  finding: ReviewFindingRecord;
  /** Head SHA GitHub reports for the pull request right now. */
  currentHeadSha: string;
  /** `reviewedHeadSha` of the retained review row. */
  reviewedHeadSha?: string;
  /** Suggestion text read from GuardianBot's own published advisory, if any. */
  publishedSuggestion?: string;
  /** Added-line ranges of this pull request's diff for the finding's path, at `currentHeadSha`. */
  changedRanges: ReadonlyArray<{ start: number; end: number }>;
  /** Decoded UTF-8 file content at `currentHeadSha`. */
  fileContent: string;
  fileBytes: number;
}

export type RemediationValidationResult =
  | { ok: true; path: string; content: string; startLine: number; endLine: number }
  | { ok: false; reason: RemediationRejection };

/**
 * The deterministic second validator. Every check fails closed, and the final check recomputes
 * the change and proves that every line outside the finding range is byte-identical, so a bug in
 * the splice itself cannot produce an out-of-range edit.
 */
export function validateRemediationDraft(
  input: RemediationValidationInput
): RemediationValidationResult {
  const { finding } = input;
  const path = finding.path ?? "";
  if (!isNormalizedPath(path)) return { ok: false, reason: "invalid-path" };
  if (isForbiddenRemediationPath(path)) return { ok: false, reason: "forbidden-path" };
  if (isBinaryPath(path)) return { ok: false, reason: "binary-file" };
  if (finding.outcome === "dismissed") return { ok: false, reason: "finding-dismissed" };
  if (finding.state !== "open") return { ok: false, reason: "finding-not-open" };
  if (
    !input.currentHeadSha ||
    input.reviewedHeadSha !== input.currentHeadSha ||
    finding.lastSeenHeadSha !== input.currentHeadSha
  ) {
    return { ok: false, reason: "stale-head" };
  }
  if (!finding.suggestionSha256 || input.publishedSuggestion === undefined) {
    return { ok: false, reason: "missing-suggestion" };
  }
  const suggestion = normalizeSuggestion(input.publishedSuggestion);
  if (!suggestion || sha256Hex(suggestion) !== finding.suggestionSha256) {
    return { ok: false, reason: "suggestion-mismatch" };
  }
  const startLine = finding.startLine ?? 0;
  const endLine = finding.endLine ?? 0;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { ok: false, reason: "invalid-range" };
  }
  const suggestionLines = suggestion.split("\n");
  if (
    endLine - startLine + 1 > MAX_DRAFT_RANGE_LINES ||
    suggestion.length > MAX_DRAFT_SUGGESTION_CHARACTERS ||
    suggestionLines.length > MAX_DRAFT_SUGGESTION_LINES ||
    input.fileBytes > MAX_DRAFT_FILE_BYTES
  ) {
    return { ok: false, reason: "size-bound" };
  }
  if (input.fileContent.includes("\u0000") || suggestion.includes("\u0000")) {
    return { ok: false, reason: "binary-file" };
  }
  if (input.fileContent.includes("\r")) return { ok: false, reason: "unsupported-line-endings" };
  const covered = input.changedRanges.some(
    (range) => range.start <= startLine && range.end >= endLine
  );
  if (!covered) return { ok: false, reason: "range-not-changed" };

  const trailingNewline = input.fileContent.endsWith("\n");
  const lines = (trailingNewline ? input.fileContent.slice(0, -1) : input.fileContent).split("\n");
  if (endLine > lines.length) return { ok: false, reason: "invalid-range" };
  const updatedLines = [
    ...lines.slice(0, startLine - 1),
    ...suggestionLines,
    ...lines.slice(endLine)
  ];
  const content = `${updatedLines.join("\n")}${trailingNewline ? "\n" : ""}`;
  if (content === input.fileContent) return { ok: false, reason: "no-op" };

  // Independent proof that nothing outside the range moved: the unchanged prefix and suffix must
  // reappear verbatim around exactly the suggested lines.
  const prefix = lines.slice(0, startLine - 1);
  const suffix = lines.slice(endLine);
  const prefixIntact = prefix.every((line, index) => updatedLines[index] === line);
  const suffixOffset = updatedLines.length - suffix.length;
  const suffixIntact = suffix.every((line, index) => updatedLines[suffixOffset + index] === line);
  const middle = updatedLines.slice(prefix.length, suffixOffset).join("\n");
  if (!prefixIntact || !suffixIntact || middle !== suggestion) {
    return { ok: false, reason: "out-of-range-change" };
  }
  return { ok: true, path, content, startLine, endLine };
}

/** Deterministic branch name, so a redelivered command converges on the same draft. */
export function remediationBranchName(fingerprint: string, headSha: string): string {
  const safe = (value: string) => value.toLowerCase().replace(/[^a-f0-9]/g, "");
  return `${REMEDIATION_BRANCH_PREFIX}${safe(fingerprint).slice(0, 12)}-${safe(headSha).slice(0, 7)}`;
}

/** Fixed template; no model or repository text other than escaped identifiers reaches it. */
export function remediationDraftBody(input: {
  sourcePullNumber: number;
  path: string;
  startLine: number;
  endLine: number;
  fingerprint: string;
  headSha: string;
}): string {
  const code = (value: string) => `\`${value.replace(/[`\r\n\u0000]/g, "")}\``;
  return [
    "<!-- guardianbot-remediation-draft -->",
    "**AI-drafted remediation. Requires human review and approval.**",
    "",
    `This draft applies GuardianBot's exact advisory suggestion for finding ${code(input.fingerprint.slice(0, 16))} to ${code(`${input.path}:${input.startLine}-${input.endLine}`)}, as validated at head ${code(input.headSha.slice(0, 12))} of #${input.sourcePullNumber}.`,
    "",
    "- Created only because an authorized repository writer ran `@guardianbot draft-fix`.",
    "- A deterministic validator confirmed the finding was open at this head, the suggestion is byte-identical to the validated one, and only the finding's changed-line range is modified.",
    "- GuardianBot never merges, approves, or pushes to the contributor's branch. Merging this draft into the pull request branch is a human decision.",
    "- AI output is advisory: it does not waive, block, or approve deterministic security checks."
  ].join("\n");
}
