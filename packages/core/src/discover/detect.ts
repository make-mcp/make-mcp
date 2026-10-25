import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import semver from "semver";
import { catalogName, findCatalogEntry } from "../catalog.js";
import type { Fetcher } from "../fetch/types.js";
import { MakeMcpError } from "../errors.js";
import { createWorkspace } from "../fs/workspace.js";
import type { Findings, IntakeAnswers, Mode, TargetKind } from "../intake/types.js";
import type { DocsSource } from "../parse/docs-corpus.js";
import { slugify } from "../parse/markdown-split.js";
import { listRepoTags, matchVersionTag, parseRepoUrl, repoWebUrl } from "../parse/repo-docs.js";
import { probeDocs, type DocsProbe } from "./probe.js";
import { npmMetadata, pypiMetadata, type PackageMetadata } from "./registry.js";
import { findInstalledPythonPackage, matchPythonDependency } from "./python-packages.js";
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

/**
 * Detects the target and, if the community catalog has an entry for it, applies the entry's sources and mode.
 * `catalog:<name>` forces a catalog entry; plain names are looked up as well.
 */
export async function detectContext(options: DetectOptions): Promise<Findings> {
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
    const min = semver.minVersion(installed.version)?.version;
    version = { value: min ?? installed.version, confidence: "medium", source: `package.json range ${installed.version}` };
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
