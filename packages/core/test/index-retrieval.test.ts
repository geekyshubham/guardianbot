import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryRepositoryIndexPersistence,
  LexicalHashEmbeddingProvider,
  indexRepositorySyntaxAware,
  retrieveDurableRepositoryContext,
  retrieveRepositoryContext,
  retrievedContextKindCoverage,
  retrievedContextKinds,
  reviewKindByRetrievedKind,
  toPersistedVectorRows,
  type DurableRepositoryContextSource,
  type RepositoryIndex,
  type RetrievedContextKind,
  type RetrievedContextKindDurability
} from "../src/indexer.js";

function asDurableSource(
  persistence: InMemoryRepositoryIndexPersistence
): DurableRepositoryContextSource {
  return {
    query: (request) => persistence.query(request),
    hydrateRecords: (request) => persistence.hydrateRecords(request),
    hydrateVectors: (request) => persistence.hydrateVectors(request),
    queryRecordsByPath: (request) => persistence.queryRecordsByPath(request),
    queryCallEdges: (request) => persistence.queryCallEdges(request)
  };
}

function descriptorOf(index: RepositoryIndex) {
  return {
    storageKey: index.storageKey,
    repository: index.repository,
    repositoryScope: index.repositoryScope,
    commitSha: index.commitSha,
    visibility: index.visibility,
    embedding: { ...index.embedding }
  };
}

const commitSha = "a".repeat(40);

/**
 * Padding that pushes a symbol's body past the builder's 8000-character content
 * limit, so the identifier it calls is truncated OUT of its stored content while
 * the call edge itself survives.
 *
 * This is the only mechanism that separates retrieval's two test disjuncts. A test
 * that calls a changed symbol normally also NAMES it, so `relatedByName` reaches it
 * and a fixture built without truncation proves nothing about `relatedByCall`.
 * Every token here is deliberately absent from the changed symbol's name.
 */
function truncationPadding(tag: string): string {
  return Array.from(
    { length: 340 },
    (_, line) => `    const ${tag}${line} = "zzzz zzzz zzzz zzzz";`
  ).join("\n");
}

const changedSymbolName = "throttleQuota";

/**
 * One snapshot whose ONLY route to a caller, a callee, and a call-based test
 * candidate is `index.calls`.
 *
 * - `src/quota.ts` holds the changed symbol, so `changedNames` is exactly
 *   {"throttlequota"}.
 * - `src/dispatch.ts` calls it, but its stored content is truncated before the call
 *   site, so no changed name appears in it.
 * - `test/dispatch.test.ts` calls it and is truncated identically, so `relatedByName`
 *   cannot reach it and only `relatedByCall` can.
 * - `src/window.ts` is called BY the changed symbol and never names it, so it is
 *   reachable only as a resolved callee.
 */
async function callEdgeFixture(): Promise<RepositoryIndex> {
  return indexRepositorySyntaxAware({
    repository: "Acme/CallEdges",
    repositoryId: 1201,
    commitSha,
    files: {
      "src/quota.ts": [
        `export function ${changedSymbolName}(bucket) {`,
        "  return sealWindow(bucket);",
        "}"
      ].join("\n"),
      "src/window.ts": "export function sealWindow(bucket) { return bucket.count; }",
      "src/dispatch.ts": [
        "export function relayEnvelope(payload) {",
        truncationPadding("dpad"),
        `  return ${changedSymbolName}(payload);`,
        "}"
      ].join("\n"),
      "test/dispatch.test.ts": [
        "export function verifyRelay() {",
        truncationPadding("tpad"),
        `  return ${changedSymbolName}({ count: 1 });`,
        "}"
      ].join("\n")
    }
  });
}

function locations(
  contexts: readonly { kind: RetrievedContextKind; path: string; line: number }[]
): string[] {
  return contexts.map((context) => `${context.kind}:${context.path}:${context.line}`);
}

test("the call-edge fixture's caller, callee, and test candidates are reachable only through index.calls", async () => {
  const index = await callEdgeFixture();
  const changed = index.symbols.find((symbol) => symbol.path === "src/quota.ts");
  assert.ok(changed, "expected the changed symbol to be indexed");
  assert.equal(changed.name, changedSymbolName);

  // Non-vacuity, asserted on the fixture itself rather than assumed. If any of
  // these contents carried the changed name, the name disjuncts could reach the
  // candidate and the call-edge assertions below would prove nothing.
  const lowerChangedName = changedSymbolName.toLowerCase();
  for (const path of ["src/dispatch.ts", "test/dispatch.test.ts", "src/window.ts"]) {
    const symbol = index.symbols.find((candidate) => candidate.path === path);
    assert.ok(symbol, `expected ${path} to be indexed`);
    assert.ok(
      !symbol.content.toLowerCase().includes(lowerChangedName),
      `${path} must not name the changed symbol, or the call edge is not its only route`
    );
    assert.ok(
      !lowerChangedName.includes(symbol.name.toLowerCase()),
      `${path}'s own name must not be a substring route into the changed symbol`
    );
  }

  // The edges themselves resolve, which is what the candidates depend on.
  const intoChanged = index.calls.filter((call) =>
    call.resolvedSymbolIds.includes(changed.id)
  );
  assert.equal(intoChanged.length, 2, "expected src/dispatch.ts and the test to call the changed symbol");
  assert.ok(
    index.calls.some((call) => call.callerSymbolId === changed.id),
    "expected the changed symbol to call sealWindow"
  );
});

test("the materialised document yields caller, callee, and the call-based test relation", async () => {
  const index = await callEdgeFixture();
  const result = await retrieveRepositoryContext({
    index,
    repositoryScope: index.repositoryScope,
    commitSha,
    changes: [{ path: "src/quota.ts", additions: 1, deletions: 0 }],
    query: "throttle quota seal window"
  });
  const found = locations(result.contexts);

  assert.ok(found.includes("changed-symbol:src/quota.ts:1"));
  // Inbound edge: a non-test caller.
  assert.ok(found.includes("caller:src/dispatch.ts:1"), `missing caller, got ${found.join(", ")}`);
  // Outbound edge: resolved from the changed symbol's own call.
  assert.ok(found.includes("callee:src/window.ts:1"), `missing callee, got ${found.join(", ")}`);
  // relatedByCall only: this symbol's stored content does not name the changed symbol.
  assert.ok(
    found.includes("test:test/dispatch.test.ts:1"),
    `missing call-based test, got ${found.join(", ")}`
  );

  // Emptying the edges removes exactly these three kinds and nothing else, which
  // is what proves the assertions above are about edges and not about names.
  const withoutEdges = structuredClone(index);
  withoutEdges.calls = [];
  const edgeless = await retrieveRepositoryContext({
    index: withoutEdges,
    repositoryScope: index.repositoryScope,
    commitSha,
    changes: [{ path: "src/quota.ts", additions: 1, deletions: 0 }],
    query: "throttle quota seal window"
  });
  assert.deepEqual(locations(edgeless.contexts), ["changed-symbol:src/quota.ts:1"]);
});

test("descriptor-first durable retrieval reconstructs caller, callee, and call-based test", async () => {
  const index = await callEdgeFixture();
  const persistence = new InMemoryRepositoryIndexPersistence();
  await persistence.replace(index, toPersistedVectorRows(index));
  const provider = new LexicalHashEmbeddingProvider(index.embedding.dimensions);

  const durable = await retrieveDurableRepositoryContext({
    descriptor: descriptorOf(index),
    repositoryScope: index.repositoryScope,
    commitSha,
    changes: [{ path: "src/quota.ts", additions: 1, deletions: 0 }],
    query: "throttle quota seal window",
    embeddingProvider: provider,
    source: asDurableSource(persistence)
  });
  const found = locations(durable.contexts);

  assert.ok(found.includes("changed-symbol:src/quota.ts:1"), `got ${found.join(", ")}`);
  assert.ok(found.includes("caller:src/dispatch.ts:1"), `missing caller, got ${found.join(", ")}`);
  assert.ok(found.includes("callee:src/window.ts:1"), `missing callee, got ${found.join(", ")}`);
  assert.ok(
    found.includes("test:test/dispatch.test.ts:1"),
    `missing call-based test, got ${found.join(", ")}`
  );
});

test("path-scoped retrieval finds a changed symbol outside the ANN top-N", async () => {
  const index = await indexRepositorySyntaxAware({
    repository: "Acme/PathExact",
    repositoryId: 1202,
    commitSha,
    files: {
      "src/noise-a.ts": "export function noiseA() { return 1; }",
      "src/noise-b.ts": "export function noiseB() { return 2; }",
      "src/noise-c.ts": "export function noiseC() { return 3; }",
      "src/target.ts": "export function rareChangedSymbolUnique() { return 99; }"
    }
  });
  const persistence = new InMemoryRepositoryIndexPersistence();
  await persistence.replace(index, toPersistedVectorRows(index));
  const provider = new LexicalHashEmbeddingProvider(index.embedding.dimensions);

  // ANN limit 1 with a query that prefers noise — path query must still recover target.
  const durable = await retrieveDurableRepositoryContext({
    descriptor: descriptorOf(index),
    repositoryScope: index.repositoryScope,
    commitSha,
    changes: [{ path: "src/target.ts", additions: 1, deletions: 0 }],
    query: "noise noise noise",
    embeddingProvider: provider,
    source: asDurableSource(persistence),
    vectorRankerLimit: 1
  });
  assert.ok(
    durable.contexts.some(
      (context) => context.kind === "changed-symbol" && context.path === "src/target.ts"
    ),
    `expected path-exact changed-symbol, got ${locations(durable.contexts).join(", ")}`
  );
});

test("path and edge truncation yield partial coverage and warnings", async () => {
  const multi = await indexRepositorySyntaxAware({
    repository: "Acme/Truncate",
    repositoryId: 1203,
    commitSha,
    files: {
      "src/a.ts": [
        "export function one() { return 1; }",
        "export function two() { return 2; }",
        "export function three() { return 3; }"
      ].join("\n")
    }
  });
  const pathStore = new InMemoryRepositoryIndexPersistence();
  await pathStore.replace(multi, toPersistedVectorRows(multi));
  const pathTruncated = await retrieveDurableRepositoryContext({
    descriptor: descriptorOf(multi),
    repositoryScope: multi.repositoryScope,
    commitSha,
    changes: [{ path: "src/a.ts", additions: 3, deletions: 0 }],
    source: asDurableSource(pathStore),
    pathRecordLimit: 1
  });
  assert.equal(pathTruncated.partial, true);
  assert.ok(
    pathTruncated.warnings?.some(
      (warning) => warning.includes("path-record") && warning.includes("truncated")
    )
  );

  const index = await callEdgeFixture();
  const edgeStore = new InMemoryRepositoryIndexPersistence();
  await edgeStore.replace(index, toPersistedVectorRows(index));
  const edgeTruncated = await retrieveDurableRepositoryContext({
    descriptor: descriptorOf(index),
    repositoryScope: index.repositoryScope,
    commitSha,
    changes: [{ path: "src/quota.ts", additions: 1, deletions: 0 }],
    source: asDurableSource(edgeStore),
    callEdgeLimit: 1
  });
  assert.equal(edgeTruncated.partial, true);
  assert.ok(
    edgeTruncated.warnings?.some(
      (warning) => warning.includes("call-edge") && warning.includes("truncated")
    )
  );
});

test("foreign durable rows fail closed on descriptor-first retrieval", async () => {
  const index = await callEdgeFixture();
  const persistence = new InMemoryRepositoryIndexPersistence();
  await persistence.replace(index, toPersistedVectorRows(index));
  const source = asDurableSource(persistence);
  const foreign = {
    ...source,
    queryRecordsByPath: async (request: Parameters<typeof source.queryRecordsByPath>[0]) => {
      const result = await source.queryRecordsByPath(request);
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          repositoryScope: "github:9999",
          storageKey: "guardianbot/repository-index/v2/github%3A9999/" + commitSha
        }))
      };
    }
  };
  await assert.rejects(
    () =>
      retrieveDurableRepositoryContext({
        descriptor: descriptorOf(index),
        repositoryScope: index.repositoryScope,
        commitSha,
        changes: [{ path: "src/quota.ts", additions: 1, deletions: 0 }],
        source: foreign
      }),
    (error: unknown) =>
      error instanceof Error && error.name === "RepositoryIsolationError"
  );
});

test("the declared kind-durability table partitions every retrieved context kind", () => {
  const classes: readonly RetrievedContextKindDurability[] = [
    "durably-exact",
    "exhaustive-from-document-recall-bounded-durably",
    "document-only"
  ];

  // Runtime witness list agrees with the coverage table in both directions.
  assert.deepEqual(
    [...retrievedContextKinds].sort(),
    Object.keys(retrievedContextKindCoverage).sort(),
    "every retrieved context kind must be classified exactly once"
  );
  // Third independent witness. The union is erased at test time, so a table can
  // only be pinned against another table; this one is load-bearing for review
  // bundles, which is what makes agreement meaningful rather than circular.
  assert.deepEqual(
    [...retrievedContextKinds].sort(),
    Object.keys(reviewKindByRetrievedKind).sort(),
    "a new kind must be mapped for review bundles as well as classified"
  );

  const byClass = new Map<RetrievedContextKindDurability, string[]>(
    classes.map((durability) => [durability, []])
  );
  for (const kind of retrievedContextKinds) {
    const coverage = retrievedContextKindCoverage[kind];
    const bucket = byClass.get(coverage.durability);
    assert.ok(bucket, `${kind} declares an unknown durability class`);
    bucket.push(kind);
    assert.ok(coverage.why.trim().length > 0, `${kind} must justify its durability class`);
  }

  // Disjoint: each kind landed in exactly one bucket, so the bucket sizes sum to
  // the union's size.
  const assigned = [...byClass.values()].flat();
  assert.equal(assigned.length, retrievedContextKinds.length);
  assert.equal(new Set(assigned).size, retrievedContextKinds.length);
  // Union: nothing is left unclassified.
  assert.deepEqual([...assigned].sort(), [...retrievedContextKinds].sort());

  // Path queries + durable edges close these three kinds.
  assert.deepEqual(byClass.get("document-only") ?? [], []);
  assert.deepEqual(byClass.get("durably-exact")?.sort(), [
    "callee",
    "caller",
    "changed-symbol"
  ]);
});

test("only kinds with a document-only relation may claim durable reproduction gaps", () => {
  for (const kind of retrievedContextKinds) {
    const coverage = retrievedContextKindCoverage[kind];
    if (coverage.durability === "document-only") {
      assert.ok(
        coverage.documentOnlyRelations.length > 0,
        `${kind} is document-only and must name the relation that makes it so`
      );
      continue;
    }
    if (coverage.durability === "durably-exact") {
      assert.deepEqual(
        coverage.documentOnlyRelations,
        [],
        `${kind} claims durable exactness, so it cannot also lose a relation`
      );
    }
  }
});
