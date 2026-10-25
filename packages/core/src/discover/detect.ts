import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import semver from "semver";
import { catalogName, findCatalogEntry } from "../catalog.js";
import type { Fetcher } from "../fetch/types.js";
import { MakeMcpError } from "../errors.js";
import { createWorkspace, type Workspace } from "../fs/workspace.js";
import { bundleChoice, isBundle } from "../intake/questions.js";
import type { Findings, IntakeAnswers, Mode, ProjectDependency, TargetKind } from "../intake/types.js";
import type { DocsSource } from "../parse/docs-corpus.js";
import { slugify } from "../parse/markdown-split.js";
import { listRepoTags, matchVersionTag, parseRepoUrl, repoWebUrl } from "../parse/repo-docs.js";
import { probeDocs, type DocsProbe } from "./probe.js";
import { npmMetadata, pypiMetadata, type PackageMetadata } from "./registry.js";
import { findInstalledPythonPackage, matchPythonDependency, normalizePythonName, pythonDependencies } from "./python-packages.js";
import { detectWorkspaceLanguage, findInstalledPackage, matchDependency } from "./workspace-packages.js";

export interface DetectOptions {
  target: string;
  workspaceRoot: string;
  /** Plain fetcher for registries and the GitHub API. */
  apiFetcher: Fetcher;
  /** Polite fetcher (robots/TDM) for documentation sites. */
  contentFetcher: Fetcher;
  /** Look the name up on PyPI before npm (e.g. a catalog entry for a Python package). */
  preferPython?: boolean;
}

const isUrl = (value: string) => /^https?:\/\//i.test(value);

function majorOf(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = /(\d+)/.exec(version);
  return match?.[1] ? Number(match[1]) : undefined;
}

function docsFromProbe(probe: DocsProbe): DocsSource[] {
  const sources: DocsSource[] = [];
  if (probe.llmsFullTxt) sources.push({ kind: "llms-full-txt", url: probe.llmsFullTxt });
  if (probe.llmsTxt) {
    sources.push({ kind: "llms-txt", url: probe.llmsTxt.url, ...(probe.llmsTxt.declaredVersion ? { ref: probe.llmsTxt.declaredVersion } : {}) });
  }
  return sources;
}

/**
 * Orders documentation sources: llms-full.txt → llms.txt → repo docs at the version tag → website → README.
 * If llms.txt declares a different major version than requested, version-exact repo docs move to the front.
 */
function orderDocs(probe: DocsProbe, repoDocs: DocsSource | undefined, readme: DocsSource | undefined, version: string | undefined, notes: string[]): DocsSource[] {
  const llms = docsFromProbe(probe);
  const declared = probe.llmsTxt?.declaredVersion;
  const mismatch = declared !== undefined && majorOf(declared) !== undefined && majorOf(version) !== undefined && majorOf(declared) !== majorOf(version);
  if (mismatch) {
    notes.push(`llms.txt describes version ${declared}, but ${version} is requested; preferring version-exact repository docs.`);
  }
  const website: DocsSource[] = probe.website ? [{ kind: "website", url: probe.website }] : [];
  const repo = repoDocs ? [repoDocs] : [];
  const tail = readme ? [readme] : [];
  return mismatch ? [...repo, ...llms, ...website, ...tail] : [...llms, ...repo, ...website, ...tail];
}

async function packageMetadata(name: string, version: string | undefined, preferPython: boolean, fetcher: Fetcher): Promise<PackageMetadata | undefined> {
  const order = preferPython ? [pypiMetadata, npmMetadata] : [npmMetadata, pypiMetadata];
  for (const lookup of order) {
    const meta = await lookup(name, version, fetcher).catch(() => undefined);
    if (meta) return meta;
  }
  return undefined;
}

/** Build tooling, linters and type packages: not libraries anyone asks an MCP server about. */
const TOOLING =
  /^(@types\/|types-|@typescript-eslint\/|eslint|@eslint\/|prettier|typescript$|ts-node$|tsx$|husky$|lint-staged$|rimraf$|cross-env$|concurrently$|nodemon$|npm-run-all|@biomejs\/|vite$|@vitejs\/|vitest|@vitest\/|jest$|@jest\/|ts-jest$|babel-|@babel\/|webpack|esbuild$|rollup$|@rollup\/|@swc\/|postcss$|autoprefixer$|pytest|mypy$|ruff$|black$|flake8|isort$|pre-commit$|coverage$|tox$|pylint$)/i;

/** Direct dependencies of the workspace, runtime ones first, without build tooling. No network. */
export function projectDependencies(ws: Workspace): ProjectDependency[] {
  const deps: ProjectDependency[] = [];
  const pkg = ws.readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>("package.json");
  // Runtime dependencies first: the library cap of a project server cuts from the end.
  for (const name of Object.keys(pkg?.dependencies ?? {})) deps.push({ name, registry: "npm" });
  for (const dep of pythonDependencies(ws)) deps.push({ name: dep.name, registry: "pypi" });
  for (const name of Object.keys(pkg?.devDependencies ?? {})) deps.push({ name, registry: "npm" });
  const seen = new Set<string>();
  return deps.filter((d) => {
    const key = `${d.registry}:${d.registry === "pypi" ? normalizePythonName(d.name) : d.name}`;
    if (TOOLING.test(d.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectName(ws: Workspace): string | undefined {
  const pkg = ws.readJson<{ name?: string }>("package.json");
  if (pkg?.name) return pkg.name;
  return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(ws.readText("pyproject.toml") ?? "")?.[1];
}

const sameDependency = (dep: ProjectDependency, findings: Findings) =>
  dep.registry === "pypi"
    ? normalizePythonName(dep.name) === normalizePythonName(findings.packageName ?? findings.target)
    : dep.name === (findings.packageName ?? findings.target);

/**
 * Detects the target and, if the community catalog has an entry for it, applies the entry's sources and mode.
 * `catalog:<name>` forces a catalog entry; plain names are looked up as well. `.` stands for the whole project:
 * the first dependency becomes the target and the intake starts with a whole-project server.
 */
export async function detectContext(options: DetectOptions): Promise<Findings> {
  if (options.target.trim() === ".") {
    const ws = createWorkspace(options.workspaceRoot);
    const deps = projectDependencies(ws);
    if (deps.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", `No dependencies found in package.json, pyproject.toml or requirements of ${ws.root}.`);
    // The first dependency that is a published library with docs becomes the primary; private packages are skipped.
    for (const dep of deps) {
      const primary = await detectCatalogTarget({ ...options, target: dep.name, preferPython: dep.registry === "pypi" }).catch(() => undefined);
      if (!primary || primary.kind.value !== "library" || primary.docsCandidates.length === 0) continue;
      const name = projectName(ws);
      return {
        ...primary,
        projectDeps: deps.filter((d) => d !== dep),
        ...(name ? { projectName: name } : {}),
        bundle: { value: "project", confidence: "high", source: 'target "."' },
      };
    }
    throw new MakeMcpError("SOURCE_NOT_FOUND", "None of the project's dependencies is a published library with documentation make-mcp can read.");
  }
  const findings = await detectCatalogTarget(options);
  if (isUrl(options.target) || findings.kind.value !== "library") return findings;
  // Offer a whole-project server when the target is one of several dependencies of the workspace.
  const ws = createWorkspace(options.workspaceRoot);
  const deps = projectDependencies(ws);
  if (!deps.some((d) => sameDependency(d, findings))) return findings;
  const name = projectName(ws);
  return { ...findings, projectDeps: deps.filter((d) => !sameDependency(d, findings)), ...(name ? { projectName: name } : {}) };
}

async function detectCatalogTarget(options: DetectOptions): Promise<Findings> {
  const entry = await findCatalogEntry(options.target, options.apiFetcher);
  if (!entry && catalogName(options.target)) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `No catalog entry "${catalogName(options.target)}" – see https://github.com/make-mcp/catalog`);
  }
  const findings = await detectTarget(entry ? { ...options, target: entry.target, preferPython: options.preferPython ?? entry.answers.language === "py" } : options);
  if (!entry) return findings;

  let next: Findings = { ...findings, target: entry.title, catalog: entry, notes: [...findings.notes] };
  if (entry.answers.docsSource || entry.answers.codeSource) next = await applySourceAnswers(next, entry.answers, options);
  if (entry.answers.mode) next = { ...next, mode: { value: entry.answers.mode, confidence: "high", source: "community catalog" } };
  if (entry.notes) next.notes.push(entry.notes);
  return next;
}

async function detectTarget(options: DetectOptions): Promise<Findings> {
  const ws = createWorkspace(options.workspaceRoot);
  const notes: string[] = [];
  const language = detectWorkspaceLanguage(ws);
  const base = {
    target: options.target,
    workspaceRoot: ws.root,
    ...(language ? { language: { value: language, confidence: "high" as const, source: "workspace files" } } : {}),
    notes,
  };

  if (isUrl(options.target)) {
    const probe = await probeDocs(options.target, options.contentFetcher);
    const host = new URL(options.target).hostname.replace(/^(www|api|docs)\./, "");
    const slug = slugify(probe.openapi?.title ?? host.split(".")[0] ?? host);
    const docsCandidates = [...docsFromProbe(probe), ...(probe.website ? [{ kind: "website" as const, url: probe.website }] : [])];
    const kind: TargetKind = probe.openapi ? "api" : "unknown";
    const mode: Mode = probe.openapi ? (docsCandidates.length ? "both" : "api") : "docs";
    return {
      ...base,
      slug,
      kind: { value: kind, confidence: probe.openapi ? "high" : "low", source: "URL probe" },
      docsCandidates,
      ...(probe.openapi ? { openapi: probe.openapi } : {}),
      mode: { value: mode, confidence: probe.openapi && !docsCandidates.length ? "high" : "medium", source: "URL probe" },
      ...(probe.openapi?.specVersion ? { version: { value: probe.openapi.specVersion, confidence: "high", source: "OpenAPI info.version" } } : {}),
    };
  }

  const npmDep = matchDependency(ws, options.target);
  const pyDep = npmDep ? undefined : matchPythonDependency(ws, options.target);
  const packageName = npmDep ?? pyDep ?? options.target.toLowerCase().replace(/\s+/g, "-");
  const preferPython = pyDep !== undefined || (npmDep === undefined && (options.preferPython ?? language === "py"));
  const installed = preferPython ? findInstalledPythonPackage(ws, packageName) : findInstalledPackage(ws, packageName);
  const meta = await packageMetadata(packageName, installed?.exact ? installed.version : undefined, preferPython, options.apiFetcher);

  let version: Findings["version"];
  if (installed?.exact) version = { value: installed.version, confidence: "high", source: installed.source };
  else if (installed && "range" in installed && installed.range) {
    version = { value: installed.version, confidence: "medium", source: `${installed.source} range ${installed.range}` };
  } else if (installed) {
    // Ranges such as "workspace:*", "latest" or "github:user/repo" have no minimum version.
    const min = (() => {
      try {
        return semver.minVersion(installed.version)?.version;
      } catch {
        return undefined;
      }
    })();
    if (min) version = { value: min, confidence: "medium", source: `package.json range ${installed.version}` };
    else if (meta) version = { value: meta.latest, confidence: "low", source: `${meta.registry} latest (package.json says ${installed.version})` };
  } else if (meta) version = { value: meta.latest, confidence: "low", source: `${meta.registry} latest` };

  const repo = parseRepoUrl(meta?.repositoryUrl);
  let repoTag: string | undefined;
  if (repo && version) {
    const tags = await listRepoTags(repo, options.apiFetcher).catch(() => []);
    repoTag = matchVersionTag(version.value, tags, meta?.name);
  }

  const homepage = meta?.docsUrl ?? meta?.homepage;
  const probe = homepage && isUrl(homepage) && !/github\.com/.test(homepage) ? await probeDocs(homepage, options.contentFetcher) : {};
  const repoRef = repoTag ?? "HEAD";
  const repoDocs: DocsSource | undefined = repo ? { kind: "repo-docs", url: repoWebUrl(repo), ref: repoRef } : undefined;
  const readme: DocsSource | undefined = repo
    ? { kind: "readme", url: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repoRef}/README.md` }
    : undefined;
  const docsCandidates = orderDocs(probe, repoDocs, readme, version?.value, notes);
  if (repo && version && !repoTag) notes.push(`No git tag found for version ${version.value}; repository docs use the default branch.`);

  const kind: TargetKind = meta ? "library" : probe.openapi ? "api" : "unknown";
  const mode: Mode = probe.openapi ? "both" : "docs";

  return {
    ...base,
    slug: slugify(meta?.name ?? options.target),
    kind: { value: kind, confidence: meta ? "high" : "low", source: meta ? `${meta.registry} registry` : "name only" },
    ...(meta ? { packageName: meta.name, registry: meta.registry, latestVersion: meta.latest } : {}),
    ...(meta?.description ? { description: meta.description } : {}),
    ...(version ? { version } : {}),
    ...(meta?.license ? { license: { value: meta.license, confidence: "high", source: `${meta.registry} registry` } } : {}),
    ...(repo ? { repositoryUrl: { value: repoWebUrl(repo), confidence: "high", source: `${meta?.registry} registry` } } : {}),
    ...(repoTag ? { repoTag } : {}),
    ...(homepage ? { homepage } : {}),
    docsCandidates,
    ...(probe.openapi ? { openapi: probe.openapi } : {}),
    mode: { value: mode, confidence: "medium", source: kind === "library" ? "package is a library" : "default" },
  };
}

export interface RefineOptions {
  apiFetcher: Fetcher;
  contentFetcher: Fetcher;
}

/** Upper bound for a whole-project server: every library costs a docs download and context in the agent. */
export const MAX_PROJECT_LIBRARIES = 12;
const DETECT_CONCURRENCY = 4;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Detects every library of a whole-project server (bundle answer "project" or a list of package names).
 * Libraries without documentation are left out with a note; the target comes first.
 */
export async function expandBundle(findings: Findings, answers: IntakeAnswers, options: RefineOptions): Promise<Findings> {
  const base: Findings = { ...findings };
  delete base.members;
  if (!isBundle(findings, answers)) return base;
  const choice = bundleChoice(findings, answers);
  const deps = findings.projectDeps ?? [];
  const notes = [...findings.notes];
  let wanted: ProjectDependency[] =
    choice.toLowerCase() === "project"
      ? deps
      : choice
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .map((n) => deps.find((d) => d.name.toLowerCase() === n.toLowerCase()) ?? { name: n, registry: findings.registry ?? "npm" })
          .filter((d) => !sameDependency(d, findings));
  if (wanted.length > MAX_PROJECT_LIBRARIES - 1) {
    notes.push(`A project server holds up to ${MAX_PROJECT_LIBRARIES} libraries; left out: ${wanted.slice(MAX_PROJECT_LIBRARIES - 1).map((d) => d.name).join(", ")}.`);
    wanted = wanted.slice(0, MAX_PROJECT_LIBRARIES - 1);
  }

  const detected = await mapLimited(wanted, DETECT_CONCURRENCY, (dep) =>
    detectCatalogTarget({ target: dep.name, workspaceRoot: findings.workspaceRoot, ...options, preferPython: dep.registry === "pypi" }).catch(
      (err: unknown) => {
        notes.push(`${dep.name}: left out (${(err as Error).message})`);
        return undefined;
      },
    ),
  );
  const members: Findings[] = [];
  const primary = { ...base, notes: [] };
  for (const member of [primary, ...detected]) {
    if (!member) continue;
    if (member.docsCandidates.length === 0) notes.push(`${member.target}: no documentation found – left out of the project server.`);
    else if (members.some((m) => m.slug === member.slug)) notes.push(`${member.target}: same name as another library ("${member.slug}") – left out.`);
    else members.push({ ...member, notes: [] });
  }
  if (members.length === 0) throw new MakeMcpError("SOURCE_NOT_FOUND", "None of the project's libraries has documentation make-mcp can read.");
  return { ...base, members, notes };
}

/**
 * Folds answers that need network into the findings: docs/code locations and the libraries of a project server.
 * `changed` are the answer ids the caller just received.
 */
export async function refineFindings(findings: Findings, answers: IntakeAnswers, changed: string[], options: RefineOptions): Promise<Findings> {
  let next = findings;
  if (changed.includes("docsSource") || changed.includes("codeSource")) next = await applySourceAnswers(next, answers, options);
  if (changed.includes("bundle") || (isBundle(next, answers) && !next.members)) next = await expandBundle(next, answers, options);
  return next;
}

/** Folds user-supplied docs/code locations into the findings so later steps can use them. */
export async function applySourceAnswers(findings: Findings, answers: IntakeAnswers, options: RefineOptions): Promise<Findings> {
  let next: Findings = { ...findings, notes: [...findings.notes] };

  if (answers.docsSource && answers.docsSource !== "none" && isUrl(answers.docsSource)) {
    const probe = await probeDocs(answers.docsSource, options.contentFetcher);
    const extra = [...docsFromProbe(probe), ...(probe.website ? [{ kind: "website" as const, url: probe.website }] : [])];
    next = {
      ...next,
      docsCandidates: [...extra, ...next.docsCandidates.filter((d) => !extra.some((e) => e.url === d.url))],
      ...(probe.openapi ? { openapi: probe.openapi } : {}),
    };
  }

  if (answers.codeSource && answers.codeSource !== "none") {
    const repo = parseRepoUrl(answers.codeSource);
    const localPath = resolve(findings.workspaceRoot, answers.codeSource);
    if (repo) {
      const tags = next.version ? await listRepoTags(repo, options.apiFetcher).catch(() => []) : [];
      const tag = next.version ? matchVersionTag(next.version.value, tags, next.packageName) : undefined;
      next = {
        ...next,
        repositoryUrl: { value: repoWebUrl(repo), confidence: "high", source: "user" },
        ...(tag ? { repoTag: tag } : {}),
        docsCandidates: [...next.docsCandidates, { kind: "repo-docs", url: repoWebUrl(repo), ref: tag ?? "HEAD" }],
      };
    } else if (existsSync(localPath) && statSync(localPath).isDirectory()) {
      next = { ...next, docsCandidates: [{ kind: "local-docs", url: localPath }, ...next.docsCandidates] };
    } else {
      next.notes.push(`Code location "${answers.codeSource}" is neither a GitHub URL nor an existing directory.`);
    }
  }

  return next;
}
