import type { MonitoringClock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { MonitoringCheckResult, MonitoringStatus } from "./status.js";
import { worstMonitoringStatus } from "./status.js";

export type EvidenceKind =
  | "semgrep"
  | "trivy"
  | "zap-smoke"
  | "zap-nightly"
  | "defectdojo-import"
  | "sbom"
  | "signature"
  | "deployment";

export interface EvidenceRecord {
  kind: EvidenceKind;
  observedAt: string;
  status: "success" | "failure";
  digest?: string;
  environment?: string;
  details?: string;
}

export interface EvidenceRequirement {
  key: string;
  kind: EvidenceKind;
  required: boolean;
  maxAgeMs: number;
  digest?: string;
  environment?: string;
  label?: string;
}

export interface EvidenceReconciliation {
  status: MonitoringStatus;
  checks: MonitoringCheckResult[];
  missingCount: number;
}

function evidenceMetadata(
  requirement: EvidenceRequirement,
  match?: EvidenceRecord | null
): Record<string, boolean | number | string | null> {
  return {
    kind: requirement.kind,
    digest: match?.digest ?? requirement.digest ?? null,
    environment: match?.environment ?? requirement.environment ?? null,
    required: requirement.required,
    details: match?.details ?? null
  };
}

function latestMatchingEvidence(
  requirement: EvidenceRequirement,
  evidence: EvidenceRecord[]
): EvidenceRecord | null {
  const matches = evidence.filter(
    (item) =>
      item.kind === requirement.kind &&
      (requirement.digest ? item.digest === requirement.digest : true) &&
      (requirement.environment ? item.environment === requirement.environment : true)
  );
  if (!matches.length) return null;
  return matches.sort(
    (left, right) =>
      new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime()
  )[0] ?? null;
}

export function reconcileEvidence(
  requirements: EvidenceRequirement[],
  evidence: EvidenceRecord[],
  clock: MonitoringClock = systemClock
): EvidenceReconciliation {
  const checks = requirements.map((requirement) => {
    const match = latestMatchingEvidence(requirement, evidence);
    const label = requirement.label ?? requirement.kind;
    if (!match) {
      return {
        key: requirement.key,
        status: requirement.required ? "failing" : "not-applicable",
        summary: requirement.required
          ? `${label} evidence is missing`
          : `${label} evidence is not required`,
        metadata: evidenceMetadata(requirement)
      } satisfies MonitoringCheckResult;
    }

    const observedAt = new Date(match.observedAt);
    if (Number.isNaN(observedAt.getTime())) {
      return {
        key: requirement.key,
        status: "failing",
        summary: `${label} evidence timestamp is invalid`,
        observedAt: match.observedAt,
        metadata: evidenceMetadata(requirement, match)
      } satisfies MonitoringCheckResult;
    }

    const ageMs = Math.max(0, clock.now().getTime() - observedAt.getTime());
    if (match.status === "failure") {
      return {
        key: requirement.key,
        status: "failing",
        summary: `${label} evidence recorded a failed execution`,
        observedAt: observedAt.toISOString(),
        ageMs,
        metadata: evidenceMetadata(requirement, match)
      } satisfies MonitoringCheckResult;
    }

    if (ageMs > requirement.maxAgeMs) {
      return {
        key: requirement.key,
        status: requirement.required ? "warning" : "not-applicable",
        summary: `${label} evidence is stale`,
        observedAt: observedAt.toISOString(),
        ageMs,
        metadata: evidenceMetadata(requirement, match)
      } satisfies MonitoringCheckResult;
    }

    return {
      key: requirement.key,
      status: "passing",
      summary: `${label} evidence is current`,
      observedAt: observedAt.toISOString(),
      ageMs,
      metadata: evidenceMetadata(requirement, match)
    } satisfies MonitoringCheckResult;
  });

  return {
    status: worstMonitoringStatus(checks.map((check) => check.status)),
    checks,
    missingCount: checks.filter((check) => check.summary.endsWith("is missing")).length
  };
}

export interface ImageEvidenceInput {
  digest: string;
  deployedDigest?: string | null;
  environment: string;
  sbomMaxAgeMs: number;
  signatureMaxAgeMs: number;
  deploymentMaxAgeMs: number;
  scanMaxAgeMs?: number;
  dastMaxAgeMs?: number;
  evidence: EvidenceRecord[];
  requireScans?: boolean;
  requireDast?: boolean;
}

export function evaluateImageEvidence(
  input: ImageEvidenceInput,
  clock: MonitoringClock = systemClock
): EvidenceReconciliation {
  const requirements: EvidenceRequirement[] = [
    {
      key: "image-sbom",
      kind: "sbom",
      required: true,
      maxAgeMs: input.sbomMaxAgeMs,
      digest: input.digest,
      environment: input.environment,
      label: "SBOM"
    },
    {
      key: "image-signature",
      kind: "signature",
      required: true,
      maxAgeMs: input.signatureMaxAgeMs,
      digest: input.digest,
      environment: input.environment,
      label: "Signature"
    },
    {
      key: "image-deployment",
      kind: "deployment",
      required: true,
      maxAgeMs: input.deploymentMaxAgeMs,
      digest: input.digest,
      environment: input.environment,
      label: "Deployment"
    },
    {
      key: "image-trivy",
      kind: "trivy",
      required: input.requireScans ?? true,
      maxAgeMs: input.scanMaxAgeMs ?? input.deploymentMaxAgeMs,
      digest: input.digest,
      environment: input.environment,
      label: "Image scan"
    },
    {
      key: "image-zap",
      kind: "zap-nightly",
      required: input.requireDast ?? false,
      maxAgeMs: input.dastMaxAgeMs ?? input.deploymentMaxAgeMs,
      digest: input.digest,
      environment: input.environment,
      label: "DAST"
    }
  ];

  const reconciliation = reconcileEvidence(requirements, input.evidence, clock);
  if (input.deployedDigest && input.deployedDigest !== input.digest) {
    return {
      status: "failing",
      missingCount: reconciliation.missingCount,
      checks: [
        {
          key: "deployed-digest",
          status: "failing",
          summary: "Deployed digest does not match the expected immutable digest",
          metadata: {
            expectedDigest: input.digest,
            deployedDigest: input.deployedDigest
          }
        },
        ...reconciliation.checks
      ]
    };
  }
  return reconciliation;
}
