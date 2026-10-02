import {
  DefectDojoClient,
  DefectDojoError,
  resolveDefectDojoConfig,
  type DefectDojoReleaseFindings,
  type DefectDojoReleaseFindingsInput
} from "@guardianbot/defectdojo";
import {
  createGitHubOidcVerifier,
  GitHubOidcVerificationError,
  type GitHubOidcClaims,
  type GitHubOidcVerifier
} from "./github-oidc.js";
import {
  evaluateReleaseGate,
  parseReleaseGatePolicy,
  type ReleaseCandidate,
  type ReleaseDefectDojoState,
  type ReleaseGateDecision,
  type ReleaseGateEvidenceInput,
  type ReleaseGatePolicy
} from "./release-gate-policy.js";
import type {
  ImageRescanEvidence,
  ReleaseCommitScanSummary,
  Store
} from "./store.js";

export const RELEASE_GATE_OIDC_AUDIENCE = "guardianbot-release-gate";
export const RELEASE_GATE_ENVIRONMENT = "guardianbot-release-gate";
const RELEASE_GATE_WORKFLOW_PATH = ".github/workflows/reusable-release-gate.yml";
const CALLER_WORKFLOW_PATH = ".github/workflows/guardianbot.yml";
const IMAGE_WORKFLOW_PATH = ".github/workflows/reusable-image.yml";
const DEFECTDOJO_PROFILES = ["security", "image", "dast"] as const;

export interface ReleaseGateRepositoryAuthorization {
  fullName: string;
  defaultBranch: string;
}

export interface ReleaseGateRequest {
  schemaVersion: "1.0.0";
  repository: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  imageDigest: string;
  environment: string;
}

export class ReleaseGateError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 503
  ) {
    super(message);
  }
}

/** Reads DefectDojo findings for one product. Injectable so tests never call DefectDojo. */
export type ReleaseGateDefectDojoReader = (
  input: DefectDojoReleaseFindingsInput
) => Promise<DefectDojoReleaseFindings>;

export interface ReleaseGateEvaluateInput {
  candidate: ReleaseCandidate;
  /** Exact DefectDojo product name, which GuardianBot imports as the repository full name. */
  productName: string;
  defaultBranch: string;
  evidence: Omit<ReleaseGateEvidenceInput, "deployedRescan" | "candidateRescan" | "commitScan">;
}

export interface ReleaseGateEvaluator {
  evaluate(input: ReleaseGateEvaluateInput): Promise<ReleaseGateDecision>;
}

export interface ReleaseGateService {
  check(authorizationHeader: string | undefined, request: unknown): Promise<ReleaseGateDecision>;
}

interface ReleaseGateEvaluatorOptions {
  store: Store;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  defectDojoReader?: ReleaseGateDefectDojoReader;
}

interface ReleaseGateServiceOptions extends ReleaseGateEvaluatorOptions {
  oidcVerifier?: GitHubOidcVerifier;
  authorizeRepository: (
    repository: string,
    repositoryId: number
  ) => Promise<ReleaseGateRepositoryAuthorization | undefined>;
}

interface ReleaseGateConfig {
  policy: ReleaseGatePolicy;
  trustedRepository: string;
  releaseGateWorkflowSha: string;
  expectedCertificateIdentity: string;
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
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
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

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be an exact sha256 digest`);
  }
  return value;
}

function parseRequest(value: unknown): ReleaseGateRequest {
  const request = asRecord(value);
  if (!request) throw new Error("release gate request must be an object");
  assertOnlyKeys(
    request,
    [
      "schemaVersion",
      "repository",
      "repositoryId",
      "runId",
      "runAttempt",
      "headSha",
      "imageDigest",
      "environment"
    ],
    "release gate request"
  );
  if (request.schemaVersion !== "1.0.0") {
    throw new Error("release gate request schemaVersion is invalid");
  }
  return {
    schemaVersion: "1.0.0",
    repository: normalizeRepository(request.repository, "repository"),
    repositoryId: positiveSafeInteger(request.repositoryId, "repositoryId"),
    runId: positiveSafeInteger(request.runId, "runId"),
    runAttempt: positiveSafeInteger(request.runAttempt, "runAttempt"),
    headSha: exactSha(request.headSha, "headSha"),
    imageDigest: exactDigest(request.imageDigest, "imageDigest"),
    environment: safeSlug(request.environment, "environment")
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

/**
 * Same identity contract as the DAST broker: exact repository, run, attempt,
 * head SHA, default-branch caller workflow, GitHub-hosted runner, pinned
 * trusted reusable workflow, and the dedicated GitHub environment.
 */
function validateOidcIdentity(
  oidc: GitHubOidcClaims,
  request: ReleaseGateRequest,
  repository: ReleaseGateRepositoryAuthorization,
  config: ReleaseGateConfig
): void {
  const defaultRef = `refs/heads/${repository.defaultBranch}`;
  const jobWorkflow = parseJobWorkflowRef(oidc.job_workflow_ref);
  const callerWorkflow = parseCallerWorkflowRef(String(oidc.workflow_ref ?? ""));
  const eventName = String(oidc.event_name ?? "");
  if (
    normalizeRepository(oidc.repository, "OIDC repository") !== request.repository ||
    normalizeRepository(repository.fullName, "authorized repository") !== request.repository ||
    numericOidcClaim(oidc.repository_id, "OIDC repository_id") !== request.repositoryId ||
    numericOidcClaim(oidc.run_id, "OIDC run_id") !== request.runId ||
    numericOidcClaim(oidc.run_attempt, "OIDC run_attempt") !== request.runAttempt ||
    exactSha(oidc.sha, "OIDC sha") !== request.headSha ||
    exactSha(oidc.workflow_sha, "OIDC workflow_sha") !== request.headSha ||
    oidc.ref !== defaultRef ||
    // Image-promotion evidence is accepted only after its push run completes,
    // so the gate runs as a later, operator-started default-branch dispatch.
    eventName !== "workflow_dispatch" ||
    oidc.runner_environment !== "github-hosted" ||
    callerWorkflow.repository !== request.repository ||
    callerWorkflow.workflowPath !== CALLER_WORKFLOW_PATH ||
    callerWorkflow.ref !== defaultRef ||
    jobWorkflow.repository !== config.trustedRepository ||
    jobWorkflow.workflowPath !== RELEASE_GATE_WORKFLOW_PATH ||
    jobWorkflow.sha !== config.releaseGateWorkflowSha ||
    (oidc.job_workflow_sha !== undefined &&
      exactSha(oidc.job_workflow_sha, "OIDC job_workflow_sha") !==
        config.releaseGateWorkflowSha) ||
    oidc.environment !== RELEASE_GATE_ENVIRONMENT ||
    oidc.sub.toLowerCase() !==
      `repo:${request.repository}:environment:${RELEASE_GATE_ENVIRONMENT}`
  ) {
    throw new Error(
      "OIDC repository, workflow, ref, runner, or environment identity is not authorized"
    );
  }
}

function loadConfig(environment: Record<string, string | undefined>): ReleaseGateConfig {
  const trustedRepository = normalizeRepository(
    environment.GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY ?? "geekyshubham/guardianbot",
    "GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY"
  );
  const releaseGateWorkflowSha = exactSha(
    environment.GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA ??
      environment.GUARDIANBOT_TRUSTED_WORKFLOW_SHA,
    "GUARDIANBOT_TRUSTED_RELEASE_GATE_WORKFLOW_SHA"
  );
  const imageWorkflowSha = exactSha(
    environment.GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA ??
      environment.GUARDIANBOT_TRUSTED_WORKFLOW_SHA,
    "GUARDIANBOT_TRUSTED_IMAGE_WORKFLOW_SHA"
  );
  return {
    policy: parseReleaseGatePolicy(environment.GUARDIANBOT_RELEASE_GATE_POLICY_JSON),
    trustedRepository,
    releaseGateWorkflowSha,
    expectedCertificateIdentity:
      `https://github.com/${trustedRepository}/${IMAGE_WORKFLOW_PATH}@${imageWorkflowSha}`
  };
}

function defaultDefectDojoReader(
  environment: Record<string, string | undefined>,
  fetchImpl: typeof fetch | undefined,
  now: () => Date
): ReleaseGateDefectDojoReader | undefined {
  const baseUrlRef = environment.GUARDIANBOT_DEFECTDOJO_BASE_URL_REF;
  const apiTokenRef = environment.GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF;
  if (!baseUrlRef || !apiTokenRef) return undefined;
  return async (input) => {
    const config = resolveDefectDojoConfig(environment, { baseUrlRef, apiTokenRef });
    const client = new DefectDojoClient(config, {
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      now
    });
    return client.listReleaseFindings(input);
  };
}

async function readDefectDojo(
  reader: ReleaseGateDefectDojoReader | undefined,
  productName: string,
  defaultBranch: string,
  verifiedOnly: boolean
): Promise<ReleaseDefectDojoState> {
  if (!reader) return { status: "unavailable", reason: "DefectDojo is not configured" };
  try {
    const result = await reader({
      productName,
      engagementNames: DEFECTDOJO_PROFILES.map((profile) => `${defaultBranch}/${profile}`),
      verifiedOnly
    });
    if (!result.product) {
      return { status: "unavailable", reason: "DefectDojo has no product for the repository" };
    }
    return {
      status: "available",
      productId: result.product.id,
      tests: result.tests.map((test) => ({
        id: test.id,
        engagement: test.engagement,
        scan_type: test.scan_type,
        tags: test.tags
      })),
      findings: result.findings,
      acceptedFindings: result.acceptedFindings
    };
  } catch (error) {
    // Never echo DefectDojo response bodies or URLs into the decision.
    const kind = error instanceof DefectDojoError ? error.kind : "unknown";
    return { status: "unavailable", reason: `DefectDojo query failed (${kind})` };
  }
}

function rescanResult(
  rescan: ImageRescanEvidence
): NonNullable<ReleaseGateEvidenceInput["candidateRescan"]> {
  return {
    digest: rescan.imageDigest,
    environment: rescan.environment,
    observedAt: rescan.observedAt,
    criticalFindings: rescan.criticalFindings,
    frozen: rescan.frozen,
    artifactAccepted: rescan.artifactAccepted,
    ref:
      `evidence://${rescan.runId}/${rescan.runAttempt}/${rescan.artifactId}/` +
      `image-rescan:${rescan.environment}`
  };
}

/** Control-plane evidence the gate reads itself, so every caller gets the same view. */
async function readStoredEvidence(
  store: Store,
  candidate: ReleaseCandidate,
  defaultBranch: string,
  coverageRequired: boolean
): Promise<Pick<ReleaseGateEvidenceInput, "deployedRescan" | "candidateRescan" | "commitScan">> {
  const candidateRescan = await store.getLatestImageRescanEvidence(
    candidate.repositoryId,
    candidate.digest,
    defaultBranch
  );
  let deployedRescan: ReleaseGateEvidenceInput["deployedRescan"];
  if (coverageRequired) {
    const deployed = await store.getLatestDeployedImageEvidence(
      candidate.repositoryId,
      candidate.environment,
      defaultBranch
    );
    const rescan = deployed
      ? await store.getLatestImageRescanEvidence(
          candidate.repositoryId,
          deployed.imageDigest,
          defaultBranch,
          candidate.environment
        )
      : undefined;
    deployedRescan = {
      environment: candidate.environment,
      deployedDigest: deployed?.imageDigest,
      rescan: rescan && rescanResult(rescan)
    };
  }
  const scan = await store.getReleaseCommitScanEvidence(
    candidate.repositoryId,
    candidate.commit,
    defaultBranch
  );
  const summary = (key: "semgrep-summary" | "trivy-summary", value: ReleaseCommitScanSummary | undefined) =>
    scan && value
      ? {
          status: value.status,
          severities: value.severities,
          ref: `evidence://${scan.runId}/${scan.runAttempt}/${scan.artifactId}/${key}`
        }
      : undefined;
  return {
    candidateRescan: candidateRescan && rescanResult(candidateRescan),
    deployedRescan,
    commitScan: scan && {
      commit: scan.headSha,
      semgrep: summary("semgrep-summary", scan.semgrep),
      trivy: summary("trivy-summary", scan.trivy)
    }
  };
}

export function createReleaseGateEvaluator(
  options: ReleaseGateEvaluatorOptions
): ReleaseGateEvaluator {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const reader =
    options.defectDojoReader ?? defaultDefectDojoReader(environment, options.fetchImpl, now);
  return {
    async evaluate(input) {
      let config: ReleaseGateConfig;
      try {
        config = loadConfig(environment);
      } catch {
        throw new ReleaseGateError("release gate is not configured", 503);
      }
      const { candidate } = input;
      const stored = await readStoredEvidence(
        options.store,
        candidate,
        input.defaultBranch,
        config.policy.requiredEvidence.includes("deployed-rescan")
      );
      const defectDojo = await readDefectDojo(
        reader,
        input.productName,
        input.defaultBranch,
        config.policy.verifiedOnly
      );
      return evaluateReleaseGate({
        candidate,
        evidence: { ...input.evidence, ...stored },
        expectedCertificateIdentity: config.expectedCertificateIdentity,
        defectDojo,
        policy: config.policy,
        now: now()
      });
    }
  };
}

export function createReleaseGateService(
  options: ReleaseGateServiceOptions
): ReleaseGateService {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const evaluator = createReleaseGateEvaluator({ ...options, environment, now });
  const oidcVerifier =
    options.oidcVerifier ??
    createGitHubOidcVerifier({ audience: RELEASE_GATE_OIDC_AUDIENCE, fetchImpl, now });

  return {
    async check(authorizationHeader, requestValue) {
      const bearer = authorizationHeader?.match(/^Bearer ([^\s]+)$/)?.[1];
      if (!bearer) {
        throw new ReleaseGateError("GitHub OIDC bearer token is required", 401);
      }
      let request: ReleaseGateRequest;
      try {
        request = parseRequest(requestValue);
      } catch {
        throw new ReleaseGateError("release gate request is invalid", 400);
      }
      let config: ReleaseGateConfig;
      try {
        config = loadConfig(environment);
      } catch {
        throw new ReleaseGateError("release gate is not configured", 503);
      }
      const repository = await options.authorizeRepository(
        request.repository,
        request.repositoryId
      );
      if (!repository) {
        throw new ReleaseGateError("repository is not active in GuardianBot", 403);
      }
      try {
        const oidc = await oidcVerifier.verify(bearer);
        validateOidcIdentity(oidc, request, repository, config);
      } catch (error) {
        if (error instanceof GitHubOidcVerificationError) {
          throw new ReleaseGateError(error.message, error.statusCode);
        }
        throw new ReleaseGateError("GitHub OIDC identity is not authorized", 401);
      }

      let image: Awaited<ReturnType<Store["getReleaseImageEvidence"]>>;
      try {
        image = await options.store.getReleaseImageEvidence(
          request.repositoryId,
          request.headSha,
          request.imageDigest,
          repository.defaultBranch
        );
      } catch {
        throw new ReleaseGateError("release gate evidence is unavailable", 503);
      }
      const ref = (key: string) =>
        image ? `evidence://${image.runId}/${image.runAttempt}/${image.artifactId}/${key}` : "";
      try {
        return await evaluator.evaluate({
          candidate: {
            repository: request.repository,
            repositoryId: request.repositoryId,
            commit: request.headSha,
            digest: request.imageDigest,
            environment: request.environment
          },
          productName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          evidence: image
            ? {
                signature: {
                  digest: image.imageDigest,
                  certificateIdentity: image.signature.certificateIdentity,
                  ref: ref("signature")
                },
                imageScan: image.imageScan && {
                  criticalFindings: image.imageScan.criticalFindings,
                  status: image.imageScan.status,
                  ref: ref("image-trivy-summary")
                },
                sbom: image.sbom && { status: image.sbom.status, ref: ref("sbom") }
              }
            : {}
        });
      } catch (error) {
        if (error instanceof ReleaseGateError) throw error;
        throw new ReleaseGateError("release gate evaluation failed", 503);
      }
    }
  };
}
