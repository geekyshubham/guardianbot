import { stableFingerprint } from "./fingerprint.js";

export type NormalizedSeverity = "critical" | "high" | "medium" | "low" | "info";
export type NormalizedTrivyClass =
  | "vulnerability"
  | "misconfiguration"
  | "secret"
  | "license";

export interface NormalizedFinding {
  source: "semgrep" | "trivy" | "zap";
  fingerprint: string;
  ruleId: string;
  severity: NormalizedSeverity;
  title: string;
  description: string;
  scannerClass?: NormalizedTrivyClass;
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

const MAX_SUMMARY_LENGTH = 500;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, fallback: string): string {
  const normalized = String(value ?? fallback).replace(/\s+/g, " ").trim();
  const text = normalized || fallback;
  return text.slice(0, MAX_SUMMARY_LENGTH);
}

function normalizedLine(value: unknown): number | undefined {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
}

export function normalizeTrivy(report: unknown): NormalizedFinding[] {
  const results = recordList(asRecord(report)?.Results);
  const findings: NormalizedFinding[] = [];
  for (const result of results) {
    const target = String(result.Target ?? "");
    const vulnerabilities = recordList(result.Vulnerabilities);
    for (const vulnerability of vulnerabilities) {
      const ruleId = String(vulnerability.VulnerabilityID ?? "unknown");
      const packageName = String(vulnerability.PkgName ?? "");
      const installedVersion = String(vulnerability.InstalledVersion ?? "");
      const fixedVersion = String(vulnerability.FixedVersion ?? "");
      const title = boundedText(vulnerability.Title, ruleId);
      findings.push({
        source: "trivy",
        scannerClass: "vulnerability",
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
        description: boundedText(vulnerability.Description, title),
        path: target,
        packageName,
        installedVersion,
        fixedVersion
      });
    }
    const misconfigurations = recordList(result.Misconfigurations);
    for (const misconfiguration of misconfigurations) {
      const causeMetadata = asRecord(misconfiguration.CauseMetadata);
      const ruleId = String(
        misconfiguration.AVDID ||
          misconfiguration.ID ||
          misconfiguration.Type ||
          "unknown"
      );
      const line = normalizedLine(causeMetadata?.StartLine);
      const title = boundedText(
        misconfiguration.Title ?? misconfiguration.Message,
        ruleId
      );
      findings.push({
        source: "trivy",
        scannerClass: "misconfiguration",
        fingerprint: stableFingerprint([
          "trivy",
          "misconfiguration",
          ruleId,
          target,
          String(causeMetadata?.Resource ?? ""),
          line ?? "",
          normalizedLine(causeMetadata?.EndLine) ?? ""
        ]),
        ruleId,
        severity:
          trivySeverity[String(misconfiguration.Severity ?? "UNKNOWN").toUpperCase()] ??
          "info",
        title,
        description: boundedText(
          misconfiguration.Description ??
            misconfiguration.Message ??
            misconfiguration.Resolution,
          title
        ),
        path: target,
        line
      });
    }
    const secrets = recordList(result.Secrets);
    for (const secret of secrets) {
      const ruleId = String(secret.RuleID ?? secret.Category ?? "secret");
      const line = normalizedLine(secret.StartLine);
      const endLine = normalizedLine(secret.EndLine);
      const category = String(secret.Category ?? "").trim();
      const title = category ? `Potential ${category} secret` : `Potential secret: ${ruleId}`;
      findings.push({
        source: "trivy",
        scannerClass: "secret",
        fingerprint: stableFingerprint([
          "trivy",
          "secret",
          ruleId,
          category,
          target,
          line ?? "",
          endLine ?? ""
        ]),
        ruleId,
        severity: trivySeverity[String(secret.Severity ?? "UNKNOWN").toUpperCase()] ?? "info",
        title,
        description: boundedText(
          category
            ? `Potential ${category} secret detected by Trivy`
            : `Potential secret detected by Trivy rule ${ruleId}`,
          title
        ),
        path: target,
        line
      });
    }
    const licenses = recordList(result.Licenses);
    for (const license of licenses) {
      const packageName = String(license.PkgName ?? "");
      const installedVersion = String(license.InstalledVersion ?? "");
      const licenseName = String(license.Name ?? license.Category ?? "unknown-license");
      findings.push({
        source: "trivy",
        scannerClass: "license",
        fingerprint: stableFingerprint([
          "trivy",
          "license",
          packageName,
          installedVersion,
          licenseName,
          target
        ]),
        ruleId: licenseName,
        severity: trivySeverity[String(license.Severity ?? "UNKNOWN").toUpperCase()] ?? "info",
        title: boundedText(licenseName, "unknown-license"),
        description: boundedText(
          license.Category
            ? `License classification ${license.Category}`
            : `Detected license ${licenseName}`,
          licenseName
        ),
        path: target,
        packageName,
        installedVersion
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
      const scannerClass = finding.scannerClass ?? "vulnerability";
      if (scannerClass === "license") {
        return false;
      }
      if (scannerClass === "misconfiguration" || scannerClass === "secret") {
        return finding.severity === "critical" || finding.severity === "high";
      }
      return (
        (finding.severity === "critical" || finding.severity === "high") &&
        Boolean(finding.fixedVersion?.trim())
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
