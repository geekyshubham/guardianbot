import { normalizeSourceText, sha256, validateEmbeddingVectors } from "./lexical.js";
import { parseTextFallback, TreeSitterSourceParser } from "./parsers.js";
import {
  normalizeCommitSha,
  normalizeRepositoryPath,
  repositoryIndexStorageKey,
  resolveRepositoryIdentity
} from "./storage.js";
import type {
  IndexedCall,
  IndexedFile,
  IndexedHistory,
  IndexedImport,
  IndexedSymbol,
  LocalEmbeddingProvider,
  ParsedSourceFile,
  RepositoryHistoryInput,
  RepositoryIndex,
  RepositoryIndexInput,
  RepositorySourceParser,
  SynchronousLocalEmbeddingProvider
} from "./types.js";

const MAX_TEXT_CHUNK_CHARACTERS = 8_000;
const MAX_METADATA_CHARACTERS = 1_000;

export interface RepositoryIndexBuildOptions {
  parser?: RepositorySourceParser;
  embeddingProvider: LocalEmbeddingProvider;
}

export interface RepositoryIndexIncrementalInput {
  /** Index published for the previous head of the same repository. */
  previous: RepositoryIndex;
  /** Content for paths that were added or modified between the two commits. */
  changedFiles: Record<string, string>;
  /** Paths that no longer exist at the new head. */
  removedPaths?: readonly string[];
  commitSha: string;
  repository?: string;
  repositoryId?: string | number;
  repositoryScope?: string;
  visibility?: RepositoryIndex["visibility"];
  history?: readonly RepositoryHistoryInput[];
  indexedAt?: string;
}

export interface RepositoryIndexIncrementalResult {
  index: RepositoryIndex;
  /** Paths parsed from freshly fetched content. */
  reindexedPaths: string[];
  /** Paths carried forward from the previous index without refetching. */
  carriedPaths: string[];
  removedPaths: string[];
  /** Embedding texts that had to be embedded because no prior vector matched. */
  embeddedRecordCount: number;
  /** Embedding texts served from the previous index by content digest. */
  reusedRecordCount: number;
}

interface NormalizedFile {
  path: string;
  content: string;
}

interface SymbolDraft extends Omit<IndexedSymbol, "vector"> {}
interface HistoryDraft extends Omit<IndexedHistory, "vector"> {}

interface PreparedIndex {
  repository: RepositoryIndex["repository"];
  repositoryScope: RepositoryIndex["repositoryScope"];
  visibility: RepositoryIndex["visibility"];
  commitSha: string;
  storageKey: string;
  files: IndexedFile[];
  symbols: SymbolDraft[];
  imports: IndexedImport[];
  calls: IndexedCall[];
  history: HistoryDraft[];
  createdAt?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortByStableKey<T>(values: T[], key: (value: T) => string): T[] {
  return values.sort((left, right) => compareText(key(left), key(right)));
}

function normalizeFiles(files: Record<string, string>): NormalizedFile[] {
  const normalized = new Map<string, string>();
  for (const [unsafePath, source] of Object.entries(files)) {
    const path = normalizeRepositoryPath(unsafePath);
    if (normalized.has(path)) {
      throw new Error(`multiple input paths normalize to ${JSON.stringify(path)}`);
    }
    normalized.set(path, normalizeSourceText(source));
  }
  return [...normalized]
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => compareText(left.path, right.path));
}

function normalizeAuditTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("indexedAt must be a valid date-time");
  }
  return date.toISOString();
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeSourceText(value).trim().slice(0, MAX_METADATA_CHARACTERS) || undefined;
}

function normalizeHistory(
  entries: readonly RepositoryHistoryInput[] | undefined,
  repositoryScope: string,
  indexedCommitSha: string
): HistoryDraft[] {
  return sortByStableKey(
    (entries ?? []).map((entry) => {
      const commitSha = normalizeCommitSha(entry.commitSha);
      const summary = normalizeSourceText(entry.summary).slice(0, MAX_TEXT_CHUNK_CHARACTERS);
      const path = entry.path ? normalizeRepositoryPath(entry.path) : undefined;
      const author = normalizeOptionalMetadata(entry.author);
      const authoredAt = normalizeAuditTimestamp(entry.authoredAt);
      const id = sha256(
        [
          repositoryScope,
          indexedCommitSha,
          "history",
          commitSha,
          path ?? "",
          author ?? "",
          authoredAt ?? "",
          sha256(summary)
        ].join("\u0000")
      );
      return {
        id,
        repositoryScope,
        indexedCommitSha,
        commitSha,
        summary,
        path,
        author,
        authoredAt,
        contentSha256: sha256(summary)
      };
    }),
    (entry) =>
      `${entry.commitSha}\u0000${entry.path ?? ""}\u0000${entry.authoredAt ?? ""}\u0000${entry.id}`
  );
}

function ensureFileTextSymbol(parsed: ParsedSourceFile, content: string): ParsedSourceFile {
  if (parsed.symbols.length || !content.trim()) return parsed;
  const lineCount = content.split("\n").length;
  return {
    ...parsed,
    symbols: [
      {
        localId: `text:${parsed.path}`,
        name: parsed.path,
        qualifiedName: parsed.path,
        kind: "text",
        line: 1,
        endLine: lineCount,
        content:
          content.length <= MAX_TEXT_CHUNK_CHARACTERS
            ? content
            : `${content.slice(0, MAX_TEXT_CHUNK_CHARACTERS)}\n[guardianbot-truncated]`
      }
    ]
  };
}

function validateProvider(provider: LocalEmbeddingProvider): void {
  if (
    provider.locality !== "local" ||
    provider.deterministic !== true ||
    !provider.id.trim() ||
    !Number.isSafeInteger(provider.dimensions) ||
    provider.dimensions < 1 ||
    provider.dimensions > 65_536
  ) {
    throw new Error("embedding provider must be local, deterministic, named, and dimensioned");
  }
}

function simpleTargetName(value: string): string {
  const identifiers = value.match(/[A-Za-z_$][\w$]*/g);
  return (identifiers?.at(-1) ?? value).toLowerCase();
}

function prepareIndex(
  input: RepositoryIndexInput,
  parsedFiles: readonly ParsedSourceFile[]
): PreparedIndex {
  const identity = resolveRepositoryIdentity(input);
  const commitSha = normalizeCommitSha(input.commitSha);
  const storageKey = repositoryIndexStorageKey({
    repositoryScope: identity.scope,
    commitSha
  });
  const files: IndexedFile[] = [];
  const symbols: SymbolDraft[] = [];
  const seenSymbolIds = new Set<string>();
  const imports: IndexedImport[] = [];
  const pendingCalls: Array<{
    path: string;
    language: IndexedCall["language"];
    line: number;
    target: string;
    callerSymbolId?: string;
  }> = [];

  for (const parsed of parsedFiles) {
    files.push({
      path: parsed.path,
      language: parsed.language,
      parser: parsed.parser,
      parserId: parsed.parserId,
      contentSha256: parsed.contentSha256,
      lineCount: parsed.lineCount,
      diagnostic: parsed.diagnostic
    });

    const symbolIdsByLocalId = new Map<string, string>();
    for (const symbol of parsed.symbols) {
      const content = normalizeSourceText(symbol.content);
      const contentSha256 = sha256(content);
      const id = sha256(
        [
          identity.scope,
          commitSha,
          parsed.path,
          symbol.kind,
          symbol.qualifiedName,
          String(symbol.line),
          String(symbol.endLine),
          contentSha256
        ].join("\u0000")
      );
      symbolIdsByLocalId.set(symbol.localId, id);
      // Some parsers can report the same declaration through overlapping
      // grammar queries (notably generated/minified JavaScript). Keep the
      // local-id mapping for graph edges, but persist one canonical symbol per
      // content-derived identity so PostgreSQL vector upserts remain unique.
      if (seenSymbolIds.has(id)) continue;
      seenSymbolIds.add(id);
      symbols.push({
        id,
        repository: identity.fullName,
        repositoryScope: identity.scope,
        commitSha,
        path: parsed.path,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        language: parsed.language,
        parser: parsed.parser,
        line: symbol.line,
        endLine: symbol.endLine,
        content,
        contentSha256
      });
    }

    for (const imported of parsed.imports) {
      const names = [...new Set(imported.names.map((name) => name.trim()).filter(Boolean))].sort(
        compareText
      );
      const containingSymbolId = imported.containingSymbolLocalId
        ? symbolIdsByLocalId.get(imported.containingSymbolLocalId)
        : undefined;
      const source = normalizeSourceText(imported.source).trim().slice(0, MAX_METADATA_CHARACTERS);
      const id = sha256(
        [
          identity.scope,
          commitSha,
          parsed.path,
          "import",
          String(imported.line),
          imported.kind,
          source,
          names.join(","),
          containingSymbolId ?? ""
        ].join("\u0000")
      );
      imports.push({
        id,
        repositoryScope: identity.scope,
        commitSha,
        path: parsed.path,
        language: parsed.language,
        line: imported.line,
        source,
        names,
        kind: imported.kind,
        containingSymbolId
      });
    }

    for (const call of parsed.calls) {
      const callerSymbolId = call.callerSymbolLocalId
        ? symbolIdsByLocalId.get(call.callerSymbolLocalId)
        : undefined;
      const caller = callerSymbolId
        ? symbols.find((symbol) => symbol.id === callerSymbolId)
        : undefined;
      if (
        caller &&
        call.line === caller.line &&
        simpleTargetName(call.target) === caller.name.toLowerCase()
      ) {
        // Regex fallback can interpret the declaration itself as a call.
        continue;
      }
      pendingCalls.push({
        path: parsed.path,
        language: parsed.language,
        line: call.line,
        target: normalizeSourceText(call.target).trim().slice(0, MAX_METADATA_CHARACTERS),
        callerSymbolId
      });
    }
  }

  sortByStableKey(files, (file) => file.path);
  sortByStableKey(
    symbols,
    (symbol) =>
      `${symbol.path}\u0000${String(symbol.line).padStart(10, "0")}\u0000${symbol.kind}\u0000${symbol.qualifiedName}\u0000${symbol.id}`
  );
  sortByStableKey(
    imports,
    (entry) =>
      `${entry.path}\u0000${String(entry.line).padStart(10, "0")}\u0000${entry.source}\u0000${entry.id}`
  );

  const symbolsBySimpleName = new Map<string, string[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const matches = symbolsBySimpleName.get(key) ?? [];
    matches.push(symbol.id);
    symbolsBySimpleName.set(key, matches);
  }
  for (const matches of symbolsBySimpleName.values()) matches.sort(compareText);

  const calls: IndexedCall[] = [];
  const seenCallIds = new Set<string>();
  for (const call of pendingCalls) {
    const resolvedSymbolIds = symbolsBySimpleName.get(simpleTargetName(call.target)) ?? [];
    const id = sha256(
      [
        identity.scope,
        commitSha,
        call.path,
        "call",
        String(call.line),
        call.target,
        call.callerSymbolId ?? "",
        resolvedSymbolIds.join(",")
      ].join("\u0000")
    );
    // Parsers can report the same call site through overlapping grammar
    // queries (and a prior index may carry those duplicates). Keep one
    // canonical edge per content-derived identity so PostgreSQL edge
    // upserts remain unique within a batch.
    if (seenCallIds.has(id)) continue;
    seenCallIds.add(id);
    calls.push({
      id,
      repositoryScope: identity.scope,
      commitSha,
      path: call.path,
      language: call.language,
      line: call.line,
      target: call.target,
      callerSymbolId: call.callerSymbolId,
      resolvedSymbolIds: [...resolvedSymbolIds],
      resolution: resolvedSymbolIds.length ? "name-match" : "unresolved"
    });
  }
  sortByStableKey(
    calls,
    (call) =>
      `${call.path}\u0000${String(call.line).padStart(10, "0")}\u0000${call.target}\u0000${call.id}`
  );

  return {
    repository: identity.fullName,
    repositoryScope: identity.scope,
    visibility: identity.visibility,
    commitSha,
    storageKey,
    files,
    symbols,
    imports,
    calls,
    history: normalizeHistory(input.history, identity.scope, commitSha),
    createdAt: normalizeAuditTimestamp(input.indexedAt)
  };
}

function finalizeIndex(
  prepared: PreparedIndex,
  provider: LocalEmbeddingProvider,
  vectors: readonly (readonly number[])[]
): RepositoryIndex {
  const validatedVectors = validateEmbeddingVectors(
    vectors,
    prepared.symbols.length + prepared.history.length,
    provider.dimensions
  );
  let vectorIndex = 0;
  const symbols: IndexedSymbol[] = prepared.symbols.map((symbol) => ({
    ...symbol,
    vector: validatedVectors[vectorIndex++]!
  }));
  const history: IndexedHistory[] = prepared.history.map((entry) => ({
    ...entry,
    vector: validatedVectors[vectorIndex++]!
  }));
  const embedding = {
    providerId: provider.id,
    kind: provider.kind,
    dimensions: provider.dimensions
  };
  const canonical = JSON.stringify({
    schemaVersion: 2,
    storageKey: prepared.storageKey,
    repository: prepared.repository,
    repositoryScope: prepared.repositoryScope,
    visibility: prepared.visibility,
    commitSha: prepared.commitSha,
    files: prepared.files,
    symbols,
    imports: prepared.imports,
    calls: prepared.calls,
    history,
    embedding
  });
  return {
    schemaVersion: 2,
    storageKey: prepared.storageKey,
    repository: prepared.repository,
    repositoryScope: prepared.repositoryScope,
    visibility: prepared.visibility,
    commitSha: prepared.commitSha,
    contentSha256: sha256(canonical),
    files: prepared.files,
    symbols,
    imports: prepared.imports,
    calls: prepared.calls,
    history,
    embedding,
    createdAt: prepared.createdAt
  };
}

/**
 * Rebuilds the parser output for a path that did not change between two commits,
 * from the previously published index alone. It exists so an incremental refresh
 * never refetches or reparses unchanged content.
 *
 * Every identifier in the result is a *local* id. `prepareIndex` recomputes the
 * durable ids from the new commit, which is required rather than optional: both
 * symbol ids and the storage key are commit-scoped, so no row may be carried
 * across commits under its old identity.
 */
function reconstructParsedFile(
  previous: RepositoryIndex,
  file: IndexedFile
): ParsedSourceFile {
  return {
    path: file.path,
    language: file.language,
    parser: file.parser,
    parserId: file.parserId,
    contentSha256: file.contentSha256,
    lineCount: file.lineCount,
    diagnostic: file.diagnostic,
    symbols: previous.symbols
      .filter((symbol) => symbol.path === file.path)
      .map((symbol) => ({
        localId: symbol.id,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        line: symbol.line,
        endLine: symbol.endLine,
        content: symbol.content
      })),
    imports: previous.imports
      .filter((entry) => entry.path === file.path)
      .map((entry) => ({
        line: entry.line,
        source: entry.source,
        names: [...entry.names],
        kind: entry.kind,
        containingSymbolLocalId: entry.containingSymbolId
      })),
    calls: previous.calls
      .filter((call) => call.path === file.path)
      .map((call) => ({
        line: call.line,
        target: call.target,
        callerSymbolLocalId: call.callerSymbolId
      }))
  };
}

/**
 * Reuses a previously computed vector for identical content. Embeddings are
 * deterministic and content-addressed by contract, so an unchanged
 * `contentSha256` under the same provider yields an identical vector. The
 * provider identity and dimensions are both checked, so a provider or dimension
 * change forces a full re-embed rather than mixing incomparable vector spaces.
 */
function reusableVectorsByDigest(
  previous: RepositoryIndex,
  provider: LocalEmbeddingProvider
): Map<string, number[]> {
  const reusable = new Map<string, number[]>();
  if (
    previous.embedding.providerId !== provider.id ||
    previous.embedding.kind !== provider.kind ||
    previous.embedding.dimensions !== provider.dimensions
  ) {
    return reusable;
  }
  for (const symbol of previous.symbols) {
    if (symbol.vector.length === provider.dimensions) {
      reusable.set(symbol.contentSha256, [...symbol.vector]);
    }
  }
  for (const entry of previous.history) {
    if (entry.vector.length === provider.dimensions) {
      reusable.set(entry.contentSha256, [...entry.vector]);
    }
  }
  return reusable;
}

/**
 * Builds the index for a new head by reparsing only the supplied changed paths
 * and carrying every other path forward from `previous`. The result is
 * indistinguishable from a full rebuild over the same file set: all durable ids,
 * the call graph, and `contentSha256` are recomputed from the new commit.
 */
export async function buildRepositoryIndexIncremental(
  input: RepositoryIndexIncrementalInput,
  options: RepositoryIndexBuildOptions
): Promise<RepositoryIndexIncrementalResult> {
  const provider = options.embeddingProvider;
  validateProvider(provider);
  const previous = input.previous;
  const changedFiles = normalizeFiles(input.changedFiles);
  const changedPaths = new Set(changedFiles.map((file) => file.path));
  const removedPaths = new Set(
    (input.removedPaths ?? []).map((path) => normalizeRepositoryPath(path))
  );
  for (const path of removedPaths) {
    if (changedPaths.has(path)) {
      throw new Error(`path cannot be both changed and removed: ${JSON.stringify(path)}`);
    }
  }

  const carriedFiles = previous.files.filter(
    (file) => !changedPaths.has(file.path) && !removedPaths.has(file.path)
  );
  const parser = options.parser ?? new TreeSitterSourceParser();
  const parsedChanged = await parseFiles(changedFiles, parser);
  const parsedFiles = [
    ...parsedChanged,
    ...carriedFiles.map((file) => reconstructParsedFile(previous, file))
  ].sort((left, right) => compareText(left.path, right.path));

  const prepared = prepareIndex(
    {
      repository: input.repository ?? previous.repository,
      repositoryId: input.repositoryId,
      repositoryScope: input.repositoryScope ?? previous.repositoryScope,
      visibility: input.visibility ?? previous.visibility,
      commitSha: input.commitSha,
      files: {},
      history: input.history ? [...input.history] : undefined,
      indexedAt: input.indexedAt
    },
    parsedFiles
  );
  if (prepared.repositoryScope !== previous.repositoryScope) {
    throw new Error("incremental index cannot change the repository isolation scope");
  }

  const reusable = reusableVectorsByDigest(previous, provider);
  const digests = [
    ...prepared.symbols.map((symbol) => symbol.contentSha256),
    ...prepared.history.map((entry) => entry.contentSha256)
  ];
  const texts = [
    ...prepared.symbols.map((symbol) => symbol.content),
    ...prepared.history.map((entry) => entry.summary)
  ];
  const missingPositions = digests
    .map((digest, position) => (reusable.has(digest) ? undefined : position))
    .filter((position): position is number => position !== undefined);
  const embedded = missingPositions.length
    ? validateEmbeddingVectors(
        await provider.embed(missingPositions.map((position) => texts[position]!)),
        missingPositions.length,
        provider.dimensions
      )
    : [];
  const vectors = digests.map((digest) => reusable.get(digest));
  missingPositions.forEach((position, offset) => {
    vectors[position] = embedded[offset]!;
  });

  return {
    index: finalizeIndex(
      prepared,
      provider,
      vectors.map((vector, position) => {
        if (!vector) {
          throw new Error(`no embedding was produced for record ${position}`);
        }
        return vector;
      })
    ),
    reindexedPaths: parsedChanged.map((file) => file.path).sort(compareText),
    carriedPaths: carriedFiles.map((file) => file.path).sort(compareText),
    removedPaths: [...removedPaths].sort(compareText),
    embeddedRecordCount: missingPositions.length,
    reusedRecordCount: digests.length - missingPositions.length
  };
}

async function parseFiles(
  files: readonly NormalizedFile[],
  parser: RepositorySourceParser
): Promise<ParsedSourceFile[]> {
  const parsed: ParsedSourceFile[] = [];
  // Sequential parsing bounds peak WASM memory for large repositories.
  for (const file of files) {
    let result: ParsedSourceFile;
    try {
      result = await parser.parse(file.path, file.content);
      if (result.path !== file.path) {
        throw new Error("parser returned a different repository path");
      }
    } catch {
      result = parseTextFallback(file.path, file.content, "parser-unavailable");
    }
    result = ensureFileTextSymbol(
      {
        ...result,
        path: file.path,
        contentSha256: sha256(file.content),
        lineCount: file.content ? file.content.split("\n").length : 0
      },
      file.content
    );
    parsed.push(result);
  }
  return parsed;
}

export async function buildRepositoryIndex(
  input: RepositoryIndexInput,
  options: RepositoryIndexBuildOptions
): Promise<RepositoryIndex> {
  validateProvider(options.embeddingProvider);
  const files = normalizeFiles(input.files);
  const parser = options.parser ?? new TreeSitterSourceParser();
  const parsedFiles = await parseFiles(files, parser);
  const prepared = prepareIndex(input, parsedFiles);
  const embeddingTexts = [
    ...prepared.symbols.map((symbol) => symbol.content),
    ...prepared.history.map((entry) => entry.summary)
  ];
  const vectors = await options.embeddingProvider.embed(embeddingTexts);
  return finalizeIndex(prepared, options.embeddingProvider, vectors);
}

export function buildRepositoryIndexFallback(
  input: RepositoryIndexInput,
  embeddingProvider: SynchronousLocalEmbeddingProvider
): RepositoryIndex {
  validateProvider(embeddingProvider);
  const files = normalizeFiles(input.files);
  const parsedFiles = files.map((file) =>
    ensureFileTextSymbol(parseTextFallback(file.path, file.content), file.content)
  );
  const prepared = prepareIndex(input, parsedFiles);
  const embeddingTexts = [
    ...prepared.symbols.map((symbol) => symbol.content),
    ...prepared.history.map((entry) => entry.summary)
  ];
  return finalizeIndex(
    prepared,
    embeddingProvider,
    embeddingProvider.embedSync(embeddingTexts)
  );
}
