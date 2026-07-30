import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectSchemaFields,
  collectTypeScriptConfigFields,
  compareCliContracts,
  compareConfigContracts,
  isCapabilityFile,
  parseCliHelp,
  parseConfigReference,
  readMarkdownDocuments,
  validateExternalLinks,
  validateMarkdownLinks,
  validateMermaidDiagram,
  validateOpenApiDocument,
  validateSafeOpenApiSurface,
  validateReleaseNotes,
  validateStructuredExamples
} from "./docs-check-lib.mjs";

const MINIMAL_REPOSITORY_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "string" },
    image: {
      type: "object",
      properties: { enabled: { type: "boolean" } }
    },
    dast: {
      type: "object",
      properties: { enabled: { type: "boolean" } }
    }
  }
};

const BASELINE_JSON = `{
  "schemaVersion": "guardianbot.baseline.v1",
  "fingerprints": [
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}`;

const SUPPORTING_STRUCTURED_FENCES = [
  "```yaml guardianbot-config=full",
  "schemaVersion: guardianbot.config.v1",
  "```",
  "",
  "```yaml openapi",
  "openapi: 3.1.0",
  "info:",
  "  title: Safe API",
  "  version: 1.0.0",
  "paths: {}",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "A --> B",
  "```"
].join("\n");

function temporaryRepository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardianbot-docs-test-"));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

test("local links validate paths, references, anchors, and source line fragments", (context) => {
  const root = temporaryRepository({
    "README.md": [
      "# Home",
      "[Guide][guide]",
      "[Section](docs/guide.md#repeated-heading-1)",
      "[Source](src/example.ts#L2)",
      "[guide]: docs/guide.md"
    ].join("\n"),
    "docs/guide.md": "# Repeated heading\n\n## Repeated heading\n",
    "src/example.ts": "first\nsecond\n"
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const documents = readMarkdownDocuments(root);
  const result = validateMarkdownLinks(root, documents);
  assert.deepEqual(result.errors, []);
});

test("local link failures are aggregated with actionable locations", (context) => {
  const root = temporaryRepository({
    "README.md": [
      "# Home",
      "[Missing](docs/nope.md)",
      "[Bad anchor](#absent)",
      "[Escape](../outside.md)"
    ].join("\n")
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = validateMarkdownLinks(root, readMarkdownDocuments(root));
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join("\n"), /missing docs\/nope\.md/);
  assert.match(result.errors.join("\n"), /missing anchor #absent/);
  assert.match(result.errors.join("\n"), /outside the repository/);
});

test("unclosed Markdown fences and invalid Mermaid sources are rejected", (context) => {
  const root = temporaryRepository({
    "README.md": "# Broken\n\n```sh\nnpm test\n"
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [document] = readMarkdownDocuments(root);
  assert.match(document.fenceErrors[0], /unclosed/);
  assert.deepEqual(validateMermaidDiagram("flowchart LR\nA --> B", "diagram.md:1"), []);
  assert.match(validateMermaidDiagram("not-a-diagram", "diagram.md:2")[0], /syntax\/rendering/);
});

test("live external checks reject insecure/private targets without fetching them", async () => {
  const fetched = [];
  const errors = await validateExternalLinks([
    "http://example.com/docs",
    "https://127.0.0.1/private",
    "https://example.com/docs"
  ], async (url, options) => {
    fetched.push([url, options.method]);
    return { status: 200 };
  });
  assert.equal(errors.length, 2);
  assert.match(errors.join("\n"), /require HTTPS/);
  assert.match(errors.join("\n"), /local or private/);
  assert.deepEqual(fetched, [["https://example.com/docs", "HEAD"]]);
});

test("configuration contract compares source, schema, and the reference table", () => {
  const schema = {
    type: "object",
    required: ["enabled"],
    properties: {
      enabled: { type: "boolean" },
      nested: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } }
      }
    }
  };
  const source = `
    export interface Example {
      enabled: boolean;
      nested?: { name: string };
    }
  `;
  const reference = [
    "| Field | Required | Description |",
    "| --- | --- | --- |",
    "| `enabled` | yes | Toggle |",
    "| `nested` | no | Group |",
    "| `nested.name` | yes | Name |"
  ].join("\n");
  assert.deepEqual(compareConfigContracts({
    schemaFields: collectSchemaFields(schema),
    sourceFields: collectTypeScriptConfigFields(source, "Example"),
    referenceFields: parseConfigReference(reference).fields
  }), []);
});

test("configuration contract reports undocumented and stale fields", () => {
  const schemaFields = new Map([["current", { required: true }]]);
  const sourceFields = new Map([["current", { required: true }]]);
  const referenceFields = new Map([["stale", { required: true }]]);
  const errors = compareConfigContracts({ schemaFields, sourceFields, referenceFields });
  assert.deepEqual(errors, [
    "Configuration reference is missing current",
    "Configuration reference contains unknown field stale"
  ]);
});

test("CLI help comparison catches dispatch and option drift", () => {
  const help = parseCliHelp(`guardianctl <command>

Commands:
  doctor        Verify state

Options:
  --dry-run     Do not write
  --help        Show help
`);
  assert.deepEqual(compareCliContracts({
    commands: new Set(["doctor", "onboard"]),
    handledOptions: new Set(["--dry-run", "--json"])
  }, help), [
    "CLI help is missing dispatched commands: onboard",
    "CLI help is missing handled options: --json"
  ]);
});

test("OpenAPI validation accepts a minimal internal document and rejects remote refs", async () => {
  const valid = {
    openapi: "3.1.0",
    info: { title: "Safe API", version: "1.0.0" },
    paths: {
      "/healthz": {
        get: {
          responses: {
            "200": { description: "Healthy" }
          }
        }
      }
    }
  };
  assert.deepEqual(await validateOpenApiDocument(valid, "valid.yml"), []);
  const remote = structuredClone(valid);
  remote.paths["/healthz"].get.responses["200"].content = {
    "application/json": {
      schema: { $ref: "https://example.com/schema.json" }
    }
  };
  assert.match((await validateOpenApiDocument(remote, "remote.yml"))[0], /only internal OpenAPI/);
  const unsafe = structuredClone(valid);
  unsafe.servers = [{ url: "http://staging.example.com" }];
  unsafe.paths["/healthz"].post = { responses: { "204": { description: "Changed" } } };
  assert.equal(validateSafeOpenApiSurface(unsafe, "unsafe.yml").length, 2);
});

test("capability diffs require both status and changelog updates", () => {
  assert.equal(isCapabilityFile("rules/semgrep.yml"), true);
  assert.equal(isCapabilityFile("scripts/deploy-digitalocean.sh"), true);
  assert.equal(isCapabilityFile("scripts/check-docs.test.mjs"), false);
  const missing = validateReleaseNotes({
    files: ["packages/core/src/config.ts"],
    unresolvedCiBase: false
  });
  assert.equal(missing.errors.length, 2);
  const complete = validateReleaseNotes({
    files: ["packages/core/src/config.ts", "docs/status.md", "CHANGELOG.md"],
    unresolvedCiBase: false
  });
  assert.deepEqual(complete.errors, []);
  assert.deepEqual(complete.capabilityFiles, ["packages/core/src/config.ts"]);
});

test("CI fails closed when its release-note diff base is unavailable", () => {
  const result = validateReleaseNotes({
    files: [],
    unresolvedCiBase: true
  });
  assert.match(result.errors[0], /could not resolve/);
});

test("guardianbot-config=none accepts non-config baseline examples without counting them as config", async (context) => {
  const root = temporaryRepository({
    "docs/example.md": [
      "# Example",
      "",
      "```json guardianbot-config=none",
      BASELINE_JSON,
      "```",
      "",
      SUPPORTING_STRUCTURED_FENCES
    ].join("\n")
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await validateStructuredExamples(
    root,
    readMarkdownDocuments(root),
    MINIMAL_REPOSITORY_SCHEMA
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.configExamples, 1);
  assert.equal(result.openApiExamples, 1);
  assert.equal(result.mermaidDiagrams, 1);
});

test("structured examples that look like config still fail without a guardianbot-config marker", async (context) => {
  const root = temporaryRepository({
    "docs/example.md": [
      "# Example",
      "",
      "```json",
      BASELINE_JSON,
      "```",
      "",
      SUPPORTING_STRUCTURED_FENCES
    ].join("\n")
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await validateStructuredExamples(
    root,
    readMarkdownDocuments(root),
    MINIMAL_REPOSITORY_SCHEMA
  );
  assert.match(
    result.errors.join("\n"),
    /looks like GuardianBot configuration but lacks guardianbot-config=<scope>/
  );
  assert.equal(result.configExamples, 1);
});

test("guardianbot-config=none does not bypass JSON parsing or other structured validation", async (context) => {
  const root = temporaryRepository({
    "docs/example.md": [
      "# Example",
      "",
      "```json guardianbot-config=none",
      "{ schemaVersion: not-valid-json }",
      "```",
      "",
      "```json guardianbot-config=none openapi",
      "{",
      '  "notOpenApi": true',
      "}",
      "```",
      "",
      SUPPORTING_STRUCTURED_FENCES
    ].join("\n")
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await validateStructuredExamples(
    root,
    readMarkdownDocuments(root),
    MINIMAL_REPOSITORY_SCHEMA
  );
  assert.match(result.errors.join("\n"), /has invalid JSON/);
  assert.match(result.errors.join("\n"), /is not a valid OpenAPI document/);
  assert.equal(result.configExamples, 1);
});
