import { createHash } from "node:crypto";
import type { ReviewFinding, ReviewResult } from "@guardianbot/protocol";

export const REVIEW_MARKER = "<!-- guardianbot-review -->";
const FINDING_MARKER_PREFIX = "guardianbot-finding:";

export interface ReviewFileGroup {
  title: string;
  paths: string[];
  summary: string;
}

export interface FindingLifecycleSummary {
  open: number;
  resolved: number;
  superseded: number;
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
  inlinePosted: number;
  inlineAlreadyPresent: number;
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

function inlineCode(value: unknown): string {
  return `\`${safeText(value, 500).replace(/`/g, "ˋ")}\``;
}

function renderList(values: string[], empty: string): string {
  return values.length ? values.map((value) => `- ${safeText(value)}`).join("\n") : empty;
}

export function findingMarker(fingerprint: string): string {
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `<!-- ${FINDING_MARKER_PREFIX}${digest} -->`;
}

export function extractFindingMarker(body: string): string | undefined {
  return new RegExp(`<!--\\s*${FINDING_MARKER_PREFIX}([a-f0-9]{64})\\s*-->`).exec(body)?.[1];
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
  const lifecycle =
    `${context.lifecycle.open} open · ` +
    `${context.lifecycle.resolved} resolved · ` +
    `${context.lifecycle.superseded} superseded`;

  return `${REVIEW_MARKER}
## GuardianBot review

${safeText(result.summary.intent, 2_000)}

**Risk score:** ${context.riskScore}/100${reasons}
**Review effort:** ${context.reviewEffort}/5
**Review completeness:** ${completeness}
**Review scope:** ${safeText(context.reviewScope, 500)}
**Impacted components:** ${context.impactedComponents.length ? context.impactedComponents.map(inlineCode).join(", ") : "No component claim available"}
**Finding lifecycle:** ${lifecycle}
**Inline comments:** ${context.inlinePosted} posted · ${context.inlineAlreadyPresent} already present
**AI route:** ${inlineCode(context.backendAlias)} · advisory only
**Context manifest:** ${inlineCode(context.contextIndexSha.slice(0, 16))}
**Deterministic scans:** ${context.scannerConfigured ? "reported by the security gate" : "not configured"}

### Changed files

${groups.join("\n") || "No changed-file grouping available."}

### Findings

${findings.join("\n") || "No evidence-backed P0–P2 findings."}

### Linked issues

${renderList(context.linkedIssues, "No linked issue reference found in the pull request title or body.")}

### Evidence-backed reviewers

${context.codeOwners.length ? context.codeOwners.map((owner) => `- ${inlineCode(owner)}`).join("\n") : "No matching CODEOWNERS evidence available."}

### Requirements

${requirements.join("\n") || "No requirement evidence reported."}

### Test gaps

${renderList(result.testGaps, "No evidence-backed test gap reported.")}${partial}

Malformed, stale, or unavailable model output is discarded and never changes the deterministic gate. GuardianBot never merges code or waives scanner findings.`;
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

**Finding lifecycle:** ${lifecycle.open} open · ${lifecycle.resolved} resolved · ${lifecycle.superseded} superseded
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

**Finding lifecycle:** ${lifecycle.open} open · ${lifecycle.resolved} resolved · ${lifecycle.superseded} superseded
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
