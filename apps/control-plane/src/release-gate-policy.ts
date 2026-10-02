/**
 * Pure, deterministic release-gate policy evaluation.
 *
 * Inputs are limited to accepted control-plane evidence (signature, image
 * scan, SBOM, commit scan summaries, deployed-digest rescans) and DefectDojo findings. AI
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

/** Hours a deployed-digest rescan stays fresh; the rescan workflow runs nightly. */
export const RELEASE_RESCAN_MAX_AGE_HOURS = 48;

export interface ReleaseRescanResult {
  digest: string;
  environment: string;
  observedAt: string;
  /** -1 when the recorded count is malformed. */
  criticalFindings: number;
  frozen: boolean;
  /** False when the rescan was verified but its DefectDojo reconciliation has not succeeded. */
  artifactAccepted: boolean;
  ref: string;
}

/**
 * Coverage of the environment the candidate is promoted into. `deployedDigest`
 * is the digest GuardianBot last deployed there, absent before the first
 * promotion; `rescan` is the newest verified scheduled rescan of that digest.
 */
export interface ReleaseRescanEvidence {
  environment: string;
  deployedDigest?: string;
  rescan?: ReleaseRescanResult;
}

export interface ReleaseSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface ReleaseCommitScanSummary {
  status: string;
  /** Absent for legacy or failed summaries, which never prove anything. */
  severities?: ReleaseSeverityCounts;
  ref: string;
}

/** Semgrep and filesystem Trivy summaries from the candidate commit's own security artifact. */
export interface ReleaseCommitScanEvidence {
  commit: string;
  semgrep?: ReleaseCommitScanSummary;
  trivy?: ReleaseCommitScanSummary;
}

export interface ReleaseGateEvidenceInput {
  signature?: ReleaseSignatureEvidence;
  imageScan?: ReleaseImageScanEvidence;
  sbom?: ReleaseSbomEvidence;
  deployedRescan?: ReleaseRescanEvidence;
  /** Newest verified rescan of the candidate digest itself, in any environment. */
  candidateRescan?: ReleaseRescanResult;
  commitScan?: ReleaseCommitScanEvidence;
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
  | "promotion-frozen"
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
  kind:
    | "signature"
    | "image-scan"
    | "sbom"
    | "deployed-rescan"
    | "commit-scan"
    | "defectdojo";
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
  // DefectDojo marks every finding covered by a risk acceptance risk_accepted.
  if (finding.risk_accepted !== true) return undefined;
  for (const acceptance of finding.accepted_risks ?? []) {
    if (!acceptance || !Number.isSafeInteger(acceptance.id)) continue;
    const name = typeof acceptance.name === "string" ? acceptance.name.trim() : "";
    const expiry = Date.parse(String(acceptance.expiration_date ?? ""));
    if (
      !name ||
      !Number.isFinite(expiry) ||
      expiry <= now.getTime() ||
      // DefectDojo always serializes the decision; only "A" (accept) waives.
      acceptance.decision !== "A" ||
      // The acceptance must explicitly cover this finding.
      !Array.isArray(acceptance.accepted_findings) ||
      !acceptance.accepted_findings.includes(finding.id)
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

/**
 * Local proof that a commit-scoped scan of the candidate commit is clean at
 * every blocking severity. Used only when DefectDojo's Test for that scan type
 * was reimported for a newer commit, so DefectDojo no longer describes the
 * candidate. Counts are an upper bound on DefectDojo's rating and ignore its
 * triage, so they can only be stricter than DefectDojo.
 */
function commitScanProof(
  source: ReleaseFindingSource,
  scanType: string,
  evidence: ReleaseGateEvidenceInput,
  candidate: ReleaseCandidate,
  policy: ReleaseGatePolicy
): string | undefined {
  const clean = (summary: ReleaseCommitScanSummary | undefined) => {
    if (summary?.status !== "success" || !summary.severities) return false;
    const counts = summary.severities;
    return SEVERITIES.every((severity) => {
      const count = counts[severity];
      if (!Number.isSafeInteger(count) || count < 0) return false;
      return !policy.blockingSeverities.includes(severity) || count === 0;
    });
  };
  if (source === "sast") {
    const scan = evidence.commitScan;
    if (!scan || scan.commit !== candidate.commit) return undefined;
    const summary =
      scanType === "Semgrep JSON Report"
        ? scan.semgrep
        : scanType === "Trivy Scan"
          ? scan.trivy
          : undefined;
    return clean(summary) ? summary?.ref : undefined;
  }
  if (source === "image" && scanType === "Trivy Scan") {
    // The image scan reports Critical findings only, so it proves nothing for
    // a policy that also blocks lower severities.
    const scan = evidence.imageScan;
    if (
      policy.blockingSeverities.length === 1 &&
      policy.blockingSeverities[0] === "critical" &&
      scan?.status === "success" &&
      scan.criticalFindings === 0
    ) {
      return scan.ref;
    }
  }
  return undefined;
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

  // A digest whose own scheduled rescan found Critical findings is never
  // promoted again, to any environment, whatever the policy requires.
  const candidateRescan =
    evidence.candidateRescan?.digest === candidate.digest ? evidence.candidateRescan : undefined;
  if (candidateRescan?.frozen) {
    blockers.push({
      code: "promotion-frozen",
      message:
        `a promotion freeze is active for the candidate digest (rescan in ${candidateRescan.environment})`,
      ref: candidateRescan.ref
    });
  }

  const coverage =
    evidence.deployedRescan?.environment === candidate.environment
      ? evidence.deployedRescan
      : undefined;
  if (coverage?.rescan) {
    evidenceRefs.push({
      kind: "deployed-rescan",
      ref: coverage.rescan.ref,
      status: coverage.rescan.frozen ? "frozen" : "success"
    });
  }
  // Required coverage means the digest running in the candidate environment
  // is still being rescanned. Its own freeze does not block a different
  // candidate: promoting a Critical-clean replacement is how a freeze is fixed.
  if (required.has("deployed-rescan")) {
    if (!coverage) {
      blockers.push({
        code: "deployed-rescan-missing",
        message: "deployed-digest rescan coverage for the candidate environment is unknown"
      });
    } else if (coverage.deployedDigest !== undefined) {
      const rescan =
        coverage.rescan?.digest === coverage.deployedDigest &&
        coverage.rescan.environment === candidate.environment
          ? coverage.rescan
          : undefined;
      const observedAt = Date.parse(rescan?.observedAt ?? "");
      if (
        !rescan ||
        !Number.isFinite(observedAt) ||
        now.getTime() - observedAt > RELEASE_RESCAN_MAX_AGE_HOURS * 3_600_000
      ) {
        blockers.push({
          code: "deployed-rescan-missing",
          message:
            `no verified rescan of the digest deployed in ${candidate.environment} ` +
            `within ${RELEASE_RESCAN_MAX_AGE_HOURS} hours`,
          ref: rescan?.ref
        });
      } else if (!rescan.artifactAccepted || rescan.criticalFindings < 0) {
        blockers.push({
          code: "deployed-rescan-failed",
          message: "the deployed-digest rescan was not fully reconciled",
          ref: rescan.ref
        });
      }
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
    const scanScope = new Map<
      string,
      { source: ReleaseFindingSource; scanType: string; inScope: number; stale: number }
    >();
    let malformed = 0;
    for (const test of dojo.tests) {
      if (!Number.isSafeInteger(test?.id)) {
        malformed += 1;
        continue;
      }
      const tags = lowerTags(test.tags);
      testTags.set(test.id, tags);
      const tagSet = new Set(tags);
      const scope = findingScope(tagSet, candidate);
      if (scope === "other-repository") continue;
      const source = findingSource(tagSet);
      const scanType = String(test.scan_type ?? "");
      const key = `${source}\u241f${scanType}`;
      const entry = scanScope.get(key) ?? { source, scanType, inScope: 0, stale: 0 };
      if (scope === "in-scope") entry.inScope += 1;
      if (scope === "other-commit") entry.stale += 1;
      scanScope.set(key, entry);
    }
    // GuardianBot reimports into one Test per engagement and scan type, and
    // DefectDojo replaces a Test's tags on reimport. A commit-scoped scan type
    // whose Tests all name another commit no longer describes the candidate.
    // Its findings for the candidate are then known only from the candidate
    // commit's own accepted summaries: a summary that is clean at every
    // blocking severity stands in for it, anything else fails closed. Older
    // Tests beside an in-scope Test of the same scan type are history and stay
    // out of scope. DAST Tests are digest and environment scoped, describe
    // only digests already deployed, and are never required.
    const proven = new Set<ReleaseFindingSource>();
    const unproven = new Set<ReleaseFindingSource>();
    for (const entry of scanScope.values()) {
      if (entry.source === "dast" || entry.stale === 0 || entry.inScope > 0) continue;
      const proof = commitScanProof(entry.source, entry.scanType, evidence, candidate, policy);
      if (proof) {
        proven.add(entry.source);
        evidenceRefs.push({ kind: "commit-scan", ref: proof, status: "success" });
        continue;
      }
      unproven.add(entry.source);
      blockers.push({
        code: "defectdojo-scope-missing",
        message:
          `a DefectDojo ${entry.source} import was last reimported for another commit, ` +
          "and no clean scan summary of the candidate commit stands in for it",
        source: entry.source
      });
    }
    for (const source of ["sast", "image"] as const) {
      const entries = [...scanScope.values()].filter((entry) => entry.source === source);
      if (
        !entries.some((entry) => entry.inScope > 0) &&
        !proven.has(source) &&
        !unproven.has(source)
      ) {
        blockers.push({
          code: "defectdojo-scope-missing",
          message: `DefectDojo has no ${source} import scoped to the candidate`,
          source
        });
      }
    }
    const findings = new Map<number, ReleaseDojoFinding>();
    for (const finding of [...dojo.findings, ...dojo.acceptedFindings]) {
      if (!Number.isSafeInteger(finding?.id) || !Number.isSafeInteger(finding?.test)) {
        malformed += 1;
        continue;
      }
      const existing = findings.get(finding.id);
      // Prefer the record that carries risk-acceptance detail.
      if (!existing || (finding.accepted_risks?.length ?? 0) > (existing.accepted_risks?.length ?? 0)) {
        findings.set(finding.id, finding);
      }
    }
    const blocking = new Set<string>(policy.blockingSeverities);
    for (const finding of [...findings.values()].sort((left, right) => left.id - right.id)) {
      // Scope comes only from the Test GuardianBot imported. Finding tags are
      // editable in DefectDojo and must not move a finding out of scope.
      const tags = new Set(testTags.get(finding.test) ?? []);
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
      // Only DefectDojo's own risk_accepted state opens the exception path; an
      // acceptance history on a finding that is no longer accepted is ignored.
      const accepted = finding.risk_accepted === true;
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
    if (malformed) {
      blockers.push({
        code: "gate-unavailable",
        message: "DefectDojo returned malformed Tests or findings"
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
