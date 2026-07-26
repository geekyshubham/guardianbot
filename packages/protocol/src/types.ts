export const PROTOCOL_VERSION = "guardian.review.v1" as const;

export type DataClassification = "public" | "private" | "restricted";
export type ReviewProfile =
  | "routine-review"
  | "high-risk-review"
  | "benchmark-review"
  | "fallback-review";

export interface ChangedLineRange {
  path: string;
  start: number;
  end: number;
}

export interface ReviewContextChunk {
  id: string;
  path: string;
  kind:
    | "diff"
    | "caller"
    | "callee"
    | "test"
    | "schema"
    | "config"
    | "issue"
    | "history"
    | "scanner";
  content: string;
  sha256: string;
}

export interface ScannerEvidence {
  source: "semgrep" | "trivy" | "zap" | "other";
  fingerprint: string;
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  path?: string;
  line?: number;
  summary: string;
}

export interface ReviewRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  schemaVersion: "1.0.0";
  requestId: string;
  repository: {
    owner: string;
    name: string;
    visibility: DataClassification;
    defaultBranch: string;
  };
  pullRequest: {
    number: number;
    title: string;
    body: string;
    baseSha: string;
    headSha: string;
    author: string;
  };
  profile: ReviewProfile;
  promptVersion: string;
  validChangedLines: ChangedLineRange[];
  contexts: ReviewContextChunk[];
  scannerEvidence: ScannerEvidence[];
  rules: Array<{
    id: string;
    instruction: string;
    paths?: string[];
    severity?: "P0" | "P1" | "P2" | "P3";
  }>;
  limits: {
    maxInlineComments: number;
    maxInputCharacters: number;
    timeoutMs: number;
  };
}

export type FindingCategory =
  | "security"
  | "logic"
  | "reliability"
  | "concurrency"
  | "performance"
  | "contract"
  | "testing"
  | "maintainability";

export interface ReviewFinding {
  id: string;
  fingerprint: string;
  category: FindingCategory;
  severity: "P0" | "P1" | "P2" | "P3";
  confidence: number;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  evidence: string;
  impact: string;
  remediation: string;
  suggestion?: string;
  relatedTests?: string[];
  scannerFingerprints?: string[];
}

export interface ReviewResult {
  protocolVersion: typeof PROTOCOL_VERSION;
  schemaVersion: "1.0.0";
  requestId: string;
  reviewedHeadSha: string;
  contextIndexSha: string;
  summary: {
    intent: string;
    changeGroups: Array<{ title: string; paths: string[]; summary: string }>;
    riskScore: number;
    reviewEffort: 1 | 2 | 3 | 4 | 5;
    impactedComponents: string[];
    mermaidDiagram?: string;
    partialReview: boolean;
  };
  findings: ReviewFinding[];
  requirements: Array<{
    requirement: string;
    status: "addressed" | "missing" | "inconclusive";
    evidence: string;
  }>;
  testGaps: string[];
  suggestedReviewers: string[];
  backend: {
    backendId: string;
    modelId: string;
    latencyMs: number;
    inputUnits?: number;
    outputUnits?: number;
    estimatedCostUsd?: number;
  };
}

export interface BackendCapabilities {
  protocolVersion: typeof PROTOCOL_VERSION;
  backendId: string;
  structuredOutput: boolean;
  maxInputCharacters: number;
  supportedProfiles: ReviewProfile[];
  supportedDataClassifications: DataClassification[];
  retention: "none" | "bounded" | "unknown";
  usageReporting: boolean;
}

export interface BackendRegistryEntry {
  id: string;
  baseUrl: string;
  authSecret?: string;
  allowedClassifications: DataClassification[];
  timeoutMs: number;
}

export interface ReviewProfileRoute {
  profile: ReviewProfile;
  backendId: string;
  modelId: string;
  reasoning?: string;
  maxInputCharacters: number;
  timeoutMs: number;
  retryCount: 0 | 1;
  fallbackBackendId?: string;
}

