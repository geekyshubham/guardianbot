import { createHash } from "node:crypto";
import type { SynchronousLocalEmbeddingProvider } from "./types.js";

const DEFAULT_LEXICAL_DIMENSIONS = 96;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSourceText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
}

export function lexicalTokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
}

/**
 * Deterministic feature hashing. This is an honest lexical fallback, not a
 * semantic embedding model.
 */
export function lexicalFeatureVector(
  content: string,
  dimensions = DEFAULT_LEXICAL_DIMENSIONS
): number[] {
  if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4096) {
    throw new RangeError("lexical embedding dimensions must be an integer between 8 and 4096");
  }

  const vector = new Array<number>(dimensions).fill(0);
  for (const token of lexicalTokens(content)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

export class LexicalHashEmbeddingProvider implements SynchronousLocalEmbeddingProvider {
  readonly id: string;
  readonly kind = "lexical-fallback" as const;
  readonly locality = "local" as const;
  readonly deterministic = true as const;

  constructor(readonly dimensions = DEFAULT_LEXICAL_DIMENSIONS) {
    if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4096) {
      throw new RangeError("lexical embedding dimensions must be an integer between 8 and 4096");
    }
    this.id = `guardianbot-lexical-sha256-v1-${dimensions}`;
  }

  embedSync(texts: readonly string[]): readonly (readonly number[])[] {
    return texts.map((text) => lexicalFeatureVector(text, this.dimensions));
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return this.embedSync(texts);
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new RangeError("vectors must have equal dimensions");
  }
  let product = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    product += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return product / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function lexicalOverlapScore(query: string, content: string): number {
  const queryTokens = new Set(lexicalTokens(query));
  if (!queryTokens.size) return 0;
  const contentTokens = new Set(lexicalTokens(content));
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(queryTokens.size * Math.max(1, contentTokens.size));
}

export function validateEmbeddingVectors(
  vectors: readonly (readonly number[])[],
  expectedCount: number,
  dimensions: number
): number[][] {
  if (vectors.length !== expectedCount) {
    throw new Error(
      `embedding provider returned ${vectors.length} vectors for ${expectedCount} inputs`
    );
  }
  return vectors.map((vector) => {
    if (vector.length !== dimensions) {
      throw new Error(
        `embedding provider returned ${vector.length} dimensions; expected ${dimensions}`
      );
    }
    const values = Array.from(vector);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("embedding provider returned a non-finite value");
    }
    return values;
  });
}
