import { createHash } from "node:crypto";

export interface IndexedSymbol {
  id: string;
  repository: string;
  commitSha: string;
  path: string;
  name: string;
  kind: "function" | "class" | "type" | "module" | "text";
  line: number;
  content: string;
  vector: number[];
}

export interface RepositoryIndex {
  repository: string;
  commitSha: string;
  symbols: IndexedSymbol[];
  createdAt: string;
}

const symbolPatterns: Array<{
  kind: IndexedSymbol["kind"];
  pattern: RegExp;
}> = [
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { kind: "function", pattern: /^\s*func\s+([A-Za-z_]\w*)/ },
  { kind: "class", pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: "type", pattern: /^\s*(?:export\s+)?(?:interface|type|enum|struct)\s+([A-Za-z_$][\w$]*)/ },
  { kind: "module", pattern: /^\s*module\s+([A-Za-z_:]\w*)/ }
];

export function localFeatureEmbedding(content: string, dimensions = 96): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of content.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

export function indexRepository(input: {
  repository: string;
  commitSha: string;
  files: Record<string, string>;
}): RepositoryIndex {
  const symbols: IndexedSymbol[] = [];
  for (const [path, content] of Object.entries(input.files)) {
    const lines = content.split(/\r?\n/);
    let found = false;
    lines.forEach((line, index) => {
      for (const candidate of symbolPatterns) {
        const match = line.match(candidate.pattern);
        if (!match?.[1]) continue;
        const start = Math.max(0, index - 2);
        const end = Math.min(lines.length, index + 12);
        const chunk = lines.slice(start, end).join("\n");
        symbols.push({
          id: createHash("sha256")
            .update(`${input.repository}:${input.commitSha}:${path}:${match[1]}:${index + 1}`)
            .digest("hex"),
          repository: input.repository,
          commitSha: input.commitSha,
          path,
          name: match[1],
          kind: candidate.kind,
          line: index + 1,
          content: chunk,
          vector: localFeatureEmbedding(chunk)
        });
        found = true;
        break;
      }
    });
    if (!found && content.trim()) {
      const chunk = content.slice(0, 4000);
      symbols.push({
        id: createHash("sha256")
          .update(`${input.repository}:${input.commitSha}:${path}:text`)
          .digest("hex"),
        repository: input.repository,
        commitSha: input.commitSha,
        path,
        name: path,
        kind: "text",
        line: 1,
        content: chunk,
        vector: localFeatureEmbedding(chunk)
      });
    }
  }
  return {
    repository: input.repository,
    commitSha: input.commitSha,
    symbols,
    createdAt: new Date().toISOString()
  };
}

function cosine(a: number[], b: number[]): number {
  let sum = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

export function retrieveContext(
  index: RepositoryIndex,
  query: string,
  limit = 20
): IndexedSymbol[] {
  const queryVector = localFeatureEmbedding(query);
  return [...index.symbols]
    .map((symbol) => ({ symbol, score: cosine(queryVector, symbol.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ symbol }) => symbol);
}

