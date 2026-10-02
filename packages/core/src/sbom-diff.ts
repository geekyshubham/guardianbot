/**
 * Pure CycloneDX SBOM diff used by the deployed-digest rescan.
 *
 * The diff is deterministic and bounded: oversized or malformed documents fail closed with an
 * SbomDiffError instead of being silently truncated, and only the reported lists are capped.
 * Suspicious-dependency signals are advisory evidence for reviewers; nothing in this module
 * blocks, waives, or approves a release.
 */

export const SBOM_DIFF_SCHEMA_VERSION = "1.0.0";
export const MAX_SBOM_DIFF_COMPONENTS = 50_000;
export const MAX_SBOM_DIFF_ENTRIES = 500;
export const MAX_SBOM_DIFF_SIGNALS = 200;
const MAX_COMPONENT_DEPTH = 8;
const MAX_NAME_LENGTH = 512;
const MAX_VERSION_LENGTH = 256;
const MAX_PURL_LENGTH = 2048;
const MAX_TYPOSQUAT_CANDIDATES = 500;
const MIN_TYPOSQUAT_NAME_LENGTH = 4;
// Typosquat comparison is quadratic per pair, so names beyond this length are not compared and
// the whole heuristic stops (marking the diff truncated) once it has spent its work budget.
const MAX_TYPOSQUAT_NAME_LENGTH = 64;
const MAX_TYPOSQUAT_WORK_CELLS = 5_000_000;

export class SbomDiffError extends Error {}

export interface SbomDiffComponent {
  key: string;
  name: string;
  ecosystem: string;
  namespace?: string;
  versions: string[];
  repositoryUrl?: string;
}

export interface SbomDiffVersionChange {
  key: string;
  name: string;
  ecosystem: string;
  namespace?: string;
  previousVersions: string[];
  currentVersions: string[];
}

export type SuspiciousDependencyKind =
  | "typosquat"
  | "dependency-confusion"
  | "version-downgrade";

export interface SuspiciousDependencySignal {
  kind: SuspiciousDependencyKind;
  key: string;
  name: string;
  ecosystem: string;
  detail: string;
  /** Always true: signals are review evidence and never gate a release. */
  advisory: true;
}

export interface SbomDiff {
  schemaVersion: typeof SBOM_DIFF_SCHEMA_VERSION;
  previousComponentCount: number;
  currentComponentCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  added: SbomDiffComponent[];
  removed: SbomDiffComponent[];
  changed: SbomDiffVersionChange[];
  signals: SuspiciousDependencySignal[];
  truncated: boolean;
}

interface IndexedComponent {
  key: string;
  name: string;
  ecosystem: string;
  namespace?: string;
  versions: Set<string>;
  repositoryUrls: Set<string>;
}

/**
 * A short, deliberately conservative reference list of heavily used package names per ecosystem.
 * A new dependency one edit away from one of these is a classic typosquat shape.
 */
const WELL_KNOWN_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  npm: [
    "axios",
    "chalk",
    "commander",
    "debug",
    "express",
    "lodash",
    "moment",
    "react",
    "react-dom",
    "request",
    "typescript",
    "webpack",
    "eslint",
    "jquery",
    "dotenv",
    "uuid",
    "yargs"
  ],
  pypi: [
    "requests",
    "numpy",
    "pandas",
    "django",
    "flask",
    "urllib3",
    "setuptools",
    "boto3",
    "cryptography",
    "pyyaml",
    "colorama",
    "python-dateutil"
  ],
  gem: ["rails", "rack", "nokogiri", "rest-client", "bundler"],
  cargo: ["serde", "tokio", "rand", "regex", "reqwest"],
  golang: ["github.com/sirupsen/logrus", "github.com/gorilla/mux"]
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SbomDiffError("CycloneDX component purl is not valid percent-encoding");
  }
}

interface ParsedPurl {
  type: string;
  namespace?: string;
  name: string;
  version?: string;
  repositoryUrl?: string;
}

/** Minimal package-url parser: pkg:type/namespace/name@version?qualifiers#subpath. */
export function parsePackageUrl(purl: string): ParsedPurl | undefined {
  if (purl.length > MAX_PURL_LENGTH || !purl.startsWith("pkg:")) return undefined;
  let rest = purl.slice(4);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  let qualifiers = "";
  const question = rest.indexOf("?");
  if (question >= 0) {
    qualifiers = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  let version: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    version = safeDecode(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }
  const segments = rest.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const type = segments[0]!.toLowerCase();
  if (!/^[a-z][a-z0-9.+-]*$/.test(type)) return undefined;
  const name = safeDecode(segments[segments.length - 1]!);
  const namespaceSegments = segments.slice(1, -1).map(safeDecode);
  let repositoryUrl: string | undefined;
  for (const pair of qualifiers.split("&")) {
    const equals = pair.indexOf("=");
    if (equals > 0 && pair.slice(0, equals).toLowerCase() === "repository_url") {
      repositoryUrl = safeDecode(pair.slice(equals + 1)).toLowerCase();
    }
  }
  return {
    type,
    namespace: namespaceSegments.length ? namespaceSegments.join("/") : undefined,
    name,
    version: version || undefined,
    repositoryUrl
  };
}

function normalizeName(ecosystem: string, name: string): string {
  const lower = name.toLowerCase();
  // PEP 503 normalization: runs of -, _ and . are equivalent in PyPI names.
  return ecosystem === "pypi" ? lower.replace(/[-_.]+/g, "-") : lower;
}

function boundedString(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SbomDiffError(`CycloneDX component ${label} must be a string`);
  }
  if (value.length > max) {
    throw new SbomDiffError(`CycloneDX component ${label} exceeds ${max} characters`);
  }
  return value;
}

interface IndexedSbom {
  components: Map<string, IndexedComponent>;
  componentCount: number;
}

function indexSbom(document: unknown, label: string): IndexedSbom {
  const root = asRecord(document);
  if (
    !root ||
    root.bomFormat !== "CycloneDX" ||
    typeof root.specVersion !== "string" ||
    !/^1\.[4-9]$/.test(root.specVersion) ||
    (root.components !== undefined && !Array.isArray(root.components))
  ) {
    throw new SbomDiffError(`${label} SBOM is not a supported CycloneDX document`);
  }
  const index = new Map<string, IndexedComponent>();
  let count = 0;
  const visit = (components: unknown, depth: number): void => {
    if (components === undefined) return;
    if (!Array.isArray(components)) {
      throw new SbomDiffError(`${label} SBOM nested components must be an array`);
    }
    if (depth > MAX_COMPONENT_DEPTH) {
      throw new SbomDiffError(`${label} SBOM nests components deeper than ${MAX_COMPONENT_DEPTH}`);
    }
    for (const value of components) {
      count += 1;
      if (count > MAX_SBOM_DIFF_COMPONENTS) {
        throw new SbomDiffError(
          `${label} SBOM exceeds ${MAX_SBOM_DIFF_COMPONENTS} components`
        );
      }
      const component = asRecord(value);
      if (!component || typeof component.type !== "string" || !component.type) {
        throw new SbomDiffError(`${label} SBOM contains an invalid component`);
      }
      const rawName = boundedString(component.name, MAX_NAME_LENGTH, "name");
      if (!rawName) throw new SbomDiffError(`${label} SBOM contains a component without a name`);
      const rawVersion = boundedString(component.version, MAX_VERSION_LENGTH, "version");
      const rawGroup = boundedString(component.group, MAX_NAME_LENGTH, "group");
      const rawPurl = boundedString(component.purl, MAX_PURL_LENGTH, "purl");
      const purl = rawPurl ? parsePackageUrl(rawPurl) : undefined;
      const ecosystem = purl ? purl.type : `component:${component.type.toLowerCase()}`;
      const namespaceValue = purl ? purl.namespace : rawGroup || undefined;
      const namespace = namespaceValue ? namespaceValue.toLowerCase() : undefined;
      const name = normalizeName(ecosystem, purl ? purl.name : rawName);
      const key = `${ecosystem}/${namespace ? `${namespace}/` : ""}${name}`;
      const version = rawVersion || purl?.version;
      const existing =
        index.get(key) ??
        {
          key,
          name,
          ecosystem,
          namespace,
          versions: new Set<string>(),
          repositoryUrls: new Set<string>()
        };
      if (version) existing.versions.add(version);
      if (purl?.repositoryUrl) existing.repositoryUrls.add(purl.repositoryUrl);
      index.set(key, existing);
      visit(component.components, depth + 1);
    }
  };
  visit(root.components, 1);
  return { components: index, componentCount: count };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function toComponent(component: IndexedComponent): SbomDiffComponent {
  return {
    key: component.key,
    name: component.name,
    ecosystem: component.ecosystem,
    ...(component.namespace ? { namespace: component.namespace } : {}),
    versions: sorted(component.versions),
    ...(component.repositoryUrls.size
      ? { repositoryUrl: sorted(component.repositoryUrls).join(",") }
      : {})
  };
}

/**
 * Bounded optimal-string-alignment distance (Levenshtein plus adjacent transposition, the most
 * common typosquat edit). Returns max + 1 as soon as the bound is exceeded.
 */
export function boundedEditDistance(left: string, right: string, max: number): number {
  return boundedEditDistanceWithWork(left, right, max).distance;
}

function boundedEditDistanceWithWork(
  left: string,
  right: string,
  max: number
): { distance: number; cells: number } {
  if (Math.abs(left.length - right.length) > max) return { distance: max + 1, cells: 0 };
  let cells = 0;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, beforePrevious[j - 2]! + 1);
      }
      current.push(value);
      if (value < rowMinimum) rowMinimum = value;
    }
    cells += right.length;
    if (rowMinimum > max) return { distance: max + 1, cells };
    beforePrevious = previous;
    previous = current;
  }
  return { distance: Math.min(previous[right.length]!, max + 1), cells };
}

interface VersionToken {
  numeric: boolean;
  value: string;
}

function versionTokens(version: string): VersionToken[] | undefined {
  // Strip a leading "v" and an optional Debian-style epoch; anything else must start numerically.
  const trimmed = version.trim().replace(/^v(?=\d)/i, "");
  if (!/^\d/.test(trimmed)) return undefined;
  const tokens = trimmed.match(/\d+|[A-Za-z]+/g);
  return tokens?.map((value) => ({ numeric: /^\d+$/.test(value), value }));
}

/**
 * Deterministic, ecosystem-agnostic version ordering for downgrade heuristics. Returns undefined
 * when either value does not look like a numeric version, so ambiguous strings never raise a
 * signal.
 */
export function compareComponentVersions(left: string, right: string): number | undefined {
  const a = versionTokens(left);
  const b = versionTokens(right);
  if (!a || !b) return undefined;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (!x || !y) {
      // A trailing alphabetic token (1.0.0-rc1) sorts before the bare release (1.0.0).
      const extra = (x ?? y)!;
      const sign = x ? 1 : -1;
      return extra.numeric ? sign : -sign;
    }
    if (x.numeric && y.numeric) {
      const difference = BigInt(x.value) - BigInt(y.value);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
    } else if (x.numeric !== y.numeric) {
      return x.numeric ? 1 : -1;
    } else if (x.value !== y.value) {
      return x.value < y.value ? -1 : 1;
    }
  }
  return 0;
}

function typosquatThreshold(name: string): number {
  return name.length >= 10 ? 2 : 1;
}

/**
 * Computes the component-level difference between the previously attested SBOM and a fresh SBOM
 * of the same deployed digest, plus advisory suspicious-dependency signals.
 */
export function diffCycloneDxSboms(previousDocument: unknown, currentDocument: unknown): SbomDiff {
  const previousSbom = indexSbom(previousDocument, "previous");
  const currentSbom = indexSbom(currentDocument, "current");
  const previous = previousSbom.components;
  const current = currentSbom.components;
  const added: IndexedComponent[] = [];
  const removed: IndexedComponent[] = [];
  const changed: SbomDiffVersionChange[] = [];
  const signals: SuspiciousDependencySignal[] = [];
  for (const key of sorted(current.keys())) {
    const now = current.get(key)!;
    const before = previous.get(key);
    if (!before) {
      added.push(now);
      continue;
    }
    const previousVersions = sorted(before.versions);
    const currentVersions = sorted(now.versions);
    if (previousVersions.join("\n") !== currentVersions.join("\n")) {
      changed.push({
        key,
        name: now.name,
        ecosystem: now.ecosystem,
        ...(now.namespace ? { namespace: now.namespace } : {}),
        previousVersions,
        currentVersions
      });
      if (previousVersions.length === 1 && currentVersions.length === 1) {
        const comparison = compareComponentVersions(currentVersions[0]!, previousVersions[0]!);
        if (comparison !== undefined && comparison < 0) {
          signals.push({
            kind: "version-downgrade",
            key,
            name: now.name,
            ecosystem: now.ecosystem,
            detail: `version decreased from ${previousVersions[0]} to ${currentVersions[0]}`,
            advisory: true
          });
        }
      }
    }
    const beforeRegistries = sorted(before.repositoryUrls).join(",");
    const nowRegistries = sorted(now.repositoryUrls).join(",");
    if (beforeRegistries !== nowRegistries) {
      signals.push({
        kind: "dependency-confusion",
        key,
        name: now.name,
        ecosystem: now.ecosystem,
        detail: `registry changed from ${beforeRegistries || "default"} to ${nowRegistries || "default"}`,
        advisory: true
      });
    }
  }
  for (const key of sorted(previous.keys())) {
    if (!current.has(key)) removed.push(previous.get(key)!);
  }

  // Dependency confusion: the same bare name now resolves from another ecosystem or namespace.
  const previousByBareName = new Map<string, IndexedComponent[]>();
  for (const component of previous.values()) {
    const list = previousByBareName.get(component.name) ?? [];
    list.push(component);
    previousByBareName.set(component.name, list);
  }
  for (const component of added) {
    const sameName = previousByBareName.get(component.name);
    if (!sameName) continue;
    const origins = sorted(
      sameName.map((entry) => `${entry.ecosystem}${entry.namespace ? `/${entry.namespace}` : ""}`)
    );
    signals.push({
      kind: "dependency-confusion",
      key: component.key,
      name: component.name,
      ecosystem: component.ecosystem,
      detail: `name previously resolved from ${origins.join(", ")}`,
      advisory: true
    });
  }

  // Typosquat: a genuinely new name that is a small edit away from a known name.
  const knownByEcosystem = new Map<string, Set<string>>();
  for (const component of previous.values()) {
    const set = knownByEcosystem.get(component.ecosystem) ?? new Set<string>();
    set.add(component.name);
    knownByEcosystem.set(component.ecosystem, set);
  }
  for (const [ecosystem, names] of Object.entries(WELL_KNOWN_PACKAGES)) {
    const set = knownByEcosystem.get(ecosystem) ?? new Set<string>();
    for (const name of names) set.add(normalizeName(ecosystem, name));
    knownByEcosystem.set(ecosystem, set);
  }
  // Comparable known names per ecosystem, bucketed by length and sorted once, so each candidate
  // only visits names whose length is within its edit threshold.
  const comparableByEcosystem = new Map<string, Map<number, string[]>>();
  for (const [ecosystem, names] of knownByEcosystem) {
    const byLength = new Map<number, string[]>();
    for (const name of sorted(names)) {
      if (name.length < MIN_TYPOSQUAT_NAME_LENGTH || name.length > MAX_TYPOSQUAT_NAME_LENGTH) {
        continue;
      }
      const bucket = byLength.get(name.length) ?? [];
      bucket.push(name);
      byLength.set(name.length, bucket);
    }
    comparableByEcosystem.set(ecosystem, byLength);
  }
  let candidates = 0;
  let typosquatWork = 0;
  let typosquatBudgetExceeded = false;
  candidateLoop: for (const component of added) {
    if (component.name.length < MIN_TYPOSQUAT_NAME_LENGTH) continue;
    if (component.name.length > MAX_TYPOSQUAT_NAME_LENGTH) continue;
    if (previousByBareName.has(component.name)) continue;
    const known = knownByEcosystem.get(component.ecosystem);
    if (!known || known.has(component.name)) continue;
    candidates += 1;
    if (candidates > MAX_TYPOSQUAT_CANDIDATES) break;
    const threshold = typosquatThreshold(component.name);
    const byLength = comparableByEcosystem.get(component.ecosystem)!;
    let match: string | undefined;
    for (
      let length = component.name.length - threshold;
      length <= component.name.length + threshold && !match;
      length += 1
    ) {
      for (const name of byLength.get(length) ?? []) {
        if (typosquatWork >= MAX_TYPOSQUAT_WORK_CELLS) {
          typosquatBudgetExceeded = true;
          break candidateLoop;
        }
        const { distance, cells } = boundedEditDistanceWithWork(
          component.name,
          name,
          threshold
        );
        typosquatWork += cells;
        if (distance > 0 && distance <= threshold) {
          match = name;
          break;
        }
      }
    }
    if (match) {
      signals.push({
        kind: "typosquat",
        key: component.key,
        name: component.name,
        ecosystem: component.ecosystem,
        detail: `new name is within edit distance ${threshold} of ${match}`,
        advisory: true
      });
    }
  }

  signals.sort((left, right) =>
    left.kind === right.kind
      ? left.key < right.key
        ? -1
        : left.key > right.key
          ? 1
          : 0
      : left.kind < right.kind
        ? -1
        : 1
  );
  const truncated =
    added.length > MAX_SBOM_DIFF_ENTRIES ||
    removed.length > MAX_SBOM_DIFF_ENTRIES ||
    changed.length > MAX_SBOM_DIFF_ENTRIES ||
    signals.length > MAX_SBOM_DIFF_SIGNALS ||
    candidates > MAX_TYPOSQUAT_CANDIDATES ||
    typosquatBudgetExceeded;
  return {
    schemaVersion: SBOM_DIFF_SCHEMA_VERSION,
    previousComponentCount: previousSbom.componentCount,
    currentComponentCount: currentSbom.componentCount,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added: added.slice(0, MAX_SBOM_DIFF_ENTRIES).map(toComponent),
    removed: removed.slice(0, MAX_SBOM_DIFF_ENTRIES).map(toComponent),
    changed: changed.slice(0, MAX_SBOM_DIFF_ENTRIES),
    signals: signals.slice(0, MAX_SBOM_DIFF_SIGNALS),
    truncated
  };
}
