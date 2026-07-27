import {
  GuardianReviewClient,
  type DataClassification,
  type ReviewProfile
} from "@guardianbot/protocol";

const ROUTABLE_PROFILES = [
  "routine-review",
  "high-risk-review",
  "benchmark-review"
] as const satisfies readonly ReviewProfile[];

export type RoutableReviewProfile = (typeof ROUTABLE_PROFILES)[number];

export interface AdminBackendDefinition {
  endpoint: string;
  token?: string;
  tokenEnv?: string;
  allowedClassifications: DataClassification[];
  timeoutMs?: number;
  /**
   * Allows an authenticated cleartext hop only to a private-network address.
   * This is an administrative deployment setting for platforms such as
   * DigitalOcean App Platform; repository configuration cannot set it.
   */
  allowPrivateHttp?: boolean;
}

export interface AdminBackendRegistryConfig {
  protocolVersion: "guardian.review.v1";
  backends: Record<string, AdminBackendDefinition>;
  routes: Partial<Record<RoutableReviewProfile, string>>;
}

export interface ResolvedReviewBackend {
  alias: string;
  allowedClassifications: DataClassification[];
  client: GuardianReviewClient;
}

type AdminEnvironment = Record<string, string | undefined>;

const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const TOKEN_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
  }
}

function parseClassification(value: unknown, label: string): DataClassification {
  if (value === "public" || value === "private" || value === "restricted") return value;
  throw new Error(`${label} contains an invalid data classification`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(normalized)) return true;
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized)) {
    return true;
  }
  if (normalized.endsWith(".internal")) return true;
  const octets = normalized.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return /^f[cd][0-9a-f]:/i.test(normalized);
}

export function parseAdminBackendRegistry(
  input: string | AdminBackendRegistryConfig,
  environment: AdminEnvironment = process.env
): AdminBackendRegistryConfig {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("Guardian review backend registry is not valid JSON");
    }
  }
  if (!isRecord(value)) throw new Error("Guardian review backend registry must be an object");
  assertOnlyKeys(value, ["protocolVersion", "backends", "routes"], "backend registry");
  if (value.protocolVersion !== "guardian.review.v1") {
    throw new Error("backend registry protocolVersion must be guardian.review.v1");
  }
  if (!isRecord(value.backends) || !Object.keys(value.backends).length) {
    throw new Error("backend registry must define at least one backend alias");
  }
  if (!isRecord(value.routes)) throw new Error("backend registry routes must be an object");

  const backends: Record<string, AdminBackendDefinition> = {};
  for (const [alias, rawDefinition] of Object.entries(value.backends)) {
    if (!ALIAS_PATTERN.test(alias)) throw new Error(`invalid backend alias ${alias}`);
    if (!isRecord(rawDefinition)) throw new Error(`backend ${alias} must be an object`);
    assertOnlyKeys(
      rawDefinition,
      [
        "endpoint",
        "token",
        "tokenEnv",
        "allowedClassifications",
        "timeoutMs",
        "allowPrivateHttp"
      ],
      `backend ${alias}`
    );
    if (typeof rawDefinition.endpoint !== "string") {
      throw new Error(`backend ${alias} endpoint is required`);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(rawDefinition.endpoint);
    } catch {
      throw new Error(`backend ${alias} endpoint must be an absolute URL`);
    }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new Error(`backend ${alias} endpoint must use HTTP or HTTPS`);
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error(
        `backend ${alias} endpoint must not contain credentials or a fragment`
      );
    }
    const loopback = isLoopbackHost(endpoint.hostname);
    if (
      rawDefinition.allowPrivateHttp !== undefined &&
      typeof rawDefinition.allowPrivateHttp !== "boolean"
    ) {
      throw new Error(`backend ${alias} allowPrivateHttp must be a boolean`);
    }
    if (endpoint.protocol !== "https:" && !loopback) {
      if (
        rawDefinition.allowPrivateHttp !== true ||
        !isPrivateNetworkHost(endpoint.hostname)
      ) {
        throw new Error(
          `backend ${alias} endpoint must use HTTPS outside explicit authenticated private-network mode`
        );
      }
    }
    if (rawDefinition.token !== undefined && typeof rawDefinition.token !== "string") {
      throw new Error(`backend ${alias} token must be a string`);
    }
    if (
      rawDefinition.tokenEnv !== undefined &&
      (typeof rawDefinition.tokenEnv !== "string" ||
        !TOKEN_ENV_PATTERN.test(rawDefinition.tokenEnv))
    ) {
      throw new Error(`backend ${alias} tokenEnv must be an environment variable name`);
    }
    if (rawDefinition.token !== undefined && rawDefinition.tokenEnv !== undefined) {
      throw new Error(`backend ${alias} must configure token or tokenEnv, not both`);
    }
    if (!Array.isArray(rawDefinition.allowedClassifications) ||
        !rawDefinition.allowedClassifications.length) {
      throw new Error(`backend ${alias} must declare allowedClassifications`);
    }
    const allowedClassifications = [
      ...new Set(
        rawDefinition.allowedClassifications.map((classification, index) =>
          parseClassification(classification, `backend ${alias} allowedClassifications[${index}]`)
        )
      )
    ];
    const timeoutMs =
      rawDefinition.timeoutMs === undefined ? 90_000 : rawDefinition.timeoutMs;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `backend ${alias} timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`
      );
    }
    const token =
      typeof rawDefinition.token === "string"
        ? rawDefinition.token
        : typeof rawDefinition.tokenEnv === "string"
          ? environment[rawDefinition.tokenEnv]
          : undefined;
    if (rawDefinition.tokenEnv && !token) {
      throw new Error(`backend ${alias} token environment variable is not set`);
    }
    if (endpoint.protocol === "http:" && !loopback && !token) {
      throw new Error(
        `backend ${alias} private HTTP endpoint requires a bearer token`
      );
    }
    backends[alias] = {
      endpoint: endpoint.toString(),
      token,
      allowedClassifications,
      timeoutMs,
      allowPrivateHttp:
        endpoint.protocol === "http:" && !loopback
          ? true
          : undefined
    };
  }

  const routes: Partial<Record<RoutableReviewProfile, string>> = {};
  for (const [profile, alias] of Object.entries(value.routes)) {
    if (!ROUTABLE_PROFILES.includes(profile as RoutableReviewProfile)) {
      throw new Error(`unsupported review profile route ${profile}`);
    }
    if (typeof alias !== "string" || !backends[alias]) {
      throw new Error(`review profile ${profile} references an unknown backend alias`);
    }
    routes[profile as RoutableReviewProfile] = alias;
  }

  return {
    protocolVersion: "guardian.review.v1",
    backends,
    routes
  };
}

export class ReviewBackendRegistry {
  private readonly config: AdminBackendRegistryConfig;

  constructor(
    input: string | AdminBackendRegistryConfig,
    environment: AdminEnvironment = process.env
  ) {
    this.config = parseAdminBackendRegistry(input, environment);
  }

  static fromAdministrativeEnvironment(
    environment: AdminEnvironment = process.env,
    legacy?: { endpoint?: string; token?: string }
  ): ReviewBackendRegistry | undefined {
    const serialized =
      environment.GUARDIAN_REVIEW_REGISTRY_JSON ??
      environment.GUARDIAN_MODEL_BACKEND_REGISTRY;
    if (serialized) return new ReviewBackendRegistry(serialized, environment);
    if (!legacy?.endpoint) return undefined;
    return new ReviewBackendRegistry(
      {
        protocolVersion: "guardian.review.v1",
        backends: {
          default: {
            endpoint: legacy.endpoint,
            token: legacy.token,
            allowedClassifications: ["public", "private"],
            timeoutMs: 90_000
          }
        },
        routes: {
          "routine-review": "default",
          "high-risk-review": "default",
          "benchmark-review": "default"
        }
      },
      environment
    );
  }

  hasRoute(profile: ReviewProfile): boolean {
    return ROUTABLE_PROFILES.includes(profile as RoutableReviewProfile) &&
      Boolean(this.config.routes[profile as RoutableReviewProfile]);
  }

  resolve(
    profile: ReviewProfile,
    classification: DataClassification
  ): ResolvedReviewBackend | undefined {
    if (!ROUTABLE_PROFILES.includes(profile as RoutableReviewProfile)) return undefined;
    const alias = this.config.routes[profile as RoutableReviewProfile];
    if (!alias) return undefined;
    const backend = this.config.backends[alias];
    if (!backend || !backend.allowedClassifications.includes(classification)) return undefined;
    return {
      alias,
      allowedClassifications: [...backend.allowedClassifications],
      client: new GuardianReviewClient({
        id: alias,
        baseUrl: backend.endpoint,
        authSecret: backend.token,
        allowedClassifications: [...backend.allowedClassifications],
        timeoutMs: backend.timeoutMs ?? 90_000
      })
    };
  }
}
