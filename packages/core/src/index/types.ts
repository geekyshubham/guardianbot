export type RepositoryVisibility = "public" | "private" | "internal";

export interface RepositoryIdentity {
  /**
   * Stable administrative identity for the repository. Prefer a provider ID
   * (for example `github:1234`) over a mutable repository name.
   */
  scope: string;
  fullName: string;
  visibility: RepositoryVisibility;
}

export type IndexedLanguage =
  | "python"
  | "javascript"
  | "typescript"
  | "swift"
  | "ruby"
  | "text";

export type IndexParserKind = "tree-sitter" | "text-fallback";

export type IndexedSymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "module"
  | "text";

export interface IndexedFile {
  path: string;
  language: IndexedLanguage;
  parser: IndexParserKind;
  parserId: string;
  contentSha256: string;
  lineCount: number;
  diagnostic?: "unsupported-language" | "parser-unavailable" | "syntax-recovery" | "file-too-large";
}

export interface IndexedSymbol {
  id: string;
  repository: string;
  repositoryScope: string;
  commitSha: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: IndexedSymbolKind;
  language: IndexedLanguage;
  parser: IndexParserKind;
  line: number;
  endLine: number;
  content: string;
  contentSha256: string;
  vector: number[];
}

export interface IndexedImport {
  id: string;
  repositoryScope: string;
  commitSha: string;
  path: string;
  language: IndexedLanguage;
  line: number;
  source: string;
  names: string[];
  kind: "static" | "require" | "dynamic";
  containingSymbolId?: string;
}

export interface IndexedCall {
  id: string;
  repositoryScope: string;
  commitSha: string;
  path: string;
  language: IndexedLanguage;
  line: number;
  target: string;
  callerSymbolId?: string;
  resolvedSymbolIds: string[];
  resolution: "name-match" | "unresolved";
}

export interface RepositoryHistoryInput {
  commitSha: string;
  summary: string;
  path?: string;
  author?: string;
  authoredAt?: string;
}

export interface IndexedHistory {
  id: string;
  repositoryScope: string;
  indexedCommitSha: string;
  commitSha: string;
  summary: string;
  path?: string;
  author?: string;
  authoredAt?: string;
  contentSha256: string;
  vector: number[];
}

export interface IndexEmbeddingMetadata {
  providerId: string;
  kind: "local-model" | "lexical-fallback";
  dimensions: number;
}

export interface RepositoryIndex {
  schemaVersion: 2;
  storageKey: string;
  repository: string;
  repositoryScope: string;
  visibility: RepositoryVisibility;
  commitSha: string;
  contentSha256: string;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  calls: IndexedCall[];
  history: IndexedHistory[];
  embedding: IndexEmbeddingMetadata;
  /**
   * Caller-supplied audit metadata. It is omitted by default so identical
   * repository snapshots produce byte-for-byte equivalent indexes.
   */
  createdAt?: string;
}

export interface RepositoryIndexInput {
  repository: string;
  repositoryId?: string | number;
  repositoryScope?: string;
  visibility?: RepositoryVisibility;
  commitSha: string;
  files: Record<string, string>;
  history?: RepositoryHistoryInput[];
  indexedAt?: string;
}

export interface ParsedSymbol {
  localId: string;
  name: string;
  qualifiedName: string;
  kind: IndexedSymbolKind;
  line: number;
  endLine: number;
  content: string;
}

export interface ParsedImport {
  line: number;
  source: string;
  names: string[];
  kind: IndexedImport["kind"];
  containingSymbolLocalId?: string;
}

export interface ParsedCall {
  line: number;
  target: string;
  callerSymbolLocalId?: string;
}

export interface ParsedSourceFile {
  path: string;
  language: IndexedLanguage;
  parser: IndexParserKind;
  parserId: string;
  contentSha256: string;
  lineCount: number;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  diagnostic?: IndexedFile["diagnostic"];
}

export interface RepositorySourceParser {
  readonly id: string;
  parse(path: string, content: string): Promise<ParsedSourceFile>;
}

/**
 * Embedding providers must be local and deterministic. A network-backed
 * provider does not satisfy this contract.
 */
export interface LocalEmbeddingProvider {
  readonly id: string;
  readonly kind: IndexEmbeddingMetadata["kind"];
  readonly locality: "local";
  readonly deterministic: true;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface SynchronousLocalEmbeddingProvider extends LocalEmbeddingProvider {
  embedSync(texts: readonly string[]): readonly (readonly number[])[];
}

export interface RepositoryIndexReference {
  repositoryScope: string;
  commitSha: string;
}

/**
 * A snapshot's identity without its content.
 *
 * Every scalar identity field retrieval reads is already a first-class column on
 * `repository_indexes`, so all of this is answerable by a SELECT that omits
 * `index_document`. It exists to be a second, independent, DB-sourced witness to
 * a snapshot's identity: a caller that already holds the document can compare the
 * two, and a caller that only needs identity can skip the document entirely.
 *
 * It deliberately carries no `files`, `symbols`, `imports`, or `calls`. This is
 * not a trimmed `RepositoryIndex` and must never be substituted for one — a
 * distinct type is what keeps "identity only" from being indistinguishable from
 * "an index that happens to be empty".
 */
export interface RepositoryIndexDescriptor extends RepositoryIndexReference {
  storageKey: string;
  repository: string;
  visibility: RepositoryVisibility;
  embedding: IndexEmbeddingMetadata;
}

export interface PersistedVectorRow {
  storageKey: string;
  repositoryScope: string;
  commitSha: string;
  visibility: RepositoryVisibility;
  providerId: string;
  dimensions: number;
  recordType: "symbol" | "history";
  recordId: string;
  path?: string;
  vector: number[];
}

/**
 * Everything retrieval needs to build one candidate without the materialised
 * index document: where the record is, what it is called, and its content. A
 * nearest-neighbour match names a record; this is how that name becomes a
 * candidate through a bounded fetch rather than a full-document load.
 *
 * `summary` carries a history record's raw summary because the in-memory path
 * matches changed names and the query against the summary alone, not against the
 * rendered content, which also carries commit, path, and author headers. Symbol
 * records leave it undefined and are matched against `content`.
 */
export interface PersistedRecordRow {
  storageKey: string;
  repositoryScope: string;
  commitSha: string;
  recordType: "symbol" | "history";
  recordId: string;
  path: string;
  line: number;
  endLine: number;
  name: string;
  content: string;
  contentSha256: string;
  summary?: string;
}

export interface RepositoryRecordReference {
  recordType: PersistedRecordRow["recordType"];
  recordId: string;
}

/**
 * A batched hydration request. Retrieval issues one of these per repository for
 * all of that repository's matches together, so hydrating N matches costs one
 * round trip rather than N.
 */
export interface RepositoryRecordHydrationRequest extends RepositoryIndexReference {
  records: readonly RepositoryRecordReference[];
}

export interface RepositoryVectorQuery extends RepositoryIndexReference {
  providerId: string;
  vector: readonly number[];
  limit: number;
  recordTypes?: readonly PersistedVectorRow["recordType"][];
}

export interface RepositoryVectorMatch {
  row: PersistedVectorRow;
  score: number;
}

/**
 * One incremental index publication. `upserts` carries only the rows whose
 * content changed; `deletedRecordIds` names rows that no longer exist at the new
 * head. Unchanged rows are re-published under the new commit's storage key by
 * the caller because both the storage key and every record id are commit-scoped,
 * so no row can be silently retained across commits.
 */
export interface RepositoryIndexVectorDelta {
  index: RepositoryIndex;
  upserts: readonly PersistedVectorRow[];
  deletedRecordIds: readonly string[];
}

/**
 * Deliberately database-neutral. A PostgreSQL implementation can map `vector`
 * to a pgvector column while retaining repository scope and commit predicates
 * in every read.
 */
export interface RepositoryIndexPersistence {
  replace(index: RepositoryIndex, vectors: readonly PersistedVectorRow[]): Promise<void>;
  load(reference: RepositoryIndexReference): Promise<RepositoryIndex | undefined>;
  query(request: RepositoryVectorQuery): Promise<RepositoryVectorMatch[]>;
  hydrateRecords(
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedRecordRow[]>;
}
