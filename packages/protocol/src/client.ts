import type {
  BackendCapabilities,
  BackendRegistryEntry,
  ReviewRequest,
  ReviewResult
} from "./types.js";
import {
  ProtocolValidationError,
  validateBackendCapabilities,
  validateReviewResult
} from "./validator.js";

export type BackendErrorCode =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "refusal"
  | "invalid_output"
  | "context_limit"
  | "unavailable";

export class BackendError extends Error {
  constructor(
    public readonly code: BackendErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export class GuardianReviewClient {
  constructor(private readonly backend: BackendRegistryEntry) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "guardianbot/0.1"
    };
    if (this.backend.authSecret) {
      headers.authorization = `Bearer ${this.backend.authSecret}`;
    }
    return headers;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/healthz", this.backend.baseUrl), {
        headers: this.headers(),
        signal: AbortSignal.timeout(Math.min(this.backend.timeoutMs, 10_000))
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<BackendCapabilities> {
    const response = await this.fetch("/v1/capabilities", { method: "GET" });
    return validateBackendCapabilities(await response.json());
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    let response: Response;
    try {
      response = await this.fetch("/v1/reviews", {
        method: "POST",
        body: JSON.stringify(request)
      });
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError("unavailable", String(error), true);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BackendError("invalid_output", "Backend returned invalid JSON", true);
    }

    try {
      return validateReviewResult(body, request);
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        throw new BackendError("invalid_output", error.message, true);
      }
      throw error;
    }
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.backend.baseUrl), {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.backend.timeoutMs)
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new BackendError("timeout", "Backend request timed out", true);
      }
      throw error;
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new BackendError("authentication", "Backend authentication failed", false);
    }
    if (response.status === 413) {
      throw new BackendError("context_limit", "Backend rejected request size", false);
    }
    if (response.status === 429) {
      throw new BackendError("rate_limit", "Backend rate limited request", true);
    }
    if (response.status >= 500) {
      throw new BackendError("unavailable", `Backend returned ${response.status}`, true);
    }
    throw new BackendError("refusal", `Backend returned ${response.status}`, false);
  }
}

