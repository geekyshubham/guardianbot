import {
  createGitHubOidcVerifier,
  GitHubOidcVerificationError,
  type GitHubOidcClaims,
  type GitHubOidcVerifier
} from "./github-oidc.js";
import type { Store } from "./store.js";

/**
 * Deployed-digest rescan target. A scheduled GuardianBot run asks the control plane which exact
 * digest is running in an environment; the answer comes only from accepted server-side
 * deployment and signature evidence, never from a tag or workflow input. The endpoint is
 * read-only and never touches the running deployment.
 */
export const IMAGE_RESCAN_OIDC_AUDIENCE = "guardianbot-image-rescan";
export const IMAGE_RESCAN_WORKFLOW_PATH = ".github/workflows/reusable-image-rescan.yml";
export const IMAGE_RESCAN_JOB_ENVIRONMENT = "guardianbot-image-rescan";
const CALLER_WORKFLOW_PATH = ".github/workflows/guardianbot.yml";

export interface ImageRescanRepositoryAuthorization {
  fullName: string;
  defaultBranch: string;
}

export interface ImageRescanTargetRequest {
  schemaVersion: "1.0.0";
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  environment: string;
}

export interface ImageRescanTargetResponse {
  schemaVersion: "1.0.0";
  environment: string;
  imageDigest: string;
  imageReference: string;
  certificateIdentity: string;
  deploymentRunId: number;
  deploymentRunAttempt: number;
  deploymentHeadSha: string;
  deployedAt: string;
}

export interface ImageRescanTargetService {
  resolve(
    authorizationHeader: string | undefined,
    request: unknown
  ): Promise<ImageRescanTargetResponse>;
}

export class ImageRescanTargetError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 503
  ) {
    super(message);
  }
}

interface ImageRescanTargetServiceOptions {
  store: Store;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  oidcVerifier?: GitHubOidcVerifier;
  authorizeRepository: (
    repository: string,
    repositoryId: number
  ) => Promise<ImageRescanRepositoryAuthorization | undefined>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function exactSha(value: unknown, label: string): string {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an exact commit SHA`);
  }
  return normalized;
}

function numericOidcClaim(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid`);
  return positiveSafeInteger(Number(value), label);
}

function parseRequest(value: unknown): ImageRescanTargetRequest {
  const request = asRecord(value);
  if (!request) throw new Error("image rescan request must be an object");
  const allowed = new Set([
    "schemaVersion",
    "repository",
    "repositoryId",
    "runId",
    "runAttempt",
    "headSha",
    "environment"
  ]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new Error("image rescan request contains unsupported fields");
  }
  if (request.schemaVersion !== "1.0.0") {
    throw new Error("image rescan request schemaVersion is invalid");
  }
  // Same slug rule as image.deployment.environment in the repository configuration.
  if (
    typeof request.environment !== "string" ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(request.environment)
  ) {
    throw new Error("environment is invalid");
  }
  return {
    schemaVersion: "1.0.0",
    repository: normalizeRepository(request.repository, "repository"),
    repositoryId: positiveSafeInteger(request.repositoryId, "repositoryId"),
    runId: positiveSafeInteger(request.runId, "runId"),
    runAttempt: positiveSafeInteger(request.runAttempt, "runAttempt"),
    headSha: exactSha(request.headSha, "headSha"),
    environment: request.environment
  };
}

function parseWorkflowRef(
  value: string,
  label: string,
  exactRef: boolean
): { repository: string; workflowPath: string; ref: string } {
  const match = (
    exactRef
      ? /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@([a-f0-9]{40})$/i
      : /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@(.+)$/
  ).exec(value);
  if (!match) throw new Error(`${label} is invalid`);
  return {
    repository: normalizeRepository(match[1], `${label} repository`),
    workflowPath: match[2]!,
    ref: exactRef ? exactSha(match[3], `${label} SHA`) : match[3]!
  };
}

/**
 * Same identity class as /dast/session: the token must come from a GitHub-hosted, scheduled
 * default-branch run of the repository's own guardianbot.yml calling the approved rescan release
 * inside the protected guardianbot-image-rescan job environment.
 */
function validateOidcIdentity(
  oidc: GitHubOidcClaims,
  request: ImageRescanTargetRequest,
  repository: ImageRescanRepositoryAuthorization,
  trustedRepository: string,
  trustedWorkflowSha: string
): void {
  const defaultRef = `refs/heads/${repository.defaultBranch}`;
  const jobWorkflow = parseWorkflowRef(oidc.job_workflow_ref, "OIDC job_workflow_ref", true);
  const callerWorkflow = parseWorkflowRef(
    String(oidc.workflow_ref ?? ""),
    "OIDC workflow_ref",
    false
  );
  if (
    normalizeRepository(oidc.repository, "OIDC repository") !== request.repository ||
    normalizeRepository(repository.fullName, "authorized repository") !== request.repository ||
    numericOidcClaim(oidc.repository_id, "OIDC repository_id") !== request.repositoryId ||
    numericOidcClaim(oidc.run_id, "OIDC run_id") !== request.runId ||
    numericOidcClaim(oidc.run_attempt, "OIDC run_attempt") !== request.runAttempt ||
    exactSha(oidc.sha, "OIDC sha") !== request.headSha ||
    exactSha(oidc.workflow_sha, "OIDC workflow_sha") !== request.headSha ||
    oidc.ref !== defaultRef ||
    oidc.event_name !== "schedule" ||
    oidc.runner_environment !== "github-hosted" ||
    callerWorkflow.repository !== request.repository ||
    callerWorkflow.workflowPath !== CALLER_WORKFLOW_PATH ||
    callerWorkflow.ref !== defaultRef ||
    jobWorkflow.repository !== trustedRepository ||
    jobWorkflow.workflowPath !== IMAGE_RESCAN_WORKFLOW_PATH ||
    jobWorkflow.ref !== trustedWorkflowSha ||
    (oidc.job_workflow_sha !== undefined &&
      exactSha(oidc.job_workflow_sha, "OIDC job_workflow_sha") !== trustedWorkflowSha) ||
    oidc.environment !== IMAGE_RESCAN_JOB_ENVIRONMENT ||
    oidc.sub.toLowerCase() !==
      `repo:${request.repository}:environment:${IMAGE_RESCAN_JOB_ENVIRONMENT}`
  ) {
    throw new Error(
      "OIDC repository, workflow, ref, event, runner, or environment identity is not authorized"
    );
  }
}

/** Trusted rescan release SHA; defaults to the image workflow SHA shipped in the same release. */
export function trustedImageRescanWorkflowSha(
  environment: Record<string, string | undefined>
): string {
  return exactSha(
    environment.GUARDIANBOT_TRUSTED_IMAGE_RESCAN_WORKFLOW_SHA ??
      environment.GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA ??
      environment.GUARDIANBOT_TRUSTED_WORKFLOW_SHA,
    "GUARDIANBOT_TRUSTED_IMAGE_RESCAN_WORKFLOW_SHA"
  );
}

export function createImageRescanTargetService(
  options: ImageRescanTargetServiceOptions
): ImageRescanTargetService {
  const environment = options.environment ?? process.env;
  const trustedRepository = normalizeRepository(
    environment.GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY ?? "geekyshubham/guardianbot",
    "GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY"
  );
  const trustedWorkflowSha = trustedImageRescanWorkflowSha(environment);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const oidcVerifier =
    options.oidcVerifier ??
    createGitHubOidcVerifier({
      audience: IMAGE_RESCAN_OIDC_AUDIENCE,
      fetchImpl,
      now
    });

  return {
    async resolve(
      authorizationHeader: string | undefined,
      requestValue: unknown
    ): Promise<ImageRescanTargetResponse> {
      const bearer = authorizationHeader?.match(/^Bearer ([^\s]+)$/)?.[1];
      if (!bearer) {
        throw new ImageRescanTargetError("GitHub OIDC bearer token is required", 401);
      }
      let request: ImageRescanTargetRequest;
      try {
        request = parseRequest(requestValue);
      } catch {
        throw new ImageRescanTargetError("image rescan request is invalid", 400);
      }
      const repository = await options.authorizeRepository(
        request.repository,
        request.repositoryId
      );
      if (!repository) {
        throw new ImageRescanTargetError("repository is not active in GuardianBot", 403);
      }
      try {
        const oidc = await oidcVerifier.verify(bearer);
        validateOidcIdentity(
          oidc,
          request,
          repository,
          trustedRepository,
          trustedWorkflowSha
        );
      } catch (error) {
        if (error instanceof GitHubOidcVerificationError) {
          throw new ImageRescanTargetError(error.message, error.statusCode);
        }
        throw new ImageRescanTargetError("GitHub OIDC identity is not authorized", 401);
      }
      let deployed;
      try {
        deployed = await options.store.getLatestDeployedImageEvidence(
          request.repositoryId,
          request.environment,
          repository.defaultBranch
        );
      } catch {
        throw new ImageRescanTargetError("deployed image evidence is unavailable", 503);
      }
      if (
        !deployed ||
        !/^sha256:[a-f0-9]{64}$/.test(deployed.imageDigest) ||
        !deployed.imageReference.endsWith(`@${deployed.imageDigest}`) ||
        !deployed.certificateIdentity.toLowerCase().startsWith(
          `https://github.com/${trustedRepository}/.github/workflows/reusable-image.yml@`
        )
      ) {
        // Fail closed: without accepted, signature-bound deployment evidence there is no digest
        // the rescan may target.
        throw new ImageRescanTargetError(
          "no accepted signed deployment exists for this repository environment",
          404
        );
      }
      return {
        schemaVersion: "1.0.0",
        environment: deployed.environment,
        imageDigest: deployed.imageDigest,
        imageReference: deployed.imageReference,
        certificateIdentity: deployed.certificateIdentity,
        deploymentRunId: deployed.runId,
        deploymentRunAttempt: deployed.runAttempt,
        deploymentHeadSha: deployed.headSha,
        deployedAt: deployed.observedAt
      };
    }
  };
}
