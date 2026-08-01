import {
  buildRepositoryIndex,
  buildRepositoryIndexFallback,
  type RepositoryIndexBuildOptions
} from "./index/builder.js";
import {
  cosineSimilarity,
  lexicalFeatureVector,
  lexicalOverlapScore,
  LexicalHashEmbeddingProvider
} from "./index/lexical.js";
import type {
  IndexedSymbol,
  LocalEmbeddingProvider,
  RepositoryIndex,
  RepositoryIndexInput,
  RepositorySourceParser
} from "./index/types.js";

export * from "./index/types.js";
export * from "./index/lexical.js";
export * from "./index/parsers.js";
export * from "./index/storage.js";
export * from "./index/retrieval.js";
export {
  buildRepositoryIndex,
  buildRepositoryIndexFallback,
  buildRepositoryIndexIncremental,
  type RepositoryIndexBuildOptions,
  type RepositoryIndexIncrementalInput,
  type RepositoryIndexIncrementalResult
} from "./index/builder.js";

export interface SyntaxAwareIndexOptions {
  parser?: RepositorySourceParser;
  embeddingProvider?: LocalEmbeddingProvider;
}

/**
 * Compatibility API for callers that need synchronous indexing. It uses the
 * explicitly labeled deterministic text/regex and lexical fallback path.
 *
 * New production callers should use `indexRepositorySyntaxAware`.
 */
export function indexRepository(input: RepositoryIndexInput): RepositoryIndex {
  return buildRepositoryIndexFallback(input, new LexicalHashEmbeddingProvider());
}

/**
 * Parses Python, JavaScript/TypeScript, Swift, and Ruby with Tree-sitter WASM.
 * Any unsupported, oversized, or unparsable file fails closed to text indexing
 * without aborting the repository snapshot.
 */
export async function indexRepositorySyntaxAware(
  input: RepositoryIndexInput,
  options: SyntaxAwareIndexOptions = {}
): Promise<RepositoryIndex> {
  const buildOptions: RepositoryIndexBuildOptions = {
    embeddingProvider:
      options.embeddingProvider ?? new LexicalHashEmbeddingProvider(),
    parser: options.parser
  };
  return buildRepositoryIndex(input, buildOptions);
}

export const indexRepositoryWithParsers = indexRepositorySyntaxAware;

/**
 * Backwards-compatible name. This remains a lexical feature hash and must not
 * be described as a semantic embedding.
 */
export function localFeatureEmbedding(content: string, dimensions = 96): number[] {
  return lexicalFeatureVector(content, dimensions);
}

export function retrieveContext(
  index: RepositoryIndex,
  query: string,
  limit = 20
): IndexedSymbol[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("retrieval limit must be between 1 and 1000");
  }
  const queryVector =
    index.embedding.kind === "lexical-fallback"
      ? lexicalFeatureVector(query, index.embedding.dimensions)
      : undefined;
  return [...index.symbols]
    .map((symbol) => ({
      symbol,
      score: queryVector
        ? cosineSimilarity(queryVector, symbol.vector)
        : lexicalOverlapScore(query, symbol.content)
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.symbol.id < right.symbol.id
        ? -1
        : left.symbol.id > right.symbol.id
          ? 1
          : 0;
    })
    .slice(0, limit)
    .map(({ symbol }) => symbol);
}
