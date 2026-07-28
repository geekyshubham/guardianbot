import { once } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  normalizeSemgrep,
  normalizeTrivy,
  stableFingerprint,
  type NormalizedFinding
} from "@guardianbot/core";
import { createAppJwt } from "./app-auth.js";
import {
  computeEvidenceManifestDigest,
  parseEvidenceManifest,
  parseEvidenceTrustPolicy,
  verifyEvidenceProvenanceToken,
  type EvidenceArtifactType,
  type EvidenceManifest,
  type EvidenceTrustPolicy
} from "./evidence-attestation.js";
import {
  createDigitalOceanDeploymentService,
  DigitalOceanDeploymentError,
  type DigitalOceanDeploymentService
} from "./digitalocean-deployment.js";
import type { GuardianScannerWorkflowRun } from "./service.js";
import type {
  ScannerArtifactRecord,
  ScannerEvidenceRecord,
  ScannerReferencedWorkflow,
  ScannerWorkflowEvent,
  ScannerWorkflowRunRecord,
  Store
} from "./store.js";

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;
const MAX_ARTIFACT_PAGES = 10;
const MAX_ARTIFACTS_PER_RUN = 150;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 64;
const MAX_FINDINGS = 500;
const ARTIFACT_NAME_TIMEOUT_MS = 60_000;
const PROVENANCE_FILES = ["provenance-manifest.json", "provenance-token.txt"] as const;
const SECURITY_REPORT_FILES = ["gate.json", "semgrep.json", "trivy.json"] as const;
const SECURITY_FILES = new Set([...SECURITY_REPORT_FILES, ...PROVENANCE_FILES]);
const IMAGE_VALIDATION_REPORT_FILES = [
  "build-digests.json",
  "policy.json",
  "sbom.cdx.json",
  "trivy-image.json"
] as const;
const IMAGE_PROMOTION_REPORT_FILES = [
  ...IMAGE_VALIDATION_REPORT_FILES,
  "cosign-verification.json",
  "promotion.json",
  "sbom-attestation-verification.json"
] as const;
const IMAGE_FILES = new Set([
  ...IMAGE_PROMOTION_REPORT_FILES,
  ...PROVENANCE_FILES
]);
const DAST_REPORT_FILES = ["scan-status.json", "zap.json"] as const;
const DAST_FILES = new Set([...DAST_REPORT_FILES, ...PROVENANCE_FILES]);

interface ScannerEvidenceHandlerOptions {
  appId: string;
  privateKey: string;
  store: Store;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  githubApiBase?: string;
  apiClientFactory?: (
    repository: { installationId: number; repositoryId: number },
    fetchImpl: typeof fetch,
    apiBase: string
  ) => Promise<GitHubApiClient>;
}

interface GitHubWorkflowRun {
  id: number;
  run_attempt: number;
  event?: string;
  run_started_at?: string | null;
  updated_at?: string | null;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch?: string | null;
  path: string;
  repository?: { id?: number; full_name?: string };
  referenced_workflows?: unknown;
}

interface GitHubArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  digest?: string;
  archive_download_url?: string;
  workflow_run?: {
    id?: number;
    repository_id?: number;
    head_repository_id?: number;
    head_branch?: string | null;
    head_sha?: string;
  };
}

interface GitHubArtifactPage {
  total_count?: number;
  artifacts?: GitHubArtifact[];
}

interface GitHubWorkflowJob {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface GitHubWorkflowJobsPage {
  total_count?: number;
  jobs?: GitHubWorkflowJob[];
}

interface ParsedReferencedWorkflow {
  path: string;
  repository: string;
  workflowPath: string;
  sha: string;
  ref?: string;
}

interface GitHubApiClient {
  requestJson<T>(method: string, path: string, body?: unknown): Promise<T>;
  downloadArtifact(owner: string, repo: string, artifactId: number): Promise<string>;
}

interface ParsedArtifactArchive {
  selectedFiles: Map<string, Uint8Array>;
}

interface ZipEntry {
  name: string;
  generalPurposeBitFlag: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface SecurityGateReport {
  schemaVersion: "1.0.0";
  mode: "advisory" | "report-only" | "enforce";
  passed: boolean;
  failures: string[];
  policyFindings: Record<string, unknown>[];
  activeSuppressions: number;
  expiredSuppressions: string[];
}

interface DefectDojoSettings {
  baseUrlRef: string;
  apiTokenRef: string;
}

interface DefectDojoModuleShape {
  DefectDojoClient: new (config: unknown) => {
    ensureImportContext(input: unknown): Promise<unknown>;
    importScan(input: unknown): Promise<unknown>;
  };
  buildDefectDojoTags(input: unknown): string[];
  resolveDefectDojoConfig(
    env: Record<string, string | undefined>,
    refs: { baseUrlRef: string; apiTokenRef: string }
  ): unknown;
}

interface DefectDojoEnsuredContext {
  engagement: { id: number };
  test?: { id: number } | null;
}

interface DefectDojoImportResultShape {
  mode: "import" | "reimport";
  testId?: number | null;
  dryRun?: true;
}

class RetryableScannerEvidenceError extends Error {
  readonly retryable = true;
}

async function loadDefectDojoModule(): Promise<DefectDojoModuleShape> {
  const moduleUrl = new URL("../../../packages/defectdojo/dist/index.js", import.meta.url);
  return (await import(moduleUrl.href)) as DefectDojoModuleShape;
}

function parseDefectDojoSettings(
  env: Record<string, string | undefined>
): DefectDojoSettings | undefined {
  const baseUrlRef = env.GUARDIANBOT_DEFECTDOJO_BASE_URL_REF;
  const apiTokenRef = env.GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF;
  if (!baseUrlRef && !apiTokenRef) return undefined;
  if (!baseUrlRef || !apiTokenRef) {
    throw new Error(
      "GUARDIANBOT_DEFECTDOJO_BASE_URL_REF and GUARDIANBOT_DEFECTDOJO_API_TOKEN_REF must be configured together"
    );
  }
  return { baseUrlRef, apiTokenRef };
}

function defectDojoEngagementDates(startedAt?: string): {
  targetStart: string;
  targetEnd: string;
} {
  if (!startedAt) {
    throw new Error("DefectDojo import requires the trusted workflow start time");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
      startedAt
    )
  ) {
    throw new Error("DefectDojo import workflow start time is invalid");
  }
  const start = new Date(startedAt);
  if (!Number.isFinite(start.getTime())) {
    throw new Error("DefectDojo import workflow start time is invalid");
  }
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return {
    targetStart: start.toISOString().slice(0, 10),
    targetEnd: end.toISOString().slice(0, 10)
  };
}

function normalizeRepository(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function artifactDigestMatches(expected: string | undefined, actualHex: string): boolean {
  return (
    typeof expected === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(expected.trim().toLowerCase()) &&
    expected.trim().toLowerCase() === `sha256:${actualHex}`
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return Number(value);
}

function scannerWorkflowEvent(value: unknown): ScannerWorkflowEvent | undefined {
  return value === "pull_request" ||
    value === "push" ||
    value === "schedule" ||
    value === "workflow_dispatch"
    ? value
    : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function parseWorkflowPath(pathValue: string): { workflowPath: string; workflowRef?: string } {
  const [workflowPath = "", workflowRef] = pathValue.split("@", 2);
  return { workflowPath, workflowRef };
}

function parseReferencedWorkflow(
  value: unknown,
  trustPolicy: EvidenceTrustPolicy
): ParsedReferencedWorkflow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const pathValue = String(record.path ?? "");
  const sha = String(record.sha ?? "").toLowerCase();
  const ref = record.ref ? String(record.ref) : undefined;
  const match = pathValue.match(
    /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(\/\.github\/workflows\/[^@]+)@([a-f0-9]{40})$/i
  );
  if (!match) return undefined;
  const repositoryPart = match[1];
  const workflowPathWithSlash = match[2];
  const workflowPath = workflowPathWithSlash?.slice(1);
  const pathShaPart = match[3];
  if (!repositoryPart || !workflowPath || !pathShaPart) return undefined;
  const repository = normalizeRepository(repositoryPart);
  const pathSha = pathShaPart.toLowerCase();
  if (repository !== trustPolicy.repository) return undefined;
  const trustedWorkflow = Object.values(trustPolicy.workflows).find(
    (workflow) => workflow.workflowPath === workflowPath && workflow.sha === pathSha
  );
  if (!trustedWorkflow) return undefined;
  if (!/^[a-f0-9]{40}$/.test(sha) || sha !== pathSha) return undefined;
  return { path: pathValue, repository, workflowPath, sha, ref };
}

function dedupeFindings(findings: readonly NormalizedFinding[]): NormalizedFinding[] {
  const seen = new Set<string>();
  const kept: NormalizedFinding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.fingerprint)) continue;
    seen.add(finding.fingerprint);
    kept.push(finding);
    if (kept.length >= MAX_FINDINGS) break;
  }
  return kept;
}

function validateSemgrepScannerReport(report: unknown): void {
  const root = asRecord(report);
  if (
    !root ||
    !Array.isArray(root.results) ||
    root.results.some((entry) => !asRecord(entry))
  ) {
    throw new Error("semgrep.json is not a complete Semgrep report");
  }
}

function validateTrivyScannerReport(
  report: unknown,
  fileName: "trivy.json" | "trivy-image.json"
): void {
  const root = asRecord(report);
  if (
    !root ||
    root.SchemaVersion !== 2 ||
    typeof root.ArtifactName !== "string" ||
    !root.ArtifactName ||
    typeof root.ArtifactType !== "string" ||
    !root.ArtifactType ||
    !Array.isArray(root.Results)
  ) {
    throw new Error(`${fileName} is not a complete Trivy report`);
  }
  for (const resultValue of root.Results) {
    const result = asRecord(resultValue);
    if (!result || typeof result.Target !== "string") {
      throw new Error(`${fileName} contains an invalid result`);
    }
    for (const key of [
      "Vulnerabilities",
      "Misconfigurations",
      "Secrets",
      "Licenses"
    ] as const) {
      const entries = result[key];
      if (
        entries !== undefined &&
        (!Array.isArray(entries) ||
          entries.some((entry) => !asRecord(entry)))
      ) {
        throw new Error(`${fileName} contains an invalid ${key} collection`);
      }
    }
  }
}

function countCriticalImageFindings(report: unknown): number {
  const root = asRecord(report);
  const results = Array.isArray(root?.Results) ? root.Results : [];
  let critical = 0;
  for (const result of results) {
    const record = asRecord(result);
    for (const key of ["Vulnerabilities", "Misconfigurations", "Secrets"] as const) {
      const entries = Array.isArray(record?.[key]) ? (record[key] as unknown[]) : [];
      for (const entry of entries) {
        if (String(asRecord(entry)?.Severity ?? "").toUpperCase() === "CRITICAL") {
          critical += 1;
        }
      }
    }
  }
  return critical;
}

function parseCycloneDxSummary(report: unknown): Record<string, unknown> {
  const root = asRecord(report);
  if (
    !root ||
    root.bomFormat !== "CycloneDX" ||
    typeof root.specVersion !== "string" ||
    !/^1\.[4-9]$/.test(root.specVersion) ||
    !Number.isSafeInteger(root.version) ||
    Number(root.version) < 1 ||
    (root.serialNumber !== undefined &&
      (typeof root.serialNumber !== "string" ||
        !/^urn:uuid:[0-9a-f-]{36}$/i.test(root.serialNumber))) ||
    (root.components !== undefined && !Array.isArray(root.components))
  ) {
    throw new Error("sbom.cdx.json is not a valid CycloneDX document");
  }
  const components = Array.isArray(root.components) ? root.components : [];
  for (const componentValue of components) {
    const component = asRecord(componentValue);
    if (
      !component ||
      typeof component.type !== "string" ||
      !component.type ||
      typeof component.name !== "string" ||
      !component.name
    ) {
      throw new Error("sbom.cdx.json contains an invalid CycloneDX component");
    }
  }
  return {
    bomFormat: root.bomFormat,
    specVersion: root.specVersion,
    version: root.version,
    serialNumber: typeof root.serialNumber === "string" ? root.serialNumber : undefined,
    componentCount: components.length
  };
}

function parseSecurityGate(report: unknown): SecurityGateReport {
  const root = asRecord(report);
  if (
    !root ||
    root.schemaVersion !== "1.0.0" ||
    (root.mode !== "advisory" &&
      root.mode !== "report-only" &&
      root.mode !== "enforce") ||
    typeof root.passed !== "boolean" ||
    !Array.isArray(root.failures) ||
    root.failures.some((failure) => typeof failure !== "string") ||
    !Array.isArray(root.policyFindings) ||
    root.policyFindings.some((finding) => !asRecord(finding)) ||
    !Number.isSafeInteger(root.activeSuppressions) ||
    Number(root.activeSuppressions) < 0 ||
    !Array.isArray(root.expiredSuppressions) ||
    root.expiredSuppressions.some((fingerprint) => typeof fingerprint !== "string")
  ) {
    throw new Error("gate.json is invalid");
  }
  return {
    schemaVersion: "1.0.0",
    mode: root.mode,
    passed: root.passed,
    failures: root.failures as string[],
    policyFindings: root.policyFindings as Record<string, unknown>[],
    activeSuppressions: Number(root.activeSuppressions),
    expiredSuppressions: root.expiredSuppressions as string[]
  };
}

function parseZapStatus(report: unknown): {
  zapExitCode: number;
  profile: "authenticated-baseline" | "authenticated-full";
  minutes: number;
  deploymentEnvironment: string;
  deployedDigest: string;
} {
  const root = asRecord(report);
  if (!root) throw new Error("scan-status.json is invalid");
  const zapExitCode = requireInteger(root.zapExitCode, "zapExitCode");
  const minutes = requireInteger(root.minutes, "minutes");
  if (
    root.schemaVersion !== "1.0.0" ||
    (root.profile !== "authenticated-baseline" &&
      root.profile !== "authenticated-full") ||
    typeof root.deploymentEnvironment !== "string" ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(root.deploymentEnvironment) ||
    typeof root.deployedDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(root.deployedDigest) ||
    minutes < 5 ||
    minutes > 45 ||
    (root.profile === "authenticated-baseline" && minutes > 15) ||
    (root.profile === "authenticated-full" && minutes < 30) ||
    zapExitCode < 0 ||
    zapExitCode > 255
  ) {
    throw new Error("scan-status.json is invalid");
  }
  return {
    zapExitCode,
    profile: root.profile,
    minutes,
    deploymentEnvironment: root.deploymentEnvironment,
    deployedDigest: root.deployedDigest
  };
}

function normalizeZapFindings(report: unknown): Array<NormalizedFinding & { count: number }> {
  const root = asRecord(report);
  const sites = Array.isArray(root?.site) ? root.site : [];
  const findings: Array<NormalizedFinding & { count: number }> = [];
  for (const site of sites) {
    const siteRecord = asRecord(site);
    const alerts = Array.isArray(siteRecord?.alerts) ? siteRecord.alerts : [];
    for (const alert of alerts) {
      const alertRecord = asRecord(alert);
      const risk = Number(alertRecord?.riskcode ?? 0);
      const severity =
        risk >= 3 ? "high" : risk === 2 ? "medium" : risk === 1 ? "low" : "info";
      const ruleId = String(alertRecord?.pluginid ?? alertRecord?.alertRef ?? "zap");
      const title = String(alertRecord?.alert ?? ruleId);
      const instances = Array.isArray(alertRecord?.instances) ? alertRecord.instances : [];
      const first = asRecord(instances[0]);
      const path = typeof first?.uri === "string" ? first.uri : undefined;
      const line = Number.isInteger(first?.line) ? Number(first?.line) : undefined;
      findings.push({
        source: "zap",
        fingerprint: stableFingerprint(["zap", ruleId, path ?? "", line ?? "", title]),
        ruleId,
        severity,
        title,
        description: String(alertRecord?.desc ?? title),
        path,
        line,
        count: instances.length || 1
      });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

function encodePayloadSummary(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

async function createGitHubApiClient(
  appId: string,
  privateKey: string,
  installationId: number,
  repositoryId: number,
  fetchImpl: typeof fetch,
  apiBase = DEFAULT_GITHUB_API_BASE
): Promise<GitHubApiClient> {
  const base = new URL(apiBase);
  const tokenResponse = await fetchImpl(
    new URL(`/app/installations/${installationId}/access_tokens`, base),
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
        "content-type": "application/json",
        "user-agent": "guardianbot/0.1",
        "x-github-api-version": "2022-11-28"
      },
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: { actions: "read", contents: "read" }
      }),
      signal: AbortSignal.timeout(DEFAULT_GITHUB_TIMEOUT_MS)
    }
  );
  if (!tokenResponse.ok) {
    throw new RetryableScannerEvidenceError(
      `GitHub installation token request failed with ${tokenResponse.status}`
    );
  }
  const tokenJson = (await tokenResponse.json()) as { token?: string };
  const token = tokenJson.token;
  if (!token) {
    throw new RetryableScannerEvidenceError("GitHub installation token response omitted token");
  }
  return {
    async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetchImpl(new URL(path, base), {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "guardianbot/0.1",
          "x-github-api-version": "2022-11-28"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_GITHUB_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new RetryableScannerEvidenceError(
          `GitHub ${method} ${path} failed with ${response.status}`
        );
      }
      return (await response.json()) as T;
    },
    async downloadArtifact(owner: string, repo: string, artifactId: number): Promise<string> {
      const tempDir = await mkdtemp(join(tmpdir(), "guardianbot-artifact-"));
      const target = join(tempDir, `${artifactId}.zip`);
      const response = await fetchImpl(
        new URL(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, base),
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "guardianbot/0.1",
            "x-github-api-version": "2022-11-28"
          },
          signal: AbortSignal.timeout(ARTIFACT_NAME_TIMEOUT_MS)
        }
      );
      if (!response.ok || !response.body) {
        await rm(tempDir, { recursive: true, force: true });
        throw new RetryableScannerEvidenceError(
          `GitHub artifact download failed with ${response.status}`
        );
      }
      let written = 0;
      const writer = createWriteStream(target, { mode: 0o600 });
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          written += value.byteLength;
          if (written > MAX_ARTIFACT_BYTES) {
            throw new Error("artifact exceeded the configured size limit");
          }
          if (!writer.write(Buffer.from(value))) {
            await once(writer, "drain");
          }
        }
        writer.end();
        await once(writer, "finish");
      } catch (error) {
        writer.destroy();
        await rm(tempDir, { recursive: true, force: true });
        throw error instanceof RetryableScannerEvidenceError
          ? error
          : new Error(`artifact download failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return target;
    }
  };
}

async function loadWorkflowRun(
  client: GitHubApiClient,
  owner: string,
  repo: string,
  runId: number
): Promise<GitHubWorkflowRun> {
  return client.requestJson("GET", `/repos/${owner}/${repo}/actions/runs/${runId}`);
}

async function listWorkflowArtifacts(
  client: GitHubApiClient,
  owner: string,
  repo: string,
  runId: number
): Promise<GitHubArtifact[]> {
  const artifacts: GitHubArtifact[] = [];
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const batch = await client.requestJson<GitHubArtifactPage>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`
    );
    const pageArtifacts = Array.isArray(batch.artifacts) ? batch.artifacts : [];
    artifacts.push(...pageArtifacts);
    if (artifacts.length > MAX_ARTIFACTS_PER_RUN) {
      throw new RetryableScannerEvidenceError("workflow run returned too many artifacts");
    }
    if (pageArtifacts.length < 100) break;
  }
  return artifacts;
}

async function listWorkflowJobs(
  client: GitHubApiClient,
  owner: string,
  repo: string,
  runId: number
): Promise<GitHubWorkflowJob[]> {
  const jobs: GitHubWorkflowJob[] = [];
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const batch = await client.requestJson<GitHubWorkflowJobsPage>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`
    );
    const pageJobs = Array.isArray(batch.jobs) ? batch.jobs : [];
    jobs.push(...pageJobs);
    if (jobs.length > MAX_ARTIFACTS_PER_RUN) {
      throw new RetryableScannerEvidenceError("workflow run returned too many jobs");
    }
    if (pageJobs.length < 100) break;
  }
  return jobs;
}

async function sha256File(zipPath: string): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(zipPath)) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_ARTIFACT_BYTES) {
      throw new Error("artifact exceeded the configured size limit");
    }
    hash.update(buffer);
  }
  return { digest: hash.digest("hex"), size };
}

async function parseArtifactArchive(
  zipPath: string,
  allowedFiles: Set<string>
): Promise<ParsedArtifactArchive> {
  const handle = await openFile(zipPath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error("artifact exceeded the configured size limit");
    }
    const tailLength = Math.min(stat.size, 66_000);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    let eocdOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocdOffset = index;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error("artifact ZIP EOCD record was not found");
    }
    const absoluteEocdOffset = stat.size - tailLength + eocdOffset;
    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    const commentLength = tail.readUInt16LE(eocdOffset + 20);
    if (
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw new Error("artifact ZIP uses unsupported multi-disk or ZIP64 metadata");
    }
    if (absoluteEocdOffset + 22 + commentLength !== stat.size) {
      throw new Error("artifact ZIP EOCD bounds are invalid");
    }
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error("artifact ZIP has too many entries");
    }
    if (
      centralDirectoryOffset + centralDirectorySize !== absoluteEocdOffset ||
      centralDirectoryOffset > stat.size ||
      centralDirectorySize > stat.size
    ) {
      throw new Error("artifact ZIP central directory exceeds archive bounds");
    }
    const centralDirectory = Buffer.alloc(centralDirectorySize);
    const centralRead = await handle.read(
      centralDirectory,
      0,
      centralDirectory.length,
      centralDirectoryOffset
    );
    if (centralRead.bytesRead !== centralDirectory.length) {
      throw new Error("artifact ZIP central directory is truncated");
    }
    const entries = new Map<string, ZipEntry>();
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > centralDirectory.length) {
        throw new Error("artifact ZIP central directory is truncated");
      }
      if (centralDirectory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error("artifact ZIP central directory entry is invalid");
      }
      const generalPurposeBitFlag = centralDirectory.readUInt16LE(cursor + 8);
      const compressionMethod = centralDirectory.readUInt16LE(cursor + 10);
      const compressedSize = centralDirectory.readUInt32LE(cursor + 20);
      const uncompressedSize = centralDirectory.readUInt32LE(cursor + 24);
      const fileNameLength = centralDirectory.readUInt16LE(cursor + 28);
      const extraLength = centralDirectory.readUInt16LE(cursor + 30);
      const commentLength = centralDirectory.readUInt16LE(cursor + 32);
      const localHeaderOffset = centralDirectory.readUInt32LE(cursor + 42);
      const variableLength = fileNameLength + extraLength + commentLength;
      if (
        fileNameLength === 0 ||
        cursor + 46 + variableLength > centralDirectory.length ||
        (generalPurposeBitFlag & ~0x0808) !== 0 ||
        (generalPurposeBitFlag & 0x0001) !== 0
      ) {
        throw new Error("artifact ZIP central directory flags or bounds are invalid");
      }
      const name = centralDirectory
        .subarray(cursor + 46, cursor + 46 + fileNameLength)
        .toString("utf8");
      cursor += 46 + variableLength;
      const normalized = posix.normalize(name.replace(/\\/g, "/"));
      if (
        name.includes("\0") ||
        normalized.startsWith("../") ||
        normalized.includes("/../") ||
        normalized.startsWith("/") ||
        normalized === ".."
      ) {
        throw new Error(`artifact ZIP entry ${name} is unsafe`);
      }
      const leaf = basename(normalized);
      if (!allowedFiles.has(leaf)) continue;
      if (entries.has(leaf)) {
        throw new Error(`artifact ZIP contains duplicate trusted file ${leaf}`);
      }
      entries.set(leaf, {
        name,
        generalPurposeBitFlag,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });
    }
    if (cursor !== centralDirectory.length) {
      throw new Error("artifact ZIP central directory length did not match");
    }
    const selectedFiles = new Map<string, Uint8Array>();
    for (const [leaf, entry] of entries) {
      if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) {
        throw new Error(`artifact ZIP entry ${leaf} exceeds the configured size limit`);
      }
      const localHeader = Buffer.alloc(30);
      if (entry.localHeaderOffset + localHeader.length > centralDirectoryOffset) {
        throw new Error(`artifact ZIP local header for ${leaf} exceeds archive bounds`);
      }
      const localRead = await handle.read(
        localHeader,
        0,
        localHeader.length,
        entry.localHeaderOffset
      );
      if (
        localRead.bytesRead !== localHeader.length ||
        localHeader.readUInt32LE(0) !== 0x04034b50
      ) {
        throw new Error(`artifact ZIP local header for ${leaf} is invalid`);
      }
      const localFlags = localHeader.readUInt16LE(6);
      const localCompressionMethod = localHeader.readUInt16LE(8);
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
      if (
        localFlags !== entry.generalPurposeBitFlag ||
        localCompressionMethod !== entry.compressionMethod ||
        localNameLength === 0 ||
        dataOffset > centralDirectoryOffset ||
        entry.compressedSize > centralDirectoryOffset - dataOffset
      ) {
        throw new Error(`artifact ZIP local header for ${leaf} did not match`);
      }
      const localName = Buffer.alloc(localNameLength);
      const localNameRead = await handle.read(
        localName,
        0,
        localName.length,
        entry.localHeaderOffset + 30
      );
      if (
        localNameRead.bytesRead !== localName.length ||
        localName.toString("utf8") !== entry.name
      ) {
        throw new Error(`artifact ZIP local filename for ${leaf} did not match`);
      }
      const compressed = Buffer.alloc(entry.compressedSize);
      const compressedRead = await handle.read(
        compressed,
        0,
        compressed.length,
        dataOffset
      );
      if (compressedRead.bytesRead !== compressed.length) {
        throw new Error(`artifact ZIP entry ${leaf} is truncated`);
      }
      let content: Buffer;
      if (entry.compressionMethod === 0) {
        content = compressed;
      } else if (entry.compressionMethod === 8) {
        content = inflateRawSync(compressed, {
          maxOutputLength: entry.uncompressedSize
        });
      } else {
        throw new Error(`artifact ZIP entry ${leaf} uses unsupported compression`);
      }
      if (content.length !== entry.uncompressedSize) {
        throw new Error(`artifact ZIP entry ${leaf} length did not match`);
      }
      selectedFiles.set(leaf, new Uint8Array(content));
    }
    return { selectedFiles };
  } finally {
    await handle.close();
  }
}

function parseJsonFile(bytes: Uint8Array, fileName: string): unknown {
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error(`${fileName} exceeds the configured JSON size limit`);
  }
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function reportFilesForArtifact(
  artifactType: EvidenceArtifactType
): readonly string[] {
  if (artifactType === "security") return SECURITY_REPORT_FILES;
  if (artifactType === "dast") return DAST_REPORT_FILES;
  if (artifactType === "image-promotion") return IMAGE_PROMOTION_REPORT_FILES;
  return IMAGE_VALIDATION_REPORT_FILES;
}

function validateArtifactProvenance(
  archive: ParsedArtifactArchive,
  artifactType: EvidenceArtifactType,
  expected: {
    repository: string;
    repositoryId: number;
    runId: number;
    runAttempt: number;
    headSha: string;
  },
  trustPolicy: EvidenceTrustPolicy,
  now: Date
): EvidenceManifest {
  const manifestBytes = archive.selectedFiles.get("provenance-manifest.json");
  const tokenBytes = archive.selectedFiles.get("provenance-token.txt");
  if (!manifestBytes || !tokenBytes) {
    throw new Error("artifact is missing its provenance manifest or token");
  }
  const manifest = parseEvidenceManifest(
    parseJsonFile(manifestBytes, "provenance-manifest.json")
  );
  const trustedWorkflow = trustPolicy.workflows[artifactType];
  if (
    manifest.artifactType !== artifactType ||
    manifest.repository !== normalizeRepository(expected.repository) ||
    manifest.repositoryId !== expected.repositoryId ||
    manifest.runId !== expected.runId ||
    manifest.runAttempt !== expected.runAttempt ||
    manifest.headSha !== expected.headSha ||
    manifest.workflowPath !== trustedWorkflow.workflowPath ||
    manifest.workflowSha !== trustedWorkflow.sha
  ) {
    throw new Error("artifact provenance manifest identity does not match the workflow run");
  }
  const expectedFiles = [...reportFilesForArtifact(artifactType)].sort();
  if (
    manifest.files.length !== expectedFiles.length ||
    manifest.files.some((file, index) => file.path !== expectedFiles[index])
  ) {
    throw new Error("artifact provenance manifest does not contain the exact report set");
  }
  for (const file of manifest.files) {
    const content = archive.selectedFiles.get(file.path);
    if (
      !content ||
      content.byteLength !== file.size ||
      createHash("sha256").update(content).digest("hex") !== file.sha256
    ) {
      throw new Error(`artifact provenance manifest does not match ${file.path}`);
    }
  }
  const manifestDigest = computeEvidenceManifestDigest(manifest);
  const token = Buffer.from(tokenBytes).toString("utf8").trim();
  const provenance = verifyEvidenceProvenanceToken(
    token,
    trustPolicy.signingSecret,
    now
  );
  if (
    provenance.artifactType !== artifactType ||
    provenance.manifestDigest !== manifestDigest ||
    provenance.repository !== manifest.repository ||
    provenance.repositoryId !== manifest.repositoryId ||
    provenance.runId !== manifest.runId ||
    provenance.runAttempt !== manifest.runAttempt ||
    provenance.headSha !== manifest.headSha ||
    provenance.workflowPath !== manifest.workflowPath ||
    provenance.workflowSha !== manifest.workflowSha ||
    provenance.jobWorkflowRef !==
      `${trustPolicy.repository}/${manifest.workflowPath}@${manifest.workflowSha}`
  ) {
    throw new Error("artifact provenance token does not match its manifest");
  }
  return manifest;
}

function summarizeFindings(findings: readonly NormalizedFinding[]): Record<string, number> {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    summary[finding.severity] += 1;
  }
  return summary;
}

async function recordEvidence(
  store: Store,
  base: Omit<ScannerEvidenceRecord, "evidenceKey" | "kind" | "source" | "status" | "observedAt">,
  record: Pick<
    ScannerEvidenceRecord,
    | "evidenceKey"
    | "kind"
    | "source"
    | "status"
    | "observedAt"
    | "digest"
    | "environment"
    | "details"
    | "fingerprint"
    | "path"
    | "line"
    | "payload"
  >
): Promise<void> {
  await store.upsertScannerEvidence({
    ...base,
    ...record,
    payload: encodePayloadSummary(record.payload)
  });
}

async function maybeImportToDefectDojo(
  store: Store,
  env: Record<string, string | undefined>,
  settings: DefectDojoSettings | undefined,
  input: {
    repositoryId: number;
    repositoryFullName: string;
    visibility: "public" | "private" | "internal";
    defaultBranch: string;
    headBranch: string;
    artifactId: number;
    runId: number;
    runAttempt: number;
    headSha: string;
    startedAt?: string;
    artifactType: string;
    scanType: string;
    fileName: string;
    report: Uint8Array;
    contentType: string;
    evidenceKey?: string;
    digest?: string;
    environment?: string;
  }
): Promise<void> {
  if (!settings) return;
  const { DefectDojoClient, buildDefectDojoTags, resolveDefectDojoConfig } =
    await loadDefectDojoModule();
  const config = resolveDefectDojoConfig(env, {
    baseUrlRef: settings.baseUrlRef,
    apiTokenRef: settings.apiTokenRef
  });
  const client = new DefectDojoClient(config);
  const profile = input.artifactType === "dast" ? "dast" : input.artifactType.startsWith("image") ? "image" : "security";
  const branch = input.headBranch;
  const isDefaultBranch = branch === input.defaultBranch;
  const engagementDates = defectDojoEngagementDates(input.startedAt);
  const tags = buildDefectDojoTags({
    repositoryId: input.repositoryId,
    repositorySlug: input.repositoryFullName,
    visibility: input.visibility,
    commitSha: input.headSha,
    workflowRunId: String(input.runId),
    workflowAttempt: String(input.runAttempt),
    branch,
    profile,
    scanType: input.scanType,
    environment: input.environment,
    imageDigest: input.digest
  });
  try {
    const ensured = (await client.ensureImportContext({
      productType: {
        name: "GitHub Repositories",
        description: "Repositories whose scanner evidence is managed by GuardianBot"
      },
      product: {
        name: input.repositoryFullName,
        description: "GuardianBot imported GitHub Actions evidence",
        tags
      },
      engagement: {
        name: `${branch}/${profile}`,
        status: "In Progress",
        targetStart: engagementDates.targetStart,
        targetEnd: engagementDates.targetEnd,
        branchTag: branch,
        buildId: `${input.runId}/${input.runAttempt}`,
        commitHash: input.headSha,
        tags
      },
      test: {
        scanType: input.scanType,
        title: `${branch}/${profile}`,
        branchTag: branch,
        buildId: `${input.runId}/${input.runAttempt}`,
        commitHash: input.headSha,
        tags
      }
    })) as DefectDojoEnsuredContext | unknown[];
    if (Array.isArray(ensured)) {
      throw new Error("DefectDojo dry-run mode is not supported for production scanner imports");
    }
    const imported = (await client.importScan({
      scanType: input.scanType,
      testTitle: `${branch}/${profile}`,
      fileName: input.fileName,
      contentType: input.contentType,
      report: input.report,
      engagementId: ensured.engagement.id,
      existingTestId: ensured.test?.id ?? undefined,
      metadata: {
        branchTag: branch,
        buildId: `${input.runId}/${input.runAttempt}`,
        commitHash: input.headSha,
        // DefectDojo reconciliation is operational health, not a mutation of the
        // already-completed GitHub gate. PR imports are isolated by head branch
        // and must never close findings from the default-branch engagement.
        closeOldFindings: isDefaultBranch,
        doNotReactivate: false,
        active: true,
        verified: true,
        tags
      }
    })) as DefectDojoImportResultShape;
    if (imported.dryRun) {
      throw new Error("DefectDojo dry-run mode is not supported for production scanner imports");
    }
    await recordEvidence(
      store,
      {
        repositoryId: input.repositoryId,
        runId: input.runId,
        runAttempt: input.runAttempt,
        artifactId: input.artifactId
      },
      {
        evidenceKey:
          input.evidenceKey ?? `defectdojo-import:${input.scanType}`,
        kind: "defectdojo-import",
        source: "defectdojo",
        status: "success",
        observedAt: new Date().toISOString(),
        digest: input.digest,
        environment: input.environment,
        details: `${input.scanType} ${imported.mode}`,
        payload: {
          mode: imported.mode,
          testId: imported.testId ?? null
        }
      }
    );
  } catch (error) {
    await recordEvidence(
      store,
      {
        repositoryId: input.repositoryId,
        runId: input.runId,
        runAttempt: input.runAttempt,
        artifactId: input.artifactId
      },
      {
        evidenceKey:
          input.evidenceKey ?? `defectdojo-import:${input.scanType}`,
        kind: "defectdojo-import",
        source: "defectdojo",
        status: "failure",
        observedAt: new Date().toISOString(),
        digest: input.digest,
        environment: input.environment,
        details: error instanceof Error ? error.message : String(error)
      }
    );
    throw new RetryableScannerEvidenceError(
      `DefectDojo import failed for ${input.scanType}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function processSecurityArtifact(
  store: Store,
  archive: ParsedArtifactArchive,
  artifact: ScannerArtifactRecord,
  run: Pick<ScannerWorkflowRunRecord, "headSha" | "headBranch" | "startedAt">,
  repositoryFullName: string,
  repositoryVisibility: "public" | "private" | "internal",
  defaultBranch: string,
  env: Record<string, string | undefined>,
  defectDojoSettings: DefectDojoSettings | undefined
): Promise<void> {
  const base = {
    repositoryId: artifact.repositoryId,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    artifactId: artifact.artifactId
  };
  const semgrepBytes = archive.selectedFiles.get("semgrep.json");
  const trivyBytes = archive.selectedFiles.get("trivy.json");
  const gateBytes = archive.selectedFiles.get("gate.json");
  if (!semgrepBytes || !trivyBytes || !gateBytes) {
    throw new Error("security evidence artifact is missing a required trusted report");
  }
  const semgrepJson = parseJsonFile(semgrepBytes, "semgrep.json");
  const trivyJson = parseJsonFile(trivyBytes, "trivy.json");
  const gateJson = parseJsonFile(gateBytes, "gate.json");
  const gate = parseSecurityGate(gateJson);
  const semgrepFailed = Boolean(asRecord(semgrepJson)?.scanner_error);
  const trivyFailed = Boolean(asRecord(trivyJson)?.scanner_error);
  if (!semgrepFailed) validateSemgrepScannerReport(semgrepJson);
  if (!trivyFailed) validateTrivyScannerReport(trivyJson, "trivy.json");
  const normalizedSemgrepFindings = semgrepFailed
    ? []
    : normalizeSemgrep(semgrepJson);
  const normalizedTrivyFindings = trivyFailed
    ? []
    : normalizeTrivy(trivyJson);
  const normalizedFingerprints = new Set(
    [...normalizedSemgrepFindings, ...normalizedTrivyFindings].map(
      (finding) => finding.fingerprint
    )
  );
  const semgrepFindings = dedupeFindings(normalizedSemgrepFindings);
  const trivyFindings = dedupeFindings(normalizedTrivyFindings);
  const policyFingerprints = gate.policyFindings.map((finding) =>
    String(finding.fingerprint ?? "")
  );
  if (
    gate.passed !== (gate.failures.length === 0) ||
    ((semgrepFailed || trivyFailed) && gate.passed) ||
    policyFingerprints.some(
      (fingerprint) =>
        !/^[a-f0-9]{64}$/.test(fingerprint) ||
        !normalizedFingerprints.has(fingerprint)
    ) ||
    new Set(policyFingerprints).size !== policyFingerprints.length
  ) {
    throw new Error(
      "gate.json does not agree with the normalized scanner evidence"
    );
  }
  await recordEvidence(store, base, {
    evidenceKey: "semgrep-summary",
    kind: "semgrep",
    source: "semgrep",
    status: semgrepFailed ? "failure" : "success",
    observedAt: new Date().toISOString(),
    details: `semgrep findings: ${semgrepFindings.length}`,
    payload: summarizeFindings(semgrepFindings)
  });
  for (const finding of semgrepFindings) {
    await recordEvidence(store, base, {
      evidenceKey: `semgrep:${finding.fingerprint}`,
      kind: "semgrep",
      source: "semgrep",
      status: "success",
      observedAt: new Date().toISOString(),
      fingerprint: finding.fingerprint,
      path: finding.path,
      line: finding.line,
      details: `${finding.severity} ${finding.ruleId}`,
      payload: {
        title: finding.title,
        description: finding.description,
        severity: finding.severity
      }
    });
  }
  await recordEvidence(store, base, {
    evidenceKey: "trivy-summary",
    kind: "trivy",
    source: "trivy",
    status: trivyFailed ? "failure" : "success",
    observedAt: new Date().toISOString(),
    details: `trivy findings: ${trivyFindings.length}`,
    payload: summarizeFindings(trivyFindings)
  });
  for (const finding of trivyFindings) {
    await recordEvidence(store, base, {
      evidenceKey: `trivy:${finding.fingerprint}`,
      kind: "trivy",
      source: "trivy",
      status: "success",
      observedAt: new Date().toISOString(),
      fingerprint: finding.fingerprint,
      path: finding.path,
      details: `${finding.severity} ${finding.ruleId}`,
      payload: {
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        packageName: finding.packageName,
        fixedVersion: finding.fixedVersion
      }
    });
  }
  await recordEvidence(store, base, {
    evidenceKey: "gate",
    kind: "security-gate",
    source: "guardianbot",
    status: gate.passed ? "success" : "failure",
    observedAt: new Date().toISOString(),
    details: gate.passed
      ? `${gate.mode} gate passed`
      : `${gate.mode} gate failed: ${gate.failures.length} failure(s)`,
    payload: {
      passed: gate.passed,
      failures: gate.failures.length,
      policyFindings: gate.policyFindings.length,
      activeSuppressions: gate.activeSuppressions,
      expiredSuppressions: gate.expiredSuppressions.length
    }
  });
  if (!semgrepFailed) {
    await maybeImportToDefectDojo(store, env, defectDojoSettings, {
      repositoryId: artifact.repositoryId,
      repositoryFullName,
      visibility: repositoryVisibility,
      defaultBranch,
      headBranch: run.headBranch ?? defaultBranch,
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha: run.headSha,
      startedAt: run.startedAt,
      artifactType: artifact.artifactType,
      scanType: "Semgrep JSON Report",
      fileName: "semgrep.json",
      report: semgrepBytes,
      contentType: "application/json"
    });
  }
  if (!trivyFailed) {
    await maybeImportToDefectDojo(store, env, defectDojoSettings, {
      repositoryId: artifact.repositoryId,
      repositoryFullName,
      visibility: repositoryVisibility,
      defaultBranch,
      headBranch: run.headBranch ?? defaultBranch,
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha: run.headSha,
      startedAt: run.startedAt,
      artifactType: artifact.artifactType,
      scanType: "Trivy Scan",
      fileName: "trivy.json",
      report: trivyBytes,
      contentType: "application/json"
    });
  }
}

function parseBuildDigestReport(report: unknown): Record<string, unknown> {
  const root = asRecord(report);
  if (
    !root ||
    root.schemaVersion !== "1.0.0" ||
    typeof root.imageId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(root.imageId) ||
    !Array.isArray(root.repoTags) ||
    root.repoTags.some((tag) => typeof tag !== "string")
  ) {
    throw new Error("build-digests.json is invalid");
  }
  return {
    imageId: root.imageId,
    repoTags: root.repoTags.length,
    promotionExpected: root.promotionExpected === true
  };
}

function parseCosignVerificationEntries(report: unknown): Record<string, unknown>[] {
  const values = Array.isArray(report) ? report : [report];
  const entries = values
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  if (!entries.length) throw new Error("cosign verification evidence is empty");
  return entries;
}

function verifyCosignSignatureEvidence(
  report: unknown,
  imageDigest: string,
  certificateIdentity: string
): number {
  const entries = parseCosignVerificationEntries(report);
  const matching = entries.filter((entry) => {
    const critical = asRecord(entry.critical);
    const image = asRecord(critical?.image);
    const optional = asRecord(entry.optional);
    return (
      image?.["docker-manifest-digest"] === imageDigest &&
      optional?.Issuer === "https://token.actions.githubusercontent.com" &&
      optional?.Subject === certificateIdentity
    );
  });
  if (!matching.length) {
    throw new Error(
      "cosign verification is not bound to the expected image digest and certificate identity"
    );
  }
  return matching.length;
}

function verifySbomAttestationEvidence(
  report: unknown,
  imageDigest: string
): number {
  const envelopes = Array.isArray(report) ? report : [report];
  let verified = 0;
  for (const envelopeValue of envelopes) {
    const envelope = asRecord(envelopeValue);
    if (!envelope || typeof envelope.payload !== "string" || !envelope.payload) continue;
    let statement: Record<string, unknown> | undefined;
    try {
      statement = asRecord(
        JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"))
      );
    } catch {
      statement = undefined;
    }
    const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
    const digestHex = imageDigest.slice("sha256:".length);
    const subjectMatches = subjects.some((subjectValue) => {
      const subject = asRecord(subjectValue);
      const digest = asRecord(subject?.digest);
      return digest?.sha256 === digestHex;
    });
    const predicate = asRecord(statement?.predicate);
    if (
      subjectMatches &&
      typeof statement?.predicateType === "string" &&
      statement.predicateType.toLowerCase().includes("cyclonedx") &&
      predicate?.bomFormat === "CycloneDX"
    ) {
      verified += 1;
    }
  }
  if (!verified) {
    throw new Error("SBOM attestation verification is missing or bound to another digest");
  }
  return verified;
}

function validatePromotionEvidence(
  archive: ParsedArtifactArchive,
  repositoryFullName: string,
  callerWorkflowPath: string,
  callerWorkflowRef: string | undefined,
  trustPolicy: EvidenceTrustPolicy
): {
  imageDigest: string;
  imageReference: string;
  certificateIdentity: string;
  signatures: number;
  sbomAttestations: number;
} {
  const promotionBytes = archive.selectedFiles.get("promotion.json");
  const cosignBytes = archive.selectedFiles.get("cosign-verification.json");
  const attestationBytes = archive.selectedFiles.get(
    "sbom-attestation-verification.json"
  );
  const sbomBytes = archive.selectedFiles.get("sbom.cdx.json");
  if (
    !promotionBytes ||
    !cosignBytes ||
    !attestationBytes ||
    !sbomBytes ||
    !callerWorkflowRef
  ) {
    throw new Error("image promotion evidence is incomplete");
  }
  const promotion = asRecord(parseJsonFile(promotionBytes, "promotion.json"));
  if (!promotion || promotion.schemaVersion !== "1.0.0") {
    throw new Error("promotion.json is invalid");
  }
  const imageDigest = String(promotion.imageDigest ?? "").toLowerCase();
  const imageReference = String(promotion.imageReference ?? "");
  const certificateIdentity = String(promotion.certificateIdentity ?? "");
  const expectedIdentity =
    `https://github.com/${repositoryFullName}/${callerWorkflowPath}@${callerWorkflowRef}`;
  const expectedJobWorkflowRef =
    `${trustPolicy.repository}/.github/workflows/reusable-image.yml@` +
    trustPolicy.workflows["image-promotion"].sha;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
    !imageReference.endsWith(`@${imageDigest}`) ||
    certificateIdentity !== expectedIdentity ||
    String(promotion.jobWorkflowRef ?? "").toLowerCase() !==
      expectedJobWorkflowRef.toLowerCase() ||
    promotion.sbomSha256 !==
      createHash("sha256").update(sbomBytes).digest("hex")
  ) {
    throw new Error(
      "promotion evidence is not bound to the expected image, workflow, and SBOM"
    );
  }
  const signatures = verifyCosignSignatureEvidence(
    parseJsonFile(cosignBytes, "cosign-verification.json"),
    imageDigest,
    certificateIdentity
  );
  const sbomAttestations = verifySbomAttestationEvidence(
    parseJsonFile(
      attestationBytes,
      "sbom-attestation-verification.json"
    ),
    imageDigest
  );
  return {
    imageDigest,
    imageReference,
    certificateIdentity,
    signatures,
    sbomAttestations
  };
}

async function processImageArtifact(
  store: Store,
  archive: ParsedArtifactArchive,
  artifact: ScannerArtifactRecord,
  repositoryFullName: string,
  repositoryVisibility: "public" | "private" | "internal",
  defaultBranch: string,
  run: Pick<
    ScannerWorkflowRunRecord,
    "headSha" | "headBranch" | "workflowPath" | "workflowRef" | "event" | "startedAt"
  >,
  trustPolicy: EvidenceTrustPolicy,
  env: Record<string, string | undefined>,
  defectDojoSettings: DefectDojoSettings | undefined,
  deploymentService: DigitalOceanDeploymentService
): Promise<void> {
  const base = {
    repositoryId: artifact.repositoryId,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    artifactId: artifact.artifactId
  };
  const trivyBytes = archive.selectedFiles.get("trivy-image.json");
  const sbomBytes = archive.selectedFiles.get("sbom.cdx.json");
  const policyBytes = archive.selectedFiles.get("policy.json");
  const buildBytes = archive.selectedFiles.get("build-digests.json");
  if (!trivyBytes || !sbomBytes || !policyBytes || !buildBytes) {
    throw new Error("image evidence artifact is missing a required trusted report");
  }
  const trivyJson = parseJsonFile(trivyBytes, "trivy-image.json");
  const sbomJson = parseJsonFile(sbomBytes, "sbom.cdx.json");
  const policyJson = parseJsonFile(policyBytes, "policy.json");
  const trivyFailed = Boolean(asRecord(trivyJson)?.scanner_error);
  if (trivyFailed) {
    throw new Error("Trivy image scanner reported scanner_error");
  }
  validateTrivyScannerReport(trivyJson, "trivy-image.json");
  const trivyFindings = dedupeFindings(normalizeTrivy(trivyJson));
  const actualCriticalCount = countCriticalImageFindings(trivyJson);
  const policyCriticalCount = asRecord(policyJson)?.criticalFindings;
  if (
    !Number.isSafeInteger(policyCriticalCount) ||
    Number(policyCriticalCount) < 0 ||
    Number(policyCriticalCount) !== actualCriticalCount
  ) {
    throw new Error("image policy critical count does not match the Trivy report");
  }
  const criticalCount = actualCriticalCount;
  const buildSummary = parseBuildDigestReport(
    parseJsonFile(buildBytes, "build-digests.json")
  );
  await recordEvidence(store, base, {
    evidenceKey: "image-trivy-summary",
    kind: "trivy",
    source: "trivy",
    status: criticalCount > 0 ? "failure" : "success",
    observedAt: new Date().toISOString(),
    details: `critical image findings: ${criticalCount}`,
    payload: {
      criticalFindings: criticalCount,
      findings: trivyFindings.length,
      ...buildSummary
    }
  });
  const sbomSummary = parseCycloneDxSummary(sbomJson);
  await recordEvidence(store, base, {
    evidenceKey: "sbom",
    kind: "sbom",
    source: "trivy",
    status: "success",
    observedAt: new Date().toISOString(),
    details: "CycloneDX SBOM generated",
    payload: sbomSummary
  });
  if (artifact.artifactType === "image-promotion") {
    const promotion = validatePromotionEvidence(
      archive,
      repositoryFullName,
      run.workflowPath,
      run.workflowRef,
      trustPolicy
    );
    await recordEvidence(store, base, {
      evidenceKey: "signature",
      kind: "signature",
      source: "cosign",
      status: "success",
      observedAt: new Date().toISOString(),
      digest: promotion.imageDigest,
      details: "Cosign signature and CycloneDX attestation verified",
      payload: promotion
    });
    if (
      run.event === "push" &&
      run.headBranch === defaultBranch
    ) {
      try {
        const deployment = await deploymentService.promote({
          repository: repositoryFullName,
          repositoryId: artifact.repositoryId,
          runId: artifact.runId,
          runAttempt: artifact.runAttempt,
          headSha: run.headSha,
          imageReference: promotion.imageReference
        });
        if (deployment) {
          await recordEvidence(store, base, {
            evidenceKey: `deployment:${deployment.environment}`,
            kind: "deployment",
            source: "digitalocean",
            status: "success",
            observedAt: deployment.observedAt,
            digest: deployment.imageDigest,
            environment: deployment.environment,
            details: "Exact signed digest is active and healthy on DigitalOcean",
            payload: {
              profileId: deployment.profileId,
              appId: deployment.appId,
              deploymentId: deployment.deploymentId,
              origin: deployment.origin,
              updated: deployment.updated
            }
          });
        }
      } catch (error) {
        const environment =
          error instanceof DigitalOceanDeploymentError
            ? error.environment
            : "unknown";
        await recordEvidence(store, base, {
          evidenceKey: `deployment:${environment}`,
          kind: "deployment",
          source: "digitalocean",
          status: "failure",
          observedAt: new Date().toISOString(),
          digest: promotion.imageDigest,
          environment,
          details:
            error instanceof DigitalOceanDeploymentError
              ? error.message
              : "DigitalOcean deployment reconciliation failed"
        });
        throw new RetryableScannerEvidenceError(
          error instanceof DigitalOceanDeploymentError
            ? error.message
            : "DigitalOcean deployment reconciliation failed"
        );
      }
    }
  }
  if (artifact.artifactType === "image-validation") {
    await maybeImportToDefectDojo(store, env, defectDojoSettings, {
      repositoryId: artifact.repositoryId,
      repositoryFullName,
      visibility: repositoryVisibility,
      defaultBranch,
      headBranch: run.headBranch ?? defaultBranch,
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha: run.headSha,
      startedAt: run.startedAt,
      artifactType: artifact.artifactType,
      scanType: "Trivy Scan",
      fileName: "trivy-image.json",
      report: trivyBytes,
      contentType: "application/json"
    });
  }
}

async function processDastArtifact(
  store: Store,
  archive: ParsedArtifactArchive,
  artifact: ScannerArtifactRecord,
  repositoryFullName: string,
  repositoryVisibility: "public" | "private" | "internal",
  defaultBranch: string,
  run: Pick<ScannerWorkflowRunRecord, "headSha" | "headBranch" | "startedAt">,
  env: Record<string, string | undefined>,
  defectDojoSettings: DefectDojoSettings | undefined
): Promise<void> {
  const base = {
    repositoryId: artifact.repositoryId,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    artifactId: artifact.artifactId
  };
  const zapBytes = archive.selectedFiles.get("zap.json");
  const statusBytes = archive.selectedFiles.get("scan-status.json");
  if (!zapBytes || !statusBytes) {
    throw new Error("DAST evidence artifact is missing a required trusted report");
  }
  const zapJson = parseJsonFile(zapBytes, "zap.json");
  const statusJson = parseJsonFile(statusBytes, "scan-status.json");
  const exit = parseZapStatus(statusJson);
  const findings = normalizeZapFindings(zapJson);
  const isNightly = exit.profile === "authenticated-full";
  const evidencePrefix = isNightly ? "zap-nightly" : "zap-smoke";
  await recordEvidence(store, base, {
    evidenceKey: `${evidencePrefix}-summary`,
    kind: evidencePrefix,
    source: "zap",
    status: exit.zapExitCode >= 3 ? "failure" : "success",
    observedAt: new Date().toISOString(),
    digest: exit.deployedDigest,
    environment: exit.deploymentEnvironment,
    details: `zap exit code: ${exit.zapExitCode}`,
    payload: {
      exitCode: exit.zapExitCode,
      profile: exit.profile,
      minutes: exit.minutes,
      findings: findings.length,
      deployedDigest: exit.deployedDigest,
      deploymentEnvironment: exit.deploymentEnvironment
    }
  });
  for (const finding of findings) {
    await recordEvidence(store, base, {
      evidenceKey: `zap:${finding.fingerprint}`,
      kind: evidencePrefix,
      source: "zap",
      status: "success",
      observedAt: new Date().toISOString(),
      digest: exit.deployedDigest,
      environment: exit.deploymentEnvironment,
      fingerprint: finding.fingerprint,
      path: finding.path,
      line: finding.line,
      details: `${finding.severity} ${finding.ruleId}`,
      payload: {
        title: finding.title,
        description: finding.description,
        count: finding.count
      }
    });
  }
  if (exit.zapExitCode < 3) {
    await maybeImportToDefectDojo(store, env, defectDojoSettings, {
      repositoryId: artifact.repositoryId,
      repositoryFullName,
      visibility: repositoryVisibility,
      defaultBranch,
      headBranch: run.headBranch ?? defaultBranch,
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha: run.headSha,
      startedAt: run.startedAt,
      artifactType: artifact.artifactType,
      scanType: "ZAP Scan",
      evidenceKey:
        `defectdojo-import:ZAP Scan:${isNightly ? "nightly" : "smoke"}`,
      fileName: "zap.json",
      report: zapBytes,
      contentType: "application/json",
      digest: exit.deployedDigest,
      environment: exit.deploymentEnvironment
    });
  }
}

function artifactType(name: string): EvidenceArtifactType | undefined {
  if (name.startsWith("guardianbot-evidence-")) return "security";
  if (name.startsWith("guardianbot-image-promotion-")) return "image-promotion";
  if (name.startsWith("guardianbot-image-evidence-")) return "image-validation";
  if (name.startsWith("guardianbot-dast-evidence-")) return "dast";
  return undefined;
}

function expectedArtifactName(
  type: EvidenceArtifactType,
  runId: number,
  runAttempt: number
): string {
  const prefix =
    type === "security"
      ? "guardianbot-evidence-"
      : type === "dast"
        ? "guardianbot-dast-evidence-"
        : type === "image-promotion"
          ? "guardianbot-image-promotion-"
          : "guardianbot-image-evidence-";
  return `${prefix}${runId}-${runAttempt}`;
}

function workflowJob(
  jobs: readonly GitHubWorkflowJob[],
  expectedName: string
): GitHubWorkflowJob | undefined {
  return jobs.find((job) => {
    const name = String(job.name ?? "");
    return name === expectedName || name.endsWith(` / ${expectedName}`);
  });
}

function expectedArtifactTypes(
  referencedWorkflows: readonly ParsedReferencedWorkflow[],
  jobs: readonly GitHubWorkflowJob[]
): EvidenceArtifactType[] {
  const types: EvidenceArtifactType[] = [];
  const paths = new Set(referencedWorkflows.map((workflow) => workflow.workflowPath));
  if (paths.has(".github/workflows/reusable-security.yml")) {
    const scannerJob = workflowJob(jobs, "deterministic scanners");
    if (!scannerJob) {
      throw new RetryableScannerEvidenceError(
        "trusted security reusable workflow job metadata is unavailable"
      );
    }
    if (scannerJob.conclusion !== "skipped") types.push("security");
  }
  if (paths.has(".github/workflows/reusable-image.yml")) {
    const validationJob = workflowJob(jobs, "image build, smoke, scan, SBOM");
    const promotionJob = workflowJob(jobs, "image push, sign, attest");
    if (!validationJob || !promotionJob) {
      throw new RetryableScannerEvidenceError(
        "trusted image reusable workflow job metadata is unavailable"
      );
    }
    if (validationJob.conclusion !== "skipped") types.push("image-validation");
    if (promotionJob.conclusion !== "skipped") types.push("image-promotion");
  }
  if (paths.has(".github/workflows/reusable-dast.yml")) {
    const dastJob = workflowJob(jobs, "authenticated staging DAST");
    if (!dastJob) {
      throw new RetryableScannerEvidenceError(
        "trusted DAST reusable workflow job metadata is unavailable"
      );
    }
    if (dastJob.conclusion !== "skipped") types.push("dast");
  }
  return types;
}

function validateArtifactMetadata(
  artifact: GitHubArtifact,
  expectedName: string,
  workflowRecord: ScannerWorkflowRunRecord,
  repositoryId: number
): string[] {
  const errors: string[] = [];
  const workflowMetadata = asRecord(artifact.workflow_run);
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) {
    errors.push("artifact id is invalid");
  }
  if (artifact.name !== expectedName) errors.push("artifact name mismatch");
  if (
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > MAX_ARTIFACT_BYTES
  ) {
    errors.push("artifact size is invalid");
  }
  if (
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest.toLowerCase())
  ) {
    errors.push("artifact digest is missing or invalid");
  }
  if (
    typeof artifact.archive_download_url !== "string" ||
    !/^https:\/\//.test(artifact.archive_download_url)
  ) {
    errors.push("artifact download metadata is missing or invalid");
  }
  if (!workflowMetadata) {
    errors.push("artifact workflow_run metadata is missing");
    return errors;
  }
  if (workflowMetadata.id !== workflowRecord.runId) {
    errors.push("artifact workflow run id mismatch");
  }
  if (workflowMetadata.repository_id !== repositoryId) {
    errors.push("artifact repository id mismatch");
  }
  if (
    !Number.isSafeInteger(workflowMetadata.head_repository_id) ||
    Number(workflowMetadata.head_repository_id) <= 0
  ) {
    errors.push("artifact head repository metadata is invalid");
  }
  if (workflowMetadata.head_sha !== workflowRecord.headSha) {
    errors.push("artifact head SHA mismatch");
  }
  if (workflowMetadata.head_branch !== workflowRecord.headBranch) {
    errors.push("artifact head branch mismatch");
  }
  return errors;
}

export function createScannerWorkflowRunHandler(
  options: ScannerEvidenceHandlerOptions
): (run: GuardianScannerWorkflowRun) => Promise<void> {
  const env = options.environment ?? process.env;
  const trustPolicy = parseEvidenceTrustPolicy(env);
  const defectDojoSettings = parseDefectDojoSettings(env);
  const deploymentService = createDigitalOceanDeploymentService({
    store: options.store,
    environment: env,
    fetchImpl: options.fetchImpl,
    now: options.now
  });
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.githubApiBase ?? DEFAULT_GITHUB_API_BASE;
  return async (run: GuardianScannerWorkflowRun) => {
    const repository = await options.store.getRepository(run.repositoryId);
    if (!repository) return;
    const existing = await options.store.getScannerWorkflowRun(
      run.repositoryId,
      run.runId,
      run.runAttempt
    );
    if (existing?.validationStatus === "accepted" && existing.processedAt) {
      return;
    }
    const [owner, repo] = repository.fullName.split("/");
    if (!owner || !repo) {
      throw new Error(`repository ${repository.fullName} is not a valid owner/name slug`);
    }
    const api = options.apiClientFactory
      ? await options.apiClientFactory(
          {
            installationId: repository.installationId,
            repositoryId: repository.repositoryId
          },
          fetchImpl,
          apiBase
        )
      : await createGitHubApiClient(
          options.appId,
          options.privateKey,
          repository.installationId,
          repository.repositoryId,
          fetchImpl,
          apiBase
        );
    const workflowRun = await loadWorkflowRun(api, owner, repo, run.runId);
    const { workflowPath, workflowRef } = parseWorkflowPath(String(workflowRun.path ?? ""));
    const referencedWorkflowValues = Array.isArray(workflowRun.referenced_workflows)
      ? workflowRun.referenced_workflows
      : [];
    const referencedWorkflows = referencedWorkflowValues
      .map((workflow) => parseReferencedWorkflow(workflow, trustPolicy))
      .filter((workflow): workflow is ParsedReferencedWorkflow => Boolean(workflow));
    const workflowRecord: ScannerWorkflowRunRecord = {
      repositoryId: run.repositoryId,
      runId: run.runId,
      runAttempt: run.runAttempt,
      headSha: String(workflowRun.head_sha ?? ""),
      headBranch: workflowRun.head_branch ? String(workflowRun.head_branch) : undefined,
      event: scannerWorkflowEvent(workflowRun.event),
      startedAt: normalizedTimestamp(workflowRun.run_started_at),
      completedAt:
        workflowRun.status === "completed"
          ? normalizedTimestamp(workflowRun.updated_at)
          : undefined,
      workflowPath,
      workflowRef,
      workflowSha:
        referencedWorkflows.length &&
        referencedWorkflows.every((workflow) => workflow.sha === referencedWorkflows[0]?.sha)
          ? referencedWorkflows[0]?.sha
          : undefined,
      conclusion: String(workflowRun.conclusion ?? "unknown"),
      status: String(workflowRun.status ?? "unknown"),
      validationStatus: "pending",
      referencedWorkflows: referencedWorkflows.map<ScannerReferencedWorkflow>((workflow) => ({
        path: workflow.path,
        sha: workflow.sha,
        ref: workflow.ref
      }))
    };
    const validationErrors: string[] = [];
    if (workflowRun.id !== run.runId) validationErrors.push("workflow run id mismatch");
    if (workflowRun.run_attempt !== run.runAttempt) validationErrors.push("workflow run attempt mismatch");
    if (workflowPath !== run.workflowPath) validationErrors.push("workflow path is not trusted");
    if (String(workflowRun.head_sha ?? "") !== run.headSha) validationErrors.push("workflow head SHA mismatch");
    if (!workflowRun.head_branch || typeof workflowRun.head_branch !== "string") {
      validationErrors.push("workflow head branch metadata is missing");
    }
    if (
      workflowRun.repository?.id !== repository.repositoryId ||
      normalizeRepository(String(workflowRun.repository?.full_name ?? "")) !==
        normalizeRepository(repository.fullName)
    ) {
      validationErrors.push("workflow repository metadata mismatch");
    }
    if (String(workflowRun.conclusion ?? "unknown") !== run.conclusion) {
      validationErrors.push("workflow conclusion mismatch");
    }
    if (String(workflowRun.status ?? "") !== "completed") validationErrors.push("workflow run is not completed");
    if (referencedWorkflows.length === 0) {
      validationErrors.push("workflow run did not reference any trusted GuardianBot reusable workflow");
    }
    if (referencedWorkflows.length !== referencedWorkflowValues.length) {
      validationErrors.push("workflow run referenced an untrusted reusable workflow or mutable ref");
    }
    if (
      new Set(referencedWorkflows.map((workflow) => workflow.workflowPath)).size !==
      referencedWorkflows.length
    ) {
      validationErrors.push("workflow run referenced a trusted reusable workflow more than once");
    }
    if (validationErrors.length) {
      await options.store.upsertScannerWorkflowRun({
        ...workflowRecord,
        validationStatus: "rejected",
        validationError: validationErrors.join("; "),
        processedAt: now().toISOString()
      });
      return;
    }
    await options.store.upsertScannerWorkflowRun(workflowRecord);
    const [artifacts, jobs] = await Promise.all([
      listWorkflowArtifacts(api, owner, repo, run.runId),
      listWorkflowJobs(api, owner, repo, run.runId)
    ]);
    const expectedTypes = expectedArtifactTypes(referencedWorkflows, jobs);
    const expectedNames = new Set(
      expectedTypes.map((type) =>
        expectedArtifactName(type, run.runId, run.runAttempt)
      )
    );
    const namedTrustedArtifacts = artifacts.filter((artifact) =>
      artifactType(artifact.name)
    );
    const unexpectedNames = namedTrustedArtifacts
      .map((artifact) => artifact.name)
      .filter((name) => !expectedNames.has(name));
    const missingOrDuplicate = [...expectedNames].filter(
      (name) => artifacts.filter((artifact) => artifact.name === name).length !== 1
    );
    if (unexpectedNames.length || missingOrDuplicate.length) {
      const validationError = [
        unexpectedNames.length
          ? `unexpected trusted artifacts: ${unexpectedNames.join(", ")}`
          : "",
        missingOrDuplicate.length
          ? `missing or duplicate expected artifacts: ${missingOrDuplicate.join(", ")}`
          : ""
      ]
        .filter(Boolean)
        .join("; ");
      await options.store.upsertScannerWorkflowRun({
        ...workflowRecord,
        validationStatus: "failed",
        validationError
      });
      throw new RetryableScannerEvidenceError(validationError);
    }
    let acceptedArtifacts = 0;
    const reconciliationErrors: string[] = [];
    for (const type of expectedTypes) {
      const expectedName = expectedArtifactName(type, run.runId, run.runAttempt);
      const artifact = artifacts.find((candidate) => candidate.name === expectedName);
      if (!artifact) continue;
      const artifactRecord: ScannerArtifactRecord = {
        repositoryId: run.repositoryId,
        runId: run.runId,
        runAttempt: run.runAttempt,
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactType: type,
        sizeBytes: Number(artifact.size_in_bytes ?? 0),
        expired: Boolean(artifact.expired),
        digest: artifact.digest ? String(artifact.digest).toLowerCase() : undefined,
        validationStatus: "accepted"
      };
      const metadataErrors = validateArtifactMetadata(
        artifact,
        expectedName,
        workflowRecord,
        repository.repositoryId
      );
      if (artifact.expired) metadataErrors.push("artifact has expired");
      if (metadataErrors.length) {
        await options.store.upsertScannerArtifact({
          ...artifactRecord,
          validationStatus: "rejected",
          validationError: metadataErrors.join("; "),
          processedAt: now().toISOString()
        });
        reconciliationErrors.push(`${expectedName}: ${metadataErrors.join("; ")}`);
        continue;
      }
      const zipPath = await api.downloadArtifact(owner, repo, artifact.id);
      try {
        const downloaded = await sha256File(zipPath);
        if (
          downloaded.size !== artifactRecord.sizeBytes ||
          !artifactDigestMatches(artifactRecord.digest, downloaded.digest)
        ) {
          throw new Error("artifact size or digest mismatch");
        }
        const allowedFiles =
          type === "security" ? SECURITY_FILES : type === "dast" ? DAST_FILES : IMAGE_FILES;
        const archive = await parseArtifactArchive(zipPath, allowedFiles);
        validateArtifactProvenance(
          archive,
          type,
          {
            repository: repository.fullName,
            repositoryId: repository.repositoryId,
            runId: run.runId,
            runAttempt: run.runAttempt,
            headSha: workflowRecord.headSha
          },
          trustPolicy,
          now()
        );
        if (type === "security") {
          await processSecurityArtifact(
            options.store,
            archive,
            artifactRecord,
            workflowRecord,
            repository.fullName,
            repository.visibility as "public" | "private" | "internal",
            repository.defaultBranch,
            env,
            defectDojoSettings
          );
        } else if (type === "dast") {
          await processDastArtifact(
            options.store,
            archive,
            artifactRecord,
            repository.fullName,
            repository.visibility as "public" | "private" | "internal",
            repository.defaultBranch,
            workflowRecord,
            env,
            defectDojoSettings
          );
        } else {
          await processImageArtifact(
            options.store,
            archive,
            artifactRecord,
            repository.fullName,
            repository.visibility as "public" | "private" | "internal",
            repository.defaultBranch,
            workflowRecord,
            trustPolicy,
            env,
            defectDojoSettings,
            deploymentService
          );
        }
        await options.store.upsertScannerArtifact({
          ...artifactRecord,
          processedAt: now().toISOString()
        });
        acceptedArtifacts += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RetryableScannerEvidenceError) {
          await options.store.upsertScannerArtifact({
            ...artifactRecord,
            validationStatus: "failed",
            validationError:
              `evidence validation completed, but reconciliation health failed: ${message}`
          });
          reconciliationErrors.push(`${expectedName}: ${message}`);
          continue;
        }
        await options.store.upsertScannerArtifact({
          ...artifactRecord,
          validationStatus: "rejected",
          validationError: message,
          processedAt: now().toISOString()
        });
        reconciliationErrors.push(`${expectedName}: ${message}`);
      } finally {
        await rm(join(zipPath, ".."), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (acceptedArtifacts !== expectedTypes.length || reconciliationErrors.length) {
      const validationError =
        reconciliationErrors.join("; ") ||
        "not every expected trusted artifact passed validation";
      await options.store.upsertScannerWorkflowRun({
        ...workflowRecord,
        validationStatus: "failed",
        validationError
      });
      throw new RetryableScannerEvidenceError(validationError);
    }
    await options.store.upsertScannerWorkflowRun({
      ...workflowRecord,
      validationStatus: "accepted",
      processedAt: now().toISOString()
    });
  };
}
