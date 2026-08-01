import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryRepositoryIndexPersistence,
  LexicalHashEmbeddingProvider,
  indexRepositorySyntaxAware,
  retrieveRepositoryContext,
  retrievedContextKindCoverage,
  retrievedContextKinds,
  reviewKindByRetrievedKind,
  toPersistedVectorRows,
  type RepositoryIndex,
  type RetrievedContextKind,
  type RetrievedContextKindDurability
} from "../src/indexer.js";

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

/**
 * A document carrying identity but no records at all, so every recalled row must be
 * classified by `classifyDurableRecord`.
 *
 * This models an EMPTY materialised key set, which is what a document-free retrieval
 * would produce. It is a test-only construction: production code must not express a
 * missing document as empty arrays, because empty is indistinguishable from a
 * genuinely empty repository to every future reader.
 */
function withoutMaterialisedRecords(index: RepositoryIndex): RepositoryIndex {
  const stripped = structuredClone(index);
  stripped.files = [];
  stripped.symbols = [];
  stripped.imports = [];
  stripped.calls = [];
  stripped.history = [];
  return stripped;
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

/**
 * ENCODES AN INTENTIONAL CURRENT LIMITATION. Do NOT delete this test.
 *
 * There is no durable representation of a call edge: no call-edge table exists, and
 * neither `PersistedVectorRow` nor `PersistedRecordRow` carries a call target or a
 * resolved callee. So when the materialised document does not hold a record,
 * `classifyDurableRecord` is a strict SUBSET of `primaryCandidates` and three kinds
 * silently vanish. Nothing raises; the review is just thinner.
 *
 * When durable call edges land, this test must be UPDATED to assert the kinds are
 * now present. Deleting it re-arms exactly the silent degradation it exists to
 * detect, because no other test would notice the loss.
 */
test("durable classification silently drops caller, the call-derived callee, and the call-based test relation", async () => {
  const index = await callEdgeFixture();
  const persistence = new InMemoryRepositoryIndexPersistence();
  await persistence.replace(index, toPersistedVectorRows(index));
  const provider = new LexicalHashEmbeddingProvider(index.embedding.dimensions);

  // Same repository, same commit, same records durably present, same query. The
  // only difference is that no record is materialised, so nothing is subtracted
  // from hydration and every row is classified durably.
  const durable = await retrieveRepositoryContext({
    index: withoutMaterialisedRecords(index),
    repositoryScope: index.repositoryScope,
    commitSha,
    changes: [{ path: "src/quota.ts", additions: 1, deletions: 0 }],
    query: "throttle quota seal window",
    embeddingProvider: provider,
    vectorRanker: persistence,
    vectorRankerLimit: 500
  });
  const found = locations(durable.contexts);

  // Recall genuinely reached the repository: the diff-bounded kind survives, so a
  // failure below is kind-loss and not an empty result.
  assert.ok(
    found.includes("changed-symbol:src/quota.ts:1"),
    `durable recall returned nothing to classify, got ${found.join(", ")}`
  );

  // The three losses. Asserted on path and line, NOT on the kind label alone.
  assert.ok(
    !durable.contexts.some((context) => context.kind === "caller"),
    `expected no caller candidate durably, got ${found.join(", ")}`
  );
  assert.ok(
    !found.includes("callee:src/window.ts:1"),
    `expected the call-resolved callee to be absent durably, got ${found.join(", ")}`
  );
  assert.ok(
    !found.includes("test:test/dispatch.test.ts:1"),
    `expected the call-based test relation to be absent durably, got ${found.join(", ")}`
  );

  // WHY the callee assertion is keyed on path and line: classifyDurableRecord DOES
  // emit the literal string "callee", for a RELATED-source lexical match on name
  // and content, with resolvedSymbolIds never consulted. A bare
  // kinds.has("callee") assertion would therefore pass while every call edge was
  // missing. That label is not call-edge coverage and must not be counted as such.
  const callEdgeCallees = new Set(
    index.calls
      .filter((call) => call.callerSymbolId)
      .flatMap((call) => call.resolvedSymbolIds)
  );
  assert.ok(callEdgeCallees.size > 0, "fixture must have at least one resolved callee");
  const durableCalleePaths = new Set(
    durable.contexts.filter((context) => context.kind === "callee").map((context) => context.path)
  );
  for (const symbol of index.symbols) {
    if (!callEdgeCallees.has(symbol.id)) continue;
    assert.ok(
      !durableCalleePaths.has(symbol.path) || symbol.path === "src/quota.ts",
      `${symbol.path} is a call-edge callee and must not be reproduced durably as one`
    );
  }

  assert.equal(retrievedContextKindCoverage.caller.durability, "document-only");
  assert.equal(retrievedContextKindCoverage.callee.durability, "document-only");
  assert.deepEqual(retrievedContextKindCoverage.test.documentOnlyRelations, [
    "call-based test relation (relatedByCall)"
  ]);
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

  // The classification that matters is asserted explicitly, so widening it is a
  // deliberate edit to this test and not an incidental table change.
  assert.deepEqual(byClass.get("document-only")?.sort(), ["callee", "caller"]);
  // Deliberately EMPTY. `changed-symbol` is the one kind whose durable route could be
  // exact — repository_index_records carries every field the changed-line intersection
  // needs — but retrieval has no path-scoped record query, so its durable route runs
  // through recall-bounded sourcing like every other kind. The class is retained rather
  // than deleted because it names the property a future path-scoped query would earn;
  // populating it must be a deliberate edit to this line, backed by that query existing.
  assert.deepEqual(byClass.get("durably-exact"), []);
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
