import type { ReviewRequest } from "@guardianbot/protocol";
import { BridgeError } from "../errors.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import type {
  AdapterContext,
  AdapterProbeRequest,
  ResolvedBinding
} from "../types.js";

const PROBE_REQUEST: ReviewRequest = {
  protocolVersion: "guardian.review.v1",
  schemaVersion: "1.0.0",
  requestId: "probe-request",
  repository: {
    owner: "redacted",
    name: "probe",
    visibility: "public",
    defaultBranch: "main"
  },
  pullRequest: {
    number: 1,
    title: "probe",
    body: "",
    baseSha: "aaaaaaa",
    headSha: "bbbbbbb",
    author: "bridge"
  },
  profile: "routine-review",
  promptVersion: "probe",
  expectedContextIndexSha: "c".repeat(64),
  validChangedLines: [{ path: "probe.txt", start: 1, end: 1 }],
  contexts: [
    {
      id: "probe-1",
      path: "probe.txt",
      kind: "diff",
      content: "safe probe payload",
      sha256: "d".repeat(64)
    }
  ],
  scannerEvidence: [],
  rules: [
    {
      id: "probe-rule",
      instruction: "Return an empty advisory result if there are no findings."
    }
  ],
  limits: {
    maxInlineComments: 1,
    maxInputCharacters: 10_000,
    timeoutMs: 5_000
  }
};

export class OpenAICompatibleAdapter extends OpenAIResponsesAdapter {
  private readonly probedModels = new Set<string>();

  constructor(binding: ResolvedBinding, context: AdapterContext) {
    super(binding, context);
  }

  async probe(input: AdapterProbeRequest): Promise<void> {
    const model = input.route.binding.profileModels[input.route.profile];
    if (this.probedModels.has(model)) return;
    const probeTimeoutMs = Math.min(
      input.route.timeoutMs,
      this.context.startupProbeTimeoutMs
    );
    try {
      await this.review({
        request: {
          ...PROBE_REQUEST,
          profile: input.route.profile,
          limits: {
            ...PROBE_REQUEST.limits,
            timeoutMs: probeTimeoutMs
          }
        },
        route: {
          ...input.route,
          timeoutMs: probeTimeoutMs,
          maxInputCharacters: Math.min(input.route.maxInputCharacters, 10_000),
          maxOutputTokens: Math.min(input.route.maxOutputTokens, 2_000)
        }
      });
    } catch {
      throw new BridgeError(
        "unavailable",
        "compatible endpoint failed strict structured-output probe",
        503,
        false
      );
    }
    this.probedModels.add(model);
  }
}
