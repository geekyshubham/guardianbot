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
    fingerprints.add(finding.fingerprint);
  }
  return value;
}

export function validateBackendCapabilities(value: unknown): BackendCapabilities {
  assertValid(validateCapabilitiesSchema, value, "BackendCapabilities");
  return value;
}
