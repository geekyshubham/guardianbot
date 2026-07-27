import { readFileSync } from "node:fs";
import {
  validateReviewResult,
  type ReviewResult
} from "@guardianbot/protocol";
import { BridgeError } from "../errors.js";
import type {
  AdapterContext,
  AdapterReviewRequest,
  AdapterReviewResult,
  ResolvedBinding
} from "../types.js";

interface FixtureFile {
  capabilities?: {
    structuredOutput?: boolean;
    retention?: "none" | "bounded";
    usageReporting?: boolean;
  };
  defaultResult?: ReviewResult;
  byRequestId?: Record<string, ReviewResult>;
  errorsByRequestId?: Record<
    string,
    {
      code: "timeout" | "refusal" | "invalid_output" | "unavailable";
    }
  >;
}

export class FixtureProviderAdapter {
  private readonly fixture: FixtureFile;

  constructor(
    private readonly binding: ResolvedBinding,
    _context: AdapterContext
  ) {
    const parsed = JSON.parse(readFileSync(binding.fixtureFile!, "utf8")) as FixtureFile;
    this.fixture = parsed;
  }

  async review(input: AdapterReviewRequest): Promise<AdapterReviewResult> {
    const errorCode = this.fixture.errorsByRequestId?.[input.request.requestId]?.code;
    if (errorCode === "timeout") {
      throw new BridgeError("timeout", "fixture timeout", 503, true);
    }
    if (errorCode === "refusal") {
      throw new BridgeError("refusal", "fixture refusal", 422, false);
    }
    if (errorCode === "invalid_output") {
      throw new BridgeError("invalid_output", "fixture invalid output", 503, true);
    }
    if (errorCode === "unavailable") {
      throw new BridgeError("unavailable", "fixture unavailable", 503, true);
    }

    const result =
      this.fixture.byRequestId?.[input.request.requestId] ?? this.fixture.defaultResult;
    if (!result) {
      throw new BridgeError("unavailable", "fixture result missing", 503, true);
    }

    const normalized = {
      ...result,
      protocolVersion: input.request.protocolVersion,
      schemaVersion: input.request.schemaVersion,
      requestId: input.request.requestId,
      reviewedHeadSha: input.request.pullRequest.headSha,
      contextIndexSha: input.request.expectedContextIndexSha ?? result.contextIndexSha,
      backend: {
        ...result.backend,
        backendId: this.binding.alias,
        modelId: this.binding.profileModels[input.route.profile],
        latencyMs: result.backend?.latencyMs ?? 1
      }
    };
    return {
      result: validateReviewResult(normalized, input.request)
    };
  }
}
