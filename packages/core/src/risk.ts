export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const riskPatterns = [
  /(^|\/)auth/i,
  /(^|\/)security/i,
  /tenant/i,
  /secret/i,
  /crypt/i,
  /migration/i,
  /^\.github\/workflows\//,
  /Dockerfile/i,
  /(openapi|swagger)/i,
  /(permission|authorization|rbac)/i
];

export function scoreChangeRisk(
  files: ChangedFile[],
  hasHighScannerFinding: boolean
): {
  score: number;
  effort: 1 | 2 | 3 | 4 | 5;
  highRisk: boolean;
  partial: boolean;
  reasons: string[];
} {
  const lines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const riskyFiles = files.filter((file) =>
    riskPatterns.some((pattern) => pattern.test(file.path))
  );
  const reasons: string[] = [];
  let score = Math.min(35, Math.round(lines / 20));
  if (riskyFiles.length) {
    score += Math.min(40, riskyFiles.length * 10);
    reasons.push(`${riskyFiles.length} high-risk path(s) changed`);
  }
  if (hasHighScannerFinding) {
    score += 30;
    reasons.push("deterministic scanner reported a High/Critical finding");
  }
  if (lines > 500) reasons.push(`${lines} changed lines`);
  const partial = files.length > 50 || lines > 5000;
  if (partial) {
    score += 10;
    reasons.push("review scope exceeds the full-review limit");
  }
  score = Math.min(100, score);
  const effort = Math.max(
    1,
    Math.min(5, Math.ceil((files.length + lines / 250) / 4))
  ) as 1 | 2 | 3 | 4 | 5;
  return {
    score,
    effort,
    highRisk: score >= 60 || riskyFiles.length > 0 || hasHighScannerFinding,
    partial,
    reasons
  };
}

