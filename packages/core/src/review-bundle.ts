import { createHash } from "node:crypto";
import type {
  ReviewContextChunk,
  ReviewRequest,
  ScannerEvidence
} from "@guardianbot/protocol";

export type ReviewBundleRule = ReviewRequest["rules"][number];

export interface ReviewBundleContextCandidate {
  id: string;
  path: string;
  kind: ReviewContextChunk["kind"];
  content: string;
  priority?: number;
}

export interface ReviewBundleScannerCandidate extends ScannerEvidence {
  priority?: number;
}

export interface ReviewBundleRuleCandidate extends ReviewBundleRule {
  priority?: number;
}

export interface ReviewBundleInput {
  contexts?: ReviewBundleContextCandidate[];
  scannerEvidence?: ReviewBundleScannerCandidate[];
  rules?: ReviewBundleRuleCandidate[];
  maxInputCharacters?: number;
  maxContextChunks?: number;
  maxScannerEvidence?: number;
  maxRules?: number;
}

export type ReviewBundleDropReason =
  | "duplicate"
  | "character-budget"
  | "context-limit"
  | "scanner-limit"
  | "rule-limit";

export interface ReviewBundleDrop {
  type: "context" | "scanner" | "rule";
  id: string;
  reason: ReviewBundleDropReason;
}

export interface ReviewBundle {
  contexts: ReviewContextChunk[];
  scannerEvidence: ScannerEvidence[];
  rules: ReviewBundleRule[];
  manifestSha256: string;
  totalCharacters: number;
  partial: boolean;
  dropped: ReviewBundleDrop[];
}

const DEFAULT_MAX_INPUT_CHARACTERS = 180_000;
const DEFAULT_MAX_CONTEXT_CHUNKS = 40;
const DEFAULT_MAX_SCANNER_EVIDENCE = 24;
const DEFAULT_MAX_RULES = 24;

const contextKindWeight: Record<ReviewContextChunk["kind"], number> = {
  diff: 100,
  scanner: 95,
  caller: 92,
  callee: 91,
  test: 89,
  config: 87,
  schema: 86,
  history: 72,
  issue: 68
};

const severityWeight: Record<NonNullable<ScannerEvidence["severity"]>, number> = {
  critical: 18,
  high: 14,
  medium: 10,
  low: 6,
  info: 2
};

const ruleSeverityWeight: Record<NonNullable<ReviewBundleRule["severity"]>, number> = {
  P0: 20,
  P1: 16,
  P2: 12,
  P3: 8
};

interface RankedContextItem {
  type: "context";
  id: string;
  stableKey: string;
  score: number;
  cost: number;
  value: ReviewContextChunk;
}

interface RankedScannerItem {
  type: "scanner";
  id: string;
  stableKey: string;
  score: number;
  cost: number;
  value: ScannerEvidence;
}

interface RankedRuleItem {
  type: "rule";
  id: string;
  stableKey: string;
  score: number;
  cost: number;
  value: ReviewBundleRule;
}

type RankedItem = RankedContextItem | RankedScannerItem | RankedRuleItem;

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
}

export function wrapUntrustedContext(candidate: ReviewBundleContextCandidate): string {
  const content = normalizeText(candidate.content);
  return [
    `[guardianbot-untrusted-data path="${candidate.path}" kind="${candidate.kind}"]`,
    "[begin-content]",
    content,
    "[end-content]"
  ].join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareRankedItems(left: RankedItem, right: RankedItem): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return left.stableKey.localeCompare(right.stableKey);
}

function contextScore(candidate: ReviewBundleContextCandidate): number {
  return (contextKindWeight[candidate.kind] ?? 0) + (candidate.priority ?? 0);
}

function scannerScore(candidate: ReviewBundleScannerCandidate): number {
  return 84 + (severityWeight[candidate.severity] ?? 0) + (candidate.priority ?? 0);
}

function ruleScore(candidate: ReviewBundleRuleCandidate): number {
  const severity = candidate.severity ? ruleSeverityWeight[candidate.severity] : 10;
  return 78 + severity + (candidate.priority ?? 0);
}

function contextCost(chunk: ReviewContextChunk): number {
  return chunk.id.length + chunk.path.length + chunk.kind.length + chunk.content.length + chunk.sha256.length;
}

function scannerCost(evidence: ScannerEvidence): number {
  return JSON.stringify(evidence).length;
}

function ruleCost(rule: ReviewBundleRule): number {
  return JSON.stringify(rule).length;
}

function buildContextItem(candidate: ReviewBundleContextCandidate): RankedContextItem {
  const content = wrapUntrustedContext(candidate);
  const value: ReviewContextChunk = {
    id: candidate.id,
    path: candidate.path,
    kind: candidate.kind,
    content,
    sha256: sha256(content)
  };
  return {
    type: "context",
    id: candidate.id,
    stableKey: `${candidate.kind}\u0000${candidate.path}\u0000${candidate.id}`,
    score: contextScore(candidate),
    cost: contextCost(value),
    value
  };
}

function buildScannerItem(candidate: ReviewBundleScannerCandidate): RankedScannerItem {
  const value: ScannerEvidence = {
    source: candidate.source,
    fingerprint: candidate.fingerprint,
    ruleId: candidate.ruleId,
    severity: candidate.severity,
    path: candidate.path,
    line: candidate.line,
    summary: normalizeText(candidate.summary)
  };
  return {
    type: "scanner",
    id: candidate.fingerprint,
    stableKey: `${candidate.source}\u0000${candidate.ruleId}\u0000${candidate.fingerprint}`,
    score: scannerScore(candidate),
    cost: scannerCost(value),
    value
  };
}

function buildRuleItem(candidate: ReviewBundleRuleCandidate): RankedRuleItem {
  const value: ReviewBundleRule = {
    id: candidate.id,
    instruction: normalizeText(candidate.instruction),
    paths: candidate.paths ? [...candidate.paths] : undefined,
    severity: candidate.severity
  };
  return {
    type: "rule",
    id: candidate.id,
    stableKey: `${candidate.id}\u0000${value.severity ?? ""}\u0000${value.paths?.join(",") ?? ""}`,
    score: ruleScore(candidate),
    cost: ruleCost(value),
    value
  };
}

function canonicalBundleManifest(bundle: Omit<ReviewBundle, "manifestSha256">): string {
  return JSON.stringify({
    version: 1,
    partial: bundle.partial,
    totalCharacters: bundle.totalCharacters,
    contexts: bundle.contexts.map((chunk) => ({
      id: chunk.id,
      path: chunk.path,
      kind: chunk.kind,
      sha256: chunk.sha256
    })),
    scannerEvidence: bundle.scannerEvidence.map((evidence) => ({
      source: evidence.source,
      fingerprint: evidence.fingerprint,
      ruleId: evidence.ruleId,
      severity: evidence.severity,
      path: evidence.path ?? null,
      line: evidence.line ?? null,
      summary: evidence.summary
    })),
    rules: bundle.rules.map((rule) => ({
      id: rule.id,
      instruction: rule.instruction,
      paths: rule.paths ?? [],
      severity: rule.severity ?? null
    }))
  });
}

export function buildReviewBundle(input: ReviewBundleInput): ReviewBundle {
  const maxInputCharacters = input.maxInputCharacters ?? DEFAULT_MAX_INPUT_CHARACTERS;
  const maxContextChunks = input.maxContextChunks ?? DEFAULT_MAX_CONTEXT_CHUNKS;
  const maxScannerEvidence = input.maxScannerEvidence ?? DEFAULT_MAX_SCANNER_EVIDENCE;
  const maxRules = input.maxRules ?? DEFAULT_MAX_RULES;

  const dropped: ReviewBundleDrop[] = [];
  const selectedContexts: ReviewContextChunk[] = [];
  const selectedScannerEvidence: ScannerEvidence[] = [];
  const selectedRules: ReviewBundleRule[] = [];

  let totalCharacters = 0;
  let contextCount = 0;
  let scannerCount = 0;
  let ruleCount = 0;

  const seen = new Set<string>();
  const rankedItems: RankedItem[] = [];

  for (const candidate of input.contexts ?? []) {
    const item = buildContextItem(candidate);
    const duplicateKey = `${item.type}\u0000${item.value.kind}\u0000${item.value.path}\u0000${item.value.sha256}`;
    if (seen.has(duplicateKey)) {
      dropped.push({ type: "context", id: item.id, reason: "duplicate" });
      continue;
    }
    seen.add(duplicateKey);
    rankedItems.push(item);
  }

  for (const candidate of input.scannerEvidence ?? []) {
    const item = buildScannerItem(candidate);
    const duplicateKey = `${item.type}\u0000${item.value.fingerprint}`;
    if (seen.has(duplicateKey)) {
      dropped.push({ type: "scanner", id: item.id, reason: "duplicate" });
      continue;
    }
    seen.add(duplicateKey);
    rankedItems.push(item);
  }

  for (const candidate of input.rules ?? []) {
    const item = buildRuleItem(candidate);
    const duplicateKey = `${item.type}\u0000${item.value.id}`;
    if (seen.has(duplicateKey)) {
      dropped.push({ type: "rule", id: item.id, reason: "duplicate" });
      continue;
    }
    seen.add(duplicateKey);
    rankedItems.push(item);
  }

  rankedItems.sort(compareRankedItems);

  for (const item of rankedItems) {
    if (item.type === "context" && contextCount >= maxContextChunks) {
      dropped.push({ type: "context", id: item.id, reason: "context-limit" });
      continue;
    }
    if (item.type === "scanner" && scannerCount >= maxScannerEvidence) {
      dropped.push({ type: "scanner", id: item.id, reason: "scanner-limit" });
      continue;
    }
    if (item.type === "rule" && ruleCount >= maxRules) {
      dropped.push({ type: "rule", id: item.id, reason: "rule-limit" });
      continue;
    }
    if (totalCharacters + item.cost > maxInputCharacters) {
      dropped.push({ type: item.type, id: item.id, reason: "character-budget" });
      continue;
    }

    totalCharacters += item.cost;
    if (item.type === "context") {
      selectedContexts.push(item.value);
      contextCount += 1;
    } else if (item.type === "scanner") {
      selectedScannerEvidence.push(item.value);
      scannerCount += 1;
    } else {
      selectedRules.push(item.value);
      ruleCount += 1;
    }
  }

  const partial = dropped.length > 0;
  const manifestInput = {
    contexts: selectedContexts,
    scannerEvidence: selectedScannerEvidence,
    rules: selectedRules,
    totalCharacters,
    partial,
    dropped
  };
  const manifestSha256 = sha256(canonicalBundleManifest(manifestInput));

  return {
    ...manifestInput,
    manifestSha256
  };
}
