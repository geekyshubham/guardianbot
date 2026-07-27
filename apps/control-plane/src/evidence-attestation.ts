import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";

export const EVIDENCE_OIDC_AUDIENCE = "guardianbot-evidence";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
const DEFAULT_PROVENANCE_TTL_SECONDS = 31 * 24 * 60 * 60;
const MAX_PROVENANCE_TTL_SECONDS = 31 * 24 * 60 * 60;
const JWKS_CACHE_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 30;

export type EvidenceArtifactType =
  | "security"
  | "image-validation"
  | "image-promotion"
  | "dast";

export interface TrustedEvidenceWorkflow {
  artifactType: EvidenceArtifactType;
  workflowPath: string;
  sha: string;
}

export interface EvidenceTrustPolicy {
  repository: string;
  signingSecret: string;
  tokenTtlSeconds: number;
  workflows: Record<EvidenceArtifactType, TrustedEvidenceWorkflow>;
}

export interface EvidenceManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface EvidenceManifest {
  schemaVersion: "1.0.0";
  artifactType: EvidenceArtifactType;
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  workflowPath: string;
  workflowSha: string;
  files: EvidenceManifestFile[];
}

export interface EvidenceAttestationRequest {
  schemaVersion: "1.0.0";
  artifactType: EvidenceArtifactType;
  manifestDigest: string;
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
}

export interface EvidenceProvenanceClaims {
  version: 1;
  artifactType: EvidenceArtifactType;
  manifestDigest: string;
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  jobWorkflowRef: string;
  workflowPath: string;
  workflowSha: string;
  issuedAt: number;
  expiresAt: number;
}

export interface EvidenceAttestationResponse {
  schemaVersion: "1.0.0";
  token: string;
  expiresAt: string;
}

export interface EvidenceAttestationService {
  attest(
    authorizationHeader: string | undefined,
    request: unknown
  ): Promise<EvidenceAttestationResponse>;
}

export class EvidenceAttestationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 429 | 503
  ) {
    super(message);
  }
}

interface EvidenceAttestationServiceOptions {
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  authorizeRepository?: (
    repository: string,
    repositoryId: number
  ) => Promise<boolean>;
}

interface GitHubOidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  repository: string;
  repository_id: string;
  run_id: string;
  run_attempt: string;
  sha: string;
  sub: string;
  environment?: string;
  job_workflow_ref: string;
  job_workflow_sha?: string;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface OidcJsonWebKey extends NodeJsonWebKey {
  alg?: string;
  kid?: string;
  use?: string;
}

interface JsonWebKeySet {
  keys?: OidcJsonWebKey[];
}

const WORKFLOW_PATHS: Record<EvidenceArtifactType, string> = {
  security: ".github/workflows/reusable-security.yml",
  "image-validation": ".github/workflows/reusable-image.yml",
  "image-promotion": ".github/workflows/reusable-image.yml",
  dast: ".github/workflows/reusable-dast.yml"
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  pattern?: RegExp
): string {
  const value = record[field];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireSafePositiveInteger(
  record: Record<string, unknown>,
  field: string
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function normalizeRepository(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(normalized)) {
    throw new Error("repository is invalid");
  }
  return normalized;
}

function parseArtifactType(value: unknown): EvidenceArtifactType {
  if (
    value !== "security" &&
    value !== "image-validation" &&
    value !== "image-promotion" &&
    value !== "dast"
  ) {
    throw new Error("artifactType is invalid");
  }
  return value;
}

function requireSha(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${field} must be an exact 40-character commit SHA`);
  }
  return normalized;
}

function configuredWorkflowSha(
  env: Record<string, string | undefined>,
  specificName: string
): string {
  const value = env[specificName] ?? env.GUARDIANBOT_TRUSTED_WORKFLOW_SHA;
  if (!value) {
    throw new Error(
      `${specificName} or GUARDIANBOT_TRUSTED_WORKFLOW_SHA is required`
    );
  }
  return requireSha(value, specificName);
}

export function parseEvidenceTrustPolicy(
  env: Record<string, string | undefined>
): EvidenceTrustPolicy {
  const repository = normalizeRepository(
    env.GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY ?? "geekyshubham/guardianbot"
  );
  const signingSecret = env.GUARDIANBOT_EVIDENCE_SIGNING_SECRET;
  if (!signingSecret || Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error(
      "GUARDIANBOT_EVIDENCE_SIGNING_SECRET must contain at least 32 bytes"
    );
  }
  const securitySha = configuredWorkflowSha(
    env,
    "GUARDIANBOT_TRUSTED_SECURITY_WORKFLOW_SHA"
  );
  const imageSha = configuredWorkflowSha(
    env,
    "GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA"
  );
  const dastSha = configuredWorkflowSha(
    env,
    "GUARDIANBOT_TRUSTED_DAST_WORKFLOW_SHA"
  );
  const configuredTtl = env.GUARDIANBOT_EVIDENCE_TOKEN_TTL_SECONDS
    ? Number(env.GUARDIANBOT_EVIDENCE_TOKEN_TTL_SECONDS)
    : DEFAULT_PROVENANCE_TTL_SECONDS;
  if (
    !Number.isSafeInteger(configuredTtl) ||
    configuredTtl < 60 ||
    configuredTtl > MAX_PROVENANCE_TTL_SECONDS
  ) {
    throw new Error(
      `GUARDIANBOT_EVIDENCE_TOKEN_TTL_SECONDS must be between 60 and ${MAX_PROVENANCE_TTL_SECONDS}`
    );
  }
  return {
    repository,
    signingSecret,
    tokenTtlSeconds: configuredTtl,
    workflows: {
      security: {
        artifactType: "security",
        workflowPath: WORKFLOW_PATHS.security,
        sha: securitySha
      },
      "image-validation": {
        artifactType: "image-validation",
        workflowPath: WORKFLOW_PATHS["image-validation"],
        sha: imageSha
      },
      "image-promotion": {
        artifactType: "image-promotion",
        workflowPath: WORKFLOW_PATHS["image-promotion"],
        sha: imageSha
      },
      dast: {
        artifactType: "dast",
        workflowPath: WORKFLOW_PATHS.dast,
        sha: dastSha
      }
    }
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = asRecord(value);
  if (!record) throw new Error("canonical JSON contains an unsupported value");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function parseEvidenceManifest(value: unknown): EvidenceManifest {
  const root = asRecord(value);
  if (!root || root.schemaVersion !== "1.0.0") {
    throw new Error("provenance manifest schemaVersion is invalid");
  }
  const artifactType = parseArtifactType(root.artifactType);
  const repository = normalizeRepository(
    requireString(root, "repository")
  );
  const filesValue = root.files;
  if (!Array.isArray(filesValue) || filesValue.length === 0 || filesValue.length > 16) {
    throw new Error("provenance manifest files are invalid");
  }
  const files = filesValue.map((value) => {
    const file = asRecord(value);
    if (!file) throw new Error("provenance manifest file is invalid");
    const path = requireString(file, "path", /^[A-Za-z0-9._-]+$/);
    const sha256 = requireString(file, "sha256", /^[a-f0-9]{64}$/);
    const size = requireSafePositiveInteger(file, "size");
    return { path, sha256: sha256.toLowerCase(), size };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("provenance manifest contains duplicate files");
  }
  const sortedFiles = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  if (files.some((file, index) => file.path !== sortedFiles[index]?.path)) {
    throw new Error("provenance manifest files must be sorted");
  }
  return {
    schemaVersion: "1.0.0",
    artifactType,
    repository,
    repositoryId: requireSafePositiveInteger(root, "repositoryId"),
    runId: requireSafePositiveInteger(root, "runId"),
    runAttempt: requireSafePositiveInteger(root, "runAttempt"),
    headSha: requireSha(requireString(root, "headSha"), "headSha"),
    workflowPath: requireString(
      root,
      "workflowPath",
      /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/
    ),
    workflowSha: requireSha(
      requireString(root, "workflowSha"),
      "workflowSha"
    ),
    files
  };
}

export function computeEvidenceManifestDigest(manifest: EvidenceManifest): string {
  const parsed = parseEvidenceManifest(manifest);
  return `sha256:${createHash("sha256")
    .update(canonicalJson(parsed), "utf8")
    .digest("hex")}`;
}

function parseAttestationRequest(value: unknown): EvidenceAttestationRequest {
  const root = asRecord(value);
  if (!root || root.schemaVersion !== "1.0.0") {
    throw new EvidenceAttestationError("schemaVersion is invalid", 400);
  }
  try {
    return {
      schemaVersion: "1.0.0",
      artifactType: parseArtifactType(root.artifactType),
      manifestDigest: requireString(
        root,
        "manifestDigest",
        /^sha256:[a-f0-9]{64}$/
      ).toLowerCase(),
      repository: normalizeRepository(requireString(root, "repository")),
      repositoryId: requireSafePositiveInteger(root, "repositoryId"),
      runId: requireSafePositiveInteger(root, "runId"),
      runAttempt: requireSafePositiveInteger(root, "runAttempt"),
      headSha: requireSha(requireString(root, "headSha"), "headSha")
    };
  } catch (error) {
    throw new EvidenceAttestationError(
      error instanceof Error ? error.message : String(error),
      400
    );
  }
}

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeJsonSegment(value: string, label: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384) {
    throw new EvidenceAttestationError(`${label} is invalid`, 401);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new EvidenceAttestationError(`${label} is invalid`, 401);
  }
}

function numericClaim(
  claims: Record<string, unknown>,
  name: string
): number {
  const value = claims[name];
  const numberValue =
    typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue) || Number(numberValue) <= 0) {
    throw new EvidenceAttestationError(`OIDC ${name} claim is invalid`, 401);
  }
  return Number(numberValue);
}

function parseOidcClaims(value: Record<string, unknown>): GitHubOidcClaims {
  const aud = value.aud;
  if (
    typeof aud !== "string" &&
    (!Array.isArray(aud) || aud.some((entry) => typeof entry !== "string"))
  ) {
    throw new EvidenceAttestationError("OIDC aud claim is invalid", 401);
  }
  const exp = numericClaim(value, "exp");
  const iat = numericClaim(value, "iat");
  const nbf = value.nbf === undefined ? undefined : numericClaim(value, "nbf");
  return {
    iss: String(value.iss ?? ""),
    aud: aud as string | string[],
    exp,
    iat,
    nbf,
    repository: String(value.repository ?? ""),
    repository_id: String(value.repository_id ?? ""),
    run_id: String(value.run_id ?? ""),
    run_attempt: String(value.run_attempt ?? ""),
    sha: String(value.sha ?? ""),
    sub: String(value.sub ?? ""),
    environment:
      value.environment === undefined ? undefined : String(value.environment),
    job_workflow_ref: String(value.job_workflow_ref ?? ""),
    job_workflow_sha:
      value.job_workflow_sha === undefined
        ? undefined
        : String(value.job_workflow_sha)
  };
}

function parseJobWorkflowRef(
  value: string
): { repository: string; workflowPath: string; sha: string } {
  const match = value.match(
    /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@([a-f0-9]{40})$/i
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new EvidenceAttestationError(
      "OIDC job_workflow_ref is not pinned to an exact SHA",
      401
    );
  }
  return {
    repository: normalizeRepository(match[1]),
    workflowPath: match[2],
    sha: match[3].toLowerCase()
  };
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("JSON response exceeded its size limit");
  }
  if (!response.body) throw new Error("JSON response body is missing");
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("JSON response exceeded its size limit");
    }
    chunks.push(value);
  }
  return JSON.parse(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  );
}

function signClaims(
  claims: EvidenceProvenanceClaims,
  signingSecret: string
): string {
  const payload = encodeBase64Url(canonicalJson(claims));
  const signature = createHmac("sha256", signingSecret)
    .update(`gbp1.${payload}`, "utf8")
    .digest();
  return `gbp1.${payload}.${encodeBase64Url(signature)}`;
}

export function createEvidenceProvenanceToken(
  claims: EvidenceProvenanceClaims,
  signingSecret: string
): string {
  if (Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error("evidence signing secret must contain at least 32 bytes");
  }
  return signClaims(claims, signingSecret);
}

export function verifyEvidenceProvenanceToken(
  token: string,
  signingSecret: string,
  now = new Date()
): EvidenceProvenanceClaims {
  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    segments[0] !== "gbp1" ||
    !segments[1] ||
    !segments[2] ||
    !/^[A-Za-z0-9_-]+$/.test(segments[2]) ||
    token.length > 16_384
  ) {
    throw new Error("evidence provenance token is invalid");
  }
  const expected = createHmac("sha256", signingSecret)
    .update(`gbp1.${segments[1]}`, "utf8")
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(segments[2], "base64url");
  } catch {
    throw new Error("evidence provenance token is invalid");
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error("evidence provenance token signature is invalid");
  }
  const root = decodeJsonSegment(segments[1], "evidence provenance token");
  const artifactType = parseArtifactType(root.artifactType);
  if (root.version !== 1) {
    throw new Error("evidence provenance token version is invalid");
  }
  const claims: EvidenceProvenanceClaims = {
    version: 1,
    artifactType,
    manifestDigest: requireString(
      root,
      "manifestDigest",
      /^sha256:[a-f0-9]{64}$/
    ).toLowerCase(),
    repository: normalizeRepository(requireString(root, "repository")),
    repositoryId: requireSafePositiveInteger(root, "repositoryId"),
    runId: requireSafePositiveInteger(root, "runId"),
    runAttempt: requireSafePositiveInteger(root, "runAttempt"),
    headSha: requireSha(requireString(root, "headSha"), "headSha"),
    jobWorkflowRef: requireString(root, "jobWorkflowRef"),
    workflowPath: requireString(root, "workflowPath"),
    workflowSha: requireSha(requireString(root, "workflowSha"), "workflowSha"),
    issuedAt: requireSafePositiveInteger(root, "issuedAt"),
    expiresAt: requireSafePositiveInteger(root, "expiresAt")
  };
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (claims.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("evidence provenance token was issued in the future");
  }
  if (claims.expiresAt <= nowSeconds) {
    throw new Error("evidence provenance token has expired");
  }
  if (
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_PROVENANCE_TTL_SECONDS
  ) {
    throw new Error("evidence provenance token lifetime is invalid");
  }
  return claims;
}

export function createEvidenceAttestationService(
  options: EvidenceAttestationServiceOptions = {}
): EvidenceAttestationService {
  const env = options.environment ?? process.env;
  const policy = parseEvidenceTrustPolicy(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  let cachedKeys:
    | { expiresAt: number; keys: OidcJsonWebKey[] }
    | undefined;
  const recentAttestations: number[] = [];

  async function loadJwks(forceRefresh = false): Promise<OidcJsonWebKey[]> {
    const current = now().getTime();
    if (!forceRefresh && cachedKeys && cachedKeys.expiresAt > current) {
      return cachedKeys.keys;
    }
    let response: Response;
    try {
      response = await fetchImpl(GITHUB_OIDC_JWKS_URL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new EvidenceAttestationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    if (!response.ok) {
      throw new EvidenceAttestationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    let document: JsonWebKeySet;
    try {
      document = (await readBoundedJsonResponse(
        response,
        256 * 1024
      )) as JsonWebKeySet;
    } catch {
      throw new EvidenceAttestationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    const keys = Array.isArray(document.keys)
      ? document.keys.filter(
          (key) =>
            key &&
            key.kty === "RSA" &&
            typeof key.kid === "string" &&
            key.kid.length > 0 &&
            (!key.use || key.use === "sig") &&
            (!key.alg || key.alg === "RS256")
        )
      : [];
    if (!keys.length) {
      throw new EvidenceAttestationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    cachedKeys = { expiresAt: current + JWKS_CACHE_MS, keys };
    return keys;
  }

  async function verifyOidcToken(token: string): Promise<GitHubOidcClaims> {
    if (token.length > 32_768) {
      throw new EvidenceAttestationError("OIDC token is invalid", 401);
    }
    const segments = token.split(".");
    if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
      throw new EvidenceAttestationError("OIDC token is invalid", 401);
    }
    const headerRecord = decodeJsonSegment(segments[0], "OIDC header");
    const header: JwtHeader = {
      alg: String(headerRecord.alg ?? ""),
      kid: String(headerRecord.kid ?? ""),
      typ:
        headerRecord.typ === undefined ? undefined : String(headerRecord.typ)
    };
    if (
      header.alg !== "RS256" ||
      !header.kid ||
      (header.typ !== undefined && header.typ !== "JWT")
    ) {
      throw new EvidenceAttestationError("OIDC header is invalid", 401);
    }
    let keys = await loadJwks();
    let jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
      keys = await loadJwks(true);
      jwk = keys.find((candidate) => candidate.kid === header.kid);
    }
    if (!jwk) throw new EvidenceAttestationError("OIDC signing key is unknown", 401);
    let verified = false;
    try {
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      verified = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"),
        publicKey,
        Buffer.from(segments[2], "base64url")
      );
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new EvidenceAttestationError("OIDC signature is invalid", 401);
    }
    const claims = parseOidcClaims(
      decodeJsonSegment(segments[1], "OIDC claims")
    );
    const nowSeconds = Math.floor(now().getTime() / 1_000);
    if (
      claims.iss !== GITHUB_OIDC_ISSUER ||
      !(Array.isArray(claims.aud)
        ? claims.aud.includes(EVIDENCE_OIDC_AUDIENCE)
        : claims.aud === EVIDENCE_OIDC_AUDIENCE) ||
      claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS ||
      claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
      (claims.nbf !== undefined && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 10 * 60 ||
      !claims.sub
    ) {
      throw new EvidenceAttestationError("OIDC claims are invalid or expired", 401);
    }
    return claims;
  }

  return {
    async attest(
      authorizationHeader: string | undefined,
      requestValue: unknown
    ): Promise<EvidenceAttestationResponse> {
      const requestTime = now().getTime();
      while (
        recentAttestations.length &&
        recentAttestations[0]! <= requestTime - 60_000
      ) {
        recentAttestations.shift();
      }
      if (recentAttestations.length >= 120) {
        throw new EvidenceAttestationError(
          "evidence attestation rate limit exceeded",
          429
        );
      }
      recentAttestations.push(requestTime);
      const match = authorizationHeader?.match(/^Bearer ([^\s]+)$/);
      if (!match?.[1]) {
        throw new EvidenceAttestationError("GitHub OIDC bearer token is required", 401);
      }
      const request = parseAttestationRequest(requestValue);
      const oidc = await verifyOidcToken(match[1]);
      const workflow = policy.workflows[request.artifactType];
      const jobWorkflow = parseJobWorkflowRef(oidc.job_workflow_ref);
      const oidcRepository = normalizeRepository(oidc.repository);
      if (
        oidcRepository !== request.repository ||
        numericClaim(oidc as unknown as Record<string, unknown>, "repository_id") !==
          request.repositoryId ||
        numericClaim(oidc as unknown as Record<string, unknown>, "run_id") !==
          request.runId ||
        numericClaim(oidc as unknown as Record<string, unknown>, "run_attempt") !==
          request.runAttempt ||
        requireSha(oidc.sha, "OIDC sha") !== request.headSha
      ) {
        throw new EvidenceAttestationError(
          "OIDC repository or workflow-run identity does not match the manifest",
          401
        );
      }
      const normalizedSubject = oidc.sub.toLowerCase();
      const promotionSubject =
        `repo:${request.repository}:environment:guardianbot-image-promotion`;
      const dastSubject =
        `repo:${request.repository}:environment:guardianbot-dast`;
      if (
        (request.artifactType === "image-promotion" &&
          (oidc.environment !== "guardianbot-image-promotion" ||
            normalizedSubject !== promotionSubject)) ||
        (request.artifactType === "image-validation" &&
          (oidc.environment === "guardianbot-image-promotion" ||
            normalizedSubject === promotionSubject)) ||
        (request.artifactType === "dast" &&
          (oidc.environment !== "guardianbot-dast" ||
            normalizedSubject !== dastSubject))
      ) {
        throw new EvidenceAttestationError(
          "OIDC job environment is not authorized for this artifact type",
          401
        );
      }
      if (
        options.authorizeRepository &&
        !(await options.authorizeRepository(
          request.repository,
          request.repositoryId
        ))
      ) {
        throw new EvidenceAttestationError(
          "repository is not active in GuardianBot",
          403
        );
      }
      if (
        jobWorkflow.repository !== policy.repository ||
        jobWorkflow.workflowPath !== workflow.workflowPath ||
        jobWorkflow.sha !== workflow.sha ||
        (oidc.job_workflow_sha !== undefined &&
          requireSha(oidc.job_workflow_sha, "OIDC job_workflow_sha") !==
            workflow.sha)
      ) {
        throw new EvidenceAttestationError(
          "OIDC job workflow is not an approved GuardianBot release",
          401
        );
      }
      const issuedAt = Math.floor(now().getTime() / 1_000);
      const claims: EvidenceProvenanceClaims = {
        version: 1,
        artifactType: request.artifactType,
        manifestDigest: request.manifestDigest,
        repository: request.repository,
        repositoryId: request.repositoryId,
        runId: request.runId,
        runAttempt: request.runAttempt,
        headSha: request.headSha,
        jobWorkflowRef:
          `${policy.repository}/${workflow.workflowPath}@${workflow.sha}`,
        workflowPath: workflow.workflowPath,
        workflowSha: workflow.sha,
        issuedAt,
        expiresAt: issuedAt + policy.tokenTtlSeconds
      };
      return {
        schemaVersion: "1.0.0",
        token: signClaims(claims, policy.signingSecret),
        expiresAt: new Date(claims.expiresAt * 1_000).toISOString()
      };
    }
  };
}
