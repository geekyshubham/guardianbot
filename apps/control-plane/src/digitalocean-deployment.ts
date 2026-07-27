import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedJsonResponse } from "./github-oidc.js";
import type { Store } from "./store.js";

const DIGITALOCEAN_API_ORIGIN = "https://api.digitalocean.com";
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_DOCUMENT_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const FAILED_DEPLOYMENT_PHASES = new Set([
  "ERROR",
  "CANCELED",
  "SUPERSEDED"
]);

interface DigitalOceanDeploymentProfile {
  id: string;
  repository: string;
  repositoryId: number;
  appId: string;
  appName: string;
  serviceNames: string[];
  imageName: string;
  environment: string;
  origin: string;
  healthPath: string;
  readinessPath?: string;
  apiTokenEnv: string;
  timeoutSeconds: number;
}

export interface DigitalOceanPromotionInput {
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  imageReference: string;
}

export interface DigitalOceanPromotionResult {
  profileId: string;
  appId: string;
  deploymentId: string;
  environment: string;
  origin: string;
  imageDigest: string;
  updated: boolean;
  observedAt: string;
}

export interface DigitalOceanDeploymentService {
  promote(
    input: DigitalOceanPromotionInput
  ): Promise<DigitalOceanPromotionResult | undefined>;
}

export class DigitalOceanDeploymentError extends Error {
  constructor(
    message: string,
    readonly environment: string
  ) {
    super(message);
  }
}

interface DigitalOceanDeploymentOptions {
  store: Store;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function onlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function safeSlug(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function repositorySlug(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function environmentKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactUuid(value: unknown, label: string): string {
  const normalized = String(value ?? "").toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function exactSha(value: unknown, label: string): string {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function privateOrLocalHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  const octets = value.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255
    )
  ) {
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return (
    /^f[cd][0-9a-f]:/i.test(value) ||
    /^fe[89ab][0-9a-f]:/i.test(value)
  );
}

function exactPublicHttpsOrigin(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error(`${label} is invalid`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    privateOrLocalHost(url.hostname)
  ) {
    throw new Error(`${label} must be an exact public HTTPS origin`);
  }
  return url.origin;
}

function requestPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    !/^\/(?!\/)[^\s?#]*$/.test(value)
  ) {
    throw new Error(`${label} must be an origin-relative path`);
  }
  return value;
}

function parseProfile(
  id: string,
  value: unknown,
  environment: Record<string, string | undefined>
): DigitalOceanDeploymentProfile {
  safeSlug(id, "DigitalOcean deployment profile id");
  const profile = asRecord(value);
  if (!profile) {
    throw new Error(`DigitalOcean deployment profile ${id} must be an object`);
  }
  onlyKeys(
    profile,
    [
      "repository",
      "repositoryId",
      "appId",
      "appName",
      "serviceNames",
      "imageName",
      "environment",
      "origin",
      "healthPath",
      "readinessPath",
      "apiTokenEnv",
      "timeoutSeconds"
    ],
    `DigitalOcean deployment profile ${id}`
  );
  if (
    !Array.isArray(profile.serviceNames) ||
    profile.serviceNames.length < 1 ||
    profile.serviceNames.length > 10 ||
    profile.serviceNames.some(
      (name) =>
        typeof name !== "string" ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(name)
    ) ||
    new Set(profile.serviceNames).size !== profile.serviceNames.length
  ) {
    throw new Error(
      `DigitalOcean deployment profile ${id} serviceNames is invalid`
    );
  }
  const imageName = String(profile.imageName ?? "").toLowerCase();
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(imageName)) {
    throw new Error(
      `DigitalOcean deployment profile ${id} imageName is invalid`
    );
  }
  const apiTokenEnv = environmentKey(
    profile.apiTokenEnv,
    `DigitalOcean deployment profile ${id} apiTokenEnv`
  );
  const token = environment[apiTokenEnv];
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 512 ||
    /\s/.test(token)
  ) {
    throw new Error(
      `DigitalOcean deployment profile ${id} API token is unavailable`
    );
  }
  const timeoutSeconds = positiveSafeInteger(
    profile.timeoutSeconds ?? 600,
    `DigitalOcean deployment profile ${id} timeoutSeconds`
  );
  if (timeoutSeconds < 60 || timeoutSeconds > 900) {
    throw new Error(
      `DigitalOcean deployment profile ${id} timeoutSeconds must be between 60 and 900`
    );
  }
  return {
    id,
    repository: repositorySlug(
      profile.repository,
      `DigitalOcean deployment profile ${id} repository`
    ),
    repositoryId: positiveSafeInteger(
      profile.repositoryId,
      `DigitalOcean deployment profile ${id} repositoryId`
    ),
    appId: exactUuid(
      profile.appId,
      `DigitalOcean deployment profile ${id} appId`
    ),
    appName: safeSlug(
      profile.appName,
      `DigitalOcean deployment profile ${id} appName`
    ),
    serviceNames: [...profile.serviceNames] as string[],
    imageName,
    environment: safeSlug(
      profile.environment,
      `DigitalOcean deployment profile ${id} environment`
    ),
    origin: exactPublicHttpsOrigin(
      profile.origin,
      `DigitalOcean deployment profile ${id} origin`
    ),
    healthPath: requestPath(
      profile.healthPath,
      `DigitalOcean deployment profile ${id} healthPath`
    ),
    readinessPath:
      profile.readinessPath === undefined
        ? undefined
        : requestPath(
            profile.readinessPath,
            `DigitalOcean deployment profile ${id} readinessPath`
          ),
    apiTokenEnv,
    timeoutSeconds
  };
}

function parseProfiles(
  environment: Record<string, string | undefined>
): Map<number, DigitalOceanDeploymentProfile> {
  const raw =
    environment.GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON ?? "{}";
  if (Buffer.byteLength(raw, "utf8") > MAX_PROFILE_DOCUMENT_BYTES) {
    throw new Error(
      "GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON exceeds its size limit"
    );
  }
  const root = asRecord(JSON.parse(raw));
  if (!root) {
    throw new Error(
      "GUARDIANBOT_DIGITALOCEAN_DEPLOYMENTS_JSON must be an object"
    );
  }
  const profiles = new Map<number, DigitalOceanDeploymentProfile>();
  for (const [id, value] of Object.entries(root)) {
    const profile = parseProfile(id, value, environment);
    if (profiles.has(profile.repositoryId)) {
      throw new Error(
        `repository ${profile.repositoryId} has multiple DigitalOcean deployment profiles`
      );
    }
    profiles.set(profile.repositoryId, profile);
  }
  return profiles;
}

function parseImageReference(
  value: string,
  expectedImage: string
): string {
  const match = /^([^@]+)@(sha256:[a-f0-9]{64})$/.exec(value.toLowerCase());
  if (!match || match[1] !== expectedImage) {
    throw new Error("promotion image does not match the deployment profile");
  }
  return match[2]!;
}

function appFromResponse(
  value: unknown,
  profile: DigitalOceanDeploymentProfile
): Record<string, unknown> {
  const app = asRecord(asRecord(value)?.app);
  const spec = asRecord(app?.spec);
  if (
    !app ||
    app.id !== profile.appId ||
    !spec ||
    spec.name !== profile.appName
  ) {
    throw new Error("DigitalOcean returned an unexpected app");
  }
  validateTargetServices(spec, profile);
  return app;
}

function validateTargetServices(
  spec: Record<string, unknown>,
  profile: DigitalOceanDeploymentProfile
): Record<string, unknown>[] {
  const services = Array.isArray(spec.services)
    ? spec.services
        .map((service) => asRecord(service))
        .filter(
          (service): service is Record<string, unknown> => Boolean(service)
        )
    : [];
  const targets = profile.serviceNames.map((name) =>
    services.find((service) => service.name === name)
  );
  if (targets.some((service) => !service)) {
    throw new Error("DigitalOcean app is missing an approved service");
  }
  for (const service of targets as Record<string, unknown>[]) {
    const image = asRecord(service.image);
    if (
      !image ||
      image.registry_type !== "GHCR" ||
      String(image.registry ?? "").toLowerCase() !==
        profile.imageName.split("/")[1] ||
      String(image.repository ?? "").toLowerCase() !==
        profile.imageName.split("/")[2]
    ) {
      throw new Error(
        "DigitalOcean app service uses an unexpected image source"
      );
    }
  }
  return targets as Record<string, unknown>[];
}

function deploymentUsesDigest(
  deployment: unknown,
  profile: DigitalOceanDeploymentProfile,
  imageDigest: string
): deployment is Record<string, unknown> {
  const record = asRecord(deployment);
  const spec = asRecord(record?.spec);
  if (!record || record.phase !== "ACTIVE" || !spec) return false;
  try {
    return validateTargetServices(spec, profile).every((service) => {
      const image = asRecord(service.image);
      return image?.digest === imageDigest && image.tag === undefined;
    });
  } catch {
    return false;
  }
}

function updatedAppSpec(
  app: Record<string, unknown>,
  profile: DigitalOceanDeploymentProfile,
  imageDigest: string
): Record<string, unknown> {
  const original = asRecord(app.spec);
  if (!original) throw new Error("DigitalOcean app spec is unavailable");
  const spec = structuredClone(original);
  const targets = validateTargetServices(spec, profile);
  for (const service of targets) {
    const image = asRecord(service.image);
    if (!image) throw new Error("DigitalOcean app image is unavailable");
    image.digest = imageDigest;
    delete image.tag;
  }
  return spec;
}

function deploymentId(value: unknown): string | undefined {
  const id = asRecord(value)?.id;
  if (typeof id !== "string") return undefined;
  try {
    return exactUuid(id, "DigitalOcean deployment id");
  } catch {
    return undefined;
  }
}

function deploymentLeaseKey(
  profile: DigitalOceanDeploymentProfile
): string {
  return createHash("sha256")
    .update(
      [
        "guardianbot-digitalocean-deployment-v1",
        profile.repositoryId,
        profile.environment,
        profile.appId
      ].join("\u241f")
    )
    .digest("hex");
}

export function createDigitalOceanDeploymentService(
  options: DigitalOceanDeploymentOptions
): DigitalOceanDeploymentService {
  const environment = options.environment ?? process.env;
  const profiles = parseProfiles(environment);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 60_000
  ) {
    throw new Error("DigitalOcean deployment poll interval is invalid");
  }

  async function requestJson(
    profile: DigitalOceanDeploymentProfile,
    method: "GET" | "PUT",
    path: string,
    body?: unknown,
    deadlineAt?: number
  ): Promise<unknown> {
    const token = environment[profile.apiTokenEnv]!;
    const requestTimeoutMs =
      deadlineAt === undefined
        ? DEFAULT_REQUEST_TIMEOUT_MS
        : Math.min(
            DEFAULT_REQUEST_TIMEOUT_MS,
            Math.max(1, deadlineAt - Date.now())
          );
    let response: Response;
    try {
      response = await fetchImpl(
        new URL(path, DIGITALOCEAN_API_ORIGIN),
        {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" })
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(requestTimeoutMs)
        }
      );
    } catch {
      throw new DigitalOceanDeploymentError(
        "DigitalOcean deployment API is unavailable",
        profile.environment
      );
    }
    if (!response.ok) {
      throw new DigitalOceanDeploymentError(
        "DigitalOcean deployment API refused the request",
        profile.environment
      );
    }
    try {
      return await readBoundedJsonResponse(
        response,
        MAX_API_RESPONSE_BYTES
      );
    } catch {
      throw new DigitalOceanDeploymentError(
        "DigitalOcean deployment API returned invalid output",
        profile.environment
      );
    }
  }

  async function probe(
    profile: DigitalOceanDeploymentProfile,
    path: string
  ): Promise<void> {
    const url = new URL(path, profile.origin);
    if (url.origin !== profile.origin) {
      throw new DigitalOceanDeploymentError(
        "DigitalOcean staging probe escaped its approved origin",
        profile.environment
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json, text/plain;q=0.9" },
        redirect: "error",
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new DigitalOceanDeploymentError(
        "DigitalOcean staging health probe is unavailable",
        profile.environment
      );
    }
    if (!response.ok) {
      throw new DigitalOceanDeploymentError(
        "DigitalOcean staging health probe failed",
        profile.environment
      );
    }
    await response.body?.cancel().catch(() => undefined);
  }

  return {
    async promote(
      input: DigitalOceanPromotionInput
    ): Promise<DigitalOceanPromotionResult | undefined> {
      const profile = profiles.get(input.repositoryId);
      if (!profile) return undefined;
      try {
        if (
          repositorySlug(input.repository, "promotion repository") !==
            profile.repository ||
          input.repositoryId !== profile.repositoryId
        ) {
          throw new Error("promotion repository does not match its profile");
        }
        positiveSafeInteger(input.runId, "promotion runId");
        positiveSafeInteger(input.runAttempt, "promotion runAttempt");
        exactSha(input.headSha, "promotion headSha");
      } catch {
        throw new DigitalOceanDeploymentError(
          "DigitalOcean promotion input is invalid",
          profile.environment
        );
      }
      let imageDigest: string;
      try {
        imageDigest = parseImageReference(
          input.imageReference,
          profile.imageName
        );
      } catch {
        throw new DigitalOceanDeploymentError(
          "Promoted image is not approved for this DigitalOcean profile",
          profile.environment
        );
      }

      const leasedAt = now();
      const leaseId = randomUUID();
      const deploymentKey = deploymentLeaseKey(profile);
      const claimed = await options.store.claimDeploymentPromotion({
        deploymentKey,
        leaseId,
        repositoryId: input.repositoryId,
        environment: profile.environment,
        imageDigest,
        runId: input.runId,
        runAttempt: input.runAttempt,
        leasedAt: leasedAt.toISOString(),
        leaseExpiresAt: new Date(
          leasedAt.getTime() +
            (profile.timeoutSeconds + 60) * 1_000
        ).toISOString()
      });
      if (!claimed) {
        throw new DigitalOceanDeploymentError(
          "Another DigitalOcean promotion is already in progress",
          profile.environment
        );
      }

      const deadlineAt = Date.now() + profile.timeoutSeconds * 1_000;
      try {
        let document = await requestJson(
          profile,
          "GET",
          `/v2/apps/${profile.appId}`,
          undefined,
          deadlineAt
        );
        let app: Record<string, unknown>;
        try {
          app = appFromResponse(document, profile);
        } catch {
          throw new DigitalOceanDeploymentError(
            "DigitalOcean app identity or image source is not approved",
            profile.environment
          );
        }
        let active = app.active_deployment;
        let updated = false;
        if (!deploymentUsesDigest(active, profile, imageDigest)) {
          const inProgress = asRecord(app.in_progress_deployment);
          const inProgressSpec = asRecord(inProgress?.spec);
          const inProgressUsesDigest =
            inProgressSpec !== undefined &&
            validateTargetServices(inProgressSpec, profile).every(
              (service) => asRecord(service.image)?.digest === imageDigest
            );
          if (!inProgressUsesDigest) {
            await requestJson(
              profile,
              "PUT",
              `/v2/apps/${profile.appId}`,
              { spec: updatedAppSpec(app, profile, imageDigest) },
              deadlineAt
            );
            updated = true;
          }

          const maximumPolls = Math.ceil(
            (profile.timeoutSeconds * 1_000) / pollIntervalMs
          );
          let completed = false;
          for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
            const remainingBeforeSleep = deadlineAt - Date.now();
            if (remainingBeforeSleep <= 0) break;
            await sleep(Math.min(pollIntervalMs, remainingBeforeSleep));
            if (Date.now() >= deadlineAt) break;
            document = await requestJson(
              profile,
              "GET",
              `/v2/apps/${profile.appId}`,
              undefined,
              deadlineAt
            );
            app = appFromResponse(document, profile);
            active = app.active_deployment;
            if (deploymentUsesDigest(active, profile, imageDigest)) {
              completed = true;
              break;
            }
            const phase = String(
              asRecord(app.in_progress_deployment)?.phase ?? ""
            ).toUpperCase();
            if (FAILED_DEPLOYMENT_PHASES.has(phase)) {
              throw new DigitalOceanDeploymentError(
                "DigitalOcean staging deployment failed",
                profile.environment
              );
            }
          }
          if (!completed) {
            throw new DigitalOceanDeploymentError(
              "DigitalOcean staging deployment timed out",
              profile.environment
            );
          }
        }

        const id = deploymentId(active);
        if (!id) {
          throw new DigitalOceanDeploymentError(
            "DigitalOcean active deployment identity is invalid",
            profile.environment
          );
        }
        await probe(profile, profile.healthPath);
        if (profile.readinessPath) {
          await probe(profile, profile.readinessPath);
        }
        return {
          profileId: profile.id,
          appId: profile.appId,
          deploymentId: id,
          environment: profile.environment,
          origin: profile.origin,
          imageDigest,
          updated,
          observedAt: now().toISOString()
        };
      } catch (error) {
        if (error instanceof DigitalOceanDeploymentError) {
          throw error;
        }
        throw new DigitalOceanDeploymentError(
          "DigitalOcean deployment state is invalid",
          profile.environment
        );
      } finally {
        await options.store
          .releaseDeploymentPromotion(deploymentKey, leaseId)
          .catch(() => false);
      }
    }
  };
}
