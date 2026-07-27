import type { ReviewBundleContextCandidate } from "../review-bundle.js";
import {
  cosineSimilarity,
  lexicalFeatureVector,
  lexicalOverlapScore,
  normalizeSourceText,
  sha256,
  validateEmbeddingVectors
} from "./lexical.js";
import {
  assertIndexReference,
  normalizeRepositoryPath
} from "./storage.js";
import type {
  IndexedHistory,
  IndexedSymbol,
  LocalEmbeddingProvider,
  RepositoryIndex,
  RepositoryVisibility
} from "./types.js";

export interface IndexChangedLineRange {
  start: number;
  end: number;
}

export interface IndexChangedFile {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
  changedLines?: readonly IndexChangedLineRange[];
}

export type SecurityClusterId =
  | "identity-access"
  | "secrets-crypto"
  | "supply-chain"
  | "data-schema"
  | "network-api"
  | "runtime-config";

export interface SecurityReviewCluster {
  id: SecurityClusterId;
  paths: string[];
  reasons: string[];
}

export interface RepositoryReviewScope {
  mode: "full" | "security-clusters";
  partial: boolean;
  totalFiles: number;
  totalLines: number;
  selectedPaths: string[];
  omittedPaths: string[];
  clusters: SecurityReviewCluster[];
  reason?: "file-limit" | "line-limit" | "file-and-line-limit";
}

export interface RepositoryAccessPolicy {
  repositoryScope: string;
  visibility: RepositoryVisibility;
  /**
   * Administrative repository scopes. Repository content cannot modify this
   * list. Related access also requires the other side to list this repository.
   */
  allowedRelatedRepositories: readonly string[];
}

export interface RelatedRepositoryContext {
  index: RepositoryIndex;
  policy: RepositoryAccessPolicy;
}

export type RetrievedContextKind =
  | "changed-symbol"
  | "caller"
  | "callee"
  | "test"
  | "config"
  | "schema"
  | "ownership"
  | "history";

export interface RetrievedRepositoryContext {
  id: string;
  repositoryScope: string;
  commitSha: string;
  source: "primary" | "related";
  path: string;
  line: number;
  kind: RetrievedContextKind;
  content: string;
  contentSha256: string;
  trust: "untrusted-repository-content";
  score: number;
}

export interface RepositoryContextRequest {
  index: RepositoryIndex;
  repositoryScope: string;
  commitSha: string;
  changes: readonly IndexChangedFile[];
  query?: string;
  limit?: number;
  primaryPolicy?: RepositoryAccessPolicy;
  related?: readonly RelatedRepositoryContext[];
  embeddingProvider?: LocalEmbeddingProvider;
}

export interface RepositoryContextResult {
  repositoryScope: string;
  commitSha: string;
  storageKey: string;
  mode: RepositoryReviewScope["mode"];
  partial: boolean;
  scope: RepositoryReviewScope;
  contexts: RetrievedRepositoryContext[];
  droppedContextCount: number;
}

export class RepositoryIsolationError extends Error {
  override readonly name = "RepositoryIsolationError";
}

interface Candidate {
  id: string;
  repositoryScope: string;
  commitSha: string;
  source: RetrievedRepositoryContext["source"];
  path: string;
  line: number;
  kind: RetrievedContextKind;
  content: string;
  contentSha256: string;
  vector: readonly number[];
  index: RepositoryIndex;
  baseScore: number;
}

interface NormalizedChange extends IndexChangedFile {
  path: string;
}

const securityClusters: Array<{
  id: SecurityClusterId;
  pathPatterns: readonly RegExp[];
  patchPatterns: readonly RegExp[];
  reason: string;
}> = [
  {
    id: "identity-access",
    pathPatterns: [
      /(^|\/)(auth|security|permissions?|rbac|acl|session|oauth|sso)(\/|[._-])/i,
      /(tenant|authorization|authentication|identity|access[_-]?control)/i
    ],
    patchPatterns: [/\b(auth|tenant|permission|role|session|token|principal)\b/i],
    reason: "identity or access-control change"
  },
  {
    id: "secrets-crypto",
    pathPatterns: [/(secret|credential|crypto|cipher|encrypt|decrypt|signing|keyring|vault)/i],
    patchPatterns: [
      /\b(secret|credential|private[_ -]?key|encrypt|decrypt|signature|password)\b/i
    ],
    reason: "secret handling or cryptography change"
  },
  {
    id: "supply-chain",
    pathPatterns: [
      /^\.github\/workflows\//i,
      /(^|\/)Dockerfile[^/]*$/i,
      /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|Podfile\.lock)$/i,
      /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Gemfile|Package\.swift)$/i
    ],
    patchPatterns: [/\b(action|workflow|dependency|container|image|registry|artifact)\b/i],
    reason: "build, dependency, or supply-chain change"
  },
  {
    id: "data-schema",
    pathPatterns: [
      /(^|\/)(migrations?|schemas?|models?)(\/|[._-])/i,
      /\.(sql|graphql|prisma)$/i,
      /(openapi|swagger)/i
    ],
    patchPatterns: [/\b(migration|schema|database|query|transaction|serialize)\b/i],
    reason: "data model or schema change"
  },
  {
    id: "network-api",
    pathPatterns: [
      /(^|\/)(api|routes?|controllers?|handlers?|middleware|webhooks?)(\/|[._-])/i,
      /(cors|proxy|gateway|network|socket|http)/i
    ],
    patchPatterns: [/\b(endpoint|request|response|webhook|cors|origin|redirect|url)\b/i],
    reason: "network or API boundary change"
  },
  {
    id: "runtime-config",
    pathPatterns: [
      /(^|\/)(config|settings?|environment|infra|deploy|terraform)(\/|[._-])/i,
      /(^|\/)\.(env|guardianbot)/i,
      /\.(ya?ml|toml|ini)$/i
    ],
    patchPatterns: [/\b(config|environment|feature[_ -]?flag|policy|allowlist)\b/i],
    reason: "runtime configuration or policy change"
  }
];

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeChanges(changes: readonly IndexChangedFile[]): NormalizedChange[] {
  const seen = new Set<string>();
  return changes
    .map((change) => {
      const path = normalizeRepositoryPath(change.path);
      if (seen.has(path)) {
        throw new Error(`duplicate changed path: ${path}`);
      }
      seen.add(path);
      if (
        !Number.isSafeInteger(change.additions) ||
        !Number.isSafeInteger(change.deletions) ||
        change.additions < 0 ||
        change.deletions < 0
      ) {
        throw new Error(`changed line counts must be non-negative integers for ${path}`);
      }
      const changedLines = change.changedLines?.map((range) => {
        if (
          !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 1 ||
          range.end < range.start
        ) {
          throw new Error(`invalid changed line range for ${path}`);
        }
        return { start: range.start, end: range.end };
      });
      return {
        ...change,
        path,
        patch: change.patch ? normalizeSourceText(change.patch) : undefined,
        changedLines
      };
    })
    .sort((left, right) => binaryCompare(left.path, right.path));
}

export function planRepositoryReviewScope(
  changes: readonly IndexChangedFile[]
): RepositoryReviewScope {
  const normalized = normalizeChanges(changes);
  const totalLines = normalized.reduce(
    (sum, change) => sum + change.additions + change.deletions,
    0
  );
  if (!Number.isSafeInteger(totalLines)) {
    throw new Error("aggregate changed line count exceeds the safe integer range");
  }
  const overFileLimit = normalized.length > 50;
  const overLineLimit = totalLines > 5_000;
  const partial = overFileLimit || overLineLimit;
  if (!partial) {
    return {
      mode: "full",
      partial: false,
      totalFiles: normalized.length,
      totalLines,
      selectedPaths: normalized.map((change) => change.path),
      omittedPaths: [],
      clusters: []
    };
  }

  const pathsByCluster = new Map<
    SecurityClusterId,
    { paths: Set<string>; reasons: Set<string> }
  >();
  for (const change of normalized) {
    for (const cluster of securityClusters) {
      const pathMatch = cluster.pathPatterns.some((pattern) => pattern.test(change.path));
      const patchMatch = change.patch
        ? cluster.patchPatterns.some((pattern) => pattern.test(change.patch!))
        : false;
      if (!pathMatch && !patchMatch) continue;
      const grouped = pathsByCluster.get(cluster.id) ?? {
        paths: new Set<string>(),
        reasons: new Set<string>()
      };
      grouped.paths.add(change.path);
      grouped.reasons.add(cluster.reason);
      pathsByCluster.set(cluster.id, grouped);
    }
  }
  const clusters = [...pathsByCluster]
    .map(([id, grouped]): SecurityReviewCluster => ({
      id,
      paths: [...grouped.paths].sort(binaryCompare),
      reasons: [...grouped.reasons].sort(binaryCompare)
    }))
    .sort((left, right) => binaryCompare(left.id, right.id));
  const selected = new Set(clusters.flatMap((cluster) => cluster.paths));
  const selectedPaths = [...selected].sort(binaryCompare);
  return {
    mode: "security-clusters",
    partial: true,
    totalFiles: normalized.length,
    totalLines,
    selectedPaths,
    omittedPaths: normalized
      .map((change) => change.path)
      .filter((path) => !selected.has(path)),
    clusters,
    reason:
      overFileLimit && overLineLimit
        ? "file-and-line-limit"
        : overFileLimit
          ? "file-limit"
          : "line-limit"
  };
}

function assertPolicyMatchesIndex(
  policy: RepositoryAccessPolicy,
  index: RepositoryIndex
): void {
  if (
    policy.repositoryScope !== index.repositoryScope ||
    policy.visibility !== index.visibility
  ) {
    throw new RepositoryIsolationError(
      "repository access policy does not match the indexed repository identity"
    );
  }
}

export function authorizeRelatedRepository(
  primaryIndex: RepositoryIndex,
  primaryPolicy: RepositoryAccessPolicy,
  relatedIndex: RepositoryIndex,
  relatedPolicy: RepositoryAccessPolicy
): void {
  assertPolicyMatchesIndex(primaryPolicy, primaryIndex);
  assertPolicyMatchesIndex(relatedPolicy, relatedIndex);
  if (primaryIndex.repositoryScope === relatedIndex.repositoryScope) {
    throw new RepositoryIsolationError("a repository cannot be added as its own related source");
  }
  if (
    !primaryPolicy.allowedRelatedRepositories.includes(relatedIndex.repositoryScope) ||
    !relatedPolicy.allowedRelatedRepositories.includes(primaryIndex.repositoryScope)
  ) {
    throw new RepositoryIsolationError(
      "related repository retrieval requires an explicit bilateral allowlist"
    );
  }
  if (primaryIndex.visibility === "public" && relatedIndex.visibility !== "public") {
    throw new RepositoryIsolationError(
      "non-public repository context cannot flow into a public repository review"
    );
  }
}

function symbolIntersectsChangedLines(
  symbol: IndexedSymbol,
  change: NormalizedChange
): boolean {
  if (!change.changedLines?.length) return true;
  return change.changedLines.some(
    (range) => symbol.line <= range.end && symbol.endLine >= range.start
  );
}

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|spec|__tests__)(\/|$)/i.test(path) ||
    /(?:^|[._-])(test|spec)\.[^/]+$/i.test(path)
  );
}

function isOwnershipPath(path: string): boolean {
  return /(^|\/)(CODEOWNERS|OWNERS)$/i.test(path);
}

function isSchemaPath(path: string): boolean {
  return (
    /(^|\/)(schemas?|migrations?)(\/|$)/i.test(path) ||
    /\.(sql|graphql|prisma)$/i.test(path) ||
    /(openapi|swagger)/i.test(path)
  );
}

function isConfigPath(path: string): boolean {
  if (isOwnershipPath(path) || isSchemaPath(path)) return false;
  const fileName = path.split("/").at(-1) ?? path;
  return (
    /(^|[._-])(config|settings?|policy)([._-]|$)/i.test(fileName) ||
    /^\.env(?:\.|$)/i.test(fileName) ||
    /^\.guardianbot\//i.test(path) ||
    /\.(ya?ml|toml|ini)$/i.test(path)
  );
}

function candidateFromSymbol(
  index: RepositoryIndex,
  symbol: IndexedSymbol,
  kind: RetrievedContextKind,
  source: Candidate["source"],
  baseScore: number
): Candidate {
  return {
    id: sha256(`${index.repositoryScope}\u0000${symbol.id}\u0000${kind}`),
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    source,
    path: symbol.path,
    line: symbol.line,
    kind,
    content: symbol.content,
    contentSha256: symbol.contentSha256,
    vector: symbol.vector,
    index,
    baseScore
  };
}

function candidateFromHistory(
  index: RepositoryIndex,
  entry: IndexedHistory,
  source: Candidate["source"],
  baseScore: number
): Candidate {
  const content = [
    `Commit: ${entry.commitSha}`,
    entry.path ? `Path: ${entry.path}` : undefined,
    entry.author ? `Author: ${entry.author}` : undefined,
    entry.authoredAt ? `Authored-At: ${entry.authoredAt}` : undefined,
    "",
    entry.summary
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    id: sha256(`${index.repositoryScope}\u0000${entry.id}\u0000history`),
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    source,
    path: entry.path ?? ".guardianbot/history",
    line: 1,
    kind: "history",
    content,
    contentSha256: sha256(content),
    vector: entry.vector,
    index,
    baseScore
  };
}

function addRepositorySupportContexts(
  candidates: Candidate[],
  index: RepositoryIndex,
  source: Candidate["source"],
  baseAdjustment: number
): void {
  for (const symbol of index.symbols) {
    if (isOwnershipPath(symbol.path)) {
      candidates.push(
        candidateFromSymbol(index, symbol, "ownership", source, 76 + baseAdjustment)
      );
    } else if (isSchemaPath(symbol.path)) {
      candidates.push(candidateFromSymbol(index, symbol, "schema", source, 74 + baseAdjustment));
    } else if (isConfigPath(symbol.path)) {
      candidates.push(candidateFromSymbol(index, symbol, "config", source, 72 + baseAdjustment));
    }
  }
}

function primaryCandidates(
  index: RepositoryIndex,
  changes: readonly NormalizedChange[],
  scope: RepositoryReviewScope,
  query: string
): { candidates: Candidate[]; changedNames: Set<string> } {
  const candidates: Candidate[] = [];
  const selectedPaths = new Set(scope.selectedPaths);
  const changesByPath = new Map(changes.map((change) => [change.path, change]));
  const changedSymbols = index.symbols.filter((symbol) => {
    if (!selectedPaths.has(symbol.path)) return false;
    const change = changesByPath.get(symbol.path);
    return change ? symbolIntersectsChangedLines(symbol, change) : false;
  });
  const changedIds = new Set(changedSymbols.map((symbol) => symbol.id));
  const changedNames = new Set(changedSymbols.map((symbol) => symbol.name.toLowerCase()));
  const symbolsById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));

  for (const symbol of changedSymbols) {
    candidates.push(candidateFromSymbol(index, symbol, "changed-symbol", "primary", 110));
  }

  for (const call of index.calls) {
    if (
      call.resolvedSymbolIds.some((symbolId) => changedIds.has(symbolId)) ||
      changedNames.has((call.target.match(/[A-Za-z_$][\w$]*/g)?.at(-1) ?? "").toLowerCase())
    ) {
      const caller = call.callerSymbolId
        ? symbolsById.get(call.callerSymbolId)
        : undefined;
      if (caller && !changedIds.has(caller.id)) {
        candidates.push(candidateFromSymbol(index, caller, "caller", "primary", 96));
      }
    }
    if (call.callerSymbolId && changedIds.has(call.callerSymbolId)) {
      for (const resolvedId of call.resolvedSymbolIds) {
        const callee = symbolsById.get(resolvedId);
        if (callee && !changedIds.has(callee.id)) {
          candidates.push(candidateFromSymbol(index, callee, "callee", "primary", 94));
        }
      }
    }
  }

  for (const symbol of index.symbols) {
    if (!isTestPath(symbol.path)) continue;
    const relatedByName = [...changedNames].some((name) =>
      symbol.content.toLowerCase().includes(name)
    );
    const relatedByCall = index.calls.some(
      (call) =>
        call.callerSymbolId === symbol.id &&
        call.resolvedSymbolIds.some((resolvedId) => changedIds.has(resolvedId))
    );
    if (relatedByName || relatedByCall) {
      candidates.push(candidateFromSymbol(index, symbol, "test", "primary", 90));
    }
  }

  addRepositorySupportContexts(candidates, index, "primary", 0);
  const selectedOrChanged = new Set(scope.selectedPaths);
  const lowerQuery = query.toLowerCase();
  for (const entry of index.history) {
    if (
      (entry.path && selectedOrChanged.has(entry.path)) ||
      [...changedNames].some((name) => entry.summary.toLowerCase().includes(name)) ||
      (lowerQuery && entry.summary.toLowerCase().includes(lowerQuery))
    ) {
      candidates.push(candidateFromHistory(index, entry, "primary", 68));
    }
  }

  return { candidates, changedNames };
}

function relatedCandidates(
  index: RepositoryIndex,
  changedNames: ReadonlySet<string>,
  query: string
): Candidate[] {
  const candidates: Candidate[] = [];
  const relevantSymbols = index.symbols.filter((symbol) => {
    if (changedNames.has(symbol.name.toLowerCase())) return true;
    const lowerContent = symbol.content.toLowerCase();
    if ([...changedNames].some((name) => lowerContent.includes(name))) return true;
    return query ? lexicalOverlapScore(query, symbol.content) > 0 : false;
  });
  const relevantIds = new Set(relevantSymbols.map((symbol) => symbol.id));
  const symbolsById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  for (const symbol of relevantSymbols) {
    candidates.push(
      candidateFromSymbol(
        index,
        symbol,
        isTestPath(symbol.path) ? "test" : "callee",
        "related",
        isTestPath(symbol.path) ? 63 : 66
      )
    );
  }
  for (const call of index.calls) {
    if (!call.resolvedSymbolIds.some((id) => relevantIds.has(id))) continue;
    const caller = call.callerSymbolId ? symbolsById.get(call.callerSymbolId) : undefined;
    if (caller && !relevantIds.has(caller.id)) {
      candidates.push(candidateFromSymbol(index, caller, "caller", "related", 64));
    }
  }
  addRepositorySupportContexts(candidates, index, "related", -18);
  for (const entry of index.history) {
    if (
      [...changedNames].some((name) => entry.summary.toLowerCase().includes(name)) ||
      (query && lexicalOverlapScore(query, entry.summary) > 0)
    ) {
      candidates.push(candidateFromHistory(index, entry, "related", 45));
    }
  }
  return candidates;
}

async function queryVectorForProvider(
  provider: LocalEmbeddingProvider | undefined,
  query: string
): Promise<readonly number[] | undefined> {
  if (!provider || !query) return undefined;
  if (
    provider.locality !== "local" ||
    provider.deterministic !== true ||
    !provider.id.trim() ||
    !["local-model", "lexical-fallback"].includes(provider.kind) ||
    !Number.isSafeInteger(provider.dimensions) ||
    provider.dimensions < 1 ||
    provider.dimensions > 65_536
  ) {
    throw new Error("retrieval embedding provider must satisfy the local deterministic contract");
  }
  const vectors = validateEmbeddingVectors(
    await provider.embed([query]),
    1,
    provider.dimensions
  );
  return vectors[0];
}

function candidateRelevance(
  candidate: Candidate,
  query: string,
  provider: LocalEmbeddingProvider | undefined,
  providerQueryVector: readonly number[] | undefined
): number {
  if (!query) return 0;
  if (
    provider &&
    providerQueryVector &&
    provider.id === candidate.index.embedding.providerId &&
    provider.kind === candidate.index.embedding.kind &&
    provider.dimensions === candidate.index.embedding.dimensions
  ) {
    return cosineSimilarity(providerQueryVector, candidate.vector);
  }
  if (candidate.index.embedding.kind === "lexical-fallback") {
    return cosineSimilarity(
      lexicalFeatureVector(query, candidate.index.embedding.dimensions),
      candidate.vector
    );
  }
  // Do not compare a lexical feature hash to local-model vectors. If the local
  // model is unavailable, use direct token overlap and label no score semantic.
  return lexicalOverlapScore(query, candidate.content);
}

export async function retrieveRepositoryContext(
  request: RepositoryContextRequest
): Promise<RepositoryContextResult> {
  assertIndexReference(request.index, {
    repositoryScope: request.repositoryScope,
    commitSha: request.commitSha
  });
  const limit = request.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("repository context limit must be between 1 and 200");
  }
  const related = request.related ?? [];
  if (related.length > 20) {
    throw new RepositoryIsolationError("at most 20 explicitly related repositories may be queried");
  }
  if (related.length && !request.primaryPolicy) {
    throw new RepositoryIsolationError(
      "related repository retrieval requires an explicit primary access policy"
    );
  }
  if (request.primaryPolicy) {
    assertPolicyMatchesIndex(request.primaryPolicy, request.index);
  }

  const normalizedChanges = normalizeChanges(request.changes);
  const scope = planRepositoryReviewScope(normalizedChanges);
  const query = normalizeSourceText(request.query ?? "").slice(0, 4_000);
  const primary = primaryCandidates(request.index, normalizedChanges, scope, query);
  const candidates = [...primary.candidates];

  const seenRelatedScopes = new Set<string>();
  for (const relatedSource of related) {
    if (seenRelatedScopes.has(relatedSource.index.repositoryScope)) {
      throw new RepositoryIsolationError("duplicate related repository scope");
    }
    seenRelatedScopes.add(relatedSource.index.repositoryScope);
    authorizeRelatedRepository(
      request.index,
      request.primaryPolicy!,
      relatedSource.index,
      relatedSource.policy
    );
    assertIndexReference(relatedSource.index, relatedSource.index);
    candidates.push(...relatedCandidates(relatedSource.index, primary.changedNames, query));
  }

  const providerQueryVector = await queryVectorForProvider(
    request.embeddingProvider,
    query
  );
  const unique = new Map<string, Candidate & { score: number }>();
  for (const candidate of candidates) {
    const score =
      candidate.baseScore +
      candidateRelevance(
        candidate,
        query,
        request.embeddingProvider,
        providerQueryVector
      ) *
        20;
    const existing = unique.get(candidate.id);
    if (!existing || score > existing.score) {
      unique.set(candidate.id, { ...candidate, score });
    }
  }
  const ranked = [...unique.values()].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return binaryCompare(
      `${left.repositoryScope}\u0000${left.kind}\u0000${left.path}\u0000${String(left.line).padStart(10, "0")}\u0000${left.id}`,
      `${right.repositoryScope}\u0000${right.kind}\u0000${right.path}\u0000${String(right.line).padStart(10, "0")}\u0000${right.id}`
    );
  });
  const selected = ranked.slice(0, limit);
  return {
    repositoryScope: request.index.repositoryScope,
    commitSha: request.index.commitSha,
    storageKey: request.index.storageKey,
    mode: scope.mode,
    partial: scope.partial || ranked.length > limit,
    scope,
    contexts: selected.map(
      (candidate): RetrievedRepositoryContext => ({
        id: candidate.id,
        repositoryScope: candidate.repositoryScope,
        commitSha: candidate.commitSha,
        source: candidate.source,
        path: candidate.path,
        line: candidate.line,
        kind: candidate.kind,
        content: candidate.content,
        contentSha256: candidate.contentSha256,
        trust: "untrusted-repository-content",
        score: candidate.score
      })
    ),
    droppedContextCount: Math.max(0, ranked.length - selected.length)
  };
}

const reviewKindByRetrievedKind: Record<
  RetrievedContextKind,
  ReviewBundleContextCandidate["kind"]
> = {
  "changed-symbol": "diff",
  caller: "caller",
  callee: "callee",
  test: "test",
  config: "config",
  schema: "schema",
  ownership: "config",
  history: "history"
};

/**
 * Review-bundle construction performs the final untrusted-data wrapping. This
 * adapter keeps repository scope in the stable ID so related content cannot be
 * confused with a primary repository path.
 */
export function retrievalToReviewContextCandidates(
  result: RepositoryContextResult
): ReviewBundleContextCandidate[] {
  return result.contexts.map((context) => ({
    id: `${context.repositoryScope}:${context.id}`,
    path: context.path.replace(/"/g, "%22"),
    kind: reviewKindByRetrievedKind[context.kind],
    content: context.content
      .replace(/\[guardianbot-untrusted-data/gi, "[guardianbot-escaped-untrusted-data")
      .replace(/\[begin-content\]/gi, "[guardianbot-escaped-begin-content]")
      .replace(/\[end-content\]/gi, "[guardianbot-escaped-end-content]"),
    priority: Math.round(context.score)
  }));
}
