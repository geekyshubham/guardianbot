import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewRequest, ReviewResult } from "@guardianbot/protocol";

export function sampleRequest(
  overrides: Partial<ReviewRequest> = {}
): ReviewRequest {
  return {
    protocolVersion: "guardian.review.v1",
    schemaVersion: "1.0.0",
    requestId: "req-1",
    repository: {
      owner: "example",
      name: "service",
      visibility: "private",
      defaultBranch: "main"
    },
    pullRequest: {
      number: 42,
      title: "Harden auth flow",
      body: "Tighten token checks",
      baseSha: "aaaaaaa",
      headSha: "bbbbbbb",
      author: "developer"
    },
    profile: "routine-review",
    promptVersion: "prompt-1",
    expectedContextIndexSha: "c".repeat(64),
    validChangedLines: [{ path: "src/auth.ts", start: 10, end: 20 }],
    contexts: [
      {
        id: "ctx-1",
        path: "src/auth.ts",
        kind: "diff",
        content: "if (user.isAdmin) return true;",
        sha256: "d".repeat(64)
      }
    ],
    scannerEvidence: [],
    rules: [
      {
        id: "rule-1",
        instruction: "Ensure auth checks remain intact.",
        severity: "P1"
      }
    ],
    limits: {
      maxInlineComments: 5,
      maxInputCharacters: 100000,
      timeoutMs: 30000
    },
    ...overrides
  };
}

export function sampleResult(
  request: ReviewRequest,
  overrides: Partial<ReviewResult> = {}
): ReviewResult {
  return {
    protocolVersion: request.protocolVersion,
    schemaVersion: request.schemaVersion,
    requestId: request.requestId,
    reviewedHeadSha: request.pullRequest.headSha,
    contextIndexSha: request.expectedContextIndexSha ?? "c".repeat(64),
    summary: {
      intent: "Harden auth flow",
      changeGroups: [
        {
          title: "Auth changes",
          paths: ["src/auth.ts"],
          summary: "Adjusts admin checks."
        }
      ],
      riskScore: 70,
      reviewEffort: 3,
      impactedComponents: ["auth"],
      partialReview: false
    },
    findings: [
      {
        id: "GB-1",
        fingerprint: "auth-check-missing",
        category: "security",
        severity: "P1",
        confidence: 0.95,
        title: "Authorization check can be bypassed",
        path: "src/auth.ts",
        startLine: 12,
        endLine: 12,
        evidence: "if (user.isAdmin) return true;",
        impact: "Unauthenticated callers could access privileged behavior.",
        remediation: "Restore the role gate before returning success."
      }
    ],
    requirements: [
      {
        requirement: "Auth checks must gate privileged paths.",
        status: "missing",
        evidence: "The changed branch returns success before validating role."
      }
    ],
    testGaps: ["Add a regression test for non-admin callers."],
    suggestedReviewers: ["security-team"],
    backend: {
      backendId: "fixture",
      modelId: "fixture-model",
      latencyMs: 1
    },
    ...overrides
  };
}

export function writeFixtureFile(body: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "guardianbot-model-bridge-"));
  const path = join(directory, "fixture.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}
