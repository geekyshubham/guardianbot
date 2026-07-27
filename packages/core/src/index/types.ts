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
 * Deliberately database-neutral. A PostgreSQL implementation can map `vector`
 * to a pgvector column while retaining repository scope and commit predicates
 * in every read.
 */
export interface RepositoryIndexPersistence {
  replace(index: RepositoryIndex, vectors: readonly PersistedVectorRow[]): Promise<void>;
  load(reference: RepositoryIndexReference): Promise<RepositoryIndex | undefined>;
  query(request: RepositoryVectorQuery): Promise<RepositoryVectorMatch[]>;
}
