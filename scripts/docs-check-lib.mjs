import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";

import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { renderMermaidSVG } from "beautiful-mermaid";
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";
import ts from "typescript";
import YAML from "yaml";

const markdown = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false
});

const REQUIRED_DOCUMENTATION = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/getting-started.md",
  "docs/onboarding-repositories.md",
  "docs/repository-configuration.md",
  "docs/commands.md",
  "docs/troubleshooting.md",
  "docs/status.md",
  "docs/how-it-works.md",
  "docs/architecture.md",
  "docs/model-protocol.md",
  "docs/building-a-model-bridge.md",
  "docs/security-model.md",
  "docs/scanning-and-policy.md",
  "docs/image-security.md",
  "docs/dast.md",
  "docs/defectdojo.md",
  "docs/operations.md",
  "docs/metrics.md",
  "docs/roadmap.md",
  "docs/release-policy.md",
  "docs/runbooks/README.md"
];

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules"
]);

const CONFIG_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "workflowVersion",
  "repository",
  "review",
  "scanners",
  "image",
  "dast"
]);

const SAFE_NON_HTTP_PROTOCOLS = new Set(["mailto:", "tel:"]);
const EXTERNAL_REACHABLE_STATUSES = new Set([401, 403, 405, 429]);

export class DocumentationCheckError extends Error {
  constructor(errors, report) {
    super(
      `Documentation checks failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n` +
      errors.map((error) => `- ${error}`).join("\n")
    );
    this.name = "DocumentationCheckError";
    this.errors = errors;
    this.report = report;
  }
}

function normalizeRelative(file) {
  return file.split(path.sep).join("/");
}

function displayLocation(file, line) {
  return line ? `${file}:${line}` : file;
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    timeout: options.timeout ?? 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function git(root, args) {
  const result = commandResult("git", args, { cwd: root, timeout: 10_000 });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeDecode(value, context, errors) {
  try {
    return decodeURIComponent(value);
  } catch {
    errors.push(`${context} contains invalid percent-encoding: ${value}`);
    return undefined;
  }
}

function splitLinkTarget(destination) {
  const hash = destination.indexOf("#");
  const beforeHash = hash === -1 ? destination : destination.slice(0, hash);
  const fragment = hash === -1 ? "" : destination.slice(hash + 1);
  const query = beforeHash.indexOf("?");
  return {
    pathname: query === -1 ? beforeHash : beforeHash.slice(0, query),
    fragment
  };
}

function visitTokens(tokens, visitor, inheritedLine = 1) {
  for (const token of tokens) {
    const line = (token.map?.[0] ?? (inheritedLine - 1)) + 1;
    visitor(token, line);
    if (token.children) visitTokens(token.children, visitor, line);
  }
}

function headingText(token) {
  if (!token.children) return token.content;
  return token.children
    .filter((child) => !["html_inline", "image"].includes(child.type))
    .map((child) => child.content)
    .join("");
}

function htmlIds(content) {
  const ids = [];
  for (const match of content.matchAll(/\s(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    ids.push(match[1] ?? match[2]);
  }
  return ids;
}

function unclosedFenceErrors(source) {
  const errors = [];
  let open;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
        open = { marker: match[1][0], length: match[1].length, line: index + 1 };
      }
      continue;
    }
    const close = new RegExp(`^ {0,3}\\${open.marker}{${open.length},}[ \\t]*$`);
    if (close.test(line)) open = undefined;
  }
  if (open) errors.push(`unclosed ${open.marker.repeat(open.length)} fence opened at line ${open.line}`);
  return errors;
}

export function discoverMarkdownFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(normalizeRelative(path.relative(root, absolute)));
      }
    }
  };
  walk(root);
  return files.sort();
}

export function readMarkdownDocuments(root, files = discoverMarkdownFiles(root)) {
  return files.map((file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const tokens = markdown.parse(source, {});
    const anchors = new Set();
    const slugger = new GithubSlugger();
    const links = [];
    const fences = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type === "heading_open") {
        const inline = tokens[index + 1];
        if (inline?.type === "inline") anchors.add(slugger.slug(headingText(inline)));
      }
      if (token.type === "html_block" || token.type === "html_inline") {
        for (const id of htmlIds(token.content)) anchors.add(id);
      }
      if (token.type === "fence") {
        fences.push({
          content: token.content,
          info: token.info.trim(),
          line: (token.map?.[0] ?? 0) + 1
        });
      }
    }

    visitTokens(tokens, (token, line) => {
      if (token.type === "link_open") {
        links.push({
          destination: token.attrGet("href"),
          image: false,
          line
        });
      } else if (token.type === "image") {
        links.push({
          destination: token.attrGet("src"),
          image: true,
          line
        });
      } else if (token.type === "html_inline" || token.type === "html_block") {
        for (const match of token.content.matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
          links.push({
            destination: match[1] ?? match[2],
            image: /\ssrc\s*=/i.test(match[0]),
            line
          });
        }
      }
    });

    return {
      file,
      source,
      tokens,
      anchors,
      links,
      fences,
      fenceErrors: unclosedFenceErrors(source)
    };
  });
}

function lineFragmentIsValid(fragment, target) {
  const match = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
  if (!match) return false;
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  if (first < 1 || last < first) return false;
  const lines = fs.readFileSync(target, "utf8").split(/\r?\n/).length;
  return last <= lines;
}

export function validateMarkdownLinks(root, documents) {
  const errors = [];
  const externalUrls = new Set();
  const byFile = new Map(documents.map((document) => [document.file, document]));

  for (const document of documents) {
    for (const link of document.links) {
      const destination = link.destination?.trim();
      const location = displayLocation(document.file, link.line);
      if (!destination) {
        errors.push(`${location} has an empty ${link.image ? "image" : "link"} target`);
        continue;
      }
      if (destination.startsWith("<") && destination.endsWith(">")) {
        errors.push(`${location} has a malformed destination: ${destination}`);
        continue;
      }

      let parsed;
      try {
        parsed = new URL(destination);
      } catch {
        parsed = undefined;
      }
      if (parsed) {
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          if (!parsed.hostname) errors.push(`${location} has an external URL without a host: ${destination}`);
          if (parsed.username || parsed.password) {
            errors.push(`${location} must not embed credentials in an external URL: ${destination}`);
          }
          externalUrls.add(parsed.href);
        } else if (!SAFE_NON_HTTP_PROTOCOLS.has(parsed.protocol)) {
          errors.push(`${location} uses unsupported link protocol ${parsed.protocol}: ${destination}`);
        }
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) {
        errors.push(`${location} has a malformed or unsupported URL: ${destination}`);
        continue;
      }
      if (destination.includes("\\")) {
        errors.push(`${location} must use URL-style forward slashes: ${destination}`);
        continue;
      }

      const { pathname, fragment } = splitLinkTarget(destination);
      const decodedPath = safeDecode(pathname, location, errors);
      const decodedFragment = safeDecode(fragment, location, errors);
      if (decodedPath === undefined || decodedFragment === undefined) continue;
      const sourceDirectory = path.dirname(path.join(root, document.file));
      const target = decodedPath
        ? path.resolve(decodedPath.startsWith("/") ? root : sourceDirectory, decodedPath.replace(/^\/+/, ""))
        : path.join(root, document.file);
      if (!isInsideRoot(root, target)) {
        errors.push(`${location} links outside the repository: ${destination}`);
        continue;
      }
      if (!fs.existsSync(target)) {
        errors.push(`${location} links to missing ${decodedPath || destination}`);
        continue;
      }
      if (!isInsideRoot(fs.realpathSync(root), fs.realpathSync(target))) {
        errors.push(`${location} resolves through a symlink outside the repository: ${destination}`);
        continue;
      }

      if (!decodedFragment) continue;
      const relativeTarget = normalizeRelative(path.relative(root, target));
      if (target.toLowerCase().endsWith(".md")) {
        const targetDocument = byFile.get(relativeTarget);
        if (!targetDocument) {
          errors.push(`${location} cannot inspect Markdown anchor in ${relativeTarget}`);
        } else if (!targetDocument.anchors.has(decodedFragment)) {
          errors.push(`${location} links to missing anchor #${decodedFragment} in ${relativeTarget}`);
        }
      } else if (!fs.statSync(target).isFile() || !lineFragmentIsValid(decodedFragment, target)) {
        errors.push(`${location} has unsupported or out-of-range fragment #${decodedFragment} for ${relativeTarget}`);
      }
    }
  }

  return { errors, externalUrls: [...externalUrls].sort() };
}

async function fetchWithTimeout(url, fetchImpl, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetchImpl(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "guardianbot-docs-check/1.0",
        ...(method === "GET" ? { range: "bytes=0-1023" } : {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function validateExternalLinks(urls, fetchImpl = globalThis.fetch) {
  if (!fetchImpl) return ["External link checking requires a fetch implementation"];
  const errors = [];
  let cursor = 0;
  const checkOne = async () => {
    const url = urls[cursor];
    cursor += 1;
    if (!url) return;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      errors.push(`${url} is not eligible for live checking because external checks require HTTPS`);
      return;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const unsafeHostname =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(hostname) ||
      (isIP(hostname) === 4 && (
        /^10\./.test(hostname) ||
        /^127\./.test(hostname) ||
        /^169\.254\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
      ));
    if (unsafeHostname) {
      errors.push(`${url} is not eligible for live checking because its host is local or private`);
      return;
    }
    try {
      let response = await fetchWithTimeout(url, fetchImpl, "HEAD");
      if (response.status === 405 || response.status === 501) {
        response = await fetchWithTimeout(url, fetchImpl, "GET");
      }
      if (response.status >= 400 && !EXTERNAL_REACHABLE_STATUSES.has(response.status)) {
        errors.push(`${url} returned HTTP ${response.status}`);
      }
    } catch (error) {
      errors.push(`${url} was not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const workers = Array.from(
    { length: Math.min(4, urls.length) },
    async () => {
      while (cursor < urls.length) await checkOne();
    }
  );
  await Promise.all(workers);
  return errors;
}

function parseStructuredExample(fence, file, errors) {
  const language = fence.info.split(/\s+/)[0].toLowerCase();
  const location = displayLocation(file, fence.line);
  if (language === "json" || language === "jsonc") {
    try {
      return JSON.parse(fence.content);
    } catch (error) {
      errors.push(`${location} has invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  if (language === "yaml" || language === "yml") {
    const document = YAML.parseDocument(fence.content, {
      prettyErrors: true,
      strict: true,
      uniqueKeys: true
    });
    if (document.errors.length) {
      for (const error of document.errors) errors.push(`${location} has invalid YAML: ${error.message}`);
      return undefined;
    }
    return document.toJS();
  }
  return undefined;
}

function ajvErrors(validate) {
  return (validate.errors ?? []).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

function findRemoteRefs(value, currentPath = "$", refs = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findRemoteRefs(entry, `${currentPath}[${index}]`, refs));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && !child.startsWith("#")) {
        refs.push(`${currentPath}.$ref=${child}`);
      } else {
        findRemoteRefs(child, `${currentPath}.${key}`, refs);
      }
    }
  }
  return refs;
}

export async function validateOpenApiDocument(value, location) {
  const errors = [];
  if (!value || typeof value !== "object") return [`${location} must contain an OpenAPI object`];
  const remoteRefs = findRemoteRefs(value);
  if (remoteRefs.length) {
    errors.push(`${location} must use only internal OpenAPI $ref values (${remoteRefs.join(", ")})`);
    return errors;
  }
  try {
    await SwaggerParser.validate(structuredClone(value));
  } catch (error) {
    errors.push(`${location} is not a valid OpenAPI document: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

export function validateSafeOpenApiSurface(value, location) {
  const errors = [];
  const unsafeMethods = new Set(["delete", "patch", "post", "put", "trace"]);
  for (const [route, pathItem] of Object.entries(value?.paths ?? {})) {
    for (const method of Object.keys(pathItem ?? {})) {
      if (unsafeMethods.has(method.toLowerCase())) {
        errors.push(`${location} safe OpenAPI example contains state-changing ${method.toUpperCase()} ${route}`);
      }
    }
  }
  if (value?.webhooks) errors.push(`${location} safe OpenAPI example must not define webhooks`);
  for (const server of value?.servers ?? []) {
    try {
      const url = new URL(server.url);
      if (url.protocol !== "https:") errors.push(`${location} safe OpenAPI server must use HTTPS: ${server.url}`);
    } catch {
      errors.push(`${location} safe OpenAPI server must be an absolute URL: ${server.url}`);
    }
  }
  return errors;
}

export function validateMermaidDiagram(source, location) {
  try {
    const svg = renderMermaidSVG(source, {
      bg: "#ffffff",
      fg: "#111827"
    });
    if (!svg.startsWith("<svg") || !svg.includes("viewBox=") || svg.includes("<script")) {
      return [`${location} did not render to a safe SVG`];
    }
    return [];
  } catch (error) {
    return [`${location} has Mermaid syntax/rendering errors: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function standaloneStructuredExamples(root) {
  const examplesDirectory = path.join(root, "docs", "examples");
  if (!fs.existsSync(examplesDirectory)) return [];
  return fs.readdirSync(examplesDirectory)
    .filter((file) => /\.(?:json|ya?ml)$/i.test(file))
    .map((file) => normalizeRelative(path.join("docs", "examples", file)))
    .sort();
}

export async function validateStructuredExamples(root, documents, repositorySchema) {
  const errors = [];
  const Ajv = Ajv2020;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const fullValidator = ajv.compile(repositorySchema);
  const fragmentValidators = new Map(
    ["image", "dast"].map((key) => [key, ajv.compile(repositorySchema.properties[key])])
  );
  let configExamples = 0;
  let openApiExamples = 0;
  let mermaidDiagrams = 0;

  for (const document of documents) {
    for (const fence of document.fences) {
      const language = fence.info.split(/\s+/)[0].toLowerCase();
      const location = displayLocation(document.file, fence.line);
      if (!language) errors.push(`${location} has a fenced block without a language`);

      if (language === "mermaid") {
        mermaidDiagrams += 1;
        errors.push(...validateMermaidDiagram(fence.content, location));
        continue;
      }

      if (!["yaml", "yml", "json", "jsonc"].includes(language)) continue;
      const value = parseStructuredExample(fence, document.file, errors);
      if (value === undefined) continue;
      const configMatch = /\bguardianbot-config=(full|image|dast)\b/.exec(fence.info);
      const openApi = /\bopenapi\b/.test(fence.info);
      const topLevelKeys = value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
        : [];
      const looksLikeConfig = topLevelKeys.some((key) => CONFIG_TOP_LEVEL_FIELDS.has(key));

      if (looksLikeConfig && !configMatch) {
        errors.push(`${location} looks like GuardianBot configuration but lacks guardianbot-config=<scope>`);
      }
      if (configMatch) {
        configExamples += 1;
        const scope = configMatch[1];
        const validate = scope === "full" ? fullValidator : fragmentValidators.get(scope);
        const structured = value && typeof value === "object" && !Array.isArray(value);
        const candidate = scope === "full" ? value : structured ? value[scope] : undefined;
        if (scope !== "full" && (!structured || topLevelKeys.length !== 1 || !(scope in value))) {
          errors.push(`${location} must contain only the ${scope} top-level fragment`);
        } else if (!validate(candidate)) {
          errors.push(`${location} does not match repository-config ${scope}: ${ajvErrors(validate).join("; ")}`);
        }
      }
      if (openApi) {
        openApiExamples += 1;
        errors.push(...await validateOpenApiDocument(value, location));
      }
    }
  }

  for (const file of standaloneStructuredExamples(root)) {
    const location = file;
    const source = fs.readFileSync(path.join(root, file), "utf8");
    let value;
    try {
      value = file.endsWith(".json") ? JSON.parse(source) : YAML.parse(source);
    } catch (error) {
      errors.push(`${file} is not valid ${file.endsWith(".json") ? "JSON" : "YAML"}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (/^openapi(?:[.-]|$)/i.test(path.basename(file))) {
      openApiExamples += 1;
      errors.push(...await validateOpenApiDocument(value, location));
      if (/^openapi\.safe(?:[.-]|$)/i.test(path.basename(file))) {
        errors.push(...validateSafeOpenApiSurface(value, location));
      }
    } else if (/^(?:repository|guardianbot)(?:[.-]|$)/i.test(path.basename(file))) {
      configExamples += 1;
      if (!fullValidator(value)) {
        errors.push(`${file} does not match repository-config: ${ajvErrors(fullValidator).join("; ")}`);
      }
    }
  }

  if (configExamples === 0) errors.push("No schema-annotated GuardianBot configuration examples were found");
  if (openApiExamples === 0) errors.push("No OpenAPI examples were found under docs/examples or annotated fences");
  if (mermaidDiagrams === 0) errors.push("No Mermaid diagrams were found to render");

  return { errors, configExamples, openApiExamples, mermaidDiagrams };
}

function schemaObjectNode(schema) {
  if (schema?.properties) return schema;
  if (schema?.items?.properties) return schema.items;
  return undefined;
}

export function collectSchemaFields(schema, prefix = "", fields = new Map()) {
  const object = schemaObjectNode(schema);
  if (!object) return fields;
  for (const [name, child] of Object.entries(object.properties)) {
    const field = prefix ? `${prefix}.${name}` : name;
    fields.set(field, { required: (object.required ?? []).includes(name) });
    collectSchemaFields(child, field, fields);
  }
  return fields;
}

function nestedTypeNode(node) {
  if (!node) return undefined;
  if (ts.isParenthesizedTypeNode(node)) return nestedTypeNode(node.type);
  if (ts.isUnionTypeNode(node)) {
    for (const member of node.types) {
      if (member.kind === ts.SyntaxKind.NullKeyword || member.kind === ts.SyntaxKind.UndefinedKeyword) continue;
      const nested = nestedTypeNode(member);
      if (nested) return nested;
    }
    return undefined;
  }
  if (ts.isTypeLiteralNode(node)) return node;
  if (ts.isArrayTypeNode(node)) return nestedTypeNode(node.elementType);
  if (ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1 &&
      ["Array", "ReadonlyArray"].includes(node.typeName.getText())) {
    return nestedTypeNode(node.typeArguments[0]);
  }
  return undefined;
}

export function collectTypeScriptConfigFields(source, interfaceName = "GuardianConfig") {
  const sourceFile = ts.createSourceFile(
    "config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declaration = sourceFile.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) throw new Error(`Could not find TypeScript interface ${interfaceName}`);
  const fields = new Map();

  const visit = (members, prefix = "") => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : member.name.getText(sourceFile);
      const field = prefix ? `${prefix}.${name}` : name;
      fields.set(field, { required: !member.questionToken });
      const nested = nestedTypeNode(member.type);
      if (nested) visit(nested.members, field);
    }
  };
  visit(declaration.members);
  return fields;
}

export function parseConfigReference(source) {
  const fields = new Map();
  const errors = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*(yes|no)\s*\|/i.exec(line);
    if (!match) continue;
    if (fields.has(match[1])) errors.push(`duplicate field ${match[1]} at line ${index + 1}`);
    fields.set(match[1], { required: match[2].toLowerCase() === "yes", line: index + 1 });
  }
  return { fields, errors };
}

export function compareConfigContracts({ schemaFields, sourceFields, referenceFields }) {
  const errors = [];
  const allNames = new Set([...schemaFields.keys(), ...sourceFields.keys()]);
  for (const field of [...allNames].sort()) {
    const schema = schemaFields.get(field);
    const source = sourceFields.get(field);
    if (!schema) {
      errors.push(`GuardianConfig source field ${field} is missing from repository-config schema`);
      continue;
    }
    if (!source) {
      errors.push(`Repository-config schema field ${field} is missing from GuardianConfig source`);
      continue;
    }
    if (schema.required !== source.required) {
      errors.push(`Requiredness differs for ${field}: schema=${schema.required}, source=${source.required}`);
    }
  }
  for (const field of [...schemaFields.keys()].sort()) {
    const expected = schemaFields.get(field);
    const reference = referenceFields.get(field);
    if (!reference) {
      errors.push(`Configuration reference is missing ${field}`);
    } else if (expected.required !== reference.required) {
      errors.push(`Configuration reference has wrong requiredness for ${field}: expected ${expected.required ? "yes" : "no"}`);
    }
  }
  for (const field of referenceFields.keys()) {
    if (!schemaFields.has(field)) errors.push(`Configuration reference contains unknown field ${field}`);
  }
  return errors;
}

function stringLiteralValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

export function extractCliSourceContract(source) {
  const sourceFile = ts.createSourceFile(
    "cli.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const commands = new Set();
  const handledOptions = new Set();

  const visit = (node) => {
    if (ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left) && node.left.text === "command") {
        const value = stringLiteralValue(node.right);
        if (value) commands.add(value);
      } else if (ts.isIdentifier(node.right) && node.right.text === "command") {
        const value = stringLiteralValue(node.left);
        if (value) commands.add(value);
      }
    }
    if (ts.isCaseClause(node)) {
      const value = stringLiteralValue(node.expression);
      if (value) commands.add(value);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "option") {
        const value = stringLiteralValue(node.arguments[1]);
        if (value?.startsWith("--")) handledOptions.add(value);
      }
      if (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "includes" &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "args") {
        const value = stringLiteralValue(node.arguments[0]);
        if (value?.startsWith("--")) handledOptions.add(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { commands, handledOptions };
}

export function parseCliHelp(output) {
  const commands = new Set();
  const options = new Set();
  let section;
  for (const line of output.split(/\r?\n/)) {
    for (const match of line.matchAll(/--[a-z][a-z0-9-]*/g)) options.add(match[0]);
    if (line.trim() === "Commands:") {
      section = "commands";
      continue;
    }
    if (line.trim() === "Options:") {
      section = "options";
      continue;
    }
    if (!line.trim()) continue;
    if (section === "commands") {
      const match = /^\s{2}([a-z][a-z0-9-]+)\s{2,}\S/.exec(line);
      if (match) commands.add(match[1]);
    }
  }
  return { commands, options };
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

export function compareCliContracts(sourceContract, helpContract) {
  const errors = [];
  const missingFromHelp = setDifference(sourceContract.commands, helpContract.commands);
  const missingFromSource = setDifference(helpContract.commands, sourceContract.commands);
  const unadvertisedOptions = setDifference(sourceContract.handledOptions, helpContract.options);
  if (missingFromHelp.length) errors.push(`CLI help is missing dispatched commands: ${missingFromHelp.join(", ")}`);
  if (missingFromSource.length) errors.push(`CLI help advertises undispatched commands: ${missingFromSource.join(", ")}`);
  if (unadvertisedOptions.length) errors.push(`CLI help is missing handled options: ${unadvertisedOptions.join(", ")}`);
  return errors;
}

function documentedCliCommands(documents) {
  const commands = new Set();
  for (const document of documents) {
    for (const match of document.source.matchAll(/\bguardianctl\s+([a-z][a-z0-9-]*)\b/g)) {
      commands.add(match[1]);
    }
  }
  return commands;
}

function runHelpCommand(root, args) {
  const executable = path.join(root, "packages", "guardianctl", "dist", "cli.js");
  return commandResult(process.execPath, [executable, ...args], {
    cwd: root,
    timeout: 10_000,
    env: {
      ...process.env,
      GUARDIANBOT_DOCS_TEST: "1",
      GH_TOKEN: "docs-check-must-not-be-used",
      GUARDIANBOT_WORKFLOW_SHA: "0000000000000000000000000000000000000001"
    }
  });
}

export function validateCliDocumentation(root, documents) {
  const errors = [];
  const cliSourcePath = path.join(root, "packages", "guardianctl", "src", "cli.ts");
  const cliExecutablePath = path.join(root, "packages", "guardianctl", "dist", "cli.js");
  if (!fs.existsSync(cliExecutablePath)) {
    return {
      errors: ["guardianctl build output is missing; run npm run docs:build-cli"],
      commands: 0,
      smokeCommands: 0
    };
  }
  const sourceContract = extractCliSourceContract(fs.readFileSync(cliSourcePath, "utf8"));
  const globalHelp = runHelpCommand(root, ["--help"]);
  if (globalHelp.status !== 0) {
    errors.push(`Documented guardianctl --help smoke command failed: ${globalHelp.stderr.trim() || `exit ${globalHelp.status}`}`);
    return { errors, commands: sourceContract.commands.size, smokeCommands: 1 };
  }
  const helpContract = parseCliHelp(globalHelp.stdout);
  errors.push(...compareCliContracts(sourceContract, helpContract));

  const documented = documentedCliCommands(documents);
  const undocumented = setDifference(helpContract.commands, documented);
  const unknown = setDifference(documented, helpContract.commands);
  if (undocumented.length) errors.push(`Documented CLI reference is missing commands: ${undocumented.join(", ")}`);
  if (unknown.length) errors.push(`Documentation names unknown guardianctl commands: ${unknown.join(", ")}`);

  let smokeCommands = 1;
  for (const command of [...helpContract.commands].sort()) {
    const result = runHelpCommand(root, [command, "--help"]);
    smokeCommands += 1;
    if (result.status !== 0) {
      errors.push(`guardianctl ${command} --help smoke failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    } else if (result.stdout !== globalHelp.stdout) {
      errors.push(`guardianctl ${command} --help differs from global help`);
    }
  }
  return { errors, commands: helpContract.commands.size, smokeCommands };
}

function readGitHubEventBase() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return undefined;
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    return event.pull_request?.base?.sha ?? (
      typeof event.before === "string" && !/^0+$/.test(event.before) ? event.before : undefined
    );
  } catch {
    return undefined;
  }
}

function resolveDiffBase(root) {
  const candidates = [
    process.env.DOCS_DIFF_BASE,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
    readGitHubEventBase()
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (git(root, ["rev-parse", "--verify", `${candidate}^{commit}`])) return candidate;
  }
  return undefined;
}

export function detectChangedFiles(root) {
  const base = resolveDiffBase(root);
  const files = new Set();
  let mode;
  if (base) {
    mode = `git diff ${base}...HEAD`;
    for (const file of (git(root, ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`]) ?? "").split("\n")) {
      if (file) files.add(normalizeRelative(file));
    }
  } else {
    mode = "local working tree";
    for (const file of (git(root, ["diff", "--name-only", "--diff-filter=ACMRD", "HEAD"]) ?? "").split("\n")) {
      if (file) files.add(normalizeRelative(file));
    }
    for (const file of (git(root, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n")) {
      if (file) files.add(normalizeRelative(file));
    }
  }
  return {
    base,
    files: [...files].sort(),
    mode,
    unresolvedCiBase: Boolean(process.env.CI && !base)
  };
}

export function isCapabilityFile(file) {
  return (
    /^(?:apps|packages)\/[^/]+\/src\//.test(file) ||
    /^schemas\/.*\.json$/.test(file) ||
    /^\.github\/(?:workflows|actions)\//.test(file) ||
    /^infra\//.test(file) ||
    /^rules\//.test(file) ||
    /^Dockerfile$/.test(file) ||
    /^scripts\/(?!check-docs(?:\.test)?\.mjs$|docs-check-|export-protocol-schemas\.mjs$|check-schemas\.mjs$).+/.test(file) ||
    /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file)
  );
}

export function validateReleaseNotes(changed) {
  const errors = [];
  if (changed.unresolvedCiBase) {
    errors.push(
      "CI could not resolve a documentation diff base; configure checkout history or DOCS_DIFF_BASE"
    );
    return { errors, capabilityFiles: [] };
  }
  const capabilityFiles = changed.files.filter(isCapabilityFile);
  if (capabilityFiles.length) {
    if (!changed.files.includes("docs/status.md")) {
      errors.push(`Capability changes require docs/status.md (${capabilityFiles.join(", ")})`);
    }
    if (!changed.files.includes("CHANGELOG.md")) {
      errors.push(`Capability changes require CHANGELOG.md (${capabilityFiles.join(", ")})`);
    }
  }
  return { errors, capabilityFiles };
}

export async function runDocumentationChecks({ root, checkExternalLinks = false }) {
  const errors = [];
  for (const file of REQUIRED_DOCUMENTATION) {
    if (!fs.existsSync(path.join(root, file))) errors.push(`Required documentation missing: ${file}`);
  }

  const documents = readMarkdownDocuments(root);
  for (const document of documents) {
    for (const error of document.fenceErrors) errors.push(`${document.file}: ${error}`);
  }
  const links = validateMarkdownLinks(root, documents);
  errors.push(...links.errors);
  if (checkExternalLinks) errors.push(...await validateExternalLinks(links.externalUrls));

  const repositorySchemaPath = path.join(root, "schemas", "repository-config.v1.schema.json");
  let repositorySchema;
  try {
    repositorySchema = JSON.parse(fs.readFileSync(repositorySchemaPath, "utf8"));
  } catch (error) {
    errors.push(`Cannot read repository configuration schema: ${error instanceof Error ? error.message : String(error)}`);
  }

  let examples = { errors: [], configExamples: 0, openApiExamples: 0, mermaidDiagrams: 0 };
  if (repositorySchema) {
    examples = await validateStructuredExamples(root, documents, repositorySchema);
    errors.push(...examples.errors);

    const schemaFields = collectSchemaFields(repositorySchema);
    const sourceFields = collectTypeScriptConfigFields(
      fs.readFileSync(path.join(root, "packages", "core", "src", "config.ts"), "utf8")
    );
    const reference = parseConfigReference(
      fs.readFileSync(path.join(root, "docs", "repository-configuration.md"), "utf8")
    );
    errors.push(...reference.errors);
    errors.push(...compareConfigContracts({
      schemaFields,
      sourceFields,
      referenceFields: reference.fields
    }));
  }

  const cli = validateCliDocumentation(root, documents);
  errors.push(...cli.errors);

  const changed = detectChangedFiles(root);
  const releaseNotes = validateReleaseNotes(changed);
  errors.push(...releaseNotes.errors);

  const report = {
    markdownFiles: documents.length,
    localLinks: documents.reduce(
      (count, document) => count + document.links.filter((link) => !/^https?:/i.test(link.destination ?? "")).length,
      0
    ),
    externalLinks: links.externalUrls.length,
    externalMode: checkExternalLinks ? "live reachability" : "syntax-only",
    ...examples,
    cliCommands: cli.commands,
    cliSmokeCommands: cli.smokeCommands,
    configFields: repositorySchema ? collectSchemaFields(repositorySchema).size : 0,
    diffMode: changed.mode,
    capabilityFiles: releaseNotes.capabilityFiles.length
  };

  if (errors.length) throw new DocumentationCheckError(errors, report);
  return report;
}

export function formatDocumentationReport(report) {
  const externalDetail = report.externalMode === "live reachability"
    ? "live reachability"
    : "syntax-only; use npm run docs:check:external for live reachability";
  return [
    `Validated ${report.markdownFiles} Markdown files and ${report.localLinks} local links.`,
    `Validated ${report.externalLinks} external URLs (${externalDetail}).`,
    `Validated ${report.configExamples} configuration example(s), ${report.openApiExamples} OpenAPI example(s), and ${report.configFields} documented config fields.`,
    `Rendered ${report.mermaidDiagrams} Mermaid diagram(s) to in-memory SVG.`,
    `Executed ${report.cliSmokeCommands} guardianctl help smoke command(s) across ${report.cliCommands} commands.`,
    `Checked release-note policy using ${report.diffMode}; ${report.capabilityFiles} capability file(s) changed.`
  ].join("\n");
}
