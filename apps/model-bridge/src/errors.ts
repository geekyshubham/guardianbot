export type SafeErrorCode =
  | "bad_request"
  | "payload_too_large"
  | "unsupported_route"
  | "unsupported_classification"
  | "refusal"
  | "invalid_output"
  | "timeout"
  | "unavailable";

export class BridgeError extends Error {
  constructor(
    public readonly code: SafeErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function sanitizeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return new BridgeError(
      error.code,
      redactMessage(error.code),
      error.statusCode,
      error.retryable
    );
  }
  return new BridgeError("unavailable", redactMessage("unavailable"), 503, true);
}

export function redactMessage(code: SafeErrorCode): string {
  switch (code) {
    case "bad_request":
      return "Request validation failed.";
    case "payload_too_large":
      return "Payload exceeded bridge limits.";
    case "unsupported_route":
      return "Requested review profile is not configured.";
    case "unsupported_classification":
      return "Requested data classification is not allowed for this route.";
    case "refusal":
      return "Model refused the review request.";
    case "invalid_output":
      return "Model output failed bridge validation.";
    case "timeout":
      return "Model backend timed out.";
    case "unavailable":
      return "Model backend is unavailable.";
  }
}
