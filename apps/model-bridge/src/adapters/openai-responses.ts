import {
  validateReviewResult,
  type ReviewRequest,
  type ReviewResult
} from "@guardianbot/protocol";
import { BridgeError } from "../errors.js";
import { readResponseJsonLimited } from "../http.js";
import {
  assertPromptSize,
  buildResponseSchema,
  buildFixedResultFields,
  buildResponsesInput,
  type OpenAIResponsesRequestBody
} from "../prompt.js";
import {
  normalizeModelOutput,
  validateStrictModelOutput
} from "../strict-schema.js";
import type {
  AdapterContext,
  AdapterReviewRequest,
  AdapterReviewResult,
  ResolvedBinding
} from "../types.js";

function now(): number {
  return Date.now();
}

function parseStructuredResponse(
  body: unknown,
  request: ReviewRequest,
  fixed: ReturnType<typeof buildFixedResultFields>
): ReviewResult {
  if (!body || typeof body !== "object") {
    throw new BridgeError("invalid_output", "response is not an object", 503, true);
  }
  const record = body as Record<string, unknown>;
  if (record.status !== "completed") {
    if (record.status === "incomplete") {
      throw new BridgeError("timeout", "response incomplete", 503, true);
    }
    throw new BridgeError("invalid_output", "response did not complete", 503, true);
  }

  const outputs = Array.isArray(record.output) ? record.output : [];
  const parsedCandidates: unknown[] = [];
  const textCandidates: string[] = [];
  for (const output of outputs) {
    if (!output || typeof output !== "object") continue;
    const item = output as Record<string, unknown>;
    if (item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const rawContent of content) {
      if (!rawContent || typeof rawContent !== "object") continue;
      const contentItem = rawContent as Record<string, unknown>;
      if (contentItem.type === "refusal") {
        throw new BridgeError("refusal", "model refusal", 422, false);
      }
      if (contentItem.type === "output_text") {
        if (typeof contentItem.text === "string") {
          textCandidates.push(contentItem.text);
        } else if (contentItem.parsed !== undefined) {
          parsedCandidates.push(contentItem.parsed);
        }
      }
    }
  }

  if (typeof record.output_text === "string") {
    textCandidates.push(record.output_text);
  }

  if (textCandidates.length + parsedCandidates.length !== 1) {
    throw new BridgeError(
      "invalid_output",
      "response did not contain exactly one structured text output",
      503,
      true
    );
  }

  let parsed: unknown;
  if (parsedCandidates.length === 1) {
    parsed = parsedCandidates[0];
  } else {
    try {
      parsed = JSON.parse(textCandidates[0] ?? "");
    } catch {
      throw new BridgeError("invalid_output", "text output was not valid JSON", 503, true);
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new BridgeError("invalid_output", "structured output was not an object", 503, true);
  }

  try {
    validateStrictModelOutput(parsed);
  } catch {
    throw new BridgeError("invalid_output", "strict output validation failed", 503, true);
  }

  const normalized = {
    ...normalizeModelOutput(parsed as Record<string, unknown>),
    protocolVersion: fixed.protocolVersion,
    schemaVersion: fixed.schemaVersion,
    requestId: fixed.requestId,
    reviewedHeadSha: fixed.reviewedHeadSha,
    contextIndexSha: fixed.contextIndexSha,
    backend: fixed.backend
  };

  try {
    return validateReviewResult(normalized, request);
  } catch {
    throw new BridgeError("invalid_output", "structured output failed schema validation", 503, true);
  }
}

export class OpenAIResponsesAdapter {
  constructor(
    protected readonly binding: ResolvedBinding,
    protected readonly context: AdapterContext
  ) {}

  protected buildRequestBody(input: AdapterReviewRequest): OpenAIResponsesRequestBody {
    const model = input.route.binding.profileModels[input.route.profile];
    const promptInput = buildResponsesInput(input.request, input.route);
    assertPromptSize(promptInput, input.route.maxInputCharacters);
    return {
      model,
      store: false,
      tools: [],
      max_output_tokens: input.route.maxOutputTokens,
      reasoning: {
        effort: input.route.reasoningEffort
      },
      input: promptInput,
      text: {
        format: {
          type: "json_schema",
          name: "guardian_review_v1",
          schema: buildResponseSchema(),
          strict: true
        }
      }
    };
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "guardianbot-model-bridge/0.1"
    };
    if (this.binding.apiKey) {
      headers.authorization = `Bearer ${this.binding.apiKey}`;
    }
    return headers;
  }

  async review(input: AdapterReviewRequest): Promise<AdapterReviewResult> {
    const startedAt = now();
    let response: Response;
    try {
      response = await (this.context.fetchImpl ?? fetch)(
        new URL("/v1/responses", this.binding.baseUrl),
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(this.buildRequestBody(input)),
          signal: AbortSignal.timeout(input.route.timeoutMs)
        }
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new BridgeError("timeout", "request timed out", 503, true);
      }
      throw new BridgeError("unavailable", String(error), 503, true);
    }

    if (response.status === 401 || response.status === 403) {
      throw new BridgeError("unavailable", "authentication failed", 503, false);
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new BridgeError("unavailable", `upstream status ${response.status}`, 503, true);
    }
    if (response.status === 413) {
      throw new BridgeError("payload_too_large", "upstream request too large", 413, false);
    }
    if (!response.ok) {
      throw new BridgeError("refusal", `upstream refusal ${response.status}`, 422, false);
    }

    const body = await readResponseJsonLimited(response, this.context.responseBodyBytes);
    const fixed = buildFixedResultFields(input.request, input.route);
    const result = parseStructuredResponse(body, input.request, fixed);
    result.backend = {
      backendId: this.binding.alias,
      modelId: this.binding.profileModels[input.route.profile],
      latencyMs: Math.max(0, now() - startedAt),
      ...(extractUsage(body) ?? {})
    };
    return { result };
  }
}

function extractUsage(
  body: unknown
):
  | {
      inputUnits?: number;
      outputUnits?: number;
    }
  | undefined {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = (usage as Record<string, unknown>).input_tokens;
  const outputTokens = (usage as Record<string, unknown>).output_tokens;
  return {
    inputUnits: typeof inputTokens === "number" && Number.isInteger(inputTokens) ? inputTokens : undefined,
    outputUnits:
      typeof outputTokens === "number" && Number.isInteger(outputTokens) ? outputTokens : undefined
  };
}
