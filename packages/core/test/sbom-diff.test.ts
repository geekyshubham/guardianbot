import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedEditDistance,
  compareComponentVersions,
  diffCycloneDxSboms,
  MAX_SBOM_DIFF_COMPONENTS,
  MAX_SBOM_DIFF_ENTRIES,
  parsePackageUrl,
  SbomDiffError
} from "../src/index.js";

function sbom(components: unknown[]): Record<string, unknown> {
  return { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components };
}

function library(purl: string, name: string, version?: string): Record<string, unknown> {
  return { type: "library", name, ...(version ? { version } : {}), purl };
}

test("SBOM diff reports added, removed, and version-changed components by purl", () => {
  const previous = sbom([
    library("pkg:npm/express@4.19.2", "express", "4.19.2"),
    library("pkg:npm/left-pad@1.3.0", "left-pad", "1.3.0"),
    library("pkg:npm/%40scope/util@1.0.0", "util", "1.0.0")
  ]);
  const current = sbom([
    library("pkg:npm/express@4.21.0", "express", "4.21.0"),
    library("pkg:npm/%40scope/util@1.0.0", "util", "1.0.0"),
    library("pkg:npm/zod@3.23.8", "zod", "3.23.8")
  ]);
  const diff = diffCycloneDxSboms(previous, current);
  assert.equal(diff.schemaVersion, "1.0.0");
  assert.equal(diff.previousComponentCount, 3);
  assert.equal(diff.currentComponentCount, 3);
  assert.deepEqual(diff.added.map((entry) => entry.key), ["npm/zod"]);
  assert.deepEqual(diff.removed.map((entry) => entry.key), ["npm/left-pad"]);
  assert.deepEqual(diff.changed, [
    {
      key: "npm/express",
      name: "express",
      ecosystem: "npm",
      previousVersions: ["4.19.2"],
      currentVersions: ["4.21.0"]
    }
  ]);
  assert.deepEqual(diff.signals, []);
  assert.equal(diff.truncated, false);
});

test("SBOM diff keys components without a purl by name and component type", () => {
  const diff = diffCycloneDxSboms(
    sbom([{ type: "operating-system", name: "debian", version: "12.5" }]),
    sbom([
      { type: "operating-system", name: "Debian", version: "12.6" },
      { type: "application", name: "debian", version: "1" }
    ])
  );
  assert.deepEqual(diff.changed.map((entry) => entry.key), ["component:operating-system/debian"]);
  assert.deepEqual(diff.added.map((entry) => entry.key), ["component:application/debian"]);
});

test("SBOM diff is deterministic regardless of component order and walks nested components", () => {
  const nested = (order: number[]) =>
    sbom(
      order.map((index) => ({
        ...library(`pkg:pypi/pkg${index}@1.0.${index}`, `pkg${index}`, `1.0.${index}`),
        components: [library(`pkg:pypi/child${index}@2.0.0`, `child${index}`, "2.0.0")]
      }))
    );
  const empty = sbom([]);
  const first = diffCycloneDxSboms(empty, nested([1, 2, 3]));
  const second = diffCycloneDxSboms(empty, nested([3, 1, 2]));
  assert.deepEqual(first, second);
  assert.equal(first.currentComponentCount, 6);
  assert.equal(first.addedCount, 6);
});

test("SBOM diff raises advisory typosquat signals for names close to known packages", () => {
  const diff = diffCycloneDxSboms(
    sbom([library("pkg:npm/internal-client@1.0.0", "internal-client", "1.0.0")]),
    sbom([
      library("pkg:npm/internal-client@1.0.0", "internal-client", "1.0.0"),
      library("pkg:npm/expresss@1.0.0", "expresss", "1.0.0"),
      library("pkg:npm/internal-cliemt@1.0.0", "internal-cliemt", "1.0.0"),
      library("pkg:pypi/reqeusts@2.0.0", "reqeusts", "2.0.0"),
      library("pkg:npm/zod@3.0.0", "zod", "3.0.0")
    ])
  );
  const typosquats = diff.signals.filter((signal) => signal.kind === "typosquat");
  assert.deepEqual(
    typosquats.map((signal) => signal.key),
    ["npm/expresss", "npm/internal-cliemt", "pypi/reqeusts"]
  );
  assert.ok(typosquats.every((signal) => signal.advisory === true));
});

test("SBOM diff does not flag well-known packages themselves as typosquats", () => {
  const diff = diffCycloneDxSboms(
    sbom([]),
    sbom([
      library("pkg:npm/express@4.0.0", "express", "4.0.0"),
      library("pkg:npm/react@18.0.0", "react", "18.0.0"),
      library("pkg:npm/react-dom@18.0.0", "react-dom", "18.0.0")
    ])
  );
  assert.deepEqual(diff.signals, []);
});

test("SBOM diff raises dependency-confusion signals for ecosystem, namespace, or registry changes", () => {
  const diff = diffCycloneDxSboms(
    sbom([
      library("pkg:npm/%40acme/billing@1.0.0", "billing", "1.0.0"),
      library(
        "pkg:maven/com.acme/ledger@1.0.0?repository_url=https://repo.acme.internal/maven",
        "ledger",
        "1.0.0"
      )
    ]),
    sbom([
      library("pkg:npm/billing@1.0.0", "billing", "1.0.0"),
      library(
        "pkg:maven/com.acme/ledger@1.0.0?repository_url=https://repo1.maven.org/maven2",
        "ledger",
        "1.0.0"
      )
    ])
  );
  const confusion = diff.signals.filter((signal) => signal.kind === "dependency-confusion");
  assert.deepEqual(
    confusion.map((signal) => signal.key),
    ["maven/com.acme/ledger", "npm/billing"]
  );
  assert.match(confusion[1]!.detail, /npm\/@acme/);
});

test("SBOM diff raises version-downgrade signals only for comparable single versions", () => {
  const diff = diffCycloneDxSboms(
    sbom([
      library("pkg:npm/lodash@4.17.21", "lodash", "4.17.21"),
      library("pkg:npm/semver@7.6.0", "semver", "7.6.0"),
      library("pkg:golang/example.com/mod@v1.10.0", "mod", "v1.10.0"),
      library("pkg:npm/opaque@abc", "opaque", "abc")
    ]),
    sbom([
      library("pkg:npm/lodash@4.17.4", "lodash", "4.17.4"),
      library("pkg:npm/semver@7.6.3", "semver", "7.6.3"),
      library("pkg:golang/example.com/mod@v1.9.0", "mod", "v1.9.0"),
      library("pkg:npm/opaque@abd", "opaque", "abd")
    ])
  );
  assert.deepEqual(
    diff.signals.map((signal) => `${signal.kind}:${signal.key}`),
    ["version-downgrade:golang/example.com/mod", "version-downgrade:npm/lodash"]
  );
});

test("component version comparison handles numeric and pre-release ordering", () => {
  assert.equal(compareComponentVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareComponentVersions("1.0.0-rc1", "1.0.0"), -1);
  assert.equal(compareComponentVersions("1.0.0", "1.0.0.1"), -1);
  assert.equal(compareComponentVersions("v2.0.0", "2.0.0"), 0);
  assert.equal(compareComponentVersions("main", "1.0.0"), undefined);
});

test("bounded edit distance stops at the bound", () => {
  assert.equal(boundedEditDistance("express", "expresss", 1), 1);
  assert.equal(boundedEditDistance("express", "react", 1), 2);
  assert.equal(boundedEditDistance("a", "abcdef", 2), 3);
  assert.equal(boundedEditDistance("requests", "reqeusts", 1), 1);
});

test("package URL parser decodes namespaces and repository qualifiers", () => {
  assert.deepEqual(
    parsePackageUrl("pkg:npm/%40scope/name@1.0.0?repository_url=HTTPS://R.example#sub"),
    {
      type: "npm",
      namespace: "@scope",
      name: "name",
      version: "1.0.0",
      repositoryUrl: "https://r.example"
    }
  );
  assert.equal(parsePackageUrl("npm/name@1"), undefined);
  assert.equal(parsePackageUrl("pkg:npm"), undefined);
});

test("SBOM diff fails closed on malformed or oversized documents", () => {
  assert.throws(() => diffCycloneDxSboms({ bomFormat: "SPDX" }, sbom([])), SbomDiffError);
  assert.throws(() => diffCycloneDxSboms(sbom([{ type: "library" }]), sbom([])), SbomDiffError);
  assert.throws(
    () => diffCycloneDxSboms(sbom([{ type: "library", name: "x", version: 1 }]), sbom([])),
    SbomDiffError
  );
  assert.throws(
    () => diffCycloneDxSboms(sbom([library("pkg:npm/%E0%A4%A@1", "x")]), sbom([])),
    SbomDiffError
  );
  const oversized = Array.from({ length: MAX_SBOM_DIFF_COMPONENTS + 1 }, (_, index) => ({
    type: "library",
    name: `c${index}`
  }));
  assert.throws(() => diffCycloneDxSboms(sbom([]), sbom(oversized)), /exceeds/);
  let deep: Record<string, unknown> = { type: "library", name: "leaf" };
  for (let index = 0; index < 10; index += 1) {
    deep = { type: "library", name: `n${index}`, components: [deep] };
  }
  assert.throws(() => diffCycloneDxSboms(sbom([deep]), sbom([])), /deeper/);
});

test("SBOM diff caps reported entries and flags truncation", () => {
  const many = Array.from({ length: MAX_SBOM_DIFF_ENTRIES + 5 }, (_, index) =>
    library(`pkg:generic/zz-component-${index}@1`, `zz-component-${index}`, "1")
  );
  const diff = diffCycloneDxSboms(sbom([]), sbom(many));
  assert.equal(diff.addedCount, MAX_SBOM_DIFF_ENTRIES + 5);
  assert.equal(diff.added.length, MAX_SBOM_DIFF_ENTRIES);
  assert.equal(diff.truncated, true);
});
