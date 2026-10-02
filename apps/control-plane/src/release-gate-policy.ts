/**
 * Pure, deterministic release-gate policy evaluation.
 *
 * Inputs are limited to accepted control-plane evidence (signature, image
 * scan, SBOM, optional deployed-digest rescan) and DefectDojo findings. AI
 * review output is never an input, so it cannot block, waive, or approve a
 * release. The only exception path is a named, unexpired DefectDojo risk
 * acceptance. Anything the evaluator cannot prove fails closed.
 */

export const RELEASE_GATE_SCHEMA_VERSION = "1.0.0";
const MAX_POLICY_BYTES = 16 * 1024;

export type ReleaseSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReleaseEvidenceRequirement =
  | "signature"
  | "image-scan"
  | "sbom"
  | "deployed-rescan";

const SEVERITIES: readonly ReleaseSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info"
];
const EVIDENCE_REQUIREMENTS: readonly ReleaseEvidenceRequirement[] = [
  "signature",
  "image-scan",
  "sbom",
  "deployed-rescan"
];

export interface ReleaseGatePolicy {
  blockingSeverities: ReleaseSeverity[];
  blockHigh: boolean;
  verifiedOnly: boolean;
  requiredEvidence: ReleaseEvidenceRequirement[];
}

export const DEFAULT_RELEASE_GATE_POLICY: Readonly<ReleaseGatePolicy> = Object.freeze({
  blockingSeverities: ["critical"] as ReleaseSeverity[],
  blockHigh: false,
  verifiedOnly: true,
  requiredEvidence: ["signature", "image-scan", "sbom"] as ReleaseEvidenceRequirement[]
});

export interface ReleaseCandidate {
  repository: string;
  repositoryId: number;
  commit: string;
  digest: string;
  environment: string;
}

export interface ReleaseSignatureEvidence {
  digest: string;
  certificateIdentity: string;
  ref: string;
}

export interface ReleaseImageScanEvidence {
  criticalFindings: number;
  status: string;
  ref: string;
}

export interface ReleaseSbomEvidence {
  status: string;
  ref: string;
}

export interface ReleaseRescanEvidence {
  digest: string;
  environment: string;
  status: string;
  observedAt: string;
  ref: string;
}

export interface ReleaseGateEvidenceInput {
  signature?: ReleaseSignatureEvidence;
  imageScan?: ReleaseImageScanEvidence;
  sbom?: ReleaseSbomEvidence;
  deployedRescan?: ReleaseRescanEvidence;
}

export interface ReleaseDojoRiskAcceptance {
  id: number;
  name?: string | null;
  expiration_date?: string | null;
  decision?: string | null;
  accepted_findings?: number[] | null;
}

export interface ReleaseDojoFinding {
  id: number;
  test: number;
  title?: string | null;
  severity?: string | null;
  active?: boolean | null;
  verified?: boolean | null;
  false_p?: boolean | null;
  duplicate?: boolean | null;
  out_of_scope?: boolean | null;
  is_mitigated?: boolean | null;
  risk_accepted?: boolean | null;
  tags?: string[] | null;
  accepted_risks?: ReleaseDojoRiskAcceptance[] | null;
}

export interface ReleaseDojoTest {
  id: number;
  engagement: number;
  scan_type?: string | null;
  tags?: string[] | null;
}

export type ReleaseDefectDojoState =
  | {
      status: "available";
      productId: number;
      tests: ReleaseDojoTest[];
      findings: ReleaseDojoFinding[];
      acceptedFindings: ReleaseDojoFinding[];
    }
  | { status: "unavailable"; reason: string };

export type ReleaseGateBlockerCode =
  | "gate-unavailable"
  | "unsigned-digest"
  | "wrong-signer"
  | "image-scan-missing"
  | "image-scan-critical"
  | "sbom-missing"
  | "deployed-rescan-missing"
  | "deployed-rescan-failed"
  | "defectdojo-scope-missing"
  | "release-blocking-finding"
  | "risk-acceptance-invalid";

export type ReleaseFindingSource = "dast" | "image" | "sast" | "unknown";

export interface ReleaseGateBlocker {
  code: ReleaseGateBlockerCode;
  message: string;
  findingId?: number;
  severity?: string;
  source?: ReleaseFindingSource;
  ref?: string;
}

export interface ReleaseGateException {
  findingId: number;
  severity: string;
  source: ReleaseFindingSource;
  riskAcceptanceId: number;
  riskAcceptanceName: string;
  expiresAt: string;
  ref: string;
}

export interface ReleaseGateEvidenceRef {
  kind: "signature" | "image-scan" | "sbom" | "deployed-rescan" | "defectdojo";
  ref: string;
  status: string;
}

export interface ReleaseGateDecision {
  schemaVersion: typeof RELEASE_GATE_SCHEMA_VERSION;
  decision: "pass" | "fail";
  candidate: ReleaseCandidate;
  evaluatedAt: string;
  policy: ReleaseGatePolicy;
  expectedCertificateIdentity: string | null;
  blockers: ReleaseGateBlocker[];
  exceptions: ReleaseGateException[];
  ignoredFindings: {
    outOfScope: number;
    belowThreshold: number;
    notOpen: number;
  };
  evidence: ReleaseGateEvidenceRef[];
}

export interface ReleaseGateEvaluationInput {
  candidate: ReleaseCandidate;
  evidence: ReleaseGateEvidenceInput;
  /** Exact Sigstore certificate identity of the trusted image workflow. */
  expectedCertificateIdentity?: string;
  defectDojo: ReleaseDefectDojoState;
  policy: ReleaseGatePolicy;
  now: Date;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniqueSorted<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  return order.filter((value) => values.includes(value));
}

/**
 * Parses GUARDIANBOT_RELEASE_GATE_POLICY_JSON. Absent means the default
 * policy. The policy can only add blocking severities and evidence: Critical
 * findings and an exact-digest signature are always required.
 */
export function parseReleaseGatePolicy(raw: string | undefined): ReleaseGatePolicy {
  if (raw === undefined || raw.trim() === "") {
    return structuredClone(DEFAULT_RELEASE_GATE_POLICY) as ReleaseGatePolicy;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_BYTES) {
    throw new Error("GUARDIANBOT_RELEASE_GATE_POLICY_JSON exceeds its size limit");
  }
  const document = asRecord(JSON.parse(raw));
  if (!document) {
    throw new Error("GUARDIANBOT_RELEASE_GATE_POLICY_JSON must be an object");
  }
  const allowed = new Set(["blockingSeverities", "blockHigh", "verifiedOnly", "requiredEvidence"]);
  const extra = Object.keys(document).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(
      `GUARDIANBOT_RELEASE_GATE_POLICY_JSON contains unsupported fields: ${extra.join(", ")}`
    );
  }
  const policy = structuredClone(DEFAULT_RELEASE_GATE_POLICY) as ReleaseGatePolicy;
  if (document.blockingSeverities !== undefined) {
    const values = document.blockingSeverities;
    if (
      !Array.isArray(values) ||
      values.some((value) => !SEVERITIES.includes(value as ReleaseSeverity)) ||
      !values.includes("critical")
    ) {
      throw new Error(
        "release gate blockingSeverities must list known severities and include critical"
      );
    }
    policy.blockingSeverities = uniqueSorted(values as ReleaseSeverity[], SEVERITIES);
  }
  for (const key of ["blockHigh", "verifiedOnly"] as const) {
    if (document[key] !== undefined) {
      if (typeof document[key] !== "boolean") {
        throw new Error(`release gate ${key} must be a boolean`);
      }
      policy[key] = document[key] as boolean;
    }
  }
  if (document.requiredEvidence !== undefined) {
    const values = document.requiredEvidence;
    if (
      !Array.isArray(values) ||
      values.some(
        (value) => !EVIDENCE_REQUIREMENTS.includes(value as ReleaseEvidenceRequirement)
      ) ||
      !values.includes("signature")
    ) {
      throw new Error(
        "release gate requiredEvidence must list known evidence and include signature"
      );
    }
    policy.requiredEvidence = uniqueSorted(
      values as ReleaseEvidenceRequirement[],
      EVIDENCE_REQUIREMENTS
    );
  }
  if (policy.blockHigh && !policy.blockingSeverities.includes("high")) {
    policy.blockingSeverities = uniqueSorted(
      [...policy.blockingSeverities, "high"],
      SEVERITIES
    );
  }
  return policy;
}

type FindingScope =
  | "in-scope"
  | "other-repository"
  | "other-environment"
  | "other-digest"
  | "other-commit";

function lowerTags(values: readonly (string | null | undefined)[] | null | undefined): string[] {
  return (values ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Scope uses GuardianBot's DefectDojo tags. Commit-scoped imports (SAST and
 * image validation) carry `guardianbot:commit:`; deployment-bound DAST
 * imports also carry `guardianbot:image:` and `guardianbot:env:`. Scope is
 * repository + commit + digest + environment: a digest or environment tag
 * that names anything other than the candidate is out of scope, as is
 * anything without the candidate repository ID.
 */
function findingScope(tags: Set<string>, candidate: ReleaseCandidate): FindingScope {
  if (!tags.has(`guardianbot:repo-id:${candidate.repositoryId}`)) {
    return "other-repository";
  }
  const envTags = [...tags].filter((tag) => tag.startsWith("guardianbot:env:"));
  if (envTags.length && !envTags.includes(`guardianbot:env:${candidate.environment}`)) {
    return "other-environment";
  }
  const imageTags = [...tags].filter((tag) => tag.startsWith("guardianbot:image:"));
  if (imageTags.length) {
    return imageTags.includes(`guardianbot:image:${candidate.digest}`)
      ? "in-scope"
      : "other-digest";
  }
  return tags.has(`guardianbot:commit:${candidate.commit}`) ? "in-scope" : "other-commit";
}

function findingSource(tags: Set<string>): ReleaseFindingSource {
  if (tags.has("guardianbot:profile:dast")) return "dast";
  if (tags.has("guardianbot:profile:image")) return "image";
  if (tags.has("guardianbot:profile:security")) return "sast";
  return "unknown";
}

function validRiskAcceptance(
  finding: ReleaseDojoFinding,
  now: Date
): { id: number; name: string; expiresAt: string } | undefined {
  for (const acceptance of finding.accepted_risks ?? []) {
    if (!acceptance || !Number.isSafeInteger(acceptance.id)) continue;
    const name = typeof acceptance.name === "string" ? acceptance.name.trim() : "";
    const expiry = Date.parse(String(acceptance.expiration_date ?? ""));
    if (
      !name ||
      !Number.isFinite(expiry) ||
      expiry <= now.getTime() ||
      (acceptance.decision !== undefined &&
        acceptance.decision !== null &&
        acceptance.decision !== "A") ||
      (Array.isArray(acceptance.accepted_findings) &&
        !acceptance.accepted_findings.includes(finding.id))
    ) {
      continue;
    }
    return { id: acceptance.id, name, expiresAt: new Date(expiry).toISOString() };
  }
  return undefined;
}

function findingRef(id: number): string {
  return `defectdojo://findings/${id}`;
}

export function evaluateReleaseGate(input: ReleaseGateEvaluationInput): ReleaseGateDecision {
  const { candidate, evidence, policy, now } = input;
  const blockers: ReleaseGateBlocker[] = [];
  const exceptions: ReleaseGateException[] = [];
  const evidenceRefs: ReleaseGateEvidenceRef[] = [];
  const ignoredFindings = { outOfScope: 0, belowThreshold: 0, notOpen: 0 };
  const required = new Set<ReleaseEvidenceRequirement>([
    "signature",
    ...policy.requiredEvidence
  ]);
  const expectedIdentity = input.expectedCertificateIdentity?.toLowerCase();

  // Signature: always required, bound to the exact candidate digest and the
  // exact trusted image-workflow certificate identity.
  if (!evidence.signature || evidence.signature.digest !== candidate.digest) {
    blockers.push({
      code: "unsigned-digest",
      message: "no accepted Cosign signature is bound to the exact candidate digest"
    });
  } else {
    evidenceRefs.push({ kind: "signature", ref: evidence.signature.ref, status: "success" });
    if (
      !expectedIdentity ||
      evidence.signature.certificateIdentity.toLowerCase() !== expectedIdentity
    ) {
      blockers.push({
        code: "wrong-signer",
        message: "the candidate signature was not issued to the trusted image workflow identity",
        ref: evidence.signature.ref
      });
    }
  }

  if (evidence.imageScan) {
    evidenceRefs.push({
      kind: "image-scan",
      ref: evidence.imageScan.ref,
      status: evidence.imageScan.status
    });
  }
  if (required.has("image-scan")) {
    if (!evidence.imageScan) {
      blockers.push({
        code: "image-scan-missing",
        message: "no accepted Trivy image result exists for the candidate"
      });
    } else if (
      evidence.imageScan.status !== "success" ||
      !Number.isSafeInteger(evidence.imageScan.criticalFindings) ||
      evidence.imageScan.criticalFindings !== 0
    ) {
      blockers.push({
        code: "image-scan-critical",
        message: "the accepted Trivy image result is not Critical-clean",
        ref: evidence.imageScan.ref
      });
    }
  }

  if (evidence.sbom) {
    evidenceRefs.push({ kind: "sbom", ref: evidence.sbom.ref, status: evidence.sbom.status });
  }
  if (required.has("sbom") && evidence.sbom?.status !== "success") {
    blockers.push({
      code: "sbom-missing",
      message: "no accepted CycloneDX SBOM exists for the candidate",
      ref: evidence.sbom?.ref
    });
  }

  const rescan =
    evidence.deployedRescan &&
    evidence.deployedRescan.digest === candidate.digest &&
    evidence.deployedRescan.environment === candidate.environment
      ? evidence.deployedRescan
      : undefined;
  if (rescan) {
    evidenceRefs.push({ kind: "deployed-rescan", ref: rescan.ref, status: rescan.status });
  }
  if (required.has("deployed-rescan")) {
    if (!rescan) {
      blockers.push({
        code: "deployed-rescan-missing",
        message: "no accepted DAST rescan exists for the candidate digest in the candidate environment"
      });
    } else if (rescan.status !== "success") {
      blockers.push({
        code: "deployed-rescan-failed",
        message: "the deployed-digest DAST rescan did not complete successfully",
        ref: rescan.ref
      });
    }
  }

  const dojo = input.defectDojo;
  if (dojo.status !== "available") {
    blockers.push({
      code: "gate-unavailable",
      message: `DefectDojo is unavailable: ${dojo.reason}`
    });
  } else {
    evidenceRefs.push({
      kind: "defectdojo",
      ref: `defectdojo://products/${dojo.productId}`,
      status: "success"
    });
    const testTags = new Map<number, string[]>();
    let scopedTests = 0;
    for (const test of dojo.tests) {
      const tags = lowerTags(test.tags);
      testTags.set(test.id, tags);
      if (findingScope(new Set(tags), candidate) === "in-scope") scopedTests += 1;
    }
    if (scopedTests === 0) {
      blockers.push({
        code: "defectdojo-scope-missing",
        message:
          "DefectDojo has no GuardianBot import scoped to the candidate commit or digest"
      });
    }
    const findings = new Map<number, ReleaseDojoFinding>();
    for (const finding of [...dojo.findings, ...dojo.acceptedFindings]) {
      if (!Number.isSafeInteger(finding?.id)) continue;
      const existing = findings.get(finding.id);
      // Prefer the record that carries risk-acceptance detail.
      if (!existing || (finding.accepted_risks?.length ?? 0) > (existing.accepted_risks?.length ?? 0)) {
        findings.set(finding.id, finding);
      }
    }
    const blocking = new Set<string>(policy.blockingSeverities);
    for (const finding of [...findings.values()].sort((left, right) => left.id - right.id)) {
      const tags = new Set([
        ...lowerTags(finding.tags),
        ...(testTags.get(finding.test) ?? [])
      ]);
      if (findingScope(tags, candidate) !== "in-scope") {
        ignoredFindings.outOfScope += 1;
        continue;
      }
      // Server-side filters are re-checked; only explicit evidence excludes.
      if (
        finding.false_p === true ||
        finding.duplicate === true ||
        finding.out_of_scope === true ||
        finding.is_mitigated === true
      ) {
        ignoredFindings.notOpen += 1;
        continue;
      }
      const accepted =
        finding.risk_accepted === true || (finding.accepted_risks?.length ?? 0) > 0;
      if (!accepted) {
        if (finding.active === false || (policy.verifiedOnly && finding.verified === false)) {
          ignoredFindings.notOpen += 1;
          continue;
        }
      }
      const severity = String(finding.severity ?? "").trim().toLowerCase();
      const known = SEVERITIES.includes(severity as ReleaseSeverity);
      if (known && !blocking.has(severity)) {
        ignoredFindings.belowThreshold += 1;
        continue;
      }
      const source = findingSource(tags);
      const ref = findingRef(finding.id);
      const label = known ? severity : "unclassified";
      if (accepted) {
        const acceptance = validRiskAcceptance(finding, now);
        if (acceptance) {
          exceptions.push({
            findingId: finding.id,
            severity: label,
            source,
            riskAcceptanceId: acceptance.id,
            riskAcceptanceName: acceptance.name,
            expiresAt: acceptance.expiresAt,
            ref
          });
          continue;
        }
        blockers.push({
          code: "risk-acceptance-invalid",
          message: `${label} ${source} finding has no named, unexpired DefectDojo risk acceptance`,
          findingId: finding.id,
          severity: label,
          source,
          ref
        });
        continue;
      }
      blockers.push({
        code: "release-blocking-finding",
        message: `active ${label} ${source} finding is tied to the candidate`,
        findingId: finding.id,
        severity: label,
        source,
        ref
      });
    }
  }

  return {
    schemaVersion: RELEASE_GATE_SCHEMA_VERSION,
    decision: blockers.length ? "fail" : "pass",
    candidate: { ...candidate },
    evaluatedAt: now.toISOString(),
    policy: structuredClone(policy),
    expectedCertificateIdentity: input.expectedCertificateIdentity ?? null,
    blockers,
    exceptions,
    ignoredFindings,
    evidence: evidenceRefs
  };
}
