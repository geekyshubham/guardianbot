import { createHash, randomUUID } from "node:crypto";
import {
  createGitHubOidcVerifier,
  GitHubOidcVerificationError,
  readBoundedJsonResponse,
  type GitHubOidcClaims,
  type GitHubOidcVerifier
} from "./github-oidc.js";
import type { Store, SuccessfulDeploymentEvidence } from "./store.js";

export const DAST_SESSION_OIDC_AUDIENCE = "guardianbot-dast-session";
const DAST_WORKFLOW_PATH = ".github/workflows/reusable-dast.yml";
const CALLER_WORKFLOW_PATH = ".github/workflows/guardianbot.yml";
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_EXCHANGE_RESPONSE_BYTES = 16 * 1024;
const LEASE_MS = 30_000;
const MAX_CREDENTIAL_BYTES = 8 * 1024;
const MAX_STATIC_LIFETIME_MS = 24 * 60 * 60_000;

type DastProfileMode = "exchange" | "static";

interface CommonDastProfile {
  id: string;
  mode: DastProfileMode;
  repository: string;
  repositoryId: number;
  origin: string;
  deploymentEnvironment: string;
  sessionAssertionPath: string;
  headerName: string;
  ttlSeconds: number;
}

interface ExchangeDastProfile extends CommonDastProfile {
  mode: "exchange";
  exchangeUrl: string;
  exchangeCredentialEnv: string;
}

interface StaticDastProfile extends CommonDastProfile {
  mode: "static";
  credentialEnv: string;
  credentialExpiresAt: string;
  pocStaticCredential: true;
}

type DastProfile = ExchangeDastProfile | StaticDastProfile;

export interface DastSessionRepositoryAuthorization {
  fullName: string;
  defaultBranch: string;
}

export interface DastSessionRequest {
  schemaVersion: "1.0.0";
  profileRef: string;
  origin: string;
  sessionAssertionPath: string;
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
}

export interface DastSessionResponse {
  schemaVersion: "1.0.0";
  origin: string;
  deploymentEnvironment: string;
  deployedDigest: string;
  sessionAssertionPath: string;
  headerName: string;
  headerValue: string;
  expiresAt: string;
  assurance: "target-exchanged" | "poc-static";
}

export interface DastSessionService {
  issue(
    authorizationHeader: string | undefined,
    request: unknown
  ): Promise<DastSessionResponse>;
}

export class DastSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 409 | 502 | 503
  ) {
    super(message);
  }
}

interface DastSessionServiceOptions {
  store: Store;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  oidcVerifier?: GitHubOidcVerifier;
  authorizeRepository: (
    repository: string,
    repositoryId: number
  ) => Promise<DastSessionRepositoryAuthorization | undefined>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) {
    throw new Error(`${label} contains unsupported fields: ${extra.join(", ")}`);
  }
}

function normalizeRepository(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
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
    !/^[a-z][a-z0-9-]{0,62}$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an exact commit SHA`);
  }
  return normalized;
}

function profileReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^control-plane:\/\/profiles\/[A-Za-z0-9._/-]+$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("profileRef is invalid");
  }
  return value.slice("control-plane://profiles/".length);
}

function safeRequestPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    !/^\/(?!\/)[^\s?#]*$/.test(value) ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be an origin-relative path`);
  }
  return value;
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
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
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

function exactExchangeUrl(value: unknown, origin: string): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("exchangeUrl is invalid");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname === "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("exchangeUrl must be a same-origin HTTPS path without query or credentials");
  }
  return url.href;
}

function safeHeaderName(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) {
    throw new Error("headerName is invalid");
  }
  const normalized = value.trim();
  const allowed =
    /^(?:Authorization|Cookie)$/i.test(normalized) ||
    (/^X-[A-Za-z0-9-]+$/.test(normalized) &&
      !/^X-(?:Forwarded|Real-IP|Original|Rewrite|HTTP-Method)/i.test(normalized));
  if (!allowed) throw new Error("headerName is not permitted");
  return normalized;
}

function environmentKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedCredential(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseProfile(
  id: string,
  value: unknown,
  environment: Record<string, string | undefined>
): DastProfile {
  if (!/^[A-Za-z0-9._/-]+$/.test(id) || id.includes("..")) {
    throw new Error(`DAST profile id ${id} is invalid`);
  }
  const profile = asRecord(value);
  if (!profile) throw new Error(`DAST profile ${id} must be an object`);
  const mode = profile.mode;
  if (mode !== "exchange" && mode !== "static") {
    throw new Error(`DAST profile ${id} mode is invalid`);
  }
  const commonKeys = [
    "mode",
    "repository",
    "repositoryId",
    "origin",
    "deploymentEnvironment",
    "sessionAssertionPath",
    "headerName",
    "ttlSeconds"
  ];
  assertOnlyKeys(
    profile,
    mode === "exchange"
      ? [...commonKeys, "exchangeUrl", "exchangeCredentialEnv"]
      : [
          ...commonKeys,
          "credentialEnv",
          "credentialExpiresAt",
          "pocStaticCredential"
        ],
    `DAST profile ${id}`
  );
  const ttlSeconds = positiveSafeInteger(
    profile.ttlSeconds,
    `DAST profile ${id} ttlSeconds`
  );
  if (ttlSeconds < 60 || ttlSeconds > 900) {
    throw new Error(`DAST profile ${id} ttlSeconds must be between 60 and 900`);
  }
  const origin = exactPublicHttpsOrigin(profile.origin, `DAST profile ${id} origin`);
  const common: CommonDastProfile = {
    id,
    mode,
    repository: normalizeRepository(
      profile.repository,
      `DAST profile ${id} repository`
    ),
    repositoryId: positiveSafeInteger(
      profile.repositoryId,
      `DAST profile ${id} repositoryId`
    ),
    origin,
    deploymentEnvironment: safeSlug(
      profile.deploymentEnvironment,
      `DAST profile ${id} deploymentEnvironment`
    ),
    sessionAssertionPath: safeRequestPath(
      profile.sessionAssertionPath,
      `DAST profile ${id} sessionAssertionPath`
    ),
    headerName: safeHeaderName(profile.headerName),
    ttlSeconds
  };
  if (mode === "exchange") {
    const exchangeCredentialEnv = environmentKey(
      profile.exchangeCredentialEnv,
      `DAST profile ${id} exchangeCredentialEnv`
    );
    boundedCredential(
      environment[exchangeCredentialEnv],
      `DAST profile ${id} exchange credential`
    );
    return {
      ...common,
      mode,
      exchangeUrl: exactExchangeUrl(profile.exchangeUrl, origin),
      exchangeCredentialEnv
    };
  }
  if (
    profile.pocStaticCredential !== true ||
    environment.GUARDIANBOT_ALLOW_POC_STATIC_DAST !== "1"
  ) {
    throw new Error(
      `DAST profile ${id} static mode requires explicit PoC-only authorization`
    );
  }
  const credentialEnv = environmentKey(
    profile.credentialEnv,
    `DAST profile ${id} credentialEnv`
  );
  boundedCredential(
    environment[credentialEnv],
    `DAST profile ${id} static credential`
  );
  const credentialExpiresAt = String(profile.credentialExpiresAt ?? "");
  const expiry = Date.parse(credentialExpiresAt);
  if (!Number.isFinite(expiry)) {
    throw new Error(`DAST profile ${id} credentialExpiresAt is invalid`);
  }
  return {
    ...common,
    mode,
    credentialEnv,
    credentialExpiresAt: new Date(expiry).toISOString(),
    pocStaticCredential: true
  };
}

function parseProfiles(
  environment: Record<string, string | undefined>
): Map<string, DastProfile> {
  const raw = environment.GUARDIANBOT_DAST_PROFILES_JSON ?? "{}";
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new Error("GUARDIANBOT_DAST_PROFILES_JSON exceeds its size limit");
  }
  const document = JSON.parse(raw);
  const root = asRecord(document);
  if (!root) throw new Error("GUARDIANBOT_DAST_PROFILES_JSON must be an object");
  const profiles = new Map<string, DastProfile>();
  for (const [id, value] of Object.entries(root)) {
    profiles.set(id, parseProfile(id, value, environment));
  }
  return profiles;
}

function parseRequest(value: unknown): DastSessionRequest & { profileId: string } {
  const request = asRecord(value);
  if (!request) throw new Error("DAST session request must be an object");
  assertOnlyKeys(
    request,
    [
      "schemaVersion",
      "profileRef",
      "origin",
      "sessionAssertionPath",
      "repository",
      "repositoryId",
      "runId",
      "runAttempt",
      "headSha"
    ],
    "DAST session request"
  );
  if (request.schemaVersion !== "1.0.0") {
    throw new Error("DAST session request schemaVersion is invalid");
  }
  return {
    schemaVersion: "1.0.0",
    profileRef: String(request.profileRef ?? ""),
    profileId: profileReference(request.profileRef),
    origin: exactPublicHttpsOrigin(request.origin, "origin"),
    sessionAssertionPath: safeRequestPath(
      request.sessionAssertionPath,
      "sessionAssertionPath"
    ),
    repository: normalizeRepository(request.repository, "repository"),
    repositoryId: positiveSafeInteger(request.repositoryId, "repositoryId"),
    runId: positiveSafeInteger(request.runId, "runId"),
    runAttempt: positiveSafeInteger(request.runAttempt, "runAttempt"),
    headSha: exactSha(request.headSha, "headSha")
  };
}

function parseJobWorkflowRef(value: string): {
  repository: string;
  workflowPath: string;
  sha: string;
} {
  const match = /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@([a-f0-9]{40})$/i.exec(
    value
  );
  if (!match) throw new Error("OIDC job_workflow_ref is invalid");
  return {
    repository: normalizeRepository(match[1], "OIDC workflow repository"),
    workflowPath: match[2]!,
    sha: exactSha(match[3], "OIDC workflow SHA")
  };
}

function parseCallerWorkflowRef(value: string): {
  repository: string;
  workflowPath: string;
  ref: string;
} {
  const match = /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@(.+)$/.exec(value);
  if (!match) throw new Error("OIDC workflow_ref is invalid");
  return {
    repository: normalizeRepository(match[1], "OIDC caller repository"),
    workflowPath: match[2]!,
    ref: match[3]!
  };
}

function numericOidcClaim(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid`);
  return positiveSafeInteger(Number(value), label);
}

function validateOidcIdentity(
  oidc: GitHubOidcClaims,
  request: DastSessionRequest,
  repository: DastSessionRepositoryAuthorization,
  trustedRepository: string,
  trustedWorkflowSha: string
): void {
  const normalizedRepository = normalizeRepository(oidc.repository, "OIDC repository");
  const defaultRef = `refs/heads/${repository.defaultBranch}`;
  const jobWorkflow = parseJobWorkflowRef(oidc.job_workflow_ref);
  const callerWorkflow = parseCallerWorkflowRef(String(oidc.workflow_ref ?? ""));
  if (
    normalizedRepository !== request.repository ||
    normalizeRepository(repository.fullName, "authorized repository") !== request.repository ||
    numericOidcClaim(oidc.repository_id, "OIDC repository_id") !== request.repositoryId ||
    numericOidcClaim(oidc.run_id, "OIDC run_id") !== request.runId ||
    numericOidcClaim(oidc.run_attempt, "OIDC run_attempt") !== request.runAttempt ||
    exactSha(oidc.sha, "OIDC sha") !== request.headSha ||
    exactSha(oidc.workflow_sha, "OIDC workflow_sha") !== request.headSha ||
    oidc.ref !== defaultRef ||
    !["schedule", "workflow_dispatch"].includes(String(oidc.event_name ?? "")) ||
    oidc.runner_environment !== "github-hosted" ||
    callerWorkflow.repository !== request.repository ||
    callerWorkflow.workflowPath !== CALLER_WORKFLOW_PATH ||
    callerWorkflow.ref !== defaultRef ||
    jobWorkflow.repository !== trustedRepository ||
    jobWorkflow.workflowPath !== DAST_WORKFLOW_PATH ||
    jobWorkflow.sha !== trustedWorkflowSha ||
    (oidc.job_workflow_sha !== undefined &&
      exactSha(oidc.job_workflow_sha, "OIDC job_workflow_sha") !== trustedWorkflowSha) ||
    oidc.environment !== "guardianbot-dast" ||
    oidc.sub.toLowerCase() !==
      `repo:${request.repository}:environment:guardianbot-dast`
  ) {
    throw new Error("OIDC repository, workflow, ref, runner, or environment identity is not authorized");
  }
}

function issuanceKey(request: DastSessionRequest, profile: DastProfile): string {
  return createHash("sha256")
    .update(
      [
        "guardianbot-dast-session-v1",
        request.repositoryId,
        request.runId,
        request.runAttempt,
        request.headSha,
        profile.id,
        profile.origin
      ].join("\u241f")
    )
    .digest("hex");
}

async function exchangeCredential(
  profile: ExchangeDastProfile,
  request: DastSessionRequest,
  deployment: SuccessfulDeploymentEvidence,
  environment: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  now: () => Date
): Promise<{ value: string; expiresAt: string }> {
  const exchangeCredential = boundedCredential(
    environment[profile.exchangeCredentialEnv],
    "DAST exchange credential"
  );
  let response: Response;
  try {
    response = await fetchImpl(profile.exchangeUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${exchangeCredential}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schemaVersion: "1.0.0",
        purpose: "guardianbot-dast",
        repository: request.repository,
        repositoryId: request.repositoryId,
        runId: request.runId,
        runAttempt: request.runAttempt,
        headSha: request.headSha,
        deploymentEnvironment: deployment.environment,
        deployedDigest: deployment.imageDigest,
        ttlSeconds: profile.ttlSeconds
      }),
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_EXCHANGE_TIMEOUT_MS)
    });
  } catch {
    throw new DastSessionError("DAST session exchange is unavailable", 502);
  }
  if (!response.ok) {
    throw new DastSessionError("DAST session exchange was refused", 502);
  }
  let value: unknown;
  try {
    value = await readBoundedJsonResponse(response, MAX_EXCHANGE_RESPONSE_BYTES);
  } catch {
    throw new DastSessionError("DAST session exchange returned invalid output", 502);
  }
  const result = asRecord(value);
  if (!result) {
    throw new DastSessionError("DAST session exchange returned invalid output", 502);
  }
  try {
    assertOnlyKeys(result, ["schemaVersion", "credential", "expiresAt"], "exchange response");
    if (result.schemaVersion !== "1.0.0") throw new Error("schemaVersion is invalid");
    const credential = boundedCredential(result.credential, "exchange credential");
    const expiry = Date.parse(String(result.expiresAt ?? ""));
    const responseReceivedAt = now();
    const maximumExpiry =
      responseReceivedAt.getTime() + profile.ttlSeconds * 1_000;
    if (
      !Number.isFinite(expiry) ||
      expiry <= responseReceivedAt.getTime() + 30_000 ||
      expiry > maximumExpiry
    ) {
      throw new Error("exchange expiry is outside the approved TTL");
    }
    return { value: credential, expiresAt: new Date(expiry).toISOString() };
  } catch {
    throw new DastSessionError("DAST session exchange returned invalid output", 502);
  }
}

export function createDastSessionService(
  options: DastSessionServiceOptions
): DastSessionService {
  const environment = options.environment ?? process.env;
  const profiles = parseProfiles(environment);
  const trustedRepository = normalizeRepository(
    environment.GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY ??
      "geekyshubham/guardianbot",
    "GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY"
  );
  const trustedWorkflowSha = exactSha(
    environment.GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA ??
      environment.GUARDIANBOT_TRUSTED_WORKFLOW_SHA,
    "GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA"
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const oidcVerifier =
    options.oidcVerifier ??
    createGitHubOidcVerifier({
      audience: DAST_SESSION_OIDC_AUDIENCE,
      fetchImpl,
      now
    });

  return {
    async issue(
      authorizationHeader: string | undefined,
      requestValue: unknown
    ): Promise<DastSessionResponse> {
      const bearer = authorizationHeader?.match(/^Bearer ([^\s]+)$/)?.[1];
      if (!bearer) {
        throw new DastSessionError("GitHub OIDC bearer token is required", 401);
      }
      let request: DastSessionRequest & { profileId: string };
      try {
        request = parseRequest(requestValue);
      } catch {
        throw new DastSessionError("DAST session request is invalid", 400);
      }
      const profile = profiles.get(request.profileId);
      if (
        !profile ||
        profile.repository !== request.repository ||
        profile.repositoryId !== request.repositoryId ||
        profile.origin !== request.origin ||
        profile.sessionAssertionPath !== request.sessionAssertionPath
      ) {
        throw new DastSessionError("DAST session profile is not authorized", 403);
      }
      const repository = await options.authorizeRepository(
        request.repository,
        request.repositoryId
      );
      if (!repository) {
        throw new DastSessionError("repository is not active in GuardianBot", 403);
      }
      let oidc: GitHubOidcClaims;
      try {
        oidc = await oidcVerifier.verify(bearer);
        validateOidcIdentity(
          oidc,
          request,
          repository,
          trustedRepository,
          trustedWorkflowSha
        );
      } catch (error) {
        if (error instanceof GitHubOidcVerificationError) {
          throw new DastSessionError(error.message, error.statusCode);
        }
        throw new DastSessionError("GitHub OIDC identity is not authorized", 401);
      }

      const issuedAt = now();
      const key = issuanceKey(request, profile);
      const leaseId = randomUUID();
      const claimed = await options.store.claimDastSessionIssuance({
        issuanceKey: key,
        leaseId,
        repositoryId: request.repositoryId,
        runId: request.runId,
        runAttempt: request.runAttempt,
        profileId: profile.id,
        origin: profile.origin,
        leasedAt: issuedAt.toISOString(),
        leaseExpiresAt: new Date(issuedAt.getTime() + LEASE_MS).toISOString()
      });
      if (!claimed) {
        throw new DastSessionError(
          "DAST session was already issued for this workflow attempt",
          409
        );
      }

      try {
        const deployment =
          await options.store.getSuccessfulDeploymentEvidence(
            request.repositoryId,
            profile.deploymentEnvironment,
            request.headSha,
            repository.defaultBranch
          );
        if (
          !deployment ||
          deployment.origin !== profile.origin ||
          !/^sha256:[a-f0-9]{64}$/.test(deployment.imageDigest)
        ) {
          throw new DastSessionError(
            "DAST requires a successful exact-head deployment for the approved environment and origin",
            403
          );
        }
        let credential: { value: string; expiresAt: string };
        let assurance: DastSessionResponse["assurance"];
        if (profile.mode === "exchange") {
          credential = await exchangeCredential(
            profile,
            request,
            deployment,
            environment,
            fetchImpl,
            now
          );
          assurance = "target-exchanged";
        } else {
          const expiresAt = Date.parse(profile.credentialExpiresAt);
          if (
            expiresAt <= issuedAt.getTime() + 30_000 ||
            expiresAt > issuedAt.getTime() + MAX_STATIC_LIFETIME_MS
          ) {
            throw new DastSessionError(
              "PoC static DAST credential is expired or exceeds its maximum lifetime",
              503
            );
          }
          credential = {
            value: boundedCredential(
              environment[profile.credentialEnv],
              "static DAST credential"
            ),
            expiresAt: new Date(
              Math.min(
                expiresAt,
                issuedAt.getTime() + profile.ttlSeconds * 1_000
              )
            ).toISOString()
          };
          assurance = "poc-static";
        }
        const completed = await options.store.completeDastSessionIssuance(
          key,
          leaseId,
          issuedAt.toISOString(),
          credential.expiresAt
        );
        if (!completed) {
          throw new DastSessionError("DAST session issuance could not be finalized", 503);
        }
        return {
          schemaVersion: "1.0.0",
          origin: profile.origin,
          deploymentEnvironment: deployment.environment,
          deployedDigest: deployment.imageDigest,
          sessionAssertionPath: profile.sessionAssertionPath,
          headerName: profile.headerName,
          headerValue: credential.value,
          expiresAt: credential.expiresAt,
          assurance
        };
      } catch (error) {
        await options.store.releaseDastSessionIssuance(key, leaseId).catch(() => false);
        if (error instanceof DastSessionError) throw error;
        throw new DastSessionError("DAST session issuance failed", 503);
      }
    }
  };
}
