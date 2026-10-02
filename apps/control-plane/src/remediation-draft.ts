import { createHash } from "node:crypto";
import {
  REMEDIATION_VALIDATION_CONTEXT_LIMIT,
  REMEDIATION_VALIDATION_PROTOCOL_VERSION,
  REMEDIATION_VALIDATION_TEXT_LIMIT,
  type DataClassification,
  type FindingCategory,
  type RemediationValidationRequest
} from "@guardianbot/protocol";
import type { RemediationDraftChecks, ReviewFindingRecord } from "./store.js";

/**
 * Mode C remediation drafts: the deterministic validator and the trusted text around a draft.
 *
 * A draft is only ever written after every check here passes. The validator is pure and takes no
 * model input beyond the suggestion text GuardianBot itself already validated and published, so
 * its decision is reproducible from the retained finding record, the published advisory, and the
 * file at the pull request head. An operator may additionally configure a second model through
 * the separate `guardian.remediation-validation.v1` contract (`guardian.review.v1` is unchanged).
 * That model can only veto: it runs after this validator, and any rejection, error, timeout or
 * malformed answer means no draft is written.
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
  "codeowners",
  // Repository plumbing that changes how git or local hooks treat other files.
  ".gitattributes",
  ".gitmodules",
  ".pre-commit-config.yaml"
]);

const CI_DIRECTORIES = [
  ".github/",
  ".guardianbot/",
  ".circleci/",
  ".buildkite/",
  ".gitlab/",
  ".azure-pipelines/",
  ".husky/"
];

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
  "binary-file": "the target file is binary or not a plain file",
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
  | {
      ok: true;
      path: string;
      content: string;
      startLine: number;
      endLine: number;
      /** The exact normalized suggestion spliced into the range. */
      replacement: string;
    }
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
  return { ok: true, path, content, startLine, endLine, replacement: suggestion };
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
  secondValidation?: RemediationSecondValidation;
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
    input.secondValidation === "accepted"
      ? "- The operator-configured second-model validator also accepted it. That model can only veto a draft; its acceptance is not a review or an approval."
      : "- No second-model validator is configured on this deployment: validation was deterministic only.",
    "- GuardianBot never merges, approves, or pushes to the contributor's branch. Merging this draft into the pull request branch is a human decision.",
    "- AI output is advisory: it does not waive, block, or approve deterministic security checks."
  ].join("\n");
}

const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "security",
  "logic",
  "reliability",
  "concurrency",
  "performance",
  "contract",
  "testing",
  "maintainability"
]);

function trustedCategory(value: string | undefined): FindingCategory | undefined {
  return value && FINDING_CATEGORIES.has(value as FindingCategory)
    ? (value as FindingCategory)
    : undefined;
}

/** Strips anything that could break out of inline code or a single title line. */
function plainIdentifier(value: string, limit: number): string {
  return value.replace(/[`\r\n\u0000-\u001f\u007f]/g, "").slice(0, limit);
}

/**
 * The draft pull request title, built only from fields GuardianBot controls: a category from the
 * closed protocol enum, the fingerprint prefix (hex), and the validated repository path. The
 * model-written finding title never reaches it.
 */
export function remediationDraftTitle(input: {
  category?: string;
  fingerprint: string;
  path: string;
}): string {
  const category = trustedCategory(input.category) ?? "advisory";
  const fingerprint = input.fingerprint.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 12);
  return `GuardianBot AI draft: ${category} fix for ${fingerprint} in ${plainIdentifier(input.path, 160)}`;
}

/** Second-model status the draft body and link comment state. */
export type RemediationSecondValidation = "accepted" | "not-configured";

/** Conclusions that count as a passing workflow run. Anything else completed is a failure. */
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
/** Bound on the runs one draft commit may have; more is treated as unsettled rather than paged. */
export const MAX_DRAFT_CHECK_RUNS = 100;

/**
 * Summarizes the workflow runs GitHub reports for the draft commit. `pending` until every run has
 * completed, and never `passed` for zero runs: no evidence is not a pass.
 */
export function summarizeDraftChecks(
  runs: ReadonlyArray<{ status?: unknown; conclusion?: unknown }>,
  totalCount: number
): RemediationDraftChecks {
  if (!runs.length || totalCount > runs.length || runs.length > MAX_DRAFT_CHECK_RUNS) {
    return "pending";
  }
  if (runs.some((run) => run.status !== "completed")) return "pending";
  return runs.every((run) => PASSING_CONCLUSIONS.has(String(run.conclusion)))
    ? "passed"
    : "failed";
}

const CHECKS_TEXT: Record<RemediationDraftChecks, string> = {
  pending:
    "Checks: **pending**. GuardianBot updates this comment when the draft commit's workflow runs complete; until then, confirm them on the draft before merging it.",
  passed:
    "Checks: **passed** (every workflow run on the draft commit completed successfully). This is not an approval.",
  failed:
    "Checks: **failed** (at least one workflow run on the draft commit did not succeed). Review the draft's checks before doing anything with it."
};

/**
 * GuardianBot's comment on the source pull request linking the draft. Rebuilt from the stored
 * record whenever the checks state changes, so it carries only trusted identifiers.
 */
export function remediationLinkComment(input: {
  fingerprint: string;
  draftPullNumber: number;
  targetRef: string;
  checks: RemediationDraftChecks;
  secondValidation: RemediationSecondValidation;
}): string {
  const validation =
    input.secondValidation === "accepted"
      ? "The deterministic validator and the configured second-model validator both accepted it."
      : "It passed deterministic validation only; no second-model validator is configured.";
  return [
    `AI-drafted remediation for \`${plainIdentifier(input.fingerprint, 16)}\` opened as draft #${input.draftPullNumber} targeting \`${plainIdentifier(input.targetRef, 200)}\`.`,
    validation,
    CHECKS_TEXT[input.checks],
    "It requires human review and approval; GuardianBot did not merge, approve, or push to this branch."
  ].join(" ");
}

/** Lines of surrounding file content sent to the second model on each side of the range. */
const VALIDATION_CONTEXT_LINES = 20;

function tail(value: string, limit: number): string {
  return value.length > limit ? value.slice(value.length - limit) : value;
}

/**
 * Builds the second-model request from the validated draft only: the replaced lines, the exact
 * replacement, and bounded surrounding lines. No finding title, evidence or other model prose is
 * sent back to a model, and the request is sized to the contract's limits.
 */
export function buildRemediationValidationRequest(input: {
  requestId: string;
  classification: DataClassification;
  finding: ReviewFindingRecord;
  fileContent: string;
  startLine: number;
  endLine: number;
  replacement: string;
}): RemediationValidationRequest | undefined {
  const trailingNewline = input.fileContent.endsWith("\n");
  const lines = (trailingNewline ? input.fileContent.slice(0, -1) : input.fileContent).split("\n");
  const original = lines.slice(input.startLine - 1, input.endLine).join("\n");
  if (
    original.length > REMEDIATION_VALIDATION_TEXT_LIMIT ||
    !input.replacement ||
    input.replacement.length > REMEDIATION_VALIDATION_TEXT_LIMIT
  ) {
    return undefined;
  }
  const before = lines
    .slice(Math.max(0, input.startLine - 1 - VALIDATION_CONTEXT_LINES), input.startLine - 1)
    .join("\n");
  const after = lines.slice(input.endLine, input.endLine + VALIDATION_CONTEXT_LINES).join("\n");
  const category = trustedCategory(input.finding.category);
  const severity = ["P0", "P1", "P2", "P3"].includes(String(input.finding.severity))
    ? (input.finding.severity as "P0" | "P1" | "P2" | "P3")
    : undefined;
  return {
    protocolVersion: REMEDIATION_VALIDATION_PROTOCOL_VERSION,
    requestId: input.requestId,
    classification: input.classification,
    finding: {
      fingerprint: input.finding.fingerprint.slice(0, 128),
      ...(category ? { category } : {}),
      ...(severity ? { severity } : {}),
      path: input.finding.path ?? "",
      startLine: input.startLine,
      endLine: input.endLine
    },
    original,
    replacement: input.replacement,
    contextBefore: tail(before, REMEDIATION_VALIDATION_CONTEXT_LIMIT),
    contextAfter: after.slice(0, REMEDIATION_VALIDATION_CONTEXT_LIMIT)
  };
}
