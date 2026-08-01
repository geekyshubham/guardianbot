import { posix } from "node:path";
import { cosineSimilarity, sha256 } from "./lexical.js";
import type {
  IndexedHistory,
  PersistedRecordRow,
  PersistedVectorRow,
  RepositoryIdentity,
  RepositoryIndex,
  RepositoryIndexDescriptor,
  RepositoryIndexInput,
  RepositoryIndexPersistence,
  RepositoryIndexReference,
  RepositoryRecordHydrationRequest,
  RepositoryVectorMatch,
  RepositoryVectorQuery
} from "./types.js";

/** Fallback path for a history record that names no file. */
export const HISTORY_RECORD_PATH = ".guardianbot/history";

const INDEX_STORAGE_PREFIX = "guardianbot/repository-index/v2";

function rejectControlCharacters(value: string, field: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} cannot contain control characters`);
  }
}

export function normalizeCommitSha(value: string): string {
  const commitSha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(commitSha)) {
    throw new Error("commitSha must be a 7-64 character hexadecimal commit identifier");
  }
  return commitSha;
}

export function normalizeRepositoryPath(path: string): string {
  rejectControlCharacters(path, "repository path");
  const slashPath = path.replace(/\\/g, "/");
  if (!slashPath || slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)) {
    throw new Error(`repository path must be relative: ${JSON.stringify(path)}`);
  }
  const segments = slashPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`repository path contains an unsafe segment: ${JSON.stringify(path)}`);
  }
  const normalized = posix.normalize(slashPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`repository path escapes the repository: ${JSON.stringify(path)}`);
  }
  return normalized;
}

export function resolveRepositoryIdentity(
  input: Pick<
    RepositoryIndexInput,
    "repository" | "repositoryId" | "repositoryScope" | "visibility"
  >
): RepositoryIdentity {
  const fullName = input.repository.trim();
  if (!fullName || fullName.length > 300) {
    throw new Error("repository must be between 1 and 300 characters");
  }
  rejectControlCharacters(fullName, "repository");

  let scope: string;
  if (input.repositoryScope !== undefined) {
    scope = input.repositoryScope.trim();
  } else if (input.repositoryId !== undefined) {
    const repositoryId = String(input.repositoryId).trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(repositoryId)) {
      throw new Error("repositoryId contains unsupported characters");
    }
    scope = `github:${repositoryId}`;
  } else {
    // Compatibility fallback. Production callers should pass repositoryId or
    // repositoryScope so renames cannot change the isolation boundary.
    scope = `name:${fullName.toLowerCase()}`;
  }
  if (!scope || scope.length > 256) {
    throw new Error("repositoryScope must be between 1 and 256 characters");
  }
  rejectControlCharacters(scope, "repositoryScope");
  const visibility = input.visibility ?? "private";
  if (!["public", "private", "internal"].includes(visibility)) {
    throw new Error("repository visibility must be public, private, or internal");
  }

  return {
    scope,
    fullName,
    visibility
  };
}

export function repositoryIndexStorageKey(reference: RepositoryIndexReference): string {
  const scope = reference.repositoryScope.trim();
  if (!scope || scope.length > 256) {
    throw new Error("repositoryScope must be between 1 and 256 characters");
  }
  rejectControlCharacters(scope, "repositoryScope");
  const commitSha = normalizeCommitSha(reference.commitSha);
  return `${INDEX_STORAGE_PREFIX}/${encodeURIComponent(scope)}/${commitSha}`;
}

/**
 * The identity fields a stored snapshot must agree with its reference on. Both
 * the materialised document and the column-sourced descriptor carry these, which
 * is what makes the two comparable.
 */
type IndexIdentityFields = Pick<
  RepositoryIndex,
  "storageKey" | "repositoryScope" | "commitSha" | "visibility"
>;

/**
 * The three checks that make a stored identity trustworthy, shared by the
 * document and descriptor asserts so the two can never drift.
 *
 * The storage key check is the load-bearing one and it is deliberately not a
 * read of the stored value: the key is *derived* from the requested scope and
 * commit, and the stored key must equal that derivation. A stored key is
 * therefore never trusted, only ever confirmed, so a row whose key was written
 * non-canonically is rejected rather than followed.
 */
function assertIndexIdentity(
  identity: IndexIdentityFields,
  reference: RepositoryIndexReference,
  subject: string
): void {
  if (!["public", "private", "internal"].includes(identity.visibility)) {
    throw new Error(`${subject} has an invalid visibility`);
  }
  const commitSha = normalizeCommitSha(reference.commitSha);
  if (identity.repositoryScope !== reference.repositoryScope || identity.commitSha !== commitSha) {
    throw new Error(`${subject} does not match the explicitly requested scope and commit`);
  }
  const expectedStorageKey = repositoryIndexStorageKey(reference);
  if (identity.storageKey !== expectedStorageKey) {
    throw new Error(`${subject} storage key is not canonical for its scope and commit`);
  }
}

export function assertIndexReference(
  index: RepositoryIndex,
  reference: RepositoryIndexReference
): void {
  assertIndexIdentity(index, reference, "repository index");
}

/**
 * The descriptor counterpart of `assertIndexReference`.
 *
 * A descriptor is read from columns rather than from the document, so it is an
 * independent witness to the same identity. It is validated identically and by
 * the same code, which is what licenses a caller holding both to compare them:
 * any disagreement is then a real storage inconsistency and not an artefact of
 * two different validation rules.
 */
export function assertDescriptorReference(
  descriptor: RepositoryIndexDescriptor,
  reference: RepositoryIndexReference
): void {
  assertIndexIdentity(descriptor, reference, "repository index descriptor");
}

export function toPersistedVectorRows(index: RepositoryIndex): PersistedVectorRow[] {
  assertIndexReference(index, index);
  const common = {
    storageKey: index.storageKey,
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    visibility: index.visibility,
    providerId: index.embedding.providerId,
    dimensions: index.embedding.dimensions
  };
  return [
    ...index.symbols.map((symbol): PersistedVectorRow => ({
      ...common,
      recordType: "symbol",
      recordId: symbol.id,
      path: symbol.path,
      vector: [...symbol.vector]
    })),
    ...index.history.map((entry): PersistedVectorRow => ({
      ...common,
      recordType: "history",
      recordId: entry.id,
      path: entry.path,
      vector: [...entry.vector]
    }))
  ];
}

/**
 * The single definition of a history record's retrievable content. Retrieval
 * renders this from the materialised document and durable hydration stores it, so
 * both paths must agree byte-for-byte or the two would score differently. It
 * lives here, beside the row projection, so neither path can drift from it.
 */
export function renderHistoryRecordContent(entry: IndexedHistory): string {
  return [
    `Commit: ${entry.commitSha}`,
    entry.path ? `Path: ${entry.path}` : undefined,
    entry.author ? `Author: ${entry.author}` : undefined,
    entry.authoredAt ? `Authored-At: ${entry.authoredAt}` : undefined,
    "",
    entry.summary
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * Projects the index into the per-record rows a query needs to build candidates
 * without loading the whole document. It is the write-side counterpart of
 * `hydrateRecords`, and is keyed identically to `toPersistedVectorRows` so a
 * nearest-neighbour match names exactly one of these rows.
 */
export function toPersistedRecordRows(index: RepositoryIndex): PersistedRecordRow[] {
  assertIndexReference(index, index);
  const common = {
    storageKey: index.storageKey,
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha
  };
  return [
    ...index.symbols.map((symbol): PersistedRecordRow => ({
      ...common,
      recordType: "symbol",
      recordId: symbol.id,
      path: symbol.path,
      line: symbol.line,
      endLine: symbol.endLine,
      name: symbol.name,
      content: symbol.content,
      contentSha256: symbol.contentSha256
    })),
    ...index.history.map((entry): PersistedRecordRow => {
      const content = renderHistoryRecordContent(entry);
      return {
        ...common,
        recordType: "history",
        recordId: entry.id,
        path: entry.path ?? HISTORY_RECORD_PATH,
        line: 1,
        endLine: 1,
        // A history record has no symbol name. Its commit is the closest stable
        // identifier, and name-based matching uses `summary` for these rows.
        name: entry.commitSha,
        content,
        contentSha256: sha256(content),
        summary: entry.summary
      };
    })
  ];
}

export function compareRecordRows(left: PersistedRecordRow, right: PersistedRecordRow): number {
  if (left.recordType !== right.recordType) {
    return left.recordType < right.recordType ? -1 : 1;
  }
  return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
}

function cloneIndex(index: RepositoryIndex): RepositoryIndex {
  return structuredClone(index);
}

export class InMemoryRepositoryIndexPersistence implements RepositoryIndexPersistence {
  readonly #indexes = new Map<string, RepositoryIndex>();
  readonly #vectors = new Map<string, PersistedVectorRow[]>();
  readonly #records = new Map<string, Map<string, PersistedRecordRow>>();

  async replace(index: RepositoryIndex, vectors: readonly PersistedVectorRow[]): Promise<void> {
    assertIndexReference(index, index);
    const expectedRows = toPersistedVectorRows(index);
    if (vectors.length !== expectedRows.length) {
      throw new Error("persistence vector rows must cover every indexed symbol and history entry");
    }
    const expectedByRecord = new Map(
      expectedRows.map((row) => [`${row.recordType}:${row.recordId}`, row])
    );
    const seenRecords = new Set<string>();
    for (const row of vectors) {
      const recordKey = `${row.recordType}:${row.recordId}`;
      const expected = expectedByRecord.get(recordKey);
      if (
        !expected ||
        seenRecords.has(recordKey) ||
        row.storageKey !== index.storageKey ||
        row.repositoryScope !== index.repositoryScope ||
        row.commitSha !== index.commitSha ||
        row.visibility !== index.visibility ||
        row.providerId !== index.embedding.providerId ||
        row.dimensions !== index.embedding.dimensions ||
        row.path !== expected.path ||
        row.vector.length !== index.embedding.dimensions ||
        row.vector.some(
          (value, vectorIndex) =>
            !Number.isFinite(value) || value !== expected.vector[vectorIndex]
        )
      ) {
        throw new Error("persistence vector row does not match its repository index");
      }
      seenRecords.add(recordKey);
    }
    this.#indexes.set(index.storageKey, cloneIndex(index));
    this.#vectors.set(
      index.storageKey,
      vectors.map((row) => structuredClone(row))
    );
    this.#records.set(
      index.storageKey,
      new Map(
        toPersistedRecordRows(index).map((row) => [`${row.recordType}:${row.recordId}`, row])
      )
    );
  }

  async load(reference: RepositoryIndexReference): Promise<RepositoryIndex | undefined> {
    const key = repositoryIndexStorageKey(reference);
    const index = this.#indexes.get(key);
    if (!index) return undefined;
    assertIndexReference(index, reference);
    return cloneIndex(index);
  }

  /**
   * Bounded per-match content fetch. The canonical storage key is derived from
   * the requested scope and commit, exactly as in `query`, so a caller-supplied
   * record id can only ever resolve inside the requested repository snapshot: two
   * repositories holding byte-identical content still hold separate row maps.
   */
  async hydrateRecords(
    request: RepositoryRecordHydrationRequest
  ): Promise<PersistedRecordRow[]> {
    if (request.records.length > 1_000) {
      throw new RangeError("record hydration is limited to 1000 records per request");
    }
    if (!request.records.length) return [];
    const key = repositoryIndexStorageKey(request);
    const index = this.#indexes.get(key);
    if (!index) return [];
    assertIndexReference(index, request);
    const rows = this.#records.get(key);
    if (!rows) return [];
    const hydrated = new Map<string, PersistedRecordRow>();
    for (const reference of request.records) {
      const recordKey = `${reference.recordType}:${reference.recordId}`;
      const row = rows.get(recordKey);
      if (row && !hydrated.has(recordKey)) {
        hydrated.set(recordKey, structuredClone(row));
      }
    }
    return [...hydrated.values()].sort(compareRecordRows);
  }

  async query(request: RepositoryVectorQuery): Promise<RepositoryVectorMatch[]> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
      throw new RangeError("vector query limit must be between 1 and 1000");
    }
    const key = repositoryIndexStorageKey(request);
    const index = this.#indexes.get(key);
    if (!index) return [];
    assertIndexReference(index, request);
    if (
      request.providerId !== index.embedding.providerId ||
      request.vector.length !== index.embedding.dimensions ||
      request.vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("vector query is incompatible with the stored index embedding");
    }
    const acceptedTypes = request.recordTypes
      ? new Set(request.recordTypes)
      : undefined;
    return (this.#vectors.get(key) ?? [])
      .filter((row) => !acceptedTypes || acceptedTypes.has(row.recordType))
      .map((row) => ({
        row: structuredClone(row),
        score: cosineSimilarity(request.vector, row.vector)
      }))
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        return left.row.recordId < right.row.recordId
          ? -1
          : left.row.recordId > right.row.recordId
            ? 1
            : 0;
      })
      .slice(0, request.limit);
  }
}
