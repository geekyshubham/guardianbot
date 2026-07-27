import type {
  BackendCapabilities,
  DataClassification,
  ReviewProfile,
  ReviewRequest,
  ReviewResult
} from "@guardianbot/protocol";

export type SupportedRetention = "none" | "bounded";

export type AdapterKind =
  | "openai-responses"
  | "openai-compatible"
  | "fixture-provider";

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface CommonBindingConfig {
  adapter: AdapterKind;
  allowedClassifications: DataClassification[];
  timeoutMs?: number;
  maxInputCharacters?: number;
  maxOutputTokens?: number;
  retention?: SupportedRetention;
  usageReporting?: boolean;
  profileModels?: Partial<Record<ReviewProfile, string>>;
  profileReasoningEfforts?: Partial<Record<ReviewProfile, ReasoningEffort>>;
}

export interface OpenAIFamilyBindingConfig extends CommonBindingConfig {
  adapter: "openai-responses" | "openai-compatible";
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  allowInsecureHttpForLocalDev?: boolean;
  zeroDataRetentionVerified?: boolean;
}

export interface FixtureBindingConfig extends CommonBindingConfig {
  adapter: "fixture-provider";
  fixtureFile: string;
}

export type BindingConfig =
  | OpenAIFamilyBindingConfig
  | FixtureBindingConfig;

export interface RouteConfig {
  binding: string;
  fallbackBinding?: string;
  timeoutMs?: number;
  maxInputCharacters?: number;
  maxOutputTokens?: number;
}

export interface BridgeConfig {
  protocolVersion: "guardian.review.v1";
  limits?: {
    requestBodyBytes?: number;
    responseBodyBytes?: number;
    startupProbeTimeoutMs?: number;
  };
  bindings: Record<string, BindingConfig>;
  routes: Partial<Record<ReviewProfile, RouteConfig>>;
}

export interface LoadedConfig {
  bindHost: string;
  bindPort: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  startupProbeTimeoutMs: number;
  authToken?: string;
  authRequired: boolean;
  bridge: {
    protocolVersion: "guardian.review.v1";
    bindings: Record<string, ResolvedBinding>;
    routes: Partial<Record<ReviewProfile, unknown>>;
  };
}

export interface ResolvedBinding {
  alias: string;
  adapter: AdapterKind;
  baseUrl?: string;
  apiKey?: string;
  allowedClassifications: DataClassification[];
  timeoutMs: number;
  maxInputCharacters: number;
  maxOutputTokens: number;
  retention: SupportedRetention;
  usageReporting: boolean;
  profileModels: Record<ReviewProfile, string>;
  profileReasoningEfforts: Record<ReviewProfile, ReasoningEffort>;
  fixtureFile?: string;
}

export interface ResolvedRoute {
  profile: ReviewProfile;
  binding: ResolvedBinding;
  fallbackBinding?: ResolvedBinding;
  timeoutMs: number;
  maxInputCharacters: number;
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
}

export interface AdapterContext {
  fetchImpl?: typeof fetch;
  responseBodyBytes: number;
  startupProbeTimeoutMs: number;
}

export interface AdapterReviewRequest {
  request: ReviewRequest;
  route: ResolvedRoute;
}

export interface AdapterReviewResult {
  result: ReviewResult;
}

export interface AdapterProbeRequest {
  route: ResolvedRoute;
}

export interface BridgeAdapter {
  probe?(input: AdapterProbeRequest): Promise<void>;
  review(input: AdapterReviewRequest): Promise<AdapterReviewResult>;
}

export interface RuntimeCapabilities extends BackendCapabilities {}
