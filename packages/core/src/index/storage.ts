import { posix } from "node:path";
import { cosineSimilarity } from "./lexical.js";
import type {
  PersistedVectorRow,
  RepositoryIdentity,
  RepositoryIndex,
  RepositoryIndexInput,
  RepositoryIndexPersistence,
  RepositoryIndexReference,
  RepositoryVectorMatch,
  RepositoryVectorQuery
} from "./types.js";

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

export function assertIndexReference(
  index: RepositoryIndex,
  reference: RepositoryIndexReference
): void {
  if (!["public", "private", "internal"].includes(index.visibility)) {
    throw new Error("repository index has an invalid visibility");
  }
  const commitSha = normalizeCommitSha(reference.commitSha);
  if (index.repositoryScope !== reference.repositoryScope || index.commitSha !== commitSha) {
    throw new Error("repository index does not match the explicitly requested scope and commit");
  }
  const expectedStorageKey = repositoryIndexStorageKey(reference);
  if (index.storageKey !== expectedStorageKey) {
    throw new Error("repository index storage key is not canonical for its scope and commit");
  }
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

function cloneIndex(index: RepositoryIndex): RepositoryIndex {
  return structuredClone(index);
}

export class InMemoryRepositoryIndexPersistence implements RepositoryIndexPersistence {
  readonly #indexes = new Map<string, RepositoryIndex>();
  readonly #vectors = new Map<string, PersistedVectorRow[]>();

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
  }

  async load(reference: RepositoryIndexReference): Promise<RepositoryIndex | undefined> {
    const key = repositoryIndexStorageKey(reference);
    const index = this.#indexes.get(key);
    if (!index) return undefined;
    assertIndexReference(index, reference);
    return cloneIndex(index);
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
