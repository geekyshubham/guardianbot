import { stableFingerprint } from "./fingerprint.js";

export type NormalizedSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface NormalizedFinding {
  source: "semgrep" | "trivy" | "zap";
  fingerprint: string;
  ruleId: string;
  severity: NormalizedSeverity;
  title: string;
  description: string;
  path?: string;
  line?: number;
  packageName?: string;
  installedVersion?: string;
  fixedVersion?: string;
}

const semgrepSeverity: Record<string, NormalizedSeverity> = {
  ERROR: "high",
  WARNING: "medium",
  INFO: "info",
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low"
};

export function normalizeSemgrep(report: unknown): NormalizedFinding[] {
  const results = (report as { results?: Array<Record<string, unknown>> })?.results ?? [];
  return results.map((entry) => {
    const extra = (entry.extra ?? {}) as Record<string, unknown>;
    const metadata = (extra.metadata ?? {}) as Record<string, unknown>;
    const start = (entry.start ?? {}) as Record<string, unknown>;
    const ruleId = String(entry.check_id ?? "unknown");
    const path = String(entry.path ?? "");
    const line = Number(start.line ?? 1);
    const severity = semgrepSeverity[String(extra.severity ?? "WARNING").toUpperCase()] ?? "medium";
    const title = String(extra.message ?? ruleId);
    return {
      source: "semgrep",
      fingerprint: stableFingerprint(["semgrep", ruleId, path, line, title]),
      ruleId,
      severity,
      title,
      description: String(metadata.impact ?? title),
      path,
      line
    };
  });
}

const trivySeverity: Record<string, NormalizedSeverity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNKNOWN: "info"
};

export function normalizeTrivy(report: unknown): NormalizedFinding[] {
  const results = (report as { Results?: Array<Record<string, unknown>> })?.Results ?? [];
  const findings: NormalizedFinding[] = [];
  for (const result of results) {
    const target = String(result.Target ?? "");
    const vulnerabilities =
      (result.Vulnerabilities as Array<Record<string, unknown>> | undefined) ?? [];
    for (const vulnerability of vulnerabilities) {
      const ruleId = String(vulnerability.VulnerabilityID ?? "unknown");
      const packageName = String(vulnerability.PkgName ?? "");
      const installedVersion = String(vulnerability.InstalledVersion ?? "");
      const fixedVersion = String(vulnerability.FixedVersion ?? "");
      const title = String(vulnerability.Title ?? ruleId);
      findings.push({
        source: "trivy",
        fingerprint: stableFingerprint([
          "trivy",
          ruleId,
          packageName,
          installedVersion,
          target
        ]),
        ruleId,
        severity:
          trivySeverity[String(vulnerability.Severity ?? "UNKNOWN").toUpperCase()] ??
          "info",
        title,
        description: String(vulnerability.Description ?? title),
        path: target,
        packageName,
        installedVersion,
        fixedVersion
      });
    }
  }
  return findings;
}

export interface GateDecision {
  conclusion: "success" | "failure";
  blockers: NormalizedFinding[];
  observed: NormalizedFinding[];
  reason: string;
}

export function evaluateGate(options: {
  findings: NormalizedFinding[];
  baselineFingerprints: Set<string>;
  mode: "advisory" | "report-only" | "enforce";
  suppressedFingerprints?: Set<string>;
}): GateDecision {
  const suppressed = options.suppressedFingerprints ?? new Set<string>();
  const introduced = options.findings.filter(
    (finding) =>
      !options.baselineFingerprints.has(finding.fingerprint) &&
      !suppressed.has(finding.fingerprint)
  );
  const blockers = introduced.filter((finding) => {
    if (finding.source === "semgrep") {
      return finding.severity === "critical" || finding.severity === "high";
    }
    if (finding.source === "trivy") {
      return (
        (finding.severity === "critical" || finding.severity === "high") &&
        Boolean(finding.fixedVersion)
      );
    }
    return false;
  });
  if (options.mode !== "enforce") {
    return {
      conclusion: "success",
      blockers,
      observed: introduced,
      reason: `${options.mode} mode: ${blockers.length} qualifying blocker(s) observed`
    };
  }
  return {
    conclusion: blockers.length ? "failure" : "success",
    blockers,
    observed: introduced,
    reason: blockers.length
      ? `${blockers.length} newly introduced qualifying finding(s)`
      : "No newly introduced qualifying findings"
  };
}

