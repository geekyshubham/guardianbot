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
  assertDescriptorReference,
  assertIndexReference,
  HISTORY_RECORD_PATH,
  normalizeRepositoryPath,
  renderHistoryRecordContent
} from "./storage.js";
import type {
  DurableRepositoryContextSource,
  IndexedHistory,
  IndexedSymbol,
  LocalEmbeddingProvider,
  PersistedCallEdge,
  PersistedPathRecordRow,
  PersistedRecordRow,
  PersistedVectorRow,
  RepositoryIndex,
  RepositoryIndexDescriptor,
  RepositoryRecordHydrationRequest,
  RepositoryVectorMatch,
  RepositoryVectorQuery,
  RepositoryVisibility
} from "./types.js";

/**
 * The seam between retrieval and durable storage. Nearest-neighbour recall is the
 * only part of retrieval that must consider every vector, so it is the part that
 * cannot scale inside one materialised index document. A ranker moves that scan
 * into storage, which can answer it with an ANN index scoped to one repository.
 *
 * `InMemoryRepositoryIndexPersistence` and a PostgreSQL/pgvector store both
 * satisfy this structurally through their `query` method, so the in-memory
 * reference implementation and a durable adapter are interchangeable here.
 *
 * A ranker that also implements `hydrateRecords` turns recalled records the
 * document does not contain into candidates. That is what removes the requirement
 * to hold a whole snapshot in memory to answer one query, and it is what makes a
 * record that exists durably but not in the loaded document retrievable at all.
 *
 * What a ranker does NOT do is decide rank. See `candidateRelevance`: scores are
 * always recomputed locally, because a store's score has store-specific polarity.
 *
 * The full-document path still walks `index.calls` for caller/callee. The
 * descriptor-first path reconstructs those edges from durable call-edge rows
 * via `retrieveDurableRepositoryContext`.
 */
export interface RepositoryVectorRanker {
  /**
   * Nearest-neighbour recall over one repository snapshot.
   *
   * `RepositoryVectorMatch.score` selects and orders what storage returns; it is
   * deliberately NOT the number any candidate is ranked by. Stores disagree on
   * what a vector score even means — pgvector's `<=>` is cosine DISTANCE, so a
   * pgvector path must return `1 - (<=>)` to express similarity, while a
   * non-pgvector fallback computes cosine similarity directly — and a seam whose
   * ordering inverted depending on which path answered would be worthless. So the
   * boundary normalises: retrieval recomputes every candidate's relevance locally
   * from the record's own vector, whatever the store reported. A store that
   * returned distance where another returned similarity can therefore change which
   * records are recalled, and can never change how any candidate is ranked.
   */
  query(request: RepositoryVectorQuery): Promise<RepositoryVectorMatch[]>;
  /**
   * Optional. When present, nearest-neighbour matches whose records are absent
   * from the materialised document are hydrated into candidates through a single
   * batched fetch per repository.
   */
  hydrateRecords?(
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedRecordRow[]>;
}

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

/**
 * Every `RetrievedContextKind` as a runtime value, pinned to the union in BOTH
 * directions by the two checks below.
 *
 * A runtime list is required because the union is erased: the test runner strips
 * types rather than checking them, so a test comparing a table against a type
 * would compare it against nothing. Pinning is what gives the list teeth — adding
 * a member to the union without adding it here is a compile error, and adding it
 * here without classifying it below fails the partition test.
 */
export const retrievedContextKinds = [
  "changed-symbol",
  "caller",
  "callee",
  "test",
  "config",
  "schema",
  "ownership",
  "history"
] as const satisfies readonly RetrievedContextKind[];

/** Fails to compile if a union member is missing from `retrievedContextKinds`. */
type UnclassifiedContextKind = Exclude<
  RetrievedContextKind,
  (typeof retrievedContextKinds)[number]
>;
const _everyKindIsListed: UnclassifiedContextKind extends never ? true : never = true;
void _everyKindIsListed;

/**
 * How completely durable per-record storage can reproduce one candidate kind.
 *
 * These names are the vocabulary for a distinction that is otherwise easy to lose:
 * "the document is no longer loaded" and "the same candidates are still found" are
 * different claims, and only one of them is about storage.
 */
export type RetrievedContextKindDurability =
  /**
   * Reproducible from durable rows exactly, for the same inputs. Bounded by the
   * diff (or by the call edges that touch the changed set), not by ANN recall.
   */
  | "durably-exact"
  /**
   * Enumerated repo-wide from the document, and answerable durably only within
   * whatever nearest-neighbour recall returned.
   *
   * The document path scans EVERY symbol (`addRepositorySupportContexts`, and the
   * test scan in `primaryCandidates`); the durable path sees only recalled rows.
   * So this is not equivalence — it is
   * "bounded by recall instead of by the repository". Widening recall widens it;
   * nothing about it makes review cost sublinear in repository size, because the
   * document-side scan is repo-wide by SEMANTICS and not by storage accident.
   */
  | "exhaustive-from-document-recall-bounded-durably"
  /**
   * Not reproducible from durable storage at all on any production path.
   *
   * Reserved for kinds that still require the materialised document after path
   * queries and call-edge rows exist. Currently empty: caller/callee reconstruct
   * from durable edges, and changed-symbol is path-exact.
   */
  | "document-only";

export interface RetrievedContextKindCoverage {
  durability: RetrievedContextKindDurability;
  /**
   * Relations within this kind that need the materialised document even when the
   * kind itself has a durable route. A non-empty list means a candidate of this
   * kind can still be MISSED durably, so the kind's presence in a durable result
   * is not evidence that its document-side counterpart was fully reproduced.
   */
  documentOnlyRelations: readonly string[];
  why: string;
}

/**
 * The declared durability of every candidate kind: a partition, one class each.
 *
 * It exists so drift is mechanically detectable rather than a matter of reading
 * comments. The descriptor-first path (`retrieveDurableRepositoryContext`) closes
 * changed-symbol via path-scoped queries and caller/callee via durable edges; the
 * remaining kinds are still recall-bounded. Nothing in retrieval reads this table;
 * it is a declaration, not a control path.
 */
export const retrievedContextKindCoverage: Record<
  RetrievedContextKind,
  RetrievedContextKindCoverage
> = {
  "changed-symbol": {
    durability: "durably-exact",
    documentOnlyRelations: [],
    why:
      "Path-scoped durable record queries fetch every symbol on selected changed " +
      "paths up to an explicit hard limit. Truncation is surfaced as partial " +
      "coverage rather than silent loss. This no longer depends on ANN recall."
  },
  caller: {
    durability: "durably-exact",
    documentOnlyRelations: [],
    why:
      "Durable call-edge rows carry caller_symbol_id and resolved_symbol_ids. " +
      "retrieveDurableRepositoryContext walks those edges for the changed symbol " +
      "set and hydrates caller records. Truncation of the edge query is partial."
  },
  callee: {
    durability: "durably-exact",
    documentOnlyRelations: [],
    why:
      "Outbound edges from changed callers are durable. The related-source lexical " +
      "'callee' label from classifyDurableRecord remains recall-bounded and is not " +
      "counted as call-edge coverage; the primary call-edge route is exact."
  },
  test: {
    durability: "exhaustive-from-document-recall-bounded-durably",
    documentOnlyRelations: [],
    why:
      "relatedByName is durable on recalled rows; relatedByCall reconstructs from " +
      "durable edges when the test symbol is the caller. Discovery of name-related " +
      "tests still depends on ANN recall (or the test path being selected)."
  },
  config: {
    durability: "exhaustive-from-document-recall-bounded-durably",
    documentOnlyRelations: [],
    why:
      "Path classification is exact on a durable row, but the document path scans every " +
      "symbol in the repository while the durable path sees only recalled rows."
  },
  schema: {
    durability: "exhaustive-from-document-recall-bounded-durably",
    documentOnlyRelations: [],
    why: "Path classification is exact per row; enumeration is repo-wide only from the document."
  },
  ownership: {
    durability: "exhaustive-from-document-recall-bounded-durably",
    documentOnlyRelations: [],
    why: "Path classification is exact per row; enumeration is repo-wide only from the document."
  },
  history: {
    durability: "exhaustive-from-document-recall-bounded-durably",
    documentOnlyRelations: [],
    why:
      "Summary matching is exact on a durable row because the row carries the raw summary, " +
      "but which history rows are considered outside selected paths is bounded by recall."
  }
};

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
  /**
   * Optional durable ranker. When supplied together with an embedding provider
   * and a query, nearest-neighbour RECALL comes from storage: records the loaded
   * document does not contain become retrievable. It does not change how anything
   * is scored — every candidate is ranked by the same local cosine either way — so
   * omitting it can only narrow what is reachable, never reorder it.
   */
  vectorRanker?: RepositoryVectorRanker;
  /**
   * Records to request from the ranker per repository. It bounds the durable
   * query independently of the context limit so recall can consider more records
   * than are ultimately returned.
   */
  vectorRankerLimit?: number;
}

/**
 * Descriptor-first retrieval for the production review path. Requires durable
 * path-record and call-edge queries; never reads a materialised index document.
 */
export interface DurableRepositoryContextRequest {
  descriptor: RepositoryIndexDescriptor;
  repositoryScope: string;
  commitSha: string;
  changes: readonly IndexChangedFile[];
  query?: string;
  limit?: number;
  primaryPolicy?: RepositoryAccessPolicy;
  embeddingProvider?: LocalEmbeddingProvider;
  source: DurableRepositoryContextSource;
  /** ANN recall bound per repository. Defaults to 200. */
  vectorRankerLimit?: number;
  /** Hard cap on path-scoped exact records. Defaults to 500. */
  pathRecordLimit?: number;
  /** Hard cap on call edges for the changed symbol set. Defaults to 500. */
  callEdgeLimit?: number;
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
  /**
   * Operator-facing reasons the durable path returned partial coverage. Empty
   * when coverage is complete within the declared durability of each kind.
   * Deliberately free of repository-identifying labels.
   */
  warnings?: string[];
}

export class RepositoryIsolationError extends Error {
  override readonly name = "RepositoryIsolationError";
}

/**
 * Identity + embedding fields scoring needs. A full `RepositoryIndex` satisfies
 * this; so does a descriptor. Keeping the type narrow is what lets the
 * descriptor-first path score candidates without materialising the document.
 */
type CandidateIndexRef = Pick<
  RepositoryIndex,
  "storageKey" | "repositoryScope" | "commitSha" | "embedding"
>;

interface Candidate {
  id: string;
  /**
   * Persisted vector row identity. It is what decides whether a record a durable
   * query recalled is already present in a loaded document, and so whether it
   * needs hydrating into a candidate at all.
   */
  recordId: string;
  recordType: "symbol" | "history";
  repositoryScope: string;
  commitSha: string;
  source: RetrievedRepositoryContext["source"];
  path: string;
  line: number;
  kind: RetrievedContextKind;
  content: string;
  contentSha256: string;
  vector: readonly number[];
  index: CandidateIndexRef;
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
  index: Pick<RepositoryIndex, "repositoryScope" | "visibility">
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
  symbol: Pick<IndexedSymbol, "line" | "endLine">,
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

/**
 * The stable candidate identity. Both the materialised and the durable sourcing
 * path derive it from the same three fields, so one record cannot present two
 * identities depending on where it came from. It also feeds the deterministic
 * tie-break, so a drift here would reorder equal scores between the two paths.
 */
function candidateId(
  repositoryScope: string,
  recordId: string,
  kind: RetrievedContextKind
): string {
  return sha256(`${repositoryScope}\u0000${recordId}\u0000${kind}`);
}

function candidateFromSymbol(
  index: RepositoryIndex,
  symbol: IndexedSymbol,
  kind: RetrievedContextKind,
  source: Candidate["source"],
  baseScore: number
): Candidate {
  return {
    id: candidateId(index.repositoryScope, symbol.id, kind),
    recordId: symbol.id,
    recordType: "symbol",
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
  const content = renderHistoryRecordContent(entry);
  return {
    id: candidateId(index.repositoryScope, entry.id, "history"),
    recordId: entry.id,
    recordType: "history",
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

interface DurableClassification {
  kind: RetrievedContextKind;
  baseScore: number;
}

/**
 * Classifies one durable record row into the same candidate kinds the
 * materialised path would produce for it, using only durably-sourced fields.
 *
 * Every predicate here is deliberately a subset of its counterpart in
 * `primaryCandidates`: a symbol's path, line span, name, and content are all
 * durable, so path classification and changed-line intersection are exact, but a
 * `caller`/`callee` edge needs `index.calls` and a test's call-based relation
 * needs it too, so those are omitted rather than approximated. Because the set is
 * a subset, sourcing durably can only ever add candidates for records the
 * document does not contain; it can never invent one the document would reject.
 * That is what keeps both paths' ordering identical.
 */
function classifyDurableRecord(
  row: PersistedRecordRow,
  source: Candidate["source"],
  selectedPaths: ReadonlySet<string>,
  changesByPath: ReadonlyMap<string, NormalizedChange>,
  changedNames: ReadonlySet<string>,
  query: string
): DurableClassification[] {
  const classifications: DurableClassification[] = [];
  const lowerNames = [...changedNames];
  if (row.recordType === "history") {
    const summary = (row.summary ?? "").toLowerCase();
    const matches =
      source === "primary"
        ? (row.path !== HISTORY_RECORD_PATH && selectedPaths.has(row.path)) ||
          lowerNames.some((name) => summary.includes(name)) ||
          Boolean(query && summary.includes(query.toLowerCase()))
        : lowerNames.some((name) => summary.includes(name)) ||
          Boolean(query && lexicalOverlapScore(query, row.summary ?? "") > 0);
    if (matches) {
      classifications.push({ kind: "history", baseScore: source === "primary" ? 68 : 45 });
    }
    return classifications;
  }

  const supportAdjustment = source === "primary" ? 0 : -18;
  if (source === "primary") {
    const change = changesByPath.get(row.path);
    if (
      selectedPaths.has(row.path) &&
      change &&
      symbolIntersectsChangedLines({ line: row.line, endLine: row.endLine }, change)
    ) {
      classifications.push({ kind: "changed-symbol", baseScore: 110 });
    }
  } else {
    const lowerContent = row.content.toLowerCase();
    const relevant =
      changedNames.has(row.name.toLowerCase()) ||
      lowerNames.some((name) => lowerContent.includes(name)) ||
      (query ? lexicalOverlapScore(query, row.content) > 0 : false);
    if (relevant) {
      classifications.push(
        isTestPath(row.path)
          ? { kind: "test", baseScore: 63 }
          : { kind: "callee", baseScore: 66 }
      );
    }
  }

  if (isOwnershipPath(row.path)) {
    classifications.push({ kind: "ownership", baseScore: 76 + supportAdjustment });
  } else if (isSchemaPath(row.path)) {
    classifications.push({ kind: "schema", baseScore: 74 + supportAdjustment });
  } else if (isConfigPath(row.path)) {
    classifications.push({ kind: "config", baseScore: 72 + supportAdjustment });
  }

  if (source === "primary" && isTestPath(row.path)) {
    const lowerContent = row.content.toLowerCase();
    if (lowerNames.some((name) => lowerContent.includes(name))) {
      classifications.push({ kind: "test", baseScore: 90 });
    }
  }
  return classifications;
}

/**
 * Repository-qualified record identity. A record id is unique only within one
 * repository snapshot, so the scope is part of the key: without it, two
 * repositories each holding a record of the same name would collide here.
 */
function recordIdentityKey(
  repositoryScope: string,
  recordType: Candidate["recordType"],
  recordId: string
): string {
  return [repositoryScope, recordType, recordId].join("\u0000");
}

/**
 * Every record the loaded documents actually contain, keyed by record identity.
 *
 * Durable sourcing consults this to decide what to hydrate, and it is derived
 * from the documents' own records rather than from the candidates enumerated out
 * of them. That distinction is what preserves the in-memory path byte-for-byte: a
 * record a document holds but did not turn into a candidate (an unchanged symbol,
 * say) stays a non-candidate instead of being re-admitted through hydration under
 * the narrower durable classification rules.
 */
function materialisedRecordKeys(indexes: readonly RepositoryIndex[]): Set<string> {
  const keys = new Set<string>();
  for (const index of indexes) {
    for (const symbol of index.symbols) {
      keys.add(recordIdentityKey(index.repositoryScope, "symbol", symbol.id));
    }
    for (const entry of index.history) {
      keys.add(recordIdentityKey(index.repositoryScope, "history", entry.id));
    }
  }
  return keys;
}

function providerMatchesIndex(
  provider: LocalEmbeddingProvider | undefined,
  index: CandidateIndexRef
): boolean {
  return Boolean(
    provider &&
      provider.id === index.embedding.providerId &&
      provider.kind === index.embedding.kind &&
      provider.dimensions === index.embedding.dimensions
  );
}

/**
 * Delegates semantic ranking to durable storage, one repository at a time. Each
 * query carries that repository's own scope and commit, so a store that honours
 * the reference cannot widen the read past one repository. The returned rows are
 * re-checked against the requested identity regardless: an isolation boundary
 * that depends on a remote implementation behaving correctly is not a boundary.
 */
interface DurableSourcingRequest {
  ranker: RepositoryVectorRanker;
  sources: readonly { index: RepositoryIndex; source: Candidate["source"] }[];
  provider: LocalEmbeddingProvider | undefined;
  providerQueryVector: readonly number[] | undefined;
  limit: number;
  selectedPaths: ReadonlySet<string>;
  changesByPath: ReadonlyMap<string, NormalizedChange>;
  changedNames: ReadonlySet<string>;
  query: string;
  /** Records the materialised document already enumerated, keyed as `type:id`. */
  materialisedRecords: ReadonlySet<string>;
}

interface DurableSourcingResult {
  candidates: Candidate[];
}

function assertRowWithinRepository(
  row: { storageKey: string; repositoryScope: string; commitSha: string },
  index: CandidateIndexRef,
  what: string
): void {
  if (
    row.storageKey !== index.storageKey ||
    row.repositoryScope !== index.repositoryScope ||
    row.commitSha !== index.commitSha
  ) {
    throw new RepositoryIsolationError(
      `${what} returned a row outside the requested repository and commit`
    );
  }
}

function assertVectorMatchesDescriptor(
  row: Pick<PersistedVectorRow, "providerId" | "dimensions" | "vector">,
  descriptor: RepositoryIndexDescriptor,
  what: string
): void {
  if (
    row.providerId !== descriptor.embedding.providerId ||
    row.dimensions !== descriptor.embedding.dimensions ||
    row.vector.length !== descriptor.embedding.dimensions ||
    row.vector.some((value) => !Number.isFinite(value))
  ) {
    throw new RepositoryIsolationError(
      `${what} returned a vector outside the snapshot embedding space`
    );
  }
}

/**
 * Delegates semantic ranking to durable storage, one repository at a time, and
 * sources the candidate set from the same query. Each query carries that
 * repository's own scope and commit, so a store that honours the reference cannot
 * widen the read past one repository. Returned rows are re-checked against the
 * requested identity on BOTH paths regardless: an isolation boundary that depends
 * on a remote implementation behaving correctly is not a boundary.
 *
 * Records the materialised document already enumerated are left entirely alone,
 * which leaves the in-memory path's candidate set and ordering untouched. Records
 * the document does not contain are hydrated into candidates, which is what lets a
 * query be answered without the whole snapshot resident. Hydration is one batched
 * fetch per repository, so N matches cost one round trip and not N.
 *
 * The store's `score` is used only to decide WHICH records to recall and hydrate.
 * It never leaves this function, because its meaning is store-specific (similarity
 * on one path, distance on another) and ranking a candidate by a number of unknown
 * polarity would silently invert the result order. Every returned candidate
 * carries its record's own vector instead, and is scored by the same local cosine
 * a materialised candidate of the same record would get.
 */
async function sourceThroughDurableStorage(
  request: DurableSourcingRequest
): Promise<DurableSourcingResult> {
  const candidates: Candidate[] = [];
  if (!request.providerQueryVector) return { candidates };
  for (const { index, source } of request.sources) {
    if (!providerMatchesIndex(request.provider, index)) continue;
    const matches = await request.ranker.query({
      repositoryScope: index.repositoryScope,
      commitSha: index.commitSha,
      providerId: index.embedding.providerId,
      vector: request.providerQueryVector,
      limit: request.limit
    });
    const absent = new Map<string, RepositoryVectorMatch>();
    for (const match of matches) {
      assertRowWithinRepository(match.row, index, "durable vector ranking");
      // A store that answers with a non-finite score is malformed, so its row is
      // not recalled at all rather than recalled at an unknown rank.
      if (!Number.isFinite(match.score)) continue;
      const key = recordIdentityKey(
        match.row.repositoryScope,
        match.row.recordType,
        match.row.recordId
      );
      // Keyed by repository as well as record, so a record id cannot be treated
      // as already materialised because another repository enumerated one by the
      // same name.
      if (!request.materialisedRecords.has(key)) {
        const recordKey = `${match.row.recordType}:${match.row.recordId}`;
        const seen = absent.get(recordKey);
        if (!seen || match.score > seen.score) absent.set(recordKey, match);
      }
    }
    if (!absent.size || !request.ranker.hydrateRecords) continue;

    const hydrated = await request.ranker.hydrateRecords({
      repositoryScope: index.repositoryScope,
      commitSha: index.commitSha,
      records: [...absent.values()].map((match) => ({
        recordType: match.row.recordType,
        recordId: match.row.recordId
      }))
    });
    for (const row of hydrated) {
      assertRowWithinRepository(row, index, "durable record hydration");
      const recordKey = `${row.recordType}:${row.recordId}`;
      const match = absent.get(recordKey);
      // A store must not answer with a record that was not asked for. Dropping it
      // rather than trusting it keeps an over-broad fetch from widening results.
      if (!match) continue;
      for (const classification of classifyDurableRecord(
        row,
        source,
        request.selectedPaths,
        request.changesByPath,
        request.changedNames,
        request.query
      )) {
        candidates.push({
          id: candidateId(index.repositoryScope, row.recordId, classification.kind),
          recordId: row.recordId,
          recordType: row.recordType,
          repositoryScope: index.repositoryScope,
          commitSha: index.commitSha,
          source,
          path: row.path,
          line: row.line,
          kind: classification.kind,
          content: row.content,
          contentSha256: row.contentSha256,
          vector: match.row.vector,
          index,
          baseScore: classification.baseScore
        });
      }
    }
  }
  return { candidates };
}

/**
 * Ranks one candidate, from its own vector, identically whether it was enumerated
 * from a materialised document or hydrated out of durable storage.
 *
 * No store-reported score reaches this function. A durable score's polarity is
 * store-specific — pgvector's `<=>` is cosine distance, a non-pgvector fallback
 * computes similarity — so ranking by it would make the result order depend on
 * which storage path answered, and a mismatch would invert it silently rather than
 * fail. Scoring locally on both paths is what makes supplying a ranker a pure
 * recall change: it can add candidates for records the document lacks, and cannot
 * move any candidate the in-memory path already produced.
 */
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
    providerMatchesIndex(provider, candidate.index)
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

function rankCandidates(
  candidates: Candidate[],
  query: string,
  embeddingProvider: LocalEmbeddingProvider | undefined,
  providerQueryVector: readonly number[] | undefined,
  limit: number
): {
  contexts: RetrievedRepositoryContext[];
  droppedContextCount: number;
  partialByLimit: boolean;
} {
  const unique = new Map<string, Candidate & { score: number }>();
  for (const candidate of candidates) {
    const score =
      candidate.baseScore +
      candidateRelevance(candidate, query, embeddingProvider, providerQueryVector) * 20;
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
    droppedContextCount: Math.max(0, ranked.length - selected.length),
    partialByLimit: ranked.length > limit
  };
}

function candidateFromPathRecord(
  index: CandidateIndexRef,
  row: PersistedPathRecordRow | (PersistedRecordRow & { vector: readonly number[] }),
  kind: RetrievedContextKind,
  source: Candidate["source"],
  baseScore: number
): Candidate {
  return {
    id: candidateId(index.repositoryScope, row.recordId, kind),
    recordId: row.recordId,
    recordType: row.recordType,
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    source,
    path: row.path,
    line: row.line,
    kind,
    content: row.content,
    contentSha256: row.contentSha256,
    vector: row.vector,
    index,
    baseScore
  };
}

/**
 * Descriptor-first production retrieval. Loads only durable rows/edges; never
 * requires a materialised `RepositoryIndex` document.
 *
 * Exact changed-path records are fetched with a hard limit (not ANN). Call edges
 * reconstruct caller/callee. Support kinds remain recall-bounded and are never
 * silently claimed as equivalent to a full document scan — truncation and known
 * recall bounds surface as `partial` plus warnings.
 */
export async function retrieveDurableRepositoryContext(
  request: DurableRepositoryContextRequest
): Promise<RepositoryContextResult> {
  assertDescriptorReference(request.descriptor, {
    repositoryScope: request.repositoryScope,
    commitSha: request.commitSha
  });
  const limit = request.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("repository context limit must be between 1 and 200");
  }
  if (request.primaryPolicy) {
    assertPolicyMatchesIndex(request.primaryPolicy, request.descriptor);
  }

  const pathRecordLimit = request.pathRecordLimit ?? 500;
  const callEdgeLimit = request.callEdgeLimit ?? 500;
  const vectorRankerLimit = request.vectorRankerLimit ?? 200;
  for (const [value, name] of [
    [pathRecordLimit, "path record limit"],
    [callEdgeLimit, "call edge limit"],
    [vectorRankerLimit, "vector ranker limit"]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new RangeError(`${name} must be between 1 and 1000`);
    }
  }

  const descriptor = request.descriptor;
  const indexRef: CandidateIndexRef = {
    storageKey: descriptor.storageKey,
    repositoryScope: descriptor.repositoryScope,
    commitSha: descriptor.commitSha,
    embedding: descriptor.embedding
  };
  const normalizedChanges = normalizeChanges(request.changes);
  const scope = planRepositoryReviewScope(normalizedChanges);
  const query = normalizeSourceText(request.query ?? "").slice(0, 4_000);
  const selectedPaths = new Set(scope.selectedPaths);
  const changesByPath = new Map(normalizedChanges.map((change) => [change.path, change]));
  const warnings: string[] = [];
  let durablePartial = false;

  const pathResult = await request.source.queryRecordsByPath({
    repositoryScope: descriptor.repositoryScope,
    commitSha: descriptor.commitSha,
    paths: scope.selectedPaths,
    limit: pathRecordLimit
  });
  if (pathResult.truncated) {
    durablePartial = true;
    warnings.push(
      "durable path-record retrieval was truncated; changed-path coverage is partial"
    );
  }

  const candidates: Candidate[] = [];
  const knownRecords = new Set<string>();
  const changedIds = new Set<string>();
  const changedNames = new Set<string>();
  const symbolsById = new Map<
    string,
    PersistedRecordRow & { vector: readonly number[] }
  >();

  for (const row of pathResult.rows) {
    assertRowWithinRepository(row, indexRef, "durable path-record retrieval");
    assertVectorMatchesDescriptor(row, descriptor, "durable path-record retrieval");
    knownRecords.add(recordIdentityKey(row.repositoryScope, row.recordType, row.recordId));
    if (row.recordType === "symbol") {
      symbolsById.set(row.recordId, row);
    }
    for (const classification of classifyDurableRecord(
      row,
      "primary",
      selectedPaths,
      changesByPath,
      changedNames,
      query
    )) {
      // First pass uses empty changedNames; collect changed-symbols then re-run name matches.
      if (classification.kind === "changed-symbol") {
        changedIds.add(row.recordId);
        changedNames.add(row.name.toLowerCase());
      }
      candidates.push(
        candidateFromPathRecord(indexRef, row, classification.kind, "primary", classification.baseScore)
      );
    }
  }

  // Re-classify path history/test rows now that changedNames is populated.
  for (const row of pathResult.rows) {
    if (row.recordType === "history" || (row.recordType === "symbol" && isTestPath(row.path))) {
      for (const classification of classifyDurableRecord(
        row,
        "primary",
        selectedPaths,
        changesByPath,
        changedNames,
        query
      )) {
        if (classification.kind === "changed-symbol") continue;
        candidates.push(
          candidateFromPathRecord(
            indexRef,
            row,
            classification.kind,
            "primary",
            classification.baseScore
          )
        );
      }
    }
  }

  const edgeResult =
    changedIds.size || changedNames.size
      ? await request.source.queryCallEdges({
          repositoryScope: descriptor.repositoryScope,
          commitSha: descriptor.commitSha,
          symbolIds: [...changedIds],
          targetNames: [...changedNames],
          limit: callEdgeLimit
        })
      : { edges: [] as PersistedCallEdge[], truncated: false };
  if (edgeResult.truncated) {
    durablePartial = true;
    warnings.push("durable call-edge retrieval was truncated; caller/callee coverage is partial");
  }

  const relatedSymbolIds = new Set<string>();
  for (const edge of edgeResult.edges) {
    assertRowWithinRepository(edge, indexRef, "durable call-edge retrieval");
    if (edge.callerSymbolId) relatedSymbolIds.add(edge.callerSymbolId);
    for (const id of edge.resolvedSymbolIds) relatedSymbolIds.add(id);
  }

  const missingSymbolRefs = [...relatedSymbolIds]
    .filter((id) => !symbolsById.has(id))
    .map((recordId) => ({ recordType: "symbol" as const, recordId }));
  if (missingSymbolRefs.length) {
    const [hydrated, vectors] = await Promise.all([
      request.source.hydrateRecords({
        repositoryScope: descriptor.repositoryScope,
        commitSha: descriptor.commitSha,
        records: missingSymbolRefs
      }),
      request.source.hydrateVectors({
        repositoryScope: descriptor.repositoryScope,
        commitSha: descriptor.commitSha,
        records: missingSymbolRefs
      })
    ]);
    const vectorsById = new Map(vectors.map((row) => [row.recordId, row]));
    for (const row of hydrated) {
      assertRowWithinRepository(row, indexRef, "durable record hydration");
      const vectorRow = vectorsById.get(row.recordId);
      if (!vectorRow) continue;
      assertRowWithinRepository(vectorRow, indexRef, "durable vector hydration");
      assertVectorMatchesDescriptor(vectorRow, descriptor, "durable vector hydration");
      knownRecords.add(recordIdentityKey(row.repositoryScope, row.recordType, row.recordId));
      symbolsById.set(row.recordId, { ...row, vector: vectorRow.vector });
    }
  }

  for (const edge of edgeResult.edges) {
    const touchesChanged =
      (edge.callerSymbolId && changedIds.has(edge.callerSymbolId)) ||
      edge.resolvedSymbolIds.some((id) => changedIds.has(id)) ||
      (edge.targetName && changedNames.has(edge.targetName));
    if (!touchesChanged) continue;

    if (
      edge.resolvedSymbolIds.some((id) => changedIds.has(id)) ||
      (edge.targetName && changedNames.has(edge.targetName))
    ) {
      const caller = edge.callerSymbolId ? symbolsById.get(edge.callerSymbolId) : undefined;
      if (caller && !changedIds.has(caller.recordId)) {
        candidates.push(
          candidateFromPathRecord(indexRef, caller, "caller", "primary", 96)
        );
      }
    }
    if (edge.callerSymbolId && changedIds.has(edge.callerSymbolId)) {
      for (const resolvedId of edge.resolvedSymbolIds) {
        const callee = symbolsById.get(resolvedId);
        if (callee && !changedIds.has(callee.recordId)) {
          candidates.push(
            candidateFromPathRecord(indexRef, callee, "callee", "primary", 94)
          );
        }
      }
    }
    // Call-based test: a test symbol that calls a changed symbol.
    if (edge.callerSymbolId && edge.resolvedSymbolIds.some((id) => changedIds.has(id))) {
      const caller = symbolsById.get(edge.callerSymbolId);
      if (caller && isTestPath(caller.path) && !changedIds.has(caller.recordId)) {
        candidates.push(candidateFromPathRecord(indexRef, caller, "test", "primary", 90));
      }
    }
  }

  // ANN recall for support kinds (config/schema/ownership/history/name-related tests).
  // These remain recall-bounded; surface that as partial rather than claiming parity.
  const providerQueryVector = await queryVectorForProvider(request.embeddingProvider, query);
  if (request.embeddingProvider && providerQueryVector && query) {
    if (!providerMatchesIndex(request.embeddingProvider, indexRef)) {
      throw new RepositoryIsolationError(
        "retrieval embedding provider does not match the snapshot embedding space"
      );
    }
    const matches = await request.source.query({
      repositoryScope: descriptor.repositoryScope,
      commitSha: descriptor.commitSha,
      providerId: descriptor.embedding.providerId,
      vector: providerQueryVector,
      limit: vectorRankerLimit
    });
    const absent = new Map<string, RepositoryVectorMatch>();
    for (const match of matches) {
      assertRowWithinRepository(match.row, indexRef, "durable vector ranking");
      assertVectorMatchesDescriptor(match.row, descriptor, "durable vector ranking");
      if (!Number.isFinite(match.score)) continue;
      const key = recordIdentityKey(
        match.row.repositoryScope,
        match.row.recordType,
        match.row.recordId
      );
      if (knownRecords.has(key)) continue;
      const recordKey = `${match.row.recordType}:${match.row.recordId}`;
      const seen = absent.get(recordKey);
      if (!seen || match.score > seen.score) absent.set(recordKey, match);
    }
    if (absent.size) {
      const hydrated = await request.source.hydrateRecords({
        repositoryScope: descriptor.repositoryScope,
        commitSha: descriptor.commitSha,
        records: [...absent.values()].map((match) => ({
          recordType: match.row.recordType,
          recordId: match.row.recordId
        }))
      });
      for (const row of hydrated) {
        assertRowWithinRepository(row, indexRef, "durable record hydration");
        const recordKey = `${row.recordType}:${row.recordId}`;
        const match = absent.get(recordKey);
        if (!match) continue;
        knownRecords.add(recordIdentityKey(row.repositoryScope, row.recordType, row.recordId));
        for (const classification of classifyDurableRecord(
          row,
          "primary",
          selectedPaths,
          changesByPath,
          changedNames,
          query
        )) {
          candidates.push(
            candidateFromPathRecord(
              indexRef,
              { ...row, vector: match.row.vector },
              classification.kind,
              "primary",
              classification.baseScore
            )
          );
        }
      }
    }
    // Support kinds (config/schema/ownership/history beyond selected paths) remain
    // recall-bounded; that limit is declared in retrievedContextKindCoverage rather
    // than forced partial on every successful review.
  }

  const ranked = rankCandidates(
    candidates,
    query,
    request.embeddingProvider,
    providerQueryVector,
    limit
  );
  return {
    repositoryScope: descriptor.repositoryScope,
    commitSha: descriptor.commitSha,
    storageKey: descriptor.storageKey,
    mode: scope.mode,
    partial: scope.partial || durablePartial || ranked.partialByLimit,
    scope,
    contexts: ranked.contexts,
    droppedContextCount: ranked.droppedContextCount,
    warnings: warnings.length ? warnings : undefined
  };
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
  const vectorRankerLimit = request.vectorRankerLimit ?? 200;
  if (
    !Number.isSafeInteger(vectorRankerLimit) ||
    vectorRankerLimit < 1 ||
    vectorRankerLimit > 1_000
  ) {
    throw new RangeError("vector ranker limit must be between 1 and 1000");
  }
  const durable =
    request.vectorRanker && query
      ? await sourceThroughDurableStorage({
          ranker: request.vectorRanker,
          sources: [
            { index: request.index, source: "primary" as const },
            ...related.map((source) => ({
              index: source.index,
              source: "related" as const
            }))
          ],
          provider: request.embeddingProvider,
          providerQueryVector,
          limit: vectorRankerLimit,
          selectedPaths: new Set(scope.selectedPaths),
          changesByPath: new Map(
            normalizedChanges.map((change) => [change.path, change])
          ),
          changedNames: primary.changedNames,
          query,
          materialisedRecords: materialisedRecordKeys([
            request.index,
            ...related.map((source) => source.index)
          ])
        })
      : { candidates: [] };
  // Durable-sourced candidates are, by construction, records no loaded document
  // contains, so they extend the candidate set without perturbing any candidate
  // the materialised path produced. Every candidate is then scored by the same
  // local cosine, so supplying a ranker changes recall and never ordering.
  candidates.push(...durable.candidates);
  const ranked = rankCandidates(
    candidates,
    query,
    request.embeddingProvider,
    providerQueryVector,
    limit
  );
  return {
    repositoryScope: request.index.repositoryScope,
    commitSha: request.index.commitSha,
    storageKey: request.index.storageKey,
    mode: scope.mode,
    partial: scope.partial || ranked.partialByLimit,
    scope,
    contexts: ranked.contexts,
    droppedContextCount: ranked.droppedContextCount
  };
}

/**
 * Exported so the kind-partition invariant has a THIRD independent runtime
 * witness of the union. The union itself is erased at test time, so a table can
 * only be checked against another table; this one is load-bearing for review
 * bundles, so a new kind cannot compile without appearing here.
 */
export const reviewKindByRetrievedKind: Record<
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
