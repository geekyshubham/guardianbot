import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Language,
  Parser,
  type Node as SyntaxNode
} from "web-tree-sitter";
import { normalizeSourceText, sha256 } from "./lexical.js";
import type {
  IndexedLanguage,
  IndexedSymbolKind,
  ParsedCall,
  ParsedImport,
  ParsedSourceFile,
  ParsedSymbol,
  RepositorySourceParser
} from "./types.js";

const MAX_TREE_SITTER_SOURCE_BYTES = 1_500_000;
const MAX_SYMBOL_CONTENT_CHARACTERS = 8_000;
const MAX_TARGET_CHARACTERS = 256;

type GrammarName = "python" | "javascript" | "typescript" | "tsx" | "swift" | "ruby";

interface LanguageSelection {
  language: IndexedLanguage;
  grammar?: GrammarName;
}

const grammarFiles: Record<GrammarName, string> = {
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  swift: "tree-sitter-swift.wasm",
  ruby: "tree-sitter-ruby.wasm"
};

let parserRuntimePromise: Promise<void> | undefined;
const languagePromises = new Map<GrammarName, Promise<Language>>();

function selectLanguage(path: string): LanguageSelection {
  const lowerPath = path.toLowerCase();
  const fileName = basename(lowerPath);
  if (lowerPath.endsWith(".py") || lowerPath.endsWith(".pyi")) {
    return { language: "python", grammar: "python" };
  }
  if (
    lowerPath.endsWith(".js") ||
    lowerPath.endsWith(".jsx") ||
    lowerPath.endsWith(".mjs") ||
    lowerPath.endsWith(".cjs")
  ) {
    return { language: "javascript", grammar: "javascript" };
  }
  if (lowerPath.endsWith(".tsx")) {
    return { language: "typescript", grammar: "tsx" };
  }
  if (
    lowerPath.endsWith(".ts") ||
    lowerPath.endsWith(".mts") ||
    lowerPath.endsWith(".cts")
  ) {
    return { language: "typescript", grammar: "typescript" };
  }
  if (lowerPath.endsWith(".swift")) {
    return { language: "swift", grammar: "swift" };
  }
  if (
    lowerPath.endsWith(".rb") ||
    lowerPath.endsWith(".rake") ||
    lowerPath.endsWith(".gemspec") ||
    fileName === "gemfile" ||
    fileName === "rakefile"
  ) {
    return { language: "ruby", grammar: "ruby" };
  }
  return { language: "text" };
}

function initializeParserRuntime(): Promise<void> {
  parserRuntimePromise ??= Parser.init({
    locateFile: () =>
      fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"))
  });
  return parserRuntimePromise;
}

async function loadLanguage(grammar: GrammarName): Promise<Language> {
  await initializeParserRuntime();
  let pending = languagePromises.get(grammar);
  if (!pending) {
    const fileName = grammarFiles[grammar];
    const wasmPath = fileURLToPath(
      import.meta.resolve(`@repomix/tree-sitter-wasms/out/${fileName}`)
    );
    pending = Language.load(wasmPath);
    languagePromises.set(grammar, pending);
  }
  return pending;
}

function allNamedNodes(root: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) pending.push(child);
    }
  }
  return result;
}

function bounded(value: string, maximum = MAX_SYMBOL_CONTENT_CHARACTERS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[guardianbot-truncated]`;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_TARGET_CHARACTERS);
}

function stripStringQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function symbolDescriptor(
  language: IndexedLanguage,
  node: SyntaxNode
): { kind: IndexedSymbolKind; nameNode: SyntaxNode } | undefined {
  const nameNode = node.childForFieldName("name");

  if (language === "python") {
    if (node.type === "function_definition" && nameNode) {
      return {
        kind: hasAncestorType(node, new Set(["class_definition"])) ? "method" : "function",
        nameNode
      };
    }
    if (node.type === "class_definition" && nameNode) {
      return { kind: "class", nameNode };
    }
  }

  if (language === "javascript" || language === "typescript") {
    if (
      ["function_declaration", "generator_function_declaration"].includes(node.type) &&
      nameNode
    ) {
      return { kind: "function", nameNode };
    }
    if (node.type === "method_definition" && nameNode) {
      return { kind: "method", nameNode };
    }
    if (node.type === "class_declaration" && nameNode) {
      return { kind: "class", nameNode };
    }
    if (
      ["interface_declaration", "type_alias_declaration", "enum_declaration"].includes(
        node.type
      ) &&
      nameNode
    ) {
      return { kind: "type", nameNode };
    }
    if (node.type === "variable_declarator" && nameNode) {
      const value = node.childForFieldName("value");
      if (
        value &&
        ["arrow_function", "function_expression", "generator_function"].includes(value.type)
      ) {
        return { kind: "function", nameNode };
      }
    }
  }

  if (language === "swift") {
    if (node.type === "function_declaration" && nameNode) {
      return {
        kind: hasAncestorType(
          node,
          new Set([
            "class_declaration",
            "struct_declaration",
            "enum_declaration",
            "protocol_declaration",
            "extension_declaration"
          ])
        )
          ? "method"
          : "function",
        nameNode
      };
    }
    if (node.type === "class_declaration" && nameNode) {
      return { kind: "class", nameNode };
    }
    if (
      [
        "struct_declaration",
        "enum_declaration",
        "protocol_declaration",
        "typealias_declaration"
      ].includes(node.type) &&
      nameNode
    ) {
      return { kind: "type", nameNode };
    }
  }

  if (language === "ruby") {
    if (["method", "singleton_method"].includes(node.type) && nameNode) {
      return {
        kind: hasAncestorType(node, new Set(["class", "module"])) ? "method" : "function",
        nameNode
      };
    }
    if (node.type === "class" && nameNode) {
      return { kind: "class", nameNode };
    }
    if (node.type === "module" && nameNode) {
      return { kind: "module", nameNode };
    }
  }

  return undefined;
}

function hasAncestorType(node: SyntaxNode, types: ReadonlySet<string>): boolean {
  let current = node.parent;
  while (current) {
    if (types.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

function enclosingContainerName(language: IndexedLanguage, node: SyntaxNode): string | undefined {
  const containerTypes =
    language === "python"
      ? new Set(["class_definition"])
      : language === "javascript" || language === "typescript"
        ? new Set(["class_declaration", "interface_declaration"])
        : language === "swift"
          ? new Set([
              "class_declaration",
              "struct_declaration",
              "enum_declaration",
              "protocol_declaration",
              "extension_declaration"
            ])
          : language === "ruby"
            ? new Set(["class", "module"])
            : new Set<string>();
  let current = node.parent;
  while (current) {
    if (containerTypes.has(current.type)) {
      const name = current.childForFieldName("name");
      if (name) return normalizedName(name.text);
    }
    current = current.parent;
  }
  return undefined;
}

function nearestSymbolLocalId(
  node: SyntaxNode,
  symbolIdsByNode: ReadonlyMap<number, string>
): string | undefined {
  let current = node.parent;
  while (current) {
    const symbolId = symbolIdsByNode.get(current.id);
    if (symbolId) return symbolId;
    current = current.parent;
  }
  return undefined;
}

function importFromNode(
  language: IndexedLanguage,
  node: SyntaxNode,
  symbolIdsByNode: ReadonlyMap<number, string>
): ParsedImport | undefined {
  const containingSymbolLocalId = nearestSymbolLocalId(node, symbolIdsByNode);
  if (
    (language === "javascript" || language === "typescript") &&
    node.type === "import_statement"
  ) {
    const source = node.childForFieldName("source");
    if (!source) return undefined;
    const names = node
      .descendantsOfType(["identifier", "type_identifier"])
      .map((candidate) => normalizedName(candidate.text))
      .filter(Boolean);
    return {
      line: node.startPosition.row + 1,
      source: stripStringQuotes(source.text),
      names: [...new Set(names)].sort(),
      kind: "static",
      containingSymbolLocalId
    };
  }

  if (
    (language === "javascript" || language === "typescript") &&
    node.type === "call_expression"
  ) {
    const functionNode = node.childForFieldName("function");
    const importKind =
      functionNode?.text === "require"
        ? "require"
        : functionNode?.text === "import"
          ? "dynamic"
          : undefined;
    if (importKind) {
      const source = node.descendantsOfType("string")[0];
      if (source) {
        return {
          line: node.startPosition.row + 1,
          source: stripStringQuotes(source.text),
          names: [],
          kind: importKind,
          containingSymbolLocalId
        };
      }
    }
  }

  if (
    language === "python" &&
    (node.type === "import_statement" || node.type === "import_from_statement")
  ) {
    const moduleName =
      node.childForFieldName("module_name") ??
      node.descendantsOfType("dotted_name")[0] ??
      node.descendantsOfType("identifier")[0];
    if (!moduleName) return undefined;
    const names = node
      .descendantsOfType("identifier")
      .map((candidate) => normalizedName(candidate.text))
      .filter((name) => name !== normalizedName(moduleName.text));
    return {
      line: node.startPosition.row + 1,
      source: normalizedName(moduleName.text),
      names: [...new Set(names)].sort(),
      kind: "static",
      containingSymbolLocalId
    };
  }

  if (language === "swift" && node.type === "import_declaration") {
    const source = node.namedChildren.map((child) => child.text).join(".");
    if (!source) return undefined;
    return {
      line: node.startPosition.row + 1,
      source: normalizedName(source),
      names: [],
      kind: "static",
      containingSymbolLocalId
    };
  }

  if (language === "ruby" && node.type === "call") {
    const method = node.childForFieldName("method");
    if (!method || !["require", "require_relative", "load"].includes(method.text)) {
      return undefined;
    }
    const stringNode = node.descendantsOfType("string")[0];
    if (!stringNode) return undefined;
    return {
      line: node.startPosition.row + 1,
      source: stripStringQuotes(stringNode.text),
      names: [],
      kind: "require",
      containingSymbolLocalId
    };
  }

  return undefined;
}

function callTarget(language: IndexedLanguage, node: SyntaxNode): string | undefined {
  let targetNode: SyntaxNode | null | undefined;
  if (language === "javascript" || language === "typescript" || language === "python") {
    targetNode = node.childForFieldName("function");
  } else if (language === "ruby") {
    targetNode = node.childForFieldName("method");
  } else if (language === "swift") {
    targetNode = node.firstNamedChild;
  }
  if (!targetNode) return undefined;
  const target = normalizedName(targetNode.text);
  return target || undefined;
}

function isCallNode(language: IndexedLanguage, node: SyntaxNode): boolean {
  if (language === "python") return node.type === "call";
  if (language === "ruby") return node.type === "call";
  if (
    language === "javascript" ||
    language === "typescript" ||
    language === "swift"
  ) {
    return node.type === "call_expression";
  }
  return false;
}

function parseSyntaxTree(
  path: string,
  content: string,
  language: IndexedLanguage,
  root: SyntaxNode,
  parserId: string
): ParsedSourceFile {
  const nodes = allNamedNodes(root);
  const symbols: ParsedSymbol[] = [];
  const symbolIdsByNode = new Map<number, string>();

  for (const node of nodes) {
    const descriptor = symbolDescriptor(language, node);
    if (!descriptor) continue;
    const name = normalizedName(descriptor.nameNode.text);
    if (!name) continue;
    const container = enclosingContainerName(language, node);
    const localId = `${node.id}:${node.startIndex}:${descriptor.kind}:${name}`;
    symbolIdsByNode.set(node.id, localId);
    symbols.push({
      localId,
      name,
      qualifiedName: container ? `${container}.${name}` : name,
      kind: descriptor.kind,
      line: node.startPosition.row + 1,
      endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
      content: bounded(normalizeSourceText(node.text))
    });
  }

  const imports: ParsedImport[] = [];
  const calls: ParsedCall[] = [];
  for (const node of nodes) {
    const imported = importFromNode(language, node, symbolIdsByNode);
    if (imported) imports.push(imported);
    if (!isCallNode(language, node)) continue;
    const target = callTarget(language, node);
    if (!target) continue;
    if (
      imported &&
      (language === "javascript" || language === "typescript") &&
      (target === "require" || target === "import")
    ) {
      continue;
    }
    calls.push({
      line: node.startPosition.row + 1,
      target,
      callerSymbolLocalId: nearestSymbolLocalId(node, symbolIdsByNode)
    });
  }

  return {
    path,
    language,
    parser: "tree-sitter",
    parserId,
    contentSha256: sha256(content),
    lineCount: content ? content.split("\n").length : 0,
    symbols,
    imports,
    calls,
    diagnostic: root.hasError ? "syntax-recovery" : undefined
  };
}

interface FallbackSymbolPattern {
  kind: IndexedSymbolKind;
  pattern: RegExp;
}

const fallbackPatterns: Record<
  Exclude<IndexedLanguage, "text">,
  FallbackSymbolPattern[]
> = {
  javascript: [
    {
      kind: "function",
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
    },
    {
      kind: "function",
      pattern:
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
    },
    {
      kind: "class",
      pattern: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/
    },
    {
      kind: "type",
      pattern: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/
    }
  ],
  typescript: [
    {
      kind: "function",
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
    },
    {
      kind: "function",
      pattern:
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
    },
    {
      kind: "class",
      pattern: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/
    },
    {
      kind: "type",
      pattern: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/
    }
  ],
  python: [
    { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)/ }
  ],
  swift: [
    { kind: "function", pattern: /^\s*func\s+([A-Za-z_]\w*)/ },
    { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)/ },
    {
      kind: "type",
      pattern: /^\s*(?:struct|enum|protocol|typealias)\s+([A-Za-z_]\w*)/
    }
  ],
  ruby: [
    { kind: "function", pattern: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ },
    { kind: "class", pattern: /^\s*class\s+([A-Za-z_:]\w*)/ },
    { kind: "module", pattern: /^\s*module\s+([A-Za-z_:]\w*)/ }
  ]
};

function fallbackImports(
  language: IndexedLanguage,
  line: string,
  lineNumber: number
): ParsedImport[] {
  if (language === "javascript" || language === "typescript") {
    const staticMatch = line.match(/^\s*import(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/);
    if (staticMatch?.[1]) {
      return [{ line: lineNumber, source: staticMatch[1], names: [], kind: "static" }];
    }
    const requireMatch = line.match(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/);
    if (requireMatch?.[1]) {
      return [{ line: lineNumber, source: requireMatch[1], names: [], kind: "require" }];
    }
  }
  if (language === "python") {
    const fromMatch = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)/);
    if (fromMatch?.[1]) {
      return [
        {
          line: lineNumber,
          source: fromMatch[1],
          names: (fromMatch[2] ?? "")
            .split(",")
            .map((name) => name.trim().split(/\s+as\s+/)[0] ?? "")
            .filter(Boolean)
            .sort(),
          kind: "static"
        }
      ];
    }
    const importMatch = line.match(/^\s*import\s+([A-Za-z_][\w.]*)/);
    if (importMatch?.[1]) {
      return [{ line: lineNumber, source: importMatch[1], names: [], kind: "static" }];
    }
  }
  if (language === "swift") {
    const match = line.match(/^\s*import\s+([A-Za-z_][\w.]*)/);
    if (match?.[1]) {
      return [{ line: lineNumber, source: match[1], names: [], kind: "static" }];
    }
  }
  if (language === "ruby") {
    const match = line.match(/^\s*(require|require_relative|load)\s*\(?\s*["']([^"']+)["']/);
    if (match?.[2]) {
      return [{ line: lineNumber, source: match[2], names: [], kind: "require" }];
    }
  }
  return [];
}

function fallbackCalls(line: string, lineNumber: number, callerSymbolLocalId?: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  const pattern = /\b([A-Za-z_$][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const target = normalizedName((match[1] ?? "").replace(/\s+/g, ""));
    if (
      !target ||
      [
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "function",
        "def",
        "func",
        "require",
        "require_relative",
        "load",
        "import"
      ].includes(target)
    ) {
      continue;
    }
    calls.push({ line: lineNumber, target, callerSymbolLocalId });
  }
  return calls;
}

export function parseTextFallback(
  path: string,
  source: string,
  diagnostic?: ParsedSourceFile["diagnostic"]
): ParsedSourceFile {
  const content = normalizeSourceText(source);
  const selection = selectLanguage(path);
  const lines = content ? content.split("\n") : [];
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const calls: ParsedCall[] = [];
  let currentSymbolLocalId: string | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (selection.language !== "text") {
      const patterns = fallbackPatterns[selection.language];
      for (const candidate of patterns) {
        const match = line.match(candidate.pattern);
        if (!match?.[1]) continue;
        const name = match[1];
        const localId = `fallback:${lineNumber}:${candidate.kind}:${name}`;
        const endLine = Math.min(lines.length, lineNumber + 11);
        symbols.push({
          localId,
          name,
          qualifiedName: name,
          kind: candidate.kind,
          line: lineNumber,
          endLine,
          content: bounded(lines.slice(Math.max(0, index - 1), endLine).join("\n"))
        });
        currentSymbolLocalId = localId;
        break;
      }
    }
    imports.push(...fallbackImports(selection.language, line, lineNumber));
    calls.push(...fallbackCalls(line, lineNumber, currentSymbolLocalId));
  });

  return {
    path,
    language: selection.language,
    parser: "text-fallback",
    parserId: "guardianbot-text-fallback-v2",
    contentSha256: sha256(content),
    lineCount: lines.length,
    symbols,
    imports,
    calls,
    diagnostic: diagnostic ?? (selection.grammar ? "parser-unavailable" : "unsupported-language")
  };
}

export class TreeSitterSourceParser implements RepositorySourceParser {
  readonly id = "web-tree-sitter-0.26.11/repomix-grammars-0.1.17";

  async parse(path: string, source: string): Promise<ParsedSourceFile> {
    const content = normalizeSourceText(source);
    const selection = selectLanguage(path);
    if (!selection.grammar) {
      return parseTextFallback(path, content, "unsupported-language");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_TREE_SITTER_SOURCE_BYTES) {
      return parseTextFallback(path, content, "file-too-large");
    }

    let parser: Parser | undefined;
    let tree: ReturnType<Parser["parse"]> | undefined;
    try {
      const language = await loadLanguage(selection.grammar);
      parser = new Parser();
      parser.setLanguage(language);
      tree = parser.parse(content);
      if (!tree) {
        return parseTextFallback(path, content, "parser-unavailable");
      }
      return parseSyntaxTree(path, content, selection.language, tree.rootNode, this.id);
    } catch {
      return parseTextFallback(path, content, "parser-unavailable");
    } finally {
      tree?.delete();
      parser?.delete();
    }
  }
}
