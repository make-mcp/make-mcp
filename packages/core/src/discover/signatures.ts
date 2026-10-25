import { posix } from "node:path";
import type { Workspace } from "../fs/workspace.js";
import type { ApiSymbol } from "../ir/index.js";
import { findDistInfo } from "./python-packages.js";

/**
 * API signatures for `get_signature`, read from the package installed in the user's project – so they match the
 * exact version without any download: `.d.ts` files for npm packages (or `@types/*`), stubs and sources for Python.
 * Nothing here executes package code; files are only read and scanned.
 */

const MAX_FILES = 300;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SYMBOLS = 3000;
const MAX_SIGNATURE = 4000;
const MAX_DOC = 1200;

export interface SignatureTarget {
  registry: "npm" | "pypi";
  packageName: string;
  version: string;
}

export interface SignatureResult {
  symbols: ApiSymbol[];
  /** Where the signatures came from, e.g. "node_modules/@types/react". */
  source?: string;
  /** Why there are none (other version, no type declarations). */
  note?: string;
  /** False when the package is not installed in the workspace at all (nothing worth telling the user). */
  installed: boolean;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\n… (truncated)` : value);

function cleanJsDoc(raw: string): string | undefined {
  const text = raw
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
  return text ? clip(text, MAX_DOC) : undefined;
}

// ---------------------------------------------------------------------------
// TypeScript declarations
// ---------------------------------------------------------------------------

/** Declarations whose `{ … }` is their body (as opposed to object types in signatures). */
const BLOCK_KEYWORD = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|namespace|module|enum|const\s+enum|global)\b/;
const NEXT_STATEMENT = /^(?:(?:export|declare|import|interface|type|function|class|const|let|var|namespace|module|enum|abstract)\b|\/\*\*|\/\/|@|\})/;
const CONTINUES = /(?:[=|&,(<:?]|=>|\bextends|\bkeyof)\s*$/;

/** Index just past the statement starting at `start` (handles nesting, generics, strings, comments, missing semicolons). */
function statementEnd(text: string, start: number): number {
  const block = BLOCK_KEYWORD.test(text.slice(start, start + 300));
  let depth = 0;
  let angle = 0;
  let body = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "<") angle++;
    else if (ch === ">" && text[i - 1] !== "=" && angle > 0) angle--;
    else if (ch === "{" || ch === "(" || ch === "[") {
      // The first top-level brace of a class/interface/namespace/enum opens its body; generics may hold object types.
      if (ch === "{" && block && depth === 0 && angle === 0) body = true;
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0 && ch === "}" && body) return i + 1;
      if (depth < 0) return i;
    } else if (depth === 0 && ch === ";") return i + 1;
    else if (depth === 0 && ch === "\n") {
      const rest = text.slice(i + 1).trimStart();
      if (NEXT_STATEMENT.test(rest) && !CONTINUES.test(text.slice(start, i))) return i;
    }
  }
  return text.length;
}

const DECLARATION =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|const\s+enum|enum|const|let|var|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const NAMESPACE = /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*|["'][^"']+["'])\s*\{/;

function declaration(statement: string, name: string, module: string, doc: string | undefined): ApiSymbol | undefined {
  const match = DECLARATION.exec(statement);
  if (!match) return undefined;
  const keyword = match[2]!.replace(/\s+/g, " ");
  const kind: ApiSymbol["kind"] =
    keyword === "const" || keyword === "let" || keyword === "var"
      ? "variable"
      : keyword === "const enum"
        ? "enum"
        : keyword === "module"
          ? "namespace"
          : (keyword as ApiSymbol["kind"]);
  const signature = statement.replace(/^export\s+(?:default\s+)?/, "").replace(/^declare\s+/, "");
  return { name, kind, module, signature: clip(signature, MAX_SIGNATURE), ...(doc ? { doc } : {}) };
}

/** Names a file exports without an `export` keyword on the declaration: `export { a, b as c }`, `export = ns`. */
function exportedNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const list of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of list[1]!.split(",")) {
      const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (m) names.set(m[1]!, m[2] ?? m[1]!);
    }
  }
  for (const m of text.matchAll(/\bexport\s*=\s*([A-Za-z_$][\w$]*)/g)) names.set(m[1]!, m[1]!);
  for (const m of text.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/g)) names.set(m[1]!, m[1]!);
  return names;
}

/**
 * Declarations of one `.d.ts` file. Top level: only what the file exports (all of it in ambient files without exports).
 * Namespaces (`declare namespace React { … }`, `export = React`) are scanned too; their members become `React.useState`.
 */
export function scanTypeDeclarations(text: string, module: string, prefix = ""): ApiSymbol[] {
  const exported = prefix ? undefined : exportedNames(text);
  const ambient = !prefix && !/^\s*export\b/m.test(text);
  const symbols: ApiSymbol[] = [];
  let doc: string | undefined;
  for (let i = 0; i < text.length; ) {
    if (/\s/.test(text[i]!)) {
      i++;
    } else if (text.startsWith("/**", i)) {
      const end = text.indexOf("*/", i + 3);
      doc = cleanJsDoc(text.slice(i + 3, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else {
      const end = Math.max(statementEnd(text, i), i + 1);
      const statement = text.slice(i, end).trim();
      const isExported = /^export\b/.test(statement);
      const ns = NAMESPACE.exec(statement);
      if (ns) {
        const body = statement.slice(statement.indexOf("{") + 1, statement.lastIndexOf("}"));
        if (/^["']/.test(ns[1]!)) {
          // `declare module "pkg" { … }`: its members are the module's exports.
          symbols.push(...scanTypeDeclarations(body, module, prefix || " ").map((s) => ({ ...s, name: s.name.trimStart() })));
        } else {
          const local = ns[1]!;
          const name = prefix + (exported?.get(local) ?? local);
          if ((prefix || isExported || ambient || exported?.has(local)) && !local.startsWith("_")) {
            const members = scanTypeDeclarations(body, module, `${name}.`);
            symbols.push({ name, kind: "namespace", module, signature: `namespace ${name} { … ${members.length} members }`, ...(doc ? { doc } : {}) });
            symbols.push(...members);
          }
        }
      } else {
        const local = DECLARATION.exec(statement)?.[3];
        if (local && !local.startsWith("_") && (prefix || isExported || ambient || exported?.has(local))) {
          const symbol = declaration(statement, prefix.trimStart() + (exported?.get(local) ?? local), module, doc);
          if (symbol) symbols.push(symbol);
        }
      }
      doc = undefined;
      i = end;
    }
  }
  return symbols;
}

interface PackageJson {
  version?: string;
  types?: string;
  typings?: string;
  main?: string;
  exports?: unknown;
}

const DTS = /\.d\.[mc]?ts$/;

/** The `types` file an `exports` entry points to, following nested conditions. */
function exportsTypes(value: unknown): string | undefined {
  if (typeof value === "string") return DTS.test(value) ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.types === "string") return record.types;
  for (const [key, nested] of Object.entries(record)) {
    if (key === "." || !key.startsWith(".")) {
      const found = exportsTypes(nested);
      if (found) return found;
    }
  }
  return undefined;
}

function typesEntry(pkg: PackageJson, exists: (rel: string) => boolean): string | undefined {
  const declared = pkg.types ?? pkg.typings ?? exportsTypes(pkg.exports);
  const candidates = [declared, pkg.main?.replace(/\.(m|c)?js$/, ".d.$1ts"), "index.d.ts"].filter(
    (c): c is string => typeof c === "string" && DTS.test(c),
  );
  return candidates.map((c) => posix.normalize(c)).find((c) => !c.startsWith("..") && exists(c));
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\/\/\/\s*<reference\s+path=)["'](\.{1,2}\/[^"']+)["']/g;

function resolveRelative(from: string, spec: string, exists: (rel: string) => boolean): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (base.startsWith("..")) return undefined;
  const candidates = DTS.test(base)
    ? [base]
    : [base.replace(/\.(m|c)?js$/, ".d.$1ts"), `${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`, `${base}/index.d.ts`];
  return candidates.find(exists);
}

/** Merges overloads and merged declarations (same name, kind and file) into one entry. */
function mergeOverloads(symbols: ApiSymbol[]): ApiSymbol[] {
  const byKey = new Map<string, ApiSymbol>();
  for (const symbol of symbols) {
    const key = `${symbol.module}\u0000${symbol.kind}\u0000${symbol.name}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, symbol);
    else if (existing.signature.length < MAX_SIGNATURE) {
      byKey.set(key, {
        ...existing,
        signature: clip(`${existing.signature}\n${symbol.signature}`, MAX_SIGNATURE),
        ...(existing.doc || !symbol.doc ? {} : { doc: symbol.doc }),
      });
    }
  }
  return [...byKey.values()];
}

function crawlDeclarations(ws: Workspace, root: string, entry: string): ApiSymbol[] {
  const exists = (rel: string) => ws.exists(`${root}/${rel}`);
  const queue = [entry];
  const seen = new Set(queue);
  const symbols: ApiSymbol[] = [];
  while (queue.length > 0 && seen.size <= MAX_FILES && symbols.length < MAX_SYMBOLS) {
    const file = queue.shift()!;
    const text = ws.readText(`${root}/${file}`);
    if (!text || text.length > MAX_FILE_BYTES) continue;
    symbols.push(...scanTypeDeclarations(text, file));
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const next = resolveRelative(file, match[1]!, exists);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return mergeOverloads(symbols).slice(0, MAX_SYMBOLS);
}

function npmSignatures(ws: Workspace, target: SignatureTarget): SignatureResult {
  const root = `node_modules/${target.packageName}`;
  const pkg = ws.readJson<PackageJson>(`${root}/package.json`);
  if (!pkg) return { symbols: [], installed: false };
  if (pkg.version !== target.version) {
    return { symbols: [], installed: true, note: `node_modules has ${target.packageName} ${pkg.version ?? "?"}, not ${target.version} – API signatures skipped.` };
  }
  const own = typesEntry(pkg, (rel) => ws.exists(`${root}/${rel}`));
  if (own) return { symbols: crawlDeclarations(ws, root, own), source: root, installed: true };

  // Packages without bundled types: DefinitelyTyped (`@scope/name` → `@types/scope__name`).
  const typesRoot = `node_modules/@types/${target.packageName.replace(/^@/, "").replace("/", "__")}`;
  const typesPkg = ws.readJson<PackageJson>(`${typesRoot}/package.json`);
  const typesFile = typesPkg ? typesEntry(typesPkg, (rel) => ws.exists(`${typesRoot}/${rel}`)) : undefined;
  if (typesFile) return { symbols: crawlDeclarations(ws, typesRoot, typesFile), source: typesRoot, installed: true };
  return { symbols: [], installed: true, note: `${target.packageName} ships no TypeScript declarations – no API signatures.` };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const indentOf = (line: string) => line.length - line.trimStart().length;
const PY_DEF = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/;

/** The `def …:` / `class …:` header starting at `start`, which may span several lines and end in a one-line body. */
function pythonHeader(lines: string[], start: number): { text: string; next: number } {
  let depth = 0;
  const parts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const code = lines[i]!.replace(/#.*$/, "");
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]!;
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (ch === ":" && depth <= 0) {
        // The colon outside brackets ends the header (annotations and defaults sit inside the parentheses).
        parts.push(code.slice(0, c));
        const text = parts
          .map((l) => l.trim())
          .join(" ")
          .replace(/\(\s+/g, "(")
          .replace(/,\s*\)/g, ")")
          .trim();
        return { text, next: i + 1 };
      }
    }
    parts.push(code);
  }
  return { text: lines[start]!.trim(), next: start + 1 };
}

/** First paragraph of the docstring right after a header, if any. */
function pythonDocstring(lines: string[], from: number): string | undefined {
  let i = from;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const first = lines[i]?.trim() ?? "";
  const open = /^[rRuUbB]?("""|''')/.exec(first);
  if (!open) return undefined;
  const quote = open[1]!;
  const body: string[] = [];
  let rest = first.slice(open[0].length);
  for (;;) {
    const close = rest.indexOf(quote);
    if (close >= 0) {
      body.push(rest.slice(0, close));
      break;
    }
    body.push(rest);
    i++;
    if (i >= lines.length) break;
    rest = lines[i]!.trim();
  }
  const paragraph = body.join("\n").trim().split(/\n\s*\n/)[0]?.trim();
  return paragraph ? clip(paragraph, MAX_DOC) : undefined;
}

const publicName = (name: string) => !name.startsWith("_") || name === "__init__" || name === "__call__";

/** Module-level functions and classes (with their public methods) of one Python file. */
export function scanPythonSource(text: string, module: string): ApiSymbol[] {
  const lines = text.split("\n");
  const symbols: ApiSymbol[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const match = indentOf(line) === 0 ? PY_DEF.exec(line) : null;
    if (!match) {
      i++;
      continue;
    }
    const name = match[2]!;
    const header = pythonHeader(lines, i);
    const isClass = match[1] === "class";
    let end = header.next;
    while (end < lines.length && (!lines[end]!.trim() || indentOf(lines[end]!) > 0 || lines[end]!.trimStart().startsWith("#"))) end++;

    if (!name.startsWith("_")) {
      const doc = pythonDocstring(lines, header.next);
      symbols.push({ name, kind: isClass ? "class" : "function", module, signature: clip(header.text, MAX_SIGNATURE), ...(doc ? { doc } : {}) });
      if (isClass) {
        const firstMethod = lines.slice(header.next, end).find((l) => /^\s+(async\s+)?def\s/.test(l));
        const indent = firstMethod ? indentOf(firstMethod) : -1;
        for (let j = header.next; j < end; j++) {
          const m = indentOf(lines[j]!) === indent ? /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lines[j]!) : null;
          if (!m || !publicName(m[1]!)) continue;
          const methodHeader = pythonHeader(lines, j);
          const methodDoc = pythonDocstring(lines, methodHeader.next);
          symbols.push({
            name: `${name}.${m[1]}`,
            kind: "method",
            module,
            signature: clip(methodHeader.text, MAX_SIGNATURE),
            ...(methodDoc ? { doc: methodDoc } : {}),
          });
          j = methodHeader.next - 1;
        }
      }
    }
    i = end;
  }
  return symbols;
}

const SKIPPED_PART = /(^|\/)(tests?|__pycache__)(\/|$)/;
const PRIVATE_MODULE = /(^|\/)_(?!_init__\.pyi?$)[^/]*/;

/** What a package's `__init__` files re-export: `from ._client import Client as C`, `__all__`, `from ._x import *`. */
function pythonReexports(inits: string[]): { names: Map<string, string>; starModules: Set<string> } {
  const names = new Map<string, string>();
  const starModules = new Set<string>();
  for (const text of inits) {
    for (const m of text.matchAll(/^from\s+\.([\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      const list = m[2]!.replace(/[()\\]/g, " ").replace(/#.*$/gm, "");
      if (list.trim() === "*") starModules.add(m[1]!.split(".").pop()!);
      for (const part of list.split(",")) {
        const item = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
        if (item) names.set(item[1]!, item[2] ?? item[1]!);
      }
    }
    for (const all of text.matchAll(/__all__\s*(?::[^=]*)?[+]?=\s*[[(]([^\])]*)[\])]/g)) {
      for (const name of all[1]!.matchAll(/["']([A-Za-z_]\w*)["']/g)) if (!names.has(name[1]!)) names.set(name[1]!, name[1]!);
    }
  }
  return { names, starModules };
}

function pythonSignatures(ws: Workspace, target: SignatureTarget): SignatureResult {
  const dist = findDistInfo(ws, target.packageName);
  if (!dist) return { symbols: [], installed: false };
  if (dist.version !== target.version) {
    return { symbols: [], installed: true, note: `The virtualenv has ${target.packageName} ${dist.version}, not ${target.version} – API signatures skipped.` };
  }
  const record = ws.readText(`${dist.sitePackages}/${dist.distInfo}/RECORD`) ?? "";
  const files = record
    .split("\n")
    .map((line) => line.split(",")[0]!.trim())
    .filter((file) => /\.pyi?$/.test(file) && !file.startsWith("..") && !file.includes(".dist-info/") && !SKIPPED_PART.test(file));
  const stubs = new Set(files.filter((f) => f.endsWith(".pyi")).map((f) => f.slice(0, -1)));
  const chosen = files.filter((f) => !stubs.has(f)).slice(0, MAX_FILES);
  const read = (file: string) => {
    const text = ws.readText(`${dist.sitePackages}/${file}`);
    return text && text.length <= MAX_FILE_BYTES ? text : undefined;
  };
  // Many packages implement their API in private modules (httpx/_client.py) and re-export it from __init__.
  const reexports = pythonReexports(chosen.filter((f) => /__init__\.pyi?$/.test(f)).map((f) => read(f) ?? ""));

  const symbols: ApiSymbol[] = [];
  for (const file of chosen) {
    if (symbols.length >= MAX_SYMBOLS) break;
    const text = read(file);
    if (!text) continue;
    const module = file.replace(/\.pyi?$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
    const isPrivate = PRIVATE_MODULE.test(file);
    const star = reexports.starModules.has(module.split(".").pop()!);
    for (const symbol of scanPythonSource(text, module)) {
      if (!isPrivate || star) {
        symbols.push(symbol);
        continue;
      }
      const [owner, ...rest] = symbol.name.split(".");
      const alias = reexports.names.get(owner!);
      if (alias) symbols.push({ ...symbol, name: [alias, ...rest].join(".") });
    }
  }
  const merged = mergeOverloads(symbols).slice(0, MAX_SYMBOLS);
  return merged.length
    ? { symbols: merged, source: `${dist.sitePackages}/${dist.distInfo}`, installed: true }
    : { symbols: [], installed: true, note: `No public Python API found in ${target.packageName} ${target.version}.` };
}

/** Signatures of the installed package, or a note why there are none. Never throws for missing files. */
export function readSignatures(ws: Workspace, target: SignatureTarget): SignatureResult {
  try {
    return target.registry === "npm" ? npmSignatures(ws, target) : pythonSignatures(ws, target);
  } catch (err) {
    return { symbols: [], installed: true, note: `Could not read API signatures of ${target.packageName}: ${(err as Error).message}` };
  }
}
