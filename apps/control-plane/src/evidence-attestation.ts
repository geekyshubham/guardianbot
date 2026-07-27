import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import {
  createGitHubOidcVerifier,
  GitHubOidcVerificationError
} from "./github-oidc.js";

export const EVIDENCE_OIDC_AUDIENCE = "guardianbot-evidence";
const DEFAULT_PROVENANCE_TTL_SECONDS = 31 * 24 * 60 * 60;
const MAX_PROVENANCE_TTL_SECONDS = 31 * 24 * 60 * 60;
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
  const oidcVerifier = createGitHubOidcVerifier({
    audience: EVIDENCE_OIDC_AUDIENCE,
    fetchImpl,
    now
  });
  const recentAttestations: number[] = [];

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
      let oidc;
      try {
        oidc = await oidcVerifier.verify(match[1]);
      } catch (error) {
        if (error instanceof GitHubOidcVerificationError) {
          throw new EvidenceAttestationError(
            error.message,
            error.statusCode
          );
        }
        throw error;
      }
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
