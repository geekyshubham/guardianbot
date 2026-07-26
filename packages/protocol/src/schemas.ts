export const changedLineRangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "start", "end"],
  properties: {
    path: { type: "string", minLength: 1 },
    start: { type: "integer", minimum: 1 },
    end: { type: "integer", minimum: 1 }
  }
} as const;

export const reviewRequestSchema = {
  $id: "https://guardianbot.dev/schemas/review-request.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "protocolVersion",
    "schemaVersion",
    "requestId",
    "repository",
    "pullRequest",
    "profile",
    "promptVersion",
    "validChangedLines",
    "contexts",
    "scannerEvidence",
    "rules",
    "limits"
  ],
  properties: {
    protocolVersion: { const: "guardian.review.v1" },
    schemaVersion: { const: "1.0.0" },
    requestId: { type: "string", minLength: 1, maxLength: 200 },
    repository: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "name", "visibility", "defaultBranch"],
      properties: {
        owner: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        visibility: { enum: ["public", "private", "restricted"] },
        defaultBranch: { type: "string", minLength: 1 }
      }
    },
    pullRequest: {
      type: "object",
      additionalProperties: false,
      required: ["number", "title", "body", "baseSha", "headSha", "author"],
      properties: {
        number: { type: "integer", minimum: 1 },
        title: { type: "string", maxLength: 1000 },
        body: { type: "string", maxLength: 100000 },
        baseSha: { type: "string", minLength: 7 },
        headSha: { type: "string", minLength: 7 },
        author: { type: "string", minLength: 1 }
      }
    },
    profile: {
      enum: [
        "routine-review",
        "high-risk-review",
        "benchmark-review",
        "fallback-review"
      ]
    },
    promptVersion: { type: "string", minLength: 1 },
    validChangedLines: {
      type: "array",
      items: changedLineRangeSchema,
      maxItems: 20000
    },
    contexts: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path", "kind", "content", "sha256"],
        properties: {
          id: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          kind: {
            enum: [
              "diff",
              "caller",
              "callee",
              "test",
              "schema",
              "config",
              "issue",
              "history",
              "scanner"
            ]
          },
          content: { type: "string" },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
        }
      }
    },
    scannerEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "fingerprint", "ruleId", "severity", "summary"],
        properties: {
          source: { enum: ["semgrep", "trivy", "zap", "other"] },
          fingerprint: { type: "string", minLength: 1 },
          ruleId: { type: "string", minLength: 1 },
          severity: { enum: ["critical", "high", "medium", "low", "info"] },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          summary: { type: "string", minLength: 1 }
        }
      }
    },
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "instruction"],
        properties: {
          id: { type: "string", minLength: 1 },
          instruction: { type: "string", minLength: 1, maxLength: 4000 },
          paths: { type: "array", items: { type: "string" } },
          severity: { enum: ["P0", "P1", "P2", "P3"] }
        }
      }
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["maxInlineComments", "maxInputCharacters", "timeoutMs"],
      properties: {
        maxInlineComments: { type: "integer", minimum: 0, maximum: 50 },
        maxInputCharacters: { type: "integer", minimum: 1000 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 }
      }
    }
  }
} as const;

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "fingerprint",
    "category",
    "severity",
    "confidence",
    "title",
    "path",
    "startLine",
    "endLine",
    "evidence",
    "impact",
    "remediation"
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    fingerprint: { type: "string", minLength: 1 },
    category: {
      enum: [
        "security",
        "logic",
        "reliability",
        "concurrency",
        "performance",
        "contract",
        "testing",
        "maintainability"
      ]
    },
    severity: { enum: ["P0", "P1", "P2", "P3"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    title: { type: "string", minLength: 1, maxLength: 300 },
    path: { type: "string", minLength: 1 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    evidence: { type: "string", minLength: 1 },
    impact: { type: "string", minLength: 1 },
    remediation: { type: "string", minLength: 1 },
    suggestion: { type: "string" },
    relatedTests: { type: "array", items: { type: "string" } },
    scannerFingerprints: { type: "array", items: { type: "string" } }
  }
} as const;

export const reviewResultSchema = {
  $id: "https://guardianbot.dev/schemas/review-result.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "protocolVersion",
    "schemaVersion",
    "requestId",
    "reviewedHeadSha",
    "contextIndexSha",
    "summary",
    "findings",
    "requirements",
    "testGaps",
    "suggestedReviewers",
    "backend"
  ],
  properties: {
    protocolVersion: { const: "guardian.review.v1" },
    schemaVersion: { const: "1.0.0" },
    requestId: { type: "string", minLength: 1 },
    reviewedHeadSha: { type: "string", minLength: 7 },
    contextIndexSha: { type: "string", minLength: 7 },
    summary: {
      type: "object",
      additionalProperties: false,
      required: [
        "intent",
        "changeGroups",
        "riskScore",
        "reviewEffort",
        "impactedComponents",
        "partialReview"
      ],
      properties: {
        intent: { type: "string" },
        changeGroups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "paths", "summary"],
            properties: {
              title: { type: "string" },
              paths: { type: "array", items: { type: "string" } },
              summary: { type: "string" }
            }
          }
        },
        riskScore: { type: "integer", minimum: 0, maximum: 100 },
        reviewEffort: { type: "integer", minimum: 1, maximum: 5 },
        impactedComponents: { type: "array", items: { type: "string" } },
        mermaidDiagram: { type: "string" },
        partialReview: { type: "boolean" }
      }
    },
    findings: { type: "array", maxItems: 100, items: findingSchema },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirement", "status", "evidence"],
        properties: {
          requirement: { type: "string" },
          status: { enum: ["addressed", "missing", "inconclusive"] },
          evidence: { type: "string" }
        }
      }
    },
    testGaps: { type: "array", items: { type: "string" } },
    suggestedReviewers: { type: "array", items: { type: "string" } },
    backend: {
      type: "object",
      additionalProperties: false,
      required: ["backendId", "modelId", "latencyMs"],
      properties: {
        backendId: { type: "string", minLength: 1 },
        modelId: { type: "string", minLength: 1 },
        latencyMs: { type: "integer", minimum: 0 },
        inputUnits: { type: "integer", minimum: 0 },
        outputUnits: { type: "integer", minimum: 0 },
        estimatedCostUsd: { type: "number", minimum: 0 }
      }
    }
  }
} as const;

export const backendCapabilitiesSchema = {
  $id: "https://guardianbot.dev/schemas/backend-capabilities.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "protocolVersion",
    "backendId",
    "structuredOutput",
    "maxInputCharacters",
    "supportedProfiles",
    "supportedDataClassifications",
    "retention",
    "usageReporting"
  ],
  properties: {
    protocolVersion: { const: "guardian.review.v1" },
    backendId: { type: "string", minLength: 1 },
    structuredOutput: { type: "boolean" },
    maxInputCharacters: { type: "integer", minimum: 1000 },
    supportedProfiles: {
      type: "array",
      items: {
        enum: [
          "routine-review",
          "high-risk-review",
          "benchmark-review",
          "fallback-review"
        ]
      }
    },
    supportedDataClassifications: {
      type: "array",
      items: { enum: ["public", "private", "restricted"] }
    },
    retention: { enum: ["none", "bounded", "unknown"] },
    usageReporting: { type: "boolean" }
  }
} as const;

