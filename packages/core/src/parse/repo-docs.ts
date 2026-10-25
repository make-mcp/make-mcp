import type { Fetcher } from "../fetch/types.js";
import type { DocPage } from "../ir/index.js";
import { slugify, stripFrontmatter } from "./markdown-split.js";

export interface RepoRef {
  host: "github";
  owner: string;
  repo: string;
}

export function parseRepoUrl(raw: string | undefined): RepoRef | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^github:/, "https://github.com/");
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#].*)?$/.exec(cleaned);
  if (!match?.[1] || !match[2]) return undefined;
  return { host: "github", owner: match[1], repo: match[2] };
}

export function repoWebUrl(repo: RepoRef): string {
  return `https://github.com/${repo.owner}/${repo.repo}`;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function listRepoTags(repo: RepoRef, fetcher: Fetcher): Promise<string[]> {
  const res = await fetcher(`https://api.github.com/repos/${repo.owner}/${repo.repo}/tags?per_page=100`, {
    accept: "application/vnd.github+json",
    headers: githubHeaders(),
  });
  if (!res.ok) return [];
  const tags = JSON.parse(res.body) as { name: string }[];
  return tags.map((t) => t.name);
}

/** Finds the tag for a package version, e.g. `5.0.43`, `v5.0.43` or `daisyui@5.0.43`. */
export function matchVersionTag(version: string, tags: string[], packageName?: string): string | undefined {
  const candidates = [version, `v${version}`, ...(packageName ? [`${packageName}@${version}`, `${packageName}-v${version}`] : [])];
  return candidates.find((c) => tags.includes(c));
}

const DOC_DIR = /(^|\/)(docs?|documentation|guides?)(\/|$)/i;
const EXCLUDED = /(^|\/)(node_modules|\.github|test|tests|__tests__|fixtures|examples?\/node_modules)(\/|$)|CHANGELOG|CODE_OF_CONDUCT|CONTRIBUTING|SECURITY/i;

export function isRepoDocFile(path: string): boolean {
  if (!/\.(md|mdx)$/i.test(path) || EXCLUDED.test(path)) return false;
  return DOC_DIR.test(path) || /^readme\.mdx?$/i.test(path);
}

function docPagePath(filePath: string): string {
  const parts = filePath
    .replace(/\.(md|mdx)$/i, "")
    .split("/")
    .filter((p) => p && !/^\(.*\)$/.test(p) && !/^\+page$/i.test(p) && !/^index$/i.test(p));
  const docIndex = parts.findIndex((p) => DOC_DIR.test(`/${p}/`));
  const rel = docIndex >= 0 ? parts.slice(docIndex + 1) : parts;
  const filtered = rel.filter((p) => !/^(src|routes|content|pages)$/i.test(p));
  return filtered.map(slugify).join("/") || "readme";
}

export interface RepoDocsOptions {
  fetcher: Fetcher;
  ref: string;
  maxFiles?: number;
}

/** Loads Markdown documentation files from a GitHub repository at a given ref (tag/branch). */
export async function loadRepoDocs(repo: RepoRef, options: RepoDocsOptions): Promise<DocPage[]> {
  const maxFiles = options.maxFiles ?? 200;
  const treeRes = await options.fetcher(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(options.ref)}?recursive=1`,
    { accept: "application/vnd.github+json", headers: githubHeaders() },
  );
  if (!treeRes.ok) return [];
  const tree = JSON.parse(treeRes.body) as { tree: { path: string; type: string }[] };
  const files = tree.tree
    .filter((entry) => entry.type === "blob" && isRepoDocFile(entry.path))
    .slice(0, maxFiles);

  const pages: DocPage[] = [];
  const usedPaths = new Set<string>();
  for (const file of files) {
    const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${options.ref}/${file.path}`;
    const res = await options.fetcher(rawUrl);
    if (!res.ok) continue;
    const { data, body } = stripFrontmatter(res.body);
    const markdown = body.replace(/<script[\s\S]*?<\/script>/gi, "").trim();
    if (markdown.length < 50) continue;
    const title =
      (typeof data.title === "string" ? data.title : undefined) ??
      /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ??
      file.path.split("/").filter((p) => !/^\+page/.test(p)).pop()?.replace(/\.(md|mdx)$/i, "") ??
      file.path;
    const basePath = docPagePath(file.path);
    let path = basePath;
    for (let i = 2; usedPaths.has(path); i++) path = `${basePath}-${i}`;
    usedPaths.add(path);
    pages.push({
      path,
      title,
      kind: /(^|\/)components?\//i.test(file.path) ? "component" : "page",
      markdown,
      sourceUrl: `${repoWebUrl(repo)}/blob/${options.ref}/${file.path}`,
    });
  }
  return pages;
}
