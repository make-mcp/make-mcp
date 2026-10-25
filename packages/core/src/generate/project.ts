import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { strToU8, zipSync } from "fflate";
import { MakeMcpError } from "../errors.js";
import { VERSION } from "../version.js";
import type { Fetcher } from "../fetch/types.js";
import { readSignatures } from "../discover/signatures.js";
import { createWorkspace, type Workspace } from "../fs/workspace.js";
import type { ResolvedIntake, ResolvedLibrary, ToolMode } from "../intake/types.js";
import type { ApiSpec, ApiSymbol, AuthScheme, DocCorpus, SourceRef } from "../ir/index.js";
import { contentModeFor, type ContentMode } from "../license.js";
import { loadChangesResult, type ChangesResult } from "../parse/changes.js";
import { loadDocCorpus, type DocsSource } from "../parse/docs-corpus.js";
import { parseRepoUrl } from "../parse/repo-docs.js";
import { applyRequestedVersion, openApiToSpec, parseApiDocument } from "../parse/openapi.js";
import { extractionToSpec, planExtraction, validateExtraction, type ExtractionPlan, type ExtractionResult, type ValidatedExtraction } from "../extract/prose-api.js";

export const GENERATOR_PACKAGE = "@make-mcp/cli";
export const GENERATOR_VERSION = VERSION;
const TOOL_WARNING_THRESHOLD = 80;
/** Above this many operations the API is exposed through list/describe/call meta tools. */
export const GROUP_THRESHOLD = 40;
export const GROUPED_TOOLS = ["list_operations", "describe_operation", "call_operation"] as const;

const templatesDir = fileURLToPath(new URL("../../templates/", import.meta.url));
const eta = new Eta({ views: templatesDir, autoEscape: false, autoTrim: false });

export interface GenerateOptions {
  apiFetcher: Fetcher;
  contentFetcher: Fetcher;
  /** Directory relative outDirs resolve against (the user's workspace). */
  workspaceRoot: string;
  now?: () => Date;
  /** API spec extracted from prose docs (required when resolved.apiSource is "docs"). */
  extractedApi?: ApiSpec;
  /** Already loaded documentation, e.g. from the extraction step, to avoid fetching twice. */
  corpus?: DocCorpus;
}

/** Where `refresh` re-reads release notes for servers that do not embed their docs. */
export interface ChangesSource {
  repository: string;
  packageName?: string;
}

/** One library of a whole-project server. Its docs live in data/corpus/<name>.json or the user cache. */
export interface LibraryManifest {
  name: string;
  title: string;
  version: string;
  license?: string;
  contentMode: ContentMode;
  sources: SourceRef[];
  candidates: DocsSource[];
  changes?: ChangesSource;
}

export interface Manifest {
  name: string;
  title: string;
  targetVersion: string;
  envPrefix: string;
  transport: "stdio" | "http";
  license?: string;
  generator: string;
  generatedAt: string;
  docs?: { contentMode: ContentMode; sources: SourceRef[]; candidates: DocsSource[]; changes?: ChangesSource };
  /** Whole-project server: several libraries instead of `docs`. */
  libraries?: LibraryManifest[];
  /** data/symbols.json holds API signatures (`{ [library]: ApiSymbol[] }`). */
  symbols?: boolean;
  api?: boolean;
  toolMode?: ToolMode;
}

/** The libraries a server serves docs for – one for a single-target server. */
export function manifestLibraries(manifest: Manifest): LibraryManifest[] {
  if (manifest.libraries) return manifest.libraries;
  if (!manifest.docs) return [];
  return [
    {
      name: manifest.name,
      title: manifest.title,
      version: manifest.targetVersion,
      ...(manifest.license ? { license: manifest.license } : {}),
      contentMode: manifest.docs.contentMode,
      sources: manifest.docs.sources,
      candidates: manifest.docs.candidates,
      ...(manifest.docs.changes ? { changes: manifest.docs.changes } : {}),
    },
  ];
}

/** True when some documentation has to be downloaded on the user's machine before the server can answer. */
export function needsRefresh(manifest: Manifest): boolean {
  return manifestLibraries(manifest).some((lib) => lib.contentMode === "fetch-on-install");
}

export interface EnvVar {
  name: string;
  description: string;
  /** Credentials; optional overrides such as base URL are not secret. */
  secret: boolean;
  /** Must be set even though it is not a credential (e.g. a base URL the docs do not state). */
  required?: boolean;
}

export interface GeneratedProject {
  outDir: string;
  files: Record<string, string>;
  manifest: Manifest;
  tools: string[];
  pageCount: number;
  endpointCount: number;
  /** Release notes across all libraries (changes_since). */
  changeCount: number;
  /** API signatures across all libraries (get_signature). */
  symbolCount: number;
  run: { command: string; args: string[] };
  envVars: EnvVar[];
  warnings: string[];
}

/** Root of make-mcp's user cache (docs downloads, servers built by `make-mcp run`). */
export function cacheRoot(): string {
  return process.env.MAKE_MCP_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "make-mcp");
}

/** Cache location shared with the generated servers (keep in sync with the templates). */
export function corpusCachePath(name: string, version: string): string {
  return insideCache(join(cacheRoot(), name, version, "corpus.json"));
}

/** Defence in depth: names and versions are validated upstream, but nothing may ever resolve outside the cache. */
export function insideCache(path: string): string {
  const root = resolve(cacheRoot());
  const full = resolve(path);
  if (!full.startsWith(root + sep)) throw new MakeMcpError("PATH_OUTSIDE_WORKSPACE", `Refusing cache path outside ${root}: ${full}`);
  return full;
}

function envVarsFor(spec: ApiSpec | undefined, envPrefix: string): EnvVar[] {
  if (!spec) return [];
  const vars: EnvVar[] = [];
  for (const scheme of spec.auth) {
    if (scheme.type === "apiKey") vars.push({ name: scheme.envVar, description: `API key, sent as ${scheme.in} "${scheme.name}"`, secret: true });
    if (scheme.type === "bearer") vars.push({ name: scheme.envVar, description: "Bearer token", secret: true });
    if (scheme.type === "basic") {
      vars.push(
        { name: scheme.userEnvVar, description: "Basic auth user", secret: true },
        { name: scheme.passwordEnvVar, description: "Basic auth password", secret: true },
      );
    }
    if (scheme.type === "oauth2") {
      vars.push({ name: scheme.tokenEnvVar, description: "OAuth2 access token (alternative to client credentials)", secret: true });
      if (scheme.tokenUrl) {
        vars.push(
          { name: scheme.clientIdEnvVar, description: `OAuth2 client id (client credentials via ${scheme.tokenUrl})`, secret: true },
          { name: scheme.clientSecretEnvVar, description: "OAuth2 client secret", secret: true },
        );
      }
    }
  }
  vars.push(
    spec.baseUrl
      ? { name: `${envPrefix}_BASE_URL`, description: `Override the base URL (default ${spec.baseUrl})`, secret: false }
      : { name: `${envPrefix}_BASE_URL`, description: "Base URL of the API (required – the documentation does not state it)", secret: false, required: true },
  );
  if (spec.versionStrategy.type !== "none") {
    vars.push({ name: `${envPrefix}_API_VERSION`, description: `API version (default ${spec.versionStrategy.default})`, secret: false });
  }
  return vars;
}

function fallbackAuth(auth: ResolvedIntake["auth"], envPrefix: string): AuthScheme[] {
  switch (auth) {
    case "apiKey":
      return [{ type: "apiKey", in: "header", name: "X-API-Key", envVar: `${envPrefix}_API_KEY` }];
    case "bearer":
      return [{ type: "bearer", envVar: `${envPrefix}_TOKEN` }];
    case "basic":
      return [{ type: "basic", userEnvVar: `${envPrefix}_USERNAME`, passwordEnvVar: `${envPrefix}_PASSWORD` }];
    case "oauth2":
      return [
        {
          type: "oauth2",
          scopes: [],
          tokenEnvVar: `${envPrefix}_ACCESS_TOKEN`,
          clientIdEnvVar: `${envPrefix}_CLIENT_ID`,
          clientSecretEnvVar: `${envPrefix}_CLIENT_SECRET`,
        },
      ];
    default:
      return [];
  }
}

async function loadOpenApiSpec(url: string, resolved: ResolvedIntake, options: GenerateOptions): Promise<ApiSpec> {
  const res = await options.contentFetcher(url, { accept: "application/json,application/yaml,text/yaml" });
  if (!res.ok) throw new MakeMcpError("SOURCE_NOT_FOUND", `Could not load ${url} (HTTP ${res.status})`);
  return openApiToSpec(parseApiDocument(res.body), {
    sourceUrl: res.url,
    envPrefix: resolved.envPrefix,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
  });
}

async function buildApiSpec(resolved: ResolvedIntake, options: GenerateOptions, warnings: string[]): Promise<ApiSpec | undefined> {
  let spec: ApiSpec;
  if (resolved.apiSource === "docs") {
    if (!options.extractedApi) {
      throw new MakeMcpError(
        "INTAKE_INCOMPLETE",
        "The API has to be extracted from the documentation first (agent: extract_api + submit_extraction; CLI: configure an LLM).",
      );
    }
    if (options.extractedApi.endpoints.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", "No API operations could be extracted from the documentation.");
    spec = options.extractedApi;
    if (!spec.baseUrl) warnings.push(`The documentation does not state a base URL – set ${resolved.envPrefix}_BASE_URL before using the API tools.`);
  } else if (resolved.openapiUrl) {
    spec = await loadOpenApiSpec(resolved.openapiUrl, resolved, options);
  } else {
    return undefined;
  }

  if (resolved.apiSource !== "docs" && resolved.version !== "latest" && resolved.version !== spec.specVersion) {
    const applied = applyRequestedVersion(spec, resolved.version);
    spec = applied.spec;
    if (!applied.applied && spec.versionStrategy.type !== "none") {
      warnings.push(`Version ${resolved.version} does not match the API's versioning (${spec.versionStrategy.default}); kept the spec default.`);
    }
  }
  if (resolved.scopeTags) {
    const tags = resolved.scopeTags.map((t) => t.toLowerCase());
    spec = { ...spec, endpoints: spec.endpoints.filter((ep) => ep.tags.some((t) => tags.includes(t.toLowerCase()))) };
  }
  if (spec.auth.length === 0 && resolved.auth !== "none") spec = { ...spec, auth: fallbackAuth(resolved.auth, resolved.envPrefix) };
  return spec;
}

async function loadCorpus(
  sources: DocsSource[],
  lib: Pick<ResolvedLibrary, "title" | "version" | "license">,
  options: Pick<GenerateOptions, "apiFetcher" | "contentFetcher" | "now">,
): Promise<DocCorpus> {
  const corpus = await loadDocCorpus(sources, {
    contentFetcher: options.contentFetcher,
    apiFetcher: options.apiFetcher,
    title: lib.title,
    version: lib.version,
    ...(lib.license ? { license: lib.license } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (corpus.pages.length === 0) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `None of the documentation sources yielded pages: ${sources.map((d) => d.url).join(", ")}`);
  }
  return corpus;
}

function changesSourceOf(lib: Pick<ResolvedLibrary, "repositoryUrl" | "packageName">): ChangesSource | undefined {
  return lib.repositoryUrl && parseRepoUrl(lib.repositoryUrl)
    ? { repository: lib.repositoryUrl, ...(lib.packageName ? { packageName: lib.packageName } : {}) }
    : undefined;
}

async function changesFor(source: ChangesSource | undefined, version: string, fetcher: Fetcher): Promise<ChangesResult> {
  const repo = source ? parseRepoUrl(source.repository) : undefined;
  if (!repo) return { entries: [], rateLimited: false };
  return loadChangesResult(repo, source?.packageName, fetcher, version === "latest" ? {} : { version }).catch(() => ({ entries: [], rateLimited: false }));
}

const rateLimitWarning = (title: string) =>
  `${title}: the GitHub API rate limit was reached, so its release notes are missing – set GITHUB_TOKEN (or GH_TOKEN) and generate again.`;

interface LoadedLibrary {
  lib: ResolvedLibrary;
  corpus: DocCorpus;
  contentMode: ContentMode;
  symbols: ApiSymbol[];
  changes?: ChangesSource;
}

/** Docs, release notes and (from the installed package) API signatures of one library. */
async function loadLibrary(
  lib: ResolvedLibrary,
  options: GenerateOptions,
  ws: Workspace | undefined,
  warnings: string[],
  preloaded?: DocCorpus,
): Promise<LoadedLibrary> {
  const changes = changesSourceOf(lib);
  const [corpus, { entries, rateLimited }] = await Promise.all([
    preloaded && preloaded.pages.length > 0 ? preloaded : loadCorpus(lib.docs, lib, options),
    changesFor(changes, lib.version, options.apiFetcher),
  ]);
  if (rateLimited) warnings.push(rateLimitWarning(lib.title));
  const contentMode = contentModeFor(lib.license);
  let symbols: ApiSymbol[] = [];
  if (ws && lib.packageName && lib.registry && lib.version !== "latest") {
    const read = readSignatures(ws, { registry: lib.registry, packageName: lib.packageName, version: lib.version });
    if (read.note) warnings.push(read.note);
    if (read.symbols.length && contentMode !== "embedded") {
      warnings.push(`${lib.title}: API signatures are not embedded – the license "${lib.license ?? "unknown"}" does not clearly permit redistribution.`);
    } else symbols = read.symbols;
  }
  return {
    lib,
    corpus: entries.length ? { ...corpus, changes: entries } : corpus,
    contentMode,
    symbols,
    ...(changes ? { changes } : {}),
  };
}

const LIBRARY_CONCURRENCY = 3;

/** Whole-project servers: libraries whose docs cannot be loaded are left out with a warning. */
async function loadLibraries(libraries: ResolvedLibrary[], options: GenerateOptions, ws: Workspace | undefined, warnings: string[]): Promise<LoadedLibrary[]> {
  const loaded: (LoadedLibrary | undefined)[] = new Array(libraries.length);
  let next = 0;
  const worker = async () => {
    while (next < libraries.length) {
      const i = next++;
      const lib = libraries[i]!;
      loaded[i] = await loadLibrary(lib, options, ws, warnings).catch((err: unknown) => {
        warnings.push(`${lib.title}: left out – ${(err as Error).message}`);
        return undefined;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIBRARY_CONCURRENCY, libraries.length) }, worker));
  const ok = loaded.filter((l): l is LoadedLibrary => l !== undefined);
  if (ok.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", "None of the project's libraries yielded documentation.");
  return ok;
}

function sourceWorkspace(resolved: ResolvedIntake): Workspace | undefined {
  try {
    return resolved.sourceRoot ? createWorkspace(resolved.sourceRoot) : undefined;
  } catch {
    return undefined;
  }
}

export interface ExtractionStart {
  corpus: DocCorpus;
  plan: ExtractionPlan;
}

/** Loads the documentation for an API extraction and batches the pages that look like API reference. */
export async function startExtraction(resolved: ResolvedIntake, options: Pick<GenerateOptions, "apiFetcher" | "contentFetcher" | "now">): Promise<ExtractionStart> {
  const sources = resolved.extractionDocs ?? resolved.docs;
  if (sources.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", "No documentation to extract the API from.");
  const corpus = await loadCorpus(sources, { title: resolved.target, version: resolved.version, ...(resolved.license ? { license: resolved.license } : {}) }, options);
  const plan = planExtraction(corpus);
  if (plan.tasks.length === 0) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `The documentation (${corpus.pages.length} pages) does not look like it documents an HTTP API.`);
  }
  return { corpus, plan };
}

/** Validates model output against the documentation and builds the API spec for generateProject. */
export function finishExtraction(
  resolved: ResolvedIntake,
  corpus: DocCorpus,
  results: ExtractionResult[],
  now: () => Date = () => new Date(),
): { spec: ApiSpec; validated: ValidatedExtraction } {
  const validated = validateExtraction(results, corpus);
  const spec = extractionToSpec(validated, corpus, {
    title: resolved.target,
    version: resolved.version,
    envPrefix: resolved.envPrefix,
    fetchedAt: now().toISOString(),
  });
  return { spec, validated };
}

/**
 * Inside the Docker image the workspace is mounted at /workspace; MAKE_MCP_HOST_WORKSPACE (the host path of that
 * mount) turns container paths in run commands and registrations into paths that work on the host.
 */
export function hostPath(path: string, workspaceRoot: string): string {
  const host = process.env.MAKE_MCP_HOST_WORKSPACE;
  if (!host) return path;
  const rel = relative(workspaceRoot, path);
  return rel.startsWith("..") || isAbsolute(rel) ? path : join(host, rel);
}

function runCommand(language: "ts" | "py", outDir: string): { command: string; args: string[] } {
  return language === "ts"
    ? { command: "node", args: [join(outDir, "dist", "index.js")] }
    : { command: "uv", args: ["run", "--directory", outDir, "server.py"] };
}

/** Collapses blank-line runs left behind by template conditionals. */
function tidy(markdown: string): string {
  return `${markdown.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function packageJson(resolved: ResolvedIntake, refreshNeeded: boolean): string {
  const refresh = `npx -y ${GENERATOR_PACKAGE}@${GENERATOR_VERSION} refresh .`;
  return `${JSON.stringify(
    {
      name: `${resolved.slug}-mcp`,
      version: "0.1.0",
      private: true,
      description: `${resolved.target} MCP server generated by make-mcp`,
      type: "module",
      bin: { [`${resolved.slug}-mcp`]: "./dist/index.js" },
      engines: { node: ">=22.18" },
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
        dev: "node src/index.ts",
        ...(refreshNeeded ? { refresh, postinstall: `${refresh} --if-missing` } : {}),
      },
      dependencies: { "@modelcontextprotocol/sdk": "1.32.2", minisearch: "7.2.0" },
      devDependencies: { "@types/node": "^22.0.0", typescript: "5.9.3" },
    },
    null,
    2,
  )}\n`;
}

/** Fetches sources, builds the IR and renders all files in memory. Nothing is written yet. */
export async function generateProject(resolved: ResolvedIntake, options: GenerateOptions): Promise<GeneratedProject> {
  const warnings: string[] = [];
  const now = (options.now ?? (() => new Date()))();
  const outDir = isAbsolute(resolved.outDir) ? resolved.outDir : resolve(options.workspaceRoot, resolved.outDir);
  const ws = sourceWorkspace(resolved);
  const bundle = resolved.libraries !== undefined;
  const single: ResolvedLibrary | undefined =
    !bundle && resolved.docs.length > 0
      ? {
          name: resolved.slug,
          title: resolved.target,
          version: resolved.version,
          ...(resolved.packageName ? { packageName: resolved.packageName } : {}),
          ...(resolved.registry ? { registry: resolved.registry } : {}),
          ...(resolved.license ? { license: resolved.license } : {}),
          docs: resolved.docs,
          ...(resolved.repositoryUrl ? { repositoryUrl: resolved.repositoryUrl } : {}),
        }
      : undefined;

  const [spec, libraries] = await Promise.all([
    buildApiSpec(resolved, options, warnings),
    resolved.libraries
      ? loadLibraries(resolved.libraries, options, ws, warnings)
      : single
        ? loadLibrary(single, options, ws, warnings, options.corpus).then((lib) => [lib])
        : Promise.resolve([]),
  ]);
  for (const lib of libraries) {
    if (lib.contentMode !== "fetch-on-install") continue;
    const message = `icense "${lib.lib.license ?? "unknown"}" does not clearly permit redistribution – docs are not embedded and will be downloaded on first install.`;
    warnings.push(bundle ? `${lib.lib.title}: l${message}` : `L${message}`);
  }

  const toolMode: ToolMode | undefined = spec ? (resolved.toolMode ?? (spec.endpoints.length > GROUP_THRESHOLD ? "grouped" : "endpoints")) : undefined;
  if (spec && toolMode === "endpoints" && spec.endpoints.length > TOOL_WARNING_THRESHOLD) {
    warnings.push(`${spec.endpoints.length} API tools – many clients work better with fewer. Use grouped tools or narrow the scope by tags.`);
  }

  const first = !bundle ? libraries[0] : undefined;
  const symbols = Object.fromEntries(libraries.filter((l) => l.symbols.length > 0).map((l) => [l.lib.name, l.symbols]));
  const manifest: Manifest = {
    name: resolved.slug,
    title: spec?.title && resolved.mode === "api" ? spec.title : resolved.target,
    targetVersion: resolved.version,
    envPrefix: resolved.envPrefix,
    transport: resolved.transport,
    ...(resolved.license ? { license: resolved.license } : {}),
    generator: `${GENERATOR_PACKAGE}@${GENERATOR_VERSION}`,
    generatedAt: now.toISOString(),
    ...(first
      ? { docs: { contentMode: first.contentMode, sources: first.corpus.sources, candidates: resolved.docs, ...(first.changes ? { changes: first.changes } : {}) } }
      : {}),
    ...(bundle
      ? {
          libraries: libraries.map((l) => ({
            name: l.lib.name,
            title: l.lib.title,
            version: l.lib.version,
            ...(l.lib.license ? { license: l.lib.license } : {}),
            contentMode: l.contentMode,
            sources: l.corpus.sources,
            candidates: l.lib.docs,
            ...(l.changes ? { changes: l.changes } : {}),
          })),
        }
      : {}),
    ...(Object.keys(symbols).length ? { symbols: true } : {}),
    ...(spec ? { api: true, toolMode } : {}),
  };

  const envVars = envVarsFor(spec, resolved.envPrefix);
  const run = runCommand(resolved.language, hostPath(outDir, options.workspaceRoot));
  const pages = libraries.flatMap((l) => l.corpus.pages);
  const components = pages.filter((p) => p.kind === "component").length;
  const changeCount = libraries.reduce((n, l) => n + (l.corpus.changes?.length ?? 0), 0);
  const symbolCount = libraries.reduce((n, l) => n + l.symbols.length, 0);
  const refreshNeeded = libraries.some((l) => l.contentMode === "fetch-on-install");
  const tools = [
    ...(libraries.length
      ? [
          "search_docs",
          "get_page",
          "list_topics",
          ...(components ? ["get_component"] : []),
          ...(changeCount ? ["changes_since"] : []),
          ...(symbolCount ? ["get_signature"] : []),
        ]
      : []),
    ...(spec ? (toolMode === "grouped" ? GROUPED_TOOLS : spec.endpoints.map((ep) => ep.id)) : []),
  ];

  const view = {
    name: resolved.slug,
    title: manifest.title,
    target: resolved.target,
    version: resolved.version,
    generatedAt: now.toISOString().slice(0, 10),
    license: resolved.license,
    docs: libraries.length
      ? {
          contentMode: refreshNeeded ? "fetch-on-install" : "embedded",
          sources: libraries.flatMap((l) => l.corpus.sources),
          pageCount: pages.length,
          componentCount: components,
          changeCount,
          symbolCount,
        }
      : undefined,
    libraries: bundle
      ? libraries.map((l) => ({
          name: l.lib.name,
          title: l.lib.title,
          version: l.lib.version,
          license: l.lib.license,
          contentMode: l.contentMode,
          pageCount: l.corpus.pages.length,
          changeCount: l.corpus.changes?.length ?? 0,
          symbolCount: l.symbols.length,
          source: l.corpus.sources[0],
        }))
      : undefined,
    regenerate: bundle ? "." : resolved.target,
    api: spec ? { title: spec.title, baseUrl: spec.baseUrl, endpointCount: spec.endpoints.length, toolMode, extracted: resolved.apiSource === "docs" } : undefined,
    envVars,
    secretVars: envVars.filter((v) => v.secret || v.required),
    run,
    generator: manifest.generator,
    deploy: resolved.deploy === "cloudrun",
    service: `${resolved.slug}-mcp`,
    secrets: envVars.filter((v) => v.secret).map((v) => ({ env: v.name, secret: `${resolved.slug}-mcp-${v.name.toLowerCase().replace(/_/g, "-")}` })),
    plainVars: envVars.filter((v) => !v.secret),
  };

  const lang = resolved.language;
  const files: Record<string, string> = {
    "README.md": tidy(eta.render(`${lang}/README.md.eta`, view)),
    ".gitignore": readFileSync(join(templatesDir, lang, "gitignore"), "utf8"),
    Dockerfile: tidy(eta.render(`${lang}/Dockerfile.eta`, view)),
    "data/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
  if (envVars.length > 0) files[".env.example"] = eta.render("_partials/env.eta", view);
  if (resolved.deploy === "cloudrun") {
    files["deploy/cloudrun/service.yaml"] = tidy(eta.render("cloudrun/service.yaml.eta", view));
    files["skaffold.yaml"] = eta.render("cloudrun/skaffold.yaml.eta", view);
  }
  if (spec) files["data/api.json"] = `${JSON.stringify(spec, null, 2)}\n`;
  for (const lib of libraries) {
    if (lib.contentMode !== "embedded") continue;
    files[bundle ? `data/corpus/${lib.lib.name}.json` : "data/corpus.json"] = `${JSON.stringify(lib.corpus)}\n`;
  }
  if (Object.keys(symbols).length) files["data/symbols.json"] = `${JSON.stringify(symbols)}\n`;

  if (lang === "ts") {
    files["package.json"] = packageJson(resolved, refreshNeeded);
    files["tsconfig.json"] = readFileSync(join(templatesDir, "ts/tsconfig.json"), "utf8");
    files["src/index.ts"] = readFileSync(join(templatesDir, "ts/src/index.ts"), "utf8");
  } else {
    files["pyproject.toml"] = eta.render("py/pyproject.toml.eta", view);
    files["server.py"] = readFileSync(join(templatesDir, "py/server.py"), "utf8");
  }

  return {
    outDir,
    files,
    manifest,
    tools,
    pageCount: pages.length,
    endpointCount: spec?.endpoints.length ?? 0,
    changeCount,
    symbolCount,
    run,
    envVars,
    warnings: [...resolved.notes, ...warnings],
  };
}

/**
 * Writes the project. Refuses to touch a non-empty directory unless it was generated
 * by make-mcp before (data/manifest.json with a generator field).
 */
export function writeProject(project: GeneratedProject): string[] {
  const { outDir } = project;
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    const manifestPath = join(outDir, "data", "manifest.json");
    const ours = existsSync(manifestPath) && /"generator":\s*"(@make-mcp\/cli|make-mcp)@/.test(readFileSync(manifestPath, "utf8"));
    if (!ours) {
      throw new MakeMcpError("OUTPUT_NOT_EMPTY", `${outDir} is not empty and was not generated by make-mcp; choose another outDir.`);
    }
  }
  const written: string[] = [];
  for (const [rel, content] of Object.entries(project.files)) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(rel);
  }
  return written;
}

export function zipProject(project: GeneratedProject): Uint8Array {
  const root = `${project.manifest.name}-mcp`;
  return zipSync(Object.fromEntries(Object.entries(project.files).map(([rel, content]) => [`${root}/${rel}`, strToU8(content)])));
}

export interface RefreshOptions {
  apiFetcher: Fetcher;
  contentFetcher: Fetcher;
  ifMissing?: boolean;
}

/**
 * Downloads docs (and release notes) of every fetch-on-install library on the user's machine into the local cache.
 * A library that fails is reported in `failed`; the call only throws when nothing could be downloaded.
 */
export async function refreshDocs(
  projectDir: string,
  options: RefreshOptions,
): Promise<{ path: string; pages: number; skipped: boolean; libraries: number; failed: string[]; warnings: string[] }> {
  const manifest = JSON.parse(readFileSync(join(projectDir, "data", "manifest.json"), "utf8")) as Manifest;
  const all = manifestLibraries(manifest);
  if (all.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", "This server has no documentation sources");
  const libraries = all.filter((lib) => lib.contentMode === "fetch-on-install");
  let pages = 0;
  let skipped = true;
  const failed: string[] = [];
  const warnings: string[] = [];
  for (const lib of libraries) {
    const path = corpusCachePath(lib.name, lib.version);
    if (options.ifMissing && existsSync(path)) continue;
    skipped = false;
    const [corpus, changes] = await Promise.all([
      loadDocCorpus(lib.candidates, {
        contentFetcher: options.contentFetcher,
        apiFetcher: options.apiFetcher,
        title: lib.title,
        version: lib.version,
        ...(lib.license ? { license: lib.license } : {}),
      }).catch((err: unknown) => {
        warnings.push(`${lib.title}: ${(err as Error).message}`);
        return undefined;
      }),
      changesFor(lib.changes, lib.version, options.apiFetcher),
    ]);
    if (!corpus || corpus.pages.length === 0) {
      failed.push(lib.title);
      continue;
    }
    if (changes.rateLimited) warnings.push(rateLimitWarning(lib.title));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(changes.entries.length ? { ...corpus, changes: changes.entries } : corpus));
    pages += corpus.pages.length;
  }
  if (failed.length > 0 && failed.length === libraries.length) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `No documentation could be downloaded for ${failed.join(", ")}${warnings.length ? ` (${warnings.join("; ")})` : ""}`);
  }
  const path = libraries.length === 1 ? corpusCachePath(libraries[0]!.name, libraries[0]!.version) : cacheRoot();
  return { path, pages, skipped, libraries: libraries.length, failed, warnings };
}
