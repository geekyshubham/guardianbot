import {
  GuardianReviewClient,
  type DataClassification,
  type RemediationValidationRequest,
  type RemediationValidationResult
} from "@guardianbot/protocol";

/** The veto-only second validator a deployment may configure for Mode C drafts. */
export interface RemediationValidator {
  allowedClassifications: readonly DataClassification[];
  validateRemediation(
    request: RemediationValidationRequest,
    signal?: AbortSignal
  ): Promise<RemediationValidationResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Reads the optional second validator from control-plane environment only. Unset URL means no
 * second validator. A set but malformed configuration throws at startup rather than silently
 * running without the veto the operator asked for.
 */
export function remediationValidatorFromEnvironment(
  environment: Record<string, string | undefined>
): RemediationValidator | undefined {
  const raw = environment.GUARDIANBOT_REMEDIATION_VALIDATOR_URL?.trim();
  if (!raw) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("GUARDIANBOT_REMEDIATION_VALIDATOR_URL must be an absolute URL");
  }
  const loopback = isLoopbackHost(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("GUARDIANBOT_REMEDIATION_VALIDATOR_URL must use HTTPS outside loopback");
  }
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error(
      "GUARDIANBOT_REMEDIATION_VALIDATOR_URL must not contain credentials, a query or a fragment"
    );
  }
  const token = environment.GUARDIANBOT_REMEDIATION_VALIDATOR_TOKEN?.trim() || undefined;
  if (!token && !loopback) {
    throw new Error("GUARDIANBOT_REMEDIATION_VALIDATOR_TOKEN is required for a non-loopback validator");
  }
  const classifications = (environment.GUARDIANBOT_REMEDIATION_VALIDATOR_CLASSIFICATIONS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!classifications.length) {
    throw new Error("GUARDIANBOT_REMEDIATION_VALIDATOR_CLASSIFICATIONS must list allowed classifications");
  }
  const allowedClassifications = [...new Set(classifications)].map((value) => {
    if (value === "public" || value === "private" || value === "restricted") return value;
    throw new Error("GUARDIANBOT_REMEDIATION_VALIDATOR_CLASSIFICATIONS contains an invalid classification");
  });
  const rawTimeout = environment.GUARDIANBOT_REMEDIATION_VALIDATOR_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `GUARDIANBOT_REMEDIATION_VALIDATOR_TIMEOUT_MS must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`
    );
  }
  const client = new GuardianReviewClient({
    id: "remediation-validator",
    baseUrl: endpoint.toString(),
    authSecret: token,
    allowedClassifications,
    timeoutMs
  });
  return {
    allowedClassifications,
    validateRemediation: (request, signal) => client.validateRemediation(request, signal)
  };
}
