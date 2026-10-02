import assert from "node:assert/strict";
import test from "node:test";
import {
  REMEDIATION_BRANCH_PREFIX,
  isForbiddenRemediationPath,
  remediationBranchName,
  remediationDraftBody,
  sha256Hex,
  validateRemediationDraft,
  type RemediationValidationInput
} from "../src/remediation-draft.js";
import { grantedPermissionsFrom } from "../src/app-auth.js";
import type { ReviewFindingRecord } from "../src/store.js";

const HEAD = "b".repeat(40);
const SUGGESTION = "  return safeValue;";
const FILE = ["line 1", "line 2", "  return unsafeValue;", "line 4", ""].join("\n");

function input(overrides: Partial<RemediationValidationInput> = {}, findingOverrides: Partial<ReviewFindingRecord> = {}): RemediationValidationInput {
  return {
    finding: {
      fingerprint: "f".repeat(64),
      state: "open",
      path: "src/a.ts",
      startLine: 3,
      endLine: 3,
      lastSeenHeadSha: HEAD,
      suggestionSha256: sha256Hex(SUGGESTION.trim()),
      ...findingOverrides
    },
    currentHeadSha: HEAD,
    reviewedHeadSha: HEAD,
    publishedSuggestion: SUGGESTION.trim(),
    changedRanges: [{ start: 2, end: 4 }],
    fileContent: FILE,
    fileBytes: Buffer.byteLength(FILE),
    ...overrides
  };
}

test("a valid draft changes only the finding's exact line range", () => {
  // The digest is of the trimmed suggestion, exactly as GuardianBot rendered it.
  const result = validateRemediationDraft(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, ["line 1", "line 2", "return safeValue;", "line 4", ""].join("\n"));
  assert.equal(result.startLine, 3);
  assert.equal(result.endLine, 3);
});

test("multi-line replacements keep every line outside the range byte-identical", () => {
  const suggestion = "if (ok) {\n  return safeValue;\n}";
  const result = validateRemediationDraft(
    input(
      { publishedSuggestion: suggestion },
      { suggestionSha256: sha256Hex(suggestion) }
    )
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const lines = result.content.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["line 1", "line 2"]);
  assert.deepEqual(lines.slice(-2), ["line 4", ""]);
});

test("the validator fails closed on every precondition", () => {
  const cases: Array<[string, RemediationValidationInput]> = [
    ["invalid-path", input({}, { path: "../etc/passwd" })],
    ["invalid-path", input({}, { path: undefined })],
    ["forbidden-path", input({}, { path: ".github/workflows/ci.yml" })],
    ["forbidden-path", input({}, { path: ".guardianbot/config.yml" })],
    ["forbidden-path", input({}, { path: "packages/a/package-lock.json" })],
    ["forbidden-path", input({}, { path: "CODEOWNERS" })],
    ["forbidden-path", input({}, { path: ".gitlab-ci.yml" })],
    ["binary-file", input({}, { path: "assets/logo.png" })],
    ["finding-dismissed", input({}, { outcome: "dismissed", outcomeAt: "x" })],
    ["finding-not-open", input({}, { state: "resolved" })],
    ["stale-head", input({ currentHeadSha: "c".repeat(40) })],
    ["stale-head", input({ reviewedHeadSha: "c".repeat(40) })],
    ["stale-head", input({}, { lastSeenHeadSha: "c".repeat(40) })],
    ["missing-suggestion", input({}, { suggestionSha256: undefined })],
    ["missing-suggestion", input({ publishedSuggestion: undefined })],
    ["suggestion-mismatch", input({ publishedSuggestion: "return somethingElse;" })],
    ["invalid-range", input({}, { startLine: 4, endLine: 3 })],
    ["invalid-range", input({ changedRanges: [{ start: 1, end: 99 }] }, { startLine: 9, endLine: 9 })],
    ["size-bound", input({ fileBytes: 10 * 1024 * 1024 })],
    ["size-bound", input({ changedRanges: [{ start: 1, end: 200 }] }, { startLine: 1, endLine: 60 })],
    ["unsupported-line-endings", input({ fileContent: FILE.replace(/\n/g, "\r\n") })],
    ["binary-file", input({ fileContent: `${FILE}\u0000` })],
    ["range-not-changed", input({ changedRanges: [] })],
    ["range-not-changed", input({ changedRanges: [{ start: 1, end: 2 }] })]
  ];
  for (const [reason, candidate] of cases) {
    assert.deepEqual(validateRemediationDraft(candidate), { ok: false, reason }, reason);
  }
});

test("a suggestion identical to the current lines is a no-op and is refused", () => {
  const same = "  return unsafeValue;";
  const result = validateRemediationDraft(
    input(
      { publishedSuggestion: same, fileContent: ["line 1", "line 2", "return unsafeValue;", ""].join("\n") },
      { suggestionSha256: sha256Hex(same.trim()) }
    )
  );
  assert.deepEqual(result, { ok: false, reason: "no-op" });
});

test("forbidden paths are matched case-insensitively", () => {
  assert.equal(isForbiddenRemediationPath(".GitHub/workflows/x.yml"), true);
  assert.equal(isForbiddenRemediationPath("docs/CODEOWNERS"), true);
  assert.equal(isForbiddenRemediationPath("Cargo.lock"), true);
  assert.equal(isForbiddenRemediationPath(".gitattributes"), true);
  assert.equal(isForbiddenRemediationPath("vendor/.gitmodules"), true);
  assert.equal(isForbiddenRemediationPath(".pre-commit-config.yaml"), true);
  assert.equal(isForbiddenRemediationPath(".husky/pre-commit"), true);
  assert.equal(isForbiddenRemediationPath("src/github/client.ts"), false);
});

test("branch names are deterministic, prefixed, and carry only hex", () => {
  const name = remediationBranchName("ABCDEF0123456789zz", HEAD);
  assert.equal(name, `${REMEDIATION_BRANCH_PREFIX}abcdef012345-bbbbbbb`);
  assert.equal(remediationBranchName("ABCDEF0123456789zz", HEAD), name);
});

test("the draft body states it is AI-drafted and requires human approval", () => {
  const body = remediationDraftBody({
    sourcePullNumber: 12,
    path: "src/`evil`.ts",
    startLine: 3,
    endLine: 3,
    fingerprint: "f".repeat(64),
    headSha: HEAD
  });
  assert.match(body, /AI-drafted remediation\. Requires human review and approval\./);
  assert.match(body, /never merges, approves, or pushes/);
  assert.doesNotMatch(body, /`evil`/);
});

test("granted token permissions keep only well-formed entries and default to nothing", () => {
  assert.deepEqual(grantedPermissionsFrom(undefined), {});
  assert.deepEqual(grantedPermissionsFrom(["contents"]), {});
  assert.deepEqual(
    grantedPermissionsFrom({ contents: "write", issues: "read", "Bad Name": "write", actions: true }),
    { contents: "write", issues: "read" }
  );
  assert.equal(Object.isFrozen(grantedPermissionsFrom({ contents: "write" })), true);
});
