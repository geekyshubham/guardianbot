import { once } from "node:events";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open as openFile, readFile, rm } from "node:fs/promises";
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
import type { GuardianScannerWorkflowRun } from "./service.js";
import type {
  ScannerArtifactRecord,
  ScannerEvidenceRecord,
  ScannerReferencedWorkflow,
  ScannerWorkflowRunRecord,
  Store
} from "./store.js";

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;
const MAX_ARTIFACT_PAGES = 20;
const MAX_ARTIFACTS_PER_RUN = 200;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_000;
const MAX_FINDINGS = 500;
const ARTIFACT_NAME_TIMEOUT_MS = 60_000;
const TRUSTED_WORKFLOW_PATHS = new Set([
  ".github/workflows/reusable-security.yml",
  ".github/workflows/reusable-image.yml",
  ".github/workflows/reusable-dast.yml"
]);
const DEFAULT_TRUSTED_REPOSITORY = "geekyshubham/guardianbot";

const SECURITY_FILES = new Set(["semgrep.json", "trivy.json", "gate.json"]);
const IMAGE_FILES = new Set([
  "trivy-image.json",
  "sbom.cdx.json",
  "policy.json",
  "build-digests.json",
  "cosign-verification.json"
]);
const DAST_FILES = new Set(["zap.json", "scan-status.json"]);

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

interface TrustedWorkflowConfig {
  repository: string;
}

interface GitHubWorkflowRun {
  id: number;
  run_attempt: number;
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
  workflow_run?: { id?: number; head_sha?: string };
}

interface GitHubArtifactPage {
  total_count?: number;
  artifacts?: GitHubArtifact[];
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
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface SecurityGateReport {
  conclusion: string;
  reason?: string;
  blockers?: unknown[];
  observed?: unknown[];
  executionFailures?: unknown[];
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

function parseTrustedWorkflowConfig(
  env: Record<string, string | undefined>
): TrustedWorkflowConfig {
  const configuredRepository =
    env.GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY ?? DEFAULT_TRUSTED_REPOSITORY;
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(configuredRepository)) {
    throw new Error("GUARDIANBOT_TRUSTED_WORKFLOW_REPOSITORY is invalid");
  }
  return { repository: configuredRepository.toLowerCase() };
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

function normalizeRepository(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function sha256Hex(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function artifactDigestMatches(expected: string | undefined, actualHex: string): boolean {
  if (!expected) return true;
  return expected.trim().toLowerCase() === `sha256:${actualHex}`;
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

function parseWorkflowPath(pathValue: string): { workflowPath: string; workflowRef?: string } {
  const [workflowPath = "", workflowRef] = pathValue.split("@", 2);
  return { workflowPath, workflowRef };
}

function parseReferencedWorkflow(
  value: unknown,
  trustedRepository: string
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
  if (repository !== trustedRepository) return undefined;
  if (!TRUSTED_WORKFLOW_PATHS.has(workflowPath)) return undefined;
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
  if (!root || root.bomFormat !== "CycloneDX" || typeof root.specVersion !== "string") {
    throw new Error("sbom.cdx.json is not a valid CycloneDX document");
  }
  return {
    bomFormat: root.bomFormat,
    specVersion: root.specVersion,
    serialNumber: typeof root.serialNumber === "string" ? root.serialNumber : undefined,
    componentCount: Array.isArray(root.components) ? root.components.length : 0
  };
}

function parseSecurityGate(report: unknown): SecurityGateReport {
  const root = asRecord(report);
  if (!root || typeof root.conclusion !== "string") {
    throw new Error("gate.json is invalid");
  }
  return {
    conclusion: root.conclusion,
    reason: typeof root.reason === "string" ? root.reason : undefined,
    blockers: Array.isArray(root.blockers) ? root.blockers : undefined,
    observed: Array.isArray(root.observed) ? root.observed : undefined,
    executionFailures: Array.isArray(root.executionFailures) ? root.executionFailures : undefined
  };
}

function parseZapStatus(report: unknown): { zapExitCode: number } {
  const root = asRecord(report);
  if (!root) throw new Error("scan-status.json is invalid");
  return { zapExitCode: requireInteger(root.zapExitCode, "zapExitCode") };
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
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error("artifact ZIP has too many entries");
    }
    if (centralDirectoryOffset + centralDirectorySize > stat.size) {
      throw new Error("artifact ZIP central directory exceeds archive bounds");
    }
    const centralDirectory = Buffer.alloc(centralDirectorySize);
    await handle.read(centralDirectory, 0, centralDirectory.length, centralDirectoryOffset);
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
      const name = centralDirectory
        .subarray(cursor + 46, cursor + 46 + fileNameLength)
        .toString(generalPurposeBitFlag & 0x0800 ? "utf8" : "utf8");
      cursor += 46 + fileNameLength + extraLength + commentLength;
      const normalized = posix.normalize(name.replace(/\\/g, "/"));
      if (
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
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });
    }
    const selectedFiles = new Map<string, Uint8Array>();
    for (const [leaf, entry] of entries) {
      if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) {
        throw new Error(`artifact ZIP entry ${leaf} exceeds the configured size limit`);
      }
      const localHeader = Buffer.alloc(30);
      await handle.read(localHeader, 0, localHeader.length, entry.localHeaderOffset);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`artifact ZIP local header for ${leaf} is invalid`);
      }
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = Buffer.alloc(entry.compressedSize);
      await handle.read(compressed, 0, compressed.length, dataOffset);
      let content: Buffer;
      if (entry.compressionMethod === 0) {
        content = compressed;
      } else if (entry.compressionMethod === 8) {
        content = inflateRawSync(compressed);
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
    artifactId: number;
    runId: number;
    runAttempt: number;
    headSha: string;
    artifactType: string;
    scanType: string;
    fileName: string;
    report: Uint8Array;
    contentType: string;
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
  const tags = buildDefectDojoTags({
    repositoryId: input.repositoryId,
    repositorySlug: input.repositoryFullName,
    visibility: input.visibility,
    commitSha: input.headSha,
    workflowRunId: String(input.runId),
    workflowAttempt: String(input.runAttempt),
    branch: input.defaultBranch,
    profile,
    scanType: input.scanType
  });
  try {
    const ensured = (await client.ensureImportContext({
      productType: { name: "GitHub Repositories" },
      product: {
        name: input.repositoryFullName,
        description: "GuardianBot imported GitHub Actions evidence",
        tags
      },
      engagement: {
        name: `${input.defaultBranch}/${profile}`,
        branchTag: input.defaultBranch,
        buildId: `${input.runId}/${input.runAttempt}`,
        commitHash: input.headSha,
        tags
      },
      test: {
        engagementId: 0,
        scanType: input.scanType,
        title: `${input.defaultBranch}/${profile}`,
        branchTag: input.defaultBranch,
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
      testTitle: `${input.defaultBranch}/${profile}`,
      fileName: input.fileName,
      contentType: input.contentType,
      report: input.report,
      engagementId: ensured.engagement.id,
      existingTestId: ensured.test?.id ?? undefined,
      metadata: {
        branchTag: input.defaultBranch,
        buildId: `${input.runId}/${input.runAttempt}`,
        commitHash: input.headSha,
        closeOldFindings: true,
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
        evidenceKey: `defectdojo-import:${input.scanType}`,
        kind: "defectdojo-import",
        source: "defectdojo",
        status: "success",
        observedAt: new Date().toISOString(),
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
        evidenceKey: `defectdojo-import:${input.scanType}`,
        kind: "defectdojo-import",
        source: "defectdojo",
        status: "failure",
        observedAt: new Date().toISOString(),
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
  run: Pick<ScannerWorkflowRunRecord, "headSha">,
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
  const semgrepFindings = semgrepFailed
    ? []
    : dedupeFindings(normalizeSemgrep(semgrepJson));
  const trivyFindings = trivyFailed
    ? []
    : dedupeFindings(normalizeTrivy(trivyJson));
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
    status: gate.conclusion === "failure" ? "failure" : "success",
    observedAt: new Date().toISOString(),
    details: gate.reason ?? gate.conclusion,
    payload: {
      blockers: Array.isArray(gate.blockers) ? gate.blockers.length : 0,
      observed: Array.isArray(gate.observed) ? gate.observed.length : 0,
      executionFailures: Array.isArray(gate.executionFailures) ? gate.executionFailures.length : 0
    }
  });
  if (!semgrepFailed) {
    await maybeImportToDefectDojo(store, env, defectDojoSettings, {
      repositoryId: artifact.repositoryId,
      repositoryFullName,
      visibility: repositoryVisibility,
      defaultBranch,
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha: run.headSha,
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
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha: run.headSha,
      artifactType: artifact.artifactType,
      scanType: "Trivy Scan",
      fileName: "trivy.json",
      report: trivyBytes,
      contentType: "application/json"
    });
  }
}

async function processImageArtifact(
  store: Store,
  archive: ParsedArtifactArchive,
  artifact: ScannerArtifactRecord,
  repositoryFullName: string,
  repositoryVisibility: "public" | "private" | "internal",
  defaultBranch: string,
  headSha: string,
  env: Record<string, string | undefined>,
  defectDojoSettings: DefectDojoSettings | undefined
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
  if (!trivyBytes || !sbomBytes || !policyBytes) {
    throw new Error("image evidence artifact is missing a required trusted report");
  }
  const trivyJson = parseJsonFile(trivyBytes, "trivy-image.json");
  const sbomJson = parseJsonFile(sbomBytes, "sbom.cdx.json");
  const policyJson = parseJsonFile(policyBytes, "policy.json");
  const trivyFailed = Boolean(asRecord(trivyJson)?.scanner_error);
  const trivyFindings = trivyFailed ? [] : dedupeFindings(normalizeTrivy(trivyJson));
  const criticalCount =
    Number(asRecord(policyJson)?.criticalFindings ?? countCriticalImageFindings(trivyJson)) || 0;
  await recordEvidence(store, base, {
    evidenceKey: "image-trivy-summary",
    kind: "trivy",
    source: "trivy",
    status: criticalCount > 0 ? "failure" : "success",
    observedAt: new Date().toISOString(),
    details: `critical image findings: ${criticalCount}`,
    payload: {
      criticalFindings: criticalCount,
      findings: trivyFindings.length
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
  const cosignBytes = archive.selectedFiles.get("cosign-verification.json");
  if (cosignBytes) {
    const cosignJson = parseJsonFile(cosignBytes, "cosign-verification.json");
    await recordEvidence(store, base, {
      evidenceKey: "signature",
      kind: "signature",
      source: "cosign",
      status: "success",
      observedAt: new Date().toISOString(),
      details: "Cosign verification present",
      payload: asRecord(cosignJson) ?? { items: Array.isArray(cosignJson) ? cosignJson.length : 0 }
    });
  }
  if (!trivyFailed) {
    await maybeImportToDefectDojo(store, env, defectDojoSettings, {
      repositoryId: artifact.repositoryId,
      repositoryFullName,
      visibility: repositoryVisibility,
      defaultBranch,
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha,
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
  headSha: string,
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
  await recordEvidence(store, base, {
    evidenceKey: "zap-summary",
    kind: "zap-nightly",
    source: "zap",
    status: exit.zapExitCode >= 3 ? "failure" : "success",
    observedAt: new Date().toISOString(),
    details: `zap exit code: ${exit.zapExitCode}`,
    payload: {
      exitCode: exit.zapExitCode,
      findings: findings.length
    }
  });
  for (const finding of findings) {
    await recordEvidence(store, base, {
      evidenceKey: `zap:${finding.fingerprint}`,
      kind: "zap-nightly",
      source: "zap",
      status: "success",
      observedAt: new Date().toISOString(),
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
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
      headSha,
      artifactType: artifact.artifactType,
      scanType: "ZAP Scan",
      fileName: "zap.json",
      report: zapBytes,
      contentType: "application/json"
    });
  }
}

function artifactType(name: string): ScannerArtifactRecord["artifactType"] | undefined {
  if (name.startsWith("guardianbot-evidence-")) return "security";
  if (name.startsWith("guardianbot-image-promotion-")) return "image-promotion";
  if (name.startsWith("guardianbot-image-evidence-")) return "image-validation";
  if (name.startsWith("guardianbot-dast-evidence-")) return "dast";
  return undefined;
}

export function createScannerWorkflowRunHandler(
  options: ScannerEvidenceHandlerOptions
): (run: GuardianScannerWorkflowRun) => Promise<void> {
  const env = options.environment ?? process.env;
  const trustedWorkflow = parseTrustedWorkflowConfig(env);
  const defectDojoSettings = parseDefectDojoSettings(env);
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
      .map((workflow) => parseReferencedWorkflow(workflow, trustedWorkflow.repository))
      .filter((workflow): workflow is ParsedReferencedWorkflow => Boolean(workflow));
    const workflowRecord: ScannerWorkflowRunRecord = {
      repositoryId: run.repositoryId,
      runId: run.runId,
      runAttempt: run.runAttempt,
      headSha: String(workflowRun.head_sha ?? ""),
      headBranch: workflowRun.head_branch ? String(workflowRun.head_branch) : undefined,
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
    if (String(workflowRun.status ?? "") !== "completed") validationErrors.push("workflow run is not completed");
    if (referencedWorkflows.length === 0) {
      validationErrors.push("workflow run did not reference any trusted GuardianBot reusable workflow");
    }
    if (referencedWorkflows.length !== referencedWorkflowValues.length) {
      validationErrors.push("workflow run referenced an untrusted reusable workflow or mutable ref");
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
    const artifacts = await listWorkflowArtifacts(api, owner, repo, run.runId);
    const expectedNames = new Set(
      [...run.artifactNamePrefixes, "guardianbot-image-promotion-"].map(
        (prefix) => `${prefix}${run.runId}-${run.runAttempt}`
      )
    );
    const trustedArtifacts = artifacts.filter((artifact) => expectedNames.has(artifact.name));
    if (!trustedArtifacts.length) {
      throw new RetryableScannerEvidenceError(
        `workflow run ${run.runId}/${run.runAttempt} has no trusted GuardianBot artifact yet`
      );
    }
    let acceptedArtifacts = 0;
    for (const artifact of trustedArtifacts) {
      const type = artifactType(artifact.name);
      if (!type) continue;
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
      if (artifact.expired) {
        await options.store.upsertScannerArtifact({
          ...artifactRecord,
          validationStatus: "rejected",
          validationError: "artifact has expired",
          processedAt: now().toISOString()
        });
        continue;
      }
      const zipPath = await api.downloadArtifact(owner, repo, artifact.id);
      try {
        const zipBytes = await readFile(zipPath);
        const actualDigest = sha256Hex(zipBytes);
        if (!artifactDigestMatches(artifactRecord.digest, actualDigest)) {
          await options.store.upsertScannerArtifact({
            ...artifactRecord,
            validationStatus: "rejected",
            validationError: "artifact digest mismatch",
            processedAt: now().toISOString()
          });
          continue;
        }
        const allowedFiles =
          type === "security" ? SECURITY_FILES : type === "dast" ? DAST_FILES : IMAGE_FILES;
        const archive = await parseArtifactArchive(zipPath, allowedFiles);
        await options.store.upsertScannerArtifact({
          ...artifactRecord,
          processedAt: now().toISOString()
        });
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
            workflowRecord.headSha,
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
            workflowRecord.headSha,
            env,
            defectDojoSettings
          );
        }
        acceptedArtifacts += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RetryableScannerEvidenceError) {
          throw error;
        }
        await options.store.upsertScannerArtifact({
          ...artifactRecord,
          validationStatus: "rejected",
          validationError: message,
          processedAt: now().toISOString()
        });
      } finally {
        await rm(join(zipPath, ".."), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await options.store.upsertScannerWorkflowRun({
      ...workflowRecord,
      validationStatus: acceptedArtifacts > 0 ? "accepted" : "failed",
      validationError: acceptedArtifacts > 0 ? undefined : "no trusted artifact passed validation",
      processedAt: now().toISOString()
    });
  };
}
