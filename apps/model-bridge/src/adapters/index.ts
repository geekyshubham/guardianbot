import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import { FixtureProviderAdapter } from "./fixture-provider.js";
import type { AdapterContext, BridgeAdapter, ResolvedBinding } from "../types.js";

export function createAdapter(
  binding: ResolvedBinding,
  context: AdapterContext
): BridgeAdapter {
  switch (binding.adapter) {
    case "openai-responses":
      return new OpenAIResponsesAdapter(binding, context);
    case "openai-compatible":
      return new OpenAICompatibleAdapter(binding, context);
    case "fixture-provider":
      return new FixtureProviderAdapter(binding, context);
  }
}
