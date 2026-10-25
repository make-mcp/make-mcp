import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { strToU8, zipSync } from "fflate";
import { MakeMcpError } from "../errors.js";
import type { Fetcher } from "../fetch/types.js";
import type { ResolvedIntake, ToolMode } from "../intake/types.js";
import type { ApiSpec, AuthScheme, DocCorpus, SourceRef } from "../ir/index.js";
import { contentModeFor, type ContentMode } from "../license.js";
import { loadDocCorpus, type DocsSource } from "../parse/docs-corpus.js";
import { applyRequestedVersion, openApiToSpec, parseApiDocument } from "../parse/openapi.js";

export const GENERATOR_PACKAGE = "@make-mcp/cli";
export const GENERATOR_VERSION = "0.1.0";
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
  docs?: { contentMode: ContentMode; sources: SourceRef[]; candidates: DocsSource[] };
  api?: boolean;
  toolMode?: ToolMode;
}

export interface EnvVar {
  name: string;
  description: string;
  /** Credentials; optional overrides such as base URL are not secret. */
  secret: boolean;
}

export interface GeneratedProject {
  outDir: string;
  files: Record<string, string>;
  manifest: Manifest;
  tools: string[];
  pageCount: number;
  endpointCount: number;
  run: { command: string; args: string[] };
  envVars: EnvVar[];
  warnings: string[];
}

/** Cache location shared with the generated servers (keep in sync with the templates). */
export function corpusCachePath(name: string, version: string): string {
  const base = process.env.MAKE_MCP_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "make-mcp");
  return join(base, name, version, "corpus.json");
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
  vars.push({ name: `${envPrefix}_BASE_URL`, description: `Override the base URL (default ${spec.baseUrl})`, secret: false });
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

async function buildApiSpec(resolved: ResolvedIntake, options: GenerateOptions, warnings: string[]): Promise<ApiSpec | undefined> {
  if (!resolved.openapiUrl) return undefined;
  const res = await options.contentFetcher(resolved.openapiUrl, { accept: "application/json,application/yaml,text/yaml" });
  if (!res.ok) throw new MakeMcpError("SOURCE_NOT_FOUND", `Could not load ${resolved.openapiUrl} (HTTP ${res.status})`);
  let spec = openApiToSpec(parseApiDocument(res.body), {
    sourceUrl: res.url,
    envPrefix: resolved.envPrefix,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
  });

  if (resolved.version !== "latest" && resolved.version !== spec.specVersion) {
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

async function buildCorpus(resolved: ResolvedIntake, options: GenerateOptions): Promise<DocCorpus | undefined> {
  if (resolved.docs.length === 0) return undefined;
  const corpus = await loadDocCorpus(resolved.docs, {
    contentFetcher: options.contentFetcher,
    apiFetcher: options.apiFetcher,
    title: resolved.target,
    version: resolved.version,
    ...(resolved.license ? { license: resolved.license } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (corpus.pages.length === 0) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `None of the documentation sources yielded pages: ${resolved.docs.map((d) => d.url).join(", ")}`);
  }
  return corpus;
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

function packageJson(resolved: ResolvedIntake, contentMode: ContentMode | undefined): string {
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
        ...(contentMode === "fetch-on-install" ? { refresh, postinstall: `${refresh} --if-missing` } : {}),
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

  const [spec, corpus] = await Promise.all([buildApiSpec(resolved, options, warnings), buildCorpus(resolved, options)]);
  const contentMode = corpus ? contentModeFor(resolved.license) : undefined;
  if (contentMode === "fetch-on-install") {
    warnings.push(
      `License "${resolved.license ?? "unknown"}" does not clearly permit redistribution – docs are not embedded and will be downloaded on first install.`,
    );
  }

  const toolMode: ToolMode | undefined = spec ? (resolved.toolMode ?? (spec.endpoints.length > GROUP_THRESHOLD ? "grouped" : "endpoints")) : undefined;
  if (spec && toolMode === "endpoints" && spec.endpoints.length > TOOL_WARNING_THRESHOLD) {
    warnings.push(`${spec.endpoints.length} API tools – many clients work better with fewer. Use grouped tools or narrow the scope by tags.`);
  }

  const manifest: Manifest = {
    name: resolved.slug,
    title: spec?.title && resolved.mode === "api" ? spec.title : resolved.target,
    targetVersion: resolved.version,
    envPrefix: resolved.envPrefix,
    transport: resolved.transport,
    ...(resolved.license ? { license: resolved.license } : {}),
    generator: `${GENERATOR_PACKAGE}@${GENERATOR_VERSION}`,
    generatedAt: now.toISOString(),
    ...(corpus && contentMode ? { docs: { contentMode, sources: corpus.sources, candidates: resolved.docs } } : {}),
    ...(spec ? { api: true, toolMode } : {}),
  };

  const envVars = envVarsFor(spec, resolved.envPrefix);
  const run = runCommand(resolved.language, outDir);
  const components = corpus?.pages.filter((p) => p.kind === "component").length ?? 0;
  const tools = [
    ...(corpus ? ["search_docs", "get_page", "list_topics", ...(components ? ["get_component"] : [])] : []),
    ...(spec ? (toolMode === "grouped" ? GROUPED_TOOLS : spec.endpoints.map((ep) => ep.id)) : []),
  ];

  const view = {
    name: resolved.slug,
    title: manifest.title,
    target: resolved.target,
    version: resolved.version,
    generatedAt: now.toISOString().slice(0, 10),
    license: resolved.license,
    docs: corpus && contentMode ? { contentMode, sources: corpus.sources, pageCount: corpus.pages.length, componentCount: components } : undefined,
    api: spec ? { title: spec.title, baseUrl: spec.baseUrl, endpointCount: spec.endpoints.length, toolMode } : undefined,
    envVars,
    secretVars: envVars.filter((v) => v.secret),
    run,
  };

  const lang = resolved.language;
  const files: Record<string, string> = {
    "README.md": tidy(eta.render(`${lang}/README.md.eta`, view)),
    ".gitignore": readFileSync(join(templatesDir, lang, "gitignore"), "utf8"),
    Dockerfile: readFileSync(join(templatesDir, lang, "Dockerfile"), "utf8"),
    "data/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
  if (envVars.length > 0) files[".env.example"] = eta.render("_partials/env.eta", view);
  if (spec) files["data/api.json"] = `${JSON.stringify(spec, null, 2)}\n`;
  if (corpus && contentMode === "embedded") files["data/corpus.json"] = `${JSON.stringify(corpus)}\n`;

  if (lang === "ts") {
    files["package.json"] = packageJson(resolved, contentMode);
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
    pageCount: corpus?.pages.length ?? 0,
    endpointCount: spec?.endpoints.length ?? 0,
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

/** Downloads docs for a fetch-on-install server on the user's machine into the local cache. */
export async function refreshDocs(projectDir: string, options: RefreshOptions): Promise<{ path: string; pages: number; skipped: boolean }> {
  const manifest = JSON.parse(readFileSync(join(projectDir, "data", "manifest.json"), "utf8")) as Manifest;
  if (!manifest.docs) throw new MakeMcpError("SOURCE_NOT_FOUND", "This server has no documentation sources");
  const path = corpusCachePath(manifest.name, manifest.targetVersion);
  if (options.ifMissing && existsSync(path)) return { path, pages: 0, skipped: true };

  const corpus = await loadDocCorpus(manifest.docs.candidates, {
    contentFetcher: options.contentFetcher,
    apiFetcher: options.apiFetcher,
    title: manifest.title,
    version: manifest.targetVersion,
    ...(manifest.license ? { license: manifest.license } : {}),
  });
  if (corpus.pages.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", "No documentation could be downloaded");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(corpus));
  return { path, pages: corpus.pages.length, skipped: false };
}
