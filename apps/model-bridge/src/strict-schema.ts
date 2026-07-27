import AjvImport, {
  type Options,
  type ValidateFunction,
  type Ajv as AjvInstance
} from "ajv";

const Ajv = AjvImport as unknown as new (options?: Options) => AjvInstance;
const ajv = new Ajv({ allErrors: true, strict: false });

export const strictModelOutputSchema = {
  $id: "https://guardianbot.dev/schemas/review-result.model-output.strict.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "requirements", "testGaps", "suggestedReviewers"],
  properties: {
    summary: {
      type: "object",
      additionalProperties: false,
      required: [
        "intent",
        "changeGroups",
        "riskScore",
        "reviewEffort",
        "impactedComponents",
        "mermaidDiagram",
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
        mermaidDiagram: { type: ["string", "null"] },
        partialReview: { type: "boolean" }
      }
    },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
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
          "remediation",
          "suggestion",
          "relatedTests",
          "scannerFingerprints"
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
          suggestion: { type: ["string", "null"] },
          relatedTests: { type: "array", items: { type: "string" } },
          scannerFingerprints: { type: "array", items: { type: "string" } }
        }
      }
    },
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
    suggestedReviewers: { type: "array", items: { type: "string" } }
  }
} as const;

const validateStrictModelOutputSchema = ajv.compile(
  strictModelOutputSchema
) as ValidateFunction<Record<string, unknown>>;

export function validateStrictModelOutput(
  value: unknown
): asserts value is Record<string, unknown> {
  if (!validateStrictModelOutputSchema(value)) {
    throw new Error("strict model output schema validation failed");
  }
}

export function normalizeModelOutput(
  value: Record<string, unknown>
): Record<string, unknown> {
  const summary = value.summary as Record<string, unknown>;
  const findings = Array.isArray(value.findings)
    ? value.findings.map((rawFinding) => {
        const finding = rawFinding as Record<string, unknown>;
        return {
          ...finding,
          suggestion:
            finding.suggestion === null ? undefined : finding.suggestion,
          relatedTests: Array.isArray(finding.relatedTests) ? finding.relatedTests : [],
          scannerFingerprints: Array.isArray(finding.scannerFingerprints)
            ? finding.scannerFingerprints
            : []
        };
      })
    : [];

  return {
    ...value,
    summary: {
      ...summary,
      mermaidDiagram:
        summary.mermaidDiagram === null ? undefined : summary.mermaidDiagram
    },
    findings
  };
}
