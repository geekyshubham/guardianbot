import { createHash } from "node:crypto";
import type { ReviewFinding, ReviewResult } from "@guardianbot/protocol";
import type { ReviewFindingLifecycleState, ReviewFindingRecord } from "./store.js";

export const REVIEW_MARKER = "<!-- guardianbot-review -->";
const FINDING_MARKER_PREFIX = "guardianbot-finding:";
/**
 * Marks an inline comment already rewritten to closed form. Terminal findings are rewritten
 * rather than deleted so reviewer replies survive, and this marker keeps the rewrite idempotent
 * across repeated reviews of the same pull request.
 */
const CLOSED_FINDING_MARKER = "<!-- guardianbot-finding-closed -->";
const MAX_PRESENTED_LIFECYCLE_FINDINGS = 20;
/**
 * Ceiling for the whole advisory body, held below GitHub's 65536-character comment limit. A body
 * over the limit is rejected outright, which would lose the entire advisory, so the lowest-value
 * sections are dropped first and the comment degrades instead of failing.
 */
const MAX_REVIEW_BODY_CHARACTERS = 60_000;
const LIFECYCLE_DETAIL_OMITTED =
  "_Per-finding lifecycle detail omitted to keep this comment inside GitHub's size limit. The counts on the finding lifecycle line above remain the complete tally._";
const CHANGED_FILE_DETAIL_OMITTED =
  "_Changed-file grouping omitted to keep this comment inside GitHub's size limit._";
const LIFECYCLE_LABELS: Record<ReviewFindingLifecycleState, string> = {
  open: "Returned after closing",
  resolved: "Resolved",
  superseded: "Superseded"
};

export interface ReviewFileGroup {
  title: string;
  paths: string[];
  summary: string;
}

export interface FindingLifecycleSummary {
  open: number;
  /** Open findings that returned after reaching a terminal state; the live regression signal. */
  reappeared: number;
  resolved: number;
  superseded: number;
  /**
   * Retained findings a human has engaged with, as a count only. Optional because a summary
   * assembled by an older instance carries no engagement figure, and absent is not the same claim
   * as zero, so the segment is omitted rather than rendered as none.
   */
  engaged?: number;
}

export interface ReviewRenderContext {
  scannerConfigured: boolean;
  riskScore: number;
  reviewEffort: 1 | 2 | 3 | 4 | 5;
  riskReasons: string[];
  changeGroups: ReviewFileGroup[];
  impactedComponents: string[];
  linkedIssues: string[];
  codeOwners: string[];
  lifecycle: FindingLifecycleSummary;
  /** Retained lifecycle records, used for per-finding closed-finding presentation. */
  lifecycleFindings: readonly ReviewFindingRecord[];
  inlinePosted: number;
  inlineAlreadyPresent: number;
  inlineClosed: number;
  backendAlias: string;
  contextIndexSha: string;
  reviewScope: string;
  partialWarning?: string;
}

function safeText(value: unknown, maximum = 2_000): string {
  const text = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&(?!(?:lt|gt|amp);)/g, "&amp;")
    .replace(/@/g, "@\u200b")
    .trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function inlineCode(value: unknown, maximum = 500): string {
  return `\`${safeText(value, maximum).replace(/`/g, "ˋ")}\``;
}

function renderList(values: string[], empty: string): string {
  return values.length ? values.map((value) => `- ${safeText(value)}`).join("\n") : empty;
}

export function findingMarker(fingerprint: string): string {
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `<!-- ${FINDING_MARKER_PREFIX}${digest} -->`;
}

/**
 * Renders one lifecycle finding as a human-meaningful line from retained provenance alone, so a
 * reviewer sees what closed or returned, and where, without the model being re-run. Identity
 * fields are optional on rows written before the provenance migration, so each degrades
 * independently.
 */
function lifecycleFindingLine(finding: ReviewFindingRecord): string {
  const state = LIFECYCLE_LABELS[finding.state];
  const severity = finding.severity ? `${safeText(finding.severity, 8)} ` : "";
  // Title and path are held to a tighter budget here than in the inline advisory: this section
  // presents up to MAX_PRESENTED_LIFECYCLE_FINDINGS lines at once, so per-line width is what
  // decides whether the whole comment stays inside GitHub's limit.
  const title = finding.title
    ? safeText(finding.title, 200)
    : "Retained finding without provenance detail";
  const location = finding.path
    ? ` — ${inlineCode(
        finding.startLine ? `${finding.path}:${finding.startLine}` : finding.path,
        200
      )}`
    : "";
  const firstSeen = finding.firstSeenHeadSha
    ? ` · first seen ${inlineCode(finding.firstSeenHeadSha.slice(0, 12))}`
    : "";
  const lastSeen = finding.lastSeenHeadSha
    ? ` · last seen ${inlineCode(finding.lastSeenHeadSha.slice(0, 12))}`
    : "";
  const reappearances = finding.reappearances
    ? ` · returned ${finding.reappearances}× after closing`
    : "";
  return `- **${state}:** ${severity}${title}${location}${firstSeen}${lastSeen}${reappearances} · ${inlineCode(
    finding.fingerprint.slice(0, 12)
  )}`;
}

/** Complete lifecycle tally, rendered identically wherever an advisory reports it. */
export function lifecycleLine(lifecycle: FindingLifecycleSummary): string {
  // Appended last and only when an engagement was actually recorded, so an installation without
  // the review-comment event subscribed renders exactly the line it renders today rather than a
  // zero that would read as "no reviewer has engaged" when the truth is that nothing is measured.
  const engaged = lifecycle.engaged
    ? ` · ${lifecycle.engaged} with reviewer feedback`
    : "";
  return (
    `${lifecycle.open} open · ` +
    `${lifecycle.reappeared} returned · ` +
    `${lifecycle.resolved} resolved · ` +
    `${lifecycle.superseded} superseded${engaged}`
  );
}

/**
 * Per-finding lifecycle presentation. Terminal findings are listed so a reviewer sees what closed
 * and where, and open findings that returned after closing are listed too: a reappearance is the
 * regression signal this provenance exists to expose, and waiting for a second closure to surface
 * it would report it only after it stopped mattering. Bounded so a long-lived pull request with
 * heavy fingerprint churn cannot grow the advisory comment past what GitHub will accept; the
 * counts in the lifecycle line remain the complete tally.
 */
export function renderLifecycleFindings(
  findings: readonly ReviewFindingRecord[]
): string {
  const presented = findings.filter(
    (finding) => finding.state !== "open" || (finding.reappearances ?? 0) > 0
  );
  if (!presented.length) {
    return "No finding has been resolved, superseded, or returned on this pull request.";
  }
  // "open" sorts ahead of both terminal states, so returned findings lead the section.
  const ordered = [...presented].sort(
    (left, right) =>
      left.state.localeCompare(right.state) ||
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.startLine ?? 0) - (right.startLine ?? 0) ||
      left.fingerprint.localeCompare(right.fingerprint)
  );
  const shown = ordered.slice(0, MAX_PRESENTED_LIFECYCLE_FINDINGS);
  const remainder = ordered.length - shown.length;
  const overflow = remainder > 0
    ? `\n- _${remainder} further lifecycle finding${remainder === 1 ? "" : "s"} retained but not listed._`
    : "";
  return `${shown.map(lifecycleFindingLine).join("\n")}${overflow}`;
}

/**
 * Rewrites a published inline comment to a clearly-closed form. The original advisory body is
 * retained verbatim below the notice and the comment is never deleted, so reviewer replies and
 * conversation history survive. `resolved` means the finding disappeared while the reviewed head
 * stayed put; `superseded` means the head moved underneath it.
 */
export function renderClosedInlineFinding(
  body: string,
  state: "resolved" | "superseded",
  headSha: string
): string {
  const notice = state === "resolved"
    ? `No longer reported as of ${inlineCode(headSha.slice(0, 12))}. The changed range this advisory referenced is clean.`
    : `Superseded at ${inlineCode(headSha.slice(0, 12))}. The pull request advanced past the range this advisory referenced.`;
  return `${CLOSED_FINDING_MARKER}
**✅ ${state === "resolved" ? "Resolved" : "Superseded"}** — ${notice}

This comment is retained rather than deleted so the discussion below it stays readable. Deterministic scanner results are unaffected.

<details><summary>Original advisory</summary>

${body}

</details>`;
}

/** True when a comment body has already been rewritten to closed form. */
export function isClosedFindingComment(body: string): boolean {
  return body.includes(CLOSED_FINDING_MARKER);
}

/**
 * Reads the fingerprint marker out of a comment body GuardianBot itself published. The match is
 * anchored to the start of the body: GitHub's "Quote reply" copies the quoted body verbatim,
 * including HTML comments, so a reviewer quoting an advisory produces a comment containing
 * `> <!-- guardianbot-finding:… -->`. An unanchored match would read that quote as the advisory
 * itself and let the closing rewrite overwrite the reviewer's own words.
 */
export function extractFindingMarker(body: string): string | undefined {
  return new RegExp(`^<!--\\s*${FINDING_MARKER_PREFIX}([a-f0-9]{64})\\s*-->`).exec(body)?.[1];
}

export function exactSuggestion(finding: ReviewFinding): string | undefined {
  const suggestion = finding.suggestion?.replace(/\r\n/g, "\n").trim();
  if (
    !suggestion ||
    suggestion.length > 8_000 ||
    suggestion.includes("\u0000") ||
    suggestion.includes("```")
  ) {
    return undefined;
  }
  return suggestion;
}

export function renderInlineFinding(finding: ReviewFinding): string {
  const suggestion = exactSuggestion(finding);
  const relatedTests = finding.relatedTests?.length
    ? `\n\n**Related tests:** ${finding.relatedTests.map(inlineCode).join(", ")}`
    : "";
  const replacement = suggestion
    ? `\n\nExact replacement proposed for this changed range:\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``
    : "";
  return `${findingMarker(finding.fingerprint)}
**${safeText(finding.severity)} · ${safeText(finding.title, 300)}**

**Evidence:** ${safeText(finding.evidence)}

**Impact:** ${safeText(finding.impact)}

**Remediation:** ${safeText(finding.remediation)}${relatedTests}${replacement}

Finding ID: ${inlineCode(finding.id)} · Fingerprint: ${inlineCode(finding.fingerprint.slice(0, 16))}

_Advisory only. This comment cannot merge code, waive scanners, or change the deterministic gate._`;
}

export function renderPlaceholder(headSha: string): string {
  return `${REVIEW_MARKER}
## GuardianBot review

⏳ Reviewing ${inlineCode(headSha.slice(0, 12))}…

The model receives bounded, hashed, explicitly untrusted context. Deterministic scanner evidence is reported separately by \`guardianbot/security-gate\`.`;
}

export function renderReview(result: ReviewResult, context: ReviewRenderContext): string {
  const findings = result.findings
    .filter((finding) => finding.severity !== "P3")
    .map(
      (finding) =>
        `- **${safeText(finding.severity)} ${safeText(finding.title, 300)}** — ${inlineCode(`${finding.path}:${finding.startLine}`)} · ${inlineCode(finding.fingerprint.slice(0, 12))}`
    );
  const groups = context.changeGroups.map(
    (group) =>
      `- **${safeText(group.title, 200)}** — ${safeText(group.summary)}\n  ${group.paths.map(inlineCode).join(", ")}`
  );
  const requirements = result.requirements
    .filter((requirement) => requirement.evidence.trim())
    .map(
      (requirement) =>
        `- **${safeText(requirement.status)}:** ${safeText(requirement.requirement)} — ${safeText(requirement.evidence)}`
    );
  const completeness = result.summary.partialReview || context.partialWarning ? "partial" : "complete";
  const partial = context.partialWarning
    ? `\n\n> ⚠️ **Partial review:** ${safeText(context.partialWarning, 3_000)}`
    : "";
  const reasons = context.riskReasons.length
    ? ` (${context.riskReasons.map((reason) => safeText(reason, 300)).join("; ")})`
    : "";
  const lifecycle = lifecycleLine(context.lifecycle);
  const compose = (sections: {
    changedFiles: string;
    lifecycleFindings: string;
  }): string => `${REVIEW_MARKER}
## GuardianBot review

${safeText(result.summary.intent, 2_000)}

**Risk score:** ${context.riskScore}/100${reasons}
**Review effort:** ${context.reviewEffort}/5
**Review completeness:** ${completeness}
**Review scope:** ${safeText(context.reviewScope, 500)}
**Impacted components:** ${context.impactedComponents.length ? context.impactedComponents.map(inlineCode).join(", ") : "No component claim available"}
**Finding lifecycle:** ${lifecycle}
**Inline comments:** ${context.inlinePosted} posted · ${context.inlineAlreadyPresent} already present · ${context.inlineClosed} marked closed
**AI route:** ${inlineCode(context.backendAlias)} · advisory only
**Context manifest:** ${inlineCode(context.contextIndexSha.slice(0, 16))}
**Deterministic scans:** ${context.scannerConfigured ? "reported by the security gate" : "not configured"}

### Changed files

${sections.changedFiles}

### Findings

${findings.join("\n") || "No evidence-backed P0–P2 findings."}

### Resolved, superseded, and returned findings

${sections.lifecycleFindings}

### Linked issues

${renderList(context.linkedIssues, "No linked issue reference found in the pull request title or body.")}

### Evidence-backed reviewers

${context.codeOwners.length ? context.codeOwners.map((owner) => `- ${inlineCode(owner)}`).join("\n") : "No matching CODEOWNERS evidence available."}

### Requirements

${requirements.join("\n") || "No requirement evidence reported."}

### Test gaps

${renderList(result.testGaps, "No evidence-backed test gap reported.")}${partial}

Malformed, stale, or unavailable model output is discarded and never changes the deterministic gate. GuardianBot never merges code or waives scanner findings.`;

  const changedFiles = groups.join("\n") || "No changed-file grouping available.";
  const body = compose({
    changedFiles,
    lifecycleFindings: renderLifecycleFindings(context.lifecycleFindings)
  });
  if (body.length <= MAX_REVIEW_BODY_CHARACTERS) return body;
  // Over budget the per-finding lifecycle detail goes first: it is the only section whose loss
  // costs nothing verifiable, because the finding lifecycle line above it carries the full tally.
  const withoutLifecycleDetail = compose({
    changedFiles,
    lifecycleFindings: LIFECYCLE_DETAIL_OMITTED
  });
  if (withoutLifecycleDetail.length <= MAX_REVIEW_BODY_CHARACTERS) return withoutLifecycleDetail;
  const reduced = compose({
    changedFiles: CHANGED_FILE_DETAIL_OMITTED,
    lifecycleFindings: LIFECYCLE_DETAIL_OMITTED
  });
  // A body GitHub rejects loses the advisory outright, so the last resort truncates rather than
  // returning something unpublishable.
  return reduced.length <= MAX_REVIEW_BODY_CHARACTERS
    ? reduced
    : `${reduced.slice(0, MAX_REVIEW_BODY_CHARACTERS - 1)}…`;
}

export function renderUnavailable(
  headSha: string,
  scannerConfigured: boolean,
  lifecycle: FindingLifecycleSummary,
  reason: "no-route" | "capability" | "transport" | "invalid-output"
): string {
  const reasons = {
    "no-route": "no approved administrative backend route",
    capability: "the configured route did not satisfy required protocol capabilities",
    transport: "the approved backend route was unavailable",
    "invalid-output": "backend output failed strict schema, context-hash, or changed-line validation"
  };
  return `${REVIEW_MARKER}
## GuardianBot review

AI review unavailable for ${inlineCode(headSha.slice(0, 12))}: ${reasons[reason]}.

**Finding lifecycle:** ${lifecycleLine(lifecycle)}
**AI backend:** advisory only
**Deterministic scans:** ${scannerConfigured ? "reported by the security gate" : "not configured"}

No automated merge or scanner waiver was performed. Deterministic checks continue independently.`;
}

export function renderStaleReview(
  reviewedHeadSha: string,
  currentHeadSha: string,
  scannerConfigured: boolean,
  lifecycle: FindingLifecycleSummary
): string {
  return `${REVIEW_MARKER}
## GuardianBot review

Review output for ${inlineCode(reviewedHeadSha.slice(0, 12))} became stale before publication because the pull request advanced to ${inlineCode(currentHeadSha.slice(0, 12))}. No inline comments were posted.

**Finding lifecycle:** ${lifecycleLine(lifecycle)}
**AI backend:** advisory only
**Deterministic scans:** ${scannerConfigured ? "reported by the security gate" : "not configured"}

A new head event or \`@guardianbot review\` will refresh this advisory summary. Deterministic checks continue independently.`;
}

export function onboardingIssue(repository: string, detected: string[], notes: string[]): string {
  return `## GuardianBot discovered this repository

GuardianBot created an isolated advisory record for ${inlineCode(repository)}.

**Detected:** ${detected.length ? detected.map(inlineCode).join(", ") : "documentation/unknown"}

Deterministic scans are **not configured** until the generated onboarding PR is merged.

\`\`\`sh
GUARDIANBOT_WORKFLOW_SHA=<published-commit> guardianctl onboard ${safeText(repository, 500)}
\`\`\`

### Detection notes

${notes.map((note) => `- ${safeText(note)}`).join("\n") || "- No missing prerequisites detected."}

No model, scanner, DefectDojo, DigitalOcean, or shared secret is copied into this repository.`;
}
