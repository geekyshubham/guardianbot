import AjvImport, {
  type ErrorObject,
  type ValidateFunction,
  type Options,
  type Ajv as AjvInstance
} from "ajv";
import addFormatsImport from "ajv-formats";
import type {
  BackendCapabilities,
  ChangedLineRange,
  ReviewFinding,
  ReviewRequest,
  ReviewResult
} from "./types.js";
import {
  backendCapabilitiesSchema,
  reviewRequestSchema,
  reviewResultSchema
} from "./schemas.js";

const Ajv = AjvImport as unknown as new (options?: Options) => AjvInstance;
const addFormats = addFormatsImport as unknown as (ajv: AjvInstance) => AjvInstance;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validateRequestSchema = ajv.compile(reviewRequestSchema) as ValidateFunction<ReviewRequest>;
const validateResultSchema = ajv.compile(reviewResultSchema) as ValidateFunction<ReviewResult>;
const validateCapabilitiesSchema = ajv.compile(
  backendCapabilitiesSchema
) as ValidateFunction<BackendCapabilities>;

export class ProtocolValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ErrorObject[] = []
  ) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

function assertValid<T>(
  validate: ValidateFunction<T>,
  value: unknown,
  label: string
): asserts value is T {
  if (!validate(value)) {
    throw new ProtocolValidationError(
      `${label} failed schema validation`,
      validate.errors ? [...validate.errors] : []
    );
  }
}

export function validateReviewRequest(value: unknown): ReviewRequest {
  assertValid(validateRequestSchema, value, "ReviewRequest");
  return value;
}

function locationAllowed(
  path: string,
  start: number,
  end: number,
  ranges: ChangedLineRange[]
): boolean {
  return ranges.some(
    (range) =>
      range.path === path && start >= range.start && end <= range.end && end >= start
  );
}

const EVIDENCE_TOKEN_PATTERN = /[A-Za-z_][A-Za-z0-9_:-]{3,}|\b\d{3,}\b/g;

function evidenceTokens(value: string): Set<string> {
  return new Set(
    (value.match(EVIDENCE_TOKEN_PATTERN) ?? []).map((token) => token.toLowerCase())
  );
}

function evidenceSupported(
  finding: ReviewFinding,
  request: ReviewRequest
): boolean {
  const evidence = finding.evidence.trim();
  if (evidence.length < 12) return false;
  const contexts = request.contexts.filter(
    (context) => context.path === finding.path
  );
  if (!contexts.length) return false;

  const normalizedEvidence = evidence
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  for (const context of contexts) {
    const normalizedContext = context.content
      .split("\n")
      .map((line) => line.replace(/^[ +\-]/, "").trim())
      .join("\n")
      .replace(/[`"'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (
      normalizedEvidence.length >= 12 &&
      normalizedContext.includes(normalizedEvidence)
    ) {
      return true;
    }
  }

  const findingTokens = evidenceTokens(evidence);
  if (!findingTokens.size) return false;
  for (const context of contexts) {
    const contextTokens = evidenceTokens(context.content);
    const overlap = [...findingTokens].filter((token) => contextTokens.has(token)).length;
    const minimumOverlap = Math.min(2, findingTokens.size);
    if (
      overlap >= minimumOverlap &&
      overlap / findingTokens.size >= 0.6
    ) {
      return true;
    }
  }
  return false;
}

export function validateReviewResult(
  value: unknown,
  request?: ReviewRequest
): ReviewResult {
  assertValid(validateResultSchema, value, "ReviewResult");

  if (!request) {
    return value;
  }

  if (value.requestId !== request.requestId) {
    throw new ProtocolValidationError("ReviewResult requestId does not match request");
  }
  if (value.reviewedHeadSha !== request.pullRequest.headSha) {
    throw new ProtocolValidationError("ReviewResult reviewedHeadSha does not match request");
  }
  if (
    request.expectedContextIndexSha &&
    value.contextIndexSha !== request.expectedContextIndexSha
  ) {
    throw new ProtocolValidationError("ReviewResult contextIndexSha does not match request");
  }
  if (value.findings.length > request.limits.maxInlineComments) {
    throw new ProtocolValidationError("ReviewResult exceeds maxInlineComments");
  }

  const fingerprints = new Set<string>();
  const scannerFingerprints = new Set(
    request.scannerEvidence.map((evidence) => evidence.fingerprint)
  );
  for (const finding of value.findings) {
    if (
      !locationAllowed(
        finding.path,
        finding.startLine,
        finding.endLine,
        request.validChangedLines
      )
    ) {
      throw new ProtocolValidationError(
        `Finding ${finding.id} references a line outside the changed diff`
      );
    }
    if (fingerprints.has(finding.fingerprint)) {
      throw new ProtocolValidationError(
        `Duplicate finding fingerprint ${finding.fingerprint}`
      );
    }
    if (!evidenceSupported(finding, request)) {
      throw new ProtocolValidationError(
        `Finding ${finding.id} does not contain evidence grounded in its file context`
      );
    }
    for (const scannerFingerprint of finding.scannerFingerprints ?? []) {
      if (!scannerFingerprints.has(scannerFingerprint)) {
        throw new ProtocolValidationError(
          `Finding ${finding.id} references unknown scanner evidence ${scannerFingerprint}`
        );
      }
    }
    fingerprints.add(finding.fingerprint);
  }
  return value;
}

export function validateBackendCapabilities(value: unknown): BackendCapabilities {
  assertValid(validateCapabilitiesSchema, value, "BackendCapabilities");
  return value;
}
