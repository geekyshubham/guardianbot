import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type {
  LoadedConfig,
  OpenAIFamilyBindingConfig,
  ReasoningEffort,
  ResolvedBinding,
  ResolvedRoute
} from "./types.js";
import {
  PROTOCOL_VERSION,
  type DataClassification,
  type ReviewProfile
} from "@guardianbot/protocol";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESPONSE_BODY_BYTES = 1024 * 1024;
const DEFAULT_STARTUP_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INPUT_CHARACTERS = 400_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const MAX_OUTPUT_TOKENS_LIMIT = 65_536;
const DEFAULT_MODELS: Record<ReviewProfile, string> = {
  "routine-review": "gpt-5.6-terra",
  "high-risk-review": "gpt-5.6-sol",
  "benchmark-review": "gpt-5.6-sol",
  "fallback-review": "gpt-5.6-terra"
};
const DEFAULT_REASONING_EFFORTS: Record<ReviewProfile, ReasoningEffort> = {
  "routine-review": "medium",
  "high-risk-review": "medium",
  "benchmark-review": "medium",
  "fallback-review": "medium"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asInteger(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asClassificationList(
  value: unknown,
  label: string
): DataClassification[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return [...new Set(value.map((item, index) => parseClassification(item, `${label}[${index}]`)))];
}

function parseClassification(value: unknown, label: string): DataClassification {
  if (value === "public" || value === "private" || value === "restricted") {
    return value;
  }
  throw new Error(`${label} must be public, private, or restricted`);
}

function parseProfile(value: string, label: string): ReviewProfile {
  if (
    value === "routine-review" ||
    value === "high-risk-review" ||
    value === "benchmark-review" ||
    value === "fallback-review"
  ) {
    return value;
  }
  throw new Error(`${label} is not a supported review profile`);
}

function parseUrl(value: unknown, label: string): string {
  if (value === undefined) return "https://api.openai.com";
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.startsWith("127.");
  if (ipVersion === 6) return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "host.docker.internal" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized)) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map((part) => Number(part));
    const [first, second] = octets;
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (ipVersion === 6) {
    return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isPrivateHostname(hostname);
}

function parseBackendBaseUrl(
  value: unknown,
  label: string,
  adapter: OpenAIFamilyBindingConfig["adapter"],
  allowInsecureHttpForLocalDev: boolean
): string {
  const serialized = parseUrl(value, label);
  const url = new URL(serialized);
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "https:" || loopback) {
    return serialized;
  }
  if (adapter === "openai-responses") {
    throw new Error(`${label} must use HTTPS outside explicit loopback development`);
  }
  if (!allowInsecureHttpForLocalDev) {
    throw new Error(`${label} must use HTTPS unless allowInsecureHttpForLocalDev is explicitly enabled`);
  }
  if (!isLocalOrPrivateHostname(url.hostname)) {
    throw new Error(`${label} insecure HTTP is limited to local or private compatible gateways`);
  }
  return serialized;
}

function parseApiKey(
  binding: OpenAIFamilyBindingConfig,
  environment: NodeJS.ProcessEnv,
  label: string
): string | undefined {
  if (binding.apiKey && binding.apiKeyEnv) {
    throw new Error(`${label} must not set both apiKey and apiKeyEnv`);
  }
  if (binding.apiKey !== undefined && typeof binding.apiKey !== "string") {
    throw new Error(`${label} apiKey must be a string`);
  }
  if (binding.apiKeyEnv !== undefined && typeof binding.apiKeyEnv !== "string") {
    throw new Error(`${label} apiKeyEnv must be a string`);
  }
  if (binding.apiKeyEnv) {
    const resolved = environment[binding.apiKeyEnv];
    if (!resolved) throw new Error(`${label} apiKeyEnv is not set in the environment`);
    return resolved;
  }
  return binding.apiKey;
}

function parseProfileModels(
  value: unknown
): Record<ReviewProfile, string> {
  if (value === undefined) return { ...DEFAULT_MODELS };
  if (!isRecord(value)) throw new Error("profileModels must be an object");
  const models = { ...DEFAULT_MODELS };
  for (const [key, rawModel] of Object.entries(value)) {
    const profile = parseProfile(key, `profileModels.${key}`);
    if (typeof rawModel !== "string" || !rawModel.trim()) {
      throw new Error(`profileModels.${profile} must be a non-empty string`);
    }
    models[profile] = rawModel;
  }
  return models;
}

function parseReasoningEffort(
  value: unknown,
  label: string
): ReasoningEffort {
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  throw new Error(`${label} must be one of none, low, medium, high, xhigh, max`);
}

function parseProfileReasoningEfforts(
  value: unknown
): Record<ReviewProfile, ReasoningEffort> {
  if (value === undefined) return { ...DEFAULT_REASONING_EFFORTS };
  if (!isRecord(value)) throw new Error("profileReasoningEfforts must be an object");
  const efforts = { ...DEFAULT_REASONING_EFFORTS };
  for (const [key, rawEffort] of Object.entries(value)) {
    const profile = parseProfile(key, `profileReasoningEfforts.${key}`);
    efforts[profile] = parseReasoningEffort(
      rawEffort,
      `profileReasoningEfforts.${profile}`
    );
  }
  return efforts;
}

function parseBinding(
  alias: string,
  rawBinding: unknown,
  environment: NodeJS.ProcessEnv
): ResolvedBinding {
  if (!isRecord(rawBinding)) throw new Error(`binding ${alias} must be an object`);
  if (
    rawBinding.adapter !== "openai-responses" &&
    rawBinding.adapter !== "openai-compatible" &&
    rawBinding.adapter !== "fixture-provider"
  ) {
    throw new Error(`binding ${alias} adapter is unsupported`);
  }

  const allowedClassifications = asClassificationList(
    rawBinding.allowedClassifications,
    `binding ${alias} allowedClassifications`
  );
  const timeoutMs =
    rawBinding.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : asInteger(rawBinding.timeoutMs, `binding ${alias} timeoutMs`, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxInputCharacters =
    rawBinding.maxInputCharacters === undefined
      ? DEFAULT_MAX_INPUT_CHARACTERS
      : asInteger(
          rawBinding.maxInputCharacters,
          `binding ${alias} maxInputCharacters`,
          1_000,
          2_000_000
        );
  const maxOutputTokens =
    rawBinding.maxOutputTokens === undefined
      ? DEFAULT_MAX_OUTPUT_TOKENS
      : asInteger(
          rawBinding.maxOutputTokens,
          `binding ${alias} maxOutputTokens`,
          256,
          MAX_OUTPUT_TOKENS_LIMIT
        );
  const profileModels = parseProfileModels(rawBinding.profileModels);
  const profileReasoningEfforts = parseProfileReasoningEfforts(
    rawBinding.profileReasoningEfforts
  );

  if (rawBinding.adapter === "fixture-provider") {
    if (typeof rawBinding.fixtureFile !== "string" || !rawBinding.fixtureFile.trim()) {
      throw new Error(`binding ${alias} fixtureFile is required`);
    }
    return {
      alias,
      adapter: rawBinding.adapter,
      allowedClassifications,
      timeoutMs,
      maxInputCharacters,
      maxOutputTokens,
      retention: rawBinding.retention === "bounded" ? "bounded" : "none",
      usageReporting: Boolean(rawBinding.usageReporting),
      profileModels,
      profileReasoningEfforts,
      fixtureFile: resolve(rawBinding.fixtureFile)
    };
  }

  const typed = rawBinding as unknown as OpenAIFamilyBindingConfig;
  const allowInsecureHttpForLocalDev = Boolean(typed.allowInsecureHttpForLocalDev);
  if (typed.adapter === "openai-responses" && allowInsecureHttpForLocalDev) {
    throw new Error(
      `binding ${alias} allowInsecureHttpForLocalDev is not supported for openai-responses`
    );
  }
  const retention =
    typed.retention === "none" || typed.retention === "bounded"
      ? typed.retention
      : typed.adapter === "openai-compatible"
        ? undefined
        : "bounded";
  if (!retention) {
    throw new Error(`binding ${alias} retention must be set for openai-compatible`);
  }
  if (
    typed.adapter === "openai-responses" &&
    retention === "none" &&
    typed.zeroDataRetentionVerified !== true
  ) {
    throw new Error(
      `binding ${alias} retention none requires zeroDataRetentionVerified after administrative verification`
    );
  }

  return {
    alias,
    adapter: typed.adapter,
    baseUrl: parseBackendBaseUrl(
      typed.baseUrl,
      `binding ${alias} baseUrl`,
      typed.adapter,
      allowInsecureHttpForLocalDev
    ),
    apiKey: parseApiKey(typed, environment, `binding ${alias}`),
    allowedClassifications,
    timeoutMs,
    maxInputCharacters,
    maxOutputTokens,
    retention,
    usageReporting:
      typed.usageReporting === undefined
        ? typed.adapter === "openai-responses"
        : Boolean(typed.usageReporting),
    profileModels,
    profileReasoningEfforts
  };
}

function parseRoute(
  profile: ReviewProfile,
  rawRoute: unknown,
  bindings: Map<string, ResolvedBinding>
): ResolvedRoute {
  if (!isRecord(rawRoute)) throw new Error(`route ${profile} must be an object`);
  if (typeof rawRoute.binding !== "string") {
    throw new Error(`route ${profile} binding is required`);
  }
  const binding = bindings.get(rawRoute.binding);
  if (!binding) throw new Error(`route ${profile} references unknown binding ${rawRoute.binding}`);

  let fallbackBinding: ResolvedBinding | undefined;
  if (rawRoute.fallbackBinding !== undefined) {
    if (typeof rawRoute.fallbackBinding !== "string") {
      throw new Error(`route ${profile} fallbackBinding must be a string`);
    }
    fallbackBinding = bindings.get(rawRoute.fallbackBinding);
    if (!fallbackBinding) {
      throw new Error(
        `route ${profile} references unknown fallback binding ${rawRoute.fallbackBinding}`
      );
    }
    const primaryClassifications = new Set(binding.allowedClassifications);
    const fallbackClassifications = new Set(fallbackBinding.allowedClassifications);
    for (const classification of primaryClassifications) {
      if (!fallbackClassifications.has(classification)) {
        throw new Error(
          `route ${profile} fallbackBinding must allow every primary classification`
        );
      }
    }
  }

  return {
    profile,
    binding,
    fallbackBinding,
    timeoutMs:
      rawRoute.timeoutMs === undefined
        ? binding.timeoutMs
        : asInteger(rawRoute.timeoutMs, `route ${profile} timeoutMs`, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxInputCharacters:
      rawRoute.maxInputCharacters === undefined
        ? binding.maxInputCharacters
        : asInteger(
            rawRoute.maxInputCharacters,
            `route ${profile} maxInputCharacters`,
            1_000,
            2_000_000
          ),
    maxOutputTokens:
      rawRoute.maxOutputTokens === undefined
        ? binding.maxOutputTokens
        : asInteger(
            rawRoute.maxOutputTokens,
            `route ${profile} maxOutputTokens`,
            256,
            MAX_OUTPUT_TOKENS_LIMIT
          ),
    reasoningEffort: binding.profileReasoningEfforts[profile]
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const serialized = environment.GUARDIAN_MODEL_BRIDGE_CONFIG_JSON;
  const file = environment.GUARDIAN_MODEL_BRIDGE_CONFIG_FILE;
  const rawConfig =
    serialized ?? (file ? readFileSync(resolve(file), "utf8") : undefined);
  if (!rawConfig) {
    throw new Error(
      "GUARDIAN_MODEL_BRIDGE_CONFIG_JSON or GUARDIAN_MODEL_BRIDGE_CONFIG_FILE is required"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    throw new Error("bridge configuration is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("bridge configuration must be an object");
  if (parsed.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`bridge protocolVersion must be ${PROTOCOL_VERSION}`);
  }
  if (!isRecord(parsed.bindings) || !Object.keys(parsed.bindings).length) {
    throw new Error("bridge bindings must define at least one binding");
  }
  if (!isRecord(parsed.routes) || !Object.keys(parsed.routes).length) {
    throw new Error("bridge routes must define at least one profile route");
  }

  const bindings = new Map<string, ResolvedBinding>();
  for (const [alias, rawBinding] of Object.entries(parsed.bindings)) {
    bindings.set(alias, parseBinding(alias, rawBinding, environment));
  }

  const routes = {} as Partial<Record<ReviewProfile, unknown>>;
  for (const [profile, rawRoute] of Object.entries(parsed.routes)) {
    routes[parseProfile(profile, `routes.${profile}`)] = rawRoute;
  }

  const bindHost = typeof environment.HOST === "string" && environment.HOST
    ? environment.HOST
    : "127.0.0.1";
  const bindPort = environment.PORT === undefined
    ? 3001
    : asInteger(Number(environment.PORT), "PORT", MIN_PORT, MAX_PORT);
  const requestBodyBytes =
    parsed.limits && isRecord(parsed.limits) && parsed.limits.requestBodyBytes !== undefined
      ? asInteger(parsed.limits.requestBodyBytes, "limits.requestBodyBytes", 1024, 10 * 1024 * 1024)
      : DEFAULT_REQUEST_BODY_BYTES;
  const responseBodyBytes =
    parsed.limits && isRecord(parsed.limits) && parsed.limits.responseBodyBytes !== undefined
      ? asInteger(parsed.limits.responseBodyBytes, "limits.responseBodyBytes", 1024, 10 * 1024 * 1024)
      : DEFAULT_RESPONSE_BODY_BYTES;
  const startupProbeTimeoutMs =
    parsed.limits && isRecord(parsed.limits) && parsed.limits.startupProbeTimeoutMs !== undefined
      ? asInteger(
          parsed.limits.startupProbeTimeoutMs,
          "limits.startupProbeTimeoutMs",
          MIN_TIMEOUT_MS,
          MAX_TIMEOUT_MS
        )
      : DEFAULT_STARTUP_PROBE_TIMEOUT_MS;
  const authToken =
    typeof environment.GUARDIAN_MODEL_BRIDGE_TOKEN === "string" &&
    environment.GUARDIAN_MODEL_BRIDGE_TOKEN.length > 0
      ? environment.GUARDIAN_MODEL_BRIDGE_TOKEN
      : undefined;
  const loopbackListener = isLoopbackHostname(bindHost);
  const hasNonLoopbackBinding = [...bindings.values()].some((binding) => {
    if (!binding.baseUrl) return false;
    return !isLoopbackHostname(new URL(binding.baseUrl).hostname);
  });
  const authRequired = Boolean(authToken) || !loopbackListener || hasNonLoopbackBinding;
  if (authRequired && !authToken) {
    throw new Error(
      "GUARDIAN_MODEL_BRIDGE_TOKEN is required unless the bridge is loopback-only for local development"
    );
  }

  return {
    bindHost,
    bindPort,
    requestBodyBytes,
    responseBodyBytes,
    startupProbeTimeoutMs,
    authToken,
    authRequired,
    bridge: {
      protocolVersion: PROTOCOL_VERSION,
      bindings: Object.fromEntries(bindings.entries()),
      routes
    }
  };
}

export function resolveRoutes(config: LoadedConfig): ResolvedRoute[] {
  const bindings = new Map<string, ResolvedBinding>(
    Object.values(config.bridge.bindings).map((binding) => [binding.alias, binding])
  );
  const routes: ResolvedRoute[] = [];
  for (const [profileKey, rawRoute] of Object.entries(config.bridge.routes)) {
    const profile = parseProfile(profileKey, `routes.${profileKey}`);
    routes.push(parseRoute(profile, rawRoute, bindings));
  }
  if (!routes.length) throw new Error("bridge must configure at least one route");
  return routes;
}

export function buildRuntimeCapabilities(routes: ResolvedRoute[]) {
  const first = routes[0];
  if (!first) throw new Error("bridge must configure at least one route");
  const classificationKey = first.binding.allowedClassifications.join(",");
  const retention = first.binding.retention;
  for (const route of routes) {
    if (route.binding.allowedClassifications.join(",") !== classificationKey) {
      throw new Error(
        "all routed bindings must share the same allowedClassifications set"
      );
    }
    if (route.binding.retention !== retention) {
      throw new Error("all routed bindings must share the same retention mode");
    }
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    backendId: "model-bridge",
    structuredOutput: true,
    maxInputCharacters: Math.min(...routes.map((route) => route.maxInputCharacters)),
    supportedProfiles: routes.map((route) => route.profile),
    supportedDataClassifications: [...first.binding.allowedClassifications],
    retention,
    usageReporting: routes.every((route) => route.binding.usageReporting)
  } as const;
}
