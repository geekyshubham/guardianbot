import type { ReviewResult } from "@guardianbot/protocol";

export const REVIEW_MARKER = "<!-- guardianbot-review -->";

export function renderPlaceholder(headSha: string): string {
  return `${REVIEW_MARKER}
## GuardianBot review

⏳ Reviewing \`${headSha.slice(0, 12)}\`…

Deterministic scanner evidence is shown separately by \`guardianbot/security-gate\`.`;
}

export function renderReview(result: ReviewResult, scannerConfigured: boolean): string {
  const findings = result.findings.length
    ? result.findings.map((finding) =>
      `- **${finding.severity} ${finding.title}** — \`${finding.path}:${finding.startLine}\` · \`${finding.fingerprint.slice(0, 12)}\`\n  ${finding.evidence}\n  **Impact:** ${finding.impact}\n  **Remediation:** ${finding.remediation}`
    ).join("\n")
    : "No evidence-backed P0–P2 findings.";
  return `${REVIEW_MARKER}
## GuardianBot review

${result.summary.intent}

**Risk score:** ${result.summary.riskScore}/100
**Review effort:** ${result.summary.reviewEffort}/5
**Review completeness:** ${result.summary.partialReview ? "partial" : "complete"}
**AI backend:** advisory only
**Deterministic scans:** ${scannerConfigured ? "reported by the security gate" : "not configured"}

### Findings

${findings}

Malformed or unavailable model output is discarded and never changes the deterministic gate.`;
}

export function onboardingIssue(repository: string, detected: string[], notes: string[]): string {
  return `## GuardianBot discovered this repository

GuardianBot created an isolated advisory record for \`${repository}\`.

**Detected:** ${detected.length ? detected.map((value) => `\`${value}\``).join(", ") : "documentation/unknown"}

Deterministic scans are **not configured** until the generated onboarding PR is merged.

\`\`\`sh
GUARDIANBOT_WORKFLOW_SHA=<published-commit> guardianctl onboard ${repository}
\`\`\`

### Detection notes

${notes.map((note) => `- ${note}`).join("\n") || "- No missing prerequisites detected."}

No model, scanner, DefectDojo, DigitalOcean, or shared secret is copied into this repository.`;
}
